/**
 * REST 接口。除 /health 和 /api/pair 外全部需要 token。
 * 流式输出走 WebSocket（ws.js），HTTP 负责控制面 + 历史拉取。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config as defaultConfig } from './config.js';
import { modelGroups as defaultModelGroups } from './model-groups.js';
import {
  THINKING_FORMATS,
  THINKING_LEVELS,
  THINKING_PRESETS,
  THINKING_UPSTREAM_VALUES,
} from './model-thinking.js';
import { store as defaultStore } from './store.js';
import { normalizeGrant } from './grants.js';
import { planGrantsFromRequest } from './grant-request.js';
import {
  deleteAttachments,
  referencedAttachmentIds,
  isAttachmentDeleted,
  attachmentDeletionRevision,
  withoutDeletedAttachments,
  metaFor,
  pathFor,
  saveBuffer,
  saveMovedFile,
} from './attachments.js';
import { lanAddresses } from './pairing.js';
import { timingSafeEqual, log } from './util.js';
import { noticeBrandDeprecation } from './brand.js';
import { readLocalToken } from './local-token.js';
import { NONCE_PURPOSE, consumeNonce, issueNonce } from './local-nonce.js';
import { planAdminRoute } from './http-admin.js';
import { createPairRequests } from './pair-requests.js';
import { activeTls } from './tls.js';
import { describeConfirmation } from './confirm.js';
import { SECOND_FACTOR_TOOLS } from './capabilities.js';
import { shells } from './shells.js';
import { VERSION } from './version.js';
import { checkForUpdate } from './update-checker.js';
import {
  selectLessonsFor,
  lessonsPromptLines,
  LESSON_LIMITS,
} from './lessons.js';
import {
  MCP_LIMITS,
  MCP_TYPES,
  MCP_EXPOSURES,
} from './mcp.js';
import { bus as defaultBus } from './bus.js';
import { createConnections } from './connections.js';
import { createTaskRunRoutes } from './task-routes.js';
import { createRequestResultService, createTerminalPublisher } from './tasks/task-request-result.js';
import { openRequest, createRequestLifecycle, resumeAdmitted } from './coordination/task-request-gate.js';
import { createRequestReceipts } from './tasks/task-request-receipts.js';
import { routeConnections } from './connections-http.js';
import { probeLogin } from './site-probe.js';
import { createSiteRuntime } from './site-runtime.js';
import { planFirstRun, planFirstRunGrants, desktopStatusOf } from './onboarding.js';
import { desktopInputPlatform } from './desktop-input-session.js';
import { publicSite } from './sites.js';
import { UploadSessions } from './upload-sessions.js';
import { loadHooks, saveHooks, validateHook } from './hooks.js';
import { createServices, publicDecision } from './services/index.js';

/// 返回带稳定错误码的失败响应。
///
/// 约定：`error` 保留人读的中文兜底（老客户端仍能用），
/// `code` 是给客户端做本地化用的稳定标识 —— 界面语言切换后
/// 客户端按 code 取自己的文案，不依赖服务端语言。
///
/// @param {string} code 大写下划线标识，如 ROOM_NOT_FOUND
/// @param {string} message 人读兜底文案
function fail(res, status, code, message, extra = null) {
  return send(res, status, { error: message, code, ...(extra ?? {}) });
}

function send(res, status, body) {
  // 防御：任何分支都不该在已发送响应后再次写头（路由重复处理时的兜底）
  if (res.headersSent || res.writableEnded) return;
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

/**
 * 桌面输入探针的结果缓存（规格 §13.2-1 要的是**实际**系统权限）。
 *
 * 为什么需要缓存：Windows 的探针会起一次 PowerShell（取屏幕信息 + 会话），
 * 真去跑一次要几百毫秒。页面重开、多窗口同时拉一次就会连着起一串进程。
 *
 * 为什么只缓 60 秒：用户刚在系统里改了权限（或刚锁屏/解锁）就应该能看到
 * 变化。缓太久会让“实际结果”变成“上次的结果”——那和第 4 步要求的
 * “按实际结果报”正好相反。
 */
const DESKTOP_PROBE_TTL = 60_000;
let desktopProbeCache = { at: 0, value: null };

/**
 * 首启页能选的项目。
 *
 * 现在只有一个候选（服务端的工作目录）：仓库里还没有“项目列表”这个东西，
 * 凭空造一个会让用户选到不存在的路径。多项目等真有了再加 ——
 * 而且到时候 `planFirstRunGrants` 已经在拿同一份列表做校验，不用改两处。
 */
function onboardingProjects(cfg = defaultConfig) {
  return [
    {
      id: 'workspace',
      label: path.basename(cfg.workspace) || 'workspace',
      path: cfg.workspace,
    },
  ];
}

function desktopProbe() {
  const now = Date.now();
  if (desktopProbeCache.value && now - desktopProbeCache.at < DESKTOP_PROBE_TTL) {
    return desktopProbeCache.value;
  }
  let value;
  try {
    value = desktopInputPlatform().probeEnvironment();
  } catch (err) {
    // 探针自己炸了也是“实际结果”的一部分：按失败报，不当成可用。
    value = { ok: false, code: 'call_failed', text: `探针抛异常：${err?.message ?? err}` };
  }
  desktopProbeCache = { at: now, value };
  return value;
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // 带上 code：下面的错误处理靠它回 413，不带就会变成 500。
    if (size > limit) throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' });
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
 * 本次启动的本机 token（懒加载）。
 *
 * 由 server-main 在 listen 之前调 issueLocalToken 写盘；
 * 这里只负责读出来比对。读不到时（文件被删/权限不对）返回 null，
 * 此时回环请求必须走正常配对流程，不再免 token。
 */
let _localTokenCache;

export function localToken(dataDir = defaultConfig.dataDir) {
  if (dataDir === defaultConfig.dataDir) {
    if (_localTokenCache !== undefined) return _localTokenCache;
    _localTokenCache = readLocalToken(dataDir);
    return _localTokenCache;
  }
  return readLocalToken(dataDir);
}

/** 测试用：重置缓存（服务端换 token 或测试里换数据目录时调）。 */
export function resetLocalTokenCache() {
  _localTokenCache = undefined;
}

/**
 * 请求是否携带了合法的本机 token。
 *
 * 用 timingSafeEqual 比对，避免按字节比较泄漏信息。
 */
function isLocalTokenValid(req, url, dataDir = defaultConfig.dataDir) {
  return isLocalToken(extractToken(req, url), dataDir);
}

/** 这个 token 是不是本次启动签发的本机 token（WS 侧也用它）。 */
export function isLocalToken(provided, dataDir = defaultConfig.dataDir) {
  if (!provided) return false;
  const expected = localToken(dataDir);
  if (!expected) return false;
  return timingSafeEqual(provided, expected);
}

export function isLoopback(req, cfg = defaultConfig) {
  if (!cfg.trustLocal) return false;
  // 中转进来的请求物理上也是回环，但代表远程设备，不能当主人
  if (req.headers?.['x-pi-relay']) return false;
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

/**
 * 桌面端 / 手机 App 在所有改状态的请求上都带这个头。
 * 浏览器跨站发自定义头必须先过 CORS 预检，而本服务从不放行预检，
 * 所以恶意网页伪造不了它（text/plain 表单、no-cors fetch 都带不上）。
 */
// @remove-2.0 2.0 起用 ORBIS_CLIENT_HEADER，旧头一并删（客户端同版本切换）
export const CLIENT_HEADER = 'x-pi-bot-client';
export const ORBIS_CLIENT_HEADER = 'x-orbis-client';
/** 过渡期响应头：告诉调用方“你还在用旧头，2.0 会删”（桌面端/App 日志里能看到） */
export const DEPRECATED_HEADER = 'x-orbis-deprecated';

/**
 * 新旧头配对表（1.7.1 过渡期）：现代头优先，两个都带就不算弃用。
 * 2.0 删旧头时，把这张表的第二列一并删掉。
 */
const LEGACY_HEADER_PAIRS = [
  [ORBIS_CLIENT_HEADER, CLIENT_HEADER],
  ['x-orbis-nonce', 'x-pi-bot-nonce'],
  ['x-orbis-channel', 'x-pi-bot-channel'],
];

/**
 * 只靠旧头认出客户端时：贴 `x-orbis-deprecated` 并进程内提醒一次。
 *
 * 为什么只在“没带现代头”时才算：新客户端两个都带（见 sdk/client.js），
 * 那不是弃用，是向后兼容。
 *
 * @returns {string[]} 本次用到的旧头名（空数组 = 没用旧头）
 */
export function markDeprecatedHeaders(req, res) {
  const used = [];
  for (const [modern, legacy] of LEGACY_HEADER_PAIRS) {
    if (!String(req.headers?.[legacy] ?? '').trim()) continue;
    if (String(req.headers?.[modern] ?? '').trim()) continue;
    used.push(legacy);
    noticeBrandDeprecation({ kind: 'header', from: legacy, to: modern });
  }
  if (!used.length) return used;
  try {
    res.setHeader(DEPRECATED_HEADER, used.join(','));
  } catch { /* 头已发出（极少见）就算了，不影响响应本身 */ }
  return used;
}
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** content-type 的媒体类型（; 前面那段）必须严格是 application/json，参数（charset 等）不管。 */
export function isJsonContentType(value) {
  const media = String(value ?? '').split(';')[0].trim().toLowerCase();
  return media === 'application/json';
}

/**
 * Origin 是否就是本服务自己（同协议族、同 host、同端口）。
 * 和 ws.js 的握手校验同一个思路：浏览器页面只有同源才算自己人。
 */
export function isSameOrigin(req, cfg = defaultConfig) {
  const origin = req.headers?.origin;
  if (!origin) return false;
  let o;
  try {
    o = new URL(origin);
  } catch {
    return false; // 包括 Origin: null（沙箱 iframe、file://）
  }
  if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
  const host = String(req.headers?.host ?? '').trim().toLowerCase();
  return Boolean(host) && o.host.toLowerCase() === host && hostAllowed(o.host, cfg);
}

/**
 * 本机免 token 只给原生客户端（不带 Origin）和本服务自己的页面（同源 Origin）。
 * 其它网页即使跑在本机浏览器里、请求来自回环地址，也一律要 token。
 */
export function localTrustAllowed(req, cfg = defaultConfig) {
  if (!isLoopback(req, cfg)) return false;
  if (!req.headers?.origin) return true;
  return isSameOrigin(req, cfg);
}

/** 浏览器明确声明是跨站发起的请求：不管带不带 token 都不处理。 */
export function isCrossSiteFetch(req) {
  return String(req.headers?.['sec-fetch-site'] ?? '').trim().toLowerCase() === 'cross-site';
}

function authenticate(req, url, { config = defaultConfig, store = defaultStore } = {}) {
  const token = extractToken(req, url);
  if (token) {
    if (config.staticToken && timingSafeEqual(token, config.staticToken)) {
      return { id: 'static', name: 'static-token', createdAt: 0, lastSeenAt: Date.now(), isStatic: true };
    }
    if (config.trustLocal && isLocalTokenValid(req, url, config.dataDir)) {
      return { ...LOCAL_DEVICE, lastSeenAt: Date.now(), viaLocalToken: true };
    }
    const device = store.findDeviceByToken(token);
    if (device) store.touchDevice(token);
    return device;
  }
  if (isTokenFreePath(req, url) && localTrustAllowed(req, config)) {
    return { ...LOCAL_DEVICE, lastSeenAt: Date.now(), viaLocalFallback: true };
  }
  return null;
}

/**
 * 免 token 的路径白名单：只读、且不泄漏隐私的。
 *
 * ★ 默认拒绝。只有显式列在这里的才允许不带 token 访问。
 *
 * 为什么需要白名单：浏览器打开配对页、首次启动读服务器信息，
 * 这些发生在**还没有 token 之前**，必须能访问。
 * 但除此之外（尤其是所有改状态接口）都必须带 token。
 */
const TOKEN_FREE_PATHS = new Set([
  '/',            // 引导页
  '/pair',        // 配对页（页面公开：地址不是秘密）
  '/api/health',  // 存活探测
  '/api/ping',
]);

/** 桌面端首次启动、还没拿到 token 时需要读的基础信息（只读且不含隐私）。 */
const TOKEN_FREE_PREFIXES = [
  '/api/server-info',
  '/api/pairing',
];

function isTokenFreePath(req, url) {
  const pathname = url.pathname;
  if (TOKEN_FREE_PATHS.has(pathname)) return true;
  for (const prefix of TOKEN_FREE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      // 配对快照在无 token 时只返回"需配对"这个事实，不给配对码
      return req.method === 'GET';
    }
  }
  return false;
}

/**
 * Host 头是否指向本机。
 *
 * 桌面端连 127.0.0.1；手机连局域网 IP。除此之外（尤其是外部域名）一律拒绝 ——
 * 否则恶意网页把自己的域名解析到 127.0.0.1，浏览器就会以"同源"身份打进来
 * （DNS rebinding），连 CORS 都挡不住。
 */
// 只有这些类型允许内联展示（图片预览），其余一律下载，杜绝 html/svg/js 内联执行
// 能直接“在浏览器里看”的 MIME。
//
// ★ PDF 加在这里是有意的：WebView2 / WKWebView 都是 Chromium/WebKit 内核，
//   自带 PDF 阅读器，直接给 application/pdf（inline）就能拿到**真版式**,
//   不用我们抽文字。之前把它当二进制下载，所以只能看到“打不开”。
//   注意：只影响浏览器栏（/api/files/:id），下载走的是同一份 headers，
//   inline 不会阻止用户另存，只是默认行为不同。
const INLINE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf',
]);

export function fileResponseHeaders(meta) {
  const mime = String(meta.mime || '').toLowerCase().split(';')[0].trim();
  const inline = INLINE_MIMES.has(mime);
  const name = encodeURIComponent(meta.name || 'file');
  return {
    'content-type': inline ? mime : 'application/octet-stream',
    'content-length': meta.size,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
    'cache-control': 'private, max-age=86400',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  };
}

export function hostAllowed(hostHeader, cfg = defaultConfig) {
  const host = String(hostHeader ?? '').trim();
  if (!host) return false;
  const name = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':')[0];
  const lower = name.toLowerCase();
  if (lower === '127.0.0.1' || lower === 'localhost' || lower === '::1') return true;
  if (cfg.hostname && lower === String(cfg.hostname).toLowerCase()) return true;
  if (cfg.allowedHosts?.includes(lower)) return true;
  return lanAddresses().some((a) => String(a.address).toLowerCase() === lower);
}

/**
 * 请求处理器：HTTP 和 HTTPS 两个 listener **共享同一份**。
 *
 * 抽出来的原因很实际：手机走 `https://<ip>:<tlsPort>`（局域网要加密），
 * 桌面端走 `http://127.0.0.1:<port>`（本机回环，没有中间人可言，也就不必为它
 * 维护一张要跟网卡 IP 一起重签的证书）。两条链路不能各写一份路由。
 */
export function createRequestHandler({ runner, pairing, sites = createSiteRuntime({ log }) }) {
  const config = runner?.config ?? defaultConfig;
  const store = runner?.store ?? defaultStore;
  const bus = runner?.bus ?? defaultBus;
  const modelGroups = runner?.modelGroups ?? defaultModelGroups;
  const services = runner?.services ?? createServices({ config, store, bus, runner, modelGroups });

  const taskRunRoutes = createTaskRunRoutes({ store, runner });
  const httpRequestReceipts = createRequestReceipts({ dir: path.join(config.dataDir, 'task-requests') });
  const requestResultService = createRequestResultService({ receipts: httpRequestReceipts, taskRuns: store.taskRuns });
  const publishTerminal = createTerminalPublisher({ service: requestResultService, emit: (event) => bus.emit('event', event) });
  runner.setRequestLifecycle?.(createRequestLifecycle({
    receipts: httpRequestReceipts, taskRuns: store.taskRuns, onTerminal: publishTerminal,
  }));
  const connections = createConnections({ store, runner, onChange: () => bus.emit('event', { t: 'connections.changed' }) });
  // 连接请求：手机发起 → 电脑上弹窗 → 允许后发 token。
  // 事件走 bus，桌面 App 的 WS 会收到（见 app/lib/app_state.dart 的 pair.request 分支）。
  const pairRequests = createPairRequests({
    addDevice: (name) => store.addDevice(name),
    emit: (event) => bus.emit('event', event),
    describeServer: () => ({ serverName: config.serverName, workspace: config.workspace }),
  });
  const uploads = new UploadSessions({
    dir: path.join(config.dataDir, 'uploads', '_partial'),
  });
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const clientIp = (r) => String(r.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');

    // 旧客户端头过渡：只用了旧头才贴 x-orbis-deprecated（2.0 删旧头时一起去掉）
    markDeprecatedHeaders(req, res);

    // ★ Host 必须是本机名/本机 IP：防 DNS rebinding ——
    //   恶意域名解析到 127.0.0.1 时，Host 会是那个域名，这里直接拒。
    if (!hostAllowed(req.headers.host, config)) {
      return send(res, 403, { error: 'bad host' });
    }

    // ★ 浏览器标了 cross-site 的请求一律拒：本服务没有任何需要被别的网站调用的接口。
    if (isCrossSiteFetch(req)) {
      return send(res, 403, { error: 'cross-site request rejected' });
    }

    if (req.method === 'OPTIONS') return send(res, 204, {});

    try {
      // ---------- 公开 ----------
      if (pathname === '/health') {
        // 服务器模式下 /health 对公网公开（探活要用），只给身份和就绪状态；
        // 房间数、模型名这些只给本机部署（桌面端启动页要显示）。
        return send(res, 200, {
          ok: true,
          serverName: config.serverName,
          version: VERSION,
          // 只说「本机要不要 token」，不带 token 本身：桌面端据此提示去设置里填 token，
          // 而不是拿着空 token 一直重连。
          auth: config.trustLocal ? 'local' : 'token',
          // 加密监听的端口/指纹（null = 明文）。手机端据此显示"已加密 · 校验码"，
          // 桌面端弹窗用它显示同一串 6 位码给人比对。
          tls: activeTls(),
          ...(config.trustLocal
            ? { stats: store.stats(), model: runner.modelLabel(), note: runner.initNote }
            : {}),
        });
      }

      // 运行统计：缓存命中率 / 耗时 / 重试。
      //
      // 统计只给可信回环来源，并复用原生客户端或同源页面的身份检查。
      if (pathname === '/api/run-stats') {
        if (!isLoopback(req)) return fail(res, 403, 'LOCAL_ONLY', '仅本机可用');
        if (!authenticate(req, url)) return fail(res, 401, 'UNAUTHORIZED', '需要有效身份');
        const day = url.searchParams.get('day');
        const limit = Number(url.searchParams.get('limit') || 100);
        if (day) {
          const stat = runner.stats?.day(day) ?? null;
          return stat ? send(res, 200, { ok: true, day, ...stat }) : fail(res, 404, 'NO_STATS', '没有这一天的数据');
        }
        return send(res, 200, {
          ok: true,
          ...(runner.stats?.recent(Number.isFinite(limit) ? limit : 100) ?? {}),
          days: Object.keys(runner.stats?.days ?? {}).sort().slice(-30),
        });
      }

      // ---------- 连接请求（手机发起、电脑上点允许） ----------
      //
      // 和配对码一样是**未鉴权**入口（手机此时还没有 token），但比配对码多一道闸：
      // 必须有人在电脑上点"允许"，token 才会发下来。
      if (pathname === '/api/pair/request' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const view = pairRequests.create({
            device: body.device,
            platform: body.platform,
            ip: clientIp(req),
          });
          return send(res, 200, { ...view, serverName: config.serverName });
        } catch (err) {
          const status = err.code === 'PAIR_REQUEST_RATE_LIMITED' ? 429 : 409;
          return fail(res, status, err.code ?? 'PAIR_REQUEST_FAILED', err.message);
        }
      }

      // 手机轮询：批准后**只付一次** token（下次再查就是 gone）。
      const requestPollMatch = /^\/api\/pair\/request\/([a-f0-9]{32})$/.exec(pathname);
      if (requestPollMatch && req.method === 'GET') {
        let polled;
        try {
          polled = pairRequests.poll(requestPollMatch[1], { ip: clientIp(req) });
        } catch (err) {
          if (err.code === 'PAIR_REQUEST_WRONG_NETWORK') {
            return fail(res, 403, err.code, '这条连接请求是从另一台设备发起的，当前网络取不到它的授权');
          }
          throw err;
        }
        if (!polled.ok) {
          return fail(res, 410, 'PAIR_REQUEST_GONE', '这个连接请求已失效（过期或被处理过），在电脑上重新发起');
        }
        return send(res, 200, polled.view);
      }

      if (pathname === '/api/pair' && req.method === 'POST') {
        const body = await readBody(req);
        if (!pairing.verify(body.code)) {
          return fail(res, 401, 'PAIR_CODE_INVALID', '配对码不对或已过期，看服务端控制台最新那 6 位数字');
        }
        const { token, device } = store.addDevice(body.deviceName);
        // 配对码一次性：换到 token 后立即作废，避免同一码重复换发。
        pairing.rotate({ force: true });
        return send(res, 200, { token, device, serverName: config.serverName, workspace: config.workspace });
      }

      // ---------- 身份 ----------
      // 主人 = 本机回环请求（桌面端）或携带合法 token 的已配对设备。
      const device = authenticate(req, url, { config, store });

      // ---------- 网页版配对页 ----------
      // 页面公开（地址不是秘密），配对码只返回给已鉴权的请求。
      if (pathname === '/pair' && req.method === 'GET') {
        const trustedForCode = Boolean(device) && !device.viaLocalFallback;
        const snap = config.staticToken ? null : pairing.snapshot({ withCode: trustedForCode });
        const html = pairPage(snap, config);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }

      if (!device) return send(res, 401, { error: 'unauthorized' });

      // ★ 改状态的请求（含上传、删除）必须带客户端自定义头：跨站网页带不上它。
      if (
        STATE_CHANGING_METHODS.has(req.method) &&
        !String(req.headers[ORBIS_CLIENT_HEADER] ?? req.headers[CLIENT_HEADER] ?? '').trim()
      ) {
        return send(res, 403, { error: `缺少 ${ORBIS_CLIENT_HEADER} 请求头（旧名 ${CLIENT_HEADER} 仍可用，2.0 移除）` });
      }

      // ★ 状态变更请求必须声明 JSON：浏览器跨域发 text/plain 不会触发预检，
      //   光靠 CORS 挡不住"只求副作用不求回显"的攻击。
      //   只认媒体类型本身：text/plain; charset=application/json 这种不算。
      //   上传接口例外（传的是原始字节），但它同样要过上面的自定义头校验。
      const isUploadRoute =
        pathname === '/api/uploads' || pathname.startsWith('/api/uploads/');
      if (!isUploadRoute && ['POST', 'PATCH', 'PUT'].includes(req.method)) {
        if (!isJsonContentType(req.headers['content-type'])) {
          return fail(res, 415, 'BAD_CONTENT_TYPE', 'content-type 必须是 application/json');
        }
      }

      // ---------- 连接请求：电脑上处理 ----------
      // 待批列表：桌面 App 重新打开时能补上（WS 事件只推一次）。
      if (pathname === '/api/pair/requests' && req.method === 'GET') {
        return send(res, 200, { requests: pairRequests.pending() });
      }

      const requestDecideMatch = /^\/api\/pair\/request\/([a-f0-9]{32})$/.exec(pathname);
      if (requestDecideMatch && req.method === 'POST') {
        const body = await readBody(req);
        const result = pairRequests.decide(requestDecideMatch[1], body.approve === true);
        if (!result.ok) {
          const status = result.code === 'PAIR_REQUEST_NOT_FOUND' ? 404 : 409;
          return fail(res, status, result.code, '这个连接请求已经失效或处理过了（手机端需要重新发起）');
        }
        return send(res, 200, { ok: true, status: result.status });
      }

      // ★ 管理动作的审计 + 防冒充（规格 §5.5 / §11）。
      //
      //   这里**不是**"拦住用户" —— 用户在 App 里改自己的策略当然可以。
      //   要挡的是同用户的其它进程：它能读到 local-token 文件，
      //   拿它直接调 PATCH /api/policy 就能把防线改了。
      //   一次性 nonce 只由界面在真实点击时申请，堵的就是这条路。
      //
      //   nonce 的**校验**仍然在各路由自己手里（那里知道自己的 purpose），
      //   这里只做两件事：记账 + 拒绝"该带 nonce 却完全没带"的请求。
      const adminPlan = planAdminRoute({ method: req.method, pathname });
      if (adminPlan) {
        if (adminPlan.nonce) {
          // ★ 这里**真正消费** nonce，不是只看有没有这个头。
          //
          //   只看"头存在"等于没防：冒充者随手填一个字符串就过了。
          //   nonce 只能由界面在真实点击时申请（单次、60 秒、绑用途），
          //   所以"能拿出来一个未用过的"就是"刚有人在界面上点了"的证据。
          //
          //   校验点集中在这里之后，各路由**不再自己消费** ——
          //   两处都消费会让第二次必然失败。
          const check = consumeNonce(// @remove-2.0 旧头 x-pi-bot-nonce 在 2.0 删掉
          req.headers['x-orbis-nonce'] ?? req.headers['x-pi-bot-nonce'], adminPlan.nonce);
          if (!check.ok) {
            log(`🔒 ${adminPlan.label} 被拒：${check.reason}（${req.method} ${pathname}）`);
            return fail(
              res,
              403,
              'nonce_required',
              '这个操作要由界面在点击之后申请一次性凭据再发起，直接调用会被拒绝',
              // reason 保留具体原因：missing/unknown/expired/used/purpose。
              // 客户端据此能区分"没申请"和"申请了但过期了"。
              { reason: check.reason },
            );
          }
        }
        store.addAdminAction({
          action: adminPlan.action,
          level: adminPlan.level,
          label: adminPlan.label,
          method: req.method,
          path: pathname,
          deviceId: device?.id ?? null,
          deviceName: device?.name ?? '',
        });
      }

      // 配对码 / 已配对设备：都是主人才能看的东西，所以放在鉴权之后
      if (pathname === '/api/pairing' && req.method === 'GET') {
        // ★ 只有**真正带凭据**的调用方才给配对码。
        //
        //   原来这里无条件 withCode:true。配合"免 token 路径"，
        //   本机任意进程 GET /api/pairing 就能拿到 6 位配对码，
        //   再拿去换设备 token —— 整个 token 机制被完全绕过。
        //   （p0 回归测试里有一条专门验证这个。）
        const trustedForCode = Boolean(device) && !device.viaLocalFallback;
        return send(
          res,
          200,
          config.staticToken ? { static: true } : pairing.snapshot({ withCode: trustedForCode }),
        );
      }

      if (pathname === '/api/devices' && req.method === 'GET') {
        return send(res, 200, {
          // 不带 token：撤销用 id，客户端拿不到别人的凭证
          devices: store.listDevicesPublic(),
          localTrusted: config.trustLocal,
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
          attachmentDeletionRevision: attachmentDeletionRevision(),
          // 每个活着的会话的上下文占用（key 是 '房间:bot'）。
          // 放这儿而不是单开接口：App 每次刷新状态就顺带拿到了，少一次往返。
          context: runner.contextUsage(),
          // 用户自己配的模型组（**key 已打码**，真 key 不出服务端）
          modelGroups: modelGroups.listPublic(),
          // 群聊轮次预算（防止 bot 解不了就互相聊个没完）
          groupLimits: store.groupLimits(),
          policy: store.policy(),
          // 快速决策（Jev）的设置。key 已抹掉，只回"配没配"。
          // 放这里让 App 一次刷新就拿到，设置页不用再单独拉一次。
          decision: publicDecision(store.decision()),
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

      // ---------- 授权与审计（只读，给界面看） ----------
      //
      // 规格 §11：「用户始终可以接管、取消、收回授权」。
      // 后端已经有 revoke()，但用户看不到有哪些授权 —— 那等于收不回。
      // 这三个都是 GET：不改状态，所以不要 nonce、不写管理审计。
      if (pathname === '/api/grants' && req.method === 'GET') {
        const gate = runner.grantGate;
        if (!gate) return send(res, 200, { grants: [], note: '网关未启用' });
        const botId = url.searchParams.get('botId');
        return send(res, 200, {
          grants: gate.list({ botId: botId || null }),
          // 顺带给出"当前规矩版本"，界面能看出哪些授权是基于旧规矩的
          policyRevision: store.policyVersion(),
          // ★ 当前实例世代：任务级授权（带 taskId）绑了它，重启后就失效。
          //   界面要能标出来 —— 否则用户看到"授权开着"却一直被拒
          //   （2026-11-16 实际发生过）。
          generation: gate.currentGeneration?.() ?? null,
        });
      }

      // ---------- 桌面设置（规格 §5.2 / §5.6） ----------
      //
      // GET 只读（看设置 + 看这台桌面的输入环境诊断），不要 nonce。
      // PATCH 是**放宽**，过管理门（defense + policy nonce + 审计）。
      //
      // 为什么要把诊断一起给出去：用户遇到"它明明有权限却不动鼠标"时，
      // 唯一能解释这件事的就是这段诊断（有东西在合成输入 / 探针不可用）。
      if (pathname === '/api/desktop-settings' && req.method === 'GET') {
        let environment = null;
        try {
          environment = desktopInputSession().inputEnvironment?.() ?? null;
        } catch { /* 探针没装配时就是 null，不影响读设置 */ }
        return send(res, 200, { settings: store.desktopSettings(), environment });
      }
      if (pathname === '/api/desktop-settings' && req.method === 'PATCH') {
        const body = await readBody(req);
        const { settings: next } = services.policy.updateDesktopSettings(body ?? {});
        log(`🖱 桌面设置已更新：信任合成输入=${next.trustPhantomInput ? '开' : '关'}`);
        return send(res, 200, { settings: next });
      }

      if (pathname === '/api/onboarding' && req.method === 'GET') {
        return send(res, 200, {
          ...planFirstRun({
            policy: store.policy(),
            bots: store.listBots(),
            projects: onboardingProjects(config),
            grants: store.state.grants ?? [],
            desktop: desktopStatusOf(desktopProbe()),
            mcpServerCount: store.mcpLibrary().length,
            platform: process.platform,
          }),
          // 上次走过首启时选了什么（界面用它回填选项）
          onboarding: store.onboarding(),
        });
      }

      if (pathname === '/api/onboarding/apply' && req.method === 'POST') {
        const gate = runner.grantGate;
        if (!gate) return fail(res, 503, 'NO_GATE', '网关未启用');
        const body = await readBody(req);
        const plan = planFirstRunGrants({
          projectId: body?.projectId,
          gitScope: body?.gitScope,
          bots: store.listBots(),
          projects: onboardingProjects(config),
        });
        if (!plan.ok) return fail(res, 400, plan.code.toUpperCase(), plan.text);

        // 整批一起过校验，不要让“第二条失败了、第一条已经落盘”变成半个状态。
        for (const spec of plan.grants) {
          const bad = normalizeGrant({ ...spec, id: `pre_${spec.subject.botId}` });
          if (!bad.ok) return fail(res, 400, 'BAD_GRANT', bad.text);
        }

        const pre = store.onboarding();
        const revoked = [];
        for (const id of pre.grantIds) {
          const r = gate.revoke(id, '首次授权页重新选择，旧的一条作废');
          if (r.ok && !r.alreadyRevoked) revoked.push(id);
        }

        const created = [];
        for (const spec of plan.grants) {
          const r = gate.add(spec);
          if (!r.ok) {
            // ★ 退回已经建好的那几条。
            //
            //   半个状态比失败更坏：用户重试一次，面板上就会多出一批
            //   连他自己也分不清的授权（哪条是上一轮的？）。
            for (const id of created) gate.revoke(id, '首启授权未完成，回退');
            return fail(res, 500, 'GRANT_FAILED', `授权建立失败（已回退）：${r.text}`);
          }
          created.push(r.grant.id);
        }

        const record = store.setOnboarding({
          doneAt: Date.now(),
          projectId: plan.project.id,
          projectPath: plan.project.path,
          gitScope: String(body?.gitScope),
          actions: plan.actions,
          grantIds: created,
        });
        log(`🔑 首次授权：项目 ${plan.project.path}｜${plan.actions.join(',')}｜${created.length} 条`);
        return send(res, 200, {
          ok: true,
          created,
          revoked,
          project: plan.project,
          actions: plan.actions,
          notes: plan.notes,
          onboarding: record,
        });
      }

      const grantRevokeMatch = pathname.match(/^\/api\/grants\/([^/]+)\/revoke$/);
      if (grantRevokeMatch && req.method === 'POST') {
        // 收回授权是**降低权限**的动作，所以不要 nonce、不写管理审计。
        //
        // 理由和「撤销设备」一样：冒充者替你收回一条授权，损失的只有你自己
        // （那个 bot 少了一项能力），他不会因此获得任何东西。反过来要求 nonce
        // 会让“发现异常时立刻收权”变复杂 —— 安全动作不该被防冒充的门槛挡住。
        // “撤销”本身靠身份 + CSRF 就够（http-admin 里也标的是 probe 档）。
        const gate = runner.grantGate;
        if (!gate) return fail(res, 503, 'NO_GATE', '网关未启用');
        const id = decodeURIComponent(grantRevokeMatch[1]);
        const out = gate.revoke(id, '用户在界面上收回');
        if (!out.ok) return fail(res, 404, 'GRANT_NOT_FOUND', out.text);
        log(`🔒 用户收回授权 ${id}${out.downstream?.length ? `（连带 ${out.downstream.length} 条）` : ''}`);
        return send(res, 200, { revoked: id, downstream: out.downstream ?? [] });
      }

      // 授权审计：谁在什么时候做了什么、被放进还是被拒、为什么。
      //
      // 规格 §5.5 要求动作可审计，而 `gate.recentAudit()` 从 P0-1 起就有
      // ——只是没有任何接口把它读出去，等于白记。只读：不要 nonce、不写审计。
      if (pathname === '/api/grant-audit' && req.method === 'GET') {
        const gate = runner.grantGate;
        if (!gate) return send(res, 200, { audit: [], note: '网关未启用' });
        const botId = url.searchParams.get('botId');
        const limit = Number(url.searchParams.get('limit') || 100);
        const onlyDenied = url.searchParams.get('denied') === '1';
        return send(res, 200, {
          audit: gate.recentAudit({ botId: botId || null, limit, onlyDenied }),
        });
      }
      if (pathname === '/api/admin-actions' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 50);
        return send(res, 200, {
          actions: store.listAdminActions({ limit }),
        });
      }

      // ---------- 危险动作确认（P0-4） ----------
      //
      // ★ 通道决定权重：`device`（已配对手机）能确认不可恢复动作；
      //   `local`（本机桌面）只能确认可恢复的动作 —— 因为主 Bot 拿到
      //   宿主 shell 之后能驱动本机界面，它自己弹的卡片它可以自己点
      //   （规格 §9 明确要求承认这一点）。
      if (pathname === '/api/confirmations' && req.method === 'GET') {
        const roomId = url.searchParams.get('roomId');
        return send(res, 200, { confirmations: store.pendingConfirmations({ roomId }) });
      }

      // 客户端自报通道：桌面端带 x-orbis-channel / x-pi-bot-channel: local，手机端带 device。
      // 不信任头本身 —— 用它只是"降权"，声称 local 只会让确认更难通过。
      // @remove-2.0 旧头 x-pi-bot-channel 在 2.0 删掉
      const rawChannel = req.headers['x-orbis-channel'] ?? req.headers['x-pi-bot-channel'] ?? '';
      const clientChannel = String(rawChannel).toLowerCase() === 'device'
        && !device?.isLocal
        ? 'device'
        : 'local';

      const confirmMatch = pathname.match(/^\/api\/confirmations\/([^/]+)$/);
      if (confirmMatch && req.method === 'POST') {
        const body = await readBody(req);
        const id = decodeURIComponent(confirmMatch[1]);
        const existing = store.getConfirmation(id);
        if (!existing) return fail(res, 404, 'CONFIRMATION_NOT_FOUND', '没有这条确认');
        if (existing.decision !== null) {
          return send(res, 200, { confirmation: existing, replayed: true });
        }
        const approved = body?.approve === true;

        // 通道校验在 store.decideConfirmation 里（集中一处，绕不过去）；
        // 这里只把 403 翻成人话。
        const c = store.decideConfirmation(id, {
          approved,
          channel: clientChannel,
          device,
        });
        if (!c) return fail(res, 404, 'CONFIRMATION_NOT_FOUND', '没有这条确认');
        if (c.rejected) {
          return fail(res, 403, 'WEAK_CHANNEL', c.rejectedReason);
        }
        log(
          `🛡 ${approved ? '批准' : '拒绝'}：${describeConfirmation(c)}` +
            `（通道 ${clientChannel}${device?.name ? '，' + device.name : ''}）`,
        );

        // ★ 授权申请（grant.request）批准之后，**在这里**以用户的名义建授权。
        //
        //   为什么不放在 store.decideConfirmation 里：那里拿不到网关（gate.add
        //   要它），也拿不到当前规矩版本。放在路由里，批准的路径只有一条：
        //   手机点名批准 → 这里建 grant → 下一次动作就能过。
        //
        //   为什么是"用户的名义"：`source: SOURCE.user`，`sourceRef` 写着
        //   "用户在批准卡片上同意（手机名）"。这不是模型自己在扩权。
        if (approved && c.action === 'grant.request') {
          const gate = runner.grantGate;
          if (!gate) return fail(res, 503, 'NO_GATE', '网关未启用，先别发授权');
          let req = null;
          try {
            req = JSON.parse(c.targetJson ?? '{}');
          } catch { req = null; }
          if (!req || !Array.isArray(req.actions) || !Array.isArray(req.bots)) {
            return fail(res, 400, 'BAD_GRANT_REQUEST', '这条申请的原文坏了，没有建任何授权');
          }
          const specs = planGrantsFromRequest({
            request: req,
            approvedBy: { deviceName: device?.name ?? c.decidedByDeviceName ?? '', channel: clientChannel },
            policyRevision: store.policyVersion(),
          });
          const created = [];
          for (const spec of specs) {
            const bad = normalizeGrant({ ...spec, id: `pre_${spec.subject.botId}` });
            if (!bad.ok) return fail(res, 400, 'BAD_GRANT', bad.text);
          }
          for (const spec of specs) {
            const r = gate.add(spec);
            if (!r.ok) {
              // 半个状态要回退（和首启页那条一样）
              for (const id of created) gate.revoke(id, '授权申请未完成，回退');
              return fail(res, 500, 'GRANT_FAILED', `建授权失败（已回退）：${r.text}`);
            }
            created.push(r.grant.id);
          }
          store.consumeConfirmation(c.id);   // 一次一用
          log(`🔑 授权申请已批准：${created.length} 条（${(req.actions ?? []).join(',')}）`);
          bus.emit('event', { t: 'grants.issued', grantIds: created });
          return send(res, 200, { confirmation: c, granted: created });
        }

        // ★ 二级强确认（高危工具）：结论写回卡片，并让会话继续。
        //
        //   卡片更新：前端据此把按钮置灰；消息里留一条结果，用户回头能看见“当时批了什么”。
        //   自动续跑：复用 approval 那条续跑入口（它只用到 roomId/botId/tool/summary）。
        //   为什么值得自动续跑：批准发生在手机上，用户批完通常已经离开会话 ——
        //   不续跑的话，模型会一直卡在“等用户批准”那句话上。
        if (SECOND_FACTOR_TOOLS.includes(c.action) && c.roomId) {
          const card = (store.listMessages(c.roomId, { limit: 200 }) ?? []).find(
            (m) => m?.meta?.confirmationId === c.id,
          );
          if (card) {
            store.updateMessage(c.roomId, card.id, {
              meta: { ...(card.meta ?? {}), decision: approved ? 'approved' : 'denied' },
            });
          }
          if (approved && c.requestedBy) {
            runner.resumeAfterApproval({
              id: c.id,
              roomId: c.roomId,
              botId: c.requestedBy,
              tool: c.action,
              summary: c.summary ?? '',
            }).catch((err) => log('高危确认批准后继续失败：', err?.message || err));
          }
        }

        bus.emit('event', { t: 'confirmation.updated', confirmation: c });
        return send(res, 200, { confirmation: c });
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
            capabilityRevision: approval.capabilityRevision ?? null,
          });
        }
        if (!approval) return fail(res, 400, 'APPROVAL_NOT_PENDING', '没有待批准的这一条');

        // 卡片状态跟着变（前端据此把按钮置灰）
        const card = (store.listMessages(approval.roomId, { limit: 200 }) ?? []).find(
          (m) => m?.meta?.approvalId === approval.id,
        );
        if (card) {
          store.updateMessage(approval.roomId, card.id, {
            meta: { ...(card.meta ?? {}), decision: approval.status },
          });
        }

        // 受管审批：回到原 TaskRun（可装配；未装配时保持旧行为）
        const bridges = runner.taskBridges ?? null;
        const managedApproval = approval && bridges
          ? await bridges.onApprovalDecided(approval).catch(() => ({ routed: false }))
          : { routed: false };
        if (managedApproval.routed) {
          // 已交回受管任务，不再启动无任务执行
        } else if (approval.status === 'approved') {
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
        return send(res, 200, { automations: services.automations.list({ roomId }) });
      }

      if (pathname === '/api/automations' && req.method === 'POST') {
        const body = await readBody(req);
        const r = services.automations.create({
          roomId: body.roomId,
          title: body.title,
          prompt: body.prompt,
          botId: body.botId ?? null,
          everyMinutes: body.everyMinutes ?? null,
          dailyAt: body.dailyAt ?? null,
          enabled: body.enabled !== false,
          createdBy: device.id,
        });
        if (!r.ok) {
          return r.code === 'SCHEDULE_INVALID'
            ? send(res, 400, { error: r.error })
            : fail(res, r.status, r.code, r.error);
        }
        return send(res, 200, { automation: r.automation });
      }

      const autoMatch = pathname.match(/^\/api\/automations\/([^/]+)$/);
      if (autoMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const r = services.automations.update(autoMatch[1], body);
        if (!r.ok) {
          return r.code === 'SCHEDULE_INVALID'
            ? send(res, 400, { error: r.error })
            : fail(res, r.status, r.code, r.error);
        }
        return send(res, 200, { automation: r.automation });
      }
      if (autoMatch && req.method === 'DELETE') {
        const { deleted } = services.automations.remove(autoMatch[1]);
        return send(res, 200, { deleted });
      }

      const autoRunMatch = pathname.match(/^\/api\/automations\/([^/]+)\/run$/);
      if (autoRunMatch && req.method === 'POST') {
        const automation = store.getAutomation(autoRunMatch[1]);
        if (!automation) return fail(res, 404, 'AUTOMATION_NOT_FOUND', '定时任务不存在');
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
        if (!task) return fail(res, 400, 'TASK_NEEDS_TITLE', '任务需要一个标题');
        return send(res, 200, { task });
      }

      const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const task = store.updateTask(taskMatch[1], body);
        if (!task) return fail(res, 404, 'TASK_NOT_FOUND', '任务不存在');
        return send(res, 200, { task });
      }
      if (taskMatch && req.method === 'DELETE') {
        const okDeleted = store.deleteTask(taskMatch[1]);
        return send(res, okDeleted ? 200 : 404, { deleted: okDeleted });
      }

      // ---------- 任务运行（独立 TaskRun） ----------
      if (await taskRunRoutes({ req, res, url, pathname, readBody, send, fail, device })) return;

      if (pathname === '/api/models' && req.method === 'GET') {
        const keyword = (url.searchParams.get('q') || '').toLowerCase();
        const all = runner.availableModels;
        const list = keyword ? all.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(keyword)) : all;
        // ★ 带上模型组里的思考声明：前台靠它决定要不要展示思考档位。
        //   注册到 pi runtime 的模型对象不会带模型组自己的 thinkingLevelMap，
        //   所以要回去查模型组那份原始配置。
        const thinkingBySlug = new Map();
        for (const group of modelGroups.list()) {
          for (const model of group.models) {
            thinkingBySlug.set(`${group.id}/${model.id}`, model);
          }
        }
        const decorate = (m) => {
          const own = thinkingBySlug.get(`${m.provider}/${m.id}`);
          // 模型组里配过的：以组里的声明为准（用户可以自己填映射）
          if (own) {
            return {
              ...m,
              reasoning: Boolean(own.reasoning),
              thinkingFormat: own.thinkingFormat || '',
              thinkingLevels: availableThinkingLevels(own),
            };
          }
          // pi 级模型（models.json）：runner 已经按模型自带的 thinkingLevelMap 算好了
          return {
            ...m,
            reasoning: Boolean(m.reasoning),
            thinkingLevels: m.thinkingLevels ?? [],
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
        if (!site) return fail(res, 404, 'SITE_NOT_FOUND', '系统不存在');
        const body = await readBody(req);
        const teamName = String(body.name ?? `${site.name} 团队`).slice(0, 40);

        // 已经有团队就直接复用（别重复建部门）
        if (site.teamRoomId && store.getRoom(site.teamRoomId)) {
          return send(res, 200, { roomId: site.teamRoomId, reused: true });
        }

        // 部门只放一个人：它专门负责回答这个系统的事。
        // 不再自动塞一堆角色 —— 保持"一个系统一个团队"，
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
        if (!site) return fail(res, 404, 'SITE_NOT_FOUND', '系统不存在');
        const r = await sites.ping(site);
        return send(res, 200, r);
      }

      if (await routeConnections({ req, res, pathname, connections, readBody, send })) return;

      // ---------- 本机已装能力（只读扫描，不碰用户的 pi 配置）----------
      if (pathname === '/api/local-capabilities' && req.method === 'GET') {
        return send(res, 200, services.capabilities.scanLocal({ sanitizeMcp: true }));
      }

      if (pathname === '/api/local-capabilities/import' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await services.capabilities.importLocal({
          kind: String(body.kind ?? ''),
          names: Array.isArray(body.names) ? body.names : [],
          all: body.all === true,
          enable: false,
        });
        if (!r.ok) return fail(res, r.status, r.code, r.error);
        log(`📥 从本机导入 ${r.imported.length} 个 ${r.kind}${r.skipped.length ? `，跳过 ${r.skipped.length} 个` : ''}`);
        return send(res, 200, { imported: r.imported, skipped: r.skipped });
      }

      // ---------- MCP 服务库（全局，所有 bot 共享） ----------
      if (pathname === '/api/mcp' && req.method === 'GET') {
        return send(res, 200, {
          servers: services.capabilities.listMcp(),
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
        const r = await services.capabilities.addMcp(body, { applyChange: true });
        if (!r.ok) return send(res, 400, { error: r.error });
        return send(res, 200, { server: r.server });
      }

      const mcpMatch = pathname.match(/^\/api\/mcp\/([^/]+)$/);
      if (mcpMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const r = await services.capabilities.updateMcp(decodeURIComponent(mcpMatch[1]), body);
        if (!r.ok) return send(res, 404, { error: r.error });
        return send(res, 200, { server: r.server });
      }
      if (mcpMatch && req.method === 'DELETE') {
        const r = await services.capabilities.removeMcp(decodeURIComponent(mcpMatch[1]));
        if (!r.ok) return send(res, 404, { error: r.error });
        return send(res, 200, { ok: true });
      }

      if (pathname === '/api/mcp/test' && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, await connections.testDraft(body));
      }

      // ---------- 技能库（全局，所有 bot 共享） ----------
      if (pathname === '/api/skills' && req.method === 'GET') {
        return send(res, 200, { skills: services.capabilities.listSkills() });
      }

      if (pathname === '/api/skills' && req.method === 'POST') {
        const body = await readBody(req);
        const r = services.capabilities.addSkill({
          title: body.title,
          summary: body.summary,
          howto: body.howto,
          tags: body.tags,
        });
        if (!r.ok) return send(res, 400, { error: r.error });
        return send(res, 200, { skill: r.skill });
      }

      const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const r = services.capabilities.updateSkill(decodeURIComponent(skillMatch[1]), body);
        if (!r.ok) return send(res, 404, { error: r.error });
        return send(res, 200, { skill: r.skill });
      }
      if (skillMatch && req.method === 'DELETE') {
        const r = services.capabilities.removeSkill(decodeURIComponent(skillMatch[1]));
        if (!r.ok) return send(res, 404, { error: r.error });
        return send(res, 200, { ok: true });
      }

      if (pathname === '/api/skills/import' && req.method === 'POST') {
        const body = await readBody(req);
        const r = services.capabilities.importSkillMarkdown(body?.files);
        return send(res, 200, { imported: r.imported, skipped: r.skipped });
      }

      // ---------- 主控总汇总（撞忙浮窗三选一） ----------
      if (pathname === '/api/summaries' && req.method === 'GET') {
        return send(res, 200, { items: services.summaries.list() });
      }
      const summaryMatch = pathname.match(/^\/api\/summaries\/([^/]+)\/resolve$/);
      if (summaryMatch && req.method === 'POST') {
        const body = await readBody(req);
        const r = services.summaries.resolve(decodeURIComponent(summaryMatch[1]), String(body?.action ?? ''));
        if (!r.ok) return send(res, r.status ?? 400, { error: r.error });
        return send(res, 200, { batch: r.batch });
      }

      // ---------- 经验库（主控派活前按任务挑 1~3 条注入） ----------
      if (pathname === '/api/lessons/preview' && req.method === 'GET') {
        const task = String(url.searchParams.get('task') || '');
        const roomId = String(url.searchParams.get('roomId') || '');
        const picked = selectLessonsFor(services.capabilities.listLessons(), task, {
          roomId,
          edges: services.capabilities.listLessonEdges(),
          modelFamily: String(url.searchParams.get('modelFamily') || ''),
        });
        const lines = lessonsPromptLines(picked);
        return send(res, 200, {
          lines,
          chars: lines.join('\n').length,
          picked,
          limits: LESSON_LIMITS,
        });
      }

      if (pathname === '/api/lessons' && req.method === 'GET') {
        return send(res, 200, {
          lessons: services.capabilities.listLessons(),
          edges: services.capabilities.listLessonEdges(),
          limits: LESSON_LIMITS,
        });
      }

      // ---------- 经验关系边（SIM-Lite：supersedes / requires / contradicts / generalizes）----------
      if (pathname === '/api/lessons/edges' && req.method === 'POST') {
        const body = await readBody(req);
        const r = services.capabilities.addLessonEdge({
          from: body.from,
          to: body.to,
          type: body.type,
          by: body.by,
        });
        if (!r.ok) return send(res, r.status, { error: r.error });
        return send(res, 200, { edge: r.edge });
      }
      if (pathname === '/api/lessons/edges' && req.method === 'DELETE') {
        const r = services.capabilities.removeLessonEdge({
          from: String(url.searchParams.get('from') || ''),
          to: String(url.searchParams.get('to') || ''),
          type: String(url.searchParams.get('type') || ''),
        });
        if (!r.ok) return send(res, r.status, { error: r.error });
        return send(res, 200, { ok: true });
      }

      // 用户否决（「记错了」）：写 user 哨兵的 contradicts 边并归档 —— 否决权最轻的一条路
      const lessonReject = pathname.match(/^\/api\/lessons\/([^/]+)\/reject$/);
      if (lessonReject && req.method === 'POST') {
        const r = services.capabilities.rejectLesson(decodeURIComponent(lessonReject[1]));
        if (!r.ok) return send(res, r.status, { error: r.error });
        return send(res, 200, { lesson: r.lesson });
      }

      if (pathname === '/api/lessons' && req.method === 'POST') {
        const body = await readBody(req);
        const r = services.capabilities.addLesson({
          roomId: body.roomId,
          dept: body.dept,
          cue: body.cue,
          lesson: body.lesson,
          evidence: body.evidence,
          verdict: body.verdict,
          status: body.status,
        });
        if (!r.ok) return send(res, 400, { error: r.error });
        return send(res, 200, { lesson: r.lesson });
      }

      const lessonMatch = pathname.match(/^\/api\/lessons\/([^/]+)$/);
      if (lessonMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const r = services.capabilities.updateLesson(decodeURIComponent(lessonMatch[1]), body);
        if (!r.ok) return send(res, 404, { error: r.error });
        return send(res, 200, { lesson: r.lesson });
      }
      if (lessonMatch && req.method === 'DELETE') {
        const r = services.capabilities.removeLesson(decodeURIComponent(lessonMatch[1]));
        if (!r.ok) return send(res, 404, { error: r.error });
        return send(res, 200, { ok: true });
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
          if (size > limit) return fail(res, 413, 'CHUNK_TOO_LARGE', '单个分片不能超过 4MB');
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
        // 不整读：临时文件直接移进附件目录（rename，跨盘才退化成 copy）
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
          if (size > 25 * 1024 * 1024) return fail(res, 413, 'FILE_TOO_LARGE', '文件太大，上限 25MB');
          chunks.push(chunk);
        }
        if (!size) return fail(res, 400, 'EMPTY_FILE', '空文件');
        const name = url.searchParams.get('name') || req.headers['x-file-name'] || 'file';
        const meta = saveBuffer(Buffer.concat(chunks), { name, mime: req.headers['content-type'] });
        return send(res, 200, { attachment: { ...meta, url: `/api/files/${meta.id}` } });
      }

      const fileMatch = pathname.match(/^\/api\/files\/([a-zA-Z0-9_-]+)$/);
      if (fileMatch && req.method === 'GET') {
        const meta = metaFor(fileMatch[1]);
        const file = pathFor(fileMatch[1]);
        if (!meta || !file) return fail(res, 404, 'FILE_NOT_FOUND', '文件不存在');
        res.writeHead(200, fileResponseHeaders(meta));
        fs.createReadStream(file).pipe(res);
        return undefined;
      }

      // 删附件。资料库里可以单个删，也可以勾选一批一起删。
      //
      // 单删走 DELETE /api/files/:id；批量走 POST /api/files/delete
      // （批量不用 DELETE + body：很多客户端和代理会丢掉 DELETE 的 body）。
      if ((fileMatch && req.method === 'DELETE')
          || (pathname === '/api/files/delete' && req.method === 'POST')) {
        const singleDelete = req.method === 'DELETE' && fileMatch;
        const body = singleDelete ? null : await readBody(req).catch(() => ({}));
        const ids = singleDelete ? [fileMatch[1]] : (Array.isArray(body?.ids) ? body.ids : []);
        if (!ids.length) return fail(res, 400, 'NO_IDS', '没有指定要删哪些');
        if (ids.length > 500) return fail(res, 400, 'TOO_MANY_IDS', '一次最多删 500 个');
        const valid = [...new Set(ids.filter((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)))];
        const missingIndex = valid.filter((id) => !metaFor(id) && !isAttachmentDeleted(id));
        const referencedMissing = referencedAttachmentIds(store.messages.values(), missingIndex);
        let result;
        try {
          result = deleteAttachments(valid, { referencedMissing });
        } catch {
          return fail(res, 500, 'FILE_DELETE_FAILED', '删除记录写入失败');
        }
        result.missing.push(...ids.filter((id) => !valid.includes(id)));
        const revision = attachmentDeletionRevision();
        if (result.deleted.length) bus.emit('event', { t: 'attachments.deleted', ids: result.deleted, revision });
        const response = { ...result, attachmentDeletionRevision: revision };
        if (result.failed.length) return fail(res, 500, 'FILE_DELETE_FAILED', '部分附件文件清理失败，可重试', response);
        return send(res, 200, { ok: true, ...response });
      }

      // 把附件渲染成可嵌入浏览器栏的 HTML（表格 / PDF / Word）。
      // 返回 text/html，直接给 webview 用；不能渲染的格式明确报 415。
      const renderMatch = pathname.match(/^\/api\/files\/([a-zA-Z0-9_-]+)\/html$/);
      if (renderMatch && req.method === 'GET') {
        const meta = metaFor(renderMatch[1]);
        const file = pathFor(renderMatch[1]);
        if (!meta || !file) return fail(res, 404, 'FILE_NOT_FOUND', '文件不存在');
        // ★ 按需加载：render-html 会拉起 xlsx / mammoth / pdf-parse 三个重库。
        //   顶层静态 import 会让**每一次服务端启动**都付这笔钱 —— 启动变慢，
        //   app 的集成测试（真起 node 子进程）在 CI 冷机器上就会被判超时。
        //   只有真的要渲染附件时才 import。
        const { canRenderAsHtml, renderFileAsHtml } = await import('./render-html.js');
        if (!canRenderAsHtml(file)) {
          return send(res, 415, {
            error: `${path.extname(file) || '该格式'} 不能转成网页查看，请下载后用系统应用打开`,
          });
        }
        // 主题由 App 显式传（它的深浅色是独立设置，和系统不一定一致）。
        // 认不出的值不传，页面回退到 prefers-color-scheme。
        const themeParam = String(url.searchParams.get('theme') || '').toLowerCase();
        const theme = themeParam === 'light' || themeParam === 'dark' ? themeParam : undefined;
        try {
          const out = await renderFileAsHtml(file, { displayName: meta.name, theme });
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            // 内容可能含用户数据，不让中间层/浏览器缓存
            'cache-control': 'no-store',
            // 我们自己的页面，但仍限制脚本与外部资源（防御性）
            'content-security-policy':
              "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
            'x-content-type-options': 'nosniff',
          });
          res.end(out.html);
          return undefined;
        } catch (err) {
          return send(res, 500, { error: `渲染失败：${err?.message || err}` });
        }
      }

      // ---------- Bot ----------
      if (pathname === '/api/bots' && req.method === 'GET') {
        return send(res, 200, { bots: services.bots.list() });
      }

      if (pathname === '/api/bots' && req.method === 'POST') {
        const body = await readBody(req);
        const r = services.bots.create(body, { createdBy: device.id, greet: true });
        if (!r.ok) return fail(res, r.status, r.code, r.error);
        return send(res, 200, { bot: r.bot });
      }

      const botMatch = pathname.match(/^\/api\/bots\/([^/]+)$/);
      if (botMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const r = services.bots.update(botMatch[1], body, { checkModel: 'resolve', checkCapacity: true });
        if (!r.ok) {
          return r.code === 'BOT_NOT_FOUND'
            ? fail(res, 404, r.code, r.error)
            : send(res, r.status, { error: r.error });
        }
        return send(res, 200, { bot: r.bot });
      }
      if (botMatch && req.method === 'DELETE') {
        const r = services.bots.remove(botMatch[1]);
        if (!r.ok) return fail(res, 400, r.code, r.error);
        const { ok: _ok, ...rest } = r;
        return send(res, 200, rest);
      }

      // ---------- 用户身份 ----------
      if (pathname === '/api/user' && req.method === 'GET') {
        return send(res, 200, { user: store.userSummary() });
      }
      if (pathname === '/api/user' && req.method === 'PATCH') {
        const body = await readBody(req);
        const user = store.updateUserName(body.name);
        const n = runner.reloadAllSessions();
        log(`👤 用户改名叫：${user.name}（已重建 ${n} 个会话，下一轮起生效）`);
        return send(res, 200, { user });
      }

      // ---------- 群聊轮次预算 ----------
      if (pathname === '/api/group-limits' && req.method === 'GET') {
        return send(res, 200, { limits: services.rooms.groupLimits() });
      }
      // ---------- 快速决策路由（Jev）----------
      if (pathname === '/api/decision' && req.method === 'GET') {
        return send(res, 200, { decision: services.models.getDecision() });
      }
      if (pathname === '/api/decision' && req.method === 'PATCH') {
        const body = await readBody(req);
        const { decision, raw } = services.models.updateDecision(body);
        log(
          `⚙️  快速决策（Jev）${raw.enabled ? '已打开' : '已关闭'}` +
            (raw.enabled && raw.baseUrl ? `，端点 ${raw.baseUrl}` : ''),
        );
        return send(res, 200, { decision });
      }
      if (pathname === '/api/decision/probe' && req.method === 'POST') {
        const body = await readBody(req);
        const probe = await services.models.probeDecision(body ?? {});
        return send(res, 200, { probe });
      }

      // ---------- 部门规矩（危险动作 / 交付要附证据）----------
      if (pathname === '/api/policy' && req.method === 'GET') {
        return send(res, 200, { policy: store.policy(), policyVersion: store.policyVersion() });
      }
      if (pathname === '/api/local-nonce' && req.method === 'POST') {
        const body = await readBody(req);
        const purpose = String(body?.purpose ?? '');
        if (!Object.values(NONCE_PURPOSE).includes(purpose)) {
          return send(res, 400, { error: 'unknown_purpose' });
        }
        return send(res, 200, issueNonce(purpose));
      }

      if (pathname === '/api/policy' && req.method === 'PATCH') {
        const body = await readBody(req);
        const resPolicy = services.policy.updatePolicy(body);
        if (resPolicy.refreshError) {
          log('重发迁移授权失败（网关将按新规矩 fail-closed）：', resPolicy.refreshError);
        } else if (resPolicy.refreshed && (resPolicy.refreshed.revoked.length || resPolicy.refreshed.created.length)) {
          log(
            `🔑 规矩变更 → 重发 ${resPolicy.refreshed.created.length} 条迁移授权` +
              (resPolicy.refreshed.revoked.length ? `（撤掉 ${resPolicy.refreshed.revoked.length} 条旧的）` : ''),
          );
        }
        log(
          `⚙️  部门规矩改为：危险动作 ${resPolicy.policy.dangerous === 'deny' ? '只读（不给改文件/跑命令的工具）' : '允许'} / ` +
            `交付${resPolicy.policy.requireProof ? '必须附证据' : '不强求证据'}` +
            (resPolicy.notified ? `；已通知 ${resPolicy.notified} 条在跑的活（不中断）` : ''),
        );
        return send(res, 200, {
          policy: resPolicy.policy,
          policyChange: resPolicy.policyChange,
          notified: resPolicy.notified,
        });
      }
      if (pathname === '/api/group-limits' && req.method === 'PATCH') {
        const body = await readBody(req);
        const { limits } = services.rooms.updateGroupLimits(body);
        log(
          `⚙️  群聊轮次改为：老大 ${limits.leadTurns} 轮 / 成员 ${limits.memberTurns} 轮 / ` +
            `单条消息最多 ${limits.maxRuns} 次`,
        );
        return send(res, 200, { limits });
      }

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
        const r = await services.models.upsertGroup(body, { awaitRefresh: true });
        if (!r.ok) return send(res, 400, { error: r.error });
        log(`🔌 新增模型组：${r.group.name}（${r.group.models.length} 个模型），可用模型 ${r.total ?? 0} 个`);
        return send(res, 200, { group: r.group });
      }

      if (pathname === '/api/model-groups/test' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await services.models.testGroup(body ?? {});
        return send(res, 200, r);
      }

      const groupMatch = pathname.match(/^\/api\/model-groups\/([^/]+)$/);
      if (groupMatch && req.method === 'PATCH') {
        const body = await readBody(req);
        const r = await services.models.upsertGroup({ ...body, id: groupMatch[1] }, { awaitRefresh: false });
        if (!r.ok) return send(res, 400, { error: r.error });
        return send(res, 200, { group: r.group });
      }
      if (groupMatch && req.method === 'DELETE') {
        const r = await services.models.removeGroup(groupMatch[1], { awaitRefresh: false });
        if (!r.ok) return fail(res, 404, 'MODEL_GROUP_NOT_FOUND', '模型组不存在');
        log(`🔌 删除模型组：${groupMatch[1]}`);
        return send(res, 200, { id: r.id });
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
        if (!room) return fail(res, 404, 'BOT_NOT_FOUND', 'bot 不存在');
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
        if (!room) return fail(res, 404, 'ROOM_NOT_FOUND', '会话不存在');
        return send(res, 200, { room: store.roomSummary(room) });
      }
      if (roomMatch && req.method === 'DELETE') {
        shells.killRoom(roomMatch[1]);
        const r = store.deleteRoom(roomMatch[1]);
        if (!r) return fail(res, 400, 'CANNOT_DELETE_DM', '删不了（不存在或是 DM）');
        return send(res, 200, r);
      }

      const msgMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
      if (msgMatch && req.method === 'GET') {
        const roomId = msgMatch[1];
        if (!store.getRoom(roomId)) return fail(res, 404, 'ROOM_NOT_FOUND', '会话不存在');
        const limit = Math.min(Number(url.searchParams.get('limit') || 100), config.maxMessagesPerRoom);
        return send(res, 200, { messages: store.listMessages(roomId, { limit }).map(withoutDeletedAttachments) });
      }

      // 记忆摘要（私聊右侧「记忆」页）：GET 返回缓存 + 是否过期；POST 重新生成
      const memoryMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/memory$/);
      if (memoryMatch && req.method === 'GET') {
        const roomId = memoryMatch[1];
        const room = store.getRoom(roomId);
        if (!room) return fail(res, 404, 'ROOM_NOT_FOUND', '会话不存在');
        // 群聊可以指定看哪个 bot 的记忆；不传就默认第一个
        const requested = url.searchParams.get('botId');
        const botId = requested || room.botIds?.[0] || null;
        if (!botId) return fail(res, 400, 'ROOM_HAS_NO_BOT', '会话里没有 bot');
        if (requested && !(room.botIds ?? []).includes(requested)) {
          return fail(res, 400, 'BOT_NOT_IN_ROOM', '这个 bot 不在会话里');
        }
        const rec = store.memorySummaryFor(roomId, botId);
        const lastId = store.listMessages(roomId, { limit: 1 })[0]?.id ?? null;
        return send(res, 200, {
          summary: rec?.text ?? '',
          at: rec?.at ?? null,
          count: rec?.count ?? null,
          stale: !rec || rec.lastId !== lastId,
          botId,
        });
      }
      const memoryRefreshMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/memory\/refresh$/);
      if (memoryRefreshMatch && req.method === 'POST') {
        const roomId = memoryRefreshMatch[1];
        const room = store.getRoom(roomId);
        if (!room) return fail(res, 404, 'ROOM_NOT_FOUND', '会话不存在');
        const body = await readBody(req);
        const requested = typeof body.botId === 'string' ? body.botId : '';
        const botId = requested || room.botIds?.[0] || null;
        if (!botId) return fail(res, 400, 'ROOM_HAS_NO_BOT', '会话里没有 bot');
        if (requested && !(room.botIds ?? []).includes(requested)) {
          return fail(res, 400, 'BOT_NOT_IN_ROOM', '这个 bot 不在会话里');
        }
        const rec = await runner.summarizeMemory(roomId, botId, { force: true });
        return send(res, 200, {
          summary: rec?.text ?? '',
          at: rec?.at ?? null,
          count: rec?.count ?? null,
          stale: false,
          error: rec?.error ?? null,
          botId,
        });
      }

      const sendMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/send$/);
      if (sendMatch && req.method === 'POST') {
        const body = await readBody(req);
        const roomId = sendMatch[1];
        const hasRequestId = body?.requestId !== undefined && body?.requestId !== null && String(body.requestId).length > 0;
        const requestId = hasRequestId ? String(body.requestId) : '';
        const requestIdValid = /^[A-Za-z0-9_-]{6,128}$/.test(requestId);

        if (hasRequestId && !requestIdValid) {
          return fail(res, 400, 'BAD_REQUEST_ID', 'requestId 必须是 6-128 位字母数字/下划线/连字符');
        }

        if (!hasRequestId) {
          const result = await runner.send(roomId, body.text, {
            mode: body.mode,
            attachments: body.attachments,
            duplexMode: body?.duplexMode,
          });
          return send(res, 200, { ok: true, message: result.userMessage, steered: result.steered ?? null });
        }

        const opened = openRequest({
          receipts: httpRequestReceipts,
          taskRuns: store.taskRuns,
          requesterId: device?.id ?? 'device_unknown',
          requestId, roomId, text: body?.text, attachments: body?.attachments, mode: body?.mode,
        });
        if (opened.status === 'done') {
          const resumed = await resumeAdmitted({ store, taskRuns: store.taskRuns, scope: opened.scope });
          return send(res, 200, {
            ok: true, duplicate: true, requestId,
            accepted: resumed.ok !== false && resumed.accepted === true,
            taskRunId: resumed.taskRunId ?? opened.receipt?.taskRunId ?? null,
            admissionPending: resumed.ok === false,
          });
        }
        if (opened.status === 'inflight') return send(res, 202, { ok: true, queued: true, inProgress: true, requestId });
        if (opened.status === 'conflict' || opened.status === 'corrupt') {
          return fail(res, opened.status === 'conflict' ? 409 : 500, opened.code ?? 'REQUEST_REJECTED', opened.text ?? '请求被拒绝');
        }

        const scope = opened.scope;
        const room = store.getRoom(roomId);
        if (room?.kind === 'group') {
          // 群聊旁路 Talk 异步回答时把 scope 交给 runner 收口，其余同步路径在 finally 收口
          let failure = null;
          let handledAsync = false;
          try {
            const result = await runner.send(roomId, body.text, {
              mode: body.mode, attachments: body.attachments, requestId,
              groupScope: scope, duplexMode: body?.duplexMode,
            });
            handledAsync = result?.scopeHandled === true;
            return send(res, 200, { ok: true, message: result.userMessage, steered: result.steered ?? null, requestId });
          } catch (err) {
            failure = err;
            throw err;
          } finally {
            if (!handledAsync) {
              runner.requestLifecycle?.close?.(scope, failure, failure ? null : 'answer');
            }
          }
        }
        try {
          // 信封交给 runner：作用域在真正取得执行权时激活，该轮真正结束时收尾
          const result = await runner.send(roomId, body.text, {
            mode: body.mode,
            attachments: body.attachments,
            requestId,
            request: { scope },
            duplexMode: body?.duplexMode,
          });
          const status = result.queued === true ? 202 : 200;
          return send(res, status, {
            ok: true, message: result.userMessage, steered: result.steered ?? null,
            queued: result.queued === true, requestId,
          });
        } catch (err) {
          runner.requestLifecycle?.close?.(scope, err);
          throw err;
        }
      }

      const abortMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/abort$/);
      if (abortMatch && req.method === 'POST') {
        const body = await readBody(req);
        return send(res, 200, await runner.abort(abortMatch[1], { scope: body?.scope ?? 'all' }));
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
  };
}

/** 返回的 server 上挂着 handler，方便再挂一个 TLS listener 复用同一份路由。 */
export function createHttpServer(options) {
  const handler = createRequestHandler(options);
  const server = http.createServer(handler);
  server.handler = handler;
  return server;
}

export function serverInfo(runner) {
  const cfg = runner?.config ?? defaultConfig;
  return {
    version: VERSION,
    serverInstanceId: cfg.serverInstanceId,
    // 加密监听的端口与证书指纹（null = 这条链路是明文）。App 用它显示校验码。
    tls: activeTls(),
    hostname: cfg.hostname,
    workspace: cfg.workspace,
    // 数据目录也回给 App：这是用户最该知道、也最不该被“神秘换掉”的东西
    dataDir: cfg.dataDir,
    model: runner.modelLabel(),
    note: runner.initNote,
    tools: cfg.tools,
    models: runner.availableModels.length,
  };
}

/**
 * 网页版配对页：展示地址；配对码仅对已鉴权的请求渲染。
 */
function pairPage(snap, config = defaultConfig) {
  const addresses = lanAddresses()
    .map(({ name, address }) => `http://${address}:${config.port}  <span class="dim">(${name})</span>`)
    .join('<br>');

  if (!snap) {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orbis 配对</title>${pairStyles()}</head><body>
<div class="card">
  <div class="logo">◉</div>
  <h1>${config.serverName}</h1>
  <p class="dim">服务端配的是固定 token（ORBIS_TOKEN / PI_BOT_TOKEN），不需要配对码。</p>
  <p class="dim">在 App 的「固定 token」页填入服务端 .env 里的那个 token 就行。</p>
</div></body></html>`;
  }

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orbis 配对</title>${pairStyles()}</head><body>
<div class="card">
  <div class="logo">◉</div>
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
