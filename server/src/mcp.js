import { explicitChildEnv } from './child-env.js';
import { probeMcpServer } from './mcp-probe.js';

/**
 * MCP 服务库（MCP server library）—— 纯函数，无 IO。
 *
 * 为什么要独立一层：
 *   MCP 跟 skill 不是一回事。skill 是"往提示词里塞一段做法"，改错了只影响回答；
 *   MCP 是**真的去起子进程 / 连远端服务**，配错了会占端口、吃内存、卡住会话。
 *   所以这里的规范化必须比 skill 更严：字段形状、名称合法性、命令/URL 二选一，
 *   全都要在入库前卡死，不能等到建会话时才炸。
 *
 * 与 pi 侧 mcp.json 的关系：
 *   pi 的 mcp.json 是**终端用户**自己的配置；pi-bot 里每个 bot 会话默认**不加载任何 MCP**
 *   （见 config.js 的 resourceSwitches）。用户在这里配的 MCP 是给 bot 用的，
 *   由服务端在建会话时按"这个 bot 选了哪几个"逐个注册，不碰用户的 mcp.json。
 */

/** 单个服务的字段上限 */
export const MCP_LIMITS = {
  /** 名字：会变成工具前缀 `mcp__<name>`，所以必须是标识符 */
  name: 40,
  description: 200,
  command: 400,
  /** 命令参数最多多少个 */
  args: 20,
  argLength: 300,
  /** 环境变量 / 请求头最多几项 */
  envPairs: 30,
  envKeyLength: 80,
  envValueLength: 2000,
  url: 500,
  timeoutSeconds: 600,
  /** 库里最多存多少个服务 */
  total: 50,
};

/** 服务类型：本地子进程 / 远端 HTTP */
export const MCP_TYPES = ['stdio', 'http'];

/** 工具暴露方式（对齐 pi 的 McpExposure） */
export const MCP_EXPOSURES = ['direct', 'deferred', 'codemode', 'hidden'];

/**
 * 名字要能当工具前缀用。
 *
 * pi 把 MCP 工具命名成 `mcp__<server>__<tool>`，名字里出现空格、
 * 中文、斜杠都会让工具名变成非法标识符 —— 模型根本调不到，
 * 而且界面上看起来"配好了"，非常难查。所以入库前就只允许这些字符。
 */
export function mcpNameError(value) {
  const name = String(value ?? '').trim();
  if (!name) return '需要一个名字';
  if (name.length > MCP_LIMITS.name) return `名字不能超过 ${MCP_LIMITS.name} 个字`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    return '名字只能用字母、数字、下划线和短横线，且要字母或数字开头（它会被拼进工具名）';
  }
  return null;
}

/** 文本里有没有编码损坏（同 skills.js 的理由） */
export function hasBrokenEncoding(text) {
  return /�/.test(String(text ?? ''));
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * 把环境变量 / 请求头这类键值对整理干净。
 *
 * - 键名不合法（空、含 `=`）直接丢；
 * - 值里带换行会破坏 .env / header 语义，也丢；
 * - 全部当字符串处理 —— 用户填 `true` 不能变成布尔，环境变量只能是字符串。
 */
function normalizePairs(raw, { keyMax, valueMax, limit }) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (n >= limit) break;
    const k = str(key, keyMax);
    if (!k || k.includes('=') || k.includes('\n')) continue;
    const v = String(value ?? '').slice(0, valueMax);
    out[k] = v;
    n++;
  }
  return out;
}

/**
 * 规范化单个 MCP 服务。
 *
 * @param {object} raw 用户输入或已存配置
 * @param {number} [now]
 * @returns {object|null} 名字非法时返回 null
 */
export function normalizeMcpServer(raw = {}, now = Date.now()) {
  const name = str(raw?.name, MCP_LIMITS.name);
  if (mcpNameError(name)) return null;

  const type = MCP_TYPES.includes(raw?.type) ? raw.type : 'stdio';

  const description = str(raw?.description, MCP_LIMITS.description);
  if (hasBrokenEncoding(name) || hasBrokenEncoding(description) || hasBrokenEncoding(raw?.command)) {
    return null;
  }

  const timeout = Number(raw?.timeout);
  const server = {
    id: str(raw?.id, 60) || `mcp_${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name,
    type,
    description,
    exposure: MCP_EXPOSURES.includes(raw?.exposure) ? raw.exposure : 'direct',
    // 默认不启用：MCP 会真起进程，用户加进来是"待配置"，要显式打开才开始连
    enabled: raw?.enabled === true,
    timeout: Number.isFinite(timeout) && timeout > 0 && timeout <= MCP_LIMITS.timeoutSeconds
      ? Math.round(timeout)
      : 60,
    createdAt: Number(raw?.createdAt) || now,
    updatedAt: Number(raw?.updatedAt) || now,
  };

  if (type === 'stdio') {
    server.command = str(raw?.command, MCP_LIMITS.command);
    server.args = Array.isArray(raw?.args)
      ? raw.args
          .map((a) => str(a, MCP_LIMITS.argLength))
          .filter(Boolean)
          .slice(0, MCP_LIMITS.args)
      : [];
    const env = normalizePairs(raw?.env, {
      keyMax: MCP_LIMITS.envKeyLength,
      valueMax: MCP_LIMITS.envValueLength,
      limit: MCP_LIMITS.envPairs,
    });
    if (Object.keys(env).length) server.env = env;
    const cwd = str(raw?.cwd, MCP_LIMITS.command);
    if (cwd) server.cwd = cwd;
  } else {
    server.url = str(raw?.url, MCP_LIMITS.url);
    const headers = normalizePairs(raw?.headers, {
      keyMax: MCP_LIMITS.envKeyLength,
      valueMax: MCP_LIMITS.envValueLength,
      limit: MCP_LIMITS.envPairs,
    });
    if (Object.keys(headers).length) server.headers = headers;
  }

  return server;
}

/**
 * 校验一个服务能不能入库，返回**人话原因**（能入库返回 null）。
 *
 * 与 normalizeMcpServer 的分工：那个整理形状，这个解释"为什么不行"。
 * 这些错误用户要能一眼看懂该改哪个字段 —— 比如把 URL 填进 command 里，
 * 报错必须说清"stdio 要的是可执行命令"。
 */
export function mcpRejectReason(raw = {}) {
  const nameErr = mcpNameError(raw?.name);
  if (nameErr) return nameErr;

  if (hasBrokenEncoding(raw?.name) || hasBrokenEncoding(raw?.description) || hasBrokenEncoding(raw?.command)) {
    return '内容里有乱码（编码损坏），请重新输入或换个方式导入';
  }

  const type = MCP_TYPES.includes(raw?.type) ? raw.type : 'stdio';

  if (type === 'stdio') {
    const command = str(raw?.command, MCP_LIMITS.command);
    if (!command) return '本地服务要填启动命令（比如 npx / python3 / node）';
    // 用户最容易犯的错：把网址填进命令里
    if (/^https?:\/\//i.test(command)) {
      return '这是网址，不是命令 —— 要连远端服务请把类型切成 HTTP';
    }
    if (command.includes('\n')) return '启动命令只能写一行（参数请填到参数列表里）';
    if ((Array.isArray(raw.args) ? raw.args : []).some((arg) => /^--?(?:access[-_]?token|refresh[-_]?token|token|api[-_]?key|secret|password|passwd|authorization)(?:=|$)/i.test(String(arg)))) {
      return '请把凭据放在环境变量中，不要写入命令参数';
    }
  } else {
    const url = str(raw?.url, MCP_LIMITS.url);
    if (!url) return 'HTTP 服务要填 URL';
    if (!/^https?:\/\//i.test(url)) {
      return 'URL 要以 http:// 或 https:// 开头';
    }
    try {
      const target = new URL(url);
      if (target.username || target.password || [...target.searchParams.keys()].some((key) => /^(?:access[-_]?token|refresh[-_]?token|token|api[-_]?key|key|secret|password|passwd|authorization|signature|sig)$/i.test(key))) {
        return '请把凭据放在请求头中，不要写入服务地址';
      }
    } catch {
      return '服务地址格式不正确';
    }
    // 明文 http 会把凭据暴露在网络上，除了本机回环都要求 https
    const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url);
    if (/^http:\/\//i.test(url) && !isLoopback) {
      return '非本机地址请用 https（明文 http 会把 key 暴露在网络上）';
    }
  }

  const timeout = Number(raw?.timeout);
  if (raw?.timeout !== undefined && raw?.timeout !== null && raw?.timeout !== '') {
    if (!Number.isFinite(timeout) || timeout <= 0) return '超时要是正数秒';
    if (timeout > MCP_LIMITS.timeoutSeconds) {
      return `超时不能超过 ${MCP_LIMITS.timeoutSeconds} 秒`;
    }
  }

  return null;
}

/** 规范化整个库（去重、限量、保持顺序）。同名只留第一条。 */
export function normalizeMcpList(list = [], now = Date.now()) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const server = normalizeMcpServer(raw, now);
    if (!server) continue;
    const key = server.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(server);
    if (out.length >= MCP_LIMITS.total) break;
  }
  return out;
}

/**
 * 把一个库里的服务转成 pi 认识的 `mcpServers` 配置。
 *
 * 只转换**启用**的那些 —— 停用的仍然留在库里（用户可能只是暂时关掉），
 * 但绝不能出现在会话配置里，否则关掉等于没关。
 *
 * @param {Array} servers 服务库
 * @returns {Record<string, object>} `{ [name]: McpServerConfig }`
 */
export function toMcpServersConfig(servers = []) {
  const out = {};
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server || server.enabled !== true) continue;
    const base = {
      exposure: server.exposure || 'direct',
      timeout: server.timeout || 60,
    };
    if (server.description) base.description = server.description;

    if (server.type === 'http') {
      if (!server.url) continue;
      out[server.name] = {
        ...base,
        type: 'http',
        url: server.url,
        ...(server.headers && Object.keys(server.headers).length
          ? { headers: server.headers }
          : {}),
      };
    } else {
      if (!server.command) continue;
      out[server.name] = {
        ...base,
        type: 'stdio',
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        // 只放用户显式写的 env。pi 默认还会并上 process.env，
        // spawn 补丁见到标记后改回白名单，并留下这些显式项。
        env: explicitChildEnv(server.env),
        inheritEnv: false,
        ...(server.cwd ? { cwd: server.cwd } : {}),
      };
    }
  }
  return out;
}

/** 摘要：给日志和提示词用的一句话。 */
export function describeMcpServer(server = {}) {
  const target =
    server.type === 'http'
      ? server.url || '(没填 URL)'
      : [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') || '(没填命令)';
  return `${server.name}（${server.type === 'http' ? 'HTTP' : '本地'}：${target}）`;
}

/**
 * 给主控看的清单：告诉它有哪些 MCP 能力、每个是干什么的、能不能派给成员。
 *
 * 为什么不直接把所有工具塞给每个 bot：MCP 会起进程，几十个 bot 各连一份
 * 就是几十个 node/python 进程。正确做法是**主控知道有哪些能力**，
 * 派活时给具体某个 bot 配上它需要的那几个。
 *
 * @param {Array} servers 服务库（全部，含停用的）
 * @returns {string} 多行文本；没有服务时返回空串
 */
export function mcpPromptLines(servers = []) {
  const usable = (Array.isArray(servers) ? servers : []).filter((s) => s && s.name);
  if (!usable.length) return '';
  const lines = [];
  for (const server of usable) {
    const state = server.enabled === true ? '可用' : '未启用';
    const what = server.description ? ` —— ${server.description}` : '';
    lines.push(`- ${server.name}（${state}）：${describeMcpServer(server)}${what}`);
  }
  return lines.join('\n');
}

/** 完成 MCP 初始化和工具发现，返回可用性及脱敏错误。 */
export async function testMcpServer(server = {}) {
  return probeMcpServer(server);
}
