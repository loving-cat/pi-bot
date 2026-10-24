/**
 * 云服务器侧的「中转」。
 *
 *  手机 ──HTTPS/WSS──▶ 中转（公网，这台）  ◀──WSS（电脑主动外连）── pi-bot（家里）
 *
 * 为什么是"电脑主动外连"：家用宽带没有公网 IP、也没人愿意做端口映射。电脑侧跑一个
 * 小 agent 连到中转，中转按 code 把请求转发过去。中转只转发字节，不解析业务。
 *
 * 对外路径：
 *   GET  /health                 存活检查
 *   GET  /                      使用说明（纯文本）
 *   WS   /agent?code=&secret=   电脑侧接入（secret 必须等于 RELAY_SECRET）
 *   任意 /<code>/...             手机侧访问，中转成帧发给对应电脑
 *   WS   /<code>/ws?...          同上，WebSocket 桥接
 *
 * 安全边界：
 *   · code 是 12 位十六进制随机串（48 bit），且必须与 agent 注册的一致；
 *   · agent 必须带 RELAY_SECRET（部署时设置），否则任何人都能往中转挂机；
 *   · 中转不保存任何请求内容，不做鉴权决策 —— 真正的鉴权仍在电脑侧那台服务端。
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
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

const CODE_RE = /^[0-9a-f]{12}$/;
/** 单个请求等多久（毫秒） */
const REQUEST_TIMEOUT = 30_000;

/**
 * @param {{secret?:string, port?:number, host?:string}} options
 */
export function createRelay({ secret = '', port = 8788, host = '0.0.0.0' } = {}) {
  /** code → { socket, streams:Set, pending:Map<id, {res, timer}> } */
  const rooms = new Map();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://relay.local');

    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, rooms: rooms.size });
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(
        'pi-bot 中转\n\n' +
          '电脑侧：RELAY_SECRET=... node src/relay-agent.js --relay wss://<这台>/agent --local http://127.0.0.1:8787\n' +
          '手机侧：服务器地址填 https://<这台>/<配对码>，token 用电脑上配的\n',
      );
    }

    const match = url.pathname.match(/^\/([0-9a-f]{12})(\/.*)?$/);
    if (!match) return json(res, 404, { error: 'not found' });
    const code = match[1];
    const rest = match[2] ?? '/';
    const room = rooms.get(code);
    if (!room) return json(res, 502, { error: '中转：电脑侧没连上（或配对码不对）' });

    forwardHttp({ room, code, rest, url, req, res });
  });

  // ---------- WebSocket ----------
  // maxPayload：帧文本上限。超过的直接被 ws 层关掉（1009），
  // 不会进到 packBody/unpackBody 里 —— 那两处 throw 会带崩整个中转。
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_TEXT_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://relay.local');
    if (url.pathname === '/agent') {
      return wss.handleUpgrade(req, socket, head, (ws) => onAgent(ws, url));
    }
    const match = url.pathname.match(/^\/([0-9a-f]{12})\/ws$/);
    if (!match) return socket.destroy();
    const code = match[1];
    const room = rooms.get(code);
    if (!room) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return socket.destroy();
    }
    return wss.handleUpgrade(req, socket, head, (ws) => onClientWs(ws, room, url, code));
  });

  function onAgent(ws, url) {
    const code = String(url.searchParams.get('code') ?? '');
    const given = String(url.searchParams.get('secret') ?? '');
    if (!CODE_RE.test(code)) return ws.close(4400, 'bad code');
    if (secret && !sameSecret(given, secret)) return ws.close(4403, 'bad secret');

    const existing = rooms.get(code);
    if (existing) {
      // ★ 不能静默顶号。
      //
      //   新连接不能一来就把旧连接 close(4409, 'replaced') 并接管：否则拿到
      //   泄露 code 的人只要先连上来，就能把主人踢下线，手机端的配对 token
      //   随之全部落到对方手里；主人侧只看到一条“被替换”日志，不会意识到
      //   自己被顶了。
      //
      //   规则：
      //     · 带了**正确 secret** → 视为同一台电脑重连（进程重启/网络抖动），
      //       顶掉旧的（这是正常运维场景，不能让老连接占着位置不放）。
      //     · 没 secret 或 secret 不对 → 拒绝新连接，旧连接**原封不动**。
      //       攻方拿不到 secret 就抢不走会话。
      //     · 完全没配 secret（本机调试）→ 只能靠 loopback 保护，仍然允许替换，
      //       但这种模式启动时已经告警过了。
      const trusted = Boolean(secret) && sameSecret(given, secret);
      if (secret && !trusted) {
        log(`中转：${code} 已在使用，新连接没有正确 secret → 拒绝（不顶掉现有电脑）`);
        return ws.close(4404, 'code in use');
      }
      try {
        existing.socket.close(4409, 'replaced');
      } catch {}
      rooms.delete(code);
      log(`中转：${code} 被同一台电脑的新连接替换（带正确 secret）`);
    }
    const room = { code, socket: ws, streams: new Map(), pending: new Map() };
    rooms.set(code, room);
    log(`中转：电脑侧已接入 ${code}（当前 ${rooms.size} 个）`);

    ws.on('message', (raw) => {
      try {
        handleAgentFrame(raw);
      } catch (err) {
        // 一条坏帧不能带崩中转（否则所有挂着的电脑一起掉线）
        log(`中转：agent 帧处理失败 ${code}：${err?.message || err}`);
      }
    });

    function handleAgentFrame(raw) {
      const frame = decodeFrame(raw.toString());
      if (!frame) return;
      if (frame.t === 'res') {
        const waiting = room.pending.get(frame.id);
        if (!waiting) return;
        room.pending.delete(frame.id);
        clearTimeout(waiting.timer);
        waiting.resolve(frame);
        return;
      }
      if (frame.t === 'ws-msg' || frame.t === 'ws-close') {
        const stream = room.streams.get(frame.id);
        if (!stream) return;
        if (frame.t === 'ws-msg') {
          let data;
          try {
            data = unpackBody(frame);
          } catch (err) {
            log(`中转：ws 消息解包失败 ${code}：${err?.message || err}`);
            if (err instanceof FrameTooLargeError) {
              room.streams.delete(frame.id);
              try {
                stream.close(1013, 'frame too large');
              } catch {}
            }
            return;
          }
          if (stream.readyState === 1) stream.send(data);
        } else {
          room.streams.delete(frame.id);
          try {
            stream.close(frame.code ?? 1000, frame.reason ?? '');
          } catch {}
        }
      }
    }

    const cleanup = () => {
      if (rooms.get(code) !== room) return;
      rooms.delete(code);
      for (const [, waiting] of room.pending) {
        clearTimeout(waiting.timer);
        waiting.fail(new Error('电脑侧断开'));
      }
      room.pending.clear();
      for (const stream of room.streams.values()) {
        try {
          stream.close(1011, 'agent disconnected');
        } catch {}
      }
      room.streams.clear();
      log(`中转：电脑侧断开 ${code}`);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    // 让 agent 知道配对码（它自己也会打印）
    try {
      ws.send(encodeFrame({ t: 'hello', code }));
    } catch (err) {
      log(`中转：握手帧发送失败：${err?.message || err}`);
    }
  }

  function onClientWs(client, room, url, code) {
    const id = `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const path = `${url.pathname}${url.search}`.replace(`/${code}`, '');
    room.streams.set(id, client);
    try {
      room.socket.send(encodeFrame({ t: 'ws-open', id, path, headers: pickHeaders(url) }));
    } catch (err) {
      log(`中转：ws-open 发送失败：${err?.message || err}`);
      room.streams.delete(id);
      try {
        client.close(1011, 'relay error');
      } catch {}
      return;
    }

    client.on('message', (raw) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      try {
        room.socket.send(encodeFrame({ t: 'ws-msg', id, dir: 'c2s', ...packBody(buf) }));
      } catch (err) {
        log(`中转：客户端消息装不进帧（${buf.length} 字节）：${err?.message || err}`);
        room.streams.delete(id);
        try {
          client.close(1013, 'frame too large');
        } catch {}
        try {
          room.socket.send(
            encodeFrame({ t: 'ws-close', id, code: 1013, reason: 'frame too large' }),
          );
        } catch {}
      }
    });
    const close = (code2, reason) => {
      room.streams.delete(id);
      try {
        room.socket.send(encodeFrame({ t: 'ws-close', id, code: code2, reason: String(reason ?? '') }));
      } catch {}
    };
    client.on('close', (c, r) => close(c, r));
    client.on('error', () => close(1011, 'client error'));
  }

  function forwardHttp({ room, code, rest, url, req, res }) {
    const id = `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `请求体太大：中转单帧上限 ${Math.round(MAX_FRAME_BYTES / 1024 / 1024)}MB，大文件请用分片上传（/api/uploads）`,
            code: 'frame_too_large',
          }),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const timer = setTimeout(() => {
        const waiting = room.pending.get(id);
        if (!waiting) return;
        room.pending.delete(id);
        waiting.fail(new Error('timeout'));
      }, REQUEST_TIMEOUT);

      room.pending.set(id, {
        resolve: (frame) => {
          let payload;
          try {
            payload = unpackBody(frame);
          } catch (err) {
            log(`中转：响应解包失败：${err?.message || err}`);
            return json(res, 502, { error: '中转：电脑侧回包过大或损坏' });
          }
          const headers = { ...(frame.headers ?? {}) };
          // 中转自己决定长度与缓存头，避免与帧里的旧值冲突
          delete headers['content-length'];
          delete headers['transfer-encoding'];
          res.writeHead(frame.status ?? 502, headers);
          res.end(payload);
        },
        fail: (err) => {
          if (res.headersSent) return;
          json(res, 504, { error: `中转失败：${err?.message || err}` });
        },
        timer,
      });

      try {
        room.socket.send(
          encodeFrame({
            t: 'req',
            id,
            method: req.method,
            path: `${rest}${url.search}`,
            headers: pickHeaders(url, req.headers),
            ...packBody(body),
          }),
        );
      } catch (err) {
        clearTimeout(timer);
        room.pending.delete(id);
        json(res, 502, { error: `中转发送失败：${err?.message || err}` });
      }
    });
  }

  return {
    server,
    get roomCount() {
      return rooms.size;
    },
    listen() {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      for (const [, room] of rooms) {
        for (const stream of room.streams.values()) {
          try {
            stream.close(1001, 'relay closing');
          } catch {}
        }
        room.streams.clear();
        try {
          room.socket.terminate?.();
          room.socket.close(1001, 'relay closing');
        } catch {}
      }
      rooms.clear();
      try {
        wss.close();
      } catch {}
      // 别等 keep-alive 自然断开（否则 close() 会挂住）
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

/** 定长比较，避免按前缀长度泄露信息 */
function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

/** 转发时只带必要头：鉴权与内容类型 */
function pickHeaders(url, headers = {}) {
  const out = {};
  for (const key of ['authorization', 'content-type', 'accept']) {
    if (headers[key]) out[key] = headers[key];
  }
  // token 也可能在 query 里（附件 URL 就是这么用的）
  const token = url.searchParams.get('token');
  if (token) out['x-relay-token'] = token;
  return out;
}
