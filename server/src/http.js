/**
 * REST 接口。除 /health 和 /api/pair 外全部需要 token。
 * 流式输出走 WebSocket（ws.js），HTTP 负责控制面 + 历史拉取。
 */
import http from 'node:http';
import fs from 'node:fs';
import { config } from './config.js';
import { lanAddresses } from './pairing.js';
import { modelGroups, testModelGroup } from './model-groups.js';
import { store } from './store.js';
import { metaFor, pathFor, saveBuffer } from './attachments.js';
import { timingSafeEqual, log } from './util.js';
import { shells } from './shells.js';

function send(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  res.end(payload);
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid json');
  }
}

function extractToken(req, url) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const fromQuery = url.searchParams.get('token');
  return fromQuery && fromQuery.length ? fromQuery : null;
}

/**
 * 是不是本机发来的请求。
 *
 * PC 端 App 就跑在这台机器上，它就是宿主，不应该还要配对。
 * 所以 loopback 来的请求直接信任（本机用户就是主人）。
 * 远程设备（手机）仍然必须带 token。
 */
export function isLoopback(req) {
  const raw = req.socket?.remoteAddress ?? '';
  return raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1';
}

export const LOCAL_DEVICE = {
  id: 'local',
  name: '本机',
  createdAt: 0,
  lastSeenAt: 0,
  isLocal: true,
};

function authenticate(req, url) {
  const token = extractToken(req, url);
  if (token) {
    if (config.staticToken && timingSafeEqual(token, config.staticToken)) {
      return { id: 'static', name: 'static-token', createdAt: 0, lastSeenAt: Date.now(), isStatic: true };
    }
    const device = store.findDeviceByToken(token);
    if (device) store.touchDevice(token);
    return device;
  }
  // 没带 token：本机直接放行
  if (isLoopback(req)) return { ...LOCAL_DEVICE, lastSeenAt: Date.now() };
  return null;
}

export function createHttpServer({ runner, pairing }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return send(res, 204, {});

    try {
      // ---------- 公开 ----------
      if (pathname === '/health') {
        return send(res, 200, {
          ok: true,
          serverName: config.serverName,
          version: '0.2.0',
          stats: store.stats(),
          model: runner.modelLabel(),
          note: runner.initNote,
        });
      }

      if (pathname === '/api/pair' && req.method === 'POST') {
        const body = await readBody(req);
        if (!pairing.verify(body.code)) {
          return send(res, 401, { error: '配对码不对或已过期，看服务端控制台最新那 6 位数字' });
        }
        const { token, device } = store.addDevice(body.deviceName);
        // 配对码一次性：换到 token 后立即作废，避免同一码重复换发。
        pairing.rotate({ force: true });
        return send(res, 200, { token, device, serverName: config.serverName, workspace: config.workspace });
      }

      // ---------- 身份 ----------
      // 主人 = 本机回环请求（桌面端）或携带合法 token 的已配对设备。
      const device = authenticate(req, url);

      // ---------- 网页版配对页 ----------
      // 页面公开（地址不是秘密），配对码只返回给已鉴权的请求。
      if (pathname === '/pair' && req.method === 'GET') {
        const snap = config.staticToken ? null : pairing.snapshot({ withCode: Boolean(device) });
        const html = pairPage(snap);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }

      if (!device) return send(res, 401, { error: 'unauthorized' });

      // 配对码 / 已配对设备：都是主人才能看的东西，所以放在鉴权之后
      if (pathname === '/api/pairing' && req.method === 'GET') {
        return send(res, 200, config.staticToken ? { static: true } : pairing.snapshot({ withCode: true }));
      }

      if (pathname === '/api/devices' && req.method === 'GET') {
        return send(res, 200, {
          devices: store.listDevices().map(({ token, ...rest }) => rest),
          localTrusted: true,
        });
      }

      const deviceMatch = pathname.match(/^\/api\/devices\/([^/]+)$/);
      if (deviceMatch && req.method === 'DELETE') {
        return send(res, 200, { revoked: store.revokeDevice(deviceMatch[1]) });
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        return send(res, 200, {
          serverName: config.serverName,
          server: serverInfo(runner),
          device,
          rooms: store.listRooms().map((r) => store.roomSummary(r)),
          bots: store.listBots(),
          // 每个活着的会话的上下文占用（key 是 '房间:bot'）。
          // 放这儿而不是单开接口：App 每次刷新状态就顺带拿到了，少一次往返。
          context: runner.contextUsage(),
          // 用户自己配的模型组（**key 已打码**，真 key 不出服务端）
          modelGroups: modelGroups.listPublic(),
          // 群聊轮次预算（防止 bot 解不了就互相聊个没完）
          groupLimits: store.groupLimits(),
          policy: store.policy(),
          // 最近被命令策略拦下的执行（新的在前），界面用来做审计提示
          denials: store.listDenials({ limit: 20 }),
          templates: store.templates(),
          // 用户自己是谁（bot 要知道在跟谁说话）
          user: store.userSummary(),
          pairing: config.staticToken ? null : pairing.snapshot(),
        });
      }

      if (pathname === '/api/models' && req.method === 'GET') {
        const keyword = (url.searchParams.get('q') || '').toLowerCase();
        const all = runner.availableModels;
        const list = keyword ? all.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(keyword)) : all;
        return send(res, 200, { total: list.length, models: list.slice(0, 200) });
      }

      // ---------- 附件 ----------
      if (pathname === '/api/uploads' && req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 25 * 1024 * 1024) return send(res, 413, { error: '文件太大，上限 25MB' });
          chunks.push(chunk);
        }
        if (!size) return send(res, 400, { error: '空文件' });
        const name = url.searchParams.get('name') || req.headers['x-file-name'] || 'file';
        const meta = saveBuffer(Buffer.concat(chunks), { name, mime: req.headers['content-type'] });
        return send(res, 200, { attachment: { ...meta, url: `/api/files/${meta.id}` } });
      }

      const fileMatch = pathname.match(/^\/api\/files\/([a-zA-Z0-9_-]+)$/);
      if (fileMatch && req.method === 'GET') {
        const meta = metaFor(fileMatch[1]);
        const file = pathFor(fileMatch[1]);
        if (!meta || !file) return send(res, 404, { error: '文件不存在' });
        res.writeHead(200, {
          'content-type': meta.mime,
          'content-length': meta.size,
          'cache-control': 'private, max-age=86400',
          'access-control-allow-origin': '*',
        });
        fs.createReadStream(file).pipe(res);
        return undefined;
      }

      // ---------- Bot ----------
      if (pathname === '/api/bots' && req.method === 'GET') {
        return send(res, 200, { bots: store.listBots() });
      }

      if (pathname === '/api/bots' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.name) return send(res, 400, { error: '需要 name' });
        const bot = store.createBot({ ...body, createdBy: device.id });
        return send(res, 200, { bot });
      }

      const botMatch = pathname.match(/^\/api\/bots\/([^/]+)$/);
      if (botMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const bot = store.updateBot(botMatch[1], body);
        if (!bot) return send(res, 404, { error: 'bot 不存在' });
        if (body.model !== undefined || body.thinking !== undefined) runner.resetSessionForBot(bot.id);
        return send(res, 200, { bot });
      }
      if (botMatch && req.method === 'DELETE') {
        const r = store.deleteBot(botMatch[1]);
        if (!r) return send(res, 400, { error: '删不了（不存在或它是主控）' });
        return send(res, 200, r);
      }

      // ---------- 用户身份 ----------
      if (pathname === '/api/user' && req.method === 'GET') {
        return send(res, 200, { user: store.userSummary() });
      }
      if (pathname === '/api/user' && req.method === 'PATCH') {
        const body = await readBody(req);
        const user = store.updateUserName(body.name);
        // 名字是拼进系统提示的，而提示只在建会话时构造 —— 不重建会话的话
        // 改名只对以后新开的会话生效，正在用的那些还记着旧名字。
        // 用户要求"每次修改要通知到全局"，所以这里把内存里的会话全丢掉重建
        // （reload 而不是 reset：对话历史保留）。
        const n = runner.reloadAllSessions();
        log(`👤 用户改名叫：${user.name}（已重建 ${n} 个会话，下一轮起生效）`);
        return send(res, 200, { user });
      }

      // ---------- 群聊轮次预算 ----------
      if (pathname === '/api/group-limits' && req.method === 'GET') {
        return send(res, 200, { limits: store.groupLimits() });
      }
      // ---------- 部门规矩（危险动作 / 交付要附证据）----------
      if (pathname === '/api/policy' && req.method === 'GET') {
        return send(res, 200, { policy: store.policy() });
      }
      if (pathname === '/api/policy' && req.method === 'PATCH') {
        const body = await readBody(req);
        const policy = store.updatePolicy(body);
        log(
          `⚙️  部门规矩改为：危险动作 ${policy.dangerous === 'deny' ? '只读（不给改文件/跑命令的工具）' : '允许'} / ` +
            `交付${policy.requireProof ? '必须附证据' : '不强求证据'}`,
        );
        return send(res, 200, { policy });
      }
      if (pathname === '/api/group-limits' && req.method === 'PATCH') {
        const body = await readBody(req);
        const limits = store.updateGroupLimits(body);
        log(
          `⚙️  群聊轮次改为：老大 ${limits.leadTurns} 轮 / 成员 ${limits.memberTurns} 轮 / ` +
            `单条消息最多 ${limits.maxRuns} 次`,
        );
        return send(res, 200, { limits });
      }

      // ---------- 模型组（用户自己配的 baseUrl/key/模型）----------
      if (pathname === '/api/model-groups' && req.method === 'GET') {
        return send(res, 200, { modelGroups: modelGroups.listPublic() });
      }

      if (pathname === '/api/model-groups' && req.method === 'POST') {
        const body = await readBody(req);
        const r = modelGroups.upsert(body);
        if (r.error) return send(res, 400, { error: r.error });
        // 运行时热注册，加完不用重启
        const total = await runner.applyModelGroupChange();
        log(`🔌 新增模型组：${r.group.name}（${r.group.models.length} 个模型），可用模型 ${total} 个`);
        return send(res, 200, { group: r.group.toPublic() });
      }

      // 连通性测试：还没保存也能测（用户在编辑器里填完想先试一下）
      if (pathname === '/api/model-groups/test' && req.method === 'POST') {
        const body = await readBody(req);
        // 有 id 就用存着的那份补全（key 打了码，不能拿它当值提交）
        const saved = body.id ? modelGroups.get(body.id) : null;
        const r = await testModelGroup({
          baseUrl: body.baseUrl || saved?.baseUrl,
          apiKey: body.apiKey || saved?.apiKey,
          api: body.api || saved?.api,
          model: body.model || saved?.models?.[0]?.id,
        });
        return send(res, 200, r);
      }

      const groupMatch = pathname.match(/^\/api\/model-groups\/([^/]+)$/);
      if (groupMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const r = modelGroups.upsert({ ...body, id: groupMatch[1] });
        if (r.error) return send(res, 400, { error: r.error });
        await runner.applyModelGroupChange();
        return send(res, 200, { group: r.group.toPublic() });
      }
      if (groupMatch && req.method === 'DELETE') {
        const ok2 = modelGroups.remove(groupMatch[1]);
        if (!ok2) return send(res, 404, { error: '模型组不存在' });
        await runner.applyModelGroupChange();
        log(`🔌 删除模型组：${groupMatch[1]}`);
        return send(res, 200, { id: groupMatch[1] });
      }

      // ---------- 部门模板 ----------
      if (pathname === '/api/templates' && req.method === 'GET') {
        return send(res, 200, { templates: store.templates() });
      }
      if (pathname === '/api/templates' && req.method === 'POST') {
        const body = await readBody(req);
        // 两种来源：从现成的部门存（给 roomId），或直接给一份班子
        const r = body.roomId
          ? store.saveTemplateFromRoom(body.roomId, { name: body.name })
          : store.createTemplate(body);
        if (r.error) return send(res, 400, { error: r.error });
        log(`📦 存了部门模板：${r.template.name}（${r.template.members.length} 人）`);
        return send(res, 200, { template: r.template });
      }
      const tplMatch = pathname.match(/^\/api\/templates\/([^/]+)$/);
      if (tplMatch && req.method === 'DELETE') {
        const r = store.deleteTemplate(tplMatch[1]);
        if (r.error) return send(res, 404, { error: r.error });
        return send(res, 200, { ok: true });
      }
      const tplApply = pathname.match(/^\/api\/templates\/([^/]+)\/apply$/);
      if (tplApply && req.method === 'POST') {
        const body = await readBody(req);
        const r = store.applyTemplate(tplApply[1], { name: body.name });
        if (r.error) return send(res, 404, { error: r.error });
        log(`🧩 照模板开了部门：${r.room.name}（复用/新造 ${r.bots.length} 人）`);
        return send(res, 200, {
          room: store.roomSummary(r.room),
          bots: r.bots.map((b) => b.id),
        });
      }

      // ---------- 房间 ----------
      if (pathname === '/api/rooms' && req.method === 'POST') {
        const body = await readBody(req);
        const room = store.createGroup({
          name: body.name,
          topic: body.topic,
          botIds: body.botIds,
          leadBotId: body.leadBotId,
          createdBy: device.id,
        });
        return send(res, 200, { room: store.roomSummary(room) });
      }

      if (pathname === '/api/rooms/dm' && req.method === 'POST') {
        const body = await readBody(req);
        const room = store.ensureDm(body.botId);
        if (!room) return send(res, 404, { error: 'bot 不存在' });
        return send(res, 200, { room: store.roomSummary(room) });
      }

      const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)$/);
      if (roomMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const room = store.updateRoom(roomMatch[1], body);
        if (!room) return send(res, 404, { error: '会话不存在' });
        return send(res, 200, { room: store.roomSummary(room) });
      }
      if (roomMatch && req.method === 'DELETE') {
        shells.killRoom(roomMatch[1]);
        const r = store.deleteRoom(roomMatch[1]);
        if (!r) return send(res, 400, { error: '删不了（不存在或是 DM）' });
        return send(res, 200, r);
      }

      const msgMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
      if (msgMatch && req.method === 'GET') {
        const roomId = msgMatch[1];
        if (!store.getRoom(roomId)) return send(res, 404, { error: '会话不存在' });
        const limit = Math.min(Number(url.searchParams.get('limit') || 100), config.maxMessagesPerRoom);
        return send(res, 200, { messages: store.listMessages(roomId, { limit }) });
      }

      const sendMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/send$/);
      if (sendMatch && req.method === 'POST') {
        const body = await readBody(req);
        const result = await runner.send(sendMatch[1], body.text, {
          mode: body.mode,
          attachments: body.attachments,
        });
        return send(res, 200, { ok: true, message: result.userMessage, steered: result.steered ?? null });
      }

      const abortMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/abort$/);
      if (abortMatch && req.method === 'POST') {
        return send(res, 200, await runner.abort(abortMatch[1]));
      }

      const resetMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/reset$/);
      if (resetMatch && req.method === 'POST') {
        const n = runner.resetRoomSessions(resetMatch[1]);
        return send(res, 200, { ok: true, reset: n });
      }

      return send(res, 404, { error: 'not found', path: pathname });
    } catch (err) {
      const code = err?.code;
      const status = code === 'BUSY' ? 409 : code ? 400 : 500;
      return send(res, status, { error: String(err?.message || err), code });
    }
  });

  return server;
}

export function serverInfo(runner) {
  return {
    version: '0.2.0',
    hostname: config.hostname,
    workspace: config.workspace,
    // 数据目录也回给 App：这是用户最该知道、也最不该被“神秘换掉”的东西
    dataDir: config.dataDir,
    model: runner.modelLabel(),
    note: runner.initNote,
    tools: config.tools,
    models: runner.availableModels.length,
  };
}

/**
 * 网页版配对页：展示地址；配对码仅对已鉴权的请求渲染。
 */
function pairPage(snap) {
  const addresses = lanAddresses()
    .map(({ name, address }) => `http://${address}:${config.port}  <span class="dim">(${name})</span>`)
    .join('<br>');

  if (!snap) {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pi-bot 配对</title>${pairStyles()}</head><body>
<div class="card">
  <div class="logo">π</div>
  <h1>${config.serverName}</h1>
  <p class="dim">服务端配的是固定 token（PI_BOT_TOKEN），不需要配对码。</p>
  <p class="dim">在 App 的「固定 token」页填入服务端 .env 里的那个 token 就行。</p>
</div></body></html>`;
  }

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pi-bot 配对</title>${pairStyles()}</head><body>
<div class="card">
  <div class="logo">π</div>
  <h1>${config.serverName}</h1>
  <p class="dim">在 App 的配对页填下面两项</p>
  <p class="dim">地址</p>
  <div class="code small">${addresses}</div>
  ${
    snap.code
      ? `<p class="dim">配对码</p>
  <div class="code" id="code">${snap.code}</div>
  <p class="dim"><span id="ttl">${Math.round(snap.ttlMs / 1000)}</span> 秒后换新码</p>`
      : `<p class="dim">配对码只在<b>服务端控制台</b>里显示（启动时打印的那 6 位数字），这里不显示 ——
  否则同一个网络里任何人都能拿到它来接管这台机器。</p>`
  }
</div>
${snap.code ? `<script>
  let ttl = ${Math.round(snap.ttlMs / 1000)};
  setInterval(() => {
    ttl--;
    if (ttl <= 0) { location.reload(); return; }
    const el = document.getElementById('ttl');
    if (el) el.textContent = ttl;
  }, 1000);
  setInterval(() => {
    fetch('/api/pairing').then(r => r.json()).then(d => {
      const c = document.getElementById('code');
      if (c && d.code) c.textContent = d.code;
      if (d.ttlMs) ttl = Math.round(d.ttlMs / 1000);
    }).catch(() => {});
  }, 30000);
</script>` : ''}
</body></html>`;
}

function pairStyles() {
  return `<style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: #0e0e0e; color: #f2f2f2; padding: 24px;
      font-family: 'Inter', -apple-system, 'Microsoft YaHei UI', 'PingFang SC', sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      width: 100%; max-width: 380px; text-align: center;
      background: #161616; border: 1px solid rgba(242,242,242,.07);
      border-radius: 20px; padding: 32px 26px;
      box-shadow: 0 20px 60px rgba(0,0,0,.5);
    }
    .logo {
      width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 16px;
      display: grid; place-items: center; font-size: 26px; font-weight: 600;
      background: linear-gradient(135deg, #3d9bff, #126fd4); color: #fff;
    }
    h1 { font-size: 20px; font-weight: 600; letter-spacing: -.3px; margin: 0 0 6px; }
    .dim { color: rgba(242,242,242,.45); font-size: 13px; line-height: 1.6; margin: 6px 0; }
    .code {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 30px; font-weight: 600; letter-spacing: 6px;
      color: #4d9bff; margin: 10px 0 2px;
    }
    .code.small { font-size: 13px; letter-spacing: 0; line-height: 1.8; color: rgba(242,242,242,.75); }
    hr { border: 0; border-top: 1px solid rgba(242,242,242,.07); margin: 22px 0 14px; }
  </style>`;
}
