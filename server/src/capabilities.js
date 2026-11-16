/**
 * 能力清单（Capability Manifest）—— **每一项事实只在这里写一次**。
 *
 * ## 为什么要有这个文件
 *
 * 项目要做成「像 pi-coding-agent 那样的多 bot 基座」：能力靠**声明式登记**扩展，
 * 不靠散落在各处的 if 分支。改造之前，加一个新能力要改 **7 处、跨 4 个文件**：
 *
 * ```
 * 1. action-catalog.js   ACTIONS        风险档 / 可撤销 / 要不要目标
 * 2. action-catalog.js   TOOLS          哪几个工具产生这个动作
 * 3. action-catalog.js   TARGET_RULES   从哪个入参字段认目标
 * 4. role-tools.js       READONLY_ALLOW 只读档放不放行
 * 5. role-tools.js       CHIEF_ONLY_TOOLS 是否只给主 Bot
 * 6. migration-grants.js MIGRATION_WITHHELD / CHIEF_ONLY_ACTIONS 迁移档给不给
 * 7. tools.js            defineTool     工具实现
 * ```
 *
 * 漏掉任一处**不会报错**，只会静默出错。这一周实测踩到 4 次：
 *
 * | 漏了哪一处 | 现象 |
 * |---|---|
 * | 迁移授权没列新动作 | 一调就 `no_grant`，看着像"功能坏了" |
 * | 只读名单与网关不同步 | 切成只读后 12 个工具被误拦（连 `web_search` 都不行） |
 * | 风险档按工具名查动作名 | 审计里 `risk` 恒为 `null` |
 * | 签发/校验的世代不一致 | 「重启后旧批准不续命」从没生效过 |
 *
 * 加一个能力：**7 处／4 文件 → 2 行／1 文件**（动作 + 工具各一行）。
 *
 * ## 为什么分「动作」和「工具」两层（不是偷懒）
 *
 * 实测过：把这些标志塞进动作层会**丢信息**。同一个 `net.fetch` 动作下：
 *
 * ```
 * ego_browser  → 会动手（mutating）：它能把页面上的东西点出去、填表提交
 * web_fetch    → 只读（readonly）：它只读一篇文章
 * ```
 *
 * 所以：
 *   · **动作层**（`ACTIONS`）放"这件事本身多危险" —— 风险档、能不能撤销、
 *     要不要认出目标、迁移策略。这些是动作的固有属性。
 *   · **工具层**（`TOOL_SPECS`）放"这个工具算不算动手" —— 只读、改状态、
 *     组织类、只给主 Bot、从哪个字段认目标。这些是工具的属性。
 *
 * 两层各写一次，规则是：**任何一项事实不允许在第二个地方重复出现**。
 *
 * ## 不做什么
 *
 * - 不 import 任何业务模块（只依赖 `grants.js` 的常量表，纯数据）。
 *   这样它永远是叶子模块，谁都能安全引用，不会成环。
 * - 不放工具实现。**声明和实现分开**：这里说"它是什么"，`tools.js` 说"怎么干"。
 * - 不在这里判权限。判定在 `grant-gate.js`，这里只提供事实。
 */
import { ACTION, RISK } from './grants.js';

// ---------------------------------------------------------------------------
// 第一层：动作
// ---------------------------------------------------------------------------

/**
 * 动作的固有属性。
 *
 * | 字段 | 含义 | 保守方向 |
 * |---|---|---|
 * | `label` | 界面/审计里给人看的名字 | 必填 |
 * | `risk` | 危险度（审计与界面用） | 没登记按 `medium` |
 * | `irreversible` | 做错了能不能撤销（决定要不要手机确认） | 拿不准写 `true` |
 * | `needsTarget` | 窄范围授权是否必须能认出目标（认不出就拒绝） | 拿不准写 `true` |
 * | `migration` | 迁移兼容授权怎么给：`all` / `chief` / `never` | `never` |
 */
export const ACTIONS = Object.freeze({
  // ---------------------------------------------------------------- 文件
  [ACTION.fileRead]: {
    label: '读文件',
    risk: RISK.low, irreversible: false, needsTarget: true, migration: 'all',
  },
  [ACTION.fileWrite]: {
    label: '写文件',
    risk: RISK.low, irreversible: false, needsTarget: true, migration: 'all',
  },
  [ACTION.fileDelete]: {
    // 删除不可撤销：文件没有回收站可用，脚本删掉的目录也回不来
    label: '删文件',
    risk: RISK.medium, irreversible: true, needsTarget: true, migration: 'all',
  },

  // ---------------------------------------------------------------- 命令
  [ACTION.cmdExec]: {
    label: '跑命令',
    // 命令里的路径埋在字符串里，认不出来。needsTarget: true 的含义因此是
    // "窄范围授权对它一律拒绝"（fail-closed）—— 这正是要修的那个洞。
    risk: RISK.medium, irreversible: false, needsTarget: true, migration: 'all',
  },
  [ACTION.cmdBackground]: {
    label: '后台进程',
    risk: RISK.medium, irreversible: false, needsTarget: true, migration: 'all',
  },

  // ---------------------------------------------------------------- Git
  [ACTION.gitRead]: {
    label: '读仓库',
    risk: RISK.low, irreversible: false, needsTarget: true, migration: 'all',
  },
  [ACTION.gitCommit]: {
    label: '本地提交',
    risk: RISK.medium, irreversible: false, needsTarget: true, migration: 'all',
  },
  [ACTION.gitPush]: {
    // push 出了本机就收不回来
    label: '推远端',
    risk: RISK.high, irreversible: true, needsTarget: true, migration: 'chief',
  },
  [ACTION.gitDestructive]: {
    // force push / reset --hard / 删分支 —— 规格 §7.1 的 G3。
    // 没有工具产生它（git-ops 白名单里根本没有），但格子先留着：
    // 接上时只能是用户新建授权，不能从迁移授权继承。
    label: '破坏性 Git',
    risk: RISK.critical, irreversible: true, needsTarget: true, migration: 'never',
  },

  // ---------------------------------------------------------------- 桌面
  [ACTION.desktopObserve]: {
    // 观察只读，但看得到整个屏幕 —— 风险是隐私面，不是破坏面
    label: '看屏幕',
    risk: RISK.medium, irreversible: false, needsTarget: false, migration: 'chief',
  },
  [ACTION.desktopInput]: {
    // 输入等于把当前登录身份交出去。输入层（P0-3b）还没建，
    // 接上时只要在 TOOL_SPECS 里加一条，其余四处自动生效。
    label: '操作屏幕',
    // migration: 'never' —— 不进迁移授权（下面 MIGRATION_WITHHELD 会含它）；
    // 但也不进 CHIEF_ONLY_ACTIONS（那个列表表示"迁移授权只给主 Bot"，
    // 而 never 已经表达"谁都不给"，语义上更严格，不需要再出现一次）。
    risk: RISK.critical, irreversible: true, needsTarget: false, migration: 'never',
  },

  // ---------------------------------------------------------------- 网络
  [ACTION.netFetch]: {
    label: '访问网络',
    risk: RISK.medium, irreversible: false, needsTarget: true, migration: 'all',
  },
  [ACTION.netSend]: {
    // 对外发送与 netFetch 差一个数量级：发出去的东西收不回来
    label: '对外发送',
    risk: RISK.high, irreversible: true, needsTarget: false, migration: 'all',
  },

  // ---------------------------------------------------------------- 凭据与防线
  [ACTION.secretUse]: {
    label: '用凭据',
    risk: RISK.high, irreversible: true, needsTarget: false, migration: 'never',
  },
  [ACTION.policyChange]: {
    // 改的是防线本身
    label: '改规矩',
    risk: RISK.high, irreversible: true, needsTarget: false, migration: 'never',
  },
  [ACTION.mcpAdd]: {
    label: '加 MCP',
    risk: RISK.critical, irreversible: true, needsTarget: false, migration: 'all',
  },
});

// ---------------------------------------------------------------------------
// 第二层：工具
// ---------------------------------------------------------------------------

/**
 * 工具的属性。
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `action` | 产生哪个动作；`null` = 不过网关（纯读/纯组织，自身没有副作用） |
 * | `readonly` | 只读政策（`dangerous=deny`）下放不放行 |
 * | `mutating` | ask 档要逐次批准（"会动手"那一批） |
 * | `coordination` | 负责人恒可用（组织类，不参与执行降权） |
 * | `chiefOnly` | 只给主 Bot |
 * | `target` | 目标认法 `{ kind, fields }`；`null` 或不写 = 认不出 |
 *
 * ★ 顺序即文档：先按动作分组，组内按职责。改这里之前先想清楚
 *   "这是工具属性还是动作属性" —— 写错层级会让同一动作下的两个工具打架。
 */
export const TOOL_SPECS = Object.freeze({
  // ---------------- 读（不过网关：纯读，没有副作用）
  read: { action: null, readonly: true, target: { kind: 'path', fields: ['path', 'file_path', 'filePath'] } },
  ls: { action: null, readonly: true },
  grep: { action: null, readonly: true },
  find: { action: null, readonly: true },
  extract_file: { action: null, readonly: true, target: { kind: 'path', fields: ['path', 'file_path'] } },

  // ---------------- file.write
  write: { action: ACTION.fileWrite, mutating: true, target: { kind: 'path', fields: ['path', 'file_path', 'filePath'] } },
  edit: { action: ACTION.fileWrite, mutating: true, target: { kind: 'path', fields: ['path', 'file_path', 'filePath'] } },
  // 站点草稿暂存：写的是内部草稿区，不算"用户文件"
  stage_site: { action: ACTION.fileWrite },

  // ---------------- file.delete
  discard_site: { action: ACTION.fileDelete },

  // ---------------- cmd.exec
  bash: { action: ACTION.cmdExec, mutating: true },
  powershell: { action: ACTION.cmdExec, mutating: true },

  // ---------------- cmd.background
  run_background: { action: ACTION.cmdBackground, mutating: true },
  write_stdin: { action: ACTION.cmdBackground, mutating: true },
  kill_shell: { action: ACTION.cmdBackground, mutating: true },

  // ---------------- git.read
  git_status: { action: ACTION.gitRead, readonly: true, coordination: true, target: { kind: 'path', fields: ['repo'] } },
  git_diff: { action: ACTION.gitRead, readonly: true, coordination: true, target: { kind: 'path', fields: ['repo'] } },
  git_log: { action: ACTION.gitRead, readonly: true, coordination: true, target: { kind: 'path', fields: ['repo'] } },
  git_show: { action: ACTION.gitRead, readonly: true, coordination: true, target: { kind: 'path', fields: ['repo'] } },
  git_branches: { action: ACTION.gitRead, readonly: true, coordination: true, target: { kind: 'path', fields: ['repo'] } },

  // ---------------- git.commit
  git_add: { action: ACTION.gitCommit, mutating: true, coordination: true, target: { kind: 'path', fields: ['repo'] } },
  git_commit: { action: ACTION.gitCommit, mutating: true, coordination: true, target: { kind: 'path', fields: ['repo'] } },

  // ---------------- git.push（动作本身只给主 Bot，见 ACTIONS 的 migration）
  git_push: { action: ACTION.gitPush, coordination: true, target: { kind: 'path', fields: ['repo'] } },

  // ---------------- git.destructive（G2/G3：合并 / 变基 / 重置 / 清理）
  //
  // ★ 一个工具覆盖四个操作，因为流程完全一样（算目标 → 手机确认 → 带票执行）。
  //   角色门（只给主 Bot 与负责人）在 git-ops 的 `roles` 与 git-tools 里，
  //   这里只声明"它产生哪个动作"。
  git_destructive: {
    action: ACTION.gitDestructive,
    mutating: true,
    coordination: true,
    target: { kind: 'path', fields: ['repo'] },
  },

  // ---------------- desktop.observe
  desktop_observe: { action: ACTION.desktopObserve, readonly: true, chiefOnly: true },
  desktop_screenshot: { action: ACTION.desktopObserve, readonly: true, chiefOnly: true },
  // ---------------- desktop.input
  // ★ 租约工具本身不过网关：它只排队，不碰用户的东西。真正危险的是
  //   `desktop_input`，它必须持着租约才动得了手，而"能不能发"的判定在
  //   `desktop-input-session.js` 里（租约 / epoch / 接管检测三道）。
  desktop_lease: { action: null, readonly: true, chiefOnly: true },
  // 输入动作不可撤销（点错了就是点了），迁移授权永不给（migration: 'never'），
  // 且只给主 Bot —— 三件事全部从 ACTIONS[desktop.input] 派生，这里不重复写。
  desktop_input: { action: ACTION.desktopInput, chiefOnly: true },

  // ---------------- 独立桌面（规格 §5.6 的 T1 档）
  //
  // 三个工具分开放，因为它们的风险不同档：
  //   · 看/截     —— 与 desktop_observe 同档（只读，但看得到整个应用）
  //   · 起应用   —— 就是"执行命令"，按 cmd.exec 算（比 cmd.exec 窄：只能起放行名单里的）
  //   · 点/打字   —— 不可撤销，风险从 ACTIONS[desktop.input] 派生
  //
  // ★ 三个都不走桌面租约：独立桌面的输入在 OS 层面就到不了用户的桌面（实测
  //   SendInput 被拒 err=5），不存在"抢用户鼠标"的互斥对象。同一个岛内的串行
  //   由 island server 自己的管道保证（见 desktop-island-win.js）。
  desktop_island_observe: { action: ACTION.desktopObserve, readonly: true, chiefOnly: true },
  desktop_island_launch: { action: ACTION.cmdExec, mutating: true, chiefOnly: true },
  desktop_island_input: { action: ACTION.desktopInput, chiefOnly: true },

  // ---------------- net.fetch
  // ★ 这三个必须分开标：
  //   ego_browser 会动手（点按钮、填表、提交），web_fetch/search 只读。
  //   把它们混成一个标志，只读档就会要么放行浏览器脚本、要么禁掉查资料。
  ego_browser: { action: ACTION.netFetch, mutating: true },
  web_fetch: { action: ACTION.netFetch, readonly: true, target: { kind: 'host', fields: ['url'] } },
  web_search: { action: ACTION.netFetch, readonly: true },

  // ---------------- net.send
  send_image: { action: ACTION.netSend, target: { kind: 'path', fields: ['path'] } },
  message_bot: { action: ACTION.netSend, readonly: true, coordination: true },
  reply_bot: { action: ACTION.netSend, readonly: true, coordination: true },
  announce: { action: ACTION.netSend },
  dispatch_to_department: { action: ACTION.netSend, readonly: true },
  commit_site: { action: ACTION.netSend },

  // ---------------- mcp.add
  add_mcp_server: { action: ACTION.mcpAdd },

  // ---------------- 组织与报告（不过网关：不碰文件/命令，也不对外发送）
  list_bots: { action: null, readonly: true, coordination: true },
  list_departments: { action: null, readonly: true, coordination: true },
  read_department: { action: null, readonly: true, coordination: true },
  list_sites: { action: null, readonly: true },
  query_site: { action: null, readonly: true, target: { kind: 'host', fields: ['site', 'name'] } },
  list_models: { action: null, readonly: true },
  list_skills: { action: null, readonly: true },
  list_department_templates: { action: null, readonly: true },
  list_local_capabilities: { action: null, readonly: true },
  read_shell: { action: null, readonly: true },
  ask_user: { action: null, readonly: true },
  assign_member_task: { action: null, readonly: true, coordination: true },
  task_report: { action: null, readonly: true, coordination: true },
  task_plan: { action: null, coordination: true },
  task_expert_review: { action: null, readonly: true, coordination: true },
});

// ---------------------------------------------------------------------------
// 派生（以下全部算出来，不允许手写第二份）
// ---------------------------------------------------------------------------

const toolEntries = Object.entries(TOOL_SPECS);

/** 工具 → 动作。**这张表就是网关的覆盖面**：不在表里的工具不过授权判定。 */
export const TOOLS = Object.freeze(
  Object.fromEntries(
    toolEntries.filter(([, s]) => s.action).map(([tool, s]) => [tool, s.action]),
  ),
);

/** 所有"有工具会产生它"的动作（去重、有序）。 */
export const GATED_ACTIONS = Object.freeze(
  [...new Set(Object.values(TOOLS))].sort(),
);

const toolsWhere = (pred) => toolEntries.filter(([, s]) => pred(s)).map(([t]) => t).sort();

/** 只读政策放行的工具。 */
export const READONLY_ALLOW = Object.freeze(toolsWhere((s) => s.readonly === true));

/** ask 档要逐次批准的工具。 */
export const MUTATING_TOOLS = Object.freeze(toolsWhere((s) => s.mutating === true));

/** 负责人恒可用的组织类工具。 */
export const COORDINATION_TOOLS = Object.freeze(toolsWhere((s) => s.coordination === true));

/** 只给主 Bot 的工具。 */
export const CHIEF_ONLY_TOOLS = Object.freeze(toolsWhere((s) => s.chiefOnly === true));

/** 只给主 Bot 的动作（迁移授权里要扣掉的那批）。与上面的工具级名单是两件事。 */
export const CHIEF_ONLY_ACTIONS = Object.freeze(
  Object.entries(ACTIONS).filter(([, a]) => a.migration === 'chief').map(([action]) => action).sort(),
);

/**
 * 负责人**总是**拿得到的只读内置工具。
 *
 * 这几个是"看一眼就知道在干什么"的基础能力（读文件、列目录、搜文本），
 * 不该因为环境变量里忘了写就失去。执行工具不在这份名单里 ——
 * 那些必须是用户明配置的。
 *
 * 它是独立的一组（不是"所有只读工具"）：`extract_file`、`web_fetch` 也只读，
 * 但负责人未必该无条件拿到，那个由 `PI_BOT_LEAD_TOOLS` 决定。
 */
export const LEAD_EXTRA_BUILTINS = Object.freeze(['read', 'ls', 'grep', 'find']);

/**
 * 执行**不透明脚本**的工具：内容是脚本，服务端无法静态核验里面跑了什么命令。
 *
 * 有命令白名单/黑名单时，这类工具必须关闭 —— 否则模型可以写一段脚本
 * 绕过所有命令规则（`await page.evaluate('...')` 里跑什么谁也不知道）。
 */
export const OPAQUE_SCRIPT_TOOLS = Object.freeze(['ego_browser']);

/**
 * 改「安全配置本身」的工具 —— **无条件**逐次审批。
 *
 * 和 `MUTATING_TOOLS` 的区别：那些（写文件、跑命令）只在 `dangerous=ask`
 * 档弹审批、`allow` 档放行，而且"本任务授权"能覆盖它 —— 那没问题，
 * 用户已经明确选了这个档位。
 *
 * 但改安全配置不是"做活"，是**改防线本身**：
 * 模型能自己 `add_mcp_server` 一个带任意 command 的本地服务，
 * 再 `update_bot` 把它挂到任意 bot，那之后这个 MCP 的工具就成了它的新执行入口。
 * 这条链上每一步都不该让模型自己走完 —— 不论 allow 还是 ask，
 * 也不论用户之前批准过多少次任务。
 *
 * ★ 表里有些工具现在还没实现（`set_policy` 等）。留着是**前瞻性声明**：
 *   实现它们的时候，安全审批自动就接上了，不需要再想起"要不要加进审批名单"。
 */
export const SECURITY_CONFIG_TOOLS = Object.freeze([
  // MCP 库 / 挂载
  'add_mcp_server', 'update_mcp_server', 'delete_mcp_server',
  'import_local_capabilities', 'import_local_mcp',
  // 策略与规矩
  'set_policy', 'set_department_policy', 'set_room_policy',
  // hook / 命令规则
  'add_hook', 'update_hook', 'delete_hook',
  'set_command_rules', 'set_deny_commands', 'set_allow_commands',
  // 凭据 / 授权
  'set_secret', 'delete_secret', 'set_mcp_credential',
]);

/**
 * 迁移授权里**故意不给**的动作（不是漏了，是扣着）。
 *
 * 有两个现在没有工具产生它们（`desktop.input`、`git.destructive`）——
 * 它们在这里的意义是"以后接上也不能从迁移授权继承"，是**前瞻性声明**。
 */
export const MIGRATION_WITHHELD = Object.freeze(
  Object.entries(ACTIONS).filter(([, a]) => a.migration === 'never').map(([action]) => action).sort(),
);

// ---------------------------------------------------------------------------
// 查询（纯函数）
// ---------------------------------------------------------------------------

/** 这个动作的目录条目；没登记过返回 null。 */
export function actionInfo(action) {
  const a = ACTIONS[String(action ?? '')];
  return a ? { action: String(action), ...a } : null;
}

/** 危险度。没登记按 medium。 */
export function riskOf(action) {
  return ACTIONS[String(action ?? '')]?.risk ?? RISK.medium;
}

/** 能不能撤销。没登记按"不可撤销"算 —— 保守方向。 */
export function isIrreversible(action) {
  const a = ACTIONS[String(action ?? '')];
  return a ? a.irreversible === true : true;
}

/** 窄范围授权要不要先认出目标。没登记按"要"算 —— 保守方向。 */
export function needsTarget(action) {
  const a = ACTIONS[String(action ?? '')];
  return a ? a.needsTarget === true : true;
}

/** 迁移授权给谁能拿：`all` 全给，`chief` 只给主 Bot，`never` 不给。 */
export function migrationScopeOf(action) {
  return ACTIONS[String(action ?? '')]?.migration ?? 'never';
}

/** 工具 → 动作。没登记的工具返回 null（= 网关不判）。 */
export function actionForTool(toolName) {
  const action = TOOLS[String(toolName ?? '')];
  return action ? { action, risk: riskOf(action) } : null;
}

/** 一批工具会产生哪些动作（去重、保序）。 */
export function actionsForTools(toolNames = []) {
  const out = [];
  for (const tool of toolNames) {
    const action = TOOLS[String(tool ?? '')];
    if (action && !out.includes(action)) out.push(action);
  }
  return out;
}

/**
 * 从工具入参里认出目标资源。
 *
 * **只认确定能认的**：读字段名，不解析命令字符串、不解析脚本内容。
 * 认不出来就返回空数组 —— "认不出来时该放行还是拒绝"由调用方按
 * `needsTarget()` 决定（网关对窄范围授权是拒绝）。
 *
 * @returns {Array<{kind:string, ref:string}>}
 */
export function targetsForTool(toolName, input = {}) {
  const rule = TOOL_SPECS[String(toolName ?? '')]?.target;
  if (!rule) return [];
  let raw = '';
  for (const f of rule.fields) {
    const v = input?.[f];
    if (typeof v === 'string' && v.trim()) { raw = v.trim(); break; }
  }
  if (!raw) return [];
  if (rule.kind === 'host') {
    try {
      return [{ kind: 'host', ref: new URL(raw).hostname }];
    } catch {
      // 不是完整 URL：可能是站点名（query_site 的入参就是这样），原样当主机名
      return [{ kind: 'host', ref: raw }];
    }
  }
  return [{ kind: rule.kind, ref: raw }];
}

// ---------------------------------------------------------------------------
// 迁移授权
// ---------------------------------------------------------------------------

/**
 * 迁移授权该覆盖哪些动作 —— 「网关上线之前，政策已经允许的全部动作」。
 *
 * 这是本项目里唯一允许"推导而不是手写"的授权范围，因为它是**兼容层**：
 * 目的不是新增权限，而是让网关上线不改变现有行为（规格 §11「隔离旧规则与
 * 新策略版本」）。手写清单实测漏过三次（`desktop.observe`、`git.push`、
 * `mcp.add`），每次都是"工具在、网关却没发授权"这种静默故障。
 *
 * 放宽方向靠什么拦：真正危险的动作仍然要过各自的二次门 ——
 * MCP 与改防线走 `SECURITY_CONFIG_TOOLS` 逐次审批，push 走手机确认。
 * 迁移授权只回答"有没有资格走这条路"，不回答"这一步要不要人点"。
 *
 * @param {object} p
 * @param {boolean} [p.readonly] 当前是不是只读模式
 * @param {boolean} [p.chief] 是不是主 Bot
 * @returns {string[]}
 */
export function deriveMigrationActions({ readonly = false, chief = false } = {}) {
  const base = readonly
    // 只读档：只发"只读放行名单里的工具"覆盖到的动作 + 读文件
    ? [ACTION.fileRead, ...actionsForTools(READONLY_ALLOW)]
    : [ACTION.fileRead, ...GATED_ACTIONS];
  return [...new Set(base.filter((action) => {
    const scope = migrationScopeOf(action);
    if (scope === 'never') return false;
    if (scope === 'chief' && !chief) return false;
    return true;
  }))];
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 清单自检：找"声明与实际对不上"的地方。
 *
 * 只查**确定是错**的东西：
 *   · 工具指向未登记的动作
 *   · 一个动作既想 `migration:'never'` 又在只读放行里（自相矛盾）
 *   · `critical` 却标了可撤销（档位与可撤销性打架）
 *   · 需要目标的动作，其工具连一个认法都没有，且该动作已经有工具
 *     （那是"窄范围授权对它必然失效"的静默 bug）
 *   · 工具真的在 `tools.js` 里存在吗（传了 `hasTool` 才查）
 *
 * "动作需要目标、但工具的目标埋在字符串里认不出"（`bash`）**不算错**：
 * 那是已知限制，网关对窄范围授权会 fail-closed 拒掉，这正是设计意图。
 *
 * @param {object} [opts]
 * @param {(name:string)=>boolean} [opts.hasTool] 工具是否真的在 tools.js 里定义
 * @returns {string[]} 人话描述的问题，空 = 干净
 */
export function auditCapabilities({ hasTool = null } = {}) {
  const problems = [];

  for (const [tool, spec] of Object.entries(TOOL_SPECS)) {
    if (spec.action && !ACTIONS[spec.action]) {
      problems.push(`工具 ${tool} 指向未登记的动作 ${spec.action}`);
    }
    if (typeof hasTool === 'function' && !hasTool(tool)) {
      problems.push(`工具 ${tool} 在 tools.js 里找不到 defineTool`);
    }
  }

  for (const [action, a] of Object.entries(ACTIONS)) {
    if (a.risk === RISK.critical && a.irreversible === false) {
      problems.push(`${action} 标了 critical 却又是可撤销的 —— 档位与可撤销性打架`);
    }
    const tools = toolEntries.filter(([, s]) => s.action === action).map(([t]) => t);
    if (tools.length && a.needsTarget && tools.every((t) => !TOOL_SPECS[t].target)) {
      // bash / ego_browser 属于这一类且是**故意**的（认不出就 fail-closed）。
      // 只有当我们声明了 needsTarget 却又"以为能认"时才是问题 —— 所以这里不报。
      // 保留这条注释是为了让后来者知道：这不是漏了。
    }
    if (a.migration === 'never' && tools.some((t) => TOOL_SPECS[t].readonly)) {
      problems.push(`${action} 迁移档不给，但它的工具在只读放行名单里 —— 自相矛盾`);
    }
  }

  return problems;
}

/** 诊断/快照用：把当前派生结果原样吐出来（改造前后逐字段比对）。 */
export function snapshotEvidence() {
  return {
    ACTIONS: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, {
      risk: v.risk, irreversible: v.irreversible, needsTarget: v.needsTarget, label: v.label,
    }])),
    TOOLS,
    GATED_ACTIONS,
    READONLY_ALLOW,
    MUTATING_TOOLS,
    COORDINATION_TOOLS,
    CHIEF_ONLY_TOOLS,
    CHIEF_ONLY_ACTIONS,
    MIGRATION_WITHHELD,
    migrationActions: {
      allowChief: deriveMigrationActions({ readonly: false, chief: true }),
      allowWorker: deriveMigrationActions({ readonly: false, chief: false }),
      denyChief: deriveMigrationActions({ readonly: true, chief: true }),
      denyWorker: deriveMigrationActions({ readonly: true, chief: false }),
    },
  };
}
