import { providerLeaseScope } from './provider-updates.js';
/**
 * 收尾复盘：一轮群聊结束后，从**真实发生的事**里提炼 0~2 条候选经验。
 *
 * ## 为什么是"候选"，不是直接生效
 *
 * 复盘由模型自己写，它一定会有写歪的时候。经验一旦直接影响下一个任务，
 * 一条写歪的经验就是"把错误做法固化下来"。所以：
 *   复盘 → candidate（只进库，不进提示词）→ 用户在设置页点启用 → active
 *
 * ## 这条调用花多少钱
 *
 * 一个**没有工具、没有技能、没有上下文文件**的一次性会话，输入是这一轮对话
 * （截到 6000 字），输出最多几百字。比让主控"顺便想想"便宜且干净 ——
 * 复用主控会话会把复盘内容写进它的聊天记录，下一轮它自己都分不清哪句是干活。
 *
 * ## 没有证据就丢
 *
 * 模型给的 evidence 必须指到这一轮真实存在的 msgId，而且 quote 必须在
 * 那条消息里能找到（去空白后包含）。对不上就整条丢掉 —— 编证据的经验
 * 比没有经验更糟。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

import { config as defaultConfig } from './config.js';
import { readBrandEnv } from './brand.js';
import { store as defaultStore } from './store.js';
import { log } from './util.js';
import { resolveModelFamilyForModel, LESSON_LIMITS } from './lessons.js';
import {
  REFLECT_SYSTEM,
  REFLECT_MAX_CHARS,
  buildReflectInput,
  parseReflectOutput,
  parsePreferenceOutput,
  OUTCOME_SYSTEM,
  buildOutcomeInput,
  parseOutcomeOutput,
} from './lesson-reflect-prompt.js';

export {
  REFLECT_SYSTEM,
  REFLECT_MAX_LESSONS,
  buildReflectInput,
  parseReflectOutput,
} from './lesson-reflect-prompt.js';

/** 同房间两次复盘的最小间隔：防止用户连着发几句就触发一串调用 */
export const REFLECT_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 给蒸馏器的「现有经验目录」：只列 **active** 的 id + 情境（截到 `reflectCatalog` 条）。
 *
 * 抽成函数是因为 build 与 parse 必须用**同一份**目录：模型看到什么，就只许引用什么。
 * 两处各算一次的话，中间删了条经验就会出现“模型看得到、校验不认”的假拒绝。
 */
export function edgeCatalogFor(store, { limit = LESSON_LIMITS.reflectCatalog } = {}) {
  return (store?.lessonLibrary?.() ?? [])
    .filter((l) => l.status === 'active')
    .slice(0, limit)
    .map((l) => ({ id: l.id, cue: l.cue }));
}

/** 复盘调用超时：超了就 abort，别让一个后台任务挂半小时 */
export const REFLECT_TIMEOUT_MS = 60_000;

/**
 * 造一个"只做复盘"的执行器。
 *
 * @param {object} deps
 * @param {object} deps.runner PiRunner（拿 modelRuntime / resolveModel）
 * @param {Function} [deps.logFn]
 */
export function createLessonReflector({ runner, logFn = log, config: scopedConfig = null, store: scopedStore = null } = {}) {
  const config = scopedConfig ?? runner?.config ?? defaultConfig;
  const store = scopedStore ?? runner?.store ?? defaultStore;
  const lastAt = new Map();

  async function reflect({ roomId, sinceIndex = 0, lease = null } = {}) {
    if (readBrandEnv(process.env, 'LESSON_REFLECT') === '0' || config.lessonReflect === false) return { skipped: 'disabled' };

    const room = store.getRoom(roomId);
    if (!room || room.kind !== 'group') return { skipped: 'not-group' };

    const now = Date.now();
    if (now - (lastAt.get(roomId) ?? 0) < REFLECT_MIN_INTERVAL_MS) {
      return { skipped: 'too-soon' };
    }

    const all = store.listMessages(roomId, { limit: 100000 });
    const round = all
      .slice(Math.max(0, sinceIndex + 1))
      .filter((m) => m.status === 'done' && String(m.text ?? '').trim());
    if (!round.some((m) => m.authorType === 'user')) return { skipped: 'no-user' };
    if (round.length < 2) return { skipped: 'too-short' };

    const lead = room.leadBotId ? store.getBot(room.leadBotId) : null;
    const model = runner.resolveModel(lead?.model || '') ?? runner.model;
    if (!model) return { skipped: 'no-model' };
    // 这条经验是**在哪个模型族上跑出来的**：SIM-Lite 跨模型去偏的归因起点。
    // 记的是"实际干活的模型"，不是复盘会话自己的模型。
    const modelFamily = resolveModelFamilyForModel(model);
    lease?.restrictTo(providerLeaseScope(model));

    // 先占坑：即使后面失败，也别在 10 分钟内反复重试烧钱
    lastAt.set(roomId, now);

    const edgeCatalog = edgeCatalogFor(store);
    const { text, ids } = buildReflectInput(round, {
      dept: room.name,
      edgeCatalog,
    });
    if (!text.trim()) return { skipped: 'empty' };

    const byId = new Map(round.map((m) => [m.id, String(m.text ?? '')]));
    let reply = '';
    try {
      ({ reply } = await askIsolated({ systemPrompt: REFLECT_SYSTEM, text, model, tempTag: 'reflect' }));
    } catch (err) {
      logFn?.(`复盘失败：${err?.message || err}`);
      return { skipped: 'error' };
    }

    if (readBrandEnv(process.env, 'REFLECT_DEBUG') === '1') {
      logFn?.(`复盘原文（${reply.length} 字）：${JSON.stringify(reply).slice(0, 1600)}`);
    }

    const candidates = parseReflectOutput(reply, { ids, byId, edgeCatalog });
    if (!candidates.length) {
      logFn?.(`【${room.name}】复盘完成：没有可迁移的经验（NO_ENTRY）`);
      return { added: 0 };
    }

    let added = 0;
    for (const item of candidates) {
      const r = store.addLesson({
        ...item,
        roomId,
        dept: room.name,
        status: 'candidate',
        modelFamily,
      });
      if (!r.error) added++;
    }
    // ★ 同一段输出里可能还有"用户的习惯"（规格 §3.2）。
    //   偏好**直接生效**（不像经验要手工启用）：说错了代价小，用户一句话就能改回来。
    let prefs = 0;
    try {
      for (const p of parsePreferenceOutput(reply)) {
        const r = store.addPreference(p);
        if (r?.added) prefs += 1;
      }
      if (prefs) logFn?.(`【${room.name}】复盘：记录 ${prefs} 条用户习惯`);
    } catch (err) {
      logFn?.(`记录用户习惯失败：${err?.message ?? err}`);
    }

    logFn?.(`【${room.name}】复盘完成：新增 ${added} 条候选经验（待用户启用）`);
    return { added, preferences: prefs };
  }

  /**
   * 一次性隔离会话：没有工具、没有技能、没有上下文文件、不读 AGENTS.md。
   *
   * 复盘（产候选经验）和评估（给注入过的经验打分）都走它 ——
   * 模型只能用我们给的文本回答，不会顺手改工作区、也不会污染主控的聊天记录。
   */
  async function askIsolated({ systemPrompt, text, model, tempTag = 'reflect' }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `orbis-${tempTag}-`));
    let session = null;
    let reply = '';
    try {
      const resourceLoader = new DefaultResourceLoader({
        cwd: config.workspace,
        agentDir: getAgentDir(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt,
      });

      ({ session } = await createAgentSession({
        cwd: config.workspace,
        agentDir: getAgentDir(),
        modelRuntime: runner.modelRuntime,
        model,
        thinkingLevel: 'off',
        noTools: 'all',
        resourceLoader,
        sessionManager: SessionManager.create(config.workspace, tmp),
      }));

      const unsubscribe = session.subscribe((ev) => {
        if (ev?.type === 'message_update' && ev.assistantMessageEvent?.type === 'text_delta') {
          reply += ev.assistantMessageEvent.delta;
        }
      });

      const timer = setTimeout(() => {
        session?.abort?.().catch?.(() => {});
      }, REFLECT_TIMEOUT_MS);
      timer.unref?.();

      try {
        await session.prompt(text);
      } finally {
        clearTimeout(timer);
        unsubscribe();
      }
      return { reply };
    } finally {
      try {
        session?.dispose?.();
      } catch {
        // 已经关了
      }
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // Windows 上可能还有句柄，留给系统清理
      }
    }
  }

  /**
   * 评估「本轮注入过的经验」到底起了什么作用（SIM-Lite 的第二条数据流）。
   *
   * ★ 为什么不能拿这一轮的 ok/fail 记账：
   *   `ok: true` 只说明模型没报错、吐了非空文本 —— 答非所问、把测试改水也是 ok；
   *   `ok: false` 绝大多数是 429 / 超时 / 用户点终止。
   *   拿它们记 win/fail，跑几轮普通聊天就能把所有经验刷成高置信度。
   *   所以胜率只能来自这里（独立评估）、已验收 TaskRun、以及用户否决。
   *
   * 评完立刻清 `entry.lessonsInjected`：不清就会在下一轮被重复计分。
   */
  const lastEvalAt = new Map();
  async function evaluateInjected({ roomId, botId, injected: injectedArg = null } = {}) {
    if (readBrandEnv(process.env, 'LESSON_REFLECT') === '0' || config.lessonReflect === false) {
      return { skipped: 'disabled' };
    }
    const entry = runner.sessions?.get?.(`${roomId}:${botId}`);
    // 调用方（turn-executor 的 finally）会**同步**把快照递过来并清空 entry，
    // 避免下一轮刚开始就把这批 id 覆盖掉。没有快照时才回落到 entry。
    const injected = injectedArg ?? entry?.lessonsInjected;
    if (!injected?.ids?.length) return { skipped: 'no-injection' };

    const now = Date.now();
    if (now - (lastEvalAt.get(roomId) ?? 0) < REFLECT_MIN_INTERVAL_MS) return { skipped: 'too-soon' };

    const ids = new Set(injected.ids);
    const lessons = store.lessonLibrary().filter((l) => ids.has(l.id));
    // ★ 只在"自己从 entry 读的"情况下才负责清：
    //   调用方（turn-executor 的 finally）已经同步摘了快照并清零，
    //   这里再无条件清一次会把**下一轮**刚写进去的快照抹掉（那一轮就永远漏评）；
    //   而且后台排队期间会话可能已被 reset，entry 会是 undefined。
    if (!injectedArg && entry) entry.lessonsInjected = null;
    if (!lessons.length) return { skipped: 'gone' };

    const room = store.getRoom(roomId);
    const bot = botId ? store.getBot(botId) : null;
    const model = runner.resolveModel(bot?.model || '') ?? runner.model;
    if (!model) return { skipped: 'no-model' };
    lastEvalAt.set(roomId, now);

    // ★ 只评估「这批经验被注入之后」发生的事。
    //   直接拉最近 40 条会把更早的无关轮次也喂进去，让评估模型张冠李戴。
    const all = store
      .listMessages(roomId, { limit: 100000 })
      .filter((m) => m.status === 'done' && String(m.text ?? '').trim());
    const since = Number(injected.at || 0) - 5000; // 留 5 秒上文余量
    const recent = since > 0 ? all.filter((m) => (Number(m.createdAt) || 0) >= since) : all.slice(-40);
    // 窗口太短时补上之前的 2 条消息当上下文（否则评估只看得到一两句）
    const before = recent.length < 4 ? all.slice(0, Math.max(0, all.length - recent.length)).slice(-2) : [];
    const round = [...before, ...recent];
    if (!round.length) return { skipped: 'too-short' };
    const { text, ids: allowed } = buildOutcomeInput(round, { lessons });

    let reply = '';
    try {
      ({ reply } = await askIsolated({ systemPrompt: OUTCOME_SYSTEM, text, model, tempTag: 'outcome' }));
    } catch (err) {
      logFn?.(`经验评估失败：${err?.message || err}`);
      return { skipped: 'error' };
    }

    if (readBrandEnv(process.env, 'REFLECT_DEBUG') === '1') {
      logFn?.(`评估原文（${reply.length} 字）：${JSON.stringify(reply).slice(0, 1200)}`);
    }

    const outcomes = parseOutcomeOutput(reply, { ids: allowed });
    if (!outcomes.length) return { applied: 0, ignored: [] };
    const r = store.recordLessonOutcomes(
      outcomes.map((o) => ({ ...o, modelFamily: injected.modelFamily })),
    );
    logFn?.(
      `【${room?.name ?? roomId}】经验评估：${r.applied} 条记账` +
        (r.ignored.length ? `，${r.ignored.length} 条不记（confounded / 找不到）` : '') +
        (r.decayed?.length
          ? `，${r.decayed.length} 条自动降级（同族连续失败：${r.decayed
              .map((d) => `${d.family} ${d.streak} 连败`)
              .join('、')}）`
          : ''),
    );
    return { applied: r.applied, ignored: r.ignored, decayed: r.decayed ?? [] };
  }

  const schedule = (options = {}) => {
    const execute = () => {
      runner.flushProviderUpdates?.();
      return runner.providerUpdates
        ? runner.providerUpdates.withLease((lease) => reflect({ ...options, lease })) : reflect(options);
    };
    return runner.withBackgroundSlot
      ? runner.withBackgroundSlot(`复盘 · ${options.roomId ?? ''}`, execute) : execute();
  };
  // 评估走同一个后台槽位（它也是一次模型调用），但入口独立：
  //   schedule(...)      = 复盘产候选（群聊收尾）
  //   schedule.evaluateInjected({roomId,botId}) = 给"本轮注入过的经验"记 win/fail
  schedule.evaluateInjected = (opts = {}) => {
    const execute = () => {
      runner.flushProviderUpdates?.();
      return runner.providerUpdates
        ? runner.providerUpdates.withLease((lease) => evaluateInjected({ ...opts, lease }))
        : evaluateInjected(opts);
    };
    return runner.withBackgroundSlot
      ? runner.withBackgroundSlot(`评估 · ${opts.roomId ?? ''}`, execute)
      : execute();
  };
  return schedule;
}
