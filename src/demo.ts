// 完整演示：ushers 经典用例、跨块一致性、中文与表情符号码点下标。

import { Automaton, Scanner } from "./automaton";
import { Store } from "./store";

export function runDemo(store: Store): void {
  const log = (s = "") => console.log(s);

  log("=== 1. 经典用例: 模式 he/she/his/hers 扫描 ushers ===");
  const { versionId } = store.compileVersion("demo-en", ["he", "she", "his", "hers"]);
  const v = store.getVersion(versionId);
  const ac = new Automaton(v.patterns);
  log("--- 转移图 ---");
  log(ac.dump());
  const scan1 = store.createScan(versionId);
  store.append(scan1, 0, "ushers");
  store.end(scan1);
  log("--- 命中（整块 ushers）---");
  for (const h of store.getHits(scan1)) {
    log(`  #${h.patternId} ${h.pattern} [${h.start},${h.end})`);
  }

  log("");
  log("=== 2. 同样文本切成 u / sh / ers 三块，结果一致 ===");
  const scan2 = store.createScan(versionId);
  store.append(scan2, 0, "u");
  store.append(scan2, 1, "sh");
  store.append(scan2, 2, "ers");
  store.end(scan2);
  for (const h of store.getHits(scan2)) {
    log(`  #${h.patternId} ${h.pattern} [${h.start},${h.end})`);
  }

  log("");
  log("=== 3. 转移解释（扫描 ushers 时每个字符的失败边与输出）===");
  for (const r of store.getExplain(scan1)) {
    const fails = r.failPath.map((f) => `${f.from}->${f.to}`).join(" ");
    log(`  pos=${r.pos} char=${r.char} fail=[${fails}] state=${r.state} out=[${r.outputs}]`);
  }

  log("");
  log("=== 4. 中文与表情符号：码点下标 vs JavaScript 字符串下标 ===");
  const { versionId: v2 } = store.compileVersion("demo-zh", ["世界", "🌍", "好🌍"]);
  const scan3 = store.createScan(v2);
  const t1 = "你好🌍，世";
  const t2 = "界！";
  store.append(scan3, 0, t1);
  store.append(scan3, 1, t2);
  store.end(scan3);
  const full = t1 + t2;
  log(`文本: ${JSON.stringify(full)}（"世界" 跨块命中；"好🌍" 跨码点边界）`);
  for (const h of store.getHits(scan3)) {
    const jsStart = [...full].slice(0, h.start).join("").length;
    log(`  #${h.patternId} ${h.pattern} 码点区间 [${h.start},${h.end})，JS 字符串下标起点 ${jsStart}`);
  }
  log(`说明: "🌍" 是 1 个码点但占 2 个 JS 字符串下标（UTF-16 代理对）。`);
  log(`码点长度=${Array.from(full).length}，JS length=${full.length}。`);

  log("");
  log("=== 5. 统计 ===");
  log(JSON.stringify((store.getScan(scan1) as { stats: unknown }).stats, null, 2));
}
