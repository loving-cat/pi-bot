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
    '★ 这是**已有任务的内部交付回调唤醒，不是用户的新提问**。',
    '不要把它当成新需求重新立项，也不要向用户复述他刚才说过的话。',
    '',
    `你之前把「${batch.taskTitle || '这个任务'}」拆给了下面这些部门，他们已经各自收口了。`,
    '现在请你**直接面向用户**做一次统一汇总，并且严格遵守：',
    '1. 先用 **不超过 3 句**给出核心结论；',
    '2. 再列**关键产物清单**（路径/附件，一行一个）；',
    '3. 最后用一句话说明缺项/受阻情况，并询问用户是否需要返工。',
    '',
    '**绝不复述各部门已经写在群里的长明细** —— 过程细节交给用户点 refs 直达部门群查看。',
    '这是交卷轮：**不要再建组、再派活或接新任务**。',
    '',
    '---- 各部门交卷 ----',
    ...lines,
  ].join('\n');
}

/**
 * 主控私聊此刻"忙不忙"。
 *
 * 只看 `runner.isBusy` 不够：还有一条「用户刚发、正在合并进这一轮」的消息
 * （`mergeQueue.hasPending`）没落地 —— 那种情况下插一条汇总会打断用户的意思。
 */
export function isMainChatBusy(runner, roomId, mainBotId) {
  try {
    if (runner?.isBusy?.(roomId, mainBotId) === true) return true;
    if (runner?.mergeQueue?.hasPending?.(roomId) === true) return true;
  } catch {
    return true; // 判忙失败就当忙：宁可晚一轮发，也别打断用户
  }
  return false;
}

/**
 * 主控这一轮的聚合键：同一轮里派多个部门要落在同一个批次里。
 * 优先用这一轮的 liveMsgId（用户看到的那条回复），没有就退回根 taskRunId。
 */
export function chiefTurnKey(runner, roomId, botId) {
  const entry = runner?.sessions?.get?.(`${roomId}:${botId}`);
  if (entry?.originTurnKey) return entry.originTurnKey; // 轮次开始时钉死，换条也不变
  if (entry?.liveMsgId) return `msg:${entry.liveMsgId}`;
  if (entry?.rootTaskId) return `task:${entry.rootTaskId}`;
  return '';
}

export function createChiefSummaryRunner({ runner, store, logFn = null } = {}) {
  const inflight = new Set();
  let draining = null;
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
        // 直接 summarize() 调用后不会经过 turn-executor 的 finally，
        // 期间新排队进来的批次就没人管了 —— 这里顺手排空（有重入锁，安全）。
        setTimeout(() => {
          void drain().catch(() => {});
        }, 0);
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
  /**
   * 排空排队中的汇总。
   *
   * ★ 重入锁：`summarize()` 成功后也会调一次 drain，而它自己可能就在 drain 里 ——
   *   没有锁的话同一批会被两个环同时扫到。重入者直接等当前这轮的结果。
   */
  async function drain() {
    if (draining) return draining;
    draining = (async () => {
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
        if (isMainChatBusy(runner, candidate.originRoomId, main.id)) break;
        const out = await summarize(candidate.id);
        if (out?.skipped) break;
        if (!out?.ok) return { sent, stopped: out?.error ?? 'failed' };
        sent += 1;
      }
      return { sent };
    })().finally(() => {
      draining = null;
    });
    return draining;
  }

  return { summarize, drain };
}
