/**
 * WebSocket 通道：手机 App 的长连接。
 *
 * 上行：{t:"send"|"abort"|"reset"|"ping"}
 * 下行：hello / msg.* / bot.updated / room.* / typing / pong / error
 */
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { store } from './store.js';
import { VERSION } from './version.js';
import { bus } from './bus.js';
import { serverInfo, isLoopback, LOCAL_DEVICE } from './http.js';
import { log, timingSafeEqual } from './util.js';

export function attachWs(server, { runner }) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  const resolveDevice = (req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (token && token.length) {
      if (config.staticToken && timingSafeEqual(token, config.staticToken)) {
        return { id: 'static', name: 'static-token' };
      }
      const device = store.findDeviceByToken(token);
      if (device) store.touchDevice(token);
      return device;
    }
    // 没带 token：本机（PC 端 App）直接放行
    if (isLoopback(req)) return LOCAL_DEVICE;
    return null;
  };

  wss.on('connection', (socket, req) => {
    const device = resolveDevice(req);
    if (!device) {
      socket.send(JSON.stringify({ t: 'error', error: 'unauthorized' }));
      socket.close(4401, 'unauthorized');
      return;
    }
    socket.device = device;
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.send(
      JSON.stringify({
        t: 'hello',
        serverName: config.serverName,
        version: VERSION,
        server: serverInfo(runner),
        device,
        rooms: store.listRooms().map((r) => store.roomSummary(r)),
        bots: store.listBots(),
      }),
    );
    log(`📱 ${device.name} 已连接（在线 ${wss.clients.size}）`);
    socket.on('message', async (raw) => {
      let cmd;
      try {
        cmd = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        switch (cmd.t) {
          case 'ping':
            socket.send(JSON.stringify({ t: 'pong', ts: cmd.ts ?? null, serverTs: Date.now() }));
            break;
          case 'send': {
            const { userMessage } = await runner.send(cmd.roomId, cmd.text, {
              mode: cmd.mode,
              attachments: cmd.attachments,
            });
            if (cmd.clientId) socket.send(JSON.stringify({ t: 'ack', clientId: cmd.clientId, messageId: userMessage.id }));
            break;
          }
          case 'abort':
            await runner.abort(cmd.roomId);
            break;
          case 'reset':
            runner.resetRoomSessions(cmd.roomId);
            socket.send(JSON.stringify({ t: 'room.reset', roomId: cmd.roomId }));
            break;
          default:
            socket.send(JSON.stringify({ t: 'error', error: `unknown command: ${cmd.t}` }));
        }
      } catch (err) {
        socket.send(
          JSON.stringify({ t: 'error', error: String(err?.message || err), code: err?.code, clientId: cmd?.clientId }),
        );
      }
    });

    socket.on('close', () => log(`📱 ${device.name} 断开（在线 ${wss.clients.size}）`));
    socket.on('error', () => {});
  });

  const forward = (event) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  };
  bus.on('event', forward);

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!client.isAlive) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  wss.on('close', () => {
    clearInterval(heartbeat);
    bus.off('event', forward);
  });

  return wss;
}
