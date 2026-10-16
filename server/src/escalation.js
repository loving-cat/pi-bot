import { pickEscalationHost as pickHost } from './util.js';
/**
 * 出事了往上抬：把"这单断了"告诉该知道的人，并请它重新安排。
 *
 * 从 pi-runner.js 搬出来。"该谁知晓"的规则本来就在 util.js
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

    const note = buildEscalationNote({ store, fromBotId, reason, task, attempts, why });
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

/** 回执正文（纯函数，好单测：该带的信息一样不能少） */
export function buildEscalationNote({ store, fromBotId, reason, task = '', attempts = 0, why = '' }) {
  const from = store?.getBot?.(fromBotId);
  return (
    `[这单断了] ${from?.name ?? fromBotId}：${reason}` +
    (attempts ? `（试了 ${attempts} 次，${why}）` : '') +
    (task ? `\n\n原任务：${task.slice(0, 600)}` : '') +
    `\n\n请你重新安排：换个人，或者再派一次。`
  );
}
