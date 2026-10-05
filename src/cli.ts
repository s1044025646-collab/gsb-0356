// CLI：直接操作本地 SQLite 数据目录，或启动 HTTP 服务。

import * as path from "node:path";
import { Store, DEFAULT_EXPLAIN_LIMIT } from "./store";
import { startServer } from "./server";
import { runDemo } from "./demo";

function defaultDbPath(): string {
  return process.env.AC_DB ?? path.join(process.cwd(), "data", "ac.db");
}

function usage(): void {
  console.log(`用法: node dist/cli.js <命令> [参数]

  serve [--port N] [--db PATH]     启动 HTTP API（默认端口 0 = 自动选空闲端口）
  compile <名称> <模式...>          保存模式集并编译新版本
  versions                         列出全部模式集版本
  graph <versionId>                打印自动机转移图（文本表示）
  scan <versionId> [explainLimit]  创建扫描（默认解释上限 ${DEFAULT_EXPLAIN_LIMIT}）
  append <scanId> <seq> <文本>     追加一个文本块（原子提交，重复序号去重）
  end <scanId>                     结束扫描（之后拒绝追加）
  status <scanId>                  查看扫描状态与统计
  hits <scanId>                    查看全部命中
  explain <scanId> [from] [to]     查看转移解释
  report <scanId>                  导出完整报告（JSON）
  demo                             运行完整演示（ushers / 分块 / 中文与表情）

数据目录: 项目内 data/（可用环境变量 AC_DB 覆盖）`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") return usage();

  if (cmd === "serve") {
    let port = 0;
    let db = defaultDbPath();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--port") port = Number(args[++i]);
      else if (args[i] === "--db") db = args[++i];
    }
    const store = new Store(db);
    const { port: actual } = await startServer(store, port);
    console.log(`AC 匹配服务已启动: http://127.0.0.1:${actual}  (数据库: ${db})`);
    return;
  }

  if (cmd === "demo") {
    runDemo(new Store(":memory:"));
    return;
  }

  const store = new Store(defaultDbPath());
  try {
    switch (cmd) {
      case "compile": {
        const [name, ...patterns] = args;
        const r = store.compileVersion(name, patterns);
        console.log(JSON.stringify(r, null, 2));
        break;
      }
      case "versions":
        console.log(JSON.stringify(store.listVersions(), null, 2));
        break;
      case "graph": {
        const v = store.getVersion(Number(args[0]));
        const { Automaton } = require("./automaton") as typeof import("./automaton");
        console.log(new Automaton(v.patterns).dump());
        break;
      }
      case "scan": {
        const id = store.createScan(Number(args[0]), args[1] === undefined ? DEFAULT_EXPLAIN_LIMIT : Number(args[1]));
        console.log(JSON.stringify(store.getScan(id), null, 2));
        break;
      }
      case "append":
        console.log(JSON.stringify(store.append(Number(args[0]), Number(args[1]), args[2] ?? ""), null, 2));
        break;
      case "end":
        store.end(Number(args[0]));
        console.log(JSON.stringify(store.getScan(Number(args[0])), null, 2));
        break;
      case "status":
        console.log(JSON.stringify(store.getScan(Number(args[0])), null, 2));
        break;
      case "hits":
        console.log(JSON.stringify(store.getHits(Number(args[0])), null, 2));
        break;
      case "explain":
        console.log(JSON.stringify(
          store.getExplain(
            Number(args[0]),
            args[1] === undefined ? undefined : Number(args[1]),
            args[2] === undefined ? undefined : Number(args[2]),
          ), null, 2));
        break;
      case "report":
        console.log(JSON.stringify(store.report(Number(args[0])), null, 2));
        break;
      default:
        usage();
        process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main().catch((e) => {
  if (e && e.code) {
    console.error(`错误 [${e.code}] ${e.message}`);
  } else {
    console.error(e);
  }
  process.exitCode = 1;
});
