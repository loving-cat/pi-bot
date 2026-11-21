# Orbis 2.0 路线图（三线并轨）

> **状态**：草案 **v2** · D1–D5 已拍板（见 §7）；v2 按 review 修正 4 处：SIM-Lite 改为 **lessons v2 演进**、恢复 `candidate → active` 人工门禁、解开 C3 与 C6 的逻辑矛盾、对齐 D3 与里程碑文案
> **日期**：2026-11-20
> **对应主干**：`main` @ `f6273bb`（tag `v1.7.0` 之后 6 个提交，CI 7 job 全绿）
> **一句话**：2.0 = 一次**破坏性收尾**（清债）+ 一次**契约冻结**（基座化）+ 一个**核心新特性**（SIM-Lite，**建在已有 lessons 体系上的 v2**）。
> **关联**：`docs/RELEASE.md`（版本线）、`docs/spec-convergence-v1.md`（1.x 收束账本）、`docs/SPEC-FULL-DUPLEX-V1.md`（已落地的双轨架构）、`docs/SDK.md`（当前 SDK 说明）
> **维护规则**：本文已列入 `scripts/check-spec-progress.mjs` 的 `LEDGER_FILES` —— 行内反引号里的 commit SHA 与文件路径必须真实存在，**且必须是 git 已跟踪的文件**（本地构建产物不算；2026-11-20 踩过：`server/resources` 下的 exe 本机有、CI 没有）；尚未落地的路径必须在同一行标 `（待新增）` / `（新）` / `❌` / `未开始`。

---

## 0. 为什么三条线要并进同一张表

分开排会出现三种必然事故：

| 事故 | 机制 |
|---|---|
| **新特性建在旧债上** | 若先做 SIM-Lite，再在 2.0 删 `PI_BOT_*` / 旧目录回退，则经验的持久化位置、SDK 字段、事件名全部要跟着改两遍 |
| **契约冻结被新特性拖后** | 若先冻结 SDK 再做 SIM-Lite，则 `runtime.lessons` 无处安放，冻结当晚就要破一次 |
| **清债无声断代** | 目录回退一删，老用户聊天记录“文件还在但程序不看”，没有前置告警就是数据事故 |

所以三线的**顺序不是并列**，而是：**先定契约形状 → 用新特性验证契约 → 最后一次性关掉旧门**。

---

## 1. 事实盘点（不是估计）

### 1.1 清债：`@remove-2.0` 显式标记只有 6 处，但真实债务是 **8 类**

`grep -rn "@remove-2.0" server/src app/lib` → **6 处**（`server/src/http.js` ×3、`server/src/config.js`、`server/src/brand.js`、`app/lib/app_state.dart`）。
但按旧品牌串实际统计：**`server/src` 38 个文件、`app/lib` 27 个文件**仍含 `pi-bot` / `PI_BOT_` / `pibot`。
全量扫描（含测试与打包脚本，已排除构建产物）：**待清债 223 个文件 / 1141 处**，其中绝大部分在测试里（那些是兼容性回归用例，Phase 3 跟代码一起删）；另有 **386 处是永久保留的身份常量**（mDNS / TLS / 应用 ID / Dart 包名），不计入债务。
这 1141 处已经用 `scripts/check-legacy.mjs` + `scripts/legacy-allowlist.json` 钉成**只许变小**的基线，新债一产生 CI 就红。

| # | 类别 | 代码位置（现状） | 2.0 若直接删会怎样 | 处置 |
|---|---|---|---|---|
| **C1** | 环境变量双前缀 | `server/src/brand.js` `readBrandEnv` 兼容读 `PI_BOT_<SUFFIX>`；全库约 25 个 `PI_BOT_*` 名字 | 老 `PI_BOT_HOME` / `PI_BOT_PORT` / `PI_BOT_MODEL` 失效 → 服务起不来或另起数据目录 | 1.7.1 加弃用告警 → 2.0 只认 `ORBIS_*` |
| **C2** | 数据目录回退 | `server/src/config.js` `LEGACY_HOME_DIR_NAME`；`app/lib/app_state.dart` 旧 `pi-bot/data` | **老用户聊天记录“消失”**（文件在，程序不看） | 迁移命令 + 启动检测提示，**复制不删除** |
| **C3** | HTTP/中继头双读 | `server/src/http.js`（`x-pi-bot-client` **必需头**，缺了直接 403；`-nonce` / `-channel` 双读）、`server/src/relay/server.js` CORS 白名单、`app/lib/api.dart` **只发旧头**、`server/src/sdk/client.js` | 1.7 客户端连 2.0 服务端 → 第一个请求就 403 | ⚠️ **顺序敏感**：必须 **1.7.1 先让 App 发 `x-orbis-*`**（服务端已双读），2.0 才敢删旧头。见 §3 T1.3 |
| **C4** | 包与符号别名 | `server/src/sdk/index.js`（`createPiBotRuntime`）、`server/src/sdk/client.js`（`PiBotClient` / `createPiBotClient`）、`server/package.json` 的 `bin.pi-bot-server` | 嵌入了 SDK 的宿主脚本 import 报错 | 2.0 删除，CHANGELOG 给一行 sed 替换 |
| **C5** | 磁盘文件名 | `server/src/providers.js` 的 `pi-bot.config.json`、`server/src/secrets.js` 的 `PI_BOT_SECRET_KEY`、`server/src/data-migration.js` 的启动标记 | 老配置读不到 → 模型配置“全没了” | 迁移期读旧写新，2.0 后只写新 |
| **C6** | **局域网发现与 TLS 身份** | `server/src/discovery.js` mDNS 类型 `pibot.discover` / `pibot.host`；`server/src/tls.js` 自签证书 CN `pi-bot` / `pi-bot.local` | **跨版本配对立断**：1.7 App 发现不到 2.0 服务端 | ⚠️ **永久双播不删**（已拍板 D2）：同时 announce `orbis.*`，TLS 加 SAN。见 `docs/PLATFORMS.md` |
| **C7** | 原生产物名 | `native/pibot-sandbox/`（Rust 源）、`scripts/build-sandbox-win.ps1` 里的产物名、`PIBOT_SANDBOX_EXE` 环境变量 | 沙箱启动失败（Windows 上等于所有工具不能跑） | 产物改 `orbis-sandbox.exe`，env 兼容读一个周期 |
| **C8** | 文案残留 | 启动 banner、`server/src/sandbox.js` 提示、`server/src/desktop-input-mac.js` 授权引导 | 只是难看 | 随手清，无风险 |

> **和 `docs/RELEASE.md` 的关系**：那份文档已有「永远不删」表（Android `APP_ID`、macOS bundle id、Inno `AppId` GUID）。本路线图把 **C6 也加进「永久双播」**，理由同款：身份常量一改就是换新应用。

### 1.2 基座化：SDK 现在**能嵌**，但还不能叫「基座」

对照 `@earendil-works/pi-coding-agent` 的公开契约（它自己的 docs/sdk.md 147 行 + 14 个 examples/sdk 例子），逐面核对：

| 契约面 | pi-coding-agent | Orbis 现状 | 判定 |
|---|---|---|---|
| 可安装性 | npm 公开包，`exports` + `types` | `server/package.json` 是 **`private: true`** —— 名义上的基座，实际装不进去 | ❌ 硬缺口 |
| 类型 | 完整 `.d.ts` + 例子被 typecheck | **0 个 `.d.ts`**，宿主只能读文档猜字段 | ❌ 硬缺口 |
| 导出面 | 一组稳定的具名导出 | 5 个 `exports`（`.` / `./sdk` / `./client` / `./capabilities` / `./server`），`./package.json` 不可达，正式名与 `PiBot*` 别名混在同一入口 | 🟡 待收口 |
| 可注入边界 | 6 类：`modelRuntime` / `sessionManager` / `settingsManager` / `resourceLoader` / `tools` / `customTools` | 只有 `createOrbisRuntime(options)` 的「给个目录 + 模型组 + 策略」 | ❌ 硬缺口 |
| 生命周期 | `dispose()` 幂等、`agent_settled`（“不会再自动继续”） | 有 `dispose()`；无 settled 类终态事件（双轨下更需要） | 🟡 待补 |
| 错误 | 类型化错误；忙时 `prompt` 不给分流意图就拒绝（不猜） | 抛字符串；忙时语义靠 `duplex-router` 内部约定 | 🟡 待补 |
| 会话可移植 | `session-format.md` 定义 JSONL 契约 | `store.sessionFileFor` 有 JSONL 事实，但没有对外格式文档 | 🟡 待补 |
| 示例 | 14 个 `examples/sdk/*.ts`，CI 跑类型检查 | 无 `examples/`；`server/tests/sdk-runtime.mjs`（495 行 / 5 个用例）是对内测试，不是对外示例 | ❌ 硬缺口 |

**结论**：基座化不是“再写点文档”，是 **4 个硬缺口（可安装 / 类型 / 注入 / 示例）+ 4 个收口项**。

### 1.3 自进化：**仓库里已经有一整套经验系统（19 个文件），SIM-Lite 是它的 v2**

> ⚠️ v1 草案在这里犯了错：把 `lessons` 当成不存在的资产，另起了一套 `experience/` 存储 + 注入 + 设置页。
> 那会同时存在两套经验库、两套注入、两个设置页 —— 直接违背「一个事实只存一份」。v2 全部改为**在既有 lessons 上升级**。

**已经落地的（可直接复用的能力，不是待建项）**

| 现成资产 | 现在已经在做什么 | SIM-Lite 怎么接 |
|---|---|---|
| `server/src/lessons.js`（纯模块，已在 `PURE_MODULES` 名单） | 数据结构 + 校验 + 打分 + 渲染：`LESSON_LIMITS`（库上限 200 / 一次 **3 条** / 总共 **600 字**）、`LESSON_STATUSES`（`candidate / active / archived`）、`LESSON_VERDICTS`（`helped / hurt / no_effect / confounded`）、`selectLessonsFor`（cue 命中 +3 / lesson +1 / 同房间 +1，门槛 3）、`lessonsPromptLines` | **加维度，不换实现**：新增 `modelFamily` / `byFamily` 统计 / 关系边加权；预算沿用 600 字，不发明第二套 |
| `server/src/lesson-reflect.js` + `server/src/lesson-reflect-prompt.js` | 一轮群聊结束后的**独立复盘会话**（无工具、无技能），只产出 0~2 条 **candidate**；evidence 必须指到真实 `msgId` 且 quote 能在原消息里找到，对不上整条丢弃 | 变成 SIM-Lite 的**蒸馏器**：多输出 `modelFamily` 与关系边候选 |
| `server/src/runner/turn-executor.js`（`withLessons`，约 564 行） | 每轮真正开始时按任务挑经验，只注入 `active`，只给**主控**，成员层不注入 | 注入点唯一，**签名不变**，只多传一个 `modelFamily` |
| `server/src/store.js` | `state.lessons` 持久化；`/api/lessons` 增删改；`lessons.updated` 事件；`/api/lessons/preview` 预演注入 | 边存在同一份 state（`state.lessonEdges`），**不新建文件/目录** |
| `app/lib/widgets/lessons_section.dart` + `app/test/lessons_section_test.dart` | 设置页经验面板：**启用 / 归档 / 删除**（`setLessonStatus`）、空态、预览 | 保留三档操作，加「族标记 / 未验证提示 / 推荐启用」 |
| `server/src/jarvis-tools.js` + `server/src/capabilities.js` | Jarvis `manage_knowledge`：列表/加经验不需要强确认，**删技能/删经验要二次确认** | 关系边操作走同一门（删边也算删数据） |
| `server/tests/lessons.mjs`、`server/tests/lesson-reflect.mjs`、`server/tests/preferences.mjs` | 已有单测覆盖校验/打分/渲染/复盘 | **扩现有文件**，不新建平行测试 |
| `server/src/memory-policy.js`、`server/src/chat-redact.js` | 上下文预算口径、脱敏 | 经验文本落盘前清洗、预算口径统一 |

---

## 2. 阶段划分与顺序理由

| 阶段 | 时间盒 | 主线 | 出口条件（不满足不进入下一阶段） |
|---|---|---|---|
| ✅ **Phase 0 · 地基** | 1 周（已完成） | 三线前置（只加守卫，不加特性） | ① 契约快照测试上线 ✅ ② 弃用告警策略定稿并随 `v1.7.1` 发版 ✅ ③ 本文进 `LEDGER_FILES` 且守卫全绿 ✅ ④ SIM-Lite 字段增量与边格式定稿 ✅（`LESSON_SCORING` / `MODEL_FAMILIES` / `LESSON_EDGE_TYPES` + 24 条契约测试） |
| **Phase 1 · SIM-Lite（lessons v2）** | 3–4 周 | **T3 自进化（核心增量）** | 现有 lessons 测试全绿的前提下新增：跨族归因、关系边、推荐启用；**人工审批门禁不回退**；`lessonReflect=false` 全链路 no-op |
| **Phase 2 · 基座化** | 2–3 周（与 Phase 1 后半并行） | **T2 契约冻结** | `npm pack` 可安装且能 import 跑通 examples；`.d.ts` 覆盖 Phase 1 全部公开面；稳定性三档文档落地 |
| **Phase 3 · 清债关门** | 1–2 周 | **T1 破坏性收尾** | C1–C5、C7、C8 全删且 `check-legacy` 白名单清零；C6 双播有测试；迁移命令跑通；release notes 含配对问答表 |

**依赖关系（硬边）**

```
Phase 0 ──► T2.1 契约快照 ──► T3.7 SDK 门面（形状先定，实现后补）
                          └──► T2.2 types（Phase 2 补齐）
Phase 1 ──► T3.1 lessons.js 加维度 ──► T3.2 关系边 ──► T3.3 蒸馏器 ──► T3.4 注入 ──► T3.6 验收
Phase 2 ──► T2.3 注入点 ──► T2.6 发布 ──► T2.8 examples
Phase 3 ──► 依赖 Phase 1/2 全部合并（否则删完兼容层还要再改新代码）
```

**为什么不把清债放最前**：C1–C5 删起来是机械活，但**每删一项，1.x 用户就断一次**。在没有迁移命令和告警铺垫前删，等于拿用户数据做实验。放最后 + 前置告警，是把「破坏性」压缩到一个 release 里的一次性代价。

---

## 3. T1 · 清理债（Phase 3 主体 / Phase 0 预埋）

> 优先级：**T1.0 = P0（Phase 0 做）**，C6 = P0 但**不是删除**，其余 P1。

| 项 | 内容 | 验收（可测得红） |
|---|---|---|
| **T1.0** | ✅ **已落地**：`scripts/check-legacy.mjs` + 基线 `scripts/legacy-allowlist.json`——分两区：`permanent`（**永久保留**：mDNS `pibot.discover`/`pibot.host`、TLS `pi-bot.local`、Android `com.pibot.pi_bot`、macOS `io.pibot.piBot`、Dart `package:pi_bot/`）与 `entries`（**待清债**，只许变小）。当前：待清债 223 文件 / 1141 处，永久保留 7 个模式 / 386 处不计入。自测 `scripts/tests/check-legacy-test.mjs`（11/11）；已接入 CI | 故意加一行 `PI_BOT_FOO` 读取 → 必红；`--strict` 只要求 `entries` 清零（permanent 不卡收门） |
| **T1.1** | ✅ **已发版**（`v1.7.1` 2026-11-20）：`server/src/brand.js` 新增弃用通道——进程内按 `kind:from` **去重**（热路径不刷屏）、`onBrandDeprecation` 可订阅、`resetBrandDeprecations` 可清零 | `server/tests/brand-deprecation.mjs` 10/10：50 次热路径调用只记 1 条；新名优先不记；不同 suffix 各一条 |
| **T1.2** | 🟡 C2 告警已落地（`resolveHomeDir` 命中旧目录时提醒一次，含“跑 orbis migrate”指引）；2.0 删回退 + `orbis migrate` 命令待 Phase 3（`migration-report.json` 待新增） | `brand-deprecation.mjs` BD-8/BD-9/BD-10：旧目录沿用且提醒一次；新旧都在时用新目录不提醒；迁移后旧目录仍在 |
| **T1.3a** | ✅ **已发版**（`v1.7.1` 2026-11-20）：`app/lib/api.dart` 全切 `x-orbis-client` / `-nonce` / `-channel`（常量收口 `Api.nonceHeader` / `Api.channelHeader`）；1.7.0 服务端本就双读 | `app/test/api_client_header_test.dart` 锁死新头名与全部写路径；`local_nonce_test.dart` 改看新头 |
| **T1.3b** | 🟡 **告警已落地**：`server/src/http.js` 新增 `DEPRECATED_HEADER` —— 只用旧头时回 `x-orbis-deprecated: <旧头名>`（两个都带则不打标）；2.0 删旧头待 Phase 3 | `local-csrf.mjs` 21/21：新头直用、旧头可用但贴弃用头、两个都带不打标；缺头 403 报错指向正式名 |
| **T1.4** | C4：删 `createPiBotRuntime` / `PiBotClient` / `createPiBotClient` / `bin.pi-bot-server` | 契约快照测试必须显式删这几行才变绿；`npm exec orbis-server` 仍可用 |
| **T1.5** | C5：`pi-bot.config.json` 读旧写新；`PI_BOT_SECRET_KEY` 改 `ORBIS_SECRET_KEY`（同值迁移） | 老配置文件存在时能读出同一份模型配置；新写入只产生新名 |
| **T1.6** | C6：**永久双播**。mDNS 同时 announce `orbis.host` 与 `pibot.host`，probe 两个类型都听；TLS 证书加 `orbis.local` SAN，旧 CN 保留 | 1.7.1 App 能发现并连上 2.0 服务端（真机，挂 #31/#32 一起验） |
| **T1.7** | C7：`pibot-sandbox.exe` → `orbis-sandbox.exe`；`PIBOT_SANDBOX_EXE` 兼容读一个周期 | 打包脚本单测跟改；`check-launcher-version` 仍绿 |
| **T1.8** | C8：文案统一（banner / sandbox 提示 / macOS 授权引导） | `check-legacy` 白名单不含文案项 |
| **T1.9** | 破坏性变更公告：`docs/RELEASE.md` 2.0 段补「**先升 1.7.1 再升 2.0**」与配对问答表 + 回滚指引 | 发版 checklist 里加一项「公告已复核」 |

---

## 4. T2 · 基座化（Phase 2）

> 目标不是“文档更全”，而是**别人 `npm i` 之后 5 行代码能跑起来，并且升级不炸**。

| 项 | 内容 | 验收 |
|---|---|---|
| **T2.1**（Phase 0） | ✅ **已落地**：`server/tests/sdk-contract.mjs` + 快照 `server/tests/sdk-contract.snapshot.json`（包元数据 / 四个入口导出名单与类型 / 运行时字段 / 六个服务方法）；改契约必须 `UPDATE_SDK_CONTRACT=1` 显式重写快照，diff 会打印增删项；已进 `server/tests/all.mjs` | 随手加一个导出 → 必红并打印 `+ entries.xxx` |
| **T2.2** | 类型：JSDoc + `tsc --emitDeclarationOnly` 生成 `server/types/`（待新增），`exports` 每项加 `types` | `tsc --noEmit` 对 `examples/sdk/` 全绿 |
| **T2.3** | 6 类注入点对齐 pi：`config` / `store` / `bus` / `modelRuntime` / `resourceLoader` / `tools`。默认值 = 现有行为（零破坏） | 传 `store: 内存实现` 时零磁盘写入；不传时既有 157 测试全绿 |
| **T2.4** | 生命周期：`run.settled` 终态事件（对齐 `agent_settled`）、`dispose()` 幂等、初始化中途失败要回收定时器/总线 | 中途抛错的构造不残留 handles |
| **T2.5** | 错误契约：`OrbisError` + `code` 枚举（`E_GRANT_DENIED` / `E_MODEL_UNAVAILABLE` / `E_BUSY_NEEDS_ROUTE` / `E_DISPOSED` …）；忙时 `prompt` 不给分流意图就**拒绝** | 每条 code 至少一个测试；`server/src/sdk/` 内字符串抛错 grep 归零 |
| **T2.6** | 发布：`private: false`（或私有 registry）、`files` 白名单、`npm pack` 体积上限、`./package.json` 可达、`scripts/check-licenses.mjs` 接入发布流程（收 #37 的许可证清单） | `npm pack` → 干净容器 `npm i <tgz>` → examples 01 能跑 |
| **T2.7** | 会话可移植：`docs/SDK-SESSION-FORMAT.md`（待新增）定义 JSONL 条目契约，与 `store.sessionFileFor` 事实一致 | 按文档手搓会话文件 → 能被 runtime 正确加载 |
| **T2.8** | 示例：`examples/sdk/01-minimal.mjs` …（待新增）至少 6 个：最小嵌入 / 自定义模型 / 只读工具集 / 多 Bot 部门 / 事件订阅与 settled / 经验库读写 | 每个例子进 CI 实跑 |
| **T2.9** | 稳定性：`docs/SDK-STABILITY.md`（待新增）三档（`stable` / `beta` / `internal`）+ 破坏性变更流程（一版弃用、一版删除） | 契约快照里每个导出带档位标记 |
| **T2.10** | 收 #37 剩余欠账：审计检索、公平排队、模板预览 | 各项单测 + 审计检索能按 roomId/时间窗过滤 |

---

## 5. T3 · SIM-Lite（Phase 1，2.0 的核心增量）= **lessons v2**

**SIM-Lite = Self-Improving Memory, Lite**：在**现有 lessons 体系**上加两个维度 —— **跨模型归因**与**轻量经验关系边**；不新建存储、不新建注入点、不新建面板。

```
① 沉淀 distill     一轮收口 → 独立复盘会话 → 0~2 条 candidate（+ modelFamily + 边候选）→ 人工启用才 active
② 检索 recall      新一轮开工 → 打分（含族加成 / 边加权）→ 3 条 / 600 字内注入主控
③ 验证 verify      命中后记 byFamily 成败 → 跨族达标给「推荐启用」/ 连续失败自动降权 + 写 contradicts 边
```

### 5.1 五个改造缝（改这些文件，别的地方不动）

| 缝 | 现状 | v2 增量 | 不能破坏什么 |
|---|---|---|---|
| `server/src/lessons.js` ✅ **契约已定稿** | 校验 / 打分 / 渲染（纯模块） | 字段 `modelFamily` / `byFamily` / `edges` 的**纯函数**读法；打分加族与边权重；`LESSON_LIMITS` 只调 `total`（200 → 500，仍要淘汰） | 仍是 `PURE_MODULES`；`selectLessonsFor` / `lessonsPromptLines` **签名兼容** |
| `server/src/lesson-reflect.js` ✅ **归因 + 胜率评估 + 边候选已接线** | 收尾复盘 → candidate（evidence 校验） | 输出带 `modelFamily`（实际干活的模型，不是复盘会话自己的模型）；新增 `evaluateInjected()`：对本轮注入过的经验做**独立评估**（helped/hurt/no_effect/confounded），只有 helped/hurt 记 `win`/`fail`，`confounded` 不记；**边候选**按 §5.3 的 `pendingEdges` 形状产出（目录校验） | 仍然**只产 candidate**；evidence 校验不放宽；**不拿本轮 ok/fail 记账**；边候选**不提前生效** |
| `server/src/runner/turn-executor.js` ✅ **注入 + 评估触发已接线** | `withLessons` 注入 | 传 `modelFamily` + `edges`；命中只 `touchLessons(..., {modelFamily})` 记 `hit`；`finally` 里把 `lessonsInjected` **同步摘成快照**再交给后台评估（清得快，防下一轮覆盖导致重复计分） | 注入点仍唯一；成员层仍不注入；**win/fail 不在这里产生** |
| `server/src/store.js` ✅ **边已落库** | `state.lessons` + `/api/lessons` + `lessons.updated` | `state.lessonEdges`（级联删、`lessons.updated` 同时带 `edges`、`POST /api/lessons/edges`、`POST /api/lessons/:id/reject`）；`/api/lessons/preview` 已传边 | 老库无新字段也能读（`normalizeLesson` 给默认值） |
| `app/lib/widgets/lessons_section.dart` ✅ **已接线** | 启用 / 归档 / 删除 | 族标记 + 胜负（`glm · 5W/0L`）、「推荐启用」角标与置顶排序、被否决时显示「已否决」并只给「解除否决」 | **不能退化成只读**；「记错了」= 写 user 边 + 归档；裸切 active 的假启用路径已封死 |

### 5.2 数据契约（增量字段，老库直接兼容）

现有字段一个不动（`cue` / `lesson` / `verdict` / `evidence` / `status` / `hits` / `roomId` / `dept` / 时间戳），只加：

```jsonc
{
  // …既有字段…
  "modelFamily": "deepseek",              // 沉淀时实际服务的模型族；缺省 = "unknown"
  "byFamily": {                            // 每个族的真实战果（这是"跨模型"的证据源）
    "deepseek": { "hit": 5, "win": 4, "fail": 1 },
    "glm":      { "hit": 2, "win": 1, "fail": 1 }
  },
  "confidence": 0.72,                      // 纯函数派生，可重算，不落库也可
  "contentHash": "sha256:…"                // 去重键（cue + lesson 归一化后哈希）
}
```

兼容性：`normalizeLesson` 对缺失字段给默认值 → **老 `state.lessons` 不需要迁移脚本**，读出来即 v2 形状。

✅ **Phase 0 已定稿**（`server/src/lessons.js`）：`MODEL_FAMILIES`（封闭 7 族 + `other`）、`UNKNOWN_MODEL_FAMILY`、
`resolveModelFamily()`（provider/model 名 → 族）、`normalizeFamilyStats()`（键数封顶 `LESSON_LIMITS.byFamilyKeys`）、
`lessonConfidence()`（0~0.95 纯派生）、`lessonContentHash()`（sha256 前 32 位，空白**全去**）。
`confidence` 不落库 —— 它是可重算的派生量，存了就会和数据打架。

⚠️ **置信度标尺是按晋升门槛反推的**（0.25×base + 0.45×ratio + 0.15×volume + 0.15×coverage，
`helped`/`hurt` 的 base = 0.7）：两族 3:1 = 0.813 达标、单族 3:1 = 0.737 不达标。
最初那版（base 0.5、权重 0.4/0.3/0.15/0.15）数学上界正好 0.800，只要出现过一次 fail
就再也到不了 0.80 —— 门槛永远不可达，单测里专门钉了一条防回退。

### 5.3 关系边（和 lessons 放在同一份 state，不新建文件）

`store.state.lessonEdges = [{ from, to, type, at, by }]`，只允许 4 种：

| 边 | 语义 | 检索时的作用 |
|---|---|---|
| `supersedes` | `from`=新, `to`=旧 | **入边 `to`** 不进候选（仍留在库里供审计） |
| `requires` | `from` 依赖 `to` | 渲染时作为附带一句（不影响排序） |
| `contradicts` | 冲突（含**用户否决**） | **双向排除**（写在 from 还是 to 上都拦），不是减分 |
| `generalizes` | `from`=特化, `to`=泛化 | 特化条命中任务时泛化条 **+1，单条上限 +1**（不随边数叠加） |

`from` 允许两个哨兵：`user`（用户在界面上的否决）与 `system`（系统自动降级）。
没有哨兵的话，单条「记错了」根本写不出合法边 —— 它不能自己指向自己。

- 边由两处产生：**蒸馏器**（`supersedes` / `contradicts` 候选，需人工确认）与**用户显式操作**（否决 → `contradicts`，立即生效）
- ✅ **蒸馏器边候选已按这个形状落地**（2026-11-21）：候选边**挂在经验本身上**（`lesson.pendingEdges: [{to, type}]`，最多 2 条），**不进 `state.lessonEdges`** —— 边表只有"生效的边"一种含义，打分/排除/淘汰/界面都不用加过滤，删候选也不会留孤儿边（守住 I0）。
  - 类型只允许 `supersedes` / `contradicts`；`to` 必须是复盘输入里给出的**现有 active 经验目录**（`LESSON_LIMITS.reflectCatalog = 15` 条）里的 id，编的 id / 哨兵 / 指向自己的在解析层就丢；
  - **只在人工 `activate` 这一次物化**成 `{ from, to, type, by: 'distiller' }`，目标已删 / 已不是 active / 边重复 → 静默跳过；无论成不成，建议消费完即清空；
  - 归档 / 删除**不物化**（没启用过的东西，不该动到别人的经验）；
  - 界面上候选卡直接写「启用后将取代《目标 cue》」/「启用后将标记与《目标 cue》的冲突」，目标没了就提示会被跳过。
- 只做**一阶**扩散；2 跳留到 2.1（Lite 就是 Lite）
- 删经验时级联删边；删边走 `manage_knowledge` 同一条二次确认路径

✅ **Phase 0 已定稿**（`server/src/lessons.js`）：`LESSON_EDGE_TYPES`、`lessonEdgeRejectReason()`、
`normalizeLessonEdge()` / `normalizeLessonEdgeList()`（去重 / 丢悬空 / 上限 `LESSON_LIMITS.edges`）、
`lessonEdgeIndex()`（**双向**邻接表 `{ incoming, outgoing }` —— 只建 `from → edges` 会让
`contradicts` 排除新条、放过旧条，正好反了）、`LESSON_EDGE_SENTINELS`（`user` / `system`）。

### 5.4 跨模型去偏（只影响**排序与推荐**，不绕过审批）

| 规则 | 实现（纯函数） |
|---|---|
| 同族加成 | 当前族 == `lesson.modelFamily` → **+2**（相对 cue 命中 +3 的量级，够用但不喧宾夺主） |
| 异族未验证 | 该族在 `byFamily` 里无记录 → **−1** 且界面标「未在同模型验证」 |
| 稳定经验 | **≥2 个模型族**都 `win:fail ≥ 3:1` 且 `confidence ≥ 0.8` → 「推荐启用」排在最前（标尺按这个门槛反推：两族 3:1 = **0.813** ✅ / 单族 3:1 = **0.737** ❌ / 全胜两族 = 0.925 / 上限 0.95） |
| 族内衰减 | ✅ **已落地**：同族连续 2 次 `fail` → 自动 `archived` 并写 `from: 'system'` 的 `contradicts` 边（可人工恢复）。阈值在 `LESSON_DECAY.familyFailStreak`；连败计数在 `byFamily[family].streak`（`win` 清零、`no_effect` / `confounded` 不记账也不打断），0 不落键所以老库形状不变。**状态与边只在 `store.recordLessonOutcomes` 里写**（纯模块只回答「该不该降」）；界面显示「已降级」且只给「解除降级」——裸切 `active` 会被服务端拒掉（否则就是下面的「看似启用、实际注入不进去」）；「解除降级」删 `system` 边时把连败计数一起清零 |
| 人工否决 | 一律最高优先级，不可被后续蒸馏覆盖 |

> 反面案例（这条规则必须挡住）：glm 上「先改测试再改实现」有效，deepseek 上「把测试改成永远通过」也 success —— 若不分族，第二条会污染第一条。

### 5.5 打分（在 `selectLessonsFor` 上做加法，门槛不变）

```js
// server/src/lessons.js 的 LESSON_SCORING（唯一口径，别处不许写魔法数字）
score = Σ cue 命中(+3/词) + Σ lesson 命中(+1/词) + 同房间(+1)      // 1.x 原有
      + 同族验证过(+2) − 异族未验证(−1)                            // v2 跨模型
      + generalizes 一跳(+1)                                      // v2 关系边
// contradicts 边 → lessonScore 直接返回 null（硬排除，不是减分）
// 门槛 minScore 仍为 3；预算仍为 3 条 / 600 字
```

✅ **Phase 0 已定稿**：`lessonScore()` 是唯一打分入口，`selectLessonsFor()` 改成调它；
**相关性闸门** `lessonLexicalScore()` > 0 才允许进候选（否则「同房间 +1 + 同族 +2 = 3」
会让同房间所有无关历史经验过门槛）；
**不传 `modelFamily` / `edges` 时行为与 1.x 逐字一致**（原有 17 条测试全绿即为证）。
老经验（`modelFamily: "unknown"`）不享受加成、也不背扣分 —— 否则升级当天老经验会被新规则一起埋掉。

### 5.6 审批门禁：**不回退**（这条是 v2 的关键修正）

现有底线写死在 `server/src/lesson-reflect.js` 的文件头：

> 复盘 → candidate（只进库，不进提示词）→ 用户在设置页点启用 → active

v1 草案把它改成「蒸馏即自动注入 + 事后点『记错了』」，等于把出事后的补救当成事前防线 —— 而且 `ds` 自己在 §5.4 举的反面案例（「把测试改水成永远通过」）**能通过『测试通过』这道自动门禁**。v2 明确：

| 项 | 规定 |
|---|---|
| 默认行为 | 蒸馏只产 `candidate`；**只有 `active` 进提示词**（现有代码已经是这样，v2 不动） |
| 人工操作 | 设置页三档全保留：**启用 / 归档 / 删除**；「记错了」= 删除或写 `contradicts` 边 |
| 自动晋升 | 只做成**默认关闭**的可选策略 `ORBIS_LESSON_AUTO_PROMOTE=1`，且只允许「≥2 族验证 + `confidence ≥ 0.8` + 用户曾批准过同 cue」 |
| 推荐排序 | SIM-Lite 把「值得启用」的候选排在前面（这是它的价值），**但不替人按按钮** |

✅ **已按 ① 落地（2026-11-20）**：界面上被否决的条目显示「已否决」角标，只提供「解除否决」，
不提供「启用」；`AppState.unrejectLesson()` 删的是那条 `user` 边本身。
下面这段是当时的决策记录，留作口径依据。

⚠️ **否决与恢复的语义（第三刀做界面前必须先定）**：`rejectLesson` 会写一条
`from: 'user'` 的 `contradicts` 边**并归档**该条。若用户事后只是想恢复，却直接
`updateLesson(id, { status: 'active' })`，界面会显示「已启用」，但那条 `user` 边仍会
在打分时把它双向排除 —— **看似启用，实际永远注入不进去**。
界面必须二选一：① 单独显示「已否决」并提供「解除否决（删 `user` 边）」；
② 干脆禁止裸切 `active`，只走「解除否决」这一个动作。**不能既有裸切、又保留否决边。**

### 5.7 曝光面（复用现有通道，不新增第二套）

| 端 | 形态 |
|---|---|
| HTTP | 现有 `/api/lessons`（GET/POST/PATCH/DELETE）+ `/api/lessons/preview` 增量返回 `modelFamily` / `edges` / `confidence` |
| 事件 | 沿用 `lessons.updated`；新增边变化时也在同一事件里带 `edges` |
| SDK | ✅ **已落地**：单一门面 `runtime.lessons`（`list / propose / activate / archive / remove / preview`，另加 `edges / reject / unreject / undecay / addEdge / removeEdge`）—— 全部转发给 `services.capabilities`，和 HTTP / 界面同一条路，不新建存储也不新建注入点（I0）；读返回数组，写一律 `{ ok, status?, code?, error? }`（和 `runtime.bots` 一致）。`propose` **强制** `candidate`（即使传 `status: 'active'` 也改回去），要生效只能走 `activate`（自己校验证据与否决/降级边）。`unreject` / `undecay` 是**必备的恢复闭环**：没有它们，宿主调过 `reject` 或遇到自动降级后在门面内就再也恢复不了。契约快照锁住 `runtime.lessons` 的**方法名集合**。若将来要 `experience` 这个名字，**只做别名转发**，不新增实现 |
| 能力 | 沿用 `manage_knowledge`（删经验/删边要二次确认这条不动） |
| 开关 | 沿用 `config.lessonReflect`（`lessonReflect=false` 时全链路 no-op）；自动晋升单独一个默认关闭的开关 |

### 5.8 反向不变量（防“第二套系统”复活，必须写成测试）

> ✅ **已落地**（2026-11-21）：`server/tests/lessons-invariants.mjs`（10 条，已进 `server/tests/all.mjs`）。
> 静态扫描 + 运行期断言；I0-2 的口径在此澄清一次：**注入点唯一**（`turn-executor` 的 `withLessons`），
> `Http / SDK` 的那两处只允许是 `/api/lessons/preview` 与 `runtime.lessons.preview`（只给人看，不注入），
> 多一个调用点就红。I1 同时要求 `lessons.js` / `lesson-reflect-prompt.js` **真的在 `PURE_MODULES` 名单里**
> （之前只在文档里声称，名单里没有，等于没管）。

| # | 红线 | 测试方式 |
|---|---|---|
| **I0** | **不得出现第二处经验存储 / 第二处注入点 / 第二个设置面板** | 静态扫描：全库只允许 `state.lessons` 一处持久化；`lessonsPromptLines` 只允许在 `server/src/runner/turn-executor.js` 调用；新建 `experience` 命名空间即红 |
| **I1** | 打分 / 蒸馏 / 渲染 / 淘汰四个模块零 IO（不进 `PURE_MODULES` 以外的新组） | `scripts/check-style.mjs` 现有名单继续管住 `lessons.js` |
| **I2** | 只在**一轮收口**写经验，delta 期不写 | 单测：delta 期触发蒸馏 → 0 写入 |
| **I3** | 经验是**文本参考**：注入块标题保持「是经验，不是硬规则」，块内不自动执行任何命令 | 渲染纯函数断言标题与定界符 |
| **I4** | 权限隔离：`server/src/grants.js` / `server/src/policy-hook.js` 依赖图里不得出现经验模块 | 静态 import 扫描 |
| **I5** | 可关可清：`lessonReflect=false` no-op；删除经验/边后 `preview` 立即可见变化 | e2e：关 → 不写不注入；删 → 预览为空 |

### 5.9 验收（扩现有测试文件，不新建平行文件）

| 测试文件 | 新增断言要点 |
|---|---|
| `server/tests/lessons.mjs`（**扩**） | 族加成方向（同族 +2 / 异族未验证 −1）、`contradicts` 直接排除、`generalizes` 一跳、门槛仍是 3、预算仍是 3 条 / 600 字、老库缺字段能读、**族内衰减**（连败 2 次归档 + `system` 边、中间赢一次重新计数、边幂等、裸切 `active` 被拒、解除后连败清零可再注入）|
| `server/tests/lesson-reflect.mjs`（**扩**） | 蒸馏产出带 `modelFamily`；evidence 对不上仍丢；**产出仍是 candidate**；边候选不自动生效 |
| `server/tests/lessons-sim-lite.mjs` ✅（52 条已落地） | 族解析 / `byFamily` 规整 / 置信度单调性 / 内容哈希归一化 / 4 种边的校验与索引 / 同族加成与未验证扣分 / `contradicts` 硬排除 / 老经验不背扣分 / 淘汰顺序 / **连败计数与 `lessonFamilyDecay()` 阈值** |
| `app/test/lessons_section_test.dart`（**扩**） | 族标记、未验证提示、推荐启用排序、**三档操作仍在**、空态、6 秒空闲 0 Ticker、**「已降级」只给「解除降级」**、**待确认的边在候选卡上明示** |
| `server/tests/lessons-invariants.mjs`（新） | §5.8 的 I0–I5：单处存储 / 唯一注入点 / 无 `experience` 命名空间 / 四个模块零 IO 且在名单里 / 只在一轮收口写 / 渲染是文本参考 / 权限层互不依赖 / 可关可清 |
| `server/tests/lesson-reflect.mjs`（**扩**） | 边候选：目录只喂 15 条、只认 `supersedes`/`contradicts`、目录外 id 与哨兵丢掉、最多 2 条去重、空不落键 |

---

## 6. 里程碑与发版

| 版本 | 内容 | 门禁 |
|---|---|---|
| ✅ **1.7.1**（已发布 2026-11-20） | ① C1/C2 弃用告警 + 旧头回 `x-orbis-deprecated` ② **`app/lib/api.dart` 切 `x-orbis-*`**（解开 C3 ↔ C6 矛盾） | 现有 5 守卫全绿；1.7.1 App ↔ 1.7.0 服务端配对通过 |
| **2.0.0-alpha.1** | Phase 0 完成 + lessons v2 字段与边骨架（**蒸馏仍产 candidate**） | 现有 lessons 测试全绿 + 契约快照上线 |
| **2.0.0-alpha.2** | SIM-Lite 全链路（族归因 + 边 + 推荐排序 + `runtime.lessons`），**评审门禁仍是 candidate→active，默认关闭自动晋升** | 五条红线（I0–I5）+ 新增 e2e |
| **2.0.0-beta.1** | Phase 2 基座化收口（types / 注入点 / 发布 / examples / 稳定性文档） | `npm pack` 干净安装可跑 |
| **2.0.0-rc.1** | Phase 3 清债全删 + 迁移命令 | `check-legacy` 白名单清零 |
| **2.0.0** | GA + 破坏性变更公告 + 配对问答表 | **1.7.1+** 客户端 ↔ 2.0 服务端真机配对通过（C6） |

---

## 7. 已拍板的 5 个决策（2026-11-20）

| # | 决策 | 拍板结果 | 落到哪 |
|---|---|---|---|
| **D1** | 发不发「弃用告警版」 | ✅ **发 1.7.1**，并把 App 切 `x-orbis-*` 一并放进 1.7.1 | T1.1 / T1.3a / §6 第一行 |
| **D2** | C6 局域网 / TLS 身份 | ✅ **永久双播**（不删） | T1.6 |
| **D3** | SIM-Lite 默认开关 | ✅ **alpha 默认关、beta 起默认开**；且开启后**仍默认保留 `candidate → active` 人工审批** | §5.6 / §6 |
| **D4** | 经验是否跨项目迁移 | ✅ **2.0 按 scope 严格隔离**，跨仓迁移留 2.1 | §5.5 门槛不变 + non-goals |
| **D5** | SDK 分发形态 | ✅ **先私有包把契约跑稳（Phase 2）→ 2.1 再公开 npm** | T2.6 |

---

## 8. 风险与对策

| 风险 | 触发条件 | 对策 |
|---|---|---|
| **R1 两套系统并存** | 有人图省事新开 `experience/` 目录或第二个面板 | 反向不变量 **I0** 写进测试；本文 §5.1 的「五个改造缝」是唯一允许的改动面 |
| **R2 门禁倒退** | 为了让「自进化」显得自动，把 candidate 改成直接 active | §5.6 写死；自动晋升必须三道闸且默认关闭 |
| **R3 经验污染** | 蒸馏出“永远让测试通过”这类坏经验 | 人工审批 + evidence 硬校验 + I3 只作文本参考 |
| **R4 跨模型误迁移** | 单族有效经验被异族无条件复用 | §5.4 去偏规则 + 「未在同模型验证」标记 + 双族门槛 |
| **R5 清债断代老用户** | C2 直接删目录回退；C3 先删头后切客户端 | T1.3a 在 1.7.1 先切客户端；`orbis migrate` 复制不删除 |
| **R6 三线并行挤爆** | 同一周三条线都在改 `server/src` | 每 Phase 只允许**一条主线**处于可合并状态 |
| **R7 守卫失守** | 新模块绕过纯逻辑约束 | I1 由 `scripts/check-style.mjs` 继续管；T1.0 的 `check-legacy.mjs` 进 CI |

---

## 9. 不做什么（Non-goals，2.0 明确不做）

- ❌ 经验图谱可视化（只做现有面板的增量标签）
- ❌ 向量库 / 嵌入检索（Lite 只做词重叠 + 一阶边扩散）
- ❌ 第二个经验库 / 第二个设置面板 / 第二套预算数字（见 I0）
- ❌ 跨机器或跨仓经验同步（2.1，且要先有可信度模型）
- ❌ 自动改代码的自进化（SIM-Lite 只写经验不改代码）
- ❌ 把 `candidate → active` 换成全自动（自动晋升只能是默认关闭的可选策略）

---

## 10. 完成定义（DoD）与回归底线

2.0.0 只有在下面全部为真时才算完成：

1. `node scripts/check-secrets.mjs`、`node scripts/check-legacy.mjs`（待新增）零检出（白名单清零）
2. `server && node scripts/check-consistency.mjs`、`node scripts/check-capability-drift.mjs`、`node tests/all.mjs` 全绿
3. `node scripts/check-spec-progress.mjs`、`node scripts/check-style.mjs` 全绿（含 I0 反向不变量）
4. `app && flutter analyze --no-pub` 零警告、`flutter test --no-pub` 全绿
5. `npm pack` → 干净环境安装 → `examples/sdk/01-minimal.mjs`（待新增）跑通
6. **1.7.1+** 客户端 ↔ 2.0 服务端真机配对成功（C6 双播验证；1.7.0 老安装包需先升级）
7. `docs/RELEASE.md` 的 2.0 段含破坏性变更清单与回滚指引

---

## 11. 与既有 issue 的映射

| Issue | 归属 | 说明 |
|---|---|---|
| #30 W2d macOS 桌面输入 | 不在 2.0 关键路径 | 独立推进，可随时插入 |
| #31 锁屏 / #32 多屏 | **Phase 3 前置** | C6 双播的真机验证挂在这里一起做 |
| #34 本机输入合成环境 | 阻塞 #31/#32 | 先解决，否则真机项一直悬空 |
| #37 P1 欠账 | **T2.10（Phase 2 尾声）** | 许可证清单并入 T2.6 发布流程 |
| #38 wip 分支结账 | **Phase 0** | 清完再开分支，避免三线并行时 rebase 打架 |
