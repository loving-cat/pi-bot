/** 角色能力判定、工具白名单与会话配置签名，不读取持久化状态。 */
export const MUTATING_TOOLS = ['write', 'edit', 'bash', 'powershell'];
const READ_ONLY_BUILTINS = new Set(['read', 'ls', 'grep', 'find']);
const COORDINATION_TOOLS = new Set([
  'list_bots', 'list_departments', 'read_department', 'message_bot',
]);

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

/** deny 策略过滤内置写入及命令工具；其他策略保留配置。 */
export function toolsForPolicy(baseTools = [], policy = {}) {
  return policy?.dangerous === 'deny'
    ? baseTools.filter((name) => !MUTATING_TOOLS.includes(name))
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

/** 只有多人部门负责人过滤自定义工具；其他角色使用原工具集。 */
export function customToolsForRole(tools, { room, bot, leadTools = [] }) {
  return isDelegatingLead(room, bot)
    ? tools.filter((tool) => leadToolAllowed(tool.name, leadTools)) : [...tools];
}

/** 房间角色和成员配置变化时签名变化，用于重建缓存会话。 */
export function roleConfigurationKey(room, bot) {
  const members = [...new Set((room?.botIds ?? []).filter(Boolean))];
  const leadId = members.includes(room?.leadBotId) ? room.leadBotId : members[0] ?? null;
  return JSON.stringify([
    bot?.role ?? '', room?.kind ?? '', leadId, members.sort(),
  ]);
}
