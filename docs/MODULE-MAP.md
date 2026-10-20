# 模块地图

> 找东西先看这张表。新增功能前先确定"它属于哪一层"，别往大文件里再塞。
> 约定：`index/http/ws` 只做接线；纯逻辑单独成文件并配测试；界面只做展示。

## 服务端 `server/src`

| 文件 | 职责 |
|---|---|
| `index.js` | 入口分流：pi CLI 参数交给 pi CLI，否则加载 `server-main.js` |
| `pi-args.js` | 判断「这次是 pi CLI 调用还是服务端」并委派；扩展派子 agent 会拿 `argv[1]` 当 pi 入口 |
| `server-main.js` | 服务端装配：reap 一次性消息 → runner/pairing → HTTP/WS → 定时任务调度器 → 信号收工 |
| `config.js` | 全部配置来源；数据目录定位与一次性迁移 |
| `http.js` | REST 路由（鉴权、房间/消息/bot/任务/定时任务/分片上传/附件/政策） |
| `ws.js` | WebSocket：hello 快照、send/abort/ping、事件广播 |
| `version.js` | 服务端版本唯一来源（读 package.json） |
| `update-check.js` | 版本比较与更新判定、按平台挑安装包（纯函数） |
| `update-checker.js` | 查 GitHub Releases（可换镜像）、超时与缓存；只查不装 |
| `store.js` | 内存态与落盘：bots/rooms/devices/sessions/**tasks**/**automations**/**approvals**/policy；消息游标；拒绝留档 |
| `pi-runner.js` | 轮次编排：建会话、群轮次、派活、预算、打断、上报、定时任务执行入口 |
| `session-factory.js` | 造会话：模型/工具/预算/提示词装配；扩展过滤（不加载 context-mode 类） |
| `session-pool.js` | 会话缓存、pending 去重、LRU 驱逐 |
| `session-refresh.js` | 配置变更后标记会话待重载；忙碌会话延后释放，取用时同步预留避免竞态 |
| `direct-message-delivery.js` | 私聊异步输入投递；会话忙时按原模式排队、保留输入并响应取消 |
| `tools.js` | 工具定义（通用 + 主控）：派活/私信/建部门/后台进程/询问卡片… |
| `group-prompt.js` | 群聊会话层：谁先开口、每人看到什么、提示词拼装（纯逻辑） |
| `group-round.js` | 群轮次决策：该跳过/排队/打断/派发、收尾轮判定（纯函数） |
| `transcript-budget.js` | 群聊记录按字数预算裁剪、单条超长保留头尾（纯函数） |
| `skills.js` | 技能库：规范化、SKILL.md 解析、按任务挑选（纯函数） |
| `lessons.js` | 经验库：cue/lesson/evidence 校验、按任务挑选、**有上限的注入渲染**（一次≤3条≤600字，只有 active 参与） |
| `lesson-reflect-prompt.js` | 复盘提示词与输出解析（纯函数）：证据必须指到真实 msgId + 原文对得上 |
| `lesson-reflect.js` | 收尾复盘：无工具的一次性会话 → 候选经验（**只进库，等人启用**） |
| `escalation.js` | 出事往上抬：抬给谁、回执写什么 |
| `watchdog.js` | 心跳与卡死判定、收尾 |
| `prompt-input.js` | 拼输入：附件正文、图片、自动附图 |
| `system-prompt.js` | 系统提示词：身份、说话规矩、部门规矩 |
| `mentions.js` | @解析与花名册文本 |
| `model-*.js` | 模型接线：注册（registry）/模型组（groups）/探活（health）/菜单（menu） |
| `model-capacity.js` | 同 ID 模型元数据合并、容量优先级与正整数/最大输出校验（纯逻辑） |
| `model-thinking.js` | 思考强度：`reasoning` / 七档 `thinkingLevelMap` / 上游 `thinkingFormat`，含预设与校验（纯逻辑） |
| `mcp.js` | MCP 服务库：规范化、校验、转 pi 配置、测连接（纯逻辑 + 一个 probe） |
| `mcp-hook.js` | 把用户配的 MCP 按 bot 选择注册进会话；给主控的能力清单 |
| `local-capabilities.js` | 只读扫描本机 pi 已装的 skill / MCP，供一键导入 |
| `spawn-command.js` | 跨平台启动用户填的命令：Windows 上按 PATHEXT 解析 `.cmd/.bat`、cmd.exe 参数转义、探测进程收尾 |
| `site-draft.js` | 站点接入草稿：抓 → 存草稿 → 用户确认 → 才入库（草稿只在内存） |
| `http-client.js` | 带系统代理探测的 fetch（Node 原生 fetch 不读系统代理）|
| `merge-messages.js` | 连发消息合并：静默窗口 700ms，把"想到一句发一句"拼成一段 |
| `model-reply.js` | 模型错误分类与脱敏展示、认证失败终止重试、真正空回复的限定模型恢复 |
| `providers.js` | 额外 provider 注册与默认模型解析 |
| `context-budget.js` | 上下文预算：容量覆盖 + 压缩阈值 |
| `attachments.js` / `extract.js` / `upload-sessions.js` | 附件存取、正文提取、**分片上传** |
| `shells.js` | 后台进程注册表（启动/读/写/杀、容量与回收） |
| `shell-policy.js` | 命令级规则：归一化、解析、通配匹配、判不了就拒绝（纯函数） |
| `policy-hook.js` | 命令规则的执行点（pi 内联扩展，拦 `tool_call`） |
| `dm.js` | 私聊行为：开场文案、进度回执、是否该回执（纯函数） |
| `hooks.js` | 工具钩子：改写入参 / 拦下（规则存 `data/hooks.json`，判定纯函数） |
| `change-watch.js` | 工作目录快照与改动对比（本轮改了哪些文件） |
| `artifact-watch.js` | 产物回传：只挑交付物扩展名、只挑这一轮新增/改过的、单文件/总量有上限 |
| `automations.js` | 定时任务：排期计算、校验、调度器（时间逻辑纯函数） |
| `coding-baseline.js` | 开发类 bot 的工程基线提示 |
| `relay/frames.js` | 中转帧编解码（base64 + deflateRaw 无损压缩，纯函数） |
| `relay/server.js` | 云侧中转：按 code 把 HTTP/WS 转给电脑侧（可选，默认不启动） |
| `relay/agent.js` | 电脑侧外连客户端（可选，`npm run relay-agent`） |
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
| `update_info.dart` | 更新响应解析 + 要不要提示的规则（纯逻辑，有测试） |
| `widgets/update_prompt.dart` | 更新提示弹窗、带进度下载、下载完成提示 |
| `widgets/skills_library.dart` | 技能库面板：搜索/增删改/启停/导入 SKILL.md |
| `server/options.dart` | 启动配置、端口与数据目录的环境变量映射、启动结果 |
| `server/locate.dart` | 服务端/Node/npm 定位；支持 macOS App Resources、Windows 的 nvm-windows / fnm / Volta / Scoop、PATH 与用户覆盖；版本目录按数值降序 |
| `server/health.dart` | 有大小上限的健康响应读取与服务身份格式校验（纯逻辑） |
| `server/spawn_posix.dart` | POSIX 独立进程组启动脚本，日志直写文件并释放辅助进程 |
| `server/supervisor.dart` / `server/launcher.dart` / `server/server_log.dart` | 进程与 PID 管理、启动编排及日志；Windows/POSIX 平台分流 |
| `model_group_capacity.dart` | 模型卡片草稿、稳定行标识、容量解析与保存协议（纯逻辑） |
| `widgets/model_group_editor.dart` | 模型组编辑装配：接口配置、独立模型卡片、思考强度选项拉取、连接测试与保存 |
| `widgets/model_capacity_fields.dart` | 模型卡片与列表摘要展示；单独编辑 ID、显示名、上下文窗口、最大输出与思考强度，向上回传操作 |
| `widgets/server_config_section.dart` | 共用本机启动配置对话框，保存后调用状态层重启并报告结果 |
| `screens/host_connect_screen.dart` | 宿主启动与失败页；重试、查看日志和打开启动配置 |
| `screens/` | 页面：home_shell / chat_screen / rooms_screen / bots_screen / settings / pair / scan |
| `widgets/` | 可复用组件：`tool_steps`、`changed_files`、`task_board`、`automation_sheet`、`ask_card`、**`approval_card`**、`md_text`、`attachment_view`、`avatar*`、`window_title_bar`… |
| `theme.dart` | 颜色/字号/圆角；**图标约束写在这里**（基础字体仅 68 个字形） |
| `clipboard_image.dart` / `clipboard_image_macos.dart` | 剪贴板图片平台分流；Windows PowerShell、macOS PNG/TIFF 读取与临时文件清理 |
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
| `app/lib/screens/chat_screen.dart` | ~1970 | 消息列表 / 输入区 / 顶栏 三块独立；消息气泡单独成文件 |
| `server/src/pi-runner.js` | ~1800 | 群轮次已抽出，还可把"单轮执行"与"会话生命周期"分开 |
| `server/src/store.js` | ~1600 | 按域拆：rooms / bots / tasks / automations / persist（保持单一入口导出） |

## 测试地图

| 层 | 命令 |
|---|---|
| 服务端统一入口 | `cd server && node tests/all.mjs`（无需真实模型，具体文件以入口列表为准） |
| 额外本机中转回归 | `cd server && node tests/relay.mjs`、`node tests/relay-limits.mjs`（随机端口与假服务端） |
| 自建样本解析 | `cd server && node tests/extract.mjs`（不设置外部样本环境变量时只读自建样本） |
| 客户端全量 | `cd app && flutter test` |
| 静态检查 | `cd app && flutter analyze` |
| macOS 打包 | `./scripts/pack-macos.sh`（完整 Xcode 原生构建；`--no-build` 复用已有 Release App） |
| Windows 打包 | `powershell -File scripts/pack-windows.ps1`（暂存后换成品；`-NoBuild` 复用、`-WithNode` 带 node.exe、`-Zip` 出压缩包） |
