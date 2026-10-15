/**
 * 冒烟测试：HTTP + WebSocket 全链路走一遍。
 *   node tests/smoke.mjs [http://127.0.0.1:8787] [token] ["消息文本"]
 */
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:8787';
const token = process.argv[3] ?? '';
const text = process.argv[4] || '用一句话介绍你自己，然后用 ls 看一眼当前目录有什么文件。';
const roomSelector = process.argv[5] || '';

const health = await (await fetch(`${base}/health`)).json();
console.log('health:', JSON.stringify(health));

const state = await (await fetch(`${base}/api/state`, { headers: { authorization: (token ? `Bearer ${token}` : '') } })).json();
console.log('state: rooms =', state.rooms.map((r) => `${r.name}(${r.id})`).join(', '));
console.log('       bots  =', state.bots.map((b) => b.name).join(', '));
console.log('       model =', state.server.model);

const roomId = (roomSelector
  ? state.rooms.find((r) => r.id === roomSelector || r.name === roomSelector)?.id
  : null) ?? state.rooms[0]?.id ?? 'main';
console.log('       room  =', state.rooms.find((r) => r.id === roomId)?.name);
const wsUrl = base.replace(/^http/, 'ws') + `/ws?token=${token}`;
const ws = new WebSocket(wsUrl);

let lastLen = 0;
const started = Date.now();
let done = false;

const finish = (code) => {
  if (done) return;
  done = true;
  ws.close();
  process.exit(code);
};

ws.on('open', () => console.log('\n--- WS 已连接，发消息 ---'));
ws.on('message', (raw) => {
  const ev = JSON.parse(raw.toString());
  switch (ev.t) {
    case 'hello':
      console.log('hello:', ev.serverName, ev.server.model);
      ws.send(JSON.stringify({ t: 'send', roomId, text }));
      break;
    case 'msg.new':
      console.log(`msg.new  [${ev.msg.authorName}] status=${ev.msg.status}`);
      break;
    case 'msg.delta':
      if (ev.text.length - lastLen > 0) {
        process.stdout.write(ev.text.slice(lastLen));
        lastLen = ev.text.length;
      }
      break;
    case 'msg.steps':
      console.log(`  🔧 [${ev.steps.length}] 最近: ${ev.steps.slice(-3).map((s) => `${s.tool}(${s.status}${s.durationMs ? ' ' + s.durationMs + 'ms' : ''})`).join(' → ')}`);
      break;
    case 'msg.done':
      console.log(`\n\n--- 完成 (${((Date.now() - started) / 1000).toFixed(1)}s) status=${ev.msg.status} steps=${(ev.msg.steps || []).length} usage=${JSON.stringify(ev.msg.usage ?? null)}`);
      finish(ev.msg.status === 'done' ? 0 : 1);
      break;
    case 'msg.error':
      console.log(`\n\n--- 出错 (${((Date.now() - started) / 1000).toFixed(1)}s): ${ev.error}`);
      finish(1);
      break;
    case 'typing':
      break;
    default:
      console.log('event:', JSON.stringify(ev).slice(0, 200));
  }
});
ws.on('error', (err) => {
  console.error('WS 错误：', err.message);
  finish(1);
});
setTimeout(() => {
  console.error('\n超时 600s 未收到 msg.done');
  finish(1);
}, 600_000);
