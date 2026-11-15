/**
 * HTTP 侧「管理动作」的判定表（纯逻辑，无 IO）。
 *
 * ## 为什么 HTTP 也要过一道
 *
 * 规格 §11 P0 第一条：「梳理所有文件、命令、Git、GUI、网络与凭据入口，
 * 入口逐次强制核对当前有效授权」。
 *
 * 盘点（docs/PERMISSIONS-INVENTORY.md）发现模型工具那条线已经过网关，
 * 而 **55 条 HTTP 路由只做了身份鉴权、没有任何授权判定**。其中有一批
 * 能改防线本身（策略、hooks、MCP 库）或者删用户数据（附件）。
 *
 * ## 这里的语义和工具层不同 —— 别搞混
 *
 * 工具层的主体是 **Bot**，网关回答"这个 bot 有没有资格做这次动作"。
 * HTTP 层的主体是**用户**（桌面端/手机 App）。用户当然可以改自己的策略，
 * 所以这里**不是**"拦住用户"，而是两件别的事：
 *
 *   1. **防冒充**：同用户的其它进程能读到 local-token，
 *      拿它直接调 `PATCH /api/policy` 就把防线改了。一次性 nonce 堵这条路
 *      （见 local-nonce.js 的说明与它的局限）。
 *   2. **审计**：规格 §5.5 要求动作可审计。用户改了什么、什么时候改的，
 *      要能在界面里查到。
 *
 * ## 分级
 *
 * | 级别 | 含义 | 处理 |
 * |---|---|---|
 * | `defense` | 改的是防线本身（策略/hooks/MCP 库） | 要 nonce + 审计 |
 * | `data` | 会删/改用户数据 | 要 nonce + 审计 |
 * | `probe` | 只起子进程或发外部请求，不改状态 | 只审计 |
 * | `read` | 只读 | 不管 |
 *
 * 分级的依据是"做错了能不能撤销"：改策略能改回来但期间已经放行了动作；
 * 删附件改不回来。只读的不花成本去管。
 */

/** 网关动作名（与 grants.js 的 ACTION 对齐，便于统一记账）。 */
export const ADMIN_ROUTE_TABLE = Object.freeze([
  // ---- defense：改防线本身 ----
  { method: 'PATCH', path: '/api/policy', level: 'defense', action: 'policy.change', nonce: 'policy', label: '改部门规矩' },
  { method: 'PUT', path: '/api/hooks', level: 'defense', action: 'policy.change', nonce: 'hooks', label: '改工具钩子' },
  { method: 'POST', path: '/api/mcp', level: 'defense', action: 'mcp.add', nonce: 'mcp', label: '新增 MCP 服务' },
  { method: 'PATCH', path: '/api/mcp/:id', level: 'defense', action: 'mcp.add', nonce: 'mcp', label: '改 MCP 服务' },
  { method: 'DELETE', path: '/api/mcp/:id', level: 'defense', action: 'mcp.add', nonce: 'mcp', label: '删 MCP 服务' },
  // 从本机 pi 配置导入 MCP = 一次加进多个可执行子进程
  { method: 'POST', path: '/api/local-capabilities/import', level: 'defense', action: 'mcp.add', nonce: 'import', label: '导入本机 MCP/技能' },
  // 改 bot 挂哪些 MCP：等价于改"这个 bot 能用哪些外部能力"
  { method: 'PATCH', path: '/api/bots/:id', level: 'defense', action: 'policy.change', nonce: 'policy', label: '改 bot 配置（含能力）', onlyWithMcp: true },
  // 模型组里存 baseUrl + key：改了等于把请求发到别的地方
  { method: 'POST', path: '/api/model-groups', level: 'defense', action: 'secret.use', nonce: 'policy', label: '改模型组' },
  { method: 'PATCH', path: '/api/model-groups/:id', level: 'defense', action: 'secret.use', nonce: 'policy', label: '改模型组' },
  { method: 'PATCH', path: '/api/decision', level: 'defense', action: 'policy.change', nonce: 'policy', label: '改决策路由配置' },
  { method: 'PUT', path: '/api/decision', level: 'defense', action: 'policy.change', nonce: 'policy', label: '改决策路由配置' },

  // ---- data：删/改用户数据 ----
  { method: 'POST', path: '/api/files/delete', level: 'data', action: 'file.delete', nonce: 'files', label: '批量删附件' },
  { method: 'DELETE', path: '/api/files/:id', level: 'data', action: 'file.delete', nonce: 'files', label: '删附件' },
  { method: 'DELETE', path: '/api/bots/:id', level: 'data', action: 'file.delete', nonce: 'policy', label: '删 bot' },
  { method: 'DELETE', path: '/api/rooms/:id', level: 'data', action: 'file.delete', nonce: 'policy', label: '删会话/部门' },
  // ★ 撤销设备**不要** nonce：它是"降低权限"的动作。
  //
  //   冒充者帮你撤销一台设备，损失的只有你自己（用不了），他不会因此多拿到什么。
  //   反过来要求 nonce 会让"在手机上把另一台设备踢下线"这条路变复杂，
  //   而那恰恰是用户在发现异常时最想立刻做的事 ——
  //   安全动作不该被防冒充的门槛挡住。
  //   仍然记审计（谁在什么时候撤销了哪台），这个有价值。
  { method: 'DELETE', path: '/api/devices/:id', level: 'probe', action: 'policy.change', nonce: null, label: '撤销设备' },
  // 技能库是给所有 bot 注入的提示词：能改它等于能改所有 bot 的做法
  { method: 'POST', path: '/api/skills', level: 'data', action: 'policy.change', nonce: 'policy', label: '加技能' },
  { method: 'POST', path: '/api/skills/import', level: 'data', action: 'policy.change', nonce: 'policy', label: '导入技能' },
  { method: 'DELETE', path: '/api/skills/:id', level: 'data', action: 'policy.change', nonce: 'policy', label: '删技能' },

  // ---- probe：起子进程/发外部请求，但不改状态 ----
  { method: 'POST', path: '/api/mcp/test', level: 'probe', action: 'mcp.add', nonce: null, label: '试连 MCP' },
  { method: 'POST', path: '/api/sites/probe', level: 'probe', action: 'net.fetch', nonce: null, label: '探测站点' },
  { method: 'POST', path: '/api/model-groups/test', level: 'probe', action: 'net.fetch', nonce: null, label: '试连模型组' },
  { method: 'POST', path: '/api/decision/probe', level: 'probe', action: 'net.fetch', nonce: null, label: '探测决策模型' },
]);

/**
 * 把 `/api/mcp/abc123` 这类具体路径套到表里的模式（`/api/mcp/:id`）。
 *
 * 只匹配**单段**占位符：多段路径不该被一个 `:id` 吃掉。
 */
function matchPattern(pattern, pathname) {
  if (pattern === pathname) return true;
  if (!pattern.includes(':')) return false;
  const p = pattern.split('/');
  const q = pathname.split('/');
  if (p.length !== q.length) return false;
  for (let i = 0; i < p.length; i += 1) {
    if (p[i].startsWith(':')) {
      if (!q[i]) return false;
      continue;
    }
    if (p[i] !== q[i]) return false;
  }
  return true;
}

/**
 * 这条 HTTP 请求要不要过管理门。
 *
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.pathname
 * @param {object|null} [p.body] 用于 `onlyWithMcp` 这类按入参判断的规则
 * @returns {{level:string, action:string, nonce:string|null, label:string, pattern:string}|null}
 */
export function planAdminRoute({ method, pathname, body = null } = {}) {
  const m = String(method ?? '').toUpperCase();
  for (const rule of ADMIN_ROUTE_TABLE) {
    if (rule.method !== m) continue;
    if (!matchPattern(rule.path, String(pathname ?? ''))) continue;
    // ★ 按入参细分的规则：改 bot 的名字/模型属于普通操作，
    //   只有带 mcpServers 时才是在改"这个 bot 能用哪些外部能力"。
    if (rule.onlyWithMcp) {
      if (!body || typeof body !== 'object' || body.mcpServers === undefined) continue;
    }
    return {
      level: rule.level,
      action: rule.action,
      nonce: rule.nonce ?? null,
      label: rule.label,
      pattern: rule.path,
    };
  }
  return null;
}

/** 表里覆盖了哪些 (method, pattern)，诊断/测试用。 */
export function listAdminRoutes() {
  return ADMIN_ROUTE_TABLE.map((r) => `${r.method} ${r.path}  [${r.level}]`);
}

/**
 * 只读接口：把授权/确认/审计摊给界面看（规格 §11「用户始终可以接管、取消、收回授权」）。
 *
 * 这三个是 GET —— 不改变任何状态，所以不过 nonce、不写管理审计
 * （否则光是打开设置页就会刷出一串"改了什么"的记录，那些记录本来就没发生）。
 */
export const ADMIN_VIEW_ROUTES = Object.freeze([
  '/api/grants',
  '/api/grant-audit',
  '/api/admin-actions',
]);
