/**
 * MCP 工具名注册表：记住每个 server **最近一次 tools/list 的结果**。
 *
 * ## 用途
 *
 * 网关（mcp-hook 的 tool_call）要在**转发之前**判断"这个工具名是不是真的存在"。
 * 不存在就直接拒绝 —— 请求根本不能到达 MCP 子进程。
 *
 * ## 为什么不能按时间过期
 *
 * 早先的实现有 10 分钟 TTL，过期就返回"未知"→ 放行。问题是长会话里
 * 这个检查等于没有：跑过 10 分钟之后网关就再也不拦了，模型幻觉出的工具名
 * 照样能打到子进程。所以现在**不看时间**，只在两种情况下作废：
 *
 *   1. 这个 server 的 configurationRevision 变了（配置改过，旧清单不可信）；
 *   2. 主动重新 probe（拿到新清单就覆盖）。
 *
 * ## "未知"时怎么办
 *
 * 不放过 —— 由调用方（mcp-hook）**同步重新拉一次** tools/list：
 *   · 拉到了 → 用新清单判断，可能放行也可能拒绝
 *   · 拉不到 → 拒绝这次调用，提示用户重新验证连接
 *
 * 也就是说：**没有可信清单 = 不允许调用**。宁可让用户点一下"验证"，
 * 也不让一个来路不明的工具名打到子进程。
 */

/** 工具名注册表：server 名(小写) → { revision, at, tools: Set } */
const registry = new Map();

/**
 * 记录某个 server 的工具列表（覆盖旧值）。
 *
 * @param {string} serverName
 * @param {string[]} toolNames
 * @param {string} [revision] server 的 configurationRevision
 */
export function rememberTools(serverName, toolNames, revision = '') {
  const key = String(serverName ?? '').trim().toLowerCase();
  if (!key) return;
  const tools = new Set(
    (Array.isArray(toolNames) ? toolNames : [])
      .map((t) => String(t ?? '').trim())
      .filter(Boolean),
  );
  registry.set(key, { revision: String(revision ?? ''), at: Date.now(), tools });
}

/**
 * 这个 server 有没有**可信的**工具清单。
 *
 * 不看时间 —— 只看有没有、以及 revision 对不对得上。
 *
 * @returns {{state:'known', tools:Set}|{state:'unknown', why:string}}
 */
export function toolListState(serverName, revision = '') {
  const key = String(serverName ?? '').trim().toLowerCase();
  const entry = registry.get(key);
  if (!entry) return { state: 'unknown', why: 'missing' };
  const want = String(revision ?? '');
  const have = String(entry.revision ?? '');
  // 调用方知道 revision、缓存里也有，且不一致 → 配置改过，旧清单作废
  if (want && have && want !== have) return { state: 'unknown', why: 'revision_changed' };
  return { state: 'known', tools: entry.tools };
}

/**
 * 工具名在不在那份清单里。
 *
 * @returns {true|false|null} null 表示"没有可信清单"，调用方应重新拉取
 */
export function isListedTool(serverName, toolName, revision = '') {
  const state = toolListState(serverName, revision);
  if (state.state === 'unknown') return null;
  return Boolean(state.tools?.has(String(toolName ?? '')));
}

/** 清空（测试用；会话全关时也可释放内存）。 */
export function clearToolRegistry() {
  registry.clear();
}

/** 当前缓存的 server 数（诊断用）。 */
export function toolRegistrySize() {
  return registry.size;
}

/** 某个 server 缓存的清单大小（诊断用）；没有清单时返回 -1。 */
export function toolCountOf(serverName) {
  const key = String(serverName ?? '').trim().toLowerCase();
  const entry = registry.get(key);
  return entry ? entry.tools.size : -1;
}
