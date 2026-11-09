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

/** mirrorProgress 的跳过原因：用户还没打开过这个 bot 的私聊，不替它建会话。 */
export const MIRROR_SKIPPED_NO_DM = 'no-dm';

/** 做完（或没做成）时的私聊回执 */
/**
 * 没产出正文时的兜底文案。
 *
 * 正常情况下不用它：模型说了什么就发什么，不套模板。
 * 只有模型这一轮一个字都没产出（异常/超时）时才兜一句，
 * 免得私聊里出现一条空消息让人以为界面坏了。
 */
export function progressFallbackText({ ok = true } = {}) {
  return ok ? '（这一轮没有产出正文）' : '（这一轮没有跑通，也没有产出说明）';
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
  // ★ 接到活不再往私聊回执。
  //
  //   "我接到了" 对用户不是新信息（任务派出去了他已经知道），
  //   却要占一条消息。memory-digest 那边早就把这类回执当噪音过滤掉，
  //   既然不够格进摘要，也不该进会话。
  if (phase === 'start') return false;

  // ★ 只查不建：不替用户没打开过的 bot 造会话，否则侧边栏会被塞满。
  //
  //   代价是：如果用户从没点开过这个 bot 的私聊，回执会被**静默丢弃** ——
  //   「负责人 @ 了某成员，但用户看不到它在部门里干了什么」就是这么来的。
  //   所以这里返回一个带原因的结果，让调用方能区分「写成功了」和
  //   「因为没会话所以跳过」。原来的 false 什么都不说明。
  const dm = store.findDm(bot.id);
  if (!dm) return MIRROR_SKIPPED_NO_DM;
  if (dm.id === room.id) return false;
  // 正常路径：模型说了什么就发什么，一个字都不套。
  const raw = String(text ?? '').trim();
  const content = raw || progressFallbackText({ ok });
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
      // ★ re = 这条在回应哪条消息。
      //   有它，界面才能画成「引用 + 回应」的对话，
      //   而不是一排互不相干的卡片。
      re: sourceMessageId ?? null,
      ...(phase === 'done' ? { outcome: ok ? 'success' : 'failure' } : {}),
    },
  });
  return true;
}
