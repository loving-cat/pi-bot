/**
 * 电脑侧的中转客户端（agent）。
 *
 * 它**主动外连**到中转（不用公网 IP、不用端口映射），然后：
 *   · 收到 req 帧 → 对本地服务端发同样的 HTTP 请求 → 回 res 帧；
 *   · 收到 ws-open → 连本地 /ws → 双向搬 ws-msg 帧。
 *
 * 配对码在启动时生成（也可用 --code 指定），打印在终端里，填到手机 App 的
 * 服务器地址：`https://<中转域名>/<配对码>`，token 用电脑上已配的那个。
 *
 * 帧大小：单帧原始字节上限 MAX_FRAME_BYTES（16MB）。超限一律回明确错误
 * （HTTP 响应 → 413 帧；ws 消息 → 关掉那条桥接，1013），绝不截断，
 * 也绝不把异常抛进 ws 回调 —— 那会把整个 agent（以及手机上所有连接）带崩。
 */
import http from 'node:http';
import WebSocket from 'ws';
import {
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  MAX_FRAME_TEXT_BYTES,
  decodeFrame,
  encodeFrame,
  packBody,
  unpackBody,
} from './frames.js';
import { log } from '../util.js';

/** 本地 ws 没连上时，积压队列的上限（条数 / 字节） */
const QUEUE_MAX_ITEMS = 128;
const QUEUE_MAX_BYTES = 4 * 1024 * 1024;

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
  const queues = new Map(); // id -> { items, bytes }：等本地 ws 连上之前攒下的消息

  /** 只发「这一帧装不下」的错误，不试图装 */
  const tooLargeRes = (id, bytes) => ({
    t: 'res',
    id,
    status: 413,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...packBody(
      Buffer.from(
        JSON.stringify({
          error: `响应太大（${bytes} 字节），中转单帧上限 ${Math.round(MAX_FRAME_BYTES / 1024 / 1024)}MB`,
          code: 'frame_too_large',
        }),
      ),
    ),
  });

  /** 关掉一条到本地的桥接，并通知中转 */
  const shutdownStream = (id, wsCode, reason) => {
    const stream = streams.get(id);
    streams.delete(id);
    queues.delete(id);
    try {
      stream?.close(wsCode, reason);
    } catch {}
    reply({ t: 'ws-close', id, code: wsCode, reason: String(reason ?? '') });
  };

  /** 中转连接断了：本地桥接也得跟着断，否则这些 ws 永远没人关 */
  const teardownStreams = () => {
    for (const stream of streams.values()) {
      try {
        stream.close(1001, 'relay disconnected');
      } catch {}
    }
    streams.clear();
    queues.clear();
  };

  const connect = () => {
    if (closed) return;
    const url = new URL(relay);
    url.searchParams.set('code', code);
    if (secret) url.searchParams.set('secret', secret);

    socket = new WebSocket(url, { maxPayload: MAX_FRAME_TEXT_BYTES });
    socket.on('open', () => {
      retry = 0;
      log(`中转已连上：${url.origin}  配对码 ${code}`);
    });
    socket.on('message', (raw) => {
      try {
        const frame = decodeFrame(raw.toString());
        if (!frame) return;
        if (frame.t === 'hello') return;
        if (frame.t === 'req') return handleRequest(frame);
        if (frame.t === 'ws-open') return openStream(frame);
        if (frame.t === 'ws-msg') return handleWsMsg(frame);
        if (frame.t === 'ws-close') {
          const stream = streams.get(frame.id);
          streams.delete(frame.id);
          queues.delete(frame.id);
          try {
            stream?.close(frame.code ?? 1000, frame.reason ?? '');
          } catch {}
        }
      } catch (err) {
        // 一条消息处理失败不能拖垮整个 agent
        log('中转消息处理失败：', err?.message || err);
      }
    });
    const reconnect = () => {
      if (closed) return;
      retry++;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(retry, 5));
      log(`中转断开，${Math.round(delay / 1000)}s 后重连（第 ${retry} 次）`);
      setTimeout(connect, delay);
    };
    socket.on('close', () => {
      teardownStreams();
      reconnect();
    });
    socket.on('error', (err) => log('中转连接出错：', err?.message || err));
  };

  const reply = (frame) => {
    try {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(encodeFrame(frame));
    } catch (err) {
      log('中转回包失败：', err?.message || err);
    }
  };

  function handleWsMsg(frame) {
    let data;
    try {
      data = unpackBody(frame);
    } catch (err) {
      const tooBig = err instanceof FrameTooLargeError;
      log(`ws 消息解包失败：${err?.message || err}`);
      if (tooBig) shutdownStream(frame.id, 1013, 'frame too large');
      return;
    }
    const stream = streams.get(frame.id);
    if (stream && stream.readyState === 1) {
      stream.send(data);
    } else {
      // 本地 ws 还没连上（手机可能比桥接先说话）：先攒着，open 之后补发。
      // 但要有上限：本地 ws 一直连不上时，队列不能无限长。
      const q = queues.get(frame.id) ?? { items: [], bytes: 0 };
      q.items.push(data);
      q.bytes += data.length;
      if (q.items.length > QUEUE_MAX_ITEMS || q.bytes > QUEUE_MAX_BYTES) {
        log(`ws 积压超限（${q.items.length} 条 / ${q.bytes} 字节），关闭桥接`);
        shutdownStream(frame.id, 1013, 'queue overflow');
        return;
      }
      queues.set(frame.id, q);
    }
  }

  function handleRequest(frame) {
    const headers = { ...(frame.headers ?? {}) };
    // 本地服务端会校验 Host（防 DNS rebinding），这里改写成回环
    headers.host = `${localUrl.hostname}:${localUrl.port}`;
    delete headers.origin;
    // 标记中转来源：本地服务端据此不再按回环当主人（客户端伪造只会降权，无需密钥）
    headers['x-pi-relay'] = '1';
    if (headers['x-relay-token']) {
      headers.authorization = `Bearer ${headers['x-relay-token']}`;
      delete headers['x-relay-token'];
    }
    let body;
    try {
      body = unpackBody(frame);
    } catch (err) {
      log(`请求体解包失败：${err?.message || err}`);
      return reply({
        t: 'res',
        id: frame.id,
        status: 413,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        ...packBody(Buffer.from(JSON.stringify({ error: '请求体超过中转单帧上限（16MB）', code: 'frame_too_large' }))),
      });
    }
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
        let overflow = false;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (overflow) return;
          if (size > MAX_FRAME_BYTES) {
            // 超限就别再攒了：继续把流读空（否则本地连接挂着），最后回 413
            overflow = true;
            chunks.length = 0;
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (overflow) return reply(tooLargeRes(frame.id, size));
          try {
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
          } catch (err) {
            const bytes = err instanceof FrameTooLargeError ? err.bytes : size;
            log(`响应装不进帧（${bytes} 字节），已回 413`);
            reply(tooLargeRes(frame.id, bytes));
          }
        });
        res.on('error', (err) => log('本地响应读取失败：', err?.message || err));
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
    // 只许桥接到本地服务端：绝对 URL / 协议相对路径会让 URL 指向外部
    if (url.host !== localUrl.host) {
      log(`拒绝外连的 WS 桥接：${path}`);
      return shutdownStream(frame.id, 1008, 'bad path');
    }
    const headers = { 'x-pi-relay': '1' };
    if (frame.headers?.authorization) headers.authorization = frame.headers.authorization;
    // 本地服务端把回环当主人；这里照实带上 token（若有）
    const stream = new WebSocket(url, { headers, maxPayload: MAX_FRAME_TEXT_BYTES });
    streams.set(frame.id, stream);
    stream.on('open', () => {
      log(`WS 桥接已建立：${path}`);
      const q = queues.get(frame.id);
      if (q) {
        queues.delete(frame.id);
        for (const item of q.items) {
          try {
            stream.send(item);
          } catch {}
        }
      }
    });
    stream.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      try {
        reply({ t: 'ws-msg', id: frame.id, dir: 's2c', ...packBody(buf) });
      } catch (err) {
        const tooBig = err instanceof FrameTooLargeError;
        log(`本地 ws 消息装不进帧：${err?.message || err}`);
        // 宁可断开这条桥接，也不能把半截数据当完整消息发过去
        if (tooBig) shutdownStream(frame.id, 1013, 'frame too large');
      }
    });
    const close = (wsCode, reason) => {
      if (!streams.has(frame.id)) return;
      streams.delete(frame.id);
      queues.delete(frame.id);
      reply({ t: 'ws-close', id: frame.id, code: wsCode, reason: String(reason ?? '') });
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
    /** 调试/测试用：当前桥接与积压数量 */
    get stats() {
      return { streams: streams.size, queues: queues.size };
    },
    close() {
      closed = true;
      teardownStreams();
      try {
        socket?.close(1001, 'agent closing');
      } catch {}
    },
  };
}
