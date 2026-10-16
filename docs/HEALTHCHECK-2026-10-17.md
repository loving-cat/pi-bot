# pi-bot 系统体检 · 初版（2026-10-17）

范围：`server/src`（6257 行）、`server/tests`（10 个脚本）、`app/`（Flutter 客户端接线）、`server/data` 现状。
方法：只读代码 + 实跑测试 + 读磁盘现场。测试用独立 `PI_BOT_HOME`/端口，线上 `server/data` 未改动。
参与：平台开发工程师、Agent 工程师、扩展开发工程师、质量工程师、优化工程师、算法工程师、系统架构师。

---

## 一、系统结构速览

| 层 | 模块 → 干什么 | 路径 |
|---|---|---|
| 启动 | reap 遗留 streaming → 建 Runner/Pairing → HTTP+WS → 终端二维码 → 信号收工落盘 | `src/index.js` (87) |
| 配置 | 全部配置来源（env+默认），import 时即 mkdir 数据目录 | `src/config.js` (137) |
| 纯函数 | id/时间、原子写（writeFileSync+rename）、配对码、timingSafeEqual、可单测策略函数 | `src/util.js` (162) |
| 状态与落盘 | bots/rooms/devices/sessions、消息数组、脏房间增量写、游标、500 条裁剪、统计 | `src/store.js` (717) |
| 事件总线 | 进程内 EventEmitter，store/runner 发、ws 订阅广播 | `src/bus.js` (8) |
| REST | 鉴权、房间/消息/bot/模型组/附件、网页配对页 | `src/http.js` (484) |
| WS | hello 快照、send/abort/reset/ping、bus→广播、30s ping | `src/ws.js` (125) |
| 配对 | 6 位码 10 分钟轮换、二维码、局域网地址排序（避 VPN） | `src/pairing.js` (112) |
| 编排 | 轮次引擎 runRound、@ 调度、并发派活、三层空回复兜底、提示词拼装 | `src/pi-runner.js` (1882) |
| 工具 | 内置工具定义与实现、模型检查、部门/招人 | `src/tools.js` (894) |
| 模型接入 | provider 注册 / 模型组 / 探活矩阵 / 菜单解析 | `src/providers.js` `model-groups.js` `model-health.js` `model-menu.js` |
| 附件 | 正文提取（pdf/xlsx/docx/html/csv/json，12 万字上限）、存取与喂图 | `src/extract.js` `src/attachments.js` |
| 自检 | 真起会话验证模型组可用 | `tools/check-model-runtime.mjs` |

链路：`请求 → authenticate(回环直通/token) → handler → store(内存 + 300ms 定时落盘) → bus.emit → ws 广播`。agent 轮次不在请求链上（fire-and-forget）。
群编排：`send → 房间锁 → runRound → openingSpeakers → 并发跑一波 → 解析 @ 入队 → 下一波`；预算 lead 4 次 / 成员 2 次 / 全局 10 次。

**当前基线（可复现）**：`unit.mjs` 104/104 通过；`room-lock.mjs` 9/9 通过；`smoke.mjs` 端到端通（status=done，3.6s，单条极简消息 input 7446 tokens）；`bench.mjs` 0.64s。一万条消息下 `roomSummary` 0.009ms、`appendMessage` 5.69ms/1000、`saveNow()`（1 脏房间）7.91ms。磁盘：`data/rooms` 49 文件 / `data/sessions` 39 文件 / 302MB。

---

## 二、最值得改的 5 个问题（按 收益÷成本 排序）

### 1. 鉴权裸奔：同网段两条无凭证请求即可拿到长期 token（已实测复现）★最高
- 证据：`http.js:139-150`（`/api/devices` 的 GET/DELETE）挂在 `http.js:153` 的 `authenticate()` **之前**；`http.js:135-137` `/api/pairing` 公开返回活码；`http.js:104-111` 配对成功后没有 `pairing.rotate()`（`pairing.js:190-197` 只在 10 分钟定时器换码）。
- 实测：`GET /api/pairing` → 200 拿到 6 位码（同机 `GET /api/state` → 401）→ `POST /api/pair` 换到长期 token → 用该 token 访问 `/api/state` 200 → 无 token `DELETE /api/devices/<token>` → 200 `{"revoked":true}`；同一码 10 分钟内可反复换 token。
- 影响：任何共享 Wi-Fi 下，另一台机器可长期操控整套 bot（读写文件、跑 bash）。
- 改法：devices 路由挪到 `authenticate` 之后；`/api/pair` 成功即 `rotate()`；`/api/pairing` 的 `code` 只对回环返回。

### 2. 探活结果 24h 过期后没有刷新机制 → 服务连续跑过一天就"全员不可用"
- 证据：`model-health.js:17` TTL=24h，`get()`（`:62`）一过期返回 null；`model-menu.js:56-62` 把「新鲜结果数>0」当 `alive`，一个都没有即 ✗；`tools.js:87-88` `checkModel` 据此拒人。重探只在启动跑一次（`pi-runner.js:497`），此后仅主控手动 `check_models` 才再来（`tools.js:673`）——全仓 `setInterval` 无一是探活。
- 现象：跑满一天后菜单全 ✗、招人/建部门被全部拒掉，主控回「模型『X』当前的线路实测不可用」→ 用户以为模型坏了去改配置，实际是缓存过期。
- 改法：`get()` 过期即触发后台重探（或挂 1h 定时器调 `runAll()`）；无任何新鲜结果时 `resolveMenu` 回退 `alive: true`。

### 3. 游标失效两处：bot 拿不到派活 / 重复倒旧账
- **3a 预算掐断时被丢下的人，游标却被推到最新**（`pi-runner.js:1219-1228`）：一条消息触发 ≥10 次派活或 `@all` 一个大部门时，被 @ 到但没轮上的成员走 `if (!used.has(m.id)) setCursor(lastId)`，游标越过老大的派活消息 → 下次被叫时 `#transcriptFor`（`:857`）拿不到任务正文，只剩"X 叫了你" → [PASS] 或反问"要做什么"。改法：排进过 `queue` 的成员不推游标，留到下一轮补派。
- **3b 回复 [PASS] 时删掉的消息正是游标指的那条**（`pi-runner.js:1167` + `:1174`；`store.js:692-703` `deleteMessage` 不清游标）：`#transcriptFor` 的 `findIndex` 返回 -1 时 `start` 保持 0（`:856-870`）。实测复现：游标失效后它把 **39 条旧消息**当新任务重读。改法：`deleteMessage` 里同步把指向该 id 的游标重设为其前一条。

### 4. 落盘链路三连坑：同步全量写阻塞流式 / 文件永不回收 / 无异常兜底
- 证据：`store.js:207-215` `saveNow()` 逐个写**所有脏房间**，底层 `util.js:8-13` 是同步 `writeFileSync`+`renameSync`；触发点 `scheduleSave`（300ms，`store.js:199-205`），而 `pushSteps`/`updateMessage` 每次工具调用都标脏（`pi-runner.js:1392`）。
- 实测：20 部门 × 500 条（单房间 372KB）→ `saveNow()` **31.1ms 同步阻塞**（其中 `JSON.stringify` 仅 0.82ms）；`touchDevice`（`store.js:251-257`，每个带 token 请求都走）也会触发重写（0.86ms/次）。删除侧 `store.js:525-540` / `355-376` / `553-556` **只删内存与 state 条目、从不 unlink** → 现场 `rooms/*.json` 49 个文件 vs state 里 10 个房间 = **39 个孤儿**（280KB，31 个是 2 字节 `[]`），`data/sessions` 39 个 jsonl / 8.3MB 含已删会话完整对话。保存路径无 try/catch，`index.js:80-81` 只挂 SIGINT/SIGTERM。
- 现象：流式输出期间每 300ms 一次 1~30ms 同步落盘夹在 `msg.delta` 中间 → 手机端流式一顿一顿；Windows 上 rename 撞杀软/备份抛 EPERM → 整个进程退出。
- 改法：房间文件改 `fs.promises` + 单房间串行队列；删除路径补 `unlink`；`saveNow` 包 try/catch，`index.js` 加 `uncaughtException` 记录不退出。

### 5. 上下文浪费：每轮重发固定抬头 + 附件正文按人头整份复制
- 证据：`#composeGroupPrompt`（`pi-runner.js:905`）。实测（只读统计 `data/sessions`）：39 个会话里 64 条群提示词共 0.22MB，其中【部门】【部门老大】【同事】+ 6 条规则这类**逐字不变**的抬头占 0.07MB，平均 1158 字符/条 —— 每条约 1/3 是常量，且是 user 消息，永久留在会话历史，一轮 10 次派活累积几十遍。
- 更重的一处：`#buildInput`（`:755`）把整份文档正文（上限 12 万字符）拼进 promptText，而 `:1157` 给这一轮**每个发言者都整份复制** → 一份大文档 × 6 个成员 = 六倍正文进上下文。基线佐证：一条极简消息固定开销 7446 input tokens。
- 改法：花名册/规则挪进 `buildAppendSystemPrompt`（每会话只拼一次）；附件正文只给第一个接单的人，其余人只给 `_inbox/` 路径 + 提示用 `extract_file` 按需读。

---

## 三、低成本快修清单（一次提交可带走）

| # | 问题 | 证据 | 改法 |
|---|---|---|---|
| 6 | 空回复兜底第 2 层是残的：链里硬编码了本机私有 provider slug | `pi-runner.js:1598-1603`，`resolveModel`（`:508-519`）换机器解析为 null 被 `filter(Boolean)` 删光 → 只剩刚吐空的那个模型 | 改成从 `health.ranked()` 取前 3 个已知存活 slug |
| 7 | 附件静默丢：模型看不到图却照常作答 | `#buildInput` `:761`/`:767` `continue`，`run()` `:1529` 跳过，而 `:774` 仍写「用户发了 N 张图」 | 被丢弃时补一句「该模型不支持图片，请用文字描述」 |
| 8 | 群里 `message_bot` 仍可见 → 模型无视"必须 @"的规则走私信 | 提示词规则 2 vs 工具注册 | `room.kind==='group'` 时不注册该工具 |
| 9 | 用户按终止时"正在建会话"的那轮留下永久转圈空白消息 | `pi-runner.js:1368`+`1373`+`1520-1523`：`aborting` 判断在 appendMessage/typing 之后直接 return，`entry.busy` 从未置 true，看门狗与后续 abort 都够不着 | `aborting` 判断提前，或 return 前补 `updateMessage(error)` + `typing:false` |
| 10 | 版本号三处硬编码 `0.2.0`，`package.json` 是 `0.1.0` | `http.js:97`、`http.js:389`、`ws.js:50` | 从 package.json 读一处导出 |
| 11 | 文档漂移：README 写「unit.mjs 33 项」，实际 104/104 | `README.md` | 改 README 或去掉数字 |
| 12 | HTTP 错误码判定反了：`code ? 400 : 500` | `http.js:26-40` 抛的 `body too large`/`invalid json` 无 `code` → 判 500；带 `code` 的内部错（如 EACCES）→ 判 400 | 按错误类型映射 413/400/500 |
| 13 | `room-lock` 输出混入报错 `Cannot read properties of undefined (reading 'safeLevel')` | `pi-runner.js:668` 用 `this.health.safeLevel`，而 `this.health` 只在 `init()`（`:476`）赋值 | 改 `this.health?.safeLevel(...)` |

---

## 四、待补（本版未完成）

- **优化工程师**：性能/稳定性取证跑到 600s 上限被中断（已采集 ws 观测、落盘耗时、循环延迟等原始数据，未成稿）——需在限时内重出结论。
- **算法工程师**：上下文压缩/记忆检索排序/游标机制的策略评估 + 指标建议，本轮步数到上限未交。
- **质量工程师**：已跑通基线，待对本版各条 `文件:行` 逐条复跑，出「通过/不通过」报告。
