# Aho–Corasick 多模式流匹配与失败转移解释后端

纯后端（API + CLI），TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无外部服务）。
从零实现 Aho–Corasick Trie、失败指针与输出继承，用同一个自动机在连续到来的文本块上持续扫描，
支持跨块命中、重叠命中、后缀继承命中，并提供逐位置的失败转移解释。

## 运行环境

- Windows 本地，Node.js ≥ 22.5（开发使用 Node 25 验证）；不需要 Docker / WSL / 网络服务。
- 数据保存在项目内 `data/ac.db`（可用环境变量 `AC_DB` 覆盖）。

## 常用命令

```bat
npm install        :: 安装开发依赖（typescript）
npm run build      :: 编译到 dist/
npm test           :: 构建并运行全部测试
npm start          :: 启动 HTTP API（默认端口 0 = 自动选择空闲端口）
npm run demo       :: 运行完整演示（ushers / 分块 / 中文与表情）
```

CLI 直接操作本地数据库（不经过 HTTP）：

```bat
node dist/cli.js serve --port 8080
node dist/cli.js compile en he she his hers
node dist/cli.js versions
node dist/cli.js graph 1
node dist/cli.js scan 1 1000
node dist/cli.js append 1 0 ushers
node dist/cli.js hits 1
node dist/cli.js explain 1
node dist/cli.js end 1
node dist/cli.js report 1
```

## 核心语义

- **码点下标**：文本与模式按 Unicode 码点处理，命中区间为从零开始、右端不含的码点下标。
  `🌍` 是 1 个码点但占 2 个 JavaScript 字符串下标（UTF-16 代理对），两者不要混用。
- **区分大小写**，不做分词、纠错、正则或相关性排序；不使用任何现成多模式匹配器。
- **流式扫描**：自动机状态与全局位置跨块累计；块边界可位于任意两个码点之间；
  空块不改变状态；结束扫描不人为增加字符，结束后追加返回 `SCAN_ENDED`。
- **失败转移**：失败边不消耗当前字符，逐级退回直到找到可走边或回到根；失败指针深度严格递减，不会成环。
- **输出继承**：命中某模式时，其后缀模式（如 `she` 中的 `he`）一并输出；
  相同终点的多个命中按模式编号升序稳定排序，不只输出最长模式。
- **模式集**：不可为空、不可含空串、不可重复（`EMPTY_PATTERN` / `DUPLICATE_PATTERN`）；
  模式编号 = 插入顺序，稳定不变；每次 `compile` 生成新版本，旧版本与进行中的扫描不受影响。
- **块序号去重**：相同序号且内容相同 → 幂等去重（`deduplicated: true`）；
  相同序号内容不同 → `SEQ_CONFLICT`；其他乱序 → `SEQ_OUT_OF_ORDER`。
- **原子性**：单块追加（块、命中、解释、扫描状态）在一个 SQLite 事务内提交；重启后继续追加与一次扫描完整文本结果一致。
- **解释与统计分离**：统计（位置数、失败边次数、命中数）始终完整；解释记录超过 `explainLimit`（默认 1000）后截断，
  截断不影响匹配继续（`stats.explainTruncated = true`）。

## 转移图（he / she / his / hers）

`node dist/cli.js graph <versionId>` 或 `GET /pattern-sets/:id/graph` 输出：

```
状态数: 10, 模式数: 4
模式 #0: "he"   模式 #1: "she"   模式 #2: "his"   模式 #3: "hers"
goto 0 --"h"--> 1     goto 0 --"s"--> 3
goto 1 --"e"--> 2     goto 1 --"i"--> 6
goto 2 --"r"--> 8     goto 3 --"h"--> 4
goto 4 --"e"--> 5     goto 6 --"s"--> 7
goto 8 --"s"--> 9
fail 4 -> 1   fail 5 -> 2   fail 7 -> 3   fail 9 -> 3   (其余 -> 0)
out 2 -> [0]  out 5 -> [0, 1]  out 7 -> [2]  out 9 -> [3]
```

扫描 `ushers` 的逐位置解释（`GET /scans/:id/explain`）：

```
pos=0 char=u fail=[]     state=0 out=[]
pos=1 char=s fail=[]     state=3 out=[]
pos=2 char=h fail=[]     state=4 out=[]
pos=3 char=e fail=[]     state=5 out=[0,1]   → he [2,4), she [1,4)
pos=4 char=r fail=[5->2] state=8 out=[]
pos=5 char=s fail=[]     state=9 out=[3]     → hers [2,6)
```

切成 `u` / `sh` / `ers` 三块结果完全相同。中文示例：`你好🌍，世界！` 分两块
`你好🌍，世` + `界！`，模式 `世界/🌍/好🌍` 命中 `🌍 [2,3)`、`好🌍 [1,3)`、`世界 [4,6)`（码点下标；
该文本码点长度 7，JS `length` 为 8）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/pattern-sets` | `{name, patterns[]}` 保存模式集并编译新版本 |
| GET | `/pattern-sets` | 列出全部版本（含模式数、模式总长度） |
| GET | `/pattern-sets/:id/graph` | 转移图文本表示 |
| POST | `/scans` | `{versionId}` 或 `{name, version?, explainLimit?}` 创建扫描 |
| POST | `/scans/:id/append` | `{seq, text}` 追加块（原子、去重、冲突检测） |
| POST | `/scans/:id/end` | 结束扫描 |
| GET | `/scans/:id` | 状态与完整统计 |
| GET | `/scans/:id/hits` | 全部命中（按终点、模式编号排序） |
| GET | `/scans/:id/explain?from&to` | 转移解释（码点区间可选） |
| GET | `/scans/:id/report` | 导出完整报告（配置+统计+命中+解释） |

## 错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | 参数缺失或类型错误 |
| `EMPTY_PATTERN` / `DUPLICATE_PATTERN` | 400 | 空模式 / 重复模式 |
| `INVALID_UNICODE` | 400 | 含孤立代理项 |
| `NOT_FOUND` | 404 | 版本 / 扫描 / 路由不存在 |
| `SEQ_CONFLICT` | 409 | 相同序号、内容不同 |
| `SEQ_OUT_OF_ORDER` | 400 | 序号既不是 next_seq 也不是已有序号 |
| `SCAN_ENDED` | 409 | 扫描已结束仍追加 |

## 公开上限与配置

- `explainLimit`：每个扫描的解释记录上限，默认 **1000**，创建扫描时可配（0 = 不记录解释）。
- 端口：`--port` 或 API 内 `startServer(store, port)`，默认 **0（自动选空闲端口）**。
- 模式总长度、输入规模无硬编码上限，受内存与 SQLite 限制；版本列表与扫描状态接口返回
  `patternCount`、`totalPatternLen`、`positions` 等实际规模指标。

## 测试

`npm test` 覆盖：经典 ushers 用例与分块一致性、前后缀继承、重复字符重叠命中、多次退回、
无匹配、空块、解释截断、孤立代理项 / 空模式 / 重复模式校验、重启续扫、重复序号去重与冲突、
结束后拒绝追加、版本隔离，以及 200 组随机小规模输入与独立逐位置直接比较基准的**全量命中**对照。

## 已知限制

- 不处理被拆开的 UTF-8 字节流或跨块代理对：每块必须是完整有效的 Unicode 字符串。
- `node:sqlite` 在 Node 25 仍为实验特性（启动时有 ExperimentalWarning），接口未来可能微调。
- 命中与解释记录全量落盘，超长扫描的报告导出会相应变大；解释记录可用 `explainLimit` 控制。
