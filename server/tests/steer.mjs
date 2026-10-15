/**
 * 中途插话测试：先派一个长任务，跑起来之后插一句引导，看它有没有按新要求改。
 *   node tests/steer.mjs
 */
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:8787';
const token = process.argv[3] || 'test-token';
const roomName = process.argv[4] || 'Pi';

const state = await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json();
const room = state.rooms.find((r) => r.name === roomName) ?? state.rooms[0];
console.log(`会话：${room.name} (${room.id})`);

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${token}`);
let steerTimer = null;
let steered = false;
let lastLen = 0;

ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  if (ev.t === 'hello') {
    console.log('--- 第 1 步：派一个会跑很久的任务 ---');
    ws.send(JSON.stringify({ t: 'send', roomId: room.id, text: '写一个 Python 脚本，把 1 到 100 每个数字都打印出来，并且每一行都加上详细中文注释。慢慢写，写完整。' }));
    steerTimer = setTimeout(() => {
      console.log('\n--- 第 2 步：中途插话（不等它做完）---');
      steered = true;
      ws.send(JSON.stringify({ t: 'send', roomId: room.id, text: '停一下，改需求：只要打印 1 到 5，不要注释。立刻按这个改。', mode: 'steer' }));
    }, 9000);
  }
  if (ev.t === 'steer.accepted') {
    console.log(`\n✅ 服务端接受插话（${ev.mode}）：${ev.text}`);
  }
  if (ev.t === 'queue') {
    console.log(`  队列状态：steering=${JSON.stringify(ev.steering)} followUp=${JSON.stringify(ev.followUp)}`);
  }
  if (ev.t === 'msg.delta' && ev.msgId && ev.text.length !== lastLen) {
    process.stdout.write(ev.text.slice(lastLen));
    lastLen = ev.text.length;
  }
  if (ev.t === 'msg.steps' && ev.steps.length) {
    const last = ev.steps[ev.steps.length - 1];
    console.log(`  🔧 [${ev.steps.length}] ${last.tool} ${last.status}`);
  }
  if (ev.t === 'msg.done' && steered) {
    console.log('\n\n--- 完成 ---');
    const bot = ev.msg;
    const hit5 = /[^0-9]5[^0-9]/.test(bot.text) && !/100/.test(bot.text);
    console.log(hit5 ? '✅ 插话生效：输出已按新要求（1-5、无注释）' : '⚠️ 插话可能没生效，自己看输出');
    ws.close();
    process.exit(hit5 ? 0 : 1);
  }
  if (ev.t === 'msg.error') {
    console.log('\n❌ 出错：', ev.error);
    ws.close();
    process.exit(1);
  }
});
setTimeout(() => {
  console.error('超时');
  process.exit(1);
}, 300_000);
