/**
 * 任务命令服务：命令身份、持久回执、阶段恢复与副作用确认的唯一入口。
 *
 * 规则：
 *   · 不可变命令信封（commandId/type/ref/decision/text/原 expectedRevision）先落 pending；
 *   · 真实副作用成功后，把 commandId 与领域变更一起写进 TaskRun.appliedCommands，
 *     再写 applied 回执；重放只认这份应用事实，不用当前状态猜历史；
 *   · 输入/审批先校验任务/版本/ref 门槛，再产生任何副作用；
 *   · 未生效不能返回成功；已生效丢回执用 commandId 回放不重复；无法确认返回不确定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { writeJsonAtomic } from '../util.js';

export const COMMAND_ID = /^[A-Za-z0-9_-]{6,128}$/;
export const CONTROL_TYPES = new Set(['pause', 'resume', 'cancel', 'input', 'approval', 'revision', 'unblock', 'extend']);

function createCommandStore(dir) {
  const fileOf = (key) => path.join(dir, key + '.json');
  const keyOf = (requesterId, commandId) => Buffer.from(requesterId + '::' + commandId).toString('base64url');
  return {
    read(requesterId, commandId) {
      let raw;
      try {
        raw = fs.readFileSync(fileOf(keyOf(requesterId, commandId)), 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') return { status: 'absent' };
        return { status: 'corrupt', code: 'command_read_failed', text: '命令回执读取失败' };
      }
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return { status: 'corrupt', code: 'command_bad_json', text: '命令回执损坏' }; }
      if (!parsed || parsed.version !== 1 || !parsed.command) {
        return { status: 'corrupt', code: 'command_bad_record', text: '命令回执版本或内容不认识' };
      }
      const cmd = parsed.command;
      if (cmd.requesterId !== requesterId || cmd.commandId !== commandId) {
        return { status: 'corrupt', code: 'command_identity_mismatch', text: '命令回执身份不一致' };
      }
      return { status: 'ok', command: cmd };
    },
    write(command) {
      try {
        writeJsonAtomic(fileOf(keyOf(command.requesterId, command.commandId)), { version: 1, command });
        return { ok: true };
      } catch (err) {
        return { ok: false, code: 'command_write_failed', text: String(err?.message || err) };
      }
    },
  };
}

/** 命令应用事实：与领域变更一起持久，重放只认它。 */
function appliedFactOf(run, identity) {
  return (run?.appliedCommands ?? []).find((f) =>
    f.commandId === identity.commandId
    && f.requesterId === identity.requesterId
    && f.fingerprint === identity.fingerprint,
  ) ?? null;
}

/** 控制类型对应的合法门槛（输入/审批必须先匹配）。 */
function expectedGate(type, body) {
  if (type === 'input') return { kind: 'input', ref: String(body?.ref ?? '') };
  if (type === 'approval') return { kind: 'approval', ref: String(body?.ref ?? '') };
  return null;
}

export function createTaskCommands({ store, runner, taskRuns = null, commandDir = null }) {
  const commands = createCommandStore(commandDir ?? path.join(config.dataDir, 'task-commands'));

  return {
    COMMAND_ID,
    CONTROL_TYPES,
    getCommand(requesterId, commandId) {
      return commands.read(requesterId, commandId);
    },

    async handle({ taskRunId, body, device, snapshotOf = () => null, findRun }) {
      const commandId = String(body?.commandId ?? '');
      const type = String(body?.type ?? '');
      const expectedRevision = body?.expectedRevision;
      const fail = (status, code, text) => ({ status, body: { ok: false, code, text } });
      if (!COMMAND_ID.test(commandId)) return fail(400, 'BAD_COMMAND_ID', '命令需要稳定的 commandId');
      if (!CONTROL_TYPES.has(type)) return fail(400, 'BAD_COMMAND_TYPE', '未知的控制类型');
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        return fail(400, 'BAD_REVISION', '控制必须带目标版本 expectedRevision');
      }

      const fingerprint = JSON.stringify({
        taskRunId, type, expectedRevision,
        ref: body?.ref ?? null, decision: body?.decision ?? null, text: body?.text ?? null,
        goal: body?.goal ?? null, reason: body?.reason ?? null, deferNotify: body?.deferNotify === true,
        extraRuns: body?.extraRuns ?? null,
      });
      const requesterId = device?.id ?? 'device_unknown';
      const runNow = () => (typeof findRun === 'function' ? findRun(taskRunId) : null);
      const appliedPayload = (run) => ({
        ok: true, accepted: true, applied: true, type, taskRunId,
        taskRun: run ? snapshotOf(run) : null,
      });
      const writeApplied = (run, envelope = null) => {
        const written = commands.write({
          requesterId, commandId, fingerprint, kind: type, taskRunId,
          at: Date.now(), stage: 'applied', result: appliedPayload(run),
          ...(envelope ? { envelope } : {}),
        });
        return written.ok ? { ok: true, payload: appliedPayload(run) } : written;
      };
      const recordAppliedFact = async (fact) => {
        const written = await taskRuns?.mutate?.(taskRunId, { mutate: (c) => (c ? {
          ...c,
          appliedCommands: [ ...(c.appliedCommands ?? []), fact ].slice(-30),
          updatedAt: Date.now(),
        } : null) });
        return written?.ok === true;
      };

      // ---------- 回放：先看持久应用事实 ----------
      const commandIdentity = { commandId, requesterId, fingerprint };
      const readWriteApplied = (run) => {
        const fact = appliedFactOf(run, commandIdentity);
        if (!fact) return null;
        return writeApplied(run, cached.command.envelope ?? null);
      };

      const cached = commands.read(requesterId, commandId);
      if (cached.status === 'corrupt') return fail(500, cached.code, cached.text);
      if (cached.status === 'ok') {
        if (cached.command.fingerprint !== fingerprint) return fail(409, 'COMMAND_CONFLICT', '同一命令 ID 的内容不一致');
        const run = runNow();
        if (cached.command.stage === 'applied') {
          // 阶段回执缺 result/taskRunId：不能当成功；也不重复执行
          if (!cached.command.result || !cached.command.result.taskRunId) {
            return fail(500, 'COMMAND_RECORD_INVALID', '命令回执缺少阶段结果');
          }
          return { status: 200, body: { ...cached.command.result, replayed: true, taskRun: run ? snapshotOf(run) : null } };
        }
        const replayed = readWriteApplied(run);
        if (replayed?.ok) return { status: 200, body: { ...replayed.payload, replayed: true } };
        if (cached.command.stage === 'pending' || cached.command.stage === 'failed') {
          // 可能已执行但事实没落盘：只有确认任务从未变动才允许重试
          const beforeSequence = cached.command.beforeSequence;
          if (typeof beforeSequence === 'number' && run && run.sequence !== beforeSequence) {
            return fail(409, 'COMMAND_INDETERMINATE', '命令可能已生效但无法确认，拒绝重放');
          }
        }
      }

      const run = runNow();
      if (!run) return fail(404, 'TASK_RUN_NOT_FOUND', '任务不存在');
      if (run.revision !== expectedRevision) return fail(409, 'STALE_REVISION', '命令针对的目标版本已过期');

      // ---------- 副作用前：作用域校验 ----------
      const gate = expectedGate(type, body);
      if (gate) {
        if (!gate.ref) return fail(400, type === 'input' ? 'MISSING_INPUT_KEY' : 'MISSING_APPROVAL_ID', '缺少 ref');
        const matched = (run.openGates ?? []).find((g) => g.kind === gate.kind && g.ref === gate.ref);
        if (!matched) return fail(409, type === 'input' ? 'INPUT_SCOPE_MISMATCH' : 'APPROVAL_SCOPE_MISMATCH', '任务/版本/ref 与当前门槛不匹配');
      }
      if (type === 'approval') {
        const approval = store.getApproval?.(String(body.ref));
        if (!approval || approval.status !== 'pending'
          || approval.taskRunId !== taskRunId
          || approval.taskRevision !== expectedRevision) {
          return fail(409, 'APPROVAL_SCOPE_MISMATCH', '审批记录不属于该任务/版本或已处理');
        }
      }

      const runtime = runner.taskRuntime;
      if (!runtime) return fail(503, 'TASK_RUNTIME_OFF', '任务运行时未启用');

      const envelope = {
        commandId, type, expectedRevision,
        ref: body?.ref ?? null, decision: body?.decision ?? null,
        text: body?.text ?? null, goal: body?.goal ?? null, reason: body?.reason ?? null, deferNotify: body?.deferNotify === true,
      };
      const pendingRecord = {
        requesterId, commandId, fingerprint, kind: type, taskRunId,
        at: Date.now(), stage: 'pending', result: null,
        beforeSequence: run.sequence, envelope,
      };
      const persisted = commands.write(pendingRecord);
      if (!persisted.ok) return fail(500, persisted.code, persisted.text);

      try {
        let result = null;
        if (type === 'cancel') {
          result = await runtime.onCancel({ taskRunId, reason: body?.reason ?? '用户取消' });
        } else if (type === 'input') {
          result = await runtime.onInputProvided({
            taskRunId, inputKey: String(body.ref), revision: expectedRevision, text: body?.text ?? null,
          });
        } else if (type === 'approval') {
          // ★ 宽容接受几种同义写法。
          //
          //   客户端曾经发 'denied'，而这里只认 'approved'/'rejected'，
          //   于是「拒绝审批」按钮必然 400，审批门槛只能批不能驳。
          //   入口处统一归一，别让一个同义词把功能锁死。
          const raw = String(body?.decision ?? '').toLowerCase();
          const decision = ['approved', 'approve', 'granted', 'grant'].includes(raw)
            ? 'approved'
            : ['rejected', 'reject', 'denied', 'deny'].includes(raw)
              ? 'rejected'
              : null;
          if (!decision) return fail(400, 'BAD_DECISION', '审批决定必须明确');
          const decided = store.decideApproval(String(body.ref), { approved: decision === 'approved' });
          if (!decided) return fail(404, 'APPROVAL_NOT_FOUND', '审批记录不存在');
          result = await runtime.onApprovalDecided({
            taskRunId, approvalId: String(body.ref), decision, revision: expectedRevision,
          });
        } else if (type === 'pause') {
          result = await runtime.onPause({ taskRunId });
        } else if (type === 'resume') {
          result = await runtime.onResume({ taskRunId });
        } else if (type === 'revision') {
          result = await runtime.onRevision({ taskRunId, goal: body?.goal ?? null, reason: body?.reason ?? '用户修改要求', expectedRevision, deferNotify: body?.deferNotify === true });
        } else if (type === 'unblock') {
          result = await runtime.onUnblock({ taskRunId, reason: body?.reason ?? '手动解除阻塞' });
        } else if (type === 'extend') {
          result = await runtime.onExtendBudget({ taskRunId, extraRuns: Number(body?.extraRuns ?? 0) });
        }
        const after = runNow();
        const effectApplied = type === 'pause'
          ? after?.state === 'paused_user'
          : type === 'resume'
            ? (after?.state !== 'paused_user' && after?.state !== 'paused_budget')
            : type === 'cancel'
              ? after?.state === 'cancelled'
              : type === 'input'
                ? !(after?.openGates ?? []).some((g) => g.kind === 'input' && g.ref === String(body?.ref ?? ''))
                : type === 'revision'
                  ? (result?.ok === true && after?.revision === expectedRevision + 1)
                  : type === 'unblock'
                    ? (result?.ok === true && !after?.flags?.blockedAt)
                    : type === 'extend'
                      ? result?.ok === true
                      : !(after?.openGates ?? []).some((g) => g.kind === 'approval' && g.ref === String(body?.ref ?? ''));
        if (!(effectApplied || result?.applied === true)) {
          commands.write({ ...pendingRecord, stage: 'failed', error: String(result?.code ?? 'EFFECT_NOT_APPLIED') });
          if (result && result.ok === false) {
            // 语义性拒绝（状态不允许这个控制）是 409，不是服务端故障。
            const semantic = new Set(['not_paused', 'not_blocked', 'terminal', 'budget_paused', 'unknown_control_type']);
            const status = semantic.has(String(result.code ?? '')) ? 409 : 500;
            return fail(status, result.code ?? 'CONTROL_FAILED', String(result.text ?? '控制未完成'));
          }
          return fail(409, result?.code ?? 'EFFECT_NOT_APPLIED', String(result?.text ?? '操作未生效'));
        }
        // 应用事实与领域变更一起持久：重放只认它
        // 注意：这是领域变更之后的第二次 mutate（非原子）；失败时保持 pending，
        // 重放按 sequence 变化判为不确定，不会重复执行。
        const factRecorded = await recordAppliedFact({
          requesterId, commandId, fingerprint, type, ref: envelope.ref,
          revision: expectedRevision, at: Date.now(), sequence: after?.sequence ?? null,
        });
        if (!factRecorded) return fail(500, 'COMMAND_FACT_FAILED', '命令应用事实未能落盘，不能报告成功');
        const done = writeApplied(after, pendingRecord.envelope);
        if (!done.ok) return fail(500, done.code, done.text);
        return { status: 200, body: done.payload };
      } catch (err) {
        commands.write({ ...pendingRecord, stage: 'failed', error: String(err?.message || err).slice(0, 300) });
        return fail(500, 'CONTROL_FAILED', String(err?.message || err));
      }
    },
  };
}
