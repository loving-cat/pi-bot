/**
 * 生产任务宿主装配：一个 TaskRuntime + 默认验收 access + 恢复/关闭生命周期。
 *
 * 只做薄装配：路由、执行、调度、预算都在既有 runtime/supervisor 内；
 * 这里不复制调度规则，也不替调用方挑任务。
 */
import fs from 'node:fs';
import { createTaskRuntime } from '../tasks/task-runtime.js';
import { resumeAdmission } from '../coordination/task-admission.js';
import { pathFor, metaFor, idForName } from '../attachments.js';

/** 真实文件验收入口：只按落盘附件 id 查，不暴露任意路径读写。 */
export function createTaskAccess({ log = () => {} } = {}) {
  return {
    async stat(ref) {
      const file = pathFor(String(ref ?? ''));
      if (!file) return { exists: false, size: 0 };
      const stat = fs.statSync(file);
      return { exists: true, size: stat.size };
    },
    /** 仅把真实登记名/ID 解析成可信附件 ID；不是路径读写。 */
    resolveRef(ref) {
      const raw = String(ref ?? '').trim();
      if (!raw) return null;
      if (metaFor(raw)) return raw;
      return idForName(raw);
    },
    async readText(ref) {
      const file = pathFor(String(ref ?? ''));
      // 访问契约：读不到必须走失败通道（抛错），不能把错误文案当正文。
      if (!file) throw Object.assign(new Error('文件不存在'), { code: 'B07_FILE_MISSING' });
      return { text: fs.readFileSync(file, 'utf8').slice(0, 200_000) };
    },
    // runTest/listReceipts 未授权：机械验收按既有规则 blocked，不伪造通过。
  };
}

/** 按任务真实归属解析执行房间：部门群优先，私聊 direct 落回原会话。 */
export function taskRouteOf(store, taskRun) {
  const owner = taskRun?.owner ?? {};
  const origin = taskRun?.origin ?? {};
  const roomId = owner.departmentId ?? origin.roomId ?? null;
  const room = roomId ? store.getRoom(roomId) : null;
  const kind = room?.kind === 'group' ? 'group' : 'dm';
  const botId = owner.leadBotId
    ?? (kind === 'dm' ? store.mainBot()?.id ?? null : room?.leadBotId ?? null);
  return { roomId, botId, kind };
}

async function recoverPendingAdmissions({ store, runner, log = () => {} }) {
  const all = store.taskRuns?.listAll?.()?.taskRuns ?? [];
  const pending = all.filter((t) => t?.admission?.status === 'pending_handoff' || t?.admission?.status === 'handoff_failed');
  const resumed = [];
  for (const taskRun of pending) {
    let out;
    try {
      out = await resumeAdmission({
        store, taskRuns: store.taskRuns, taskRun,
        // routeSpec 已含完整冻结部门规格；这里只满足既有 resume 的入口检查。
        prepareSpec: () => ({ ok: true }),
      });
    } catch (error) {
      out = { ok: false, code: 'recover_threw', text: String(error?.message ?? error) };
    }
    resumed.push({ taskRunId: taskRun.id, ok: out?.ok === true, code: out?.code ?? null, outcome: out?.outcome ?? null, departmentId: out?.departmentId ?? null, leadBotId: out?.leadBotId ?? null, text: out?.text ?? null });
    log('任务交接恢复', taskRun.id, out?.ok ? '已继续' : '未完成：' + (out?.text ?? out?.code ?? 'unknown'));
  }
  return { scanned: pending.length, resumed };
}

export function createTaskHost({ store, runner, clock = () => Date.now(), log = () => {} }) {
  if (!store?.taskRuns) throw new Error('任务宿主需要 TaskRunStore');
  const taskRuns = store.taskRuns;

  // ★ runner 必须能拿到应用 store。
  //
  //   task-runtime / task-supervisor 里有 7 处 runner.store 读取
  //   （查房间、查成员、查 Bot 名），但 PiRunner 从来没有 store 属性 ——
  //   全仓零赋值。后果是负责人回合正文里的 @ 根本查不到成员名单，
  //   一条子任务都不会建；任务终态回报也发不出去。
  //   生产装配下「@ 派活」等于完全失效，任务第一次执行就卡死。
  //
  //   在这里补上（只在缺失时写，不覆盖宿主已有的注入）。
  if (runner && !runner.store) {
    try {
      Object.defineProperty(runner, 'store', {
        value: store, writable: true, configurable: true, enumerable: false,
      });
    } catch {
      runner.store = store;
    }
  }
  const access = createTaskAccess({ log });
  const runtime = createTaskRuntime({
    taskRuns,
    runner,
    routeOf: (taskRun) => taskRouteOf(store, taskRun),
    access,
    clock,
    log,
  });
  let recovered = false;
  return {
    runtime,
    access,
    routeOf: (taskRun) => taskRouteOf(store, taskRun),
    async recover() {
      if (recovered) return { ok: true, already: true };
      recovered = true;
      // 先按持久冻结意图恢复“已准入但组织/owner 未完成”的交接；不依赖用户重发。
      const admissions = await recoverPendingAdmissions({ store, runner, log });
      const taskRecovery = await runtime.recover();
      return { ...taskRecovery, admissions };
    },
    dispose() {
      try { runtime.supervisor?.dispose?.(); } catch {}
    },
  };
}
