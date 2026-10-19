/** 模型元数据合并与容量校验；仅处理传入的配置，不推断接口真实能力。 */
import { normalizeThinking, thinkingLevelMapError } from './model-thinking.js';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const integer = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function capacityError(value, fallback = {}, { allowNull = false } = {}) {
  for (const key of ['contextWindow', 'maxTokens', 'reserveTokens', 'keepRecentTokens']) {
    if (!own(value, key)) continue;
    if (allowNull && value[key] == null) continue;
    if (!integer(value[key])) return `${key} 必须是正整数`;
  }
  const context = value.contextWindow ?? fallback.contextWindow;
  const output = value.maxTokens ?? fallback.maxTokens;
  if (context != null && output != null && output > context) {
    return 'maxTokens 不能大于 contextWindow';
  }
  return null;
}

/** 优先级：本次模型覆盖 > 本次组级覆盖 > 同 id 已存元数据 > 新模型默认值。 */
export function mergeGroupModels(rawModels, group = {}, previous = []) {
  const groupError = capacityError(group);
  if (groupError) return { error: groupError };
  const saved = new Map(previous.map((model) => [model.id, model]));
  const models = [];
  const seen = new Set();
  for (const raw of rawModels) {
    const src = typeof raw === 'string' ? { id: raw } : raw ?? {};
    const id = String(src.id ?? '').trim().slice(0, 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const error = capacityError(src);
    if (error) return { error };
    const old = saved.get(id) ?? {};
    // 旧模型上根本没有思考字段时（早期配置）不要凭空长出新字段，
    // 否则"只改容量"会把模型对象改写成另一份形状。
    const hadThinking =
      own(old, 'reasoning') || own(old, 'thinkingFormat') || own(old, 'thinkingLevelMap');
    const wantsThinking =
      own(src, 'reasoning') || own(src, 'thinkingFormat') || own(src, 'thinkingLevelMap');
    const model = {
      id,
      name: own(src, 'name') ? String(src.name ?? '').trim().slice(0, 120) || id : old.name ?? id,
      contextWindow: src.contextWindow ?? group.contextWindow ?? old.contextWindow ?? 128_000,
      maxTokens: src.maxTokens ?? group.maxTokens ?? old.maxTokens ?? 8_192,
      input: own(src, 'input') ? (Array.isArray(src.input) && src.input.includes('image')
        ? ['text', 'image'] : ['text']) : old.input ?? ['text'],
      // 思考强度：会不会思考 / 各档位映射 / 用哪种上游格式（只有涉及的模型才带）
      ...(hadThinking || wantsThinking ? normalizeThinking(src, old) : {}),
    };
    const thinkingError = thinkingLevelMapError(model.thinkingLevelMap);
    if (thinkingError) return { error: `模型 ${id}：${thinkingError}` };
    const mergedError = capacityError(model);
    if (mergedError) return { error: mergedError };
    models.push(model);
  }
  return models.length ? { models } : { error: '至少要给一个 modelId' };
}
