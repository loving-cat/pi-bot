/**
 * WebSocket 通道：手机 App 的长连接。
 *
 * 上行：{t:"send"|"abort"|"reset"|"ping"}
 * 下行：hello / msg.* / bot.updated / room.* / typing / pong / error
 */
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { config } from './config.js';
import { store } from './store.js';
import { VERSION } from './version.js';
import { bus } from './bus.js';
import { openRequest, createRequestLifecycle, resumeAdmitted } from './coordination/task-request-gate.js';
import { createRequestResultService, createTerminalPublisher } from './tasks/task-request-result.js';
import { createRequestReceipts } from './tasks/task-request-receipts.js';
import { projectTaskRunList } from './tasks/task-projection.js';
import { attachmentDeletionRevision, withoutDeletedAttachments } from './attachments.js';
import { serverInfo, isLoopback, LOCAL_DEVICE, hostAllowed } from './http.js';
import { log, timingSafeEqual } from './util.js';

const taskRequestReceipts = createRequestReceipts({ dir: path.join(config.dataDir, 'task-requests') });
/**
 * 首次接单请求的发送：预约 → 作用域 → 理解轮 → 收尾。
 * 并发同 requestId 的第二个请求只会拿到 queued/inflight，不会起第二轮理解。
 */
async function startAdmittedSend({ runner, socket, roomId, requestId, text, attachments = [], mode, clientId = null }) {
  const room = store.getRoom(roomId);
  if (room?.kind === 'group') {
    // 普通群聊保持原行为：requestId 只做同键去重，不把群消息当首次接单
    const opened = openRequest({ receipts: taskRequestReceipts, taskRuns: store.taskRuns,
    requesterId: socket.device?.id ?? 'device_unknown', requestId, roomId, text, attachments, mode });
    if (opened.status === 'done') { socket.send(JSON.stringify({ t: 'ack', clientId, requestId, duplicate: true, accepted: true })); return; }
    if (opened.status === 'inflight') { socket.send(JSON.stringify({ t: 'queued', clientId, requestId, inProgress: true })); return; }
    if (opened.status === 'conflict' || opened.status === 'corrupt') { socket.send(JSON.stringify({ t: 'error', error: opened.text, code: opened.code, clientId, requestId })); return; }
    let failure = null;
    try {
      const result = await runner.send(roomId, text, { mode, attachments, flushMerge: true, requestId });
      if (clientId) socket.send(JSON.stringify({ t: 'ack', clientId, messageId: result.userMessage?.id, requestId }));
    } catch (err) {
      failure = err;
      socket.send(JSON.stringify({ t: 'error', error: String(err?.message || err), code: err?.code, clientId, requestId }));
    } finally {
      runner.requestLifecycle?.close?.(opened.scope, failure, failure ? null : 'answer');
    }
    return;
  }
  const opened = openRequest({
    receipts: taskRequestReceipts,
    taskRuns: store.taskRuns,
    requesterId: socket.device?.id ?? 'device_unknown',
    requestId, roomId, text, attachments, mode,
  });
  if (opened.status === 'done') {
    const resumed = await resumeAdmitted({ store, taskRuns: store.taskRuns, scope: opened.scope });
    socket.send(JSON.stringify({
      t: 'ack', clientId, requestId, duplicate: true,
      accepted: resumed.ok !== false && resumed.accepted === true,
      taskRunId: resumed.taskRunId ?? opened.receipt?.taskRunId ?? null,
      admissionPending: resumed.ok === false,
    }));
    return;
  }
  if (opened.status === 'inflight') {
    socket.send(JSON.stringify({ t: 'queued', clientId, requestId, inProgress: true }));
    return;
  }
  if (opened.status === 'conflict' || opened.status === 'corrupt') {
    socket.send(JSON.stringify({ t: 'error', error: opened.text ?? '请求被拒绝', code: opened.code, clientId, requestId }));
    return;
  }
  try {
    // 信封交给 runner：真正取得执行权时才激活作用域，该轮真正结束时才收尾
    const result = await runner.send(roomId, text, {
      mode, attachments, flushMerge: true, requestId, request: { scope: opened.scope },
    });
    if (clientId) socket.send(JSON.stringify({
      t: 'ack', clientId, messageId: result.userMessage?.id, requestId,
      queued: result.queued === true,
    }));
  } catch (err) {
    // 入队前就失败：本次请求明确失败，允许同 requestId 重试
    runner.requestLifecycle?.close?.(opened.scope, err);
    socket.send(JSON.stringify({ t: 'error', error: String(err?.message || err), code: err?.code, clientId, requestId }));
  }
}

export function attachWs(server, { runner }) {
  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: verifyWsClient });
  const requestResultService = createRequestResultService({ receipts: taskRequestReceipts, taskRuns: store.taskRuns });
  const publishTerminal = createTerminalPublisher({
    service: requestResultService,
    // 事件按原请求来源设备投递；不向所有设备广播别人的确认
    emit: (event) => {
      for (const client of wss.clients) {
        if (client.device?.id === event.requesterId) {
          try { client.send(JSON.stringify(event)); } catch {}
        }
      }
    },
  });
  runner.setRequestLifecycle?.(createRequestLifecycle({
    receipts: taskRequestReceipts, taskRuns: store.taskRuns, onTerminal: publishTerminal,
  }));

  const resolveDevice = (req) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = String(req.headers.authorization || '');
    const token = url.searchParams.get('token') || (auth.startsWith('Bearer ') ? auth.slice(7) : '');
    if (token && token.length) {
      if (config.staticToken && timingSafeEqual(token, config.staticToken)) {
        return { id: 'static', name: 'static-token' };
      }
      const device = store.findDeviceByToken(token);
      if (device) store.touchDevice(token);
      return device;
    }
    // 没带 token：仅限本机原生客户端（不带 Origin），浏览器页面一律要 token
    if (isLoopback(req) && !req.headers.origin) return LOCAL_DEVICE;
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
        attachmentDeletionRevision: attachmentDeletionRevision(),
        // 活跃任务权威快照：断线重连靠它补齐；仍以 taskRun.* 增量更新
        // 活跃任务权威快照（含完整性与根预算）+ 最近终态（历史入口）
        taskRuns: (() => {
          const scan = store.taskRuns.listAll?.();
          const runs = scan?.taskRuns ?? scan ?? [];
          const rootOf = (run) => {
            const rootId = run.rootTaskId ?? run.id;
            if (rootId === run.id) return run;
            const loaded = store.taskRuns.read(rootId);
            return loaded?.status === 'found' ? loaded.taskRun : null;
          };
          return projectTaskRunList(runs, { includeDone: false, limit: 200, rootOf });
        })(),
        taskRunMeta: (() => {
          const scan = store.taskRuns.listAll?.();
          const runs = scan?.taskRuns ?? scan ?? [];
          const activeCount = runs.filter((r) => r.state !== 'completed' && r.state !== 'cancelled').length;
          return { activeCount, activeComplete: activeCount <= 200, activeLimit: 200 };
        })(),
        recentTaskRuns: (() => {
          const scan = store.taskRuns.listAll?.();
          const rootOf = (run) => {
            const rootId = run.rootTaskId ?? run.id;
            if (rootId === run.id) return run;
            const loaded = store.taskRuns.read(rootId);
            return loaded?.status === 'found' ? loaded.taskRun : null;
          };
          const all = projectTaskRunList(scan?.taskRuns ?? scan ?? [], { includeDone: true, limit: 500, rootOf });
          return all.filter((t) => t.state === 'completed' || t.state === 'cancelled').slice(0, 30);
        })(),
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
            const hasRequestId = cmd.requestId !== undefined && cmd.requestId !== null && String(cmd.requestId).length > 0;
            const rawRequestId = hasRequestId ? String(cmd.requestId) : '';
            const requestIdValid = /^[A-Za-z0-9_-]{6,128}$/.test(rawRequestId);
            if (hasRequestId && !requestIdValid) {
              socket.send(JSON.stringify({ t: 'error', error: 'requestId 必须是 6-128 位字母数字/下划线/连字符', code: 'BAD_REQUEST_ID', clientId: cmd.clientId ?? null, requestId: rawRequestId }));
              break;
            }
            if (!hasRequestId) {
              const { userMessage } = await runner.send(cmd.roomId, cmd.text, {
                mode: cmd.mode,
                attachments: cmd.attachments,
                flushMerge: cmd.flushMerge === true,
              });
              if (cmd.clientId) socket.send(JSON.stringify({ t: 'ack', clientId: cmd.clientId, messageId: userMessage.id }));
              break;
            }

            await startAdmittedSend({
              runner, socket, roomId: cmd.roomId, requestId: rawRequestId,
              text: cmd.text, attachments: cmd.attachments, mode: cmd.mode,
              clientId: cmd.clientId ?? null,
            });
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
    // 设备被移除：立刻断开它的在线连接（否则它靠长连接还能继续收消息）
    if (event.t === 'device.revoked') {
      for (const client of wss.clients) {
        if (client.device?.id && client.device.id === event.id) {
          try {
            client.close(4401, 'device revoked');
          } catch {}
        }
      }
      return;
    }
    const outgoing = event.msg ? { ...event, msg: withoutDeletedAttachments(event.msg) } : event;
    const payload = JSON.stringify(outgoing);
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

/**
 * WS 握手校验：Upgrade 不经过 HTTP 处理器，要单独防 DNS rebinding / 跨站劫持。
 * - Host 必须是本机名/本机 IP
 * - 带 Origin（浏览器）时，Origin 必须指向本服务自身（同 host 同端口）
 */
export function verifyWsClient({ origin, req }) {
  if (!hostAllowed(req.headers.host)) return false;
  if (!origin) return true; // 原生 App 不发 Origin
  let o;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
  const port = o.port || (o.protocol === 'https:' ? '443' : '80');
  return hostAllowed(o.host) && port === String(config.port);
}
