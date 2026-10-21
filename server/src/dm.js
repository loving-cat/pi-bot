/** 私聊开场与进度回执：生成文案并保存结果、来源和调度关联。 */

export { backfillProgressSenders } from './progress-migration.js';

/** 摘要：压成一行，去掉 markdown 记号，限长 */
export function excerpt(text, limit = 80) {
  const flat = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

/** 私聊开场指令（写给模型，不会出现在聊天记录里） */
export function dmOpeningPrompt(bot = {}) {
  const name = bot.name || '你';
  return [
    `【私聊开场】用户刚打开和「${name}」的私聊，还没有说话。`,
    '请按顺序做两件事：',
    '1) 用一句话介绍自己：名字 + 你负责什么（不要提模型、线路、工具、思考等级）。',
    '2) 调用 ask_user 弹一张卡片，问用户现在想做什么：给 2–3 个跟你职责相关的具体选项，',
    '   每个选项带一句代价/说明；留出"我自己说"的入口。',
    '不要复述这段说明，也不要解释你的身份设定。整段不超过 60 字，像一个同事刚坐下开口。',
  ].join('\n');
}

/** 接到活时的私聊回执 */
export function progressStartText({ roomName = '', task = '' } = {}) {
  const where = roomName ? `「${roomName}」` : '部门里';
  const what = excerpt(task, 70);
  return what ? `在${where}接到活，开始处理：${what}` : `在${where}接到活，开始处理。`;
}

/** 做完（或没做成）时的私聊回执 */
export function progressDoneText({ roomName = '', text = '', ok = true } = {}) {
  const where = roomName ? `「${roomName}」` : '部门';
  const what = excerpt(text, 70);
  if (!ok) return what ? `${where}那件事没跑通：${what}` : `${where}那件事没跑通。`;
  return what ? `${where}那件事做完了：${what}` : `${where}那件事做完了。`;
}

/**
 * 是否该往私聊回执。
 *
 * 只在"这活是部门里的另一个 bot 派给它的"时才回执 —— 用户自己直接找它干活时
 * 不需要再往私聊复述一遍（他就在那个会话里看着）。
 */
export function shouldMirrorProgress({ roomKind, fromId, botId } = {}) {
  if (roomKind !== 'group') return false;
  if (!fromId) return false;
  if (fromId === botId) return false;
  return true;
}


/**
 * 把一条进度写进该 bot 与用户的私聊。
 *
 * 只在私聊已存在时写（不替用户没打开过的 bot 造会话，否则侧边栏会被塞满）。
 * @returns {boolean} 是否写入了
 */
export function mirrorProgress({
  store,
  room,
  bot,
  phase,
  text,
  ok = true,
  fromId = null,
  fromName = '',
  dispatchId = null,
  sourceMessageId = null,
}) {
  const dm = store.findDm(bot.id);
  if (!dm || dm.id === room.id) return false;
  const content =
    phase === 'start'
      ? progressStartText({ roomName: room.name, task: text })
      : progressDoneText({ roomName: room.name, text, ok });
  store.appendMessage({
    roomId: dm.id,
    authorType: 'bot',
    authorId: bot.id,
    authorName: bot.name,
    authorEmoji: bot.emoji,
    text: content,
    status: 'done',
    meta: {
      progress: true,
      fromRoomId: room.id,
      phase,
      fromId,
      fromName,
      dispatchId,
      sourceMessageId,
      ...(phase === 'done' ? { outcome: ok ? 'success' : 'failure' } : {}),
    },
  });
  return true;
}
