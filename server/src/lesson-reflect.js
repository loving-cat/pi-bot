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

import { config } from './config.js';
import { store } from './store.js';
import { log } from './util.js';
import {
  REFLECT_SYSTEM,
  REFLECT_MAX_CHARS,
  buildReflectInput,
  parseReflectOutput,
} from './lesson-reflect-prompt.js';

export {
  REFLECT_SYSTEM,
  REFLECT_MAX_LESSONS,
  buildReflectInput,
  parseReflectOutput,
} from './lesson-reflect-prompt.js';

/** 同房间两次复盘的最小间隔：防止用户连着发几句就触发一串调用 */
export const REFLECT_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** 复盘调用超时：超了就 abort，别让一个后台任务挂半小时 */
export const REFLECT_TIMEOUT_MS = 60_000;

/**
 * 造一个"只做复盘"的执行器。
 *
 * @param {object} deps
 * @param {object} deps.runner PiRunner（拿 modelRuntime / resolveModel）
 * @param {Function} [deps.logFn]
 */
export function createLessonReflector({ runner, logFn = log } = {}) {
  const lastAt = new Map();

  return async function reflect({ roomId, sinceIndex = 0 } = {}) {
    if (process.env.PI_BOT_LESSON_REFLECT === '0') return { skipped: 'disabled' };

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

    // 先占坑：即使后面失败，也别在 10 分钟内反复重试烧钱
    lastAt.set(roomId, now);

    const { text, ids } = buildReflectInput(round, { dept: room.name });
    if (!text.trim()) return { skipped: 'empty' };

    const byId = new Map(round.map((m) => [m.id, String(m.text ?? '')]));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-reflect-'));
    let session;
    let reply = '';
    try {
      const resourceLoader = new DefaultResourceLoader({
        cwd: config.workspace,
        agentDir: getAgentDir(),
        // 复盘不需要任何外挂：没有工具、没有技能、没有 AGENTS.md
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: REFLECT_SYSTEM,
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
    } catch (err) {
      logFn?.(`复盘失败：${err?.message || err}`);
      return { skipped: 'error' };
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

    if (process.env.PI_BOT_REFLECT_DEBUG === '1') {
      logFn?.(`复盘原文（${reply.length} 字）：${JSON.stringify(reply).slice(0, 1600)}`);
    }

    const candidates = parseReflectOutput(reply, { ids, byId });
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
      });
      if (!r.error) added++;
    }
    logFn?.(`【${room.name}】复盘完成：新增 ${added} 条候选经验（待用户启用）`);
    return { added };
  };
}
