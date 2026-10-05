// 自行实现的 Aho–Corasick 自动机：Trie + 失败指针 + 输出继承。
// 字符单位为 Unicode 码点（string 元素为单码点字符串）。

export interface AcNode {
  next: Map<string, number>;
  fail: number;
  own: number[]; // 本节点自身结束的模式编号
  out: number[]; // 含失败链继承的全部输出模式编号（升序）
  depth: number;
}

export interface Automaton {
  nodes: AcNode[];
  patterns: string[]; // pid -> 原始模式文本
  patternLens: number[]; // pid -> 码点长度
}

export interface StepRecord {
  pos: number; // 输入字符的全局码点下标
  char: string;
  stateBefore: number;
  failPath: number[]; // 失败转移依次到达的状态（不含起点）
  stateAfter: number;
  outputs: number[]; // 本位置新增的命中模式编号
}

export function buildAutomaton(patterns: string[][], texts: string[]): Automaton {
  const nodes: AcNode[] = [{ next: new Map(), fail: 0, own: [], out: [], depth: 0 }];

  // 1) 构建 Trie
  patterns.forEach((cps, pid) => {
    let cur = 0;
    for (const ch of cps) {
      const node = nodes[cur];
      let nxt = node.next.get(ch);
      if (nxt === undefined) {
        nxt = nodes.length;
        nodes.push({ next: new Map(), fail: 0, own: [], out: [], depth: node.depth + 1 });
        node.next.set(ch, nxt);
      }
      cur = nxt;
    }
    nodes[cur].own.push(pid);
  });

  // 2) BFS 计算失败指针（fail 深度严格递减，保证不存在非根循环）
  const queue: number[] = [];
  for (const [, child] of nodes[0].next) {
    nodes[child].fail = 0;
    queue.push(child);
  }
  while (queue.length > 0) {
    const r = queue.shift()!;
    for (const [ch, s] of nodes[r].next) {
      queue.push(s);
      let f = nodes[r].fail;
      while (f !== 0 && !nodes[f].next.has(ch)) f = nodes[f].fail;
      const t = nodes[f].next.get(ch);
      nodes[s].fail = t !== undefined && t !== s ? t : 0;
      if (nodes[nodes[s].fail].depth >= nodes[s].depth) {
        throw new Error('内部错误：失败指针未指向更浅节点');
      }
    }
  }

  // 3) 输出继承：节点输出 = 自身输出 ∪ fail 节点输出（BFS 顺序保证 fail 已就绪）
  const order: number[] = [];
  {
    const q = [0];
    while (q.length > 0) {
      const n = q.shift()!;
      order.push(n);
      for (const [, c] of nodes[n].next) q.push(c);
    }
  }
  for (const id of order) {
    if (id === 0) continue;
    const merged = new Set([...nodes[id].own, ...nodes[nodes[id].fail].out]);
    nodes[id].out = [...merged].sort((a, b) => a - b);
  }
  nodes[0].out = [];

  return {
    nodes,
    patterns: texts,
    patternLens: patterns.map((p) => p.length),
  };
}

// 用同一自动机持续扫描一个码点；失败转移不消耗当前字符。
export function scanOne(
  auto: Automaton,
  state: number,
  ch: string,
  pos: number,
): { state: number; rec: StepRecord } {
  const failPath: number[] = [];
  let s = state;
  const before = s;
  while (s !== 0 && !auto.nodes[s].next.has(ch)) {
    s = auto.nodes[s].fail;
    failPath.push(s);
  }
  const nxt = auto.nodes[s].next.get(ch);
  if (nxt !== undefined) s = nxt;
  const rec: StepRecord = {
    pos,
    char: ch,
    stateBefore: before,
    failPath,
    stateAfter: s,
    outputs: auto.nodes[s].out,
  };
  return { state: s, rec };
}

// 转移图的文本表示
export function graphText(auto: Automaton): string {
  const lines: string[] = [];
  lines.push('转移边（go）:');
  auto.nodes.forEach((n, id) => {
    for (const [ch, to] of n.next) {
      lines.push(`  ${id} --${JSON.stringify(ch)}--> ${to}`);
    }
  });
  lines.push('失败边（fail）:');
  auto.nodes.forEach((n, id) => {
    if (id !== 0) lines.push(`  ${id} -.-> ${n.fail}`);
  });
  lines.push('输出（含继承）:');
  auto.nodes.forEach((n, id) => {
    if (n.out.length > 0) {
      lines.push(
        `  状态 ${id}: ${n.out.map((p) => `#${p} ${JSON.stringify(auto.patterns[p])}`).join(', ')}`,
      );
    }
  });
  return lines.join('\n');
}
