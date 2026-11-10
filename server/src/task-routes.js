/**
 * 任务 HTTP 路由：鉴权接入、查询/快照与命令翻译。
 *
 * 控制命令的持久回执、阶段恢复与副作用确认全部在 tasks/task-commands.js；
 * 这里只解析 HTTP、调用已通过服务并翻译结果。
 */
import { config } from './config.js';
import { projectTaskRun } from './tasks/task-transport.js';
import { createTaskCommands } from './tasks/task-commands.js';
import { createRequestReceipts } from './tasks/task-request-receipts.js';
import { createRequestResultService } from './tasks/task-request-result.js';
import path from 'node:path';

export function createTaskRunRoutes({ store, runner, commandDir = null }) {
  const commands = runner.taskCommands ?? createTaskCommands({ store, runner, taskRuns: store.taskRuns, commandDir });
  runner.taskCommands = commands;
  const requestReceipts = createRequestReceipts({ dir: path.join(config.dataDir, 'task-requests') });
  const requestResultService = createRequestResultService({ receipts: requestReceipts, taskRuns: store.taskRuns });
  const respond = (send, res, status, body) => {
    send(res, status, body);
    return true;
  };

  return async function handleTaskRoutes({ req, res, url, pathname, readBody, send, fail, device }) {
    const resultMatch = pathname.match(/^\/api\/request-results\/([^/]+)$/);
    if (resultMatch && req.method === 'GET') {
      const requestId = decodeURIComponent(resultMatch[1]);
      const requesterId = device?.id ?? 'device_unknown';
      const result = requestResultService.read({ requesterId, requestId });
      if (!result.ok) return fail(res, 500, result.code, result.text);
      return respond(send, res, 200, result.projection);
    }
    if (pathname !== '/api/task-runs' && !pathname.startsWith('/api/task-runs/')) return false;

    /**
     * 扫一次磁盘，建好按 id 和按父任务的两个索引。
     *
     * ★ 为什么需要：`listAll()` 会对每个文件做 readFileSync + JSON.parse +
     *   完整契约校验。原来 `snapshotOf` 在**每条**任务上都调一次它来找子任务，
     *   列表接口于是变成 O(N²) 次文件读 —— 500 条时实测 3 秒级，
     *   而且全程同步阻塞事件循环，所有房间的流式输出都跟着卡住。
     *   这里只扫一次，后续查询都是内存 Map 操作。
     */
    const scanIndex = () => {
      const scan = store.taskRuns.listAll?.();
      const runs = scan?.taskRuns ?? scan ?? [];
      const byId = new Map();
      /** parentTaskId -> 子任务数组，顺序与 runs 一致（等同原来 filter 的顺序） */
      const kids = new Map();
      for (const r of runs) {
        byId.set(r.id, r);
        if (r.parentTaskId) {
          let arr = kids.get(r.parentTaskId);
          if (!arr) kids.set(r.parentTaskId, (arr = []));
          arr.push(r);
        }
      }
      return { runs, byId, kids };
    };
    const findRun = (id) => {
      const loaded = store.taskRuns.read(id);
      return loaded?.status === 'found' ? loaded.taskRun : null;
    };
    const rootOf = (run, idx = null) => {
      const rootId = run.rootTaskId ?? run.id;
      if (rootId === run.id) return run;
      // 根不在扫描结果里（损坏/缺失）时回落到直读，结果与原来相同
      return idx?.byId.get(rootId) ?? findRun(rootId);
    };
    const nameOf = (botId) => store.getBot?.(botId)?.name ?? '';
    const snapshotOf = (run, idx = null) => {
      let children = null;
      try {
        // 不传 idx 时（单条接口）仍是 1 次扫描，与原来相同
        const i = idx ?? scanIndex();
        children = (i.kids.get(run.id) ?? [])
          .filter((r) => (r.parentRevision ?? r.revision) === run.revision);
      } catch { children = null; }
      return projectTaskRun(run, { root: rootOf(run, idx), nameOf, children });
    };

    // ---- 列表：活跃/历史/全部；根预算统一由 rootOf -> projectTaskRun 解析
    if (pathname === '/api/task-runs' && req.method === 'GET') {
      const scope = url.searchParams.get('scope') ?? 'all';
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '200') || 200, 500);
      const encodeCursor = (item) => Buffer.from(JSON.stringify({ t: item.updatedAt ?? 0, id: item.id })).toString('base64url');
      const decodeCursor = (raw) => {
        if (!raw) return null;
        try {
          const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
          if (typeof parsed?.t === 'number' && typeof parsed?.id === 'string') return parsed;
        } catch {}
        return null;
      };
      const cursor = decodeCursor(url.searchParams.get('cursor'));
      // ★ 只扫一次，整页共用。
      //   注意不能写成 idx.runs.map(snapshotOf) —— Array.prototype.map
      //   会把下标当第二个参数传进来，idx 就成了一个数字。
      const idx = scanIndex();
      const all = idx.runs.map((run) => snapshotOf(run, idx)).sort((a, b) => {
        const byTime = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
        return byTime !== 0 ? byTime : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      const active = all.filter((t) => t.state !== 'completed' && t.state !== 'cancelled');
      const history = all.filter((t) => t.state === 'completed' || t.state === 'cancelled');
      const base = scope === 'active' ? active : scope === 'history' ? history : all;
      const filtered = cursor
        ? base.filter((t) => {
            const time = t.updatedAt ?? 0;
            return time < cursor.t || (time === cursor.t && t.id > cursor.id);
          })
        : base;
      const tasks = filtered.slice(0, limit);
      const hasMore = filtered.length > tasks.length;
      const nextCursor = hasMore && tasks.length > 0 ? encodeCursor(tasks[tasks.length - 1]) : null;
      return respond(send, res, 200, {
        tasks, serverName: config.serverName, serverInstanceId: config.serverInstanceId,
        scope, complete: !hasMore, nextCursor,
        activeCount: active.length, historyCount: history.length,
      });
    }

    // ---- 用户直接建任务：来自任务板的「加一条任务」。
    //
    //   ★ 这是任务板与执行引擎之间缺失的那座桥。
    //
    //     以前「加一条任务」走的是 /api/tasks —— 纯备忘清单，
    //     和 TaskRun 执行引擎没有任何关系，所以用户加的任务永远不会被执行。
    //     用户的原话：「待办进了 但是也没有真实去执行」。
    //
    //   这里直接把用户输入建成一个真实 TaskRun，并走准入（direct 路由：
    //   不另建部门，交给主控在该会话里执行），之后由推进器正常调度。
    if (pathname === '/api/task-runs' && req.method === 'POST') {
      const body = await readBody(req);
      const title = String(body?.title ?? '').trim();
      if (!title) return fail(res, 400, 'TITLE_REQUIRED', '任务需要一个标题');
      const roomId = String(body?.roomId ?? '').trim();
      const room = roomId ? store.getRoom(roomId) : null;
      if (!room) return fail(res, 400, 'ROOM_REQUIRED', '任务必须属于一个会话');

      const requesterId = device?.id ?? 'device_unknown';
      const requestId = String(body?.requestId ?? '').trim()
        || ('user_task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10));
      const goal = {
        requirement: title,
        scope: String(body?.scope ?? '').trim(),
        deliverables: Array.isArray(body?.deliverables) ? body.deliverables.slice(0, 20) : [],
        // 用户手写的任务没有专家复核流程，默认按「交付物存在 + 负责人确认」验收。
        // 没有验收条件任务无法完成，这是硬要求。
        verification: [{ id: 'done', kind: 'expert', description: '负责人确认已按要求交付', required: true }],
      };
      const fingerprint = 'user_' + String(roomId) + '_' + title.slice(0, 120);

      const out = await runner.taskRuntime?.onUserCreate?.({
        requesterId, requestId, roomId, goal, fingerprint, title,
      });
      if (!out) return fail(res, 503, 'TASK_RUNTIME_OFF', '任务运行时未启用');
      if (!out.ok) return fail(res, 400, out.code ?? 'CREATE_FAILED', out.text ?? '建任务失败');
      const created = findRun(out.taskRunId);
      return respond(send, res, 200, { task: created ? snapshotOf(created) : null, taskRunId: out.taskRunId });
    }

    const match = pathname.match(/^\/api\/task-runs\/([^/]+)(\/events|\/control)?$/);
    if (!match) return respond(send, res, 404, { error: 'not found' });
    const taskRunId = decodeURIComponent(match[1]);
    const suffix = match[2] ?? '';

    // ---- 权威快照 / 事件游标
    if ((suffix === '' || suffix === '/events') && req.method === 'GET') {
      const run = findRun(taskRunId);
      if (!run) return fail(res, 404, 'TASK_RUN_NOT_FOUND', '任务不存在');
      const since = Number(url.searchParams.get('since') ?? '0') || 0;
      const snapshot = snapshotOf(run);
      const gap = since > 0 && Number(snapshot.storeVersion) - since > 1;
      return respond(send, res, 200, {
        taskRun: snapshot, authoritative: true,
        cursor: Number(snapshot.storeVersion ?? 0), gap,
        serverName: config.serverName, serverInstanceId: config.serverInstanceId,
      });
    }

    // ---- 任务级控制：薄翻译
    if (suffix === '/control' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await commands.handle({
        taskRunId, body, device, findRun, snapshotOf,
      });
      if (out.status >= 400) return fail(res, out.status, out.body.code ?? 'CONTROL_REJECTED', out.body.text ?? '控制被拒绝');
      return respond(send, res, out.status, out.body);
    }

    return respond(send, res, 404, { error: 'not found' });
  };
}
