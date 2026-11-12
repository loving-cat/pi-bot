/**
 * MCP 工具的风险分级 —— **服务端白名单**，不信任何自报信息。
 *
 * ## 为什么不能用动词猜测
 *
 * 第一版是按工具名里的动词分类的：名字含 decompile/read/get 就当只读。
 * 但**工具名本身就是 MCP server 自己报的** —— 一个恶意（或写坏了）的
 * server 只要把"执行任意命令"的工具命名成 `get_info`、`read_x`，
 * 就能在 allow 档下免审批跑掉。这等于又信了一次被调用方。
 *
 * 同理，MCP 协议自带的 `annotations.readOnlyHint` 也不能信：那是
 * 被调用方给自己发的好人卡。
 *
 * ## 现在的规则
 *
 *   static  —— **只有本文件白名单里逐条列明的 (server 可执行文件名, 工具名)
 *              组合**才算只读。白名单是服务端维护的常量表，外部改不了。
 *   dynamic —— 其余一切：未知 server 的所有工具、白名单 server 的新工具、
 *              以及白名单里没写的工具。
 *
 * 换句话说：**默认 dynamic，白名单是例外**。新增只读例外要人工核对源码后
 * 才能加进来 —— 这才是"服务端自己判断"。
 *
 * ## 白名单键为什么要带 command
 *
 * 只按 server 名字匹配的话，另一个 MCP 只要也叫 `r2mcp` 就能冒充。
 * 所以键是 `<可执行文件名>:<工具名>`，server 的启动命令对不上就不认。
 *
 * ## 动词分类还留着干什么
 *
 * 只用于 UI 给个默认建议（比如"这个看起来是只读的，要不要加白名单？"），
 * **不参与任何放行判定**。见 `suggestRiskLevel`。
 */

import path from 'node:path';
import { matchPresetShape, PRESET_SHAPES } from './mcp-preset-shapes.js';

export const RISK_STATIC = 'static';
export const RISK_DYNAMIC = 'dynamic';

/**
 * 只读工具白名单。
 *
 * 结构：{ '<可执行文件名>': Set<工具名> }
 *
 * ★ 加之前必须核对那个 MCP 的源码，确认该工具不发网络请求、
 *   不写文件、不改目标进程、不执行命令、不写数据库。
 * ★ 名字必须和源码里注册的**完全一致**（大小写敏感 —— 我们按原样比对）。
 */
// 白名单已迁到 mcp-preset-shapes.js 的 PRESET_SHAPES（配置精确形状匹配）。


/** 与 mcp-access.js 的 RESOURCE_TOOLS 对齐：只读资源访问，不需要白名单。 */
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
 * 从 server 的启动命令里取"可执行文件名"。
 *
 * `npx -y r2mcp`、`/usr/local/bin/r2mcp`、`python -m pyghidra_mcp` 这些写法
 * 都要归一到 "r2mcp" / "pyghidra_mcp" 这种粒度上。取不到就返回 null（→ dynamic）。
 *
 * 注意：这里只做**白名单匹配**用，不追求完美解析命令 ——
 * 解析不出来的结果就是"不在白名单里"，安全侧是可接受的。
 */
/**
 * 去掉包规格里的版本后缀：`pkg==1.2.3` / `pkg@1.2.3` → `pkg`。
 *
 * ★ 不能无脑按 `@` 切：npm 的 scoped 包叫 `@scope/pkg`，
 *   开头的 @ 是名字的一部分，不是版本分隔符。
 */
function stripVersionSpec(spec) {
  const text = String(spec);
  // 先处理 ==（Python/PEP 440 风格）
  const eq = text.indexOf('==');
  if (eq > 0) return text.slice(0, eq);
  // @ 版本分隔符只能出现在「包名之后」。scoped 包 `@scope/pkg` 的第一个 @
  // 是名字开头，不能切。
  const at = text.lastIndexOf('@');
  if (at > 0) return text.slice(0, at);
  return text;
}

/** 可执行名里的 scoped 包要保留 scope：`@scope/pkg` 的 basename 不是 `pkg`。 */
function packageNameOf(spec) {
  const text = String(spec);
  return text.startsWith('@') ? text : path.basename(text);
}

export function executableNameOf(server) {
  const command = String(server?.command ?? '').trim();
  if (!command) return null;
  // 显式 command + args：可执行文件就是 command 的 basename
  const base = path.basename(command);
  // `python -m mod` 这种把模块名当主体
  const args = Array.isArray(server?.args) ? server.args.map(String) : [];
  if (/-m$/i.test(base) || /^python[0-9.]*$/i.test(base)) {
    const idx = args.indexOf('-m');
    if (idx >= 0 && args[idx + 1]) return path.basename(args[idx + 1]);
  }
  // npx / uvx / bunx 这类启动器：真正的目标是它后面的第一个非选项参数
  if (/^(npx|uvx|bunx|pnpm|yarn)$/i.test(base)) {
    // 先处理 `--from pkg==1.2.3` / `-p pkg@1.2.3` 这种"先给包再跑命令"的写法：
    // 真正被执行的是 pkg，不是带版本号的那串。
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
  // r2pm 是 radare2 的包管理器，`r2pm -r <tool>` 才是真正要跑的东西
  if (/^r2pm$/i.test(base)) {
    const idx = args.indexOf('-r');
    if (idx >= 0 && args[idx + 1]) return path.basename(args[idx + 1]);
    // `r2pm -ci r2mcp` 之类是安装命令，不是运行 —— 这里返回 null，
    // 让调用方按 dynamic 处理（配错了就不该拿到只读待遇）
    return null;
  }
  return base || null;
}

/**
 * 综合判定一次调用的风险等级。
 *
 * @param {string} toolName
 * @param {object|null} [server] 该工具所属 MCP 的运行配置（含 command / args）
 * @returns {'static'|'dynamic'|null} 不是外部 MCP 工具时返回 null
 */
/**
 * @param {string} toolName
 * @param {object|null} server 该工具所属 MCP 的**运行时配置**（command/args/env）
 * @param {object|null} downgradeTable 用户手动降级表
 * @param {(presetId: string) => string} [projectPathOf] 算 project_path 的函数
 */
export function mcpRiskLevel(toolName, server = null, downgradeTable = null, projectPathOf = null) {
  if (RESOURCE_TOOLS.has(toolName)) return RISK_STATIC;

  const parts = splitMcpToolName(toolName);
  if (!parts) return null;

  // 用户手动降级：把一个本来在白名单里的 server 整体按 dynamic 处理。
  // 只能降不能升 —— 白名单是唯一的升格途径（要改代码、要人工核对源码）。
  if (downgradeTable && downgradeTable[String(parts.server).toLowerCase()] === RISK_DYNAMIC) {
    return RISK_DYNAMIC;
  }

  // ★ 唯一放行条件：配置**逐项等于**某个预设形状，且工具在该形状的只读集里。
  //
  //   不再按可执行名猜。看 basename 的话 /tmp/evil/r2mcp、npm 上的 r2mcp、
  //   uvx --from 本地目录、--with 塞包、PYTHONPATH 改加载路径全都能冒充。
  const pathOf = typeof projectPathOf === 'function' ? projectPathOf : () => '';
  const shape = matchPresetShape(server, pathOf);
  if (!shape) return RISK_DYNAMIC;
  if (!shape.tools.includes(parts.tool)) return RISK_DYNAMIC;
  return RISK_STATIC;
}

/** 是否必须逐次审批（除白名单外一律要）。 */
export function mcpRequiresApproval(toolName, server = null, downgradeTable = null, projectPathOf = null) {
  return mcpRiskLevel(toolName, server, downgradeTable, projectPathOf) === RISK_DYNAMIC;
}

/** 白名单里有没有这个可执行文件（UI / 诊断用）。 */
export function hasStaticWhitelist(exe) {
  return PRESET_SHAPES.some((sh) => sh.exe === exe);
}

/** 白名单里某个可执行文件名下的工具（只读副本，测试与 UI 用）。 */
export function staticWhitelistFor(exe) {
  const shape = PRESET_SHAPES.find((sh) => sh.exe === exe);
  return shape ? [...shape.tools] : [];
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
 * 按工具名猜一个风险等级 —— **只用来给 UI 一个默认建议**。
 *
 * ★ 绝不能用它放行。工具名是 MCP 自己报的，恶意 server 随便起名叫 get_info。
 * 这个函数存在的唯一意义是：在"设置 → MCP"里展示"看起来像只读/会动手"，
 * 帮用户决定要不要把它加进白名单。
 */
export function suggestRiskLevel(toolName) {
  const list = words(toolName);
  if (!list.length) return RISK_DYNAMIC;
  for (const w of list) {
    if (DYNAMIC_VERBS.includes(w)) return RISK_DYNAMIC;
  }
  for (const w of list) {
    if (STATIC_VERBS.includes(w)) return RISK_STATIC;
  }
  return RISK_DYNAMIC;
}
