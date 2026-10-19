/**
 * 思考强度：一个模型「会不会思考、各档位映射到上游哪个值、走哪种思考格式」。
 *
 * 为什么单独一层：
 *   1. 上游写法互不兼容 —— deepseek 走独立的 `reasoning_content` 通道，openai 走
 *      `reasoning_effort` 参数，zai 走 `thinking.type`。填错格式不报错，只是**静默
 *      不思考**，从界面上完全看不出来。
 *   2. pi 认的是 `thinkingLevelMap`（off/minimal/low/medium/high/xhigh/max → 上游值）。
 *      映射错一个档位，表现就是"界面选了 high，模型其实没提高"。
 *   3. 这份配置 Windows 与 Mac 共用（同一个服务端），所以不能写死在任何一端的 UI 里，
 *      也不能靠"猜模型名"来推断 —— 猜错就是静默降智。
 *
 * 设计取舍：**默认值只覆盖确定的档位**。拿不准的档位留空（= 不传该档位），
 * 宁可让用户自己填，也不替上游编一个看起来合理、实际无效的值。
 */

/** 上游思考格式。取值必须落在 pi 的 model-config schema 允许的集合内。 */
export const THINKING_FORMATS = [
  'deepseek',
  'openai',
  'zai',
  'qwen',
  'openrouter',
  'together',
  'baseten',
  'ant-ling',
  'string-thinking',
];

/** pi 的七个思考档位（顺序即界面顺序）。 */
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * 各格式的档位默认映射。
 *
 * 只有两种确定的事实：
 *   · `off` 一律映射成 null —— 表示"这个档位不额外传思考参数"；
 *   · 上游确实存在的枚举值才写。
 * 拿不准的（比如 openai 格式没有 xhigh、max）**故意留空**，交给用户显式填。
 */
export const THINKING_PRESETS = {
  // WorkBuddy / DeepSeek 系：独立 reasoning_content 通道，xhigh 走上游的 max
  deepseek: {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'max',
    max: 'max',
  },
  // OpenAI / 兼容中转：reasoning_effort 只有 low/medium/high
  openai: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' },
  // 智谱 GLM：thinking 枚举 + 高段走 max
  zai: {
    off: null,
    minimal: null,
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'max',
    max: 'max',
  },
  // 通义：effort 枚举同 openai 三档
  qwen: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' },
};

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const str = (v, max = 40) => String(v ?? '').trim().slice(0, max);

/** 只认 pi 支持的格式；空/不认识的返回 ''（= 不指定，走 pi 默认）。 */
export function normalizeFormat(value) {
  const format = str(value).toLowerCase();
  return THINKING_FORMATS.includes(format) ? format : '';
}

/**
 * 校验档位映射：键必须是七个档位之一，值必须是字符串或 null。
 *
 * 返回错误文案（给用户看）或 null。
 */
export function thinkingLevelMapError(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'thinkingLevelMap 必须是 {档位: 上游值} 的对象';
  }
  for (const [level, mapped] of Object.entries(value)) {
    if (!THINKING_LEVELS.includes(level)) {
      return `思考档位 ${level} 不认识（可选：${THINKING_LEVELS.join(' / ')}）`;
    }
    if (mapped != null && typeof mapped !== 'string') {
      return `思考档位 ${level} 的上游值必须是字符串，或留空表示不传`;
    }
  }
  return null;
}

/**
 * 把用户输入 / 已存配置 / 格式预设合成一份完整的思考配置。
 *
 * 优先级：本次输入 > 同 id 已存配置 > 该格式的预设 > 不思考。
 * 空字符串（界面上的"留空"）**视同未提供**，这样用户在输入框里清空就等于回退默认，
 * 而不是把上游值写成空串。
 */
export function normalizeThinking(src = {}, previous = {}) {
  const hasReasoning = own(src, 'reasoning');
  const reasoning = hasReasoning
    ? Boolean(src.reasoning)
    : previous.reasoning ?? false;

  const format =
    normalizeFormat(src.thinkingFormat) ||
    normalizeFormat(previous.thinkingFormat) ||
    '';

  // 用户显式给了映射就用它（允许只给几档）；否则回退到该格式的预设
  const previousFormat = normalizeFormat(previous.thinkingFormat) || '';
  // 格式换了一一旧格式的映射对新格式无意义（比如 openai 没有 xhigh），
  // 必须重套预设，否则会静默少一档。
  const formatChanged = format !== '' && format !== previousFormat;
  let map = null;
  if (own(src, 'thinkingLevelMap') && src.thinkingLevelMap != null) {
    map = {};
    for (const [level, mapped] of Object.entries(src.thinkingLevelMap)) {
      const value = mapped == null ? null : str(mapped);
      // 空串 = 这一档不映射（界面上的"留空"）
      if (value != null && value !== '') map[level] = value;
      else if (value === null) map[level] = null;
    }
  } else if (!formatChanged && own(previous, 'thinkingLevelMap') && previous.thinkingLevelMap) {
    map = { ...previous.thinkingLevelMap };
  } else if (reasoning && format) {
    map = { ...(THINKING_PRESETS[format] ?? {}) };
  }

  const thinking = { reasoning };
  if (!reasoning) {
    // 不支持思考的模型留着格式/映射没有意义，反而会让 pi 去发思考参数
    thinking.thinkingFormat = '';
    thinking.thinkingLevelMap = null;
    return thinking;
  }
  // 只在真有值时才写字段：早期配置只有 reasoning、没有格式，
  // 凭空补一个空格式会把"没声明格式"改成"声明了空格式"。
  if (format) thinking.thinkingFormat = format;
  if (map) thinking.thinkingLevelMap = map;
  return thinking;
}

/**
 * 转成 pi 认识的 `compat` 片段。
 *
 * 注意：pi 的 `getApiKeyAndHeaders` 依据**模型级** compat 决定怎么附带凭据和思考参数，
 * provider 级写了不生效（这一点在 model-groups.js 里已经踩过一次）。
 */
export function thinkingCompat(thinking = {}) {
  if (!thinking.reasoning) {
    return { supportsReasoningEffort: false };
  }
  return {
    supportsReasoningEffort: true,
    ...(thinking.thinkingFormat ? { thinkingFormat: thinking.thinkingFormat } : {}),
  };
}

/** 界面/日志用的简短描述，例如 `deepseek · high→max`。 */
export function describeThinking(thinking = {}) {
  if (!thinking.reasoning) return '不思考';
  const format = thinking.thinkingFormat || '默认格式';
  const map = thinking.thinkingLevelMap ?? {};
  const mapped = THINKING_LEVELS.filter((level) => own(map, level)).length;
  return mapped ? `${format} · ${mapped} 档` : format;
}

/**
 * 这个模型**实际可选**的思考档位。
 *
 * 前台那段胶囊/侧边栏要按这个来渲染：后台关掉思考 → 返回空数组 → 前台不展示档位；
 * 只映射了部分档位 → 前台只给这几档，避免选了一个后台根本不传参的档位。
 *
 * `off` 永远算可选（它就是“不思考”），但只有在模型开着 reasoning 时才出现在列表里。
 */
export function availableThinkingLevels(thinking = {}) {
  if (!thinking.reasoning) return [];
  const map = thinking.thinkingLevelMap;
  // 没给映射 = 七个档位都原样透传
  if (!map || typeof map !== 'object') return [...THINKING_LEVELS];
  // 和 pi 的 getSupportedThinkingLevels 保持同一套判断，只有一处不同：
  //   · pi 把 `off: null` 当成"不支持 off"，选 off 会被 clamp 到 minimal；
  //   · 这里把 off **永远算可选**（它就是"不思考"，没有理由关掉），
  //     至于下发时传不传参数由 pi 按 map 决定。
  // xhigh / max 是 pi 的扩展档：**必须显式映射**才认为支持，
  // 否则会静默 clamp 到 high（用户会以为选了 max，其实没生效）。
  return THINKING_LEVELS.filter((level) => {
    // off 永远可选（"不思考"没有理由被映射表关掉）。
    // 其余档位仍按映射表来：没写 = 这个模型不支持，别让用户选了一个
    // 后台根本不传参的档位（尤其是 xhigh / max，pi 会静默 clamp 到 high）。
    if (level === 'off') return true;
    return own(map, level) && map[level] !== null;
  });
}

/**
 * 档位可选的上游值。
 *
 * 上游可用的取值就那几种（low/medium/high/max 之类），让用户从下拉里选，
 * 而不是手打 —— 手打一个上游不认识的词（比如给 `off` 填 `on`）不会报错，
 * 只会让这一档静默失效，正是要防的那种错。
 */
export const THINKING_UPSTREAM_VALUES = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
];
