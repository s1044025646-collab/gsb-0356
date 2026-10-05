import Database from 'better-sqlite3';
import { ApiError } from './errors';
import { validatePatterns, toCodePoints } from './validate';
import { Automaton, buildAutomaton, scanOne, graphText, StepRecord } from './automaton';

export const EXPLAIN_MAX = Math.max(0, Number(process.env.AC_EXPLAIN_MAX ?? 1000));

export class Service {
  private autoCache = new Map<number, Automaton>();

  constructor(public db: Database.Database) {}

  // ---------- 模式集与版本 ----------

  createPatternSet(name: unknown, rawPatterns: unknown) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new ApiError('VALIDATION', 'name 必须是非空字符串');
    }
    const patterns = validatePatterns(rawPatterns);
    const tx = this.db.transaction(() => {
      const setId = Number(
        this.db.prepare('INSERT INTO pattern_sets (name) VALUES (?)').run(name).lastInsertRowid,
      );
      const versionId = this.insertVersion(setId, 1, patterns);
      return { setId, versionId, version: 1 };
    });
    return tx();
  }

  createVersion(setId: number, rawPatterns: unknown) {
    const patterns = validatePatterns(rawPatterns);
    const set = this.db.prepare('SELECT id FROM pattern_sets WHERE id = ?').get(setId);
    if (!set) throw new ApiError('NOT_FOUND', `模式集 ${setId} 不存在`);
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(version_no), 0) AS v FROM versions WHERE set_id = ?')
        .get(setId) as { v: number };
      const versionId = this.insertVersion(setId, row.v + 1, patterns);
      return { setId, versionId, version: row.v + 1 };
    });
    return tx();
  }

  private insertVersion(
    setId: number,
    versionNo: number,
    patterns: { text: string; cps: string[] }[],
  ): number {
    const totalLen = patterns.reduce((a, p) => a + p.cps.length, 0);
    const versionId = Number(
      this.db
        .prepare(
          'INSERT INTO versions (set_id, version_no, total_pattern_len) VALUES (?, ?, ?)',
        )
        .run(setId, versionNo, totalLen).lastInsertRowid,
    );
    const ins = this.db.prepare(
      'INSERT INTO patterns (version_id, pid, text, len) VALUES (?, ?, ?, ?)',
    );
    patterns.forEach((p, pid) => ins.run(versionId, pid, p.text, p.cps.length));
    return versionId;
  }

  getVersion(versionId: number) {
    const v = this.db
      .prepare(
        'SELECT id, set_id AS setId, version_no AS version, compiled, node_count AS nodeCount, total_pattern_len AS totalPatternLen, created_at AS createdAt FROM versions WHERE id = ?',
      )
      .get(versionId) as
      | {
          id: number;
          setId: number;
          version: number;
          compiled: number;
          nodeCount: number | null;
          totalPatternLen: number;
          createdAt: string;
        }
      | undefined;
    if (!v) throw new ApiError('NOT_FOUND', `版本 ${versionId} 不存在`);
    const patterns = this.db
      .prepare('SELECT pid, text, len FROM patterns WHERE version_id = ? ORDER BY pid')
      .all(versionId) as { pid: number; text: string; len: number }[];
    return { ...v, compiled: !!v.compiled, patterns };
  }

  // ---------- 编译 ----------

  compile(versionId: number) {
    const v = this.getVersion(versionId);
    const auto = this.buildFor(versionId);
    this.db
      .prepare('UPDATE versions SET compiled = 1, node_count = ? WHERE id = ?')
      .run(auto.nodes.length, versionId);
    return {
      versionId,
      compiled: true,
      nodeCount: auto.nodes.length,
      patternCount: auto.patterns.length,
      totalPatternLen: v.totalPatternLen,
    };
  }

  private buildFor(versionId: number): Automaton {
    const cached = this.autoCache.get(versionId);
    if (cached) return cached;
    const rows = this.db
      .prepare('SELECT pid, text FROM patterns WHERE version_id = ? ORDER BY pid')
      .all(versionId) as { pid: number; text: string }[];
    if (rows.length === 0) throw new ApiError('NOT_FOUND', `版本 ${versionId} 不存在或无模式`);
    const texts = rows.map((r) => r.text);
    const cps = texts.map((t) => Array.from(t));
    const auto = buildAutomaton(cps, texts);
    this.autoCache.set(versionId, auto);
    return auto;
  }

  graph(versionId: number): string {
    this.getVersion(versionId);
    return graphText(this.buildFor(versionId));
  }

  // ---------- 扫描 ----------

  createScan(versionId: number) {
    const v = this.getVersion(versionId);
    if (!v.compiled) throw new ApiError('NOT_COMPILED', `版本 ${versionId} 尚未编译`);
    const id = Number(
      this.db.prepare('INSERT INTO scans (version_id) VALUES (?)').run(versionId).lastInsertRowid,
    );
    return { scanId: id, versionId };
  }

  private getScanRow(scanId: number) {
    const s = this.db.prepare('SELECT * FROM scans WHERE id = ?').get(scanId) as
      | {
          id: number;
          version_id: number;
          state: number;
          pos: number;
          next_seq: number;
          finished: number;
          explain_count: number;
        }
      | undefined;
    if (!s) throw new ApiError('NOT_FOUND', `扫描 ${scanId} 不存在`);
    return s;
  }

  // 追加一个块：单块原子提交；重复序号按公开规则去重/报冲突。
  append(scanId: number, seq: unknown, text: unknown) {
    if (!Number.isInteger(seq) || (seq as number) < 0) {
      throw new ApiError('VALIDATION', 'seq 必须是非负整数');
    }
    const cps = toCodePoints(text as string, 'text');
    const s = this.getScanRow(scanId);
    if (s.finished) {
      throw new ApiError('SCAN_FINISHED', `扫描 ${scanId} 已结束，拒绝继续追加`);
    }
    const n = seq as number;
    if (n < s.next_seq) {
      const prev = this.db
        .prepare('SELECT text FROM chunks WHERE scan_id = ? AND seq = ?')
        .get(scanId, n) as { text: string } | undefined;
      if (prev && prev.text === (text as string)) {
        return { scanId, seq: n, deduplicated: true, hits: 0 };
      }
      throw new ApiError(
        'SEQ_CONFLICT',
        `序号 ${n} 已使用且内容不同，构成冲突`,
      );
    }
    if (n !== s.next_seq) {
      throw new ApiError(
        'SEQ_OUT_OF_ORDER',
        `期望序号 ${s.next_seq}，收到 ${n}（块必须按序到达，重复序号用于去重）`,
      );
    }

    const auto = this.buildFor(s.version_id);
    const tx = this.db.transaction(() => {
      let state = s.state;
      let pos = s.pos;
      let explainCount = s.explain_count;
      let hits = 0;
      let failSteps = 0;
      const insHit = this.db.prepare(
        'INSERT INTO hits (scan_id, pid, pattern, start, "end") VALUES (?, ?, ?, ?, ?)',
      );
      const insExp = this.db.prepare(
        'INSERT INTO explains (scan_id, pos, char, state_before, fail_path, state_after, outputs) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const ch of cps) {
        const r = scanOne(auto, state, ch, pos);
        state = r.state;
        failSteps += r.rec.failPath.length;
        for (const pid of r.rec.outputs) {
          insHit.run(scanId, pid, auto.patterns[pid], pos + 1 - auto.patternLens[pid], pos + 1);
          hits++;
        }
        if (explainCount < EXPLAIN_MAX) {
          insExp.run(
            scanId,
            pos,
            ch,
            r.rec.stateBefore,
            JSON.stringify(r.rec.failPath),
            r.rec.stateAfter,
            JSON.stringify(r.rec.outputs),
          );
          explainCount++;
        } else {
          this.db
            .prepare('UPDATE scans SET explain_truncated = 1 WHERE id = ?')
            .run(scanId);
        }
        pos++;
      }
      this.db
        .prepare('INSERT INTO chunks (scan_id, seq, text, chars) VALUES (?, ?, ?, ?)')
        .run(scanId, n, text as string, cps.length);
      this.db
        .prepare(
          `UPDATE scans SET state = ?, pos = ?, next_seq = ?, explain_count = ?,
             total_chars = total_chars + ?, total_chunks = total_chunks + 1,
             total_hits = total_hits + ?, total_fail_steps = total_fail_steps + ?
           WHERE id = ?`,
        )
        .run(state, pos, n + 1, explainCount, cps.length, hits, failSteps, scanId);
      return { scanId, seq: n, deduplicated: false, chars: cps.length, hits };
    });
    return tx();
  }

  finish(scanId: number) {
    const s = this.getScanRow(scanId);
    if (s.finished) return { scanId, finished: true, already: true };
    this.db.prepare('UPDATE scans SET finished = 1 WHERE id = ?').run(scanId);
    return { scanId, finished: true, already: false };
  }

  hits(scanId: number) {
    this.getScanRow(scanId);
    const rows = this.db
      .prepare('SELECT pid, pattern, start, "end" FROM hits WHERE scan_id = ? ORDER BY "end", pid')
      .all(scanId);
    return rows;
  }

  stats(scanId: number) {
    const s = this.getScanRow(scanId);
    const row = this.db
      .prepare(
        `SELECT version_id AS versionId, state, pos, next_seq AS nextSeq, finished,
                total_chars AS totalChars, total_chunks AS totalChunks,
                total_hits AS totalHits, total_fail_steps AS totalFailSteps,
                explain_count AS explainCount, explain_truncated AS explainTruncated
         FROM scans WHERE id = ?`,
      )
      .get(scanId) as {
      versionId: number;
      state: number;
      pos: number;
      nextSeq: number;
      finished: number;
      totalChars: number;
      totalChunks: number;
      totalHits: number;
      totalFailSteps: number;
      explainCount: number;
      explainTruncated: number;
    };
    return {
      scanId,
      ...row,
      finished: !!row.finished,
      explainTruncated: !!row.explainTruncated,
      explainMax: EXPLAIN_MAX,
    };
  }

  explain(scanId: number, from?: number, to?: number, limit = 200) {
    this.getScanRow(scanId);
    const rows = this.db
      .prepare(
        `SELECT pos, char, state_before AS stateBefore, fail_path AS failPath,
                state_after AS stateAfter, outputs
         FROM explains
         WHERE scan_id = ? AND pos >= ? AND pos < ?
         ORDER BY pos LIMIT ?`,
      )
      .all(scanId, from ?? 0, to ?? Number.MAX_SAFE_INTEGER, Math.min(limit, 1000)) as {
      pos: number;
      char: string;
      stateBefore: number;
      failPath: string;
      stateAfter: number;
      outputs: string;
    }[];
    return rows.map((r) => ({
      ...r,
      failPath: JSON.parse(r.failPath) as number[],
      outputs: JSON.parse(r.outputs) as number[],
    }));
  }

  exportReport(scanId: number) {
    const s = this.getScanRow(scanId);
    const version = this.getVersion(s.version_id);
    return {
      scan: this.stats(scanId),
      version: {
        id: version.id,
        setId: version.setId,
        version: version.version,
        totalPatternLen: version.totalPatternLen,
        nodeCount: version.nodeCount,
      },
      patterns: version.patterns,
      hits: this.hits(scanId),
      graph: graphText(this.buildFor(s.version_id)),
    };
  }
}
