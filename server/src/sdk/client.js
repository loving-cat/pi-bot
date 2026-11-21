/**
 * Orbis 远程 HTTP / WebSocket SDK 客户端。
 *
 * 用于从外部 Node 脚本、CI、或独立进程控制已在运行中的 Orbis / pi-bot 服务端实例；
 * 会自动从 `dataDir/local-token` 读本机凭据（或使用显式传入的 token），
 * 并在需要管理员一次性 nonce 的写接口上自动申请并携带 `x-orbis-nonce` / `x-pi-bot-nonce`。
 */
import { WebSocket as WsClient } from 'ws';
import { readLocalToken } from '../local-token.js';
import { ORBIS_ERROR_CODES as CODE, OrbisError, asOrbisError } from './errors.js';

function joinUrl(base, pathname) {
  return `${String(base).replace(/\/+$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function wsUrlFor(base, pathname, token) {
  const u = new URL(joinUrl(base, pathname));
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (token) u.searchParams.set('token', token);
  return u.toString();
}

export class OrbisClient {
  constructor({
    baseUrl = 'http://127.0.0.1:8787',
    token = null,
    dataDir = null,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = WsClient,
    clientName = 'orbis-sdk',
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.dataDir = dataDir;
    this.token = token || (dataDir ? readLocalToken(dataDir) : null);
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.clientName = clientName;
  }

  refreshLocalToken() {
    if (this.dataDir) this.token = readLocalToken(this.dataDir);
    return this.token;
  }

  async request(method, pathname, { body, noncePurpose = null, headers = {} } = {}) {
    const reqHeaders = {
      'x-orbis-client': this.clientName,
      'x-pi-bot-client': this.clientName,
      ...headers,
    };
    if (this.token) reqHeaders.authorization = `Bearer ${this.token}`;

    if (noncePurpose) {
      const issued = await this.request('POST', '/api/local-nonce', { body: { purpose: noncePurpose } });
      if (issued?.nonce) reqHeaders['x-orbis-nonce'] = issued.nonce;
    }

    const init = { method, headers: reqHeaders };
    if (body !== undefined) {
      reqHeaders['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await this.fetch(joinUrl(this.baseUrl, pathname), init);
    } catch (err) {
      // 网络层失败（DNS / 连接被拒 / TLS 握手）：也是 HTTP 失败的一种
      throw asOrbisError(err, CODE.E_HTTP, { method, path: pathname });
    }
    const text = await res.text();
    let json = {};
    if (text) {
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
    }
    if (!res.ok) {
      // 服务端的 `code` 放在 `details.serverCode`（不覆盖 SDK 契约码）：
      // 宿主先按 E_HTTP 分支，再看 serverCode 细分。
      throw new OrbisError(CODE.E_HTTP, json?.error || `HTTP ${res.status}`, {
        status: res.status,
        method,
        path: pathname,
        serverCode: json?.code || null,
        payload: json,
      });
    }
    return json;
  }

  health() {
    return this.request('GET', '/health');
  }

  state() {
    return this.request('GET', '/api/state');
  }

  async listBots() {
    return (await this.request('GET', '/api/bots')).bots ?? [];
  }

  createBot(body) {
    return this.request('POST', '/api/bots', { body });
  }

  updateBot(id, patch) {
    const needsNonce = Object.hasOwn(patch ?? {}, 'mcpServers');
    return this.request('PATCH', `/api/bots/${encodeURIComponent(id)}`, {
      body: patch,
      noncePurpose: needsNonce ? 'policy' : null,
    });
  }

  deleteBot(id) {
    return this.request('DELETE', `/api/bots/${encodeURIComponent(id)}`, { noncePurpose: 'policy' });
  }

  async listRooms() {
    return (await this.state()).rooms ?? [];
  }

  createGroup(body) {
    return this.request('POST', '/api/rooms', { body });
  }

  deleteRoom(id) {
    return this.request('DELETE', `/api/rooms/${encodeURIComponent(id)}`, { noncePurpose: 'policy' });
  }

  async messages(roomId, { limit = 100 } = {}) {
    const res = await this.request('GET', `/api/rooms/${encodeURIComponent(roomId)}/messages?limit=${limit}`);
    return res.messages ?? [];
  }

  send(roomId, text, { mode, attachments, duplexMode, requestId } = {}) {
    return this.request('POST', `/api/rooms/${encodeURIComponent(roomId)}/send`, {
      body: { text, mode, attachments, duplexMode, requestId },
    });
  }

  abort(roomId, { scope = 'all' } = {}) {
    return this.request('POST', `/api/rooms/${encodeURIComponent(roomId)}/abort`, { body: { scope } });
  }

  reset(roomId) {
    return this.request('POST', `/api/rooms/${encodeURIComponent(roomId)}/reset`, { body: {} });
  }

  updatePolicy(patch) {
    return this.request('PATCH', '/api/policy', { body: patch, noncePurpose: 'policy' });
  }

  upsertModelGroup(body) {
    if (body?.id) {
      return this.request('PATCH', `/api/model-groups/${encodeURIComponent(body.id)}`, {
        body,
        noncePurpose: 'policy',
      });
    }
    return this.request('POST', '/api/model-groups', { body, noncePurpose: 'policy' });
  }

  addMcpServer(body) {
    return this.request('POST', '/api/mcp', { body, noncePurpose: 'mcp' });
  }

  updateMcpServer(id, patch) {
    return this.request('PATCH', `/api/mcp/${encodeURIComponent(id)}`, { body: patch, noncePurpose: 'mcp' });
  }

  removeMcpServer(id) {
    return this.request('DELETE', `/api/mcp/${encodeURIComponent(id)}`, { noncePurpose: 'mcp' });
  }

  connectEvents(onEvent = () => {}) {
    return new Promise((resolve, reject) => {
      const url = wsUrlFor(this.baseUrl, '/ws', this.token);
      const socket = new this.WebSocket(url);
      let settled = false;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve({
          socket,
          close: () => new Promise((done) => {
            if (socket.readyState >= 2) { done(); return; }
            socket.once('close', () => done());
            socket.close();
          }),
        });
      };

      socket.on('message', (raw) => {
        try {
          const ev = JSON.parse(String(raw));
          onEvent(ev);
          if (!settled && ev?.t === 'hello') finish(null);
        } catch {}
      });
      socket.on('error', (err) => finish(asOrbisError(err, CODE.E_HTTP, { url })));
      socket.on('close', (code, reason) => {
        if (!settled) {
          finish(
            new OrbisError(CODE.E_HTTP, `WS closed before ready (${code}: ${reason || ''})`, {
              closeCode: code,
              reason: String(reason ?? ''),
            }),
          );
        }
      });
    });
  }
}

export function createOrbisClient(options = {}) {
  return new OrbisClient(options);
}

/** 向后兼容旧称 */
export const PiBotClient = OrbisClient;
export const createPiBotClient = createOrbisClient;
