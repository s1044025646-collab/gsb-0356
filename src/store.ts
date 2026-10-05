// SQLite 持久层：模式版本、扫描、块、命中、解释记录。
// 单块追加在事务中原子提交；重复序号按公开规则去重。

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AcError,
  Automaton,
  ExplainRecord,
  Hit,
  Scanner,
  ScanStats,
  assertValidUnicode,
} from "./automaton";

export const DEFAULT_EXPLAIN_LIMIT = 1000;

export interface AppendResult {
  scanId: number;
  seq: number;
  deduplicated: boolean;
  hits: Hit[];
  position: number;
  state: number;
  stats: ScanStats;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        patterns_json TEXT NOT NULL,
        pattern_count INTEGER NOT NULL,
        total_pattern_len INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(name, version)
      );
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES versions(id),
        status TEXT NOT NULL DEFAULT 'open',
        position INTEGER NOT NULL DEFAULT 0,
        state INTEGER NOT NULL DEFAULT 0,
        next_seq INTEGER NOT NULL DEFAULT 0,
        explain_limit INTEGER NOT NULL,
        stats_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS chunks (
        scan_id INTEGER NOT NULL REFERENCES scans(id),
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (scan_id, seq)
      );
      CREATE TABLE IF NOT EXISTS hits (
        scan_id INTEGER NOT NULL REFERENCES scans(id),
        pattern_id INTEGER NOT NULL,
        start INTEGER NOT NULL,
        "end" INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hits_scan ON hits(scan_id, "end", pattern_id);
      CREATE TABLE IF NOT EXISTS explain (
        scan_id INTEGER NOT NULL REFERENCES scans(id),
        pos INTEGER NOT NULL,
        char TEXT NOT NULL,
        fail_json TEXT NOT NULL,
        state INTEGER NOT NULL,
        outputs_json TEXT NOT NULL,
        PRIMARY KEY (scan_id, pos)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 保存模式集，生成新版本号；模式集不可变，修改即新版本。 */
  compileVersion(name: string, patterns: string[]): { versionId: number; version: number } {
    if (typeof name !== "string" || name.length === 0) {
      throw new AcError("BAD_REQUEST", "模式集名称不能为空");
    }
    const ac = new Automaton(patterns); // 负责全部模式校验
    const row = this.db
      .prepare(`SELECT MAX(version) AS v FROM versions WHERE name = ?`)
      .get(name) as { v: number | null };
    const version = (row.v ?? 0) + 1;
    const r = this.db
      .prepare(
        `INSERT INTO versions (name, version, patterns_json, pattern_count, total_pattern_len)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(name, version, JSON.stringify(ac.patterns), ac.patterns.length, ac.totalPatternLen);
    return { versionId: Number(r.lastInsertRowid), version };
  }

  listVersions(): unknown[] {
    return this.db
      .prepare(
        `SELECT id AS versionId, name, version, pattern_count AS patternCount,
                total_pattern_len AS totalPatternLen, created_at AS createdAt
         FROM versions ORDER BY name, version`,
      )
      .all();
  }

  getVersion(versionId: number): { id: number; name: string; version: number; patterns: string[] } {
    const row = this.db
      .prepare(`SELECT id, name, version, patterns_json FROM versions WHERE id = ?`)
      .get(versionId) as { id: number; name: string; version: number; patterns_json: string } | undefined;
    if (!row) throw new AcError("NOT_FOUND", `版本不存在: ${versionId}`);
    return { id: row.id, name: row.name, version: row.version, patterns: JSON.parse(row.patterns_json) };
  }

  findVersionId(name: string, version?: number): number {
    const row = version === undefined
      ? this.db.prepare(`SELECT id FROM versions WHERE name = ? ORDER BY version DESC LIMIT 1`).get(name)
      : this.db.prepare(`SELECT id FROM versions WHERE name = ? AND version = ?`).get(name, version);
    if (!row) throw new AcError("NOT_FOUND", `模式集版本不存在: ${name}@${version ?? "latest"}`);
    return (row as { id: number }).id;
  }

  createScan(versionId: number, explainLimit: number = DEFAULT_EXPLAIN_LIMIT): number {
    if (!Number.isInteger(explainLimit) || explainLimit < 0) {
      throw new AcError("BAD_REQUEST", "explainLimit 必须是非负整数");
    }
    this.getVersion(versionId);
    const stats: ScanStats = {
      positions: 0,
      failTraversals: 0,
      hits: 0,
      explainRecords: 0,
      explainTruncated: false,
    };
    const r = this.db
      .prepare(`INSERT INTO scans (version_id, explain_limit, stats_json) VALUES (?, ?, ?)`)
      .run(versionId, explainLimit, JSON.stringify(stats));
    return Number(r.lastInsertRowid);
  }

  private getScanRow(scanId: number): {
    id: number; version_id: number; status: string; position: number; state: number;
    next_seq: number; explain_limit: number; stats_json: string;
  } {
    const row = this.db.prepare(`SELECT * FROM scans WHERE id = ?`).get(scanId) as never;
    if (!row) throw new AcError("NOT_FOUND", `扫描不存在: ${scanId}`);
    return row;
  }

  /** 从持久化状态重建扫描器（重启续扫与一次扫描完整文本一致）。 */
  private resumeScanner(scanId: number): { scanner: Scanner; row: ReturnType<Store["getScanRow"]> } {
    const row = this.getScanRow(scanId);
    const v = this.getVersion(row.version_id);
    const ac = new Automaton(v.patterns);
    const scanner = new Scanner(ac, row.explain_limit);
    scanner.state = row.state;
    scanner.pos = row.position;
    Object.assign(scanner.stats, JSON.parse(row.stats_json));
    return { scanner, row };
  }

  /**
   * 追加一个块。规则：
   * - seq 必须等于 next_seq（新块）或是一个已存在的序号（重放去重）；
   * - 相同序号且内容相同 → 幂等去重，不重复计数；
   * - 相同序号但内容不同 → SEQ_CONFLICT；
   * - 其他序号 → SEQ_OUT_OF_ORDER；
   * - 已结束的扫描 → SCAN_ENDED。
   * 单块追加在一个事务内原子提交。
   */
  append(scanId: number, seq: number, text: string): AppendResult {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new AcError("BAD_REQUEST", "seq 必须是非负整数");
    }
    assertValidUnicode(text, "文本块");
    const row = this.getScanRow(scanId);
    if (row.status !== "open") throw new AcError("SCAN_ENDED", `扫描 ${scanId} 已结束，拒绝追加`);

    const existing = this.db
      .prepare(`SELECT text FROM chunks WHERE scan_id = ? AND seq = ?`)
      .get(scanId, seq) as { text: string } | undefined;
    if (existing) {
      if (existing.text !== text) {
        throw new AcError("SEQ_CONFLICT", `块序号 ${seq} 已存在但内容不同`);
      }
      const stats = JSON.parse(row.stats_json) as ScanStats;
      return { scanId, seq, deduplicated: true, hits: [], position: row.position, state: row.state, stats };
    }
    if (seq !== row.next_seq) {
      throw new AcError(
        "SEQ_OUT_OF_ORDER",
        `块序号乱序: 期望 ${row.next_seq} 或已存在的序号，收到 ${seq}`,
      );
    }

    const { scanner } = this.resumeScanner(scanId);
    const { hits, records } = scanner.feed(text);

    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO chunks (scan_id, seq, text) VALUES (?, ?, ?)`).run(scanId, seq, text);
      const insHit = this.db.prepare(
        `INSERT INTO hits (scan_id, pattern_id, start, "end") VALUES (?, ?, ?, ?)`,
      );
      for (const h of hits) insHit.run(scanId, h.patternId, h.start, h.end);
      const insExp = this.db.prepare(
        `INSERT INTO explain (scan_id, pos, char, fail_json, state, outputs_json) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const rec of records) {
        insExp.run(scanId, rec.pos, rec.char, JSON.stringify(rec.failPath), rec.state, JSON.stringify(rec.outputs));
      }
      this.db
        .prepare(
          `UPDATE scans SET position = ?, state = ?, next_seq = ?, stats_json = ? WHERE id = ?`,
        )
        .run(scanner.pos, scanner.state, seq + 1, JSON.stringify(scanner.stats), scanId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return {
      scanId, seq, deduplicated: false, hits,
      position: scanner.pos, state: scanner.state, stats: { ...scanner.stats },
    };
  }

  end(scanId: number): void {
    const row = this.getScanRow(scanId);
    if (row.status !== "open") throw new AcError("SCAN_ENDED", `扫描 ${scanId} 已结束`);
    this.db.prepare(`UPDATE scans SET status = 'ended' WHERE id = ?`).run(scanId);
  }

  getScan(scanId: number): unknown {
    const row = this.getScanRow(scanId);
    const v = this.getVersion(row.version_id);
    return {
      scanId: row.id,
      status: row.status,
      versionId: row.version_id,
      name: v.name,
      version: v.version,
      position: row.position,
      state: row.state,
      nextSeq: row.next_seq,
      explainLimit: row.explain_limit,
      stats: JSON.parse(row.stats_json),
    };
  }

  getHits(scanId: number): Hit[] {
    this.getScanRow(scanId);
    const v = this.getVersion(this.getScanRow(scanId).version_id);
    const rows = this.db
      .prepare(`SELECT pattern_id AS pid, start, "end" FROM hits WHERE scan_id = ? ORDER BY "end", pattern_id`)
      .all(scanId) as { pid: number; start: number; end: number }[];
    return rows.map((r) => ({ patternId: r.pid, pattern: v.patterns[r.pid], start: r.start, end: r.end }));
  }

  getExplain(scanId: number, from?: number, to?: number): ExplainRecord[] {
    this.getScanRow(scanId);
    const rows = this.db
      .prepare(
        `SELECT pos, char, fail_json, state, outputs_json FROM explain
         WHERE scan_id = ? AND (? IS NULL OR pos >= ?) AND (? IS NULL OR pos < ?)
         ORDER BY pos`,
      )
      .all(scanId, from ?? null, from ?? null, to ?? null, to ?? null) as {
        pos: number; char: string; fail_json: string; state: number; outputs_json: string;
      }[];
    return rows.map((r) => ({
      pos: r.pos,
      char: r.char,
      failPath: JSON.parse(r.fail_json),
      state: r.state,
      outputs: JSON.parse(r.outputs_json),
    }));
  }

  /** 导出完整报告（扫描配置、统计、全部命中、解释记录）。 */
  report(scanId: number): unknown {
    const scan = this.getScan(scanId) as Record<string, unknown>;
    const v = this.getVersion((scan as { versionId: number }).versionId);
    return {
      ...scan,
      patterns: v.patterns,
      hits: this.getHits(scanId),
      explain: this.getExplain(scanId),
    };
  }
}
