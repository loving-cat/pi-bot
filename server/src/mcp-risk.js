/**
 * 外部 MCP 工具一律需要逐次审批 —— 没有"只读免审批"这一档。
 *
 * ## 为什么彻底删掉 static
 *
 * 前几版试图给"只读工具"一条免审批通道，判据换了三次：
 *
 *   1. 按工具名里的动词猜 —— 工具名是 MCP 自己报的，恶意 server 把
 *      run_command 叫成 get_info 就绕过了。
 *   2. 按可执行名 + 工具白名单 —— basename 太容易冒充：/tmp/evil/r2mcp、
 *      npm 上的同名包、uvx --from 本地目录、--with 塞包全能过。
 *   3. 按"配置逐项等于预设形状"+ env 为空 —— 已经是能想到最严的形态匹配了，
 *      但仍然要求"我们相信某个具体 MCP 是安全的"。
 *
 * 而且第 3 版默认放行 RESOURCE_TOOLS（read_mcp_resource 等三个），
 * 在解析 server 之前就返回 static —— 对任意 server 成立，那是个洞。
 *
 * 结论：**不存在可以免审批的外部工具调用**。判据再严也只是"我们以为它安全"，
 * 而 MCP 是被调用方，它随时可以在下一次更新里改变行为。所以整条静态路径删掉，
 * 所有外部 MCP 工具（包括资源工具）走同一条审批路径。
 *
 * ## 保留的东西
 *
 * executableNameOf / suggestRiskLevel 只给 UI 做展示和默认建议用，
 * **不参与任何安全判定**。它们的存在不会让任何调用少一次审批。
 */

import path from 'node:path';

/** 与 mcp-access.js 的 RESOURCE_TOOLS 保持一致：这些也是外部工具，也要审批。 */
const RESOURCE_TOOLS = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]);

/**
 * 把 `mcp__<server>__<tool>` 拆成 { server, tool }。不是外部 MCP 工具时返回 null。
 */
export function splitMcpToolName(name) {
  if (typeof name !== 'string') return null;
  const m = /^mcp__([A-Za-z0-9_-]{1,80})__(.+)$/.exec(name);
  if (!m) return null;
  return { server: m[1], tool: m[2] };
}

/**
 * 是不是需要逐次审批的外部工具调用。
 *
 * 现在**所有**外部 MCP 工具都要审批，包括资源类工具 ——
 * 它们同样能读用户机器上的东西。
 *
 * @param {string} toolName
 * @returns {boolean}
 */
export function mcpRequiresApproval(toolName) {
  if (typeof toolName !== 'string' || !toolName) return false;
  if (RESOURCE_TOOLS.has(toolName)) return true;
  return splitMcpToolName(toolName) !== null;
}

// ─────────────────────── 以下仅供 UI 展示，不参与放行 ───────────────────────

/**
 * 从 server 的启动命令里取"可执行文件名"。
 *
 * ★ 只用于 UI 显示"这个 MCP 大概是干嘛的"。**不参与任何安全判定** ——
 *   上一版拿它匹配白名单，basename 冒充太容易（/tmp/evil/r2mcp 之类）。
 */
export function executableNameOf(server) {
  const command = String(server?.command ?? '').trim();
  if (!command) return null;
  const base = path.basename(command);
  const args = Array.isArray(server?.args) ? server.args.map(String) : [];
  if (/-m$/i.test(base) || /^python[0-9.]*$/i.test(base)) {
    const idx = args.indexOf('-m');
    if (idx >= 0 && args[idx + 1]) return path.basename(args[idx + 1]);
  }
  if (/^(npx|uvx|bunx|pnpm|yarn)$/i.test(base)) {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '--from' || arg === '-p' || arg === '--package') {
        const spec = args[i + 1];
        if (!spec) continue;
        return packageNameOf(stripVersionSpec(String(spec)));
      }
    }
    for (const arg of args) {
      if (!arg || arg.startsWith('-')) continue;
      return packageNameOf(stripVersionSpec(String(arg)));
    }
  }
  if (/^r2pm$/i.test(base)) {
    const idx = args.indexOf('-r');
    if (idx >= 0 && args[idx + 1]) return path.basename(args[idx + 1]);
    return null;
  }
  return base || null;
}

/**
 * 去掉包规格里的版本后缀：`pkg==1.2.3` / `pkg@1.2.3` → `pkg`。
 *
 * 不能无脑按 `@` 切：npm 的 scoped 包叫 `@scope/pkg`，
 * 开头的 @ 是名字的一部分，不是版本分隔符。
 */
function stripVersionSpec(spec) {
  const text = String(spec);
  const eq = text.indexOf('==');
  if (eq > 0) return text.slice(0, eq);
  const at = text.lastIndexOf('@');
  if (at > 0) return text.slice(0, at);
  return text;
}

/** 可执行名里的 scoped 包要保留 scope：`@scope/pkg` 的 basename 不是 `pkg`。 */
function packageNameOf(spec) {
  const text = String(spec);
  return text.startsWith('@') ? text : path.basename(text);
}

// ─────────────────────── 以下仅供 UI 建议，不参与放行 ───────────────────────

/** 会驱动/改变外部世界的动词。 */
const DYNAMIC_VERBS = [
  'run', 'exec', 'execute', 'spawn', 'attach', 'emulate', 'inject',
  'script', 'eval', 'launch', 'start', 'continue', 'step', 'patch',
  'write', 'set', 'put', 'post', 'delete', 'remove', 'kill', 'stop',
  'create', 'upload', 'install', 'deploy', 'call', 'invoke', 'send',
  'open', 'load', 'apply', 'modify', 'edit', 'move', 'copy', 'rename',
  'sql', 'query', 'db',
];

/** 只读/分析类动词。 */
const STATIC_VERBS = [
  'disassemble', 'decompile', 'decompilation', 'read', 'get', 'list',
  'show', 'describe', 'inspect', 'view', 'dump', 'symbol', 'symbols',
  'lookup', 'resolve', 'search', 'find', 'analyze', 'analyse',
  'info', 'status', 'version', 'help', 'export', 'decode', 'parse',
  'xref', 'xrefs', 'hexdump', 'imports', 'exports', 'strings', 'functions',
];

function words(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * 按工具名猜"看起来像只读还是会动手" —— **仅供 UI 展示**。
 *
 * ★ 返回 'static' 不代表这个调用能免审批。它只是让界面能标注
 *   "看起来是只读的"，帮用户判断要不要点批准。**任何外部工具都要审批**。
 */
export function suggestRiskLevel(toolName) {
  const list = words(toolName);
  if (!list.length) return 'dynamic';
  for (const w of list) {
    if (DYNAMIC_VERBS.includes(w)) return 'dynamic';
  }
  for (const w of list) {
    if (STATIC_VERBS.includes(w)) return 'static';
  }
  return 'dynamic';
}
