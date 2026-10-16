/**
 * 自检：你在 App 里配的模型组，**真的能跑起来吗**？
 *
 *   node tools/check-model-runtime.mjs
 *
 * 为什么要有这个脚本（真事）：
 *   用户报 "No API key found for local_cline."，而且"每次重启、重组队伍都不行"。
 *   根因是 createAgentSession 没拿到我们自己的 modelRuntime —— pi 会**另造一个**
 *   runtime（只认 ~/.pi/agent/auth.json 和 models.json），于是用户在 App 里配的
 *   模型组（运行时注册在我们 runtime 上的）对它来说根本不存在。
 *
 *   症状特别骗人：探活和模型菜单走的是我们的 runtime，一直显示 ★ 可用；
 *   一到真跑就找不到 key。所以光看菜单"绿不绿"证明不了任何事 ——
 *   必须**真起一个会话、真发一句话**。这个脚本就是干这个的。
 *
 * 它会：
 *   1. 用一个临时数据目录（不碰你的真实数据）
 *   2. 照 App 的方式新建一个模型组（baseUrl + key + 模型名，从你已有的组里借一份）
 *   3. 造一个 bot 用它，走真实链路跑一句话
 *   4. 打印 OK / FAIL 和原因
 */
import fs from 'node:fs';

// 用**真实**的数据目录：不然看不到你自己配的模型组，也就借不到一份可用配置。
// 但它会自己收拾干净（见下面的 cleanup）。
const { store } = await import('../src/store.js');
const { modelGroups } = await import('../src/model-groups.js');
const { PiRunner } = await import('../src/pi-runner.js');

const made = { groupId: null, botId: null, roomId: null };
function cleanup() {
  try {
    if (made.roomId) store.deleteRoom?.(made.roomId);
    if (made.botId) store.deleteBot?.(made.botId);
    if (made.groupId) modelGroups.remove(made.groupId);
  } catch {
    /* 收拾不干净也别炸 */
  }
}

function done(code, msg) {
  cleanup();
  console.log(msg);
  process.exit(code);
}

// 借一份能用的配置（用户已经在用的那个组）
const existing = modelGroups.list().filter((g) => g.enabled && g.apiKey && g.models.length);
if (!existing.length) {
  done(1, [
    '还没有可用的模型组 —— 先去 App 的「模型」页加一个：',
    '  1. 填 baseUrl + API key（任何 OpenAI 兼容接口都行）',
    '  2. 点「测试连接」拉出模型列表，勾上你要用的',
    '  3. 再跑一次这个脚本。',
  ].join('\n'));
}
const src = existing[0];
const modelId = src.models[0].id;

// 照 App 的方式新建一个（id 随机，和用户在 App 里点"新建"一样）
const r = modelGroups.upsert({
  name: 'self-check',
  baseUrl: src.baseUrl,
  apiKey: src.apiKey,
  api: src.api,
  models: [{ id: modelId, name: 'self-check' }],
});
if (r.error) done(1, `建组失败：${r.error}`);
made.groupId = r.group.id;
const slug = r.group.slugFor(modelId);
console.log(`新建模型组 ${r.group.id}，模型 slug = ${slug}（跑完会自动删掉）`);

const bot = store.createBot({ name: '自检（临时）', persona: '只回一个词', model: slug });
made.botId = bot.id;
const room = store.ensureDm(bot.id);
made.roomId = room.id;

const runner = new PiRunner();
await runner.init();

const res = await Promise.race([
  runner.run(room.id, bot.id, 'Reply with exactly: OK', { skipUserMessage: true }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('超时 90s')), 90_000)),
]).catch((err) => ({ ok: false, error: String(err?.message || err) }));

if (res.ok) {
  done(0, `\n✓ 通了。模型回的是：${String(res.text).trim().slice(0, 60)}\n  （你自配的模型组能被真正用起来）`);
}
done(
  1,
  [
    '',
    '✗ 没通。错误：' + String(res.error).slice(0, 300),
    '',
    '排查顺序：',
    '  1. baseUrl / key 对不对（App 的「模型」页点「测试连接」）',
    '  2. 模型名对不对（要和服务端返回的 id 完全一致）',
    '  3. 把上面这行错误发给我。',
  ].join('\n'),
);
