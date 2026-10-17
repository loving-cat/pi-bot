# 模块地图

> 找东西先看这张表。新增功能前先确定"它属于哪一层"，别往大文件里再塞。
> 约定：`index/http/ws` 只做接线；纯逻辑单独成文件并配测试；界面只做展示。

## 服务端 `server/src`

| 文件 | 职责 |
|---|---|
| `index.js` | 启动：reap 遗留流式消息 → 建 runner/pairing → HTTP/WS → 定时任务调度器 → 信号收工 |
| `config.js` | 全部配置来源；数据目录定位与一次性迁移 |
| `http.js` | REST 路由（鉴权、房间/消息/bot/任务/定时任务/分片上传/附件/政策） |
| `ws.js` | WebSocket：hello 快照、send/abort/ping、事件广播 |
| `version.js` | 服务端版本唯一来源（读 package.json） |
| `store.js` | 内存态与落盘：bots/rooms/devices/sessions/**tasks**/**automations**/**approvals**/policy；消息游标；拒绝留档 |
| `pi-runner.js` | 轮次编排：建会话、群轮次、派活、预算、打断、上报、定时任务执行入口 |
| `session-factory.js` | 造会话：模型/工具/预算/提示词装配；扩展过滤（不加载 context-mode 类） |
| `session-pool.js` | 会话缓存、pending 去重、LRU 驱逐 |
| `tools.js` | 工具定义（通用 + 主控）：派活/私信/建部门/后台进程/询问卡片… |
| `group-prompt.js` | 群聊会话层：谁先开口、每人看到什么、提示词拼装（纯逻辑） |
| `group-round.js` | 群轮次决策：该跳过/排队/打断/派发（纯函数） |
| `escalation.js` | 出事往上抬：抬给谁、回执写什么 |
| `watchdog.js` | 心跳与卡死判定、收尾 |
| `prompt-input.js` | 拼输入：附件正文、图片、自动附图 |
| `system-prompt.js` | 系统提示词：身份、说话规矩、部门规矩 |
| `mentions.js` | @解析与花名册文本 |
| `model-*.js` | 模型接线：注册（registry）/模型组（groups）/探活（health）/菜单（menu） |
| `providers.js` | 额外 provider 注册与默认模型解析 |
| `context-budget.js` | 上下文预算：容量覆盖 + 压缩阈值 |
| `attachments.js` / `extract.js` / `upload-sessions.js` | 附件存取、正文提取、**分片上传** |
| `shells.js` | 后台进程注册表（启动/读/写/杀、容量与回收） |
| `shell-policy.js` | 命令级规则：归一化、解析、通配匹配、判不了就拒绝（纯函数） |
| `policy-hook.js` | 命令规则的执行点（pi 内联扩展，拦 `tool_call`） |
| `dm.js` | 私聊行为：开场文案、进度回执、是否该回执（纯函数） |
| `hooks.js` | 工具钩子：改写入参 / 拦下（规则存 `data/hooks.json`，判定纯函数） |
| `change-watch.js` | 工作目录快照与改动对比（本轮改了哪些文件） |
| `automations.js` | 定时任务：排期计算、校验、调度器（时间逻辑纯函数） |
| `coding-baseline.js` | 开发类 bot 的工程基线提示 |
| `web.js` | 搜索与抓网页 |
| `util.js` | id/时间/原子写/日志/错误分类 |

新增后端能力的落点：

- 新的**数据**：加在 `store.js` 的对应 section（tasks/automations 已经这么放）；
- 新的**纯算法**：单独文件 + `tests/` 里配测试（如 `shell-policy.js`、`automations.js`）；
- 新的**路由**：只写参数校验与调用，逻辑放到模块里；
- 新的**执行期拦截**：走 `policy-hook.js` 这类 pi 内联扩展，不往 runner 里塞判断。

## 客户端 `app/lib`

| 位置 | 职责 |
|---|---|
| `app_state.dart` | 连接、房间、消息、流式、任务、定时任务、模型组…（**状态与请求**） |
| `models.dart` | 数据模型：Msg / Room / Bot / TaskItem / Automation / ChangedSummary… |
| `api.dart` | HTTP 封装（含分片上传 `uploadChunked`） |
| `server/` | 启动层：`options` / `locate` / `server_log` / `supervisor` / `launcher` |
| `screens/` | 页面：home_shell / chat_screen / rooms_screen / bots_screen / settings / pair / scan |
| `widgets/` | 可复用组件：`tool_steps`、`changed_files`、`task_board`、`automation_sheet`、`ask_card`、**`approval_card`**、`md_text`、`attachment_view`、`avatar*`、`window_title_bar`… |
| `theme.dart` | 颜色/字号/圆角；**图标约束写在这里**（基础字体仅 68 个字形） |
| `clipboard_image.dart` | 剪贴板图片读取（Windows PowerShell） |
| `window_state.dart` | 窗口位置/大小记忆：编码、解析、夹回可见区（纯函数） |
| `app_log.dart` | 界面层错误落盘（app.log）、打开日志目录 |

界面约定：

- 面板类组件拆成 `widgets/xxx_sheet.dart`：组件只做展示与回调，
  "打开面板"的装配写成同文件的 `showXxxSheet(context, state, room)`；
  页面里只留一行调用。
- 新增图标前确认它在基础字体里（`list / checkCircle2 / fileText / target / boxes / pin …`），
  否则真机是空白而组件测试发现不了。

## 已知偏大的文件（下次优先拆）

| 文件 | 行数 | 计划拆法 |
|---|---|---|
| `app/lib/screens/chat_screen.dart` | ~1960 | 消息列表 / 输入区 / 顶栏 三块独立；消息气泡单独成文件 |
| `server/src/pi-runner.js` | ~1700 | 群轮次已抽出，还可把"单轮执行"与"会话生命周期"分开 |
| `server/src/store.js` | ~1100 | 按域拆：rooms / bots / tasks / automations / persist（保持单一入口导出） |

## 测试地图

| 层 | 命令 |
|---|---|
| 服务端全量 | `cd server && node tests/<name>.mjs`（unit / auth / disk / tasks / automations / uploads / **approvals** / **hooks** / shells / shell-policy / policy-hook / dm / ask-guard / room-lock / model-health） |
| 客户端全量 | `cd app && flutter test` |
| 静态检查 | `cd app && flutter analyze` |
