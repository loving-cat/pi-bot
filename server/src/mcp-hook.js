/**
 * 把用户在「设置 → MCP」里配的服务注册进 pi 会话。
 *
 * ## 为什么要走扩展
 *
 * pi 的 MCP 不是 session option，而是**扩展注册**：
 * `pi.registerMcpServer(name, config)`，然后在 `session_start` 时才真正连。
 * 所以这里以内联扩展的形式挂进每个会话，按"这个 bot 选了哪几个"逐个注册。
 *
 * ## 为什么默认一个都不连
 *
 * MCP 是**真的会起子进程 / 连远端**（一个 npx 服务就是几百 MB 内存）。
 * pi-bot 里可能同时开几十个 bot 会话，每个都挂一份 MCP 会直接把机器拖死。
 * 所以：用户配了 ≠ 生效，必须（1）服务自己在库里启用 +（2）这个 bot 选中它，
 * 两条都满足才连。默认两条都是空的。
 *
 * ## 和 pi 自己的 mcp.json 的关系
 *
 * 完全不碰。pi 的 mcp.json 是终端用户自己的；这里注册的是 pi-bot 自己的服务，
 * 名字冲突时以这里为准（因为 bot 会话本来就默认不加载 mcp.json，
 * 见 config.js 的 resourceSwitches）。
 */
import { store } from './store.js';
import { toMcpServersConfig } from './mcp.js';
import { log } from './util.js';
import { isDelegatingLead } from './role-tools.js';

/**
 * 造一个只注册 MCP 服务的扩展。
 *
 * @param {object} deps
 * @param {string} deps.botId 这个会话属于哪个 bot（决定连哪几个）
 * @param {string} [deps.roomId] 房间（日志用）
 * @returns {(pi: any) => void} 扩展工厂
 */
export function createMcpExtension({ botId, roomId = null }) {
  return function mcpExtension(pi) {
    // 负责人的外部能力由成员执行，不在此会话连接或注册 MCP。
    if (isDelegatingLead(store.getRoom(roomId), store.getBot(botId))) return;
    // 建会话时就把名字定下来：会话中途用户改了配置也不会突然多连/少连，
    // 避免跑到一半 MCP 的工具有的有一一没有（那种 bug 极难查）。
    const servers = store.mcpServersFor(botId);
    const config = toMcpServersConfig(servers);

    const names = Object.keys(config);
    if (!names.length) return; // 没选/没启用 → 什么都不做，零开销

    for (const [name, serverConfig] of Object.entries(config)) {
      try {
        pi.registerMcpServer(name, serverConfig);
      } catch (err) {
        // 单个服务注册失败不能拖垮整个会话 —— 其它服务还得能用
        log(`⚠️ MCP「${name}」注册失败：${err?.message || err}`);
      }
    }

    log(
      `🔌 ${roomId ? `[${roomId}] ` : ''}MCP 已挂载 ${names.length} 个：${names.join(', ')}`,
    );

    // 连上之后 pi 会把工具塞进来。这里只做一件事：断开时把连接关掉，
    // 否则反复建会话会积一堆子进程（长驻服务最常见的泄漏点）。
    pi.on?.('session_shutdown', () => {
      for (const name of names) {
        try {
          pi.unregisterMcpServer?.(name);
        } catch {
          // 关不掉就算了，进程退出时操作系统会回收
        }
      }
    });
  };
}

/**
 * 给主控提示词用的 MCP 清单。
 *
 * 为什么不直接把 MCP 工具塞给每个 bot：
 *   MCP 会起进程。正确做法是**主控知道有哪些能力**，派活时再决定给哪个 bot 配上。
 * 所以主控的提示词里只列"能用什么"，具体连不连由 bot 自己的配置决定。
 *
 * @returns {string} 多行文本；一个服务都没有时返回空串
 */
export function mcpSectionForPrompt() {
  const servers = store.mcpLibrary();
  if (!servers.length) return '';
  const usable = servers.filter((s) => s.enabled);
  const lines = ['## 可用的 MCP 能力', ''];
  if (!servers.length) return '';

  if (!usable.length) {
    lines.push('（库里配了 MCP 服务，但都还没启用。）');
    return lines.join('\n');
  }

  lines.push(
    '下面这些 MCP 服务已经启用。**你可以给成员 bot 配上它需要的工具**，' +
      '但不要一股脑全配 —— 每个 MCP 都会起进程吃内存：',
  );
  for (const s of usable) {
    const target =
      s.type === 'http'
        ? s.url
        : [s.command, ...(s.args ?? [])].filter(Boolean).join(' ');
    const what = s.description ? ` —— ${s.description}` : '';
    lines.push(`- \`${s.name}\`（${s.type === 'http' ? 'HTTP' : '本地'}：${target}）${what}`);
  }
  lines.push('');
  lines.push(
    '要启用：用 update_bot 把 mcpServers 设成这些名字的数组（比如 `["filesystem"]`）。' +
      '改完那个 bot 的会话会自动重开，下一轮就能用上新工具。',
  );
  return lines.join('\n');
}
