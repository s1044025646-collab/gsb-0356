// Aho–Corasick 自动机：Trie + 失败指针 + 输出继承。
// 所有文本按 Unicode 码点处理（通过 for..of / Array.from 迭代）。

export class AcError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "AcError";
  }
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function assertValidUnicode(s: unknown, what: string): asserts s is string {
  if (typeof s !== "string") {
    throw new AcError("BAD_REQUEST", `${what} 必须是字符串`);
  }
  if (LONE_SURROGATE.test(s)) {
    throw new AcError("INVALID_UNICODE", `${what} 含有孤立代理项，不是完整有效的 Unicode 字符串`);
  }
}

export function toCodePoints(s: string): string[] {
  return Array.from(s);
}

export interface Hit {
  patternId: number;
  pattern: string;
  start: number; // 码点下标，从 0 开始
  end: number; // 右端不含
}

export interface FailStep {
  from: number;
  to: number;
}

export interface ExplainRecord {
  pos: number; // 输入字符的全局码点下标
  char: string;
  failPath: FailStep[]; // 本字符经过的失败边
  state: number; // 处理完该字符后的状态
  outputs: number[]; // 本字符新增的命中模式编号
}

export interface ScanStats {
  positions: number; // 已消费的码点总数
  failTraversals: number; // 失败边累计次数
  hits: number; // 命中总数
  explainRecords: number; // 已保存的解释记录数
  explainTruncated: boolean; // 解释记录是否已达上限被截断
}

export class Automaton {
  readonly patterns: string[];
  readonly patternCps: string[][];
  readonly totalPatternLen: number;
  // goto 表：每个状态一个 Map<码点, 目标状态>
  readonly trans: Map<string, number>[] = [];
  readonly fail: number[] = [];
  // out[v]：在状态 v 结束的全部模式编号（含自失败链继承），按编号升序
  readonly out: number[][] = [];
  readonly own: number[][] = [];

  constructor(patterns: string[]) {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new AcError("BAD_REQUEST", "模式集不能为空数组");
    }
    const seen = new Set<string>();
    for (const p of patterns) {
      assertValidUnicode(p, "模式");
      if (p.length === 0) throw new AcError("EMPTY_PATTERN", "模式不能为空串");
      if (seen.has(p)) {
        throw new AcError("DUPLICATE_PATTERN", `重复的模式文本: ${JSON.stringify(p)}`);
      }
      seen.add(p);
    }
    this.patterns = patterns.slice();
    this.patternCps = patterns.map(toCodePoints);
    this.totalPatternLen = this.patternCps.reduce((a, c) => a + c.length, 0);
    this.build();
  }

  private newState(): number {
    this.trans.push(new Map());
    this.fail.push(0);
    this.out.push([]);
    this.own.push([]);
    return this.trans.length - 1;
  }

  private build(): void {
    this.newState(); // 根 = 0
    // 1) 建 Trie，模式编号 = 插入顺序（稳定）
    this.patterns.forEach((p, id) => {
      let v = 0;
      for (const ch of this.patternCps[id]) {
        const nxt = this.trans[v].get(ch);
        if (nxt === undefined) {
          const u = this.newState();
          this.trans[v].set(ch, u);
          v = u;
        } else {
          v = nxt;
        }
      }
      this.own[v].push(id);
    });
    // 2) BFS 计算失败指针与输出继承（保证 fail[v] 深度严格小于 v，不会成环）
    const queue: number[] = [];
    for (const [, u] of this.trans[0]) {
      this.fail[u] = 0;
      queue.push(u);
    }
    while (queue.length > 0) {
      const v = queue.shift()!;
      for (const [ch, u] of this.trans[v]) {
        let f = this.fail[v];
        while (f !== 0 && !this.trans[f].has(ch)) f = this.fail[f];
        const t = this.trans[f].get(ch);
        this.fail[u] = t !== undefined && t !== u ? t : 0;
        queue.push(u);
      }
    }
    // 3) 输出继承：BFS 顺序保证 fail[v] 已处理
    const order: number[] = [];
    {
      const q: number[] = [];
      for (const [, u] of this.trans[0]) q.push(u);
      while (q.length > 0) {
        const v = q.shift()!;
        order.push(v);
        for (const [, u] of this.trans[v]) q.push(u);
      }
    }
    for (const v of order) {
      const merged = this.own[v].concat(this.out[this.fail[v]]);
      merged.sort((a, b) => a - b);
      this.out[v] = merged;
    }
    this.out[0] = [];
    // 自检：失败指针不得形成非根循环
    for (let s = 1; s < this.fail.length; s++) {
      let v = s;
      const visited = new Set<number>();
      while (v !== 0) {
        if (visited.has(v)) throw new AcError("INTERNAL", "失败指针成环");
        visited.add(v);
        v = this.fail[v];
      }
    }
  }

  get stateCount(): number {
    return this.trans.length;
  }

  /** 转移图的文本表示 */
  dump(): string {
    const lines: string[] = [];
    lines.push(`状态数: ${this.stateCount}, 模式数: ${this.patterns.length}`);
    this.patterns.forEach((p, i) => lines.push(`模式 #${i}: ${JSON.stringify(p)}`));
    for (let v = 0; v < this.stateCount; v++) {
      for (const [ch, u] of this.trans[v]) {
        lines.push(`goto ${v} --${JSON.stringify(ch)}--> ${u}`);
      }
    }
    for (let v = 1; v < this.stateCount; v++) {
      lines.push(`fail ${v} -> ${this.fail[v]}`);
    }
    for (let v = 0; v < this.stateCount; v++) {
      if (this.out[v].length > 0) {
        lines.push(`out ${v} -> [${this.out[v].join(", ")}]`);
      }
    }
    return lines.join("\n");
  }
}

export interface FeedResult {
  hits: Hit[];
  records: ExplainRecord[]; // 本块产生的解释记录（可能因截断而不完整）
}

export class Scanner {
  state = 0;
  pos = 0; // 全局码点位置（已消费字符数）
  readonly stats: ScanStats = {
    positions: 0,
    failTraversals: 0,
    hits: 0,
    explainRecords: 0,
    explainTruncated: false,
  };
  private explain: ExplainRecord[] = [];

  constructor(
    readonly ac: Automaton,
    readonly explainLimit: number = 1000,
  ) {}

  /** 喂入一个文本块；空块不改变状态。 */
  feed(chunk: string): FeedResult {
    assertValidUnicode(chunk, "文本块");
    const hits: Hit[] = [];
    const records: ExplainRecord[] = [];
    for (const ch of toCodePoints(chunk)) {
      const failPath: FailStep[] = [];
      let v = this.state;
      // 失败转移不消耗当前字符，直到找到可走边或退回根
      while (v !== 0 && !this.ac.trans[v].has(ch)) {
        const to = this.ac.fail[v];
        failPath.push({ from: v, to });
        this.stats.failTraversals++;
        v = to;
      }
      const nxt = this.ac.trans[v].get(ch);
      this.state = nxt !== undefined ? nxt : 0;
      const outputs = this.ac.out[this.state];
      const end = this.pos + 1;
      for (const pid of outputs) {
        const start = end - this.ac.patternCps[pid].length;
        hits.push({ patternId: pid, pattern: this.ac.patterns[pid], start, end });
      }
      this.stats.hits += outputs.length;
      this.pos++;
      this.stats.positions = this.pos;
      if (this.explain.length < this.explainLimit) {
        const rec: ExplainRecord = {
          pos: this.pos - 1,
          char: ch,
          failPath,
          state: this.state,
          outputs: outputs.slice(),
        };
        this.explain.push(rec);
        records.push(rec);
      } else {
        this.stats.explainTruncated = true;
      }
    }
    this.stats.explainRecords = this.explain.length;
    return { hits, records };
  }

  getExplain(): ExplainRecord[] {
    return this.explain.slice();
  }
}
