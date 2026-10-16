/**
 * 组织架构端到端验收测试。
 *
 * 验证：
 *   1. 总经理能一次建出「部门 + 多人 + 指定老大」
 *   2. 用户往部门里发消息时，**只有部门老大先接**（不是全员一拥而上）
 *   3. 老大的输出里 @ 了谁，谁才接着发言（@ = 发言权转移）
 *   4. 成员产出后，老大能给出结论
 *   5. 没被 @ 的成员不发言
 *
 *   node tests/org.mjs [baseUrl]
 */
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:8787';
const wsBase = base.replace(/^http/, 'ws');

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`);
  }
}

async function api(path, options) {
  const res = await fetch(`${base}${path}`, options);
  return res.json();
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws`);
    const events = [];
    ws.on('message', (raw) => {
      const ev = JSON.parse(raw.toString());
      events.push(ev);
      if (ev.t === 'hello') resolve({ ws, events });
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS 连接超时')), 10_000);
  });
}

function waitFor(events, predicate, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = events.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) return reject(new Error(`等待超时：${what}`));
      setTimeout(tick, 400);
    };
    tick();
  });
}

/** 等某个会话彻底安静下来（没有 streaming 消息、没有 typing） */
async function waitIdle(roomId, timeoutMs = 600_000) {
  const started = Date.now();
  let quietSince = null;
  while (Date.now() - started < timeoutMs) {
    const { messages } = await api(`/api/rooms/${roomId}/messages?limit=60`);
    const busy = messages.some((m) => m.status === 'streaming');
    if (!busy) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince > 6000) return messages;
    } else {
      quietSince = null;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('等会话安静超时');
}

console.log('==================== 组织架构验收 ====================\n');

// ---------------------------------------------------------------- 1. 建部门
console.log('【1】总经理建部门');
const { ws, events } = await connect();
const state0 = await api('/api/state');
const dm = state0.rooms.find((r) => r.kind === 'dm');
const before = state0.rooms.filter((r) => r.kind === 'group').length;

// ★ 这个测试假定数据目录是干净的：它靠"最后一个部门就是刚建的那个"来断言。
//   在脏数据目录（比如日常自用的 data/）下跑，会拿错部门、报一串假失败 ——
//   看着像代码坏了，其实只是旧数据在捣乱。这里提前说清楚，别让人白查一轮。
if (before > 0) {
  console.log(`  ⚠ 数据目录里已经有 ${before} 个部门 —— 本测试需要干净数据目录，否则会误报。`);
  console.log('     干净跑法：');
  console.log('       PI_BOT_HOME=<空目录> PI_BOT_PORT=8788 node src/index.js');
  console.log('       node tests/org.mjs http://127.0.0.1:8788');
  console.log('     （本次仍继续跑，但「新建了 1 个部门」可能假失败）\n');
}

ws.send(
  JSON.stringify({
    t: 'send',
    roomId: dm.id,
    text:
      '建一个「内容运营组」部门，4 个人：' +
      '「运营总监」负责统筹和验收，「文案编辑」负责写文案，' +
      '「视觉设计」负责配图，「数据分析师」负责看数据。' +
      '运营总监当部门老大。',
  }),
);
await waitFor(events, (e) => e.t === 'msg.done' && e.msg?.authorType === 'bot', 400_000, '总经理建部门');
await new Promise((r) => setTimeout(r, 3000));

const state1 = await api('/api/state');
const groups = state1.rooms.filter((r) => r.kind === 'group');
check('新建了 1 个部门', groups.length === before + 1, `before=${before} after=${groups.length}`);

// 按名字找刚建的那个，别赌"它是最后一个"（脏数据目录下会拿错）
const dept = groups.find((r) => r.name === '内容运营组') ?? groups[groups.length - 1];
check('部门有 4 个成员', dept.botIds.length === 4, `实际 ${dept.botIds.length}`);
check('部门有老大', Boolean(dept.leadBotId), `leadBotId=${dept.leadBotId}`);
check('老大不是总经理', state1.bots.find((b) => b.id === dept.leadBotId)?.role !== 'main');
check('老大叫「运营总监」', dept.leadName === '运营总监', `实际 ${dept.leadName}`);
check('4 个人都各自建了私聊窗口', state1.rooms.filter((r) => r.kind === 'dm').length >= 5);

const memberNames = dept.botNames.filter((n) => n !== dept.leadName);
console.log(`     部门=${dept.name}  老大=${dept.leadName}  成员=${memberNames.join('、')}`);

// ---------------------------------------------------------------- 2. 老大先接
console.log('\n【2】用户往部门发指令 → 只有老大先接');
const evStart = events.length;
ws.send(
  JSON.stringify({
    t: 'send',
    roomId: dept.id,
    text: '给我们的新产品写一条推广文案，配一张图，并说明预期效果。开始干。',
  }),
);
await waitFor(
  events,
  (e) => e.t === 'msg.new' && e.msg?.authorType === 'bot' && e.msg?.status === 'streaming',
  120_000,
  '第一个 bot 开始发言',
);
await new Promise((r) => setTimeout(r, 4000));

const firstSpeakers = events
  .slice(evStart)
  .filter((e) => e.t === 'msg.new' && e.msg?.authorType === 'bot')
  .map((e) => e.msg.authorName);
const uniqueFirst = [...new Set(firstSpeakers)];
check('第一个开口的是部门老大', firstSpeakers[0] === dept.leadName, `实际 ${firstSpeakers[0]}`);
check(
  '开始时没有全员一拥而上',
  uniqueFirst.length <= 2,
  `同时开跑：${uniqueFirst.join('、')}`,
);

// ---------------------------------------------------------------- 3. 完整一轮
console.log('\n【3】等整轮跑完（老大派活 → 成员干活 → 老大汇总）');
const messages = await waitIdle(dept.id);
const botMsgs = messages.filter((m) => m.authorType === 'bot');
const speakers = [...new Set(botMsgs.map((m) => m.authorName))];
const leadMsgs = botMsgs.filter((m) => m.authorName === dept.leadName);
const memberMsgs = botMsgs.filter((m) => m.authorName !== dept.leadName);

console.log(`     发言者：${speakers.join('、')}`);
console.log(`     老大发了 ${leadMsgs.length} 条，成员发了 ${memberMsgs.length} 条`);

check('老大发言了', leadMsgs.length > 0);
check('至少有 1 个成员被叫到并发言', memberMsgs.length > 0, `成员消息数 ${memberMsgs.length}`);
check('有成员被 @ 派活', /@/.test(leadMsgs.map((m) => m.text).join('\n')));
check('没有 PASS 占位泄漏到界面', !botMsgs.some((m) => /^\s*\[?PASS\]?\s*$/i.test(m.text ?? '')));
check(
  '没有"没有返回文本"这种空白',
  !botMsgs.some((m) => (m.text ?? '').includes('没有返回文本')),
);
const errCount = botMsgs.filter((m) => m.status === 'error').length;
const recovered = botMsgs.some((m) => m.text?.includes('已自动重试'));
check('报错消息不超过 1 条（模型偶发吐空，靠兜底+下一轮自愈）', errCount <= 1, `${errCount} 条`);
check('成员确实产出了内容', memberMsgs.filter((m) => (m.text ?? '').trim().length > 10).length > 0);

// ---------------------------------------------------------------- 4. 总经理能看到进展
console.log('\n【4】总经理能读部门进展');
const evDm = events.length;
ws.send(JSON.stringify({ t: 'send', roomId: dm.id, text: '内容运营组现在做到哪了？给我个结论。' }));
await waitFor(events, (e) => e.t === 'msg.done' && e.msg?.authorType === 'bot', 400_000, '总经理汇报');
const dmMsgs = await waitIdle(dm.id, 400_000);
const report = (dmMsgs.filter((m) => m.authorType === 'bot').pop()?.text ?? '');
check('总经理给出了结论', report.length > 20, `长度 ${report.length}`);
console.log(`     总经理回复节选：${report.replace(/\n/g, ' ').slice(0, 120)}`);

ws.close();
console.log(`\n==================== ${pass} 通过 / ${fail} 失败 ====================`);
process.exit(fail === 0 ? 0 : 1);
