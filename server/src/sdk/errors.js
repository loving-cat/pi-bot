/**
 * SDK 的类型化错误契约（路线图 §4 T2.5）。
 *
 * ## 为什么不能继续 `throw new Error('找不到 mainBot')`
 *
 * 宿主拿到一个 `Error` 只能看文案去做 `if (err.message.includes(...))` —— 文案一改
 * 就断，翻译一改就断，而且**分不清"我传错了参数"和"环境没准备好"**：
 * 前者该改调用代码，后者该重试或提示用户。`code` 就是把这两件事分开的那一维。
 *
 * ## 约定
 *
 * · 所有面向宿主的失败都抛 `OrbisError`（`err.name === 'OrbisError'`）；
 * · `code` 只在 `ORBIS_ERROR_CODES` 里取值 —— 拼错的 code 会退化成 `E_INTERNAL`
 *   并把原值放进 `requestedCode`，宁可降级也不让调用方拿到一个"看起来能用"的自定义码；
 * · `details` 只放**可公开**的上下文（房间 id、bot id、可选动作），不放 token / 路径；
 * · 老的内部错误（`Object.assign(new Error(...), { code })`）在 SDK 边界用
 *   `asOrbisError()` 统一翻译，不要求存储层/运行层一起改签名；
 * · **同步门面抛异常、异步入口返回 rejected promise**（两者都带 `code`）——
 *   `lessons.list()` 这种同步读 API 不包成 Promise，调用方 `try/catch` 就好。
 */

/** 允许出现在 `OrbisError.code` 上的全部取值（新增必须先改这里 + 补单测） */
export const ORBIS_ERROR_CODES = Object.freeze({
  /** 参数不合法（空消息、群聊不支持首次接单等） */
  E_INVALID_ARGUMENT: 'E_INVALID_ARGUMENT',
  /** 找不到目标（房间 / bot / 经验 …） */
  E_NOT_FOUND: 'E_NOT_FOUND',
  /** runtime 已经 dispose：不再接受新的一轮（重建一个才能继续） */
  E_DISPOSED: 'E_DISPOSED',
  /** 构造参数不合法（模型组、policy 等） */
  E_CONFIG_INVALID: 'E_CONFIG_INVALID',
  /** 指定的模型 / 模型组不可用 */
  E_MODEL_UNAVAILABLE: 'E_MODEL_UNAVAILABLE',
  /** 库里没有主控 bot（初始化异常或被人删了） */
  E_NO_MAIN_BOT: 'E_NO_MAIN_BOT',
  /** bot 正忙，而调用方没给分流意图 —— SDK **不替人猜** */
  E_BUSY_NEEDS_ROUTE: 'E_BUSY_NEEDS_ROUTE',
  /** 等回复超时 */
  E_TIMEOUT: 'E_TIMEOUT',
  /** 这一轮执行失败（模型报错 / 工具崩了） */
  E_TURN_FAILED: 'E_TURN_FAILED',
  /** 权限不足（迁移授权 / 策略拦截） */
  E_GRANT_DENIED: 'E_GRANT_DENIED',
  /** 远程 HTTP / WebSocket 失败（`status` 在 `details.status`） */
  E_HTTP: 'E_HTTP',
  /** 兜底：没归类的内部错误 */
  E_INTERNAL: 'E_INTERNAL',
});

const CODE_SET = new Set(Object.values(ORBIS_ERROR_CODES));

/** 创建时用的原始 code 不在词表里时，保留它便于排查（不改 `code`） */
export class OrbisError extends Error {
  /**
   * @param {string} code `ORBIS_ERROR_CODES` 里的值
   * @param {string} message 人话（可以直接给用户看）
   * @param {object} [details] 可公开的上下文（roomId / botId / options / status …）
   */
  constructor(code, message, details = {}) {
    super(String(message ?? code));
    this.name = 'OrbisError';
    const clean = String(code ?? '');
    this.code = CODE_SET.has(clean) ? clean : ORBIS_ERROR_CODES.E_INTERNAL;
    if (this.code !== clean) this.requestedCode = clean;
    this.details = details && typeof details === 'object' ? details : {};
    Error.captureStackTrace?.(this, OrbisError);
  }

  /** 给日志 / JSON 响应用的稳定形状（不包含堆栈与内部字段） */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(Object.keys(this.details).length ? { details: this.details } : {}),
    };
  }
}

/** `new OrbisError(...)` 的短写 */
export function orbisError(code, message, details = {}) {
  return new OrbisError(code, message, details);
}

/** 判断一个值是不是**本模块产出**的类型化错误（不靠鸭子类型的 `code` 字段） */
export function isOrbisError(err) {
  return Boolean(err) && err instanceof OrbisError;
}

/**
 * 老内部错误码 → SDK 契约码。
 *
 * 这些码是运行层/存储层用 `Object.assign(new Error(...), { code })` 抛的；
 * 不要求它们一起改成 `OrbisError`（那是跨层大改），但不能把它们原样漏给宿主 ——
 * 宿主分不清 `NO_ROOM` 和 `EMPTY` 该不该重试。
 */
const LEGACY_CODE_MAP = Object.freeze({
  NO_ROOM: ORBIS_ERROR_CODES.E_NOT_FOUND,
  NO_BOT: ORBIS_ERROR_CODES.E_NOT_FOUND,
  EMPTY: ORBIS_ERROR_CODES.E_INVALID_ARGUMENT,
  REQUEST_GROUP_UNSUPPORTED: ORBIS_ERROR_CODES.E_INVALID_ARGUMENT,
  GRANT_DENIED: ORBIS_ERROR_CODES.E_GRANT_DENIED,
  no_grant: ORBIS_ERROR_CODES.E_GRANT_DENIED,
});

/**
 * 把任意异常翻译成 `OrbisError`（已经是 `OrbisError` 就原样返回）。
 *
 * @param {unknown} err
 * @param {string} [fallbackCode] 翻译不了时用的码（默认 `E_INTERNAL`）
 * @param {object} [details] 追加到 `details` 的上下文（会与 `err.details` 合并）
 */
export function asOrbisError(err, fallbackCode = ORBIS_ERROR_CODES.E_INTERNAL, details = {}) {
  if (isOrbisError(err)) {
    if (!details || !Object.keys(details).length) return err;
    return new OrbisError(err.code, err.message, { ...err.details, ...details });
  }
  const message =
    typeof err === 'string'
      ? err
      : String(err?.message ?? err ?? '未知错误');
  const legacy = String(err?.code ?? '');
  const code = CODE_SET.has(legacy) ? legacy : LEGACY_CODE_MAP[legacy] ?? fallbackCode;
  const merged = { ...(err?.details && typeof err.details === 'object' ? err.details : {}) };
  if (legacy) merged.legacyCode = legacy;
  if (err?.status !== undefined) merged.status = err.status;
  if (err?.payload !== undefined) merged.payload = err.payload;
  return new OrbisError(code, message, { ...merged, ...details });
}
