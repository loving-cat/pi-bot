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
import { mergeGroupModels } from './model-capacity.js';
import { modelFailure } from './model-reply.js';

/** 支持的接口类型。够用就好，不追求全 —— 加错了比不加更糟。 */
export const API_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages'];

function str(v, max = 400) {
  return String(v ?? '').trim().slice(0, max);
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
    const baseUrl = str(input.baseUrl ?? existing?.baseUrl, 400).replace(/\/+$/, '');
    if (!baseUrl) return { error: 'baseUrl 不能为空' };
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { error: 'baseUrl 要以 http:// 或 https:// 开头' };
    }

    const name = str(input.name ?? existing?.name, 60) || '未命名模型组';

    // 支持两种写法：字符串数组，或者带覆盖项的对象数组
    const rawModels = input.models === undefined ? existing?.models ?? [] : input.models;
    const merged = mergeGroupModels(Array.isArray(rawModels) ? rawModels : [], input, existing?.models);
    if (merged.error) return { error: merged.error };
    const models = merged.models;

    const api = API_TYPES.includes(input.api) ? input.api : existing?.api ?? API_TYPES[0];
    // 没改 key 就把老的拿回来（App 拿到的是打码后的，不能拿它覆盖真 key）
    const apiKey = str(input.apiKey, 400) || existing?.apiKey || '';

    return {
      group: new ModelGroup({
        // ★ 优先用调用方给的 id（seedBuiltin 要一个稳定 id，否则每次重启都会
        //   预置出一份新的同内容组）；没给才随机生成。
        id: existing?.id ?? (str(input.id, 60) || newId('mg_')),
        name,
        baseUrl,
        apiKey,
        api,
        models,
        enabled: input.enabled === undefined ? existing?.enabled ?? true : Boolean(input.enabled),
        // 内置组（从本机已有配置里带出来的，比如我们自己在用的 cline 线路）——
        // 不给删：它就是当前跑着的配置，删掉等于把自己踢下线。
        builtin: existing?.builtin ?? Boolean(input.builtin),
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
      builtin: Boolean(this.builtin),
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
      builtin: Boolean(this.builtin),
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
      // 模型级 compat 必填：pi 的 getApiKeyAndHeaders 依据模型上的
      // authHeader / thinkingFormat / supportsReasoningEffort 决定如何附带凭据，
      // 仅设置 provider 级 authHeader 不生效。与 providers.js 中的配置保持一致。
      models: this.models.map((m) => ({
        id: m.id,
        name: m.name,
        input: m.input,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: {
          off: 'minimal',
          minimal: 'minimal',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'high',
          max: 'max',
        },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          thinkingFormat: 'openai',
        },
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
// 连通性测试
// ---------------------------------------------------------------------------

/**
 * 测一下这套 baseUrl + key 通不通。
 *
 * 思路（学 CC Switch 那种"先测一下"）：**能用不花钱的方式测就别花钱**。
 *   1. 先打 `GET /models` —— 标准 OpenAI 兼容接口都有，不消耗 token，还能顺便
 *      拿到模型列表（用户就不用一个个手打了）
 *   2. 有些中转站没实现 /models，才退回一次最小 chat 请求（max_tokens=1）
 *
 * 返回 `{ ok, ms, via, models?, error? }` —— **error 要写人话**：
 * 401 和"地址打不开"是两件事，用户要能一眼知道该改哪个字段。
 */
export async function testModelGroup({
  baseUrl,
  apiKey,
  api = 'openai-completions',
  model,
} = {}) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, error: 'baseUrl 要以 http:// 或 https:// 开头' };
  }
  const key = String(apiKey || '').trim();
  const headers = {
    'user-agent': 'pi-bot/1.0',
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  };
  const t0 = Date.now();

  const withTimeout = async (url, init = {}, ms = 12_000) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('超时')), ms);
    try {
      return await fetch(url, { ...init, signal: ac.signal, redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
  };

  const explain = (status) => {
    if (status === 401 || status === 403) {
      return `认证没过（HTTP ${status}）—— key 填错了，或者这个接口不吃 Bearer`;
    }
    if (status === 404) return `地址不对（HTTP 404）—— 检查 baseUrl 是不是缺/多了一段路径`;
    if (status === 429) return `被限流了（HTTP 429）—— 说明地址和 key 是对的，只是现在太快`;
    return `接口回了 HTTP ${status}`;
  };

  // ① GET /models：不花 token
  let netError = null;
  try {
    const res = await withTimeout(`${base}/models`, { headers });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      const ids = (json?.data ?? json?.models ?? [])
        .map((m) => m?.id ?? m?.name)
        .filter((x) => typeof x === 'string' && x.trim());
      return {
        ok: true,
        ms: Date.now() - t0,
        via: '/models',
        count: ids.length,
        models: ids.slice(0, 60),
        // ★ 实测踩到的：有些中转站的 /models **不校验 key**（假 key 也返回 200
        //   和一大堆模型名）。所以"通了"只说明地址和网络没问题，
        //   不等于 key 有效 —— 这句话必须传给用户，否则他会以为配好了。
        note: '地址通了。注意：部分中转站的 /models 不校验 key，所以这里通过 ≠ key 一定有效',
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, ms: Date.now() - t0, error: explain(res.status) };
    }
    // 其他状态（404/405…）继续往下试 chat
  } catch (err) {
    netError = modelFailure(err).error;
  }

  // ② 最小 chat 请求（一些中转站没有 /models）
  const mid = String(model || '').trim() || 'gpt-4o-mini';
  try {
    const res = await withTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: mid,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    if (res.ok) {
      return {
        ok: true,
        ms: Date.now() - t0,
        via: `chat（用了 ${mid}）`,
      };
    }
    return { ok: false, ms: Date.now() - t0, error: explain(res.status) };
  } catch (err) {
    const e = modelFailure(err).error;
    return {
      ok: false,
      ms: Date.now() - t0,
      error: netError
        ? `连不上：${netError}`
        : `连不上：${e}（地址打不开 / 不是 OpenAI 兼容接口 / 需要代理）`,
    };
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
    const target = this.#groups.find((g) => g.id === id);
    if (target?.builtin) return false; // 内置的不给删
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

  /**
   * 把"本机已经在用的那套配置"带成一个模型组。
   *
   * 用户在 pi 那边早就配好了（~/.pi/agent 里的 provider），App 里却是一张白纸 ——
   * 所以第一次打开设置时，直接把他正在用的东西摆上去，标成「正在用」，不给删。
   * 已经存在同 id 的组就不动（用户自己改过的话不能覆盖）。
   */
  seedBuiltin({ id, name, baseUrl, apiKey, api, models }) {
    this.load();
    if (this.#groups.some((g) => g.id === id || g.name === name)) return null;
    if (!baseUrl || !Array.isArray(models) || !models.length) return null;
    const r = ModelGroup.fromInput(
      { id, name, baseUrl, apiKey, api, models, builtin: true },
      { existing: null },
    );
    if (r.error) return null;
    this.#groups.push(r.group);
    this.save();
    log(`📦 预置模型组：${name}（${models.length} 个模型，正在用，不可删）`);
    return r.group;
  }

  /** 给 model-menu 用 */
  menuEntries() {
    return this.list().filter((g) => g.enabled).flatMap((g) => g.menuEntries());
  }
}

export const modelGroups = new ModelGroupStore();
