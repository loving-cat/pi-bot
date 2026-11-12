/** 角色能力判定、工具白名单与会话配置签名，不读取持久化状态。 */

/**
 * 只读模式（policy.dangerous === 'deny'）唯一的放行名单。
 * 不在这里的调用一律拒绝：改文件、跑命令、改配置、后台进程、MCP 与扩展工具。
 */
export const READONLY_ALLOW = [
  'read', 'ls', 'grep', 'find',
  'extract_file', 'web_search', 'web_fetch', 'read_shell',
  'list_bots', 'list_departments', 'read_department', 'message_bot', 'reply_bot',
  'list_sites', 'query_site',
  'list_models', 'list_skills', 'list_department_templates', 'list_local_capabilities',
  'ask_user', 'dispatch_to_department', 'assign_member_task',
  // 受管阶段报告：只登记模型声明，不碰文件/命令，只读模式也可用
  'task_report', 'task_expert_review',
];
const READONLY_ALLOW_SET = new Set(READONLY_ALLOW);

/** 需要点批准的「会动手」工具（ask）。只读模式不看这份名单。 */
export const MUTATING_TOOLS = [
  'write', 'edit', 'bash', 'powershell',
  'run_background', 'write_stdin', 'kill_shell',
  'ego_browser',
];

/**
 * 改「安全配置本身」的工具：加 MCP 服务、把 MCP 挂到 bot、改策略、
 * 改 hook / 白名单 / 凭据。
 *
 * ★ 和 MUTATING_TOOLS 的区别 —— 这份名单是**无条件**审批：
 *
 *   MUTATING_TOOLS（写文件、跑命令）只在 dangerous=ask 档弹审批，
 *   allow 档放行；而且"本任务授权"（scope=task 的 grant 窗口）能覆盖它。
 *   这没问题：用户已经明确选了这个档位。
 *
 *   但改安全配置不是"做活"，是**改防线本身**：
 *     · 模型能自行 add_mcp_server 一个带任意 command 的本地服务；
 *     · 再 update_bot 把它挂到任意 bot；
 *     · 那之后这个 MCP 的工具就成了它的新执行入口。
 *   这条链上每一步都不该让模型自己走完 —— 不论 allow 还是 ask，
 *   也不论用户之前批准过多少次任务。必须逐次由用户点批准。
 */
export const SECURITY_CONFIG_TOOLS = [
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
];
const SECURITY_CONFIG_SET = new Set(SECURITY_CONFIG_TOOLS);

/**
 * 这次调用的工具是否改安全配置。
 *
 * update_bot 是特例：它平时只是改名字/模型，属于普通操作；
 * 但一旦带 mcpServers 字段，就是在改"这个 bot 能用哪些外部能力"，
 * 必须按安全配置处理。所以要看入参，不能只看工具名。
 */
export function isSecurityConfigCall(tool, input = null) {
  if (SECURITY_CONFIG_SET.has(tool)) return true;
  if (tool === 'update_bot') {
    return Boolean(input && typeof input === 'object' && input.mcpServers !== undefined);
  }
  return false;
}

/** 不透明脚本无法静态核验内部命令，存在命令限制时不开放此执行入口。 */
export function opaqueScriptBlockReason(policy, tool) {
  if (tool !== 'ego_browser') return null;
  return policy?.denyCommands?.length || policy?.allowCommands?.length
    ? '当前命令规则不允许执行无法逐条核验的浏览器脚本。'
    : null;
}

const READ_ONLY_BUILTINS = new Set(['read', 'ls', 'grep', 'find']);
const COORDINATION_TOOLS = new Set([
  'list_bots', 'list_departments', 'read_department', 'message_bot', 'reply_bot',
  'task_report', 'task_plan', 'assign_member_task', 'task_expert_review',
]);

export function isReadonlyPolicy(policy) {
  return policy?.dangerous === 'deny';
}

export function readonlyToolAllowed(name) {
  return READONLY_ALLOW_SET.has(name);
}

/** 只读模式下的拒绝原因；不是只读或工具在放行名单里时返回 null。 */
export function readonlyBlockReason(policy, tool) {
  if (!isReadonlyPolicy(policy) || readonlyToolAllowed(tool)) return null;
  return '当前是只读模式，不能改文件、跑命令或改配置。';
}

/** 群聊有真实 leadBotId 且 bot 就是该负责人；验收能力不要求可派工成员数。 */
export function isRoomLead(room, botId) {
  return room?.kind === 'group' && Boolean(room.leadBotId) && room.leadBotId === botId;
}

export function isLeadOfRoom(room, botId) {
  if (room?.kind !== 'group') return false;
  const members = [...new Set((room.botIds ?? []).filter(Boolean))];
  if (members.length < 2) return false;
  const leadId = members.includes(room.leadBotId) ? room.leadBotId : members[0];
  return leadId === botId;
}

/** 主控保留自己的能力配置；普通 bot 在多人部门担任负责人时限制执行。 */
export function isDelegatingLead(room, bot) {
  return bot?.role !== 'main' && isLeadOfRoom(room, bot?.id);
}

/** deny 时只留放行名单里的工具；其他策略保留配置。 */
export function toolsForPolicy(baseTools = [], policy = {}) {
  return isReadonlyPolicy(policy)
    ? baseTools.filter((name) => readonlyToolAllowed(name))
    : [...baseTools];
}

/** 负责人仅可使用配置内的只读内置工具，以及固定的组织查询和派活工具。 */
export function leadToolAllowed(name, leadTools = []) {
  return COORDINATION_TOOLS.has(name) ||
    (READ_ONLY_BUILTINS.has(name) && leadTools.includes(name));
}

/** 按角色选择内置工具，再应用统一行为策略。 */
export function toolsForRole({
  isChief = false, isDeptLead = false,
  chiefTools = [], leadTools = [], memberTools = [], policy = {},
} = {}) {
  const raw = isChief ? chiefTools : isDeptLead
    ? leadTools.filter((name) => READ_ONLY_BUILTINS.has(name)) : memberTools;
  return toolsForPolicy(raw, policy);
}

/** 负责人先按角色过滤；只读模式再按同一份放行名单收掉写工具。 */
export function customToolsForRole(tools, { room, bot, leadTools = [], policy = {} } = {}) {
  const list = isDelegatingLead(room, bot)
    ? tools.filter((tool) => leadToolAllowed(tool.name, leadTools)) : [...tools];
  return isReadonlyPolicy(policy)
    ? list.filter((tool) => readonlyToolAllowed(tool.name)) : list;
}

/**
 * 工具集/提示词的版本号。
 *
 * ★ 每次**改动 bot 能用的工具或群提示词**就要 +1。
 *
 *   为什么：会话按 roomId:botId 缓存复用，靠 roleConfigurationKey 判断要不要重建。
 *   原来这个 key 只看「房间角色 + 成员」，升级代码后老会话的 key 没变 ——
 *   于是继续复用旧会话，**新加的工具、改过的提示词全部不生效**。
 *   用户看到的就是「更新了但没变化」，而且没有任何报错。
 *
 *   +1 会让所有老会话在下次使用时重建一次（丢的只是进程内的会话缓存，
 *   聊天记录都在库里，不受影响）。
 */
export const SESSION_TOOLS_VERSION = 2;

/** 房间角色、成员或工具集版本变化时签名变化，用于重建缓存会话。 */
export function roleConfigurationKey(room, bot) {
  const members = [...new Set((room?.botIds ?? []).filter(Boolean))];
  const leadId = members.includes(room?.leadBotId) ? room.leadBotId : members[0] ?? null;
  return JSON.stringify([
    bot?.role ?? '', room?.kind ?? '', leadId, members.sort(),
    // 工具集版本：改了工具/提示词就 bump，让老会话重建一次
    SESSION_TOOLS_VERSION,
  ]);
}
