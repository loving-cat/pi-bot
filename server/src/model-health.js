/**
 * 模型探活。
 *
 * 本机 models.json 里挂着 110+ 个模型，但真能用的没几个（key 过期、网关挂了、
 * 模型下线都会表现为"静默空回复"或超时）。主控要靠 list_models 选模型，
 * 如果它挑到一个死的，整个派活链路就卡死 5 分钟。
 *
 * 所以：启动后在后台挨个发一句最短的话探活，结果缓存 24 小时；
 * list_models 只把活的排在前面，create_bot 也会拦掉已知死掉的模型。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './util.js';

const FILE = path.join(config.dataDir, 'model-health.json');
const TTL_MS = 24 * 3600 * 1000;

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === 'text')
      .map((p) => p.text ?? '')
      .join('');
  }
  return '';
}

export class ModelHealth {
  constructor(runner) {
    this.runner = runner;
    /** @type {Record<string, {ok:boolean, ms:number, error:string|null, at:number}>} */
    this.results = {};
    this.running = false;
    this.progress = { done: 0, total: 0 };
    this.load();
  }

  load() {
    try {
      this.results = JSON.parse(fs.readFileSync(FILE, 'utf8')) ?? {};
    } catch {
      this.results = {};
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.results, null, 2));
    } catch (err) {
      log('⚠️  写 model-health.json 失败：', err?.message || err);
    }
  }

  /** 缓存里新鲜的结果 */
  get(slug) {
    const r = this.results[slug];
    if (!r) return null;
    if (Date.now() - r.at > TTL_MS) return null;
    return r;
  }

  isKnownDead(slug) {
    const r = this.get(slug);
    return Boolean(r && !r.ok);
  }

  isKnownGood(slug) {
    const r = this.get(slug);
    return Boolean(r && r.ok);
  }

  async probe(slug, timeoutMs = 25_000) {
    const model = this.runner.resolveModel(slug);
    if (!model) {
      const r = { ok: false, ms: 0, error: '模型不存在', at: Date.now() };
      this.results[slug] = r;
      return r;
    }
    const started = Date.now();
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`超时 ${timeoutMs}ms`)), timeoutMs);
      });
      const reply = await Promise.race([
        this.runner.modelRuntime.completeSimple(
          model,
          { messages: [{ role: 'user', content: '回复两个字：你好', timestamp: Date.now() }] },
          // maxTokens 要给够：推理型模型的思考内容会先把小额度吃掉，
          // 剩下的正文就是空 → 会被误判成「模型挂了」。
          // reasoning 用 low：有些模型（如 glm-5.3）不允许关闭思考，传 off 直接 400。
          { maxTokens: 512, reasoning: 'low' },
        ),
        timeout,
      ]);
      const text = textOf(reply).trim();
      const r = {
        ok: Boolean(text) && !reply?.errorMessage,
        ms: Date.now() - started,
        error: text ? null : (reply?.errorMessage ?? '空回复'),
        at: Date.now(),
      };
      this.results[slug] = r;
      return r;
    } catch (err) {
      const r = {
        ok: false,
        ms: Date.now() - started,
        error: String(err?.message || err).slice(0, 180),
        at: Date.now(),
      };
      this.results[slug] = r;
      return r;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 后台把所有模型跑一遍；只跑没新鲜结果的（force 可强制重跑） */
  async runAll({ concurrency = 6, force = false, timeoutMs = 25_000 } = {}) {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      const all = this.runner.availableModels.map((m) => `${m.provider}/${m.id}`);
      const queue = force ? all : all.filter((slug) => !this.get(slug));
      this.progress = { done: 0, total: queue.length };
      if (!queue.length) {
        log('模型探活：缓存都是新的，跳过');
        return { skipped: true };
      }
      log(`模型探活：开始，${queue.length}/${all.length} 个待测（并发 ${concurrency}）`);
      let cursor = 0;
      let healthy = 0;
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (cursor < queue.length) {
          const slug = queue[cursor++];
          const r = await this.probe(slug, timeoutMs);
          if (r.ok) healthy++;
          this.progress.done++;
          if (this.progress.done % 10 === 0) {
            this.save();
            log(`模型探活：${this.progress.done}/${queue.length}，活的 ${healthy} 个`);
          }
        }
      });
      await Promise.all(workers);
      this.save();
      log(`模型探活完成：${healthy}/${queue.length} 个可用`);
      return { healthy, total: queue.length };
    } finally {
      this.running = false;
      this.save();
    }
  }

  /** 给主控看的排序：活的、便宜、有思考等级的排前面 */
  ranked() {
    const list = [...this.runner.availableModels];
    const score = (m) => {
      const slug = `${m.provider}/${m.id}`;
      const h = this.get(slug);
      const alive = h ? (h.ok ? 0 : 2) : 1;
      return alive * 1000 + (m.cost?.input ?? 99) * 10 + (h?.ok ? (h.ms ?? 9999) / 10000 : 0);
    };
    return list.sort((a, b) => score(a) - score(b));
  }
}
