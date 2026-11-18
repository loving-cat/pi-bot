/**
 * 实时工作台只读快照投影（纯逻辑、零 IO、不读全局时钟）。
 *
 * Talk Lane（旁路对话轨）不打开磁盘 `.jsonl` 会话文件、不执行写工具，
 * 它能 1 秒内说清“后台现在干到哪了”，靠的就是由调用方从内存状态抽出
 * 这份有界、脱敏后的 LiveWorkSnapshot。
 */

function sanitizeSnippet(value, maxLen = 200) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const redacted = raw
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <redacted>')
    .replace(/\b(?:token|apikey|api_key|secret|password)\s*[:=]\s*[^\s,;]+/gi, (m) => {
      const idx = m.search(/[:=]/);
      return idx > 0 ? `${m.slice(0, idx + 1)}<redacted>` : '<redacted>';
    });
  if (redacted.length <= maxLen) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLen - 1))}…`;
}

function tailText(value, maxLen = 400) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const redacted = raw.replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <redacted>');
  if (redacted.length <= maxLen) return redacted;
  return `…${redacted.slice(Math.max(0, redacted.length - maxLen + 1))}`;
}

function derivePhase(recentSteps = [], draftText = '') {
  const hasRunning = Array.isArray(recentSteps) && recentSteps.some((s) => s?.status === 'running');
  if (hasRunning) return 'tool_calling';
  if (String(draftText ?? '').trim()) return 'streaming_reply';
  return 'thinking';
}

function formatDurationCompact(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec}s`;
}

/**
 * 构建单个 Bot 的实时工作台快照。
 *
 * @returns {{
 *   roomId: string,
 *   botId: string,
 *   botName: string,
 *   workMsgId: string|null,
 *   phase: 'thinking'|'tool_calling'|'streaming_reply',
 *   elapsedMs: number,
 *   goalExcerpt: string,
 *   steps: Array<{tool:string, status:string, detail:string, durationMs:number|null}>,
 *   activeShells: Array<{id:string, command:string, running:boolean, tail:string}>,
 *   draftTail: string,
 *   sideNotes: string[],
 *   activeTaskRun: object|null,
 *   maxChars: number,
 * }}
 */
export function buildLiveWorkSnapshot({
  roomId = '',
  botId = '',
  botName = '',
  goalText = '',
  workMsgId = null,
  workStartedAt = 0,
  nowMs = 0,
  recentSteps = [],
  draftText = '',
  activeShells = [],
  sideNotes = [],
  activeTaskRun = null,
  maxChars = 2400,
} = {}) {
  const safeNow = Number(nowMs) || 0;
  const safeStart = Number(workStartedAt) || 0;
  const elapsedMs = safeNow > 0 && safeStart > 0 ? Math.max(0, safeNow - safeStart) : 0;

  const steps = (Array.isArray(recentSteps) ? recentSteps : [])
    .slice(-8)
    .map((s) => ({
      tool: sanitizeSnippet(s?.tool ?? 'tool', 48),
      status: String(s?.status ?? 'done'),
      detail: sanitizeSnippet(s?.detail ?? '', 120),
      durationMs: typeof s?.durationMs === 'number' ? Math.max(0, s.durationMs) : null,
    }));

  const shells = (Array.isArray(activeShells) ? activeShells : [])
    .slice(0, 3)
    .map((sh) => ({
      id: String(sh?.id ?? ''),
      command: sanitizeSnippet(sh?.command ?? '', 120),
      running: Boolean(sh?.running),
      tail: tailText(sh?.tail ?? sh?.output ?? '', 600),
    }));

  const notes = (Array.isArray(sideNotes) ? sideNotes : [])
    .slice(-5)
    .map((n) => sanitizeSnippet(n, 180))
    .filter(Boolean);

  const taskSummary = activeTaskRun
    ? {
        id: String(activeTaskRun.id ?? ''),
        state: String(activeTaskRun.state ?? ''),
        revision: Number(activeTaskRun.revision ?? 0),
        goal: sanitizeSnippet(activeTaskRun.goal ?? '', 180),
      }
    : null;

  return {
    roomId: String(roomId ?? ''),
    botId: String(botId ?? ''),
    botName: sanitizeSnippet(botName || botId, 48),
    workMsgId: workMsgId ? String(workMsgId) : null,
    phase: derivePhase(recentSteps, draftText),
    elapsedMs,
    goalExcerpt: sanitizeSnippet(goalText, 300),
    steps,
    activeShells: shells,
    draftTail: tailText(draftText, 400),
    sideNotes: notes,
    activeTaskRun: taskSummary,
    maxChars: Math.max(400, Number(maxChars) || 2400),
  };
}

/**
 * 将单个工作台快照压缩成适合注入 Talk Lane 提示词的高密度中文块，并保证 <= maxChars。
 */
export function formatLiveWorkSnapshotPrompt(snapshot, { maxChars } = {}) {
  if (!snapshot) return '';
  const limit = Math.max(200, Number(maxChars ?? snapshot.maxChars) || 2400);
  const lines = [
    '【实时工作台快照（只读）】',
    `- 状态阶段：${snapshot.phase} · 已运行 ${formatDurationCompact(snapshot.elapsedMs)}`,
  ];
  if (snapshot.goalExcerpt) lines.push(`- 当前后台目标：${snapshot.goalExcerpt}`);
  if (snapshot.activeTaskRun?.id) {
    lines.push(
      `- 关联任务：${snapshot.activeTaskRun.id}（${snapshot.activeTaskRun.state}，v${snapshot.activeTaskRun.revision}）`,
    );
  }
  if (snapshot.steps?.length) {
    lines.push('- 最近执行步骤：');
    for (const s of snapshot.steps) {
      const dur = s.durationMs != null ? ` (${formatDurationCompact(s.durationMs)})` : '';
      lines.push(`  · [${s.status}] ${s.tool}${s.detail ? ` — ${s.detail}` : ''}${dur}`);
    }
  }
  if (snapshot.activeShells?.length) {
    lines.push('- 活跃后台命令：');
    for (const sh of snapshot.activeShells) {
      lines.push(`  · (${sh.running ? '运行中' : '已结束'}) ${sh.command}`);
      if (sh.tail) lines.push(`    输出尾部：${sanitizeSnippet(sh.tail, 260)}`);
    }
  }
  if (snapshot.draftTail) {
    lines.push(`- 后台草稿尾部：${sanitizeSnippet(snapshot.draftTail, 280)}`);
  }
  if (snapshot.sideNotes?.length) {
    lines.push('- 本轮刚补充过的话：');
    for (const n of snapshot.sideNotes) lines.push(`  · ${n}`);
  }
  const text = lines.join('\n');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * 部门群汇总快照：供负责人在群里边统筹边秒回用户进度。
 */
export function buildGroupWorkSnapshot({
  roomName = '',
  leadName = '',
  memberSnapshots = [],
  queuedCount = 0,
} = {}) {
  return {
    roomName: sanitizeSnippet(roomName, 60),
    leadName: sanitizeSnippet(leadName, 48),
    queuedCount: Math.max(0, Number(queuedCount) || 0),
    members: (Array.isArray(memberSnapshots) ? memberSnapshots : []).slice(0, 12),
  };
}

export function formatGroupWorkSnapshotPrompt(groupSnapshot, { maxChars = 2800 } = {}) {
  if (!groupSnapshot) return '';
  const limit = Math.max(300, Number(maxChars) || 2800);
  const lines = [
    `【部门「${groupSnapshot.roomName || '当前群'}」实时协作快照（只读）】`,
    `- 正在运行成员数：${groupSnapshot.members?.length ?? 0}${groupSnapshot.queuedCount ? ` · 待接续队列：${groupSnapshot.queuedCount}` : ''}`,
  ];
  for (const m of groupSnapshot.members ?? []) {
    const lastStep = m.steps?.length ? m.steps[m.steps.length - 1] : null;
    const stepText = lastStep
      ? `${lastStep.tool}[${lastStep.status}]${lastStep.detail ? `(${sanitizeSnippet(lastStep.detail, 80)})` : ''}`
      : m.phase;
    lines.push(
      `  · ${m.botName || m.botId}：已跑 ${formatDurationCompact(m.elapsedMs)} · ${stepText}`,
    );
  }
  const text = lines.join('\n');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}
