# 执行入口盘点（P0-1 前置）

对应规格：`architecture-permissions-v1.0.1.md` §11「梳理所有文件、命令、Git、GUI、网络与凭据入口，入口逐次强制核对当前有效授权及完整父链撤销状态」。

> 本文只是**盘点**，不代表任何入口已合规。规格 §16.1 原话：「本稿没有任何当前实现通过结论」。

## 现状：唯一的校验点是一条线

| 层 | 校验点 | 覆盖 |
|---|---|---|
| pi 工具调用 | `policy-hook.js` 的 `tool_call` 扩展（一个处理器） | 全部模型工具（49 个） |
| HTTP 路由 | 只做**身份**鉴权（`authenticate`）+ CSRF 头 | **不做任何授权判定** |
| 内部调用 | 无 | 直接 `spawn` / `fs.write*` |

也就是说：**模型走工具那条线有判定，别的线一条都没有。**

## 一、模型工具（49 个）

由 `defineTool` 注册，全部经 `policy-hook`。

| 文件 | 数量 | 工具 |
|---|---|---|
| `tools.js` | 41 | ask_user, web_search, web_fetch, ego_browser, list_bots, list_departments, read_department, message_bot, reply_bot, extract_file, send_image, run_background, read_shell, write_stdin, kill_shell, query_site, list_sites, add_skill, add_mcp_server, list_local_capabilities, stage_site, confirm_site, commit_site, discard_site, create_bot, update_bot, set_context_budget, delete_bot, list_models, recommend_model, check_models, list_department_templates, create_department, dispatch_to_department, set_department_lead, add_to_department, remove_from_department, announce, list_skills, assign_skill, create_skill |
| `coordination/intake-tool.js` | 1 | accept_task |
| `coordination/task-insight-tool.js` | 4 | task_status, task_revise, task_unblock, task_extend_budget |
| `tasks/task-expert-tool.js` | 1 | task_expert_review |
| `tasks/task-member-tool.js` | 1 | assign_member_task |
| `tasks/task-plan-tool.js` | 1 | task_plan |

**缺口**：`policy-hook` 的判定是「策略 + 审批 + 角色白名单」，**没有授权对象**（无 grantId、无资源范围、无有效期、无父链、无撤销状态）。

## 二、HTTP 路由（55 条声明）

统一鉴权在 `http.js:459`（`if (!device) return 401`），之后只校验 CSRF 头与 JSON 媒体类型。**没有任何按资源的授权判定。**

### 会改状态、且能间接产生系统副作用的（P0 必须纳入网关）

| 路由 | 副作用 |
|---|---|
| POST/PATCH `/api/policy` | 改的是**防线本身** |
| POST/PUT `/api/hooks` | 改工具入参/拦命令，等效于改行为 |
| POST `/api/mcp` | 新增 MCP = 新增可执行子进程 |
| POST `/api/mcp/test` | 起子进程探测 |
| POST `/api/local-capabilities/import` | 从本机 pi 配置导入 |
| POST `/api/skills/import` | 同上 |
| POST `/api/files/delete` | 删文件 |
| POST `/api/uploads`、`/api/uploads/init` | 写盘 |
| POST `/api/bots`、`PATCH /api/bots/:id`（含 mcpServers） | 改角色能力 |
| POST `/api/sites/probe` | 对外请求 |
| POST `/api/model-groups/test`、`/api/decision/probe` | 对外请求（含凭据） |
| POST `/api/devices`、`/api/pair` | 发凭据 |

### 只读（仍需授权判定，但风险低）

`GET /api/{state,policy,bots,rooms,tasks,mcp,sites,skills,hooks,models,...}`

## 三、直接调系统 API 的内部模块（28 个文件有真实副作用）

这些**完全绕过工具层**，是规格所说「遗漏入口」的主体。

### spawn / execFile（13 处，8 个文件）

| 文件 | 处 | 用途 |
|---|---|---|
| `sandbox-win.js` | 4 | 启动器：grant/revoke/delete-profile/run |
| `spawn-command.js` | 3 | 统一命令启动（PATHEXT/.cmd 处理） |
| `ego-browser.js` | 1 | 跑浏览器脚本 |
| `shells.js` | 1 | 内置 bash/powershell |
| `sandboxed-shell.js` | 1 | 沙箱版 shell |
| `sandbox.js` | 1 | selfCheck |
| `mcp-probe-cleanup.js` | 1 | 探测进程清理 |
| `http-client.js` | 1 | 走代理的 HTTP |

### 网络出口（8 处）

`http-client.js`(5)、`http.js`(1 入站)、`mcp-probe-http.js`(1)、`relay/agent.js`(1)

### 写盘（48 处，未逐条列）

大头：`attachments.js`(8)、`local-token.js`(7)、`data-migration.js`(5)、`upload-sessions.js`(4)、`sandbox.js`(3)、`sandbox-win.js`(3)、`secrets.js`(3)、`run-stats.js`(3)、`util.js`(3)

> 其中 `local-token.js` / `secrets.js` / `data-migration.js` 属于**宿主自身**的数据管理，不是「某个 Bot 的动作」。授权网关要区分「主体是 Bot」还是「主体是宿主」——规格 §3 的权限服务本身就在宿主边界内。

## 四、Git

**当前为零**：工具清单里 0 个 git 工具，代码里没有任何 git 调用。

P0-6 要新增。按规格 §14.2，调用用户已安装的 Git（探测可执行路径 + 版本），不随包分发。

## 五、GUI / 桌面

### 观察层：已交付（P0-3a）

| 工具 | 能力 | 网关动作 | 给谁 |
|---|---|---|---|
| `desktop_observe` | 列可见窗口（应用/标题/位置尺寸） | `desktop.observe` | 只给主 Bot |
| `desktop_screenshot` | 截**指定窗口**（默认不截整屏） | `desktop.observe` | 只给主 Bot |

实现在 `server/src/desktop-observe.js`。两个实测出来的平台细节：

- **Windows 必须用 `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)`**，不能用
  `CopyFromScreen(窗口矩形)` —— 后者截到的是"压在窗口上面的东西"。
  本机实际踩到：想截编辑器，结果截到了自己终端。
- **PowerShell 变量大小写不敏感**，`$H` 会把窗口句柄 `$h` 顶掉，
  PrintWindow 于是返回 False 并静默回退。变量名改 `$winW/$winH`。
- 老程序不实现 `WM_PRINTCLIENT` 时 PrintWindow 返回**全黑但返回 true**，
  所以有"解 IDAT 看字节分布"的空白检测，失败才回退屏幕矩形。

macOS 走 `System Events` 列窗口 + `screencapture -R <矩形>`。
System Events 拿不到 CGWindowID，所以是按矩形截；窗口被部分遮挡时
遮挡处截到的是上面那个窗口。**待 macOS 实机验证**（规格 §16.1 要求标出）。

### 输入层：未做（P0-3b）

无鼠标、无键盘、无隐藏/最小化恢复。规格 §5.2 要求的输入租约、
用户接管检测、世代号、旧坐标失效都还没实现 —— 这一层必须在确认框架之后。

`ego_browser` 是**页面级**（`page.goto`/`page.snapshot`/`page.evaluate`），不是桌面级，不构成 computer use。

## 六、结论：P0-1 的边界

规格要求「入口逐次强制核对当前有效授权及完整父链撤销状态」。按上面盘点，P0-1 的最小可交付是：

1. **授权记录与存储**（规格 §6.1 字段）
2. **统一执行边界**：一个 `enforce()`，主体/动作/资源/参数 + 每次现查有效性
3. ~~**把现有唯一的校验点（policy-hook）改成经网关**~~ ✅ 已完成（`b130fc6`）
4. **HTTP 的危险路由接入网关**（上表「会改状态」那批）—— **未做**
5. ~~**反向用例优先**~~ ✅ 已完成（`grants.mjs` 30 项：来源、子授权扩权、父链撤销、策略版本、世代）

第 3 步刻意不改任何现有行为（默认授权仍等价于今天的 policy），先把「漏掉的入口」变成可测；之后的 Git / computer use 才有地方挂。

### 进度

| 项 | 状态 | 提交 |
|---|---|---|
| 授权模型（`grants.js`）+ 网关（`grant-gate.js`） | ✅ | `b130fc6` |
| policy-hook 经网关 + 迁移授权（行为不变） | ✅ | `b130fc6` |
| 桌面观察（`desktop-observe.js` + 两个工具） | ✅ | `c45eb7c` |
| HTTP 危险路由接网关 | ⬜ 下一步 | — |
| Git 适配器（P0-6） | ⬜ | — |
| 确认框架（P0-4，只做不可恢复动作） | ⬜ | — |
| 桌面输入（P0-3b，输入租约） | ⬜ 最后 | — |

## 七、明确不做（本阶段）

- 不改沙箱策略。规格 §8 明确「旧『所有挂 MCP 的 Bot 必须沙箱』不再作为全局规则」，但撤销那条规则属于产品决策，不在 P0-1 里顺手改。
- 不实现桌面**输入**（P0-3b）、不实现 Git（P0-6）、不做确认框架（P0-4）。
- 观察层已交付，但它只覆盖"看"，不代表 P0-3 整体完成。
- 不把现有的 120 分钟 `approvalGrants` 当作已合规授权 —— 它没有资源范围，正是规格 §13.1 要修的东西。
