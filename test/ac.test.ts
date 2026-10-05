import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/db';
import { Service } from '../src/service';
import { ApiError } from '../src/errors';

function tmpSvc(): { svc: Service; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-test-'));
  return { svc: new Service(openDb(dir)), dir };
}

function makeScan(svc: Service, patterns: string[]) {
  const { versionId } = svc.createPatternSet('t', patterns);
  svc.compile(versionId);
  return svc.createScan(versionId).scanId;
}

function feed(svc: Service, scanId: number, chunks: string[]) {
  chunks.forEach((c, i) => svc.append(scanId, i, c));
  svc.finish(scanId);
  return svc.hits(scanId) as { pid: number; pattern: string; start: number; end: number }[];
}

// 独立基准：逐位置直接比较（码点数组）
function naiveHits(patterns: string[], text: string) {
  const t = Array.from(text);
  const pats = patterns.map((p) => Array.from(p));
  const out: { pid: number; start: number; end: number }[] = [];
  for (let end = 1; end <= t.length; end++) {
    pats.forEach((p, pid) => {
      if (p.length <= end) {
        const start = end - p.length;
        if (p.every((ch, i) => t[start + i] === ch)) out.push({ pid, start, end });
      }
    });
    out.sort((a, b) => a.end - b.end || a.pid - b.pid);
  }
  return out;
}

test('ushers: she=[1,4) he=[2,4) hers=[2,6)，整块与分块一致', () => {
  const { svc } = tmpSvc();
  const pats = ['he', 'she', 'his', 'hers'];
  const whole = feed(svc, makeScan(svc, pats), ['ushers']);
  const expect = [
    { pid: 0, pattern: 'he', start: 2, end: 4 },
    { pid: 1, pattern: 'she', start: 1, end: 4 },
    { pid: 3, pattern: 'hers', start: 2, end: 6 },
  ];
  assert.deepEqual(whole, expect);
  const chunked = feed(svc, makeScan(svc, pats), ['u', 'sh', 'ers']);
  assert.deepEqual(chunked, expect);
});

test('前后缀继承与重叠命中（aa 在 aaaa 中命中 3 次）', () => {
  const { svc } = tmpSvc();
  const hits = feed(svc, makeScan(svc, ['aa', 'a']), ['aaaa']);
  assert.deepEqual(
    hits.map((h) => [h.pid, h.start, h.end]),
    [
      [1, 0, 1],
      [0, 0, 2],
      [1, 1, 2],
      [0, 1, 3],
      [1, 2, 3],
      [0, 2, 4],
      [1, 3, 4],
    ],
  );
});

test('多次退回失败边后仍命中', () => {
  const { svc } = tmpSvc();
  const hits = feed(svc, makeScan(svc, ['aab', 'ab', 'b']), ['aaab']);
  assert.deepEqual(
    hits.map((h) => [h.pattern, h.start, h.end]),
    [
      ['aab', 1, 4],
      ['ab', 2, 4],
      ['b', 3, 4],
    ],
  );
});

test('无匹配与空块', () => {
  const { svc } = tmpSvc();
  const scanId = makeScan(svc, ['xyz']);
  svc.append(scanId, 0, 'abc');
  svc.append(scanId, 1, ''); // 空块不改变状态
  svc.append(scanId, 2, 'def');
  svc.finish(scanId);
  assert.deepEqual(svc.hits(scanId), []);
  const st = svc.stats(scanId);
  assert.equal(st.totalChars, 6);
  assert.equal(st.totalChunks, 3);
});

test('空块不丢跨块命中', () => {
  const { svc } = tmpSvc();
  const hits = feed(svc, makeScan(svc, ['abc']), ['a', '', 'b', '', 'c']);
  assert.deepEqual(
    hits.map((h) => [h.start, h.end]),
    [[0, 3]],
  );
});

test('结束后追加被拒绝', () => {
  const { svc } = tmpSvc();
  const scanId = makeScan(svc, ['a']);
  svc.append(scanId, 0, 'a');
  svc.finish(scanId);
  assert.throws(() => svc.append(scanId, 1, 'a'), (e: ApiError) => e.code === 'SCAN_FINISHED');
});

test('重复序号去重，同序号不同内容报冲突', () => {
  const { svc } = tmpSvc();
  const scanId = makeScan(svc, ['a']);
  svc.append(scanId, 0, 'xa');
  const dup = svc.append(scanId, 0, 'xa');
  assert.equal(dup.deduplicated, true);
  assert.throws(() => svc.append(scanId, 0, 'yb'), (e: ApiError) => e.code === 'SEQ_CONFLICT');
  assert.throws(() => svc.append(scanId, 5, 'z'), (e: ApiError) => e.code === 'SEQ_OUT_OF_ORDER');
  svc.append(scanId, 1, 'a');
  svc.finish(scanId);
  assert.equal((svc.hits(scanId) as unknown[]).length, 2);
});

test('重启后继续追加与一次扫描一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-test-'));
  const pats = ['he', 'she', 'his', 'hers'];
  let scanId = 0;
  {
    const svc = new Service(openDb(dir));
    const { versionId } = svc.createPatternSet('t', pats);
    svc.compile(versionId);
    scanId = svc.createScan(versionId).scanId;
    svc.append(scanId, 0, 'us');
  } // 模拟进程退出
  {
    const svc = new Service(openDb(dir)); // 重启后从 SQLite 恢复状态
    svc.append(scanId, 1, 'hers');
    svc.finish(scanId);
    const hits = svc.hits(scanId) as { pid: number; start: number; end: number }[];
    assert.deepEqual(
      hits.map((h) => [h.pid, h.start, h.end]),
      [
        [0, 2, 4],
        [1, 1, 4],
        [3, 2, 6],
      ],
    );
  }
});

test('模式校验：空模式、重复模式、孤立代理项', () => {
  const { svc } = tmpSvc();
  assert.throws(() => svc.createPatternSet('t', ['a', '']), (e: ApiError) => e.code === 'EMPTY_PATTERN');
  assert.throws(() => svc.createPatternSet('t', ['a', 'a']), (e: ApiError) => e.code === 'DUPLICATE_PATTERN');
  assert.throws(() => svc.createPatternSet('t', ['\uD800x']), (e: ApiError) => e.code === 'LONE_SURROGATE');
  const scanId = makeScan(svc, ['a']);
  assert.throws(() => svc.append(scanId, 0, '\uDC00'), (e: ApiError) => e.code === 'LONE_SURROGATE');
});

test('中文与表情符号按码点计下标', () => {
  const { svc } = tmpSvc();
  const hits = feed(svc, makeScan(svc, ['世界', '🌍🌎', '界🌍']), ['你好世', '界🌍', '🌎!']);
  assert.deepEqual(
    hits.map((h) => [h.pattern, h.start, h.end]),
    [
      ['世界', 2, 4],
      ['界🌍', 3, 5],
      ['🌍🌎', 4, 6],
    ],
  );
});

test('新版本不影响进行中的扫描与旧报告', () => {
  const { svc } = tmpSvc();
  const { setId, versionId: v1 } = svc.createPatternSet('t', ['ab']);
  svc.compile(v1);
  const scanId = svc.createScan(v1).scanId;
  svc.append(scanId, 0, 'a');
  const { versionId: v2 } = svc.createVersion(setId, ['abc']);
  svc.compile(v2);
  svc.append(scanId, 1, 'b'); // 仍按旧版本规则
  svc.finish(scanId);
  assert.deepEqual(
    (svc.hits(scanId) as { pattern: string }[]).map((h) => h.pattern),
    ['ab'],
  );
  assert.equal(svc.exportReport(scanId).version.id, v1);
  assert.notEqual(v1, v2);
});

test('解释记录与统计分离，截断不影响匹配', () => {
  const { svc } = tmpSvc();
  const scanId = makeScan(svc, ['she', 'he']);
  const long = 'ushers'.repeat(500); // 3000 码点 > EXPLAIN_MAX(1000)
  svc.append(scanId, 0, long);
  svc.finish(scanId);
  const st = svc.stats(scanId);
  assert.equal(st.totalChars, 3000);
  assert.equal(st.explainCount, 1000);
  assert.equal(st.explainTruncated, true);
  assert.equal(st.totalHits, 1000); // she+he 各 500
  assert.equal((svc.explain(scanId, 2990) as unknown[]).length, 0); // 超出截断范围无记录
});

test('随机小规模输入对照逐位置直接比较', () => {
  const { svc } = tmpSvc();
  const alphabet = ['a', 'b', 'c', '世', '🌍'];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let iter = 0; iter < 50; iter++) {
    const npat = 1 + Math.floor(rnd() * 4);
    const pats = new Set<string>();
    while (pats.size < npat) {
      const len = 1 + Math.floor(rnd() * 4);
      pats.add(Array.from({ length: len }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join(''));
    }
    const patterns = [...pats];
    const textLen = Math.floor(rnd() * 40);
    const text = Array.from({ length: textLen }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
    // 随机切块
    const cps = Array.from(text);
    const chunks: string[] = [];
    let i = 0;
    while (i < cps.length) {
      const n = Math.floor(rnd() * 5);
      chunks.push(cps.slice(i, i + n).join(''));
      i += n;
    }
    const got = feed(svc, makeScan(svc, patterns), chunks);
    const want = naiveHits(patterns, text);
    assert.deepEqual(
      got.map((h) => ({ pid: h.pid, start: h.start, end: h.end })),
      want,
      `iter=${iter} patterns=${JSON.stringify(patterns)} text=${JSON.stringify(text)}`,
    );
  }
});
