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
import { mcpRequiresApproval } from './mcp-risk.js';
import { mcpApprovalSummary } from './mcp-approval-summary.js';
import { presetOutputDir } from './mcp-preset-shapes.js';

/** 执行命令的工具名 */
const SHELL_TOOLS = new Set(['bash', 'powershell']);

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
 * 这个 MCP 工具所属 server 的**运行配置**（要 command / args）。
 *
 * 用途：白名单按 (可执行文件名, 工具名) 匹配 —— 光看 server 名字会让
 * 另一个同名 MCP 冒充，所以必须拿到它真实的启动命令。
 */
function mcpServerConfigFor(tool) {
  try {
    const parts = /^mcp__([A-Za-z0-9_-]{1,80})__/.exec(String(tool ?? ''));
    if (!parts) return null;
    const name = parts[1].toLowerCase();
    const record = store.mcpLibrary().find(
      (s) => String(s?.name ?? '').toLowerCase() === name,
    );
    return record ?? null;
  } catch {
    return null;
  }
}

/**
 * 预设的输出目录（pyghidra 的 project_path 要落在这里）。
 *
 * 白名单形状匹配时会拿它和配置里的实际值比对 ——
 * 用户如果手动把 project_path 指到别处，形状就对不上，退回 dynamic。
 */
function presetProjectPath(presetId) {
  try {
    return presetOutputDir(config.dataDir, presetId);
  } catch {
    return '';
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

        // ---- MCP 风险分级：dynamic 一律逐次审批 ----
        //
        // ★ 这段必须放在 `dangerous === 'ask'` 判断**外面**。
        //
        //   原来的写法把外部 MCP 工具整块包进了 ask 档：
        //     if (policy.dangerous === 'ask' && (... || isExternalMcpTool(tool)))
        //   于是默认的 allow 档下，任何外部 MCP 工具都直接放行 ——
        //   模型只要能调用 mcp__dbg__run，就等于拿到一个免审批的任意执行入口。
        //
        //   现在：dynamic（run/attach/spawn/emulate/inject/script/eval 一类，
        //   以及所有认不出动词的）**不论策略档位都强制审批**。
        //   static（反编译、读符号等）保持原样：allow 档放行、ask 档仍会走下面的通用审批。
        //
        //   判定完全由服务端自己的分级表决定（mcp-risk.js），
        //   不读 MCP server 自报的 annotations —— 那是被调用方给自己发的好人卡。
        // ★ 判定完全由服务端白名单决定（mcp-risk.js），不读任何自报信息：
        //   不看 MCP 的 annotations，也不看工具名里的动词。
        //   未知 server 的一切工具、白名单 server 的新工具，全部 dynamic。
        const mcpDynamic = isExternalMcpTool(tool) &&
          mcpRequiresApproval(
            tool,
            mcpServerConfigFor(tool),
            store.mcpServerRiskOverrides?.() ?? null,
            (presetId) => presetProjectPath(presetId),
          );

        // ★ 改安全配置本身：有些工具**不论档位**都必须逐次审批。
        //
        //   模型能 add_mcp_server 一个带任意 command 的本地服务、
        //   再 update_bot 挂到任意 bot —— 挂上之后那些 MCP 工具就成了它的
        //   新执行入口。这条链上每一步都不该让模型自己走完：
        //   它不是"做活"，是**改防线**。
        //
        //   所以这类调用不受 dangerous 档位影响（allow 档也弹卡），
        //   也不吃"本任务授权"窗口（见下面的 windowOk）。
        const securityConfig = isSecurityConfigCall(tool, event?.input);

        // ---- 第三档：每一次"会动手"的调用都要用户点批准 ----
        if (
          securityConfig ||
          mcpDynamic ||
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
          // 能享受"本次任务授权"窗口的只有：内置动手工具 + static MCP 工具。
          // securityConfig（改策略/挂 MCP）和 mcpDynamic（会驱动外部进程）
          // 一律不吃窗口 —— 它们的每次调用实际效果都可能完全不同。
          if (!securityConfig && !mcpDynamic && !managed &&
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
