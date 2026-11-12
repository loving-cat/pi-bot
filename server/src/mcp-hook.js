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
import { probeMcpServer } from './mcp-probe.js';
import { log } from './util.js';
import { isDelegatingLead, isReadonlyPolicy } from './role-tools.js';
import { isExternalMcpTool, mcpAccessSignature, splitExternalToolName } from './mcp-access.js';
import { isListedTool, rememberTools } from './mcp-tool-registry.js';

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
    // 只读模式不连接 MCP：工具名不固定，连上之后就能写文件、跑命令。
    if (isReadonlyPolicy(store.policy())) return;
    // 负责人的外部能力由成员执行，不在此会话连接或注册 MCP。
    if (isDelegatingLead(store.getRoom(roomId), store.getBot(botId))) return;
    // 建会话时就把名字定下来：会话中途用户改了配置也不会突然多连/少连，
    // 避免跑到一半 MCP 的工具有的有一一没有（那种 bug 极难查）。
    const servers = store.mcpServersFor(botId);
    const config = toMcpServersConfig(servers);

    const names = Object.keys(config);
    if (!names.length) return; // 没选/没启用 → 什么都不做，零开销

    const signature = mcpAccessSignature(store.getBot(botId), store.mcpLibrary());

    /** 当前 server 配置的 revision（网关判断清单是否可信要用）。 */
    const revisionOf = (serverName) => {
      const server = store.mcpLibrary().find(
        (s) => String(s?.name ?? '').toLowerCase() === String(serverName ?? '').toLowerCase(),
      );
      return String(server?.configurationRevision ?? '');
    };

    /** 同步拉一次某 server 的 tools/list 并写进注册表；失败返回 false。 */
    const refreshToolList = async (serverName) => {
      const serverConfig = config[serverName]
        ?? config[Object.keys(config).find((n) => n.toLowerCase() === String(serverName).toLowerCase())];
      if (!serverConfig) return false;
      try {
        const probe = await probeMcpServer(serverConfig, { timeoutMs: 15_000 });
        const toolNames = (probe?.tools ?? []).map((t) => t.name).filter(Boolean);
        rememberTools(serverName, toolNames, revisionOf(serverName));
        return true;
      } catch (err) {
        log(`⚠️ MCP「${serverName}」工具清单刷新失败：${err?.message || err}`);
        return false;
      }
    };

    pi.on?.('tool_call', (event) => {
      if (!isExternalMcpTool(event?.toolName)) return;

      // ★ D5 网关：工具名必须在这个 server **当前**的 tools/list 里。
      //
      //   不在就直接拒绝，请求**不会到达 MCP 子进程** ——
      //   模型幻觉出的工具名（或 server 升级后改名的旧名）在这里就被挡下，
      //   而不是打到子进程去触发它内部的兜底分支。
      //
      //   ★ 没有可信清单时（还没拉过 / revision 变了 / 上次 probe 失败）
      //     一律**拒绝**，同时在后台重新拉一次清单。
      //     tool_call 处理器是同步的（返回 Promise 不会阻止工具执行），
      //     所以不能在这里 await —— 只能把这次调用挡下，让下一次能通过。
      //     宁可让用户重试一次，也不让来路不明的工具名打到子进程。
      const parts = splitExternalToolName(event?.toolName);
      if (parts) {
        const revision = revisionOf(parts.server);
        let listed = isListedTool(parts.server, parts.tool, revision);

        if (listed === null) {
          // ★ 没有可信清单（还没拉过 / revision 变了 / 上次 probe 失败）。
          //
          //   不能在这里 await —— tool_call 处理器是同步的，返回 Promise
          //   不会阻止工具执行。所以：**当场拒绝这次调用**，同时在后台
          //   重新拉一次清单，让用户的下一次尝试（或重试）能通过。
          //
          //   宁可让用户点一下"重试"，也不在"不知道这个工具存不存在"的
          //   情况下把请求转发给子进程。
          refreshToolList(parts.server).catch(() => {});
          return {
            block: true,
            reason:
              `拿不到「${parts.server}」的工具清单（还没拉取成功，或配置刚改过），` +
              '无法确认这个工具名是否真实存在，调用已拒绝。' +
              '正在后台重新拉取 —— 稍等几秒再试一次；如果一直这样，请让用户重新验证这个 MCP 连接。',
          };
        }

        if (listed === false) {
          return {
            block: true,
            reason:
              `这个 MCP 服务没有叫「${parts.tool}」的工具（不在它当前的 tools/list 里），` +
              '调用没有转发出去。让用户重新验证这个连接，或换个工具名。',
          };
        }
      }

      const currentBot = store.getBot(botId);
      if (!currentBot || currentBot.enabled === false ||
          signature !== mcpAccessSignature(currentBot, store.mcpLibrary())) {
        return { block: true, reason: '应用连接或 Bot 授权已更改，请在新会话中重试。' };
      }
    });

    for (const [name, serverConfig] of Object.entries(config)) {
      try {
        pi.registerMcpServer(name, serverConfig);
      } catch (err) {
        // 单个服务注册失败不能拖垮整个会话 —— 其它服务还得能用
        log(`⚠️ MCP「${name}」注册失败：${err?.message || err}`);
      }
    }

    // ★ 记下每个 server 的工具清单，供网关校验（D5）。
    //
    //   不阻塞会话建立：拉清单要真的连一次，慢的 server 会拖住整个会话。
    //   所以放到微任务里异步做，失败只是"网关对那个 server 视为未知"，
    //   行为退化成"放行但仍要审批"——安全侧仍然正确。
    Promise.resolve().then(async () => {
      for (const [name, serverConfig] of Object.entries(config)) {
        try {
          const probe = await probeMcpServer(serverConfig, { timeoutMs: 15_000 });
          const toolNames = (probe?.tools ?? []).map((t) => t.name).filter(Boolean);
          // ★ revision 必须用 server 的 configurationRevision —— 网关拿它比对。
          //   用 probe 自己返回的字段对不上，会导致网关永远认为"清单不可信"，
          //   每次调用都白跑一次 probe。
          rememberTools(name, toolNames, revisionOf(name));
        } catch (err) {
          // 拉不到就**不留清单** —— 网关会把后续调用挡下并要求重新验证
          log(`⚠️ MCP「${name}」工具清单拉取失败（网关将拒绝未知调用）：${err?.message || err}`);
        }
      }
    });

    log(
      `🔌 ${roomId ? `[${roomId}]` : ''}MCP 已挂载 ${names.length} 个：${names.join(', ')}`,
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
    '要挂给哪个 bot：用 update_bot 把 mcpServers 设成这些名字的数组（比如 `["filesystem"]`）。',
    '★ 挂载会弹一张审批卡给用户，批准后才生效 —— 这是改"这个 bot 能用哪些外部能力"，' +
      '不是普通操作，不要反复重试。批准后那个 bot 的会话会自动重开，下一轮就能用上新工具。',
    '★ 服务本身必须先由用户在「设置 → MCP」里启用；没启用的挂了也没用。',
  );
  return lines.join('\n');
}
