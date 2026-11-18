/**
 * 私聊开场那一轮的文案收尾（纯逻辑，无 IO、不读时钟）。
 *
 * ## 为什么需要这一层
 *
 * 开场提示（`dm.js` 的 `dmOpeningPrompt`）要求模型「一句话自我介绍 + 调 ask_user
 * 弹一张卡片让用户选」。实际跑下来，模型经常把这句工具动作当成回答：
 *
 *   用户看到的：  卡片已发出，请你选择或直接说。
 *   应该看到的：  我是抓数员，负责把页面上的数据抓回来。
 *
 * 卡片本身用户看得见（就在下面），「卡片已发出」对用户是零信息量的噪音，
 * 而自我介绍——对话第一句话该有的东西——反而没了。
 *
 * 所以这里只做一件保守的事：**开场轮**里，如果整段话就是在描述工具动作、
 * 且没有任何自我介绍痕迹，就用「名字 + 人设首句」把它换掉。
 * 判定刻意求稳：
 *   · 只改开场这一轮（调用方按 `meta.opening` 判断），普通回复一个字都不动；
 *   · 话里出现「我是 / 我叫 / 机器人名字」就认为已经在介绍自己，不替换；
 *   · 超过 40 字的长回答不替换（那通常是真在说话，不是一句工具播报）。
 */

/** 描述「我刚刚调用了工具」的说法。 */
const NARRATION_RE =
  /卡片|弹窗|弹出了?|已发出|已发送|已展示|已推送|请选择|请点击|点一下|如图所示|上面这张|下面这张/;

/** 自我介绍痕迹：有这些词就不当成纯播报。 */
const SELF_INTRO_RE = /我是|我叫|我负责|我的职责|你可以叫我/;

/**
 * 这段文字是不是在「念工具动作」而不是在说话。
 *
 * @param {string} text 模型产出的正文
 * @param {{name?: string}} bot 用来识别「话里已经报了自己名字」的情况
 */
export function looksLikeToolNarration(text, bot = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return false;
  if (clean.length > 40) return false;
  if (SELF_INTRO_RE.test(clean)) return false;
  const name = String(bot?.name ?? '').trim();
  if (name && clean.includes(name)) return false;
  return NARRATION_RE.test(clean);
}

/**
 * 从这个 bot 的设定里拼一句自我介绍。
 *
 * persona 常常是一整段（"你是一名数据工程师，擅长…"），这里取第一个句子、
 * 去掉「你是/你负责」这类第二人称，最长 40 字 —— 开场白不该是一段简历。
 */
export function openingIntro(bot = {}) {
  const name = String(bot?.name ?? '').trim() || '助手';
  const persona = String(bot?.persona ?? bot?.tagline ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const firstSentence = persona.split(/[。\n！!？?]/)[0]?.trim() ?? '';
  const cleaned = firstSentence
    .replace(/^(你是一名|你是个|你是|你负责|你的职责是|你的职责)\s*/, '')
    .replace(/[，,；;]$/, '')
    .trim();
  if (!cleaned) return `我是${name}。`;
  const brief = cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned;
  return `我是${name}，${brief}。`;
}

/**
 * 开场轮收尾：把「卡片已发出」这类播报换成自我介绍。
 *
 * @param {string} text 模型原话
 * @param {{name?: string, persona?: string, tagline?: string}} bot
 * @returns {string} 可以直接展示给用户的正文
 */
export function polishOpeningReply(text, bot = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return openingIntro(bot);
  if (looksLikeToolNarration(clean, bot)) return openingIntro(bot);
  return clean;
}
