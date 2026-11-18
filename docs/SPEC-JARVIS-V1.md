# Spec: Jarvis Superroot Mode (`mainBot` 最高权限与全能管家能力) V1

> 状态：设计并落地（2026-11-18）
> 关联代码：`server/src/config.js`、`server/src/chat-redact.js`、`server/src/capabilities.js`、`server/src/sandboxed-shell.js`、`server/src/policy-hook.js`、`server/src/tools.js`、`server/src/jarvis-tools.js`、`server/src/git-tools.js`、`server/src/store.js`、`server/src/pi-runner.js`、`server/src/system-prompt.js`、`app/lib/app_state.dart`

---

## 1. 设计定位

将唯一的主控 Bot（`role === 'main'`，用户电脑与手机端唯一总管家「贾维斯」）升级为**全机可信宿主模式（`MODE.host`）＋ 全域对话式系统配置管家**：

- **全权代劳**：用户无需在手机或电脑上翻设置页，直接用自然语言让 `mainBot` 修改定时任务、Bot 全属性（含 16 种几何形象与颜色、模型、技能、上下文）、部门与预算、用户称呼与偏好、技能库/经验库、本机能力导入、MCP 生命周期、API 模型组/默认模型/决策路由，以及部门规矩与桌面设置。
- **不降权不弹窗**：在日常执行时，`mainBot` 保持可信宿主身份（挂 MCP 也不转入沙箱、可访问工作区外宿主机目录、`ask` 档与已启用外部 MCP 工具免逐次弹窗），仅保留极少数高危防线动作在聊天内一键确认。
- **下属继续受控**：所有成员与部门负责人（`lead` / `member`）严格维持原有的 `project` / `isolated` 边界、工作区限制与命令规则。

---

## 2. 权限矩阵与执行边界

| 主体 | 执行模式 | 工作目录范围 | 挂 MCP 时 Shell | 日常动手 / 已启用 MCP | 高危防线边界 |
|---|---|---|---|---|---|
| **主控 `mainBot`**（`Work Lane` + `jarvisMode`） | 恒为 `MODE.host`（可信宿主） | `run_background` 与 `git_*` 支持全机任意合法目录 | 不进沙箱，直通宿主 `bash` / `powershell` | 免逐次弹窗，自动走 `jarvis-host` 授权放行并写入 `adminAudit` 审计 | 全局只读刹车（`dangerous='deny'`）继续生效；首次启用未启用 MCP 与 `git_destructive` 弹一键确认卡 |
| **主控 `mainBot`**（`Talk Lane` 旁路） | 纯内存只读 | 仅只读与实时快照 | 无 | 无写工具 / 无 MCP / 无 Shell | 旁路零副作用 |
| **部门负责人 / 执行 Bot**（`lead` / `member`） | `MODE.project` / `MODE.isolated` | 严格限制在 `config.workspace` 内 | 挂 MCP 时强制走沙箱与逐次审批 | 严格按 `grantGate` + `policy.dangerous` + `allowCommands` 执行 | 无法调 `buildChiefTools` / `buildJarvisTools` / `desktop_*` |

### 2.1 `policy-hook` 中的 `mainBot` 放行规则

1. `policy.dangerous === 'deny'`（全局只读总刹车）对**所有 Bot（含主控）**始终优先拦截写操作。
2. `policy.dangerous` 为 `allow` 或 `ask` 且 `!talkLane && role === 'main' && jarvisMode`：
   - 不因 `allowCommands` 白名单拦主控（`denyCommands` 明确黑名单除外，且主控可通过 `set_policy` 修改）；
   - 不因 `opaqueScriptBlockReason` 拦主控 `ego_browser`；
   - `grantGate.check()` 若未命中手建授权（除 `git.destructive` 与被显式 `revoked` 的规则外），允许主控按 `MODE.host` 放行并记录 `adminAudit`（`主控宿主执行：<tool>`）；
   - 通过 `isJarvisApprovalCall` 收窄审批弹窗：仅在调用 `git_destructive`，或通过 `manage_mcp_server` / `import_local_capabilities` **从未启用状态开启 MCP** 时弹出一次聊天内确认卡；常规文件、命令、桌面键鼠、已启用 MCP、模型组/策略修改全部零弹窗直通。

---

## 3. Steward 系统管理能力清单

| 工具 | 职责范围 | 关键安全与实时同步机制 |
|---|---|---|
| `list_automations` / `manage_automation` | 创建、修改、启停、删、立即触发定时任务 | 校验 `everyMinutes ≥ 5` 或 `dailyAt HH:MM`，广播 `automation.updated` / `automation.deleted` |
| `create_bot` / `update_bot` | 在原有人设/模型/思考/MCP 基础上，新增 `avatarShape (0..15)`、`avatarColor (#RRGGBB)` 与 `skills` | `0..15` 对应 16 种几何形态，`-1` 或空值恢复默认/随机 |
| `manage_user_profile` | 读取/修改用户名，增删改用户的强偏好（`preferences`） | 自动重载空闲会话让称呼与习惯即时注入所有 Bot 系统提示 |
| `manage_department` | 改部门名/简介/组长/置顶隐藏、删空部门、改 `groupLimits`、存成部门模板 | 不允许删除当前正在对话的房间本身 |
| `manage_knowledge` | 全局技能库编辑/删、经验库列表/增/改/删 | 有证据校验与编码校验（复用 `store` / `lessons` 原有契约） |
| `import_local_capabilities` | 一键导入本机 `~/.pi/agent` 中的技能与 MCP（支持 `enable: true` 同时启用） | 启用新 MCP 时触发 `isJarvisApprovalCall` 一键确认 |
| `manage_mcp_server` | 查看、修改、启用、停用、删除已登记 MCP 服务 | 从停用改为启用时触发一键确认；修改后热调用 `applyMcpChange()` |
| `manage_model_group` | 增删改查模型组、测试连通性、切换全局默认模型（`set_default_model`）、配置快决策路由 `Jev` | API Key 使用 AES-GCM 密文落盘；工具输出只返回打码 `keyMasked`；执行后立即调用 `redactRoomSecrets` 对聊天记录中的明文 Key 打码并推 `msg.updated`；热调用 `applyModelGroupChange()` + `models.changed` |
| `set_policy` | 读取/更新 `dangerous` / `requireProof` / `denyCommands` / `allowCommands` 与桌面设置（`trustPhantomInput` / `awayAfterMs` / `allowLocalApproval`） | 变更后自动重发迁移授权、通知在跑任务、重置空闲会话工具集 |

---

## 4. 聊天明文凭据自动脱敏（`chat-redact.js`）

当用户在电脑或手机聊天框把 API Key 发给贾维斯配置模型组或路由时：

1. `manage_model_group` 入库前收集用户输入中的所有 `apiKey`，立即调用 `store.redactRoomSecrets(roomId, rawKeys)`，把会话历史里最近消息中的明文 Key 原地替换为掩码（例如 `sk-123456…abcd`）并通过 WS `msg.updated` 实时刷新客户端气泡。
2. `pi-runner.js` 在主控（`role === 'main'`）每轮执行结束的 `finally` 块中再执行一轮兜底扫描，对常见高置信度 Token 形态（`sk-` / `sk_` / `nvapi-` / `ghp_` / `AKIA` / `AIza` / 长 `Bearer`）自动打码，避免凭据长期明文留在聊天记录中。
