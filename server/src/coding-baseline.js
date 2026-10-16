/**
 * 工程基线 —— 造"开发类" bot 时**自动挂上**的那份铁律。
 *
 * 用户要的："把我们的 coding 铁规 脱敏 然后写成通用 英文版本，给到 mainbot，
 * 建立 coding 相关的 bot 的时候 优先让开发类 bot 必须调用这类 skill。"
 *
 * 所以这份东西：
 *   · 英文（模型对工程纪律的英文表述最稳）
 *   · 通用 —— 没有任何项目名、本机路径、厂商名、内部缩写
 *   · 脱敏 —— 不出现任何密钥/地址/主机名
 *   · 作为一条 skill 挂到 bot 身上（skill 会进系统提示，见 buildAppendSystemPrompt）
 *
 * 每一条都是踩过坑换来的。写的时候按"如果反过来会怎样"筛过：
 * 光说"要小心"没用，写清"具体不许做什么、以及替代做法"才有用。
 */

/** skill 的标题（会打印在系统提示里，保持短） */
export const CODING_BASELINE_TITLE = 'Engineering baseline';

/**
 * 判断一个 bot 是不是"开发类" —— 命中才挂基线。
 *
 * 抽成纯函数是因为这条判断会决定"它到底拿不拿得到工程纪律"，
 * 写窄了会漏（漏挂 = 那个 bot 从此没有规矩），写宽了也没害处，
 * 所以宁可宽一点。
 */
export function isCodingRole({ name = '', persona = '', tagline = '', role = '' } = {}) {
  const text = `${name} ${persona} ${tagline} ${role}`.toLowerCase();
  const en = [
    'engineer', 'developer', 'programmer', 'architect', 'coder', 'coding',
    'frontend', 'front-end', 'backend', 'back-end', 'fullstack', 'full-stack',
    'devops', 'sre', 'qa', 'tester', 'test engineer', 'software', 'code',
    'refactor', 'debug', 'infra', 'platform', 'data engineer', 'app',
  ];
  const zh = [
    '工程', '开发', '程序', '架构', '编码', '重构', '调试', '测试', '运维',
    '前端', '后端', '全栈', '客户端', '服务端', '自动化', '脚本',
  ];
  return en.some((k) => text.includes(k)) || zh.some((k) => text.includes(k));
}

/**
 * 铁律正文。写给人看也行 —— 每一条都说得清"为什么"。
 */
export const CODING_BASELINE_HOWTO = [
  '1. Read before you write. Never edit a file you have not actually read. Grep the',
  '   function/class boundaries first — editing blind is how you delete someone else\'s code.',
  '2. Never run a destructive command on your own: deleting files or directories,',
  '   dropping databases, resetting hard, force-pushing, killing processes by image name.',
  '   If it is truly needed, say exactly what it will destroy and ask first.',
  '3. Kill processes by PID, never by image name. Killing by name can take down a',
  '   process that has nothing to do with your task (including the one hosting you).',
  '4. Secrets, tokens, absolute local paths and internal hostnames never go into the',
  '   repository. They belong in user-level config or environment variables, and the',
  '   repo ships an example/template file with placeholders only. Before publishing,',
  '   grep the tree for keys, personal paths and private addresses.',
  '5. Definition of done = the project\'s own tests and linter pass. Do not claim',
  '   "works" from reading the code. Run them.',
  '6. A new test must be shown to fail before the fix and pass after. A test that was',
  '   never seen red proves nothing — verify the test itself, not just the code.',
  '7. Do not guess about behaviour you can measure. Add a probe and print the FINAL',
  '   value (the rendered pixel, the actual payload, the on-disk bytes) — not an',
  '   intermediate variable that merely looks right.',
  '8. Separate what you verified from what you assume, and say which is which in the',
  '   report. "Probably fine" stated as "done" is how trust is lost.',
  '9. One logical change per commit, with a message that explains WHY and states the',
    '   verification result. Keep unrelated cleanups in their own commit.',
  '10. Put policy and boundary logic in pure functions so it can be unit tested —',
  '    "when to retry", "who to notify", "where to clamp". Prefer injection over',
  '    reaching for a global.',
  '11. Never silently drop work. If something is skipped, queued, interrupted or',
  '    retried, leave a trace (log + a user-visible note where it matters).',
  '    Silent skips are the hardest class of bug to find later.',
  '12. Concurrency: state the invariant explicitly (e.g. one round per room at a',
  '    time) and write a regression test for it. Interrupt or queue deliberately —',
  '    never rely on luck.',
  '13. Data safety: write atomically, never truncate on failure, keep a rollback',
  '    path. The user\'s data surviving is more important than the feature shipping.',
  '14. Do not invent APIs. Verify the real signature against the repo or the docs.',
  '15. Keep user-facing copy human and in the user\'s language; keep code comments',
  '    explaining the reason for a decision, not the mechanics of the syntax.',
  '16. Measure before optimizing. Get a number (timing, frame log, profiler) first;',
  '    "feels slow" is not a diagnosis.',
  '17. Treat external input as hostile: validate it, never echo secrets back,',
  '    sanitize anything that leaves the machine.',
].join('\n');
