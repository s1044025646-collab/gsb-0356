# Aho–Corasick 多模式流匹配与失败转移解释后端

纯本地运行的后端服务（仅 API 与 CLI）：自行实现 Aho–Corasick Trie、失败指针与输出继承，
用同一个自动机在连续到来的文本块上做多关键词精确匹配，命中、统计与转移解释持久化到 SQLite。

- 技术栈：TypeScript + Node.js（>=18）+ better-sqlite3，无 Docker / WSL / 在线服务依赖
- 文本与模式按 **Unicode 码点** 处理，区分大小写；不做分词、纠错、正则或相关性排序
- 支持重叠命中、后缀命中（she/he）、跨块命中、空块、重复追加去重、重启续扫

## 快速开始

```powershell
npm install        # 安装依赖
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 API 服务（默认自动选择空闲端口）
npm run demo       # 运行完整演示（ushers / 分块 / 中文与表情符号）
```

数据目录默认为项目内 `./data`（可用环境变量 `AC_DATA_DIR` 覆盖），数据库文件为 `data/ac.db`。

## 核心语义

- **码点下标**：位置是从 0 开始、右端不含的码点下标。`🌍` 在 JavaScript 字符串下标中占 2 个
  位置（`length === 2`，UTF-16 代理对），这里按码点计为 1 个位置。例如文本 `你好世界🌍🌎!`
  的码点下标为 `你=0 好=1 世=2 界=3 🌍=4 🌎=5 !=6`。
- **块边界**：可以位于任意两个码点之间；每块必须是完整有效的 Unicode 字符串，孤立代理项
  （lone surrogate）会被拒绝（错误码 `LONE_SURROGATE`）。不处理被拆开的 UTF-8 字节或跨块代理对。
- **扫描**：失败转移不消耗当前字符，直到找到可走边或退回根；扫描位置跨块累计，空块不改变状态；
  `finish` 不人为增加字符，结束后追加返回 `SCAN_FINISHED`。
- **命中**：返回模式编号、原始模式、全局起点与终点；同一终点的多个命中按模式编号升序输出，
  不只输出最长模式。
- **解释**：每个码点记录状态编号、输入字符、经过的失败边、新增输出。解释记录上限由
  `AC_EXPLAIN_MAX` 控制（默认 1000 条/扫描），截断只影响展示记录，不影响匹配与统计
  （统计字段 `explainTruncated` 会置为 true）。
- **版本**：修改模式集生成新版本；版本编译后在任何一次扫描期间固定，旧扫描与旧报告不受影响。
- **重复追加**：块序号必须等于 `nextSeq`；序号小于 `nextSeq` 且内容相同则去重（幂等成功），
  内容不同报 `SEQ_CONFLICT`（409）；跳号报 `SEQ_OUT_OF_ORDER`。单块追加在 SQLite 事务中原子提交。

## 转移图的文本表示（he / she / his / hers）

`npm run demo` 或 `node dist/src/cli.js graph <versionId>` 输出：

```
转移边（go）:
  0 --"h"--> 1
  0 --"s"--> 3
  1 --"e"--> 2
  1 --"i"--> 6
  2 --"r"--> 8
  3 --"h"--> 4
  4 --"e"--> 5
  6 --"s"--> 7
  8 --"s"--> 9
失败边（fail）:
  4 -.-> 1     5 -.-> 2     7 -.-> 3     9 -.-> 3   （其余指向根 0）
输出（含继承）:
  状态 2: #0 "he"
  状态 5: #0 "he", #1 "she"     <- 输出继承：she 的结点同时输出后缀 he
  状态 7: #2 "his"
  状态 9: #3 "hers"
```

扫描 `ushers` 的转移解释（`explain`）：

```
pos=0 字符=u 状态 0 -> 0 失败边=[]  输出=[]
pos=1 字符=s 状态 0 -> 3 失败边=[]  输出=[]
pos=2 字符=h 状态 3 -> 4 失败边=[]  输出=[]
pos=3 字符=e 状态 4 -> 5 失败边=[]  输出=[0,1]   <- he [2,4) 与 she [1,4)
pos=4 字符=r 状态 5 -> 8 失败边=[2] 输出=[]      <- 失败转移不消耗 r
pos=5 字符=s 状态 8 -> 9 失败边=[]  输出=[3]     <- hers [2,6)
```

把文本切成 `u` / `sh` / `ers` 三块逐块追加，命中完全相同。

## CLI

```
node dist/src/cli.js serve [--port N]      启动 API（默认端口 0 = 自动选择空闲端口）
node dist/src/cli.js add-set <名称> <模式...>
node dist/src/cli.js new-version <setId> <模式...>
node dist/src/cli.js compile <versionId>
node dist/src/cli.js graph <versionId>     转移图文本表示
node dist/src/cli.js scan <versionId>
node dist/src/cli.js append <scanId> <seq> <文本>
node dist/src/cli.js finish <scanId>
node dist/src/cli.js hits|stats <scanId>
node dist/src/cli.js explain <scanId> [from] [to]
node dist/src/cli.js export <scanId>       导出完整报告 JSON
node dist/src/cli.js demo
```

## HTTP API

所有错误返回 `{"error": {"code": "...", "message": "..."}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/pattern-sets` | `{name, patterns:[...]}` 新建模式集（版本 1） |
| POST | `/api/pattern-sets/:id/versions` | `{patterns:[...]}` 创建新版本 |
| POST | `/api/versions/:id/compile` | 编译版本（构建自动机） |
| GET  | `/api/versions/:id` | 版本详情（含模式与总长度） |
| GET  | `/api/versions/:id/graph` | 转移图文本表示 |
| POST | `/api/scans` | `{versionId}` 创建扫描（版本须已编译） |
| POST | `/api/scans/:id/append` | `{seq, text}` 追加块（原子提交、去重/冲突） |
| POST | `/api/scans/:id/finish` | 结束扫描 |
| GET  | `/api/scans/:id/hits` | 全部命中（按终点、模式编号排序） |
| GET  | `/api/scans/:id/stats` | 完整统计（不受解释截断影响） |
| GET  | `/api/scans/:id/explain?from=&to=&limit=` | 转移解释记录 |
| GET  | `/api/scans/:id/export` | 导出完整报告（版本+模式+命中+统计+转移图） |

错误码：`VALIDATION`、`EMPTY_PATTERN`、`DUPLICATE_PATTERN`、`LONE_SURROGATE`、`NOT_FOUND`、
`NOT_COMPILED`、`SEQ_CONFLICT`(409)、`SEQ_OUT_OF_ORDER`、`SCAN_FINISHED`(409)、`SCAN_NOT_FINISHED`。

## 公开限制

- 模式总长度：版本详情中的 `totalPatternLen`（码点数）；自动机节点数见 `nodeCount`。
- 输入规模：单块大小与总输入无硬编码上限，受 SQLite 与内存限制；命中与解释逐行落库。
- 解释上限：`AC_EXPLAIN_MAX`（默认 1000 条/扫描），超出后 `explainTruncated=true`，匹配继续。
- 端口：`AC_PORT` 或 `--port`，默认 0（操作系统分配空闲端口）。
- 数据目录：`AC_DATA_DIR`，默认 `./data`。

## 测试

`npm test` 覆盖：ushers 基准（整块与 u/sh/ers 分块）、前后缀继承、重复字符重叠命中、
多次失败退回、无匹配、空块、结束后拒绝追加、重复序号去重与冲突、重启后续扫一致性、
模式校验（空/重复/孤立代理项）、中文与表情符号码点下标、版本隔离、解释截断与统计分离，
以及 50 组随机小规模输入对照独立逐位置直接比较基准（核对全部命中而非仅总数）。

## 已知限制

- 单进程服务；自动机常驻内存（按版本缓存），SQLite 持久化模式/扫描状态/命中/解释，重启后
  自动机从模式确定性重建，行为一致。
- 块边界不能在代理对中间（每块必须是完整 Unicode 字符串），不处理流式 UTF-8 字节解码。
