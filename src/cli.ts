import { openDb, dataDir } from './db';
import { Service } from './service';
import { startServer } from './server';

function fmtHits(hits: { pid: number; pattern: string; start: number; end: number }[]): string {
  if (hits.length === 0) return '（无命中）';
  return hits
    .map((h) => `  #${h.pid} ${JSON.stringify(h.pattern)}  [${h.start}, ${h.end})`)
    .join('\n');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const svc = new Service(openDb());

  switch (cmd) {
    case 'serve': {
      const portIdx = args.indexOf('--port');
      const port = portIdx >= 0 ? Number(args[portIdx + 1]) : undefined;
      const actual = await startServer(svc, port);
      console.log(`API 服务已启动: http://127.0.0.1:${actual}  (数据目录: ${dataDir()})`);
      return; // 保持进程存活
    }
    case 'add-set': {
      const [name, ...patterns] = args;
      console.log(JSON.stringify(svc.createPatternSet(name, patterns)));
      break;
    }
    case 'new-version': {
      const [setId, ...patterns] = args;
      console.log(JSON.stringify(svc.createVersion(Number(setId), patterns)));
      break;
    }
    case 'compile':
      console.log(JSON.stringify(svc.compile(Number(args[0]))));
      break;
    case 'version':
      console.log(JSON.stringify(svc.getVersion(Number(args[0])), null, 2));
      break;
    case 'graph':
      console.log(svc.graph(Number(args[0])));
      break;
    case 'scan':
      console.log(JSON.stringify(svc.createScan(Number(args[0]))));
      break;
    case 'append':
      console.log(JSON.stringify(svc.append(Number(args[0]), Number(args[1]), args[2] ?? '')));
      break;
    case 'finish':
      console.log(JSON.stringify(svc.finish(Number(args[0]))));
      break;
    case 'hits':
      console.log(fmtHits(svc.hits(Number(args[0])) as never));
      break;
    case 'stats':
      console.log(JSON.stringify(svc.stats(Number(args[0])), null, 2));
      break;
    case 'explain': {
      const rows = svc.explain(
        Number(args[0]),
        args[1] === undefined ? undefined : Number(args[1]),
        args[2] === undefined ? undefined : Number(args[2]),
      );
      for (const r of rows) {
        console.log(
          `  pos=${r.pos} 字符=${JSON.stringify(r.char)} 状态 ${r.stateBefore} -> ${r.stateAfter}` +
            ` 失败边=[${r.failPath.join(',')}] 新增输出=[${r.outputs.join(',')}]`,
        );
      }
      break;
    }
    case 'export':
      console.log(JSON.stringify(svc.exportReport(Number(args[0])), null, 2));
      break;
    case 'demo':
      runDemo(svc);
      break;
    default:
      console.log(`用法: node dist/src/cli.js <命令>
  serve [--port N]                 启动 API 服务（默认自动选择空闲端口）
  add-set <名称> <模式...>          新建模式集（版本 1）
  new-version <setId> <模式...>     为模式集创建新版本
  compile <versionId>              编译版本（构建自动机）
  version <versionId>              查看版本详情
  graph <versionId>                打印转移图文本表示
  scan <versionId>                 创建扫描
  append <scanId> <seq> <文本>      追加一个块（空文本传 ""）
  finish <scanId>                  结束扫描
  hits <scanId>                    查询命中
  stats <scanId>                   查询统计
  explain <scanId> [from] [to]     查看转移解释
  export <scanId>                  导出完整报告 JSON
  demo                             运行完整演示`);
  }
}

function runDemo(svc: Service) {
  console.log('=== 演示 1: he/she/his/hers 扫描 "ushers"（整块） ===');
  const { versionId } = svc.createPatternSet('demo-usher', ['he', 'she', 'his', 'hers']);
  console.log('编译:', JSON.stringify(svc.compile(versionId)));
  console.log('--- 转移图 ---');
  console.log(svc.graph(versionId));
  const s1 = svc.createScan(versionId).scanId;
  svc.append(s1, 0, 'ushers');
  svc.finish(s1);
  console.log('--- 命中 ---');
  console.log(fmtHits(svc.hits(s1) as never));
  console.log('--- 转移解释 ---');
  for (const r of svc.explain(s1)) {
    console.log(
      `  pos=${r.pos} 字符=${r.char} 状态 ${r.stateBefore} -> ${r.stateAfter}` +
        ` 失败边=[${r.failPath.join(',')}] 输出=[${r.outputs.join(',')}]`,
    );
  }

  console.log('\n=== 演示 2: 同一文本切成 u / sh / ers 三块 ===');
  const s2 = svc.createScan(versionId).scanId;
  svc.append(s2, 0, 'u');
  svc.append(s2, 1, 'sh');
  svc.append(s2, 2, 'ers');
  svc.finish(s2);
  console.log(fmtHits(svc.hits(s2) as never));

  console.log('\n=== 演示 3: 中文与表情符号跨块（码点下标） ===');
  const v2 = svc.createPatternSet('demo-cjk', ['世界', '🌍🌎', '界🌍']).versionId;
  svc.compile(v2);
  const s3 = svc.createScan(v2).scanId;
  svc.append(s3, 0, '你好世');
  svc.append(s3, 1, '界🌍');
  svc.append(s3, 2, '🌎!');
  svc.finish(s3);
  console.log('文本: "你好世界🌍🌎!"（按码点：你=0 好=1 世=2 界=3 🌍=4 🌎=5 !=6）');
  console.log(fmtHits(svc.hits(s3) as never));
  console.log(
    '注意: "🌍" 在 JavaScript 字符串下标中占 2 个位置（length=2），这里按码点计为 1 个位置。',
  );
  console.log('--- 统计 ---');
  console.log(JSON.stringify(svc.stats(s3), null, 2));
}

main().catch((e) => {
  console.error(e.code ? `[${e.code}] ${e.message}` : e);
  process.exitCode = 1;
});
