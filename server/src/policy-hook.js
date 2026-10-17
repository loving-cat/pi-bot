/**
 * 命令策略的执行点：拦截 shell 类工具调用，命中规则就阻止执行。
 *
 * 以 pi 扩展的形式注入会话（inline extension），只注册 `tool_call` 一个处理器：
 *   · 只处理会执行命令的工具（bash / powershell）；
 *   · 规则从 store 实时读取 —— 改规矩后新建的会话立即生效；
 *   · 拒绝时写一条审计记录，并把原因回给模型（模型据此换做法，不会卡死）。
 */
import { store } from './store.js';
import { decideCommand } from './shell-policy.js';
import { log } from './util.js';

/** 执行命令的工具名 */
const SHELL_TOOLS = new Set(['bash', 'powershell']);

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
        if (!SHELL_TOOLS.has(event?.toolName)) return undefined;

        const policy = store.policy();
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
