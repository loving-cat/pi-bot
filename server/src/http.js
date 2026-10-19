/**
 * REST 接口。除 /health 和 /api/pair 外全部需要 token。
 * 流式输出走 WebSocket（ws.js），HTTP 负责控制面 + 历史拉取。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { modelGroups, testModelGroup } from './model-groups.js';
import {
  THINKING_FORMATS,
  THINKING_LEVELS,
  THINKING_PRESETS,
  THINKING_UPSTREAM_VALUES,
  availableThinkingLevels,
} from './model-thinking.js';
import { capacityError } from './model-capacity.js';
import { store } from './store.js';
import { metaFor, pathFor, saveBuffer, saveMovedFile } from './attachments.js';
import { lanAddresses } from './pairing.js';
import { timingSafeEqual, log } from './util.js';
import { shells } from './shells.js';
import { computeNextRun, validateSchedule } from './automations.js';
import { VERSION } from './version.js';
import { checkForUpdate, clearUpdateCache } from './update-checker.js';
import { parseSkillMarkdown } from './skills.js';
import {
  scanLocalCapabilities,
  localSkillToLibrary,
  localMcpToLibrary,
} from './local-capabilities.js';
import {
  MCP_LIMITS,
  MCP_TYPES,
  MCP_EXPOSURES,
  mcpRejectReason,
  normalizeMcpServer,
  testMcpServer,
} from './mcp.js';
import { probeLogin } from './site-probe.js';
import { createSiteRuntime } from './site-runtime.js';
import { publicSite } from './sites.js';
import { UploadSessions } from './upload-sessions.js';
import { loadHooks, saveHooks, validateHook } from './hooks.js';

function send(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // ★ 不再给 `access-control-allow-origin: *`。
    //   桌面端是同机直连（没有 Origin）；网页配对页是同源。给 * 只会让
    //   任意网页都能读到 127.0.0.1 的响应。
    'x-content-type-options': 'nosniff',
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
    throw Object.assign(new Error('invalid json'), { code: 'INVALID_JSON' });
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

/**
 * Host 头是否指向本机。
 *
 * 桌面端连 127.0.0.1；手机连局域网 IP。除此之外（尤其是外部域名）一律拒绝 ——
 * 否则恶意网页把自己的域名解析到 127.0.0.1，浏览器就会以"同源"身份打进来
 * （DNS rebinding），连 CORS 都挡不住。
 */
export function hostAllowed(hostHeader) {
  const host = String(hostHeader ?? '').trim();
  if (!host) return false;
  const name = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  const lower = name.toLowerCase();
  if (lower === '127.0.0.1' || lower === 'localhost' || lower === '::1') return true;
  if (config.hostname && lower === String(config.hostname).toLowerCase()) return true;
  return lanAddresses().some((a) => String(a.address).toLowerCase() === lower);
}

export function createHttpServer({ runner, pairing, sites = createSiteRuntime({ log }) }) {
  const uploads = new UploadSessions({
    dir: path.join(config.dataDir, 'uploads', '_partial'),
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    // ★ Host 必须是本机名/本机 IP：防 DNS rebinding ——
    //   恶意域名解析到 127.0.0.1 时，Host 会是那个域名，这里直接拒。
    if (!hostAllowed(req.headers.host)) {
      return send(res, 403, { error: 'bad host' });
    }

    if (req.method === 'OPTIONS') return send(res, 204, {});

    try {
      // ---------- 公开 ----------
      if (pathname === '/health') {
        return send(res, 200, {
          ok: true,
          serverName: config.serverName,
          version: VERSION,
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

      // ★ 状态变更请求必须声明 JSON：浏览器跨域发 text/plain 不会触发预检，
      //   光靠 CORS 挡不住"只求副作用不求回显"的攻击。上传接口例外。
      const isUploadRoute =
        pathname === '/api/uploads' || pathname.startsWith('/api/uploads/');
      if (!isUploadRoute && ['POST', 'PATCH', 'PUT'].includes(req.method)) {
        const ct = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!ct.includes('application/json')) {
          return send(res, 415, { error: 'content-type 必须是 application/json' });
        }
      }

      // 配对码 / 已配对设备：都是主人才能看的东西，所以放在鉴权之后
      if (pathname === '/api/pairing' && req.method === 'GET') {
        return send(res, 200, config.staticToken ? { static: true } : pairing.snapshot({ withCode: true }));
      }

      if (pathname === '/api/devices' && req.method === 'GET') {
        return send(res, 200, {
          // 不带 token：撤销用 id，客户端拿不到别人的凭证
          devices: store.listDevicesPublic(),
          localTrusted: true,
        });
      }

      const deviceMatch = pathname.match(/^\/api\/devices\/([^/]+)$/);
      if (deviceMatch && req.method === 'DELETE') {
        const selector = decodeURIComponent(deviceMatch[1]);
        return send(res, 200, { revoked: store.revokeDevice(selector) });
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
          // 任务板（房间页会按 roomId 过滤）
          tasks: store.listTasks({ limit: 200 }),
          // 定时任务（房间页按 roomId 过滤）
          automations: store.listAutomations(),
          templates: store.templates(),
          // 用户自己是谁（bot 要知道在跟谁说话）
          user: store.userSummary(),
          pairing: config.staticToken ? null : pairing.snapshot(),
        });
      }

      // ---------- 工具钩子（改入参 / 拦下） ----------
      if (pathname === '/api/hooks' && req.method === 'GET') {
        return send(res, 200, { hooks: loadHooks() });
      }
      if (pathname === '/api/hooks' && req.method === 'PUT') {
        const body = await readBody(req);
        const list = Array.isArray(body?.hooks) ? body.hooks : [];
        const bad = list.map((rule) => validateHook(rule)).filter(Boolean);
        if (bad.length) return send(res, 400, { error: bad[0] });
        return send(res, 200, { hooks: saveHooks(list) });
      }

      // ---------- 审批（危险动作第三档） ----------
      if (pathname === '/api/approvals' && req.method === 'GET') {
        const roomId = url.searchParams.get('roomId');
        const status = url.searchParams.get('status');
        return send(res, 200, {
          approvals: store.listApprovals({ roomId, status, limit: 100 }),
        });
      }

      const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
      if (approvalMatch && req.method === 'POST') {
        const body = await readBody(req);
        const approval = store.decideApproval(approvalMatch[1], {
          approved: body?.approve === true,
        });
        // scope='task' → 开一个 10 分钟的放行窗口（同一 bot + 同一会话）
        if (approval?.status === 'approved' && body?.scope === 'task') {
          store.grantApproval({
            roomId: approval.roomId,
            botId: approval.botId,
            minutes: Number(body?.minutes) || 10,
          });
        }
        if (!approval) return send(res, 400, { error: '没有待批准的这一条' });

        // 卡片状态跟着变（前端据此把按钮置灰）
        const card = (store.listMessages(approval.roomId, { limit: 200 }) ?? []).find(
          (m) => m?.meta?.approvalId === approval.id,
        );
        if (card) {
          store.updateMessage(approval.roomId, card.id, {
            meta: { ...(card.meta ?? {}), decision: approval.status },
          });
        }

        if (approval.status === 'approved') {
          runner.resumeAfterApproval(approval).catch((err) =>
            log('批准后继续失败：', err?.message || err),
          );
        } else {
          store.appendMessage({
            roomId: approval.roomId,
            authorType: 'system',
            authorName: '审批',
            text: `已拒绝：${approval.summary}`,
            status: 'done',
            meta: { approvalId: approval.id, decision: 'denied' },
          });
        }
        return send(res, 200, { approval });
      }

      // ---------- 定时任务 ----------
      if (pathname === '/api/automations' && req.method === 'GET') {
        const roomId = url.searchParams.get('roomId');
        return send(res, 200, { automations: store.listAutomations({ roomId }) });
      }

      if (pathname === '/api/automations' && req.method === 'POST') {
        const body = await readBody(req);
        const problem = validateSchedule(body);
        if (problem) return send(res, 400, { error: problem });
        if (!store.getRoom(body.roomId)) return send(res, 400, { error: '会话不存在' });
        const automation = store.createAutomation({
          roomId: body.roomId,
          title: body.title,
          prompt: body.prompt,
          botId: body.botId ?? null,
          everyMinutes: body.everyMinutes ?? null,
          dailyAt: body.dailyAt ?? null,
          enabled: body.enabled !== false,
          createdBy: device.id,
          nextRunAt: computeNextRun(body) ?? 0,
        });
        if (!automation) return send(res, 400, { error: '任务要有标题和内容' });
        return send(res, 200, { automation });
      }

      const autoMatch = pathname.match(/^\/api\/automations\/([^/]+)$/);
      if (autoMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const patch = { ...body };
        // 改了排期就重算下一次
        if (body.everyMinutes !== undefined || body.dailyAt !== undefined) {
          const current = store.getAutomation(autoMatch[1]);
          const merged = {
            everyMinutes: body.everyMinutes ?? current?.everyMinutes,
            dailyAt: body.dailyAt ?? current?.dailyAt,
          };
          const problem = validateSchedule(merged);
          if (problem) return send(res, 400, { error: problem });
          patch.nextRunAt = computeNextRun(merged) ?? 0;
        }
        const automation = store.updateAutomation(autoMatch[1], patch);
        if (!automation) return send(res, 404, { error: '定时任务不存在' });
        return send(res, 200, { automation });
      }
      if (autoMatch && req.method === 'DELETE') {
        return send(res, 200, { deleted: store.deleteAutomation(autoMatch[1]) });
      }

      const autoRunMatch = pathname.match(/^\/api\/automations\/([^/]+)\/run$/);
      if (autoRunMatch && req.method === 'POST') {
        const automation = store.getAutomation(autoRunMatch[1]);
        if (!automation) return send(res, 404, { error: '定时任务不存在' });
        runner.runAutomation(automation).catch((err) =>
          log('手动触发定时任务失败：', err?.message || err),
        );
        return send(res, 200, { ok: true, started: true });
      }

      // ---------- 任务板 ----------
      if (pathname === '/api/tasks' && req.method === 'GET') {
        const roomId = url.searchParams.get('roomId');
        const status = url.searchParams.get('status');
        return send(res, 200, { tasks: store.listTasks({ roomId, status, limit: 300 }) });
      }

      if (pathname === '/api/tasks' && req.method === 'POST') {
        const body = await readBody(req);
        const task = store.createTask({
          roomId: body.roomId ?? null,
          title: body.title,
          detail: body.detail,
          ownerBotId: body.ownerBotId ?? null,
          createdBy: device.id,
        });
        if (!task) return send(res, 400, { error: '任务需要一个标题' });
        return send(res, 200, { task });
      }

      const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const task = store.updateTask(taskMatch[1], body);
        if (!task) return send(res, 404, { error: '任务不存在' });
        return send(res, 200, { task });
      }
      if (taskMatch && req.method === 'DELETE') {
        const okDeleted = store.deleteTask(taskMatch[1]);
        return send(res, okDeleted ? 200 : 404, { deleted: okDeleted });
      }

      if (pathname === '/api/models' && req.method === 'GET') {
        const keyword = (url.searchParams.get('q') || '').toLowerCase();
        const all = runner.availableModels;
        const list = keyword ? all.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(keyword)) : all;
        // ★ 带上模型组里的思考声明：前台靠它决定要不要展示思考档位。
        //   注册到 pi runtime 的模型对象不会带我们自己的 thinkingLevelMap，
        //   所以要回去查模型组那份原始配置。
        const thinkingBySlug = new Map();
        for (const group of modelGroups.list()) {
          for (const model of group.models) {
            thinkingBySlug.set(`${group.id}/${model.id}`, model);
          }
        }
        const decorate = (m) => {
          const own = thinkingBySlug.get(`${m.provider}/${m.id}`);
          if (!own) return m;
          return {
            ...m,
            reasoning: Boolean(own.reasoning),
            thinkingFormat: own.thinkingFormat || '',
            thinkingLevels: availableThinkingLevels(own),
          };
        };
        return send(res, 200, { total: list.length, models: list.slice(0, 200).map(decorate) });
      }

      // ---------- 外部 Web 系统接入 ----------
      if (pathname === '/api/sites' && req.method === 'GET') {
        return send(res, 200, {
          sites: store.siteList().map((s) => publicSite(s, sites.statusOf(s.id))),
        });
      }

      // 添加前先探测：确认这个站的登录方式，避免存进去却连不上
      if (pathname === '/api/sites/probe' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await probeLogin({
          baseUrl: body.baseUrl,
          account: body.account,
          password: body.password,
          accountField: body.accountField ?? '',
          passwordField: body.passwordField ?? '',
        });
        // 不带回 token：探测只回答"能不能连、字段叫什么"
        return send(res, 200, {
          ok: result.ok,
          reason: result.reason,
          tried: result.tried,
          auth: result.auth ?? null,
        });
      }

      if (pathname === '/api/sites' && req.method === 'POST') {
        const body = await readBody(req);
        const r = store.addSite({
          name: body.name,
          baseUrl: body.baseUrl,
          account: body.account,
          password: body.password,
          auth: body.auth,
        });
        if (r.error) return send(res, 400, { error: r.error });
        return send(res, 200, { site: publicSite(r.site, sites.statusOf(r.site.id)) });
      }

      const siteMatch = pathname.match(/^\/api\/sites\/([^/]+)$/);
      if (siteMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const id = decodeURIComponent(siteMatch[1]);
        const r = store.updateSite(id, body);
        if (r.error) return send(res, 404, { error: r.error });
        // 凭证变了要让缓存失效，否则还用旧 token
        sites.forget(id);
        return send(res, 200, { site: publicSite(r.site, sites.statusOf(id)) });
      }
      if (siteMatch && req.method === 'DELETE') {
        const id = decodeURIComponent(siteMatch[1]);
        const r = store.removeSite(id);
        if (r.error) return send(res, 404, { error: r.error });
        sites.forget(id);
        return send(res, 200, { ok: true });
      }

      // 为一个系统建团队：建部门 + 把该系统的查询能力交给它
      const siteTeamMatch = pathname.match(/^\/api\/sites\/([^/]+)\/team$/);
      if (siteTeamMatch && req.method === 'POST') {
        const id = decodeURIComponent(siteTeamMatch[1]);
        const site = store.getSite(id);
        if (!site) return send(res, 404, { error: '系统不存在' });
        const body = await readBody(req);
        const teamName = String(body.name ?? `${site.name} 团队`).slice(0, 40);

        // 已经有团队就直接复用（别重复建部门）
        if (site.teamRoomId && store.getRoom(site.teamRoomId)) {
          return send(res, 200, { roomId: site.teamRoomId, reused: true });
        }

        // 部门只放一个人：它专门负责回答这个系统的事。
        // 不再自动塞一堆角色 —— 用户要的是"一个系统一个团队"，
        // 人多了反而互相推诿。
        const persona =
          `你负责「${site.name}」这个系统（${site.baseUrl}）。` +
          `用户在手机上问你跟这个系统有关的事时，你用 query_site 去查真实数据再回答。` +
          `查之前先用 list_sites 确认系统标识；结果有可能是大 JSON，挑用户关心的说出来，不要整段贴。` +
          `查不到就直说查不到，不要猜。`;
        const { room, bots } = store.createDepartment({
          name: teamName,
          topic: `接入的外部系统：${site.name}`,
          members: [
            {
              name: `${site.name} 助手`,
              persona,
              emoji: '🔌',
              tagline: `查 ${site.name} 的数据`,
              skills: [
                {
                  title: `查询 ${site.name}`,
                  howto:
                    `用 query_site(site="${site.id}", path="/api/...") 查数据。` +
                    `不确定路径就先查列表接口看结构。`,
                },
              ],
            },
          ],
          lead: `${site.name} 助手`,
          createdBy: 'site',
        });
        store.bindSiteTeam(id, room.id);
        return send(res, 200, { roomId: room.id, botId: bots[0]?.id ?? null, reused: false });
      }

      // 连一次看看通不通（用户点"测试连接"）
      const siteTestMatch = pathname.match(/^\/api\/sites\/([^/]+)\/test$/);
      if (siteTestMatch && req.method === 'POST') {
        const id = decodeURIComponent(siteTestMatch[1]);
        const site = store.getSite(id);
        if (!site) return send(res, 404, { error: '系统不存在' });
        const r = await sites.ping(site);
        return send(res, 200, r);
      }

      // ---------- 本机已装能力（只读扫描，不碰用户的 pi 配置）----------
      // 用户在终端里早就装了一堆 skill / MCP，这里让他一键导入，不用手抄。
      if (pathname === '/api/local-capabilities' && req.method === 'GET') {
        const found = scanLocalCapabilities({
          existingSkills: store.skillLibrary(),
          existingMcp: store.mcpLibrary(),
        });
        return send(res, 200, found);
      }

      // 一键导入：传 kind + 名字列表。同名的不重复导，返回明细。
      if (pathname === '/api/local-capabilities/import' && req.method === 'POST') {
        const body = await readBody(req);
        const kind = String(body.kind ?? '');
        const wanted = new Set(
          (Array.isArray(body.names) ? body.names : []).map((n) => String(n).toLowerCase()),
        );
        if (!wanted.size) return send(res, 400, { error: '没选要导入的条目' });

        const found = scanLocalCapabilities({
          existingSkills: store.skillLibrary(),
          existingMcp: store.mcpLibrary(),
        });
        const imported = [];
        const skipped = [];

        if (kind === 'skill') {
          for (const entry of found.skills) {
            if (!wanted.has((entry.title || '').toLowerCase())) continue;
            if (entry.imported) {
              skipped.push({ title: entry.title, reason: '已经导入过了' });
              continue;
            }
            const skill = localSkillToLibrary(entry);
            if (!skill) {
              skipped.push({ title: entry.title, reason: '内容不合法' });
              continue;
            }
            const r = store.addSkill(skill);
            if (r.error) skipped.push({ title: entry.title, reason: r.error });
            else imported.push(r.skill.title);
          }
        } else if (kind === 'mcp') {
          for (const entry of found.mcpServers) {
            if (!wanted.has((entry.name || '').toLowerCase())) continue;
            if (entry.imported) {
              skipped.push({ title: entry.name, reason: '已经导入过了' });
              continue;
            }
            const server = localMcpToLibrary(entry);
            if (!server) {
              skipped.push({ title: entry.name, reason: '配置不合法' });
              continue;
            }
            const r = store.addMcpServer(server);
            if (r.error) skipped.push({ title: entry.name, reason: r.error });
            else imported.push(r.server.name);
          }
        } else {
          return send(res, 400, { error: 'kind 只能是 skill 或 mcp' });
        }

        if (imported.length && kind === 'mcp') await runner.applyMcpChange?.();
        log(`📥 从本机导入 ${imported.length} 个 ${kind}${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`);
        return send(res, 200, { imported, skipped });
      }

      // ---------- MCP 服务库（全局，所有 bot 共享） ----------
      // 跟技能库不一样的地方：这里配的服务会**真去起子进程/连远端**，
      // 所以默认 enabled=false，而且还要 bot 自己选中才挂载。
      if (pathname === '/api/mcp' && req.method === 'GET') {
        return send(res, 200, {
          servers: store.mcpLibrary(),
          limits: {
            types: MCP_TYPES,
            exposures: MCP_EXPOSURES,
            maxTotal: MCP_LIMITS.total,
            maxTimeout: MCP_LIMITS.timeoutSeconds,
          },
        });
      }

      if (pathname === '/api/mcp' && req.method === 'POST') {
        const body = await readBody(req);
        const r = store.addMcpServer(body);
        if (r.error) return send(res, 400, { error: r.error });
        // 改了服务库，挂着它的会话要重建才能拿到新工具
        await runner.applyMcpChange?.();
        return send(res, 200, { server: r.server });
      }

      const mcpMatch = pathname.match(/^\/api\/mcp\/([^/]+)$/);
      if (mcpMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const r = store.updateMcpServer(decodeURIComponent(mcpMatch[1]), body);
        if (r.error) return send(res, 404, { error: r.error });
        await runner.applyMcpChange?.();
        return send(res, 200, { server: r.server });
      }
      if (mcpMatch && req.method === 'DELETE') {
        const r = store.removeMcpServer(decodeURIComponent(mcpMatch[1]));
        if (r.error) return send(res, 404, { error: r.error });
        await runner.applyMcpChange?.();
        return send(res, 200, { ok: true });
      }

      /**
       * 测一下这个 MCP 服务能不能连上。
       *
       * 不分类型写两套逻辑：都是"能不能把 TCP 打通并用得上"。
       * HTTP 直接打个请求；stdio 真的把命令跑起来看能不能启动。
       * 不在这里跑完整 MCP 握手（那要拉 SDK，太重），只回答"这条路通不通"。
       */
      if (pathname === '/api/mcp/test' && req.method === 'POST') {
        const body = await readBody(req);
        const saved = body.id ? store.mcpLibrary().find((s) => s.id === body.id) : null;
        const merged = { ...(saved ?? {}), ...body };
        const reason = mcpRejectReason(merged);
        if (reason) return send(res, 200, { ok: false, error: reason });
        const probe = normalizeMcpServer(merged);
        if (!probe) return send(res, 200, { ok: false, error: '配置不合法' });
        const r = await testMcpServer(probe);
        return send(res, 200, r);
      }

      // ---------- 技能库（全局，所有 bot 共享） ----------
      if (pathname === '/api/skills' && req.method === 'GET') {
        return send(res, 200, { skills: store.skillLibrary() });
      }

      if (pathname === '/api/skills' && req.method === 'POST') {
        const body = await readBody(req);
        const r = store.addSkill({
          title: body.title,
          summary: body.summary,
          howto: body.howto,
          tags: body.tags,
        });
        if (r.error) return send(res, 400, { error: r.error });
        return send(res, 200, { skill: r.skill });
      }

      const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const r = store.updateSkill(decodeURIComponent(skillMatch[1]), body);
        if (r.error) return send(res, 404, { error: r.error });
        return send(res, 200, { skill: r.skill });
      }
      if (skillMatch && req.method === 'DELETE') {
        const r = store.removeSkill(decodeURIComponent(skillMatch[1]));
        if (r.error) return send(res, 404, { error: r.error });
        return send(res, 200, { ok: true });
      }

      // 导入：客户端把 SKILL.md 的正文读出来发给这里，服务端负责解析
      // （放在服务端解析是为了让导入规则只有一份，和手动添加走同一套规范化）
      if (pathname === '/api/skills/import' && req.method === 'POST') {
        const body = await readBody(req);
        const files = Array.isArray(body.files) ? body.files : [];
        const parsed = [];
        const unparsed = [];
        for (const f of files.slice(0, 100)) {
          const skill = parseSkillMarkdown(f?.text, f?.name);
          if (skill) parsed.push(skill);
          else unparsed.push({ name: String(f?.name ?? ''), reason: '解析不出内容' });
        }
        const r = store.importSkills(parsed);
        return send(res, 200, {
          imported: r.imported,
          skipped: [...r.skipped, ...unparsed],
        });
      }

      // 检查更新：只查不装。下载与安装由客户端在用户确认后自己做。
      if (pathname === '/api/update' && req.method === 'GET') {
        const platform = String(url.searchParams.get('platform') || '').trim() || undefined;
        const force = url.searchParams.get('force') === '1';
        const info = await checkForUpdate({ platform, force });
        return send(res, 200, info);
      }

      // ---------- 附件 ----------
      // ---------- 分片上传（大文件走这里） ----------
      if (pathname === '/api/uploads/init' && req.method === 'POST') {
        const body = await readBody(req);
        const started = uploads.init(body);
        if (started.error) return send(res, 400, { error: started.error });
        return send(res, 200, started);
      }

      const chunkMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/chunk$/);
      if (chunkMatch && req.method === 'POST') {
        const limit = 4 * 1024 * 1024;
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > limit) return send(res, 413, { error: '单个分片不能超过 4MB' });
          chunks.push(chunk);
        }
        const result = uploads.writeChunk(
          chunkMatch[1],
          url.searchParams.get('offset'),
          Buffer.concat(chunks),
        );
        if (result.error) return send(res, 400, { error: result.error });
        return send(res, 200, result);
      }

      const completeMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/complete$/);
      if (completeMatch && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const done = await uploads.complete(completeMatch[1], { sha256: body?.sha256 });
        if (done.error) return send(res, 400, { error: done.error });
        // 不整读：临时文件直接搬进附件目录（rename，跨盘才退化成 copy）
        const meta = saveMovedFile(done.filePath, { name: done.name, mime: done.mime });
        return send(res, 200, { attachment: { ...meta, url: `/api/files/${meta.id}` } });
      }

      const abortUploadMatch = pathname.match(/^\/api\/uploads\/([^/]+)$/);
      if (abortUploadMatch && req.method === 'DELETE') {
        return send(res, 200, { aborted: uploads.abort(abortUploadMatch[1]) });
      }

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
          // 附件同样是本机内容，不对外开放跨域读取
          'x-content-type-options': 'nosniff',
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
        const previous = store.getBot(botMatch[1]);
        if (!previous) return send(res, 404, { error: 'bot 不存在' });
        const model = runner.resolveModel?.(body.model ?? previous.model) ?? runner.model ?? {};
        const capacityProblem = capacityError({ ...previous, ...body }, model, { allowNull: true });
        if (capacityProblem) return send(res, 400, { error: capacityProblem });
        const bot = store.updateBot(botMatch[1], body);
        if (!bot) return send(res, 404, { error: 'bot 不存在' });
        if (['model', 'thinking', 'contextWindow', 'maxTokens', 'reserveTokens', 'keepRecentTokens']
          .some((key) => body[key] !== undefined)) runner.reloadSessionForBot(bot.id);
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
      // 思考强度的可选值集中由服务端给出：Windows 与 Mac 共用同一套枚举，
      // 升级只改一处，不会出现一端能选、另一端是死值。
      if (pathname === '/api/model-thinking/options' && req.method === 'GET') {
        return send(res, 200, {
          levels: THINKING_LEVELS,
          formats: THINKING_FORMATS,
          presets: THINKING_PRESETS,
          upstreamValues: THINKING_UPSTREAM_VALUES,
        });
      }

      if (pathname === '/api/model-groups' && req.method === 'GET') {
        return send(res, 200, { modelGroups: modelGroups.listPublic() });
      }

      if (pathname === '/api/model-groups' && req.method === 'POST') {
        const body = await readBody(req);
        const r = modelGroups.upsert(body);
        if (r.error) return send(res, 400, { error: r.error });
        // 运行时热注册，加完不用重启
        const total = await runner.applyModelGroupChange(r.group.id);
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
        // 同 DELETE：刷新含真实网络请求（checkAuth），不等它 ——
        // 否则 baseUrl 不通时保存也卡死。配置已落盘，后台同步菜单即可。
        runner
          .applyModelGroupChange(r.group.id)
          .catch((err) => log(`保存后刷新失败（不影响保存本身）：${err?.message ?? err}`));
        return send(res, 200, { group: r.group.toPublic() });
      }
      if (groupMatch && req.method === 'DELETE') {
        const ok2 = modelGroups.remove(groupMatch[1]);
        if (!ok2) return send(res, 404, { error: '模型组不存在' });
        // ★ 删除不等刷新完成就回 —— 刷新要对每个 provider 做真实网络请求
        //   （checkAuth），baseUrl 挂了的话会卡到超时（几十秒），
        //   用户看到的就是“删不掉”。
        //   删除本身已经落盘了，刷新只是同步内存里的菜单，后台跑完自然生效。
        runner
          .applyModelGroupChange(groupMatch[1])
          .then(() => log(`🔌 删除模型组：${groupMatch[1]}`))
          .catch((err) => log(`删除后刷新失败（不影响删除本身）：${err?.message ?? err}`));
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
        // 空私聊 → 让它自己开口（自我介绍 + 询问卡片），不阻塞这次请求
        runner.greetDm(room.id, body.botId).catch((err) =>
          log('私聊开场失败：', err?.message || err),
        );
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
      const status =
        code === 'BUSY'
          ? 409
          : code === 'BODY_TOO_LARGE'
            ? 413
            : code === 'INVALID_JSON'
              ? 400
              : code
                ? 400
                : 500;
      return send(res, status, { error: String(err?.message || err), code });
    }
  });

  return server;
}

export function serverInfo(runner) {
  return {
    version: VERSION,
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
