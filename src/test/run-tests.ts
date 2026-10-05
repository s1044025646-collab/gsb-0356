// 测试：node dist/test/run-tests.js（先 npm run build）
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AcError, Automaton, Hit, Scanner, toCodePoints } from "../automaton";
import { Store } from "../store";

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

function key(h: Hit): string {
  return `${h.patternId}:${h.start}:${h.end}`;
}

/** 独立基准：逐位置直接比较（码点数组），核对全部匹配。 */
function baseline(patterns: string[], text: string): Hit[] {
  const t = toCodePoints(text);
  const hits: Hit[] = [];
  patterns.forEach((p, pid) => {
    const pc = toCodePoints(p);
    for (let i = 0; i + pc.length <= t.length; i++) {
      let ok = true;
      for (let j = 0; j < pc.length; j++) {
        if (t[i + j] !== pc[j]) { ok = false; break; }
      }
      if (ok) hits.push({ patternId: pid, pattern: p, start: i, end: i + pc.length });
    }
  });
  hits.sort((a, b) => a.end - b.end || a.patternId - b.patternId);
  return hits;
}

function scanChunked(patterns: string[], chunks: string[], explainLimit = 1000): Hit[] {
  const sc = new Scanner(new Automaton(patterns), explainLimit);
  const hits: Hit[] = [];
  for (const c of chunks) hits.push(...sc.feed(c).hits);
  hits.sort((a, b) => a.end - b.end || a.patternId - b.patternId);
  return hits;
}

const P = ["he", "she", "his", "hers"];

test("ushers 整块: she [1,4), he [2,4), hers [2,6)", () => {
  const hits = scanChunked(P, ["ushers"]);
  const got = hits.map((h) => `${h.pattern} [${h.start},${h.end})`);
  // 相同终点按模式编号排序：he(#0) 在 she(#1) 前
  assert.deepEqual(got, ["he [2,4)", "she [1,4)", "hers [2,6)"]);
});

test("ushers 切成 u/sh/ers 结果一致", () => {
  const a = scanChunked(P, ["ushers"]).map(key);
  const b = scanChunked(P, ["u", "sh", "ers"]).map(key);
  assert.deepEqual(b, a);
});

test("后缀继承: she 命中时同时输出 he", () => {
  const hits = scanChunked(["he", "she"], ["she"]);
  assert.deepEqual(hits.map((h) => h.pattern), ["he", "she"]);
});

test("重复字符与重叠命中: aaaa 中的 aa", () => {
  const hits = scanChunked(["aa"], ["aaaa"]);
  assert.deepEqual(hits.map((h) => [h.start, h.end]), [[0, 2], [1, 3], [2, 4]]);
});

test("多次退回: aaab 中的 aab 需要多级失败", () => {
  const hits = scanChunked(["aab", "ab", "b"], ["xaaab"]);
  assert.deepEqual(hits.map((h) => `${h.pattern}@${h.start}`), ["aab@2", "ab@3", "b@4"]);
});

test("无匹配", () => {
  assert.equal(scanChunked(P, ["xyz"]).length, 0);
});

test("空块不改变状态", () => {
  const sc = new Scanner(new Automaton(P));
  sc.feed("us");
  const s1 = sc.state;
  const p1 = sc.pos;
  sc.feed("");
  assert.equal(sc.state, s1);
  assert.equal(sc.pos, p1);
  sc.feed("hers");
  assert.ok(sc.stats.hits > 0);
});

test("中文与表情跨块: 码点下标", () => {
  const hits = scanChunked(["世界", "🌍", "好🌍"], ["你好", "🌍，世", "界！"]);
  const got = hits.map((h) => `${h.pattern} [${h.start},${h.end})`);
  assert.deepEqual(got, ["🌍 [2,3)", "好🌍 [1,3)", "世界 [4,6)"]);
});

test("拒绝孤立代理项", () => {
  assert.throws(() => new Automaton(["\uD800"]), (e: AcError) => e.code === "INVALID_UNICODE");
  assert.throws(
    () => new Scanner(new Automaton(["a"])).feed("\uDC00"),
    (e: AcError) => e.code === "INVALID_UNICODE",
  );
});

test("拒绝空模式与重复模式", () => {
  assert.throws(() => new Automaton(["a", ""]), (e: AcError) => e.code === "EMPTY_PATTERN");
  assert.throws(() => new Automaton(["a", "a"]), (e: AcError) => e.code === "DUPLICATE_PATTERN");
});

test("解释截断不停止匹配", () => {
  const sc = new Scanner(new Automaton(["aa"]), 2);
  sc.feed("aaaa");
  assert.equal(sc.stats.hits, 3);
  assert.equal(sc.stats.positions, 4);
  assert.equal(sc.getExplain().length, 2);
  assert.equal(sc.stats.explainTruncated, true);
});

test("相同终点的多个命中按模式编号排序", () => {
  const hits = scanChunked(["bc", "abc", "c"], ["abc"]);
  assert.deepEqual(hits.map((h) => h.patternId), [0, 1, 2]);
});

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ac-")), "t.db");
}

test("重启后继续追加与一次扫描一致", () => {
  const db = tmpDb();
  let store = new Store(db);
  const { versionId } = store.compileVersion("t", P);
  const scanId = store.createScan(versionId);
  store.append(scanId, 0, "us");
  store.close();
  store = new Store(db);
  store.append(scanId, 1, "he");
  store.append(scanId, 2, "rs");
  store.end(scanId);
  const got = store.getHits(scanId).map(key);
  const want = scanChunked(P, ["ushers"]).map(key);
  assert.deepEqual(got, want);
  store.close();
});

test("重复序号去重与冲突", () => {
  const store = new Store(":memory:");
  const { versionId } = store.compileVersion("t", P);
  const id = store.createScan(versionId);
  store.append(id, 0, "us");
  const dup = store.append(id, 0, "us");
  assert.equal(dup.deduplicated, true);
  assert.equal((store.getScan(id) as { position: number }).position, 2);
  assert.throws(() => store.append(id, 0, "xx"), (e: AcError) => e.code === "SEQ_CONFLICT");
  assert.throws(() => store.append(id, 5, "h"), (e: AcError) => e.code === "SEQ_OUT_OF_ORDER");
  store.close();
});

test("结束后拒绝追加", () => {
  const store = new Store(":memory:");
  const { versionId } = store.compileVersion("t", P);
  const id = store.createScan(versionId);
  store.append(id, 0, "ushers");
  store.end(id);
  assert.throws(() => store.append(id, 1, "x"), (e: AcError) => e.code === "SCAN_ENDED");
  store.close();
});

test("修改模式集生成新版本，旧扫描不受影响", () => {
  const store = new Store(":memory:");
  const v1 = store.compileVersion("t", ["he", "she"]);
  const v2 = store.compileVersion("t", ["he", "she", "hers"]);
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  const id = store.createScan(v1.versionId);
  store.append(id, 0, "ushers");
  assert.deepEqual(store.getHits(id).map((h) => h.pattern), ["he", "she"]);
  store.close();
});

test("随机小规模输入与逐位置基准完全一致", () => {
  let s = 42;
  const rng = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = ["a", "b", "c", "世", "界", "🌍"];
  for (let iter = 0; iter < 200; iter++) {
    const npat = 1 + Math.floor(rng() * 4);
    const pats = new Set<string>();
    while (pats.size < npat) {
      const len = 1 + Math.floor(rng() * 4);
      let p = "";
      for (let i = 0; i < len; i++) p += alphabet[Math.floor(rng() * alphabet.length)];
      pats.add(p);
    }
    const patterns = [...pats];
    const textLen = Math.floor(rng() * 40);
    let text = "";
    for (let i = 0; i < textLen; i++) text += alphabet[Math.floor(rng() * alphabet.length)];
    const cps = toCodePoints(text);
    const chunks: string[] = [];
    let i = 0;
    while (i < cps.length) {
      const n = 1 + Math.floor(rng() * 5);
      chunks.push(cps.slice(i, i + n).join(""));
      i += n;
    }
    const got = scanChunked(patterns, chunks).map(key);
    const want = baseline(patterns, text).map(key);
    assert.deepEqual(got, want, `iter=${iter} patterns=${JSON.stringify(patterns)} text=${JSON.stringify(text)}`);
  }
});

console.log(`\n${passed} 个测试通过${process.exitCode ? "（存在失败）" : ""}`);
