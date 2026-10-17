/**
 * 电脑侧的中转客户端（agent）。
 *
 * 它**主动外连**到中转（不用公网 IP、不用端口映射），然后：
 *   · 收到 req 帧 → 对本地服务端发同样的 HTTP 请求 → 回 res 帧；
 *   · 收到 ws-open → 连本地 /ws → 双向搬 ws-msg 帧。
 *
 * 配对码在启动时生成（也可用 --code 指定），打印在终端里，填到手机 App 的
 * 服务器地址：`https://<中转域名>/<配对码>`，token 用电脑上已配的那个。
 */
import http from 'node:http';
import WebSocket from 'ws';
import { decodeFrame, encodeFrame, packBody, unpackBody } from './frames.js';
import { log } from '../util.js';

/**
 * @param {object} opts
 * @param {string} opts.relay     中转的 agent 地址，如 wss://relay.example.com/agent
 * @param {string} opts.code      12 位十六进制配对码
 * @param {string} [opts.secret]  中转的 RELAY_SECRET
 * @param {string} [opts.local]   本地服务端地址，默认 http://127.0.0.1:8787
 */
export function startRelayAgent({
  relay,
  code,
  secret = '',
  local = 'http://127.0.0.1:8787',
} = {}) {
  if (!relay) throw new Error('缺少 relay 地址');
  if (!/^[0-9a-f]{12}$/.test(String(code ?? ''))) {
    throw new Error('code 必须是 12 位十六进制（可用 crypto.randomBytes(6).toString("hex")）');
  }
  const localUrl = new URL(local);
  let socket = null;
  let closed = false;
  let retry = 0;
  const streams = new Map(); // id -> ws 到本地 /ws
  const queues = new Map(); // id -> 等本地 ws 连上之前攒下的消息

  const connect = () => {
    if (closed) return;
    const url = new URL(relay);
    url.searchParams.set('code', code);
    if (secret) url.searchParams.set('secret', secret);

    socket = new WebSocket(url);
    socket.on('open', () => {
      retry = 0;
      log(`中转已连上：${url.origin}  配对码 ${code}`);
    });
    socket.on('message', (raw) => {
      const frame = decodeFrame(raw.toString());
      if (!frame) return;
      if (frame.t === 'hello') return;
      if (frame.t === 'req') return handleRequest(frame);
      if (frame.t === 'ws-open') return openStream(frame);
      if (frame.t === 'ws-msg') {
        const stream = streams.get(frame.id);
        const data = unpackBody(frame);
        if (stream && stream.readyState === 1) {
          stream.send(data);
        } else {
          // 本地 ws 还没连上（手机可能比桥接先说话）：先攒着，open 之后补发
          const q = queues.get(frame.id) ?? [];
          q.push(data);
          queues.set(frame.id, q);
        }
        return;
      }
      if (frame.t === 'ws-close') {
        const stream = streams.get(frame.id);
        streams.delete(frame.id);
        try {
          stream?.close(frame.code ?? 1000, frame.reason ?? '');
        } catch {}
      }
    });
    const reconnect = () => {
      if (closed) return;
      retry++;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(retry, 5));
      log(`中转断开，${Math.round(delay / 1000)}s 后重连（第 ${retry} 次）`);
      setTimeout(connect, delay);
    };
    socket.on('close', reconnect);
    socket.on('error', (err) => log('中转连接出错：', err?.message || err));
  };

  const reply = (frame) => {
    try {
      socket?.send(encodeFrame(frame));
    } catch (err) {
      log('中转回包失败：', err?.message || err);
    }
  };

  function handleRequest(frame) {
    const headers = { ...(frame.headers ?? {}) };
    // 本地服务端会校验 Host（防 DNS rebinding），这里改写成回环
    headers.host = `${localUrl.hostname}:${localUrl.port}`;
    delete headers.origin;
    if (headers['x-relay-token']) {
      headers.authorization = `Bearer ${headers['x-relay-token']}`;
      delete headers['x-relay-token'];
    }
    const body = unpackBody(frame);
    const req = http.request(
      {
        hostname: localUrl.hostname,
        port: localUrl.port,
        method: frame.method || 'GET',
        path: frame.path || '/',
        headers,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size <= 32 * 1024 * 1024) chunks.push(chunk);
        });
        res.on('end', () => {
          reply({
            t: 'res',
            id: frame.id,
            status: res.statusCode ?? 502,
            headers: {
              'content-type': res.headers['content-type'] ?? 'application/octet-stream',
              'cache-control': res.headers['cache-control'] ?? 'no-store',
            },
            ...packBody(Buffer.concat(chunks)),
          });
        });
      },
    );
    req.on('error', (err) => {
      reply({
        t: 'res',
        id: frame.id,
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        ...packBody(Buffer.from(JSON.stringify({ error: `本地服务端连不上：${err?.message || err}` }))),
      });
    });
    if (body.length) req.write(body);
    req.end();
  }

  function openStream(frame) {
    const path = frame.path || '/ws';
    const url = new URL(path, localUrl);
    const headers = {};
    if (frame.headers?.authorization) headers.authorization = frame.headers.authorization;
    // 本地服务端把回环当主人；这里照实带上 token（若有）
    const stream = new WebSocket(url, { headers });
    streams.set(frame.id, stream);
    stream.on('open', () => {
      log(`WS 桥接已建立：${path}`);
      const q = queues.get(frame.id);
      if (q) {
        queues.delete(frame.id);
        for (const item of q) {
          try {
            stream.send(item);
          } catch {}
        }
      }
    });
    stream.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      reply({ t: 'ws-msg', id: frame.id, dir: 's2c', ...packBody(buf) });
    });
    const close = (code, reason) => {
      streams.delete(frame.id);
      queues.delete(frame.id);
      reply({ t: 'ws-close', id: frame.id, code, reason: String(reason ?? '') });
    };
    stream.on('close', (c, r) => close(c, r));
    stream.on('error', () => close(1011, 'local ws error'));
  }

  connect();

  return {
    code,
    get connected() {
      return socket?.readyState === WebSocket.OPEN;
    },
    close() {
      closed = true;
      for (const [, stream] of streams) {
        try {
          stream.close(1001, 'agent closing');
        } catch {}
      }
      streams.clear();
      try {
        socket?.close(1001, 'agent closing');
      } catch {}
    },
  };
}
