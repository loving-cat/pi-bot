/** 角色能力判定、工具白名单与会话配置签名，不读取持久化状态。 */

/**
 * 只读模式（policy.dangerous === 'deny'）唯一的放行名单。
 * 不在这里的调用一律拒绝：改文件、跑命令、改配置、后台进程、MCP 与扩展工具。
 */
export const READONLY_ALLOW = [
  'read', 'ls', 'grep', 'find',
  'extract_file', 'web_search', 'web_fetch', 'read_shell',
  'list_bots', 'list_departments', 'read_department', 'message_bot',
  'list_sites', 'query_site',
  'list_models', 'list_skills', 'list_department_templates', 'list_local_capabilities',
  'ask_user', 'dispatch_to_department',
];
const READONLY_ALLOW_SET = new Set(READONLY_ALLOW);

/** 需要点批准的「会动手」工具（ask）。只读模式不看这份名单。 */
export const MUTATING_TOOLS = [
  'write', 'edit', 'bash', 'powershell',
  'run_background', 'write_stdin', 'kill_shell',
];

const READ_ONLY_BUILTINS = new Set(['read', 'ls', 'grep', 'find']);
const COORDINATION_TOOLS = new Set([
  'list_bots', 'list_departments', 'read_department', 'message_bot',
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

/** 群聊有至少两个不同成员，且 bot 是有效负责人时返回 true。 */
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

/** 房间角色和成员配置变化时签名变化，用于重建缓存会话。 */
export function roleConfigurationKey(room, bot) {
  const members = [...new Set((room?.botIds ?? []).filter(Boolean))];
  const leadId = members.includes(room?.leadBotId) ? room.leadBotId : members[0] ?? null;
  return JSON.stringify([
    bot?.role ?? '', room?.kind ?? '', leadId, members.sort(),
  ]);
}
