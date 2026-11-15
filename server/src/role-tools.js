/** 角色能力判定、工具白名单与会话配置签名，不读取持久化状态。 */

/**
 * 本文件的所有工具名单都是 **派生**，事实来源在 `capabilities.js`。
 *
 * 改造前这里有四份手写清单（只读放行 / 会动手 / 组织类 / 主 Bot 专属），
 * 加上 action-catalog 的三份、migration-grants 的两份，一个能力要在 7 处登记。
 * 漏一处不会报错，只会静默出错 —— 这一周实测踩到 4 次。
 *
 * 现在这里只做转发和判定逻辑。**加工具请去 `capabilities.js` 的 TOOL_SPECS**。
 */
import {
  READONLY_ALLOW, MUTATING_TOOLS, COORDINATION_TOOLS, CHIEF_ONLY_TOOLS,
  LEAD_EXTRA_BUILTINS, OPAQUE_SCRIPT_TOOLS, SECURITY_CONFIG_TOOLS,
} from './capabilities.js';

export {
  READONLY_ALLOW, MUTATING_TOOLS, COORDINATION_TOOLS, CHIEF_ONLY_TOOLS,
  LEAD_EXTRA_BUILTINS, OPAQUE_SCRIPT_TOOLS, SECURITY_CONFIG_TOOLS,
};

const READONLY_ALLOW_SET = new Set(READONLY_ALLOW);
const COORDINATION_SET = new Set(COORDINATION_TOOLS);
const CHIEF_ONLY_SET = new Set(CHIEF_ONLY_TOOLS);

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

/**
 * 不透明脚本无法静态核验内部命令，存在命令限制时不开放此执行入口。
 *
 * ★ 工具名从能力清单读（`OPAQUE_SCRIPT_TOOLS`），不在这里写死 ——
 *   否则以后再加一个"跑脚本"的工具，这条规则就悄悄漏了。
 */
export function opaqueScriptBlockReason(policy, tool) {
  if (!OPAQUE_SCRIPT_TOOLS.includes(tool)) return null;
  return policy?.denyCommands?.length || policy?.allowCommands?.length
    ? '当前命令规则不允许执行无法逐条核验的浏览器脚本。'
    : null;
}


const LEAD_EXTRA_SET = new Set(LEAD_EXTRA_BUILTINS);

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

/**
 * 这个 bot 在多人部门里当负责人吗。
 *
 * ★ 它现在只影响**提示词和行为习惯**（先派后干、汇报要写清谁做了什么），
 *   不再限制“能不能执行”。原来叫 `isDelegatingLead`，含义是“这个负责人
 *   只派活不干活”，于是 policy-hook 拿它当第二道门把执行工具全拦了。
 *   实测后果：用户对负责人说“你直接改吧”，它也只能再派人。
 */
export function isDelegatingLead(room, bot) {
  return bot?.role !== 'main' && isLeadOfRoom(room, bot?.id);
}

/** deny 时只留放行名单里的工具；其他策略保留配置。 */
export function toolsForPolicy(baseTools = [], policy = {}) {
  return isReadonlyPolicy(policy)
    ? baseTools.filter((name) => readonlyToolAllowed(name))
    : [...baseTools];
}

/**
 * 负责人能不能用这个工具。
 *
 * ★ 现在**不再只放行只读** —— 负责人和成员一样能动手。
 *
 *   原来的实现是 `COORDINATION_TOOLS.has(name) || 只读集合.has(name) && 配置里有`：
 *   哪怕你把 `bash` 写进 `PI_BOT_LEAD_TOOLS`，也会被这个函数过滤掉 ——
 *   配置形同虚设，而且没有任何提示说明为什么改了不生效。
 *
 *   现在：配置里有什么就给什么（属于“负责人额外通道”的组织工具恒放行）。
 *   “先派后干”是**提示词层面的行为规则**，不靠断能力来实现。
 *   真要禁，把工具从 `PI_BOT_LEAD_TOOLS` / `PI_BOT_TOOLS` 里拿掉就行，
 *   那是配置该干的事，不是代码里静默覆盖。
 */
export function leadToolAllowed(name, leadTools = []) {
  if (COORDINATION_SET.has(name)) return true;
  // 负责人自己的通道：配置里列了就给（含执行工具）
  if (leadTools.includes(name)) return true;
  // 配置里没列，但它是内置只读工具（默认就有，不依赖配置）
  return LEAD_EXTRA_SET.has(name);
}

/** 按角色选择内置工具，再应用统一行为策略。 */
export function toolsForRole({
  isChief = false, isDeptLead = false,
  chiefTools = [], leadTools = [], memberTools = [], policy = {},
} = {}) {
  // ★ 负责人不再被剃成只读：它有自己的配置，没有回退成员配置。
  const raw = isChief ? chiefTools : isDeptLead ? leadTools : memberTools;
  return toolsForPolicy(raw, policy);
}

/** 负责人先按角色过滤；只读模式再按同一份放行名单收掉写工具。 */

export function customToolsForRole(tools, { room, bot, policy = {} } = {}) {
  // ★ 负责人不再额外收窄自定义工具。
  //
  //   原来这里对“多人部门的负责人”再过滤一遍 leadToolAllowed，而那份名单
  //   只有只读 + 组织类 —— 于是即便用户把 run_background 加进
  //   PI_BOT_LEAD_TOOLS，负责人也永远拿不到。能力边界现在只由两处决定：
  //   工具集本身（按配置/角色算出来的那一份）和只读策略。
  const chief = bot?.role === 'main';
  const list = tools.filter((tool) => chief || !CHIEF_ONLY_SET.has(tool.name));
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
export const SESSION_TOOLS_VERSION = 3;

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
