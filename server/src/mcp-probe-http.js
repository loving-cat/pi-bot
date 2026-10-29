/** 带目标校验、固定解析地址和响应上限的短时 MCP HTTP 探测。 */
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { assertPublicTarget } from './net-guard.js';
import { currentProxy, isDirectHost } from './http-client.js';
import { assertActive, parseMessage, probeError, PROBE_LIMITS, rpcResult } from './mcp-probe-protocol.js';

function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const requested = typeof options === 'object' ? options : {};
    const matches = addresses.filter((item) => !requested.family || item.family === requested.family);
    const list = matches.length ? matches : addresses;
    if (requested.all) done(null, list);
    else done(null, list[0].address, list[0].family);
  };
}

function directRequest(url, init, addresses) {
  return new Promise((resolve, reject) => {
    const library = url.protocol === 'https:' ? https : http;
    const request = library.request(url, {
      method: init.method,
      headers: init.headers,
      lookup: pinnedLookup(addresses),
      signal: init.signal,
      agent: false,
    }, (response) => {
      resolve({
        status: response.statusCode,
        header: (name) => response.headers[name.toLowerCase()],
        body: response,
        close: () => response.destroy(),
      });
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

function requestHeaders(raw) {
  const headers = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(String(value))) {
      throw probeError('invalid_config');
    }
    if (/^(host|content-length|transfer-encoding|connection|upgrade|proxy-authorization)$/i.test(name)) {
      throw probeError('invalid_config');
    }
    headers[name.toLowerCase()] = String(value);
  }
  return headers;
}

/** 只读取当前请求对应的响应，SSE 收到结果后立即取消流。 */
async function readResult(response, id, signal) {
  const contentType = String(response.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json' && contentType !== 'text/event-stream') throw probeError('protocol_error');
  if (!response.body) throw probeError('protocol_error');
  const decoder = new StringDecoder('utf8');
  let bytes = 0;
  let buffer = '';
  let data = [];
  let messages = 0;
  for await (const chunk of response.body) {
    assertActive(signal);
    bytes += chunk.byteLength;
    if (bytes > PROBE_LIMITS.bytes) throw probeError('response_limit');
    buffer += decoder.write(Buffer.from(chunk));
    if (contentType === 'application/json') continue;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (!line) {
        if (!data.length) continue;
        if (++messages > PROBE_LIMITS.messages) throw probeError('response_limit');
        const parsed = rpcResult(parseMessage(data.join('\n')), id);
        data = [];
        if (!parsed.notification) return parsed.result;
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  assertActive(signal);
  if (contentType === 'text/event-stream') throw probeError('protocol_error');
  buffer += decoder.end();
  const parsed = rpcResult(parseMessage(buffer), id);
  if (parsed.notification) throw probeError('protocol_error');
  return parsed.result;
}

export function createHttpProbe(server, signal, deps = {}) {
  let url;
  try { url = new URL(server.url); } catch { throw probeError('invalid_config'); }
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw probeError('invalid_config');
  }
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw probeError('invalid_config');
  }
  const headers = requestHeaders(server.headers);
  let sessionId = '';
  let version = '';
  let proxyAgent = null;
  let closed = false;
  let activeResponse = null;

  const dispatch = async (message, callSignal, method = 'POST') => {
    assertActive(callSignal);
    let checked;
    try { checked = await assertPublicTarget(url, { scope: 'user-config', lookup: deps.lookup }); }
    catch { throw probeError('unsafe_target'); }
    assertActive(callSignal);
    const request = {
      method,
      body: message ? JSON.stringify(message) : undefined,
      headers: {
        ...headers,
        'accept': 'application/json, text/event-stream',
        'accept-encoding': 'identity',
        'content-type': 'application/json',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...(version ? { 'mcp-protocol-version': version } : {}),
      },
      signal: callSignal,
      redirect: 'manual',
    };
    const proxy = !isDirectHost(url.hostname) ? await (deps.currentProxy ?? currentProxy)() : '';
    assertActive(callSignal);
    if (proxy) {
      const { ProxyAgent, fetch } = await import('undici');
      assertActive(callSignal);
      proxyAgent ??= new ProxyAgent(proxy);
      const response = await fetch(url, { ...request, dispatcher: proxyAgent });
      return {
        status: response.status,
        header: (name) => response.headers.get(name),
        body: response.body,
        close: () => { void response.body?.cancel().catch(() => {}); },
      };
    }
    return directRequest(url, request, checked.addresses);
  };

  const perform = async (message) => {
    assertActive(signal);
    if (closed) throw probeError('cancelled');
    const response = await dispatch(message, signal);
    activeResponse = response;
    try {
      if (response.status === 401 || response.status === 403) throw probeError('auth_required');
      if (response.status >= 300 && response.status < 400) throw probeError('redirect');
      if (response.status < 200 || response.status >= 300) throw probeError('http_error');
      const session = response.header('mcp-session-id');
      if (session != null) {
        if (typeof session !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(session)) throw probeError('protocol_error');
        if (sessionId && sessionId !== session) throw probeError('protocol_error');
        sessionId = session;
      }
      if (!Object.hasOwn(message, 'id')) {
        if (response.status !== 202 && response.status !== 204) throw probeError('protocol_error');
        return;
      }
      return await readResult(response, message.id, signal);
    } finally {
      response.close();
      if (activeResponse === response) activeResponse = null;
    }
  };
  return {
    request: perform,
    notify: perform,
    setVersion(value) { version = value; },
    async close() {
      if (closed) return;
      closed = true;
      activeResponse?.close();
      if (sessionId) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 300);
        try { (await dispatch(null, controller.signal, 'DELETE')).close(); }
        catch { /* 会话终止失败不改变已取得的验证结果。 */ }
        finally { clearTimeout(timer); }
      }
      if (proxyAgent) await proxyAgent.destroy().catch(() => {});
    },
  };
}
