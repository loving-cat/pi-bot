/**
 * SIM-Lite 反向不变量（`docs/ROADMAP-2.0.md` §5.8 的 I0–I5）。
 *   node tests/lessons-invariants.mjs
 *
 * ## 这个文件守什么
 *
 * 经验系统最危险的退化不是崩溃，而是**慢慢长出第二套**：第二个存储、第二个注入点、
 * 第二个设置面板、第二个"经验"名字。这种回归不会报错，只会静默出错 —— 两套数据
 * 各记一半，界面看起来一切正常。所以这里用静态扫描 + 少量运行期断言把它钉死：
 *
 *   I0 一处存储 / 一个注入点 / 没有 experience 命名空间
 *   I1 打分、蒸馏、渲染、淘汰四个模块零 IO（并且真的在 check-style 的纯模块名单里）
 *   I2 经验只在**一轮收口**写，turn 执行期间一次都不写
 *   I3 经验是文本参考（标题写明"是经验，不是硬规则"）
 *   I4 权限模块不许依赖经验模块（反向也不行）
 *   I5 可关可清：lessonReflect=false 直接 no-op；删掉后预览立刻变空
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-lesson-invariants-'));
process.env.HOME = path.join(root, 'home');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.ORBIS_HOME = root;
process.env.ORBIS_WORKSPACE = path.join(root, 'workspace');
process.env.ORBIS_PROBE = '0';
// 让 I5 测的是 config 开关本身（env 开关由另一条断言覆盖）
process.env.ORBIS_LESSON_REFLECT = '1';
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
globalThis.fetch = () => {
  throw new Error('测试期间不允许联网');
};

const SERVER_DIR = path.resolve(import.meta.dirname, '..');
const SRC = path.join(SERVER_DIR, 'src');
const STYLE = path.join(SERVER_DIR, '..', 'scripts', 'check-style.mjs');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const srcFiles = walk(SRC).sort();
const rel = (file) => path.relative(SRC, file).split(path.sep).join('/');
const code = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');
const importSpecs = (file) =>
  [...code(file).matchAll(/^\s*import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

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

// ---------------------------------------------------------------------------
// I0：一处存储 / 一个注入点 / 没有第二套命名空间
// ---------------------------------------------------------------------------
await test('I0-1 经验与关系边只持久化在 store 一处（state.lessons / state.lessonEdges）', () => {
  const writesLessons = srcFiles
    .filter((f) => /state\.lessons\s*=[^=]/.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(writesLessons, ['store.js'], '只允许 store.js 写经验库');

  const writesEdges = srcFiles
    .filter((f) => /state\.lessonEdges\s*=[^=]/.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(writesEdges, ['store.js'], '边也只能和 lessons 同住一处（不新建第二个文件）');

  // 第二套账本连名字都不许出现
  for (const file of srcFiles) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/state\.experience\b|state\.lessons2|state\.experiences\b/.test(text), `${rel(file)} 出现了第二套经验账本`);
  }
});

await test('I0-2 渲染函数只有一处定义，注入点唯一；preview 只做只读展示', () => {
  const definers = srcFiles.filter((f) => /export\s+function\s+lessonsPromptLines/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(definers, ['lessons.js'], '渲染口径必须单一事实源');

  const callers = srcFiles.filter((f) => /lessonsPromptLines\s*\(/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert.deepEqual(
    callers.sort(),
    ['http.js', 'lessons.js', 'runner/turn-executor.js', 'sdk/index.js'],
    '新增调用点就是在新增注入点，必须回来改规格',
  );

  // 真正的"把经验塞进提示词"只有一个地方：turn-executor 的 withLessons
  const withLessons = srcFiles
    .filter((f) => /function\s+withLessons\b|const\s+withLessons\s*=/.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(withLessons, ['runner/turn-executor.js'], '注入点必须唯一（成员层也不许再开一个）');

  // http 的那一处必须在 preview 路由里（只给人看，不注入）
  assert.match(
    code('http.js'),
    /\/api\/lessons\/preview[\s\S]{0,900}lessonsPromptLines/,
    'http 只允许在 /api/lessons/preview 里渲染',
  );
  // sdk 的那一处必须在 lessons.preview 门面里
  assert.match(
    code('sdk/index.js'),
    /preview:\s*\(task[\s\S]{0,900}lessonsPromptLines/,
    'sdk 只允许在 lessons.preview 里渲染',
  );
});

await test('I0-3 没有 experience 命名空间（别名只做转发，不新增实现）', () => {
  const named = srcFiles.map(rel).filter((f) => /experience/i.test(f));
  assert.deepEqual(named, [], '不许新建 experience 模块/面板；要改名只能给 runtime.lessons 加别名');
});

// ---------------------------------------------------------------------------
// I1：四个核心模块零 IO，且真的被 check-style 管住
// ---------------------------------------------------------------------------
await test('I1 打分 / 蒸馏 / 渲染 / 淘汰四个模块零 IO，并在 PURE_MODULES 名单里', () => {
  for (const file of ['lessons.js', 'lesson-reflect-prompt.js']) {
    const specs = importSpecs(file);
    for (const spec of specs) {
      assert.ok(
        !/(^|\/)(store|config)\.js$|^node:(fs|child_process|http|https|net)$/.test(spec),
        `${file} 不许引入 IO/状态依赖（${spec}）`,
      );
    }
  }

  const style = fs.readFileSync(STYLE, 'utf8');
  for (const file of ["'lessons.js'", "'lesson-reflect-prompt.js'"]) {
    assert.ok(style.includes(file), `check-style 的 PURE_MODULES 必须包含 ${file}，否则零 IO 只是口号`);
  }
});

// ---------------------------------------------------------------------------
// I2：经验只在一轮收口写
// ---------------------------------------------------------------------------
await test('I2-1 复盘只在一轮收口触发一次（group-orchestrator，且受 lessonsEnabled 守卫）', () => {
  const callers = srcFiles
    .filter((f) => /runner\.reflect\?\.\(/.test(fs.readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(callers, ['runner/group-orchestrator.js'], '复盘触发点必须唯一');

  const orchestrator = code('runner/group-orchestrator.js');
  assert.match(
    orchestrator,
    /lessonsEnabled\(\)[\s\S]{0,240}runner\.reflect\?\.\(/,
    '触发前必须过开关：关掉就整条链路 no-op',
  );
  assert.ok(
    !/message_update[\s\S]{0,600}runner\.reflect/.test(orchestrator),
    'delta 期不许触发复盘（半句话写出来的经验是毒）',
  );
});

await test('I2-2 跑一轮对话期间一次都不写经验（只可能由收口复盘写）', async () => {
  const { store } = await import('../src/store.js');
  const { PiRunner } = await import('../src/pi-runner.js');
  const { executeTurn } = await import('../src/runner/turn-executor.js');

  const MODEL = { provider: 'sensenova', id: 'glm-5.2', contextWindow: 16000, maxTokens: 1000 };
  const listeners = [];
  const session = {
    model: MODEL,
    subscribe(fn) {
      listeners.push(fn);
      return () => {};
    },
    async abort() {},
    async prompt() {
      const emit = (ev) => listeners.forEach((fn) => fn(ev));
      emit({ type: 'message_start', message: { role: 'assistant' } });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好的' } });
      emit({ type: 'message_end', message: { role: 'assistant', usage: {}, content: [{ type: 'text', text: '好的' }] } });
    },
  };
  const main = store.mainBot();
  const dm = store.ensureDm(main.id);
  const entry = { bot: main, busy: false, session, liveMsgId: null, turnAmends: [], pendingReseat: null };
  const runner = new PiRunner();
  runner.model = MODEL;
  runner.modelRuntime = { completeSimple: () => assert.fail('测试不许调模型') };
  runner.memoryAutoDisabled = true;
  runner.ensureSession = async () => entry;
  runner.sessions.set(`${dm.id}:${main.id}`, entry);

  const original = store.addLesson.bind(store);
  let writes = 0;
  store.addLesson = (...args) => {
    writes += 1;
    return original(...args);
  };
  try {
    const out = await executeTurn(runner, dm.id, main.id, '随便说句话', { skipUserMessage: true });
    assert.equal(out.ok, true, out.error ?? '');
  } finally {
    store.addLesson = original;
  }
  assert.equal(writes, 0, 'turn 执行期写经验 = 把半成品当结论，绝不允许');
});

// ---------------------------------------------------------------------------
// I3：经验是文本参考，不是可执行规则
// ---------------------------------------------------------------------------
await test('I3 注入块标题写明「是经验，不是硬规则」，且不夹带可执行片段', async () => {
  const { lessonsPromptLines, normalizeLesson } = await import('../src/lessons.js');
  const lesson = normalizeLesson(
    {
      cue: '跑测试时',
      lesson: '用仓内 basetemp 目录',
      verdict: 'helped',
      status: 'active',
      evidence: [{ msgId: 'm1', quote: '这样跑就好了' }],
    },
    1,
  );
  const lines = lessonsPromptLines([lesson]);
  assert.match(lines[0], /是经验，不是硬规则/, '标题是给人看的安全阀，改了就不再是"参考"');
  assert.match(lines[0], /跟当前任务无关就忽略/);
  assert.ok(!lines.join('\n').includes('```'), '不许塞代码块：那会诱导模型直接照抄命令');
});

// ---------------------------------------------------------------------------
// I4：权限模块与经验模块互不依赖
// ---------------------------------------------------------------------------
await test('I4 权限层不依赖经验模块，经验模块也不依赖权限层', () => {
  for (const file of ['grants.js', 'policy-hook.js']) {
    for (const spec of importSpecs(file)) {
      assert.ok(!/lesson/i.test(spec), `${file} 不许依赖经验模块（${spec}）`);
    }
  }
  for (const file of ['lessons.js', 'lesson-reflect.js', 'lesson-reflect-prompt.js']) {
    for (const spec of importSpecs(file)) {
      assert.ok(!/grants|policy-hook/.test(spec), `${file} 不许反向依赖权限层（${spec}）`);
    }
  }
});

// ---------------------------------------------------------------------------
// I5：可关可清
// ---------------------------------------------------------------------------
await test('I5-1 lessonReflect=false → 复盘直接 no-op（不调模型、不落盘）', async () => {
  const { createLessonReflector } = await import('../src/lesson-reflect.js');
  let modelCalls = 0;
  const reflector = createLessonReflector({
    runner: {
      config: { lessonReflect: false },
      model: null,
      get modelRuntime() {
        modelCalls += 1;
        return null;
      },
    },
    config: { lessonReflect: false },
    store: { getRoom: () => ({ id: 'r1', kind: 'group', name: '一组' }) },
    logFn: () => {},
  });
  const out = await reflector({ roomId: 'r1' });
  assert.equal(out.skipped, 'disabled');
  assert.equal(modelCalls, 0, '关掉之后连模型总线都不该摸');
});

await test('I5-2 删掉经验后 preview 立刻变空（不缓存、不留幽灵）', async () => {
  const { store } = await import('../src/store.js');
  const { selectLessonsFor } = await import('../src/lessons.js');
  const { lesson } = store.addLesson({
    cue: 'I5 可清案的情境',
    lesson: 'I5 可清案的做法',
    evidence: [{ msgId: 'm1', quote: '这样就行' }],
    status: 'active',
  });
  const picked = () => selectLessonsFor(store.lessonLibrary(), 'I5 可清案的情境', { edges: store.lessonEdges() });
  assert.ok(picked().some((l) => l.id === lesson.id), '启用后应该挑得到');
  store.removeLesson(lesson.id);
  assert.equal(picked().length, 0, '删了就必须立刻消失');
});

try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows 上可能还有句柄，忽略
}

const failed = results.filter((r) => !r.ok);
console.log(`\nlessons-invariants: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
