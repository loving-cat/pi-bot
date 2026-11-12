/**
 * 命令策略的执行点：拦截 shell 类工具调用，命中规则就阻止执行。
 *
 * 以 pi 扩展的形式注入会话（inline extension），只注册 `tool_call` 一个处理器：
 *   · 会执行命令的工具（bash / powershell / run_background / write_stdin）走同一套判定；
 *   · 规则从 store 实时读取 —— 改规矩后新建的会话立即生效；
 *   · 拒绝时写一条审计记录，并把原因回给模型（模型据此换做法，不会卡死）。
 */
import crypto from 'node:crypto';
import { store } from './store.js';
import { verdictForTool } from './shell-policy.js';
import { log } from './util.js';
import { bus } from './bus.js';
import { loadHooks, applyHooks } from './hooks.js';
import { config } from './config.js';
import { isDelegatingLead, leadToolAllowed, readonlyBlockReason, opaqueScriptBlockReason, MUTATING_TOOLS, isSecurityConfigCall } from './role-tools.js';
import { isExternalMcpTool, externalApprovalSummary, mcpAccessSignature } from './mcp-access.js';
import { mcpApprovalSummary } from './mcp-approval-summary.js';

/** 执行命令的工具名 */
const SHELL_TOOLS = new Set(['bash', 'powershell']);

/**
 * 能"往 shell 里塞命令"的全部工具。
 *
 * ★ 必须包含 write_stdin，否则有个绕过：
 *   run_background 批准一次之后，模型可以反复用 write_stdin 往那个后台 shell
 *   里灌任意命令 —— 不弹卡、还吃 120 分钟授权窗口。等于批准的是一条无害命令，
 *   实际执行的是后面灌进去的一切。
 *
 * kill_shell 不在里面：它只能杀进程，不能执行东西。
 */
const SHELL_LIKE = new Set(['bash', 'powershell', 'run_background', 'write_stdin']);

/** ask 档要批准的工具，与 role-tools 的名单是同一份 */
const MUTATING = new Set(MUTATING_TOOLS);

/** 把一次调用压成一句人话，给审批卡片看 */
export function summarizeToolCall(tool, input = {}, mcpOpts = null) {
  if (isExternalMcpTool(tool)) {
    // ★ 审批卡要能看到"它要干什么"，但不能泄漏凭据。
    //   原来这里只回一句"调用外部工具 mcp__x__y"，用户等于盲批；
    //   直接把 input 贴上去又会让模型传进来的 key/token 落进审批记录。
    //   见 mcp-approval-summary.js：结构保留、值按凭据特征打码。
    const detail = mcpApprovalSummary(input, mcpOpts ?? {});
    return `${externalApprovalSummary(tool)}｜${detail}`;
  }
  const pick = (k) => (typeof input?.[k] === 'string' ? input[k] : '');
  if (SHELL_TOOLS.has(tool) || tool === 'run_background') {
    return pick('command') || pick('cmd') || '(命令)';
  }
  if (tool === 'write') {
    const body = pick('content');
    return `${pick('path') || '(文件)'}${body ? `（写 ${body.length} 字）` : ''}`;
  }
  if (tool === 'edit') return pick('path') || '(文件)';
  if (tool === 'write_stdin') return `${pick('shell_id')} ← ${pick('chars')}`;
  if (tool === 'kill_shell') return pick('shell_id') || '(进程)';
  return JSON.stringify(input ?? {}).slice(0, 200);
}

/** 同一次调用（工具 + 入参）的指纹：批准一次只放行同一个动作 */
export function approvalHash(tool, input, scope = null) {
  return crypto
    .createHash('sha1')
    .update(`${tool}
${JSON.stringify(input ?? {})}${scope ? `\n${JSON.stringify(scope)}` : ''}`)
    .digest('hex');
}

/**
 * @param {{roomId:string, bot:object}} ctx
 * @returns {{name:string, hidden:boolean, factory:Function}}
 */
/**
 * 命令策略的执行点：拦截 shell 类工具调用，命中规则就阻止执行。
 *
 * @param {object} p
 * @param {string} p.roomId
 * @param {object} p.bot
 * @param {(approval:object, info:{created:boolean})=>void} [p.onBlocked]
 *   真实的**策略阻塞观察**回调：一次调用被 pending 审批挡住时通知调用方。
 *   复用已有 pending 与新建 pending 两条路径都会触发。
 *   仅供观察（例如受管执行记录「我在等哪个真实审批」），不参与放行判定。
 */
/**
 * 这个 MCP 工具所属 server 已存的凭据键名（env + header 的 key）。
 *
 * 用途：审批卡脱敏。模型可能把 \`api_key\` 传成 \`FOO\`（用户 env 里的名字），
 * 只看键名 \`FOO\` 判断不出是凭据，但它确实是同一个值 —— 必须遮掉。
 */
/**
 * 这个 bot 是不是挂了任何外部 MCP 工具。
 *
 * 用途：挂了 MCP 的 bot，shell 类工具要逐次审批 —— 否则模型可以用 bash
 * 去起同一个 MCP（或任何别的程序），绕过 MCP 那一层的管控。
 */
function botHasMcp(bot) {
  try {
    if (!bot?.id) return false;
    // 解析出真正会连上的服务（enabled 且被这个 bot 选中）
    return store.mcpServersFor(bot.id).length > 0;
  } catch {
    return false;
  }
}

function mcpServerSecretKeys(tool) {
  try {
    const parts = /^mcp__([A-Za-z0-9_-]{1,80})__/.exec(String(tool ?? ''));
    if (!parts) return [];
    const name = parts[1].toLowerCase();
    const record = store.state.mcpServers?.find(
      (s) => String(s?.name ?? '').toLowerCase() === name,
    );
    return Array.isArray(record?.credentialKeys)
      ? record.credentialKeys.filter((k) => typeof k === 'string')
      : [];
  } catch {
    return [];
  }
}

export function createPolicyExtension({ roomId, bot, onBlocked = () => {}, managedContextOf = null }) {
  /** 通知观察者：这次调用被某条 pending 审批挡住了。 */
  function notifyBlocked(approval, created) {
    if (typeof onBlocked !== 'function') return;
    try {
      onBlocked(approval, { created: created === true });
    } catch {
      // 观察者出错不能影响策略判定
    }
  }

  return {
    name: 'policy',
    hidden: true,
    factory: (pi) => {
      pi.on('tool_call', (event) => {
        const tool = event?.toolName;
        const policy = store.policy();

        // 执行前读取当前角色，审批授权和缓存中的旧工具不能覆盖负责人限制。
        const currentBot = store.getBot(bot?.id) ?? bot;
        if (isDelegatingLead(store.getRoom(roomId), currentBot) &&
            !leadToolAllowed(tool, config.leadTools)) {
          return { block: true, reason: '部门负责人负责拆解、派活和汇总；请把这项操作交给成员执行。' };
        }

        // 只读：默认拒绝。审批授权、命令白名单和会话里残留的工具都不能放行。
        const readonlyReason = readonlyBlockReason(policy, tool);
        if (readonlyReason) return { block: true, reason: readonlyReason };
        const scriptReason = opaqueScriptBlockReason(policy, tool);
        if (scriptReason) return { block: true, reason: scriptReason };

        // ---- 钩子：可以先改入参（重写命令），也可以直接拦下 ----
        const hooked = applyHooks(loadHooks(), { tool, input: event?.input ?? {} });
        if (hooked.blocked) return { block: true, reason: hooked.reason };
        if (hooked.applied.length) {
          // 就地改写入参（SDK 约定：mutate event.input 即可生效）
          if (event?.input && typeof event.input === 'object') {
            Object.assign(event.input, hooked.input);
          }
        }

        // 命令规矩在审批之前：批准、临时放行都不能绕过黑名单/白名单。
        const commandVerdict = verdictForTool(tool, event?.input, policy);
        if (commandVerdict && !commandVerdict.allowed) {
          const command = tool === 'write_stdin'
            ? (event?.input?.chars ?? '')
            : (event?.input?.command ?? event?.input?.cmd ?? '');
          store.addDenial({
            roomId,
            botId: bot?.id ?? null,
            botName: bot?.name ?? '',
            command,
            rule: commandVerdict.rule ?? commandVerdict.deniedBy,
            reason: commandVerdict.reason,
          });
          log(
            `⛔ ${bot?.name ?? bot?.id ?? 'bot'} 的命令被拦（${commandVerdict.reason}）：` +
              String(command).replace(/\s+/g, ' ').slice(0, 120),
          );
          return { block: true, reason: commandVerdict.message };
        }

        // ---- 外部 MCP 工具：一律逐次审批 ----
        //
        // ★ 这段必须放在 `dangerous === 'ask'` 判断**外面**。
        //
        //   早先的写法把外部 MCP 工具整块包进了 ask 档，于是默认的 allow 档下
        //   任何外部 MCP 工具都直接放行 —— 模型只要能调用 mcp__dbg__run，
        //   就等于拿到一个免审批的任意执行入口。
        //
        //   后来试过给"只读工具"留免审批通道（按动词猜 / 按可执行名 /
        //   按配置精确形状），但每一版都只是"我们以为它安全"：
        //   MCP 是被调用方，它随时能在下一次更新里改变行为。
        //   所以现在**不存在 static 档**：所有外部 MCP 工具都要审批。
        const externalMcp = isExternalMcpTool(tool);

        // ★ 挂了 MCP 的 bot，shell 类工具也要逐次审批。
        //
        //   为什么：MCP 一旦挂上，它自己的工具是管控的，但模型完全可以用
        //   bash 去起同一个 MCP（或任何别的程序）绕过检查 —— 等于开了后门。
        //   所以"这个 bot 有外部能力"本身就是提高 shell 风险的因素。
        //
        //   没挂 MCP 的 bot 行为保持不变（allow 档不弹卡）。
        //   挂 MCP 时，**所有能执行/注入命令的工具**都逐次审批 ——
        //   包括 write_stdin（往已批准的后台 shell 里灌命令）。
        const shellWithMcp = !externalMcp && SHELL_LIKE.has(tool) && botHasMcp(currentBot);

        // ★ 改安全配置本身：有些工具**不论档位**都必须逐次审批。
        //
        //   模型能 add_mcp_server 一个带任意 command 的本地服务、
        //   再 update_bot 挂到任意 bot —— 挂上之后那些 MCP 工具就成了它的
        //   新执行入口。这条链上每一步都不该让模型自己走完：
        //   它不是"做活"，是**改防线**。
        const securityConfig = isSecurityConfigCall(tool, event?.input);

        // ---- 第三档：每一次"会动手"的调用都要用户点批准 ----
        if (
          securityConfig ||
          externalMcp ||
          shellWithMcp ||
          (policy.dangerous === 'ask' && (MUTATING.has(tool) || isExternalMcpTool(tool)))
        ) {
          const capabilityRevision = isExternalMcpTool(tool)
            ? mcpAccessSignature(currentBot, store.mcpLibrary()) : null;
          const managed = typeof managedContextOf === 'function' ? managedContextOf() : null;
          // 用户批准过"本次任务" → 这个 bot 在这个会话里有一段时间不用逐条点。
          //
          // ★ dynamic MCP 工具**不吃这个窗口**。
          //   任务级授权本来是给"这个活我已经批准过做法了"用的，
          //   但一个会驱动外部进程的工具，每一次调用的实际参数都可能完全不同
          //   （这次 attach 8743 端口、下次 attach 别的），窗口覆盖等于盲开。
          //   static / 内置工具仍按原逻辑享受窗口。
          // 能享受"本次任务授权"窗口（120 分钟）的只有**纯内置动手工具**，
          // 前提是这个 bot 没挂任何 MCP。
          //
          //   不吃窗口的三类：
          //     · securityConfig  改策略/挂 MCP —— 改的是防线本身
          //     · externalMcp     外部工具 —— 每次调用的实际效果都可能完全不同
          //     · shellWithMcp    bot 挂了 MCP 时的 shell —— 可以用它绕过 MCP 管控
          if (!securityConfig && !externalMcp && !shellWithMcp && !managed &&
              store.hasApprovalGrant({ roomId, botId: bot?.id ?? null, capabilityRevision })) return undefined;
          const scope = capabilityRevision ? { roomId, botId: bot?.id ?? null, capabilityRevision } : null;
          const hash = approvalHash(tool, event?.input, scope);
          // 批准过的那一次直接放行（而且只用一次）；受管只消费本任务本版本的批准
          if (store.takeApproved(hash, {
            taskRunId: managed?.taskRunId ?? null,
            taskRevision: managed?.revision ?? null,
          })) return undefined;

          const existing = store.findPendingApproval({
            roomId,
            botId: bot?.id ?? null,
            hash,
            taskRunId: managed?.taskRunId ?? null,
            taskRevision: managed?.revision ?? null,
          });
          if (existing) {
            // ★ 真实阻塞观察：这次调用确实被这条既有审批挡住了
            notifyBlocked(existing, false);
            return {
              block: true,
              reason: '这一次操作还在等用户批准（卡片已经发在会话里了），先别重复调用。',
            };
          }

          // MCP：把那个 server 已存的 env/header 键名交给摘要器，
          // 这样"模型把凭据当普通参数传"的情况也能遮住（光看键名判断不出来）。
          const mcpOpts = isExternalMcpTool(tool)
            ? { secretKeys: mcpServerSecretKeys(tool) }
            : null;
          const summary = summarizeToolCall(tool, event?.input, mcpOpts);
          const approval = store.createApproval({
            roomId,
            botId: bot?.id ?? null,
            botName: bot?.name ?? '',
            tool,
            summary,
            taskRunId: managed?.taskRunId ?? null,
            taskRevision: managed?.revision ?? null,
            attemptId: managed?.attemptId ?? null,
            // MCP 也记一份**脱敏后**的入参：原来这里是 null，
            // 事后想查"当时到底批了什么"什么都看不到。
            input: isExternalMcpTool(tool)
              ? { __masked: summary }
              : event?.input ?? null,
            hash,
            capabilityRevision,
          });
          notifyBlocked(approval, true);
          const msg = store.appendMessage({
            roomId,
            authorType: 'bot',
            authorId: bot?.id ?? null,
            authorName: bot?.name ?? '',
            authorEmoji: bot?.emoji ?? null,
            kind: 'approval',
            text: `${bot?.name ?? '它'} 想执行：${summary}`,
            status: 'done',
            meta: {
              approvalId: approval.id,
              tool,
              summary,
            },
          });
          bus.emit('event', { t: 'msg.new', msg });
          log(`🛡 ${bot?.name ?? 'bot'} 的操作等待批准：${String(summary).slice(0, 80)}`);
          return {
            block: true,
            reason:
              '这一次操作需要用户批准，批准卡片已经发在会话里。' +
              '先不要重复调用；等用户点了批准会再来找你继续。',
          };
        }
      });
    },
  };
}
