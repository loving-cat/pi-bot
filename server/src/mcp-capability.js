/**
 * MCP 能力画像：把「这个服务能干什么」变成可判定的标签。
 *
 * 为什么需要：
 *   MCP 库里有 rea、playwright、chrome-devtools 这些服务，但 bot 默认一个都不挂 ——
 *   因为每个 MCP 都会起子进程（rea 带 Ghidra + JVM 就是几百 MB），
 *   几十个会话全挂会把机器拖死。
 *
 *   结果就是：库里明明有能力，用户却要手动去「设置 → MCP」挨个勾选，
 *   还得知道该给哪个 bot 勾。这层映射不该让用户记。
 *
 * 这里做的事：
 *   从服务的名字/命令/描述推断它属于哪类能力，再按任务的文字特征
 *   推荐该挂哪几个。纯逻辑，无副作用，方便单测。
 */

/** 能力类别。顺序即提示词里的展示顺序。 */
export const CAPABILITY_KINDS = [
  {
    key: 'reverse',
    label: '逆向 / 二进制分析',
    // ★ hints 只用于识别"这个 MCP 属于哪类能力"。
    //
    //   它不产生任何推荐加权，也不会让某个服务少一次审批 ——
    //   内置预设已全部下线，所有外部 MCP 工具一律逐次审批。
    hints: ['rea', 'ghidra', 'ida', 'radare', 'rizin', 'binary', 'disasm', 'decompile'],
    triggers: [
      '逆向', '反编译', '反汇编', '静态分析', '二进制', '固件',
      '崩溃', 'crash', '符号表', 'dylib', 'apk', '脱壳',
      'reverse', 'decompile', 'disassemble', 'firmware',
    ],
  },
  {
    key: 'browser',
    label: '浏览器 / 网页操作',
    hints: ['playwright', 'puppeteer', 'chrome-devtools', 'browser', 'selenium', 'ego'],
    triggers: [
      '网页', '网站', '浏览器', '登录', '点击', '填表', '截图',
      '抓取', '爬', '前端页面', 'e2e', '端到端', '打开链接',
      'browser', 'webpage', 'selenium', 'playwright',
    ],
  },
  {
    key: 'e2e',
    label: '端到端测试',
    hints: ['e2e', 'cypress', 'testcafe'],
    triggers: ['端到端', 'e2e', '流程测试', '自动化测试', '回归测试'],
  },
  {
    key: 'filesystem',
    label: '文件系统',
    hints: ['filesystem', 'file-server'],
    triggers: ['批量改文件', '遍历目录', '文件系统'],
  },
  {
    key: 'database',
    label: '数据库',
    hints: ['postgres', 'mysql', 'sqlite', 'mongodb', 'database'],
    triggers: [
      '数据库', 'sql', '表结构', '索引', '查询语句', '建表', '迁移',
      'database', 'postgres', 'mysql', 'sqlite',
    ],
  },
  {
    key: 'docs',
    label: '文档 / 知识库',
    hints: ['notion', 'confluence', 'knowledge'],
    triggers: ['知识库', '文档库', 'notion', 'confluence'],
  },
];

const lower = (v) => String(v ?? '').toLowerCase();

/**
 * 判断一个 MCP 服务属于哪些能力类别。
 *
 * 看名字、命令、参数和描述 —— 任一命中就算。一个服务可以同时属于多类。
 *
 * @returns {string[]} 命中的 kind.key；一个都不命中时返回空数组
 */
export function capabilityKindsOf(server = {}) {
  const haystack = [
    server.name,
    server.command,
    ...(Array.isArray(server.args) ? server.args : []),
    server.description,
    server.url,
  ]
    .map(lower)
    .join(' ');

  return CAPABILITY_KINDS.filter((kind) =>
    kind.hints.some((hint) => haystack.includes(hint)),
  ).map((kind) => kind.key);
}

/**
 * 按任务描述推荐该挂哪些 MCP。
 *
 * 只推荐已启用的服务：没启用的挂上去也连不了，反而让模型以为配好了。
 *
 * @param {string} task 任务的文字描述（用户消息 / 派活说明）
 * @param {object[]} servers MCP 库
 * @returns {string[]} 建议挂载的服务名（按相关度排序，去重）
 */
export function recommendMcpForTask(task, servers = []) {
  const text = lower(task);
  if (!text) return [];

  const usable = (Array.isArray(servers) ? servers : []).filter(
    (s) => s && s.enabled === true && s.name,
  );
  if (!usable.length) return [];

  const scored = [];
  for (const server of usable) {
    const kinds = capabilityKindsOf(server);
    if (!kinds.length) continue;
    let score = 0;
    for (const kind of CAPABILITY_KINDS) {
      if (!kinds.includes(kind.key)) continue;
      for (const trigger of kind.triggers) {
        if (text.includes(lower(trigger))) score += 1;
      }
    }
    if (score > 0) scored.push({ name: server.name, score });
  }

  // 纯按相关度排序，没有任何"预设优先"的加权。
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.map((s) => s.name);
}

/**
 * 给主控提示词用的能力清单：按类别分组，并说明什么时候该挂。
 *
 * 和 mcpSectionForPrompt 的区别：那个只列「有哪些服务」，
 * 这个回答「什么活该配什么」。
 */
export function capabilityGuideForPrompt(servers = []) {
  const usable = (Array.isArray(servers) ? servers : []).filter(
    (s) => s && s.enabled === true && s.name,
  );
  if (!usable.length) return '';

  const grouped = new Map();
  const unclassified = [];
  for (const server of usable) {
    const kinds = capabilityKindsOf(server);
    if (!kinds.length) {
      unclassified.push(server.name);
      continue;
    }
    for (const key of kinds) {
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(server.name);
    }
  }

  const lines = ['## 什么时候挂哪个 MCP', ''];
  lines.push(
    '下面的活需要外部工具时，先给接手的 bot 配上对应 MCP 再派' +
      '（用 update_bot 的 mcpServers）。不配就派，它只能用内置的读写文件与搜索，做不了这类事。',
    '',
    '★ 两点必须记住：',
    '· 挂载会**弹审批卡**给用户，批准后才生效。所以别一次挂一堆，也别在用户不在时反复试。',
    '· 服务本身要**先由用户在「设置 → MCP」里启用**。没启用的服务挂了也连不上，' +
      '而且 update_bot 会直接报错说它还没启用。',
  );
  lines.push('');
  for (const kind of CAPABILITY_KINDS) {
    const names = grouped.get(kind.key);
    if (!names || !names.length) continue;
    lines.push(
      '- **' + kind.label + '** → ' + names.join(' / ') +
        '　触发词：' + kind.triggers.slice(0, 6).join('、'),
    );
  }
  if (unclassified.length) {
    lines.push('- **其它** → ' + unclassified.join(' / ') + '　（按名字判断用途）');
  }
  lines.push('');
  lines.push(
    '挂完那个 bot 的会话会自动重开。别一次挂一堆 —— 每个 MCP 都起进程吃内存，' +
      '只挂这次活真正用得上的。',
    '挂载动作本身要用户点批准，所以挂之前先把理由说清楚（要干什么活、为什么非得用它）。',
  );
  return lines.join('\n');
}
