/**
 * 主控总汇总的**执行**薄层（Stage 2）。
 *
 * 规格：`docs/SPEC-CHIEF-SUMMARY.md` §3.3。
 *
 * 只做三件事，别的什么都不碰：
 *   1. 把各部门交卷结论拼成**结构化只读提示词**（绝不塞部门群的全量过程对话）；
 *   2. 用常规私聊通道唤醒 `mainBot`，并把 `summaryTurn: true` 传下去
 *      —— 工具层靠这个标记硬拦"汇总完又自己派活"的无限套娃；
 *   3. 成功 → `markChiefSummarySent`；失败 → `markChiefSummarySendFailed`
 *      （退回 `ready_blocked`，让用户还能重试或忽略，而不是卡死在 `sending`）。
 *
 * 状态流转本身仍在纯模块 `server/src/chief-summary.js` 里 —— 这里只调它。
 */

/** 提示词里每个部门最多给多少字（部门群的过程对话绝不进来，只有结论） */
const LEAD_SUMMARY_CHARS = 1200;

/**
 * 拼汇总提示词（纯函数，方便单测）。
 *
 * 写法上刻意"只读 + 交卷"：明确告诉模型这是汇总轮、不许再派活，
 * 缺项要如实说并问用户要不要返工 —— 与 `SUMMARY_TURN_BLOCK_MESSAGE` 一致。
 */
export function buildChiefSummaryPrompt(batch = {}) {
  const targets = Array.isArray(batch.targets) ? batch.targets : [];
  const lines = [];
  for (const t of targets) {
    const name = t.departmentName || t.departmentId || '某部门';
    const status =
      t.status === 'done' ? '已完成' : t.status === 'failed' ? `受阻/失败${t.error ? `（${t.error}）` : ''}` : '仍在进行（按当前进度汇报）';
    lines.push(`■ ${name} —— ${status}`);
    const body = String(t.leadSummary ?? '').trim();
    if (body) lines.push(body.slice(0, LEAD_SUMMARY_CHARS));
    if (Array.isArray(t.artifacts) && t.artifacts.length) {
      lines.push(`产物：${t.artifacts.join('、')}`);
    }
    lines.push('');
  }

  return [
    '【主控汇总轮】',
    `你之前把「${batch.taskTitle || '这个任务'}」拆给了下面这些部门，他们已经各自收口了。`,
    '现在请你**直接面向用户**做一次统一汇总：说清每个部门交付了什么、关键产物在哪、',
    '哪些部分没做到或受阻（如实说，不要美化），最后问用户是否需要返工。',
    '',
    '这是交卷轮：**不要再建组、再派活或接新任务**，也不要重复用户原话。',
    '',
    '---- 各部门交卷 ----',
    ...lines,
  ].join('\n');
}

export function createChiefSummaryRunner({ runner, store, logFn = null } = {}) {
  const inflight = new Set();
  const log = (msg) => {
    try {
      logFn?.(msg);
    } catch {
      // 日志本身不该影响发送
    }
  };

  /** 发一条汇总；返回 {ok} 或 {skipped} */
  async function summarize(batchId) {
    let batch = store.chiefSummary(batchId);
    if (!batch) return { skipped: 'gone' };
    // 排队中的批次先推进到 sending（drain 会拿到 queued_send 的候选）
    if (batch.state === 'queued_send') {
      const begun = store.beginChiefSummarySend(batch.id);
      if (begun.error) return { skipped: begun.error };
      batch = begun.batch;
    }
    if (batch.state !== 'sending') return { skipped: `state:${batch.state}` };
    if (inflight.has(batch.id)) return { skipped: 'inflight' };

    const main = store.mainBot();
    if (!main) return { skipped: 'no-main' };
    const roomId = batch.originRoomId;
    if (!roomId) return { skipped: 'no-room' };

    inflight.add(batch.id);
    try {
      const out = await runner.runBotOnce({
        roomId,
        botId: main.id,
        prompt: buildChiefSummaryPrompt(batch),
        summaryTurn: true,
        meta: {
          via: 'chief_summary',
          batchId: batch.id,
          summaryBatchId: batch.id,
          refs: (batch.targets ?? [])
            .filter((t) => t.sourceMsgId || t.departmentId)
            .map((t) => ({
              roomId: t.departmentId,
              msgId: t.sourceMsgId ?? null,
              name: t.departmentName || t.departmentId,
            })),
        },
      });
      if (out?.ok) {
        store.markChiefSummarySent(batch.id, { messageId: out.messageId ?? null });
        log(`【汇总】已发送：${batch.taskTitle || batch.id}`);
        return { ok: true, messageId: out.messageId ?? null };
      }
      const reason = out?.error || '未知原因';
      store.markChiefSummarySendFailed(batch.id, { reason });
      log(`【汇总】发送失败，已退回待确认：${reason}`);
      return { ok: false, error: reason };
    } catch (err) {
      const reason = err?.message || String(err);
      store.markChiefSummarySendFailed(batch.id, { reason });
      log(`【汇总】发送异常，已退回待确认：${reason}`);
      return { ok: false, error: reason };
    } finally {
      inflight.delete(batch.id);
    }
  }

  /**
   * 排空排队中的汇总（`queued_send`，以及主控刚空闲下来的 `sending`）。
   *
   * 串行发送、一次失败就停：连着失败多半是模型/额度问题，连环调用只会继续烧钱。
   */
  async function drain() {
    const main = store.mainBot();
    if (!main) return { sent: 0, stopped: 'no-main' };
    let sent = 0;
    for (let guard = 0; guard < 10; guard++) {
      // 排队中的优先；其次是"已经该发但还没发"的 sending（例如上一轮 finally 里没赶上）
      const candidate =
        store.queuedChiefSummaries()[0] ??
        store.chiefSummaries().find((b) => b.state === 'sending') ??
        null;
      if (!candidate) break;
      // 主控还没空闲就等下一轮 finally 再来，绝不打断用户正在进行的对话
      if (runner.isBusy?.(candidate.originRoomId, main.id) === true) break;
      const out = await summarize(candidate.id);
      if (out?.skipped) break;
      if (!out?.ok) return { sent, stopped: out?.error ?? 'failed' };
      sent += 1;
    }
    return { sent };
  }

  return { summarize, drain };
}
