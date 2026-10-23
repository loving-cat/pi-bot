/**
 * 命令策略的执行点：拦截 shell 类工具调用，命中规则就阻止执行。
 *
 * 以 pi 扩展的形式注入会话（inline extension），只注册 `tool_call` 一个处理器：
 *   · 只处理会执行命令的工具（bash / powershell）；
 *   · 规则从 store 实时读取 —— 改规矩后新建的会话立即生效；
 *   · 拒绝时写一条审计记录，并把原因回给模型（模型据此换做法，不会卡死）。
 */
import crypto from 'node:crypto';
import { store } from './store.js';
import { decideCommand } from './shell-policy.js';
import { log } from './util.js';
import { bus } from './bus.js';
import { loadHooks, applyHooks } from './hooks.js';
import { config } from './config.js';
import { isDelegatingLead, leadToolAllowed, readonlyBlockReason, MUTATING_TOOLS } from './role-tools.js';

/** 执行命令的工具名 */
const SHELL_TOOLS = new Set(['bash', 'powershell']);

/** ask 档要批准的工具，与 role-tools 的名单是同一份 */
const MUTATING = new Set(MUTATING_TOOLS);

/** 把一次调用压成一句人话，给审批卡片看 */
export function summarizeToolCall(tool, input = {}) {
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
export function approvalHash(tool, input) {
  return crypto
    .createHash('sha1')
    .update(`${tool}
${JSON.stringify(input ?? {})}`)
    .digest('hex');
}

/**
 * @param {{roomId:string, bot:object}} ctx
 * @returns {{name:string, hidden:boolean, factory:Function}}
 */
export function createPolicyExtension({ roomId, bot }) {
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

        // ---- 钩子：可以先改入参（重写命令），也可以直接拦下 ----
        const hooked = applyHooks(loadHooks(), { tool, input: event?.input ?? {} });
        if (hooked.blocked) return { block: true, reason: hooked.reason };
        if (hooked.applied.length) {
          // 就地改写入参（SDK 约定：mutate event.input 即可生效）
          if (event?.input && typeof event.input === 'object') {
            Object.assign(event.input, hooked.input);
          }
        }

        // ---- 第三档：每一次"会动手"的调用都要用户点批准 ----
        if (policy.dangerous === 'ask' && MUTATING.has(tool)) {
          // 用户批准过"本次任务" → 这个 bot 在这个会话里有一段时间不用逐条点
          if (store.hasApprovalGrant({ roomId, botId: bot?.id ?? null })) return undefined;
          const hash = approvalHash(tool, event?.input);
          // 批准过的那一次直接放行（而且只用一次）
          if (store.takeApproved(hash)) return undefined;

          const existing = store.findPendingApproval({
            roomId,
            botId: bot?.id ?? null,
            hash,
          });
          if (existing) {
            return {
              block: true,
              reason: '这一次操作还在等用户批准（卡片已经发在会话里了），先别重复调用。',
            };
          }

          const summary = summarizeToolCall(tool, event?.input);
          const approval = store.createApproval({
            roomId,
            botId: bot?.id ?? null,
            botName: bot?.name ?? '',
            tool,
            summary,
            input: event?.input ?? null,
            hash,
          });
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

        if (!SHELL_TOOLS.has(tool)) return undefined;

        const denyCommands = policy.denyCommands ?? [];
        const allowCommands = policy.allowCommands ?? [];
        if (!denyCommands.length && !allowCommands.length) return undefined;

        const command = event?.input?.command ?? event?.input?.cmd ?? '';
        const verdict = decideCommand(command, { denyCommands, allowCommands });
        if (verdict.allowed) return undefined;

        store.addDenial({
          roomId,
          botId: bot?.id ?? null,
          botName: bot?.name ?? '',
          command,
          rule: verdict.rule ?? verdict.deniedBy,
          reason: verdict.reason,
        });
        log(
          `⛔ ${bot?.name ?? bot?.id ?? 'bot'} 的命令被拦（${verdict.reason}）：` +
            String(command).replace(/\s+/g, ' ').slice(0, 120),
        );
        return { block: true, reason: verdict.message };
      });
    },
  };
}
