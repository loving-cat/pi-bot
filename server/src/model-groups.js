/**
 * 模型组：用户自己加的一套 `baseUrl + key + 一组 modelId`。
 *
 * OpenAI 兼容接口现在到处都是（中转站、自建 vLLM/Ollama、各家云厂商），
 * 用户不该为了加一个自己的模型去改 pi 的 models.json —— 那是全局的，
 * 而且格式还得现学。
 *
 * ## 为什么收口成一个类
 *
 * 这套数据被三处用到，而三处对"什么算合法"的要求并不一样：
 *
 * | 用处 | 要什么 |
 * |---|---|
 * | 设置页 | 校验、能展示（**key 必须打码**，不能回传给 App） |
 * | 模型菜单 | 变成可选项（alias → pi 认识的 `providerId/modelId`） |
 * | 建会话 | 变成 pi 认识的 `ProviderConfigInput` |
 *
 * 三处各写一遍字段处理，迟早会长歪（最常见的是：打码那处忘了打、
 * 或者默认值三处不一致）。所以形状、校验、转换全部收在这个类里。
 *
 * 落盘在 `<dataDir>/model-groups.json`，和房间/bot 的状态分开 ——
 * 这份东西坏了大不了重新填，不该连累聊天记录。
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { log, newId, now, readJson, writeJsonAtomic } from './util.js';

/** 一个模型没写 contextWindow/maxTokens 时用的兜底值（偏保守，用户可覆盖） */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** 支持的接口类型。够用就好，不追求全 —— 加错了比不加更糟。 */
export const API_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages'];

function str(v, max = 400) {
  return String(v ?? '').trim().slice(0, max);
}

function positiveIntOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** key 打码：只留头尾，中间固定省略号。空就是空，别假装有。 */
export function maskKey(key) {
  const k = str(key, 400);
  if (!k) return '';
  if (k.length <= 10) return `${k.slice(0, 2)}…`;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

export class ModelGroup {
  constructor(data) {
    Object.assign(this, data);
  }

  /**
   * 从用户的输入造一个模型组。
   *
   * @returns {{group: ModelGroup}|{error: string}} —— 故意返回 error 字符串而不是抛异常：
   *   这是"用户填错了"，不是"程序坏了"，调用方要原样显示给用户看。
   */
  static fromInput(input = {}, { existing = null } = {}) {
    const baseUrl = str(input.baseUrl, 400).replace(/\/+$/, '');
    if (!baseUrl) return { error: 'baseUrl 不能为空' };
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { error: 'baseUrl 要以 http:// 或 https:// 开头' };
    }

    const name = str(input.name, 60) || '未命名模型组';

    // 支持两种写法：字符串数组，或者带覆盖项的对象数组
    const rawModels = Array.isArray(input.models) ? input.models : [];
    const seen = new Set();
    const models = [];
    for (const raw of rawModels) {
      const src = typeof raw === 'string' ? { id: raw } : raw || {};
      const id = str(src.id, 200);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const cw = positiveIntOrNull(src.contextWindow) ?? positiveIntOrNull(input.contextWindow);
      const mt = positiveIntOrNull(src.maxTokens) ?? positiveIntOrNull(input.maxTokens);
      models.push({
        id,
        name: str(src.name, 120) || id,
        contextWindow: cw ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: mt ?? DEFAULT_MAX_TOKENS,
        // 默认只声明 text：图片支持各接口差异太大，猜错了会直接把请求打挂
        input: Array.isArray(src.input) && src.input.includes('image')
          ? ['text', 'image']
          : ['text'],
        reasoning: Boolean(src.reasoning),
      });
    }
    if (!models.length) return { error: '至少要给一个 modelId' };

    const api = API_TYPES.includes(input.api) ? input.api : API_TYPES[0];
    // 没改 key 就把老的拿回来（App 拿到的是打码后的，不能拿它覆盖真 key）
    const apiKey = str(input.apiKey, 400) || existing?.apiKey || '';

    return {
      group: new ModelGroup({
        id: existing?.id ?? newId('mg_'),
        name,
        baseUrl,
        apiKey,
        api,
        models,
        enabled: input.enabled === undefined ? true : Boolean(input.enabled),
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
      }),
    };
  }

  static fromJson(json) {
    const r = ModelGroup.fromInput(json, { existing: json });
    return r.group ?? null;
  }

  /** 落盘用（含真 key）—— 只有存盘那一处该用它 */
  toJson() {
    return {
      id: this.id,
      name: this.name,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      api: this.api,
      models: this.models,
      enabled: this.enabled,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /** 发给 App 用 —— **key 一定打码**，真 key 不出服务端 */
  toPublic() {
    return {
      id: this.id,
      name: this.name,
      baseUrl: this.baseUrl,
      api: this.api,
      hasKey: Boolean(this.apiKey),
      keyMasked: maskKey(this.apiKey),
      models: this.models,
      enabled: this.enabled,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /** pi 认识的 provider 配置 */
  toProviderConfig() {
    return {
      name: this.name,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey || 'no-key',
      api: this.api,
      authHeader: true,
      models: this.models.map((m) => ({
        id: m.id,
        name: m.name,
        input: m.input,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    };
  }

  /** pi 里的完整 slug：`<组 id>/<模型 id>` */
  slugFor(modelId) {
    return `${this.id}/${modelId}`;
  }

  /** 变成模型菜单里的一项（每个模型一项） */
  menuEntries() {
    return this.models.map((m) => ({
      alias: `${this.name}/${m.id}`,
      label: `${this.name} · ${m.name}`,
      use: '你自己配的模型组',
      tier: 'custom',
      slugs: [this.slugFor(m.id)],
      custom: true,
      groupId: this.id,
      contextWindow: m.contextWindow,
    }));
  }
}

// ---------------------------------------------------------------------------
// 注册表（落盘 + CRUD）
// ---------------------------------------------------------------------------

class ModelGroupStore {
  #groups = [];
  #loaded = false;

  get file() {
    return path.join(config.dataDir, 'model-groups.json');
  }

  load() {
    if (this.#loaded) return;
    this.#loaded = true;
    const raw = readJson(this.file, null);
    const list = Array.isArray(raw?.groups) ? raw.groups : [];
    this.#groups = list.map(ModelGroup.fromJson).filter(Boolean);
    if (this.#groups.length) log(`📦 载入 ${this.#groups.length} 个自定义模型组`);
  }

  save() {
    writeJsonAtomic(this.file, {
      version: 1,
      groups: this.#groups.map((g) => g.toJson()),
    });
  }

  list() {
    this.load();
    return [...this.#groups];
  }

  /** 给 App 看的（key 打码） */
  listPublic() {
    return this.list().map((g) => g.toPublic());
  }

  get(id) {
    this.load();
    return this.#groups.find((g) => g.id === id) ?? null;
  }

  /** 新增或更新。`id` 为空 = 新增。 */
  upsert(input) {
    this.load();
    const existing = input?.id ? this.get(input.id) : null;
    if (input?.id && !existing) return { error: `找不到模型组 ${input.id}` };
    const r = ModelGroup.fromInput(input, { existing });
    if (r.error) return { error: r.error };
    const group = r.group;
    const idx = this.#groups.findIndex((g) => g.id === group.id);
    if (idx >= 0) this.#groups[idx] = group;
    else this.#groups.push(group);
    this.save();
    return { group };
  }

  remove(id) {
    this.load();
    const before = this.#groups.length;
    this.#groups = this.#groups.filter((g) => g.id !== id);
    if (this.#groups.length === before) return false;
    this.save();
    return true;
  }

  /** 给 providers.js 用：`{ providerId: ProviderConfigInput }` */
  toProviderConfigs() {
    const out = {};
    for (const g of this.list()) {
      if (!g.enabled) continue;
      out[g.id] = g.toProviderConfig();
    }
    return out;
  }

  /** 给 model-menu 用 */
  menuEntries() {
    return this.list().filter((g) => g.enabled).flatMap((g) => g.menuEntries());
  }
}

export const modelGroups = new ModelGroupStore();
