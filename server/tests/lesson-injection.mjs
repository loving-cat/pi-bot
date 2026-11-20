/**
 * 经验注入接线测试（Phase 1 第二刀）。
 *   node tests/lesson-injection.mjs
 *
 * ## 这个文件守什么
 *
 * 1. **模型族与关系边真的接到注入点**：`turn-executor` 的 `withLessons` 必须把
 *    当前模型的族与 `store.lessonEdges()` 传进 `selectLessonsFor`，否则
 *    "同族加成 / 矛盾排除"在真实注入里完全不生效（纯函数测得再好也没用）。
 * 2. **只记 `hit`，不记 `win/fail`**：这一轮 `ok: true` 只说明模型没报错、吐出了
 *    非空文本 —— 答非所问、把测试改水也照样 `ok: true`。拿它当胜率会把
 *    `win` 退化成 `hits` 的马甲，5 轮普通聊天就能把所有经验刷到 0.925。
 *    真正的 `win/fail` 只能来自复盘评估 / 已验收 TaskRun / 用户反馈。
 * 3. **被否决的经验注入不进去**（user 否决边在真实路径上也生效）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-lesson-inject-'));
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
// 用正式名 ORBIS_*：新文件不该再种旧品牌债（`scripts/check-legacy.mjs` 只许变小）
process.env.ORBIS_HOME = root;
process.env.ORBIS_WORKSPACE = path.join(root, 'workspace');
process.env.ORBIS_PROBE = '0';
process.env.ORBIS_LESSON_REFLECT = '0';
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const { store } = await import('../src/store.js');
const { PiRunner } = await import('../src/pi-runner.js');
const { executeTurn } = await import('../src/runner/turn-executor.js');

const MODEL = { provider: 'sensenova', id: 'glm-5.2', contextWindow: 16000, maxTokens: 1000 };
const EVIDENCE = [{ taskId: 't1', msgId: 'm1', quote: '这次这么干是对的' }];

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`✗ ${name}\n  ${err?.stack || err}`);
  }
}

/** 造一个只用一次的 runner：ensureSession 直接返回我们装配好的 entry */
function makeRunner(entry) {
  const runner = new PiRunner();
  runner.model = MODEL;
  runner.modelRuntime = { completeSimple: () => assert.fail('测试不许调模型') };
  runner.memoryAutoDisabled = true;
  runner.ensureSession = async () => entry;
  return runner;
}

/** 跑一轮：session 只吐一段正文，把收到的 prompt 记下来 */
async function runTurn({ roomId, botId, prompt, onPrompt }) {
  const listeners = [];
  const session = {
    model: MODEL,
    subscribe(fn) {
      listeners.push(fn);
      return () => {};
    },
    async abort() {},
    async prompt(text) {
      onPrompt?.(text);
      const emit = (ev) => {
        for (const fn of listeners) fn(ev);
      };
      emit({ type: 'message_start', message: { role: 'assistant' } });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好的' } });
      emit({
        type: 'message_end',
        message: { role: 'assistant', usage: {}, content: [{ type: 'text', text: '好的' }] },
      });
    },
  };
  const entry = {
    bot: store.getBot(botId),
    busy: false,
    session,
    liveMsgId: null,
    turnAmends: [],
    pendingReseat: null,
  };
  const runner = makeRunner(entry);
  runner.sessions.set(`${roomId}:${botId}`, entry);
  const out = await executeTurn(runner, roomId, botId, prompt, { skipUserMessage: true });
  return { out, entry, runner };
}

/** 主控是内置那一个（MAIN_BOT_ID，role 固定 main）；createBot 只能造成员 */
function mainBot() {
  const bot = store.mainBot();
  assert.ok(bot && bot.role === 'main', '内置主控必须存在');
  return bot;
}

await test('LI-1 经验真的被注入，且按当前模型族记 hit（不记 win/fail）', async () => {
  const main = mainBot();
  const dm = store.ensureDm(main.id);
  const { lesson } = store.addLesson({
    cue: 'pytest 权限报错',
    lesson: '用仓内 basetemp 目录',
    evidence: EVIDENCE,
    status: 'active',
    roomId: dm.id,
    modelFamily: 'glm',
  });

  let seen = '';
  const { out } = await runTurn({
    roomId: dm.id,
    botId: main.id,
    prompt: 'pytest 权限报错 怎么修',
    onPrompt: (text) => {
      seen = text;
    },
  });
  assert.equal(out.ok, true, out.error ?? '');
  assert.match(seen, /踩过的坑/, '注入块必须出现');
  assert.match(seen, /仓内 basetemp/, '命中的经验正文必须在提示词里');

  const after = store.lessonLibrary().find((l) => l.id === lesson.id);
  assert.equal(after.hits, 1, '命中记一次');
  assert.equal(after.byFamily.glm?.hit, 1, '按当前模型族记 hit（sensenova/glm-5.2 → glm）');
  assert.equal(after.byFamily.glm?.win ?? 0, 0, '★ 一轮成功≠这条经验有用，绝不能记 win');
  assert.equal(after.byFamily.glm?.fail ?? 0, 0, '更不许记 fail');
});

await test('LI-2 被 user 否决的经验注入不进去（真实路径）', async () => {
  const main = mainBot();
  const dm = store.ensureDm(main.id);
  const { lesson } = store.addLesson({
    cue: '部署脚本注意',
    lesson: '把测试改成永远通过',
    evidence: EVIDENCE,
    status: 'active',
    roomId: dm.id,
  });
  store.rejectLesson(lesson.id);

  let seen = '';
  const { out } = await runTurn({
    roomId: dm.id,
    botId: main.id,
    prompt: '部署脚本注意 怎么做',
    onPrompt: (text) => {
      seen = text;
    },
  });
  assert.equal(out.ok, true, out.error ?? '');
  assert.doesNotMatch(seen, /把测试改成永远通过/, '被否决的经验不许出现在提示词里');
});

await test('LI-3 冲突边在真实路径上也排除（两条经验互斥时都不注入）', async () => {
  const main = mainBot();
  const dm = store.ensureDm(main.id);
  const a = store.addLesson({ cue: '发版前检查', lesson: '先跑全量测试', evidence: EVIDENCE, status: 'active', roomId: dm.id }).lesson;
  const b = store.addLesson({ cue: '发版前检查了', lesson: '只要手动点一下', evidence: EVIDENCE, status: 'active', roomId: dm.id }).lesson;
  const c = store.addLesson({ cue: '发布前检查', lesson: '先跑一遍 smoke 就够', evidence: EVIDENCE, status: 'active', roomId: dm.id }).lesson;
  assert.ok(a && b && c, '三条经验都要建成功');
  assert.ok(store.addLessonEdge({ from: c.id, to: b.id, type: 'contradicts' }).edge);

  let seen = '';
  const { out } = await runTurn({
    roomId: dm.id,
    botId: main.id,
    prompt: '发版前检查 要做什么',
    onPrompt: (text) => {
      seen = text;
    },
  });
  assert.equal(out.ok, true, out.error ?? '');
  // 双向排除：写在 from 的 c 与写在 to 的 b，**两条都不许出现**
  assert.doesNotMatch(seen, /只要手动点一下/, 'contradicts 的 to 侧不许注入');
  assert.doesNotMatch(seen, /先跑一遍 smoke 就够/, 'contradicts 的 from 侧同样不许注入');
  assert.match(seen, /先跑全量测试/, '没被冲突牵连的第三条要正常注入（正向对照）');
  assert.ok(a.id && store.lessonLibrary().some((l) => l.id === a.id));
});

await test('LI-4 非主控（成员）不注入经验（口径不变）', async () => {
  const main = mainBot();
  const member = store.createBot({ name: '成员注入测试' });
  const dm = store.ensureDm(main.id);
  store.addLesson({
    cue: '成员测试情境',
    lesson: '成员不该看到这条',
    evidence: EVIDENCE,
    status: 'active',
    roomId: dm.id,
  });

  let seen = '';
  await runTurn({
    roomId: dm.id,
    botId: member.id,
    prompt: '成员测试情境 做什么',
    onPrompt: (text) => {
      seen = text;
    },
  });
  assert.doesNotMatch(seen, /成员不该看到这条/, '经验只给主控，成员层不注入');
});

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows 上可能还有句柄
}

const failed = results.filter((r) => !r.ok);
console.log(`\nlesson-injection: ${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exit(1);
