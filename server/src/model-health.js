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
  constructor(runner, { ttlMs = TTL_MS } = {}) {
    this.runner = runner;
    /** 探活结果多久算过期（提出来是为了能测：不然要等 24 小时） */
    this.ttlMs = ttlMs;
    /** @type {Record<string, {ok:boolean, ms:number, error:string|null, at:number}>} */
    this.results = {};
    this.running = false;
    this.progress = { done: 0, total: 0 };
    /** 后台重探的防抖定时器 + 待探队列 */
    this.refreshTimer = null;
    this.refreshQueue = new Set();
    this.autoTimer = null;
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

  /**
   * 缓存里新鲜的结果。
   *
   * ★ 过期不等于「挂了」。
   *   以前这里过期就直接 return null，而菜单把「没有任何新鲜结论」当「全员不可用」——
   *   服务连续跑过一天之后，模型菜单全变 ✗、招人/建部门被全部拒掉，
   *   用户以为是模型坏了跑去改配置，其实只是缓存过期了。
   *   现在：过期就排队后台重探（不阻塞调用方），并且不再拿它当死亡结论。
   */
  get(slug) {
    const r = this.results[slug];
    if (!r) return null;
    if (Date.now() - r.at <= this.ttlMs) return r;
    if (!this.running) this.#queueRefresh(slug);
    return null;
  }

  /** 全库有没有**任何**新鲜结论（用来区分「真全挂了」和「全都过期了」） */
  hasFresh() {
    const at = Date.now();
    return Object.values(this.results).some((r) => r && at - r.at <= this.ttlMs);
  }

  /** 有过结论（可能是过期的）：以前能跑，先当能用看待，别把人拦在门外 */
  wasGood(slug) {
    return Boolean(this.results[slug]?.ok);
  }

  /** 这几个 slug 里有没有**新鲜**结论（不管好坏） */
  hasFreshFor(slugs) {
    const at = Date.now();
    return slugs.some((s) => {
      const r = this.results[s];
      return Boolean(r) && at - r.at <= this.ttlMs;
    });
  }

  anyExpired() {
    const at = Date.now();
    return Object.values(this.results).some((r) => r && at - r.at > this.ttlMs);
  }

  /**
   * 攒一批过期条目再重探。
   *
   * 菜单一渲染就会 get() 几十次，一人发一个探活请求会把上游打爆，
   * 所以攒 800ms 合并成一次 runAll（它自己只跑「没有新鲜结果」的那些）。
   */
  #queueRefresh(slug) {
    if (!slug || slug.includes('@')) return; // 档位组合由 runLevelMatrix 单独跑
    this.refreshQueue.add(slug);
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const count = this.refreshQueue.size;
      this.refreshQueue.clear();
      if (!count || this.running) return;
      log(`模型探活：${count} 个结果过期，后台重探`);
      this.runAll().catch((err) => log('⚠️  后台重探失败：', err?.message || err));
    }, 800);
    this.refreshTimer.unref?.();
  }

  /**
   * 定时看一眼有没有过期的，有就补探。
   *
   * 为什么要定时而不能只靠「用到时才发现」：跑一天之后**第一个**问菜单的人
   * 拿到的还是过期数据（虽然现在会当乐观处理，但结论还是不真）。
   * 主动补探之后，用户看到的永远是新鲜结论。
   */
  startAutoRefresh(intervalMs = 60 * 60 * 1000) {
    if (this.autoTimer) return;
    this.autoTimer = setInterval(() => {
      if (this.running || !this.anyExpired()) return;
      log('模型探活：有结果过期了，自动补探');
      this.runAll().catch((err) => log('⚠️  自动补探失败：', err?.message || err));
    }, intervalMs);
    this.autoTimer.unref?.();
  }

  stop() {
    if (this.autoTimer) clearInterval(this.autoTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.autoTimer = null;
    this.refreshTimer = null;
  }

  // ---------- 「模型 × 思考等级」组合探活 ----------
  // 有些组合会静默返回空内容（推理内容把额度用光、正文就是空的），
  // 所以除了探模型活不活，还要探每个档位出不出话。

  static levelKey(slug, level) {
    return `${slug}@${level}`;
  }

  /** 这个组合是不是已知会空 */
  isLevelBad(slug, level) {
    if (!slug || !level) return false;
    const r = this.get(ModelHealth.levelKey(slug, level));
    return Boolean(r && !r.ok);
  }

  /** 已知会空就换一个能用的档位；都没测过就原样返回 */
  safeLevel(slug, wanted) {
    if (!wanted || !this.isLevelBad(slug, wanted)) return wanted;
    const order = ['medium', 'low', 'high', 'off'];
    for (const l of order) {
      if (l === wanted) continue;
      const r = this.get(ModelHealth.levelKey(slug, l));
      if (r?.ok) {
        log(`⚠️  ${slug} 在 ${wanted} 档实测不出话，自动降到 ${l}`);
        return l;
      }
    }
    return wanted;
  }

  async probeLevel(slug, level, timeoutMs = 30_000) {
    const model = this.runner.resolveModel(slug);
    if (!model) return { ok: false, note: '模型不存在' };
    const started = Date.now();
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`超时 ${timeoutMs}ms`)), timeoutMs);
      });
      const reply = await Promise.race([
        this.runner.modelRuntime.completeSimple(
          model,
          { messages: [{ role: 'user', content: '用一句话说明什么是均线。', timestamp: Date.now() }] },
          { maxTokens: 1024, reasoning: level === 'off' ? undefined : level },
        ),
        timeout,
      ]);
      const text = textOf(reply).trim();
      const r = {
        ok: Boolean(text) && !reply?.errorMessage,
        ms: Date.now() - started,
        chars: text.length,
        error: text ? null : (reply?.errorMessage ?? '空回复'),
        at: Date.now(),
      };
      this.results[ModelHealth.levelKey(slug, level)] = r;
      return r;
    } catch (err) {
      const r = { ok: false, ms: Date.now() - started, error: String(err?.message || err).slice(0, 120), at: Date.now() };
      this.results[ModelHealth.levelKey(slug, level)] = r;
      return r;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 只给白名单模型跑档位矩阵（便宜，几秒到几十秒） */
  async runLevelMatrix(slugs, levels = ['off', 'low', 'medium', 'high'], { force = false } = {}) {
    const queue = [];
    for (const slug of slugs) {
      for (const level of levels) {
        if (!force && this.get(ModelHealth.levelKey(slug, level))) continue;
        queue.push([slug, level]);
      }
    }
    if (!queue.length) return { skipped: true };
    log(`档位矩阵探活：${queue.length} 个组合`);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (cursor < queue.length) {
        const [slug, level] = queue[cursor++];
        await this.probeLevel(slug, level);
      }
    });
    await Promise.all(workers);
    this.save();
    const bad = queue.filter(([s, l]) => this.isLevelBad(s, l)).length;
    log(`档位矩阵完成：${queue.length - bad}/${queue.length} 可用`);
    return { total: queue.length, bad };
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
          // reasoning 用 low：有些推理模型不允许关闭思考，传 off 直接 400。
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
