import { pickEscalationHost as pickHost } from './util.js';
import { isDelegatingLead } from './role-tools.js';
/**
 * 出事了往上抬：把"这单断了"告诉该知道的人，并请它重新安排。
 *
 * "该谁知晓"的规则在 util.js
 * （pickEscalationHost：部门里的活先找组长，没有组长就找主控）；
 * 这里负责**怎么抬**：在哪儿说、说什么、怎么把对方叫醒。
 *
 * 叫醒这一步不能省：只往群里留一条消息，对方是不会自己动起来的 ——
 * 用户看到的就是"报了个回执，然后没下文"。
 *
 * @param {object} deps
 * @param {object} deps.store
 * @param {(roomId:string, botId:string, text:string, opts:object)=>Promise<any>} deps.run
 *        叫醒对方用的执行器（就是 runner.run）
 * @param {(msg:string, err:any)=>void} [deps.onError]
 */
export function createEscalator({ store, run, onError = () => {} }) {
  return async function escalate({
    roomId,
    fromBotId,
    reason,
    task = '',
    attempts = 0,
    why = '',
    prefer = 'lead',
  }) {
    const room = store.getRoom(roomId);
    const chief = store.mainBot();
    const target = pickHost({
      roomKind: room?.kind,
      leadBotId: room?.leadBotId ?? null,
      fromBotId,
      chiefId: chief?.id ?? null,
      prefer,
    });
    if (!target.hostId) return null;

    const host = store.getBot(target.hostId);
    if (!host) return null;
    // 组长：就在群里说（用户也看得见"这单断了"）；主控：在它的私聊里说
    const inRoom = target.role === 'lead' ? roomId : (store.ensureDm(host.id)?.id ?? null);
    if (!inRoom) return null;

    const note = buildEscalationNote({
      store, fromBotId, reason, task, attempts, why,
      delegateOnly: isDelegatingLead(store.getRoom(inRoom), host),
    });
    store.appendMessage({
      roomId: inRoom,
      authorType: 'system',
      authorId: host.id,
      authorName: '中断回执',
      text: note,
      status: 'done',
      meta: { via: 'escalate', aboutBotId: fromBotId },
    });

    // 光留一条消息它不会自己动 —— 顺手叫醒它，让它当场重新安排
    run(inRoom, host.id, `【系统】${note}`, {
      skipUserMessage: true,
      timeoutMs: 300_000,
    }).catch((err) => onError('叫醒失败', err));

    return { hostId: host.id, roomId: inRoom };
  };
}

/** 构造失败回执文本；delegateOnly 时第三步改为向用户说明阻塞并等待决定。 */
export function buildEscalationNote({ store, fromBotId, reason, task = '', attempts = 0, why = '', delegateOnly = false }) {
  const from = store?.getBot?.(fromBotId);
  const name = from?.name ?? fromBotId;
  const lines = [`[这单断了] ${name}：${reason}`];
  if (attempts) lines.push(`（试了 ${attempts} 次${why ? `，${why}` : ''}）`);
  if (task) lines.push('', `原任务：${String(task).slice(0, 600)}`);
  lines.push(
    '',
    '请按这个顺序处理：',
    `1. 先 @ ${name} 再派一次，把要求说得更具体（做什么 / 交什么 / 怎么算完成）。`,
    '2. 还不行就 @ 另一个同事接手，并说明是谁没完成。',
    delegateOnly
      ? '3. 没有成员能接时，向用户说明谁未完成、卡在哪里、需要什么；等待用户决定，不自行执行。'
      : '3. 实在没人能接，你自己上 —— 但**必须在群里说明你接手了、因为谁没完成**。',
    '★ 不要悄悄把活接下：用户会以为全员都交付了，掉链子的事故就被掩盖了。',
  );
  return lines.join('\n');
}
