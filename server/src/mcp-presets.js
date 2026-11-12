/**
 * 内置 MCP 预设：登记方式与用户手加的服务完全一致，只是"出厂自带"。
 *
 * ## 设计原则
 *
 * 1. **预设 ≠ 自动运行**。登记进库时 enabled 一律 false，也不挂到任何 bot。
 *    用户打开开关（或审批挂载）之后才真正起进程 —— MCP 会起子进程吃内存，
 *    "装了就自动跑"是不可接受的默认。
 * 2. **不改数据结构**。预设就是普通的 mcpServers 条目，STATE_VERSION 不变。
 *    这样才能"用户改过的配置不被预设覆盖"——见 ensureBuiltinPresets 的合并逻辑。
 * 3. **不打包二进制、不下载、不执行安装命令**。只检测本机是否已有，
 *    没有就在 UI 给安装说明。自动化安装一个会起 Ghidra/JVM 的东西，
 *    风险和体积都不该由我们替用户决定。
 */

/**
 * 预设清单。
 *
 * `id` 是稳定的身份标识（存进条目的 `presetId` 字段），
 * 改名不影响"还是同一个预设"的判定。
 */
import { statSync } from 'node:fs';
import { config } from './config.js';
import { PRESET_SHAPES, PRESET_OUTPUT_DIR, presetOutputDir } from './mcp-preset-shapes.js';

const configDataDir = () => String(config?.dataDir ?? '');

export const BUILTIN_MCP_PRESETS = [
  {
    id: 'r2mcp',
    name: 'r2mcp',
    type: 'stdio',
    description:
      'radare2 官方的逆向分析 MCP：反汇编、反编译、列函数/导入/导出/字符串/符号、交叉引用、hexdump。' +
      '默认以只读模式（-R）启动，不开放 run_command / sql 这类会动手的工具。',
    // ★ 默认带 -R：r2mcp 上游支持只读模式，服务端只暴露标记了 TOOL_MODE_RO 的工具。
    //   这比客户端白名单更稳（上游维护，不靠我们跟踪工具名漂移）。
    //   ★ 不带 -r（那是 restrict 另一个维度的开关，会改变工具集），
    //   ★ 不带 -L（那会打开远端 r2/iaito 会话，等于让 MCP 连到别的进程上）。
    command: 'r2mcp',
    // ★ 参数从 PRESET_SHAPES 取，保证「登记的配置」和「白名单认的形状」永远一致
    args: [...PRESET_SHAPES.find((s) => s.id === 'r2mcp').args],
    // 版本约束只作文档/检测提示，不参与启动参数
    versionNote: '需要 r2mcp 1.9.0（radare2 ≥ 6.2.x）',
    /** 检测本机是否有这个可执行文件；返回 {found, detail} */
    detect: 'r2mcp',
    install:
      'macOS：`r2pm -Uci r2mcp`（先装 radare2：`brew install radare2`）\n' +
      'Linux：先装 radare2（发行版包或 `brew install radare2`），再 `r2pm -Uci r2mcp`\n' +
      'Windows：从 https://github.com/radareorg/radare2/releases 下载 zip，' +
      '解压后把 bin 目录加进 PATH，再 `r2pm -Uci r2mcp`',
  },
  {
    id: 'pyghidra-mcp',
    name: 'pyghidra-mcp',
    type: 'stdio',
    description:
      'Ghidra 官方的 PyGhidra MCP：反编译、反汇编、调用图、符号/导入导出搜索、按地址读字节。' +
      '以 headless + stdio 启动（不占用 GUI），索引写在 pi-bot 数据目录下。',
    // ★ 锁版本：uvx 不锁版本会拉到任意新版本，行为和工具名都可能变。
    //   用 --from 显式指定，避免"今天能用明天炸"。
    // ★ command/args 从 PRESET_SHAPES 取，保证与白名单形状一致。
    //   project-path 的值是占位（空串），登记时替换成数据目录下的真实路径。
    command: PRESET_SHAPES.find((s) => s.id === 'pyghidra-mcp').command,
    args: [
      ...PRESET_SHAPES.find((s) => s.id === 'pyghidra-mcp').args,
      '', // project-path 的占位，见 ensureBuiltinPresets
    ],
    versionNote: '需要 pyghidra-mcp==0.3.0、Ghidra（GHIDRA_INSTALL_DIR 指向安装目录）、JDK 21+',
    // 通过 uvx 拉起，首次会把整个 Python 依赖树下载下来（实测约 80MB）。
    // 只作提示展示，不改变任何启动行为。
    firstRunDownload: '约 80MB',
    detect: 'pyghidra-mcp',
    install:
      '需要三样东西：\n' +
      '1. JDK 21+：`brew install openjdk@21`\n' +
      '2. Ghidra：从 https://ghidra-sre.org 下载，解压后设 `GHIDRA_INSTALL_DIR`\n' +
      '3. uv：`brew install uv`（提供 uvx）\n' +
      '装好后本预设会用 `uvx --from pyghidra-mcp==0.3.0` 拉起，首次会自动下载 Python 包。',
  },
];

/** pi-bot 的数据目录（预设输出目录挂在它下面）。 */
function presetDataDir() {
  try {
    // 延迟 import：mcp-presets 被 store 链路引用，config 若在加载期循环依赖会炸
    return configDataDir();
  } catch {
    return '';
  }
}

// 输出目录的计算放在 mcp-preset-shapes.js —— policy-hook 也要用它，
// 而那条链路不该依赖整个预设模块（那会把"白名单判定"和"预设登记"耦合起来）。
export { PRESET_OUTPUT_DIR, presetOutputDir };

/** 按 id 取预设。 */
export function findBuiltinPreset(id) {
  return BUILTIN_MCP_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * 把预设登记进 MCP 库 —— **幂等**，且不覆盖用户改动。
 *
 * ## 判定规则
 *
 *   1. 库里已有同名服务（不论是不是预设）→ **跳过**，一个字都不改。
 *      用户可能早就自己配了一个 r2mcp（带自己的参数、自己的 env），
 *      预设绝不能把它顶掉。
 *   2. 库里已有 `presetId` 相同的条目 → 跳过（用户改过名也算同一个预设）。
 *   3. 都没有 → 插入一条新的，enabled=false，presetId 记下身份。
 *
 * 所以"重复启动不产生重复条目"和"用户改过的不被覆盖"是同一条规则的两种表现。
 *
 * @param {object} store
 * @returns {{added: string[], skipped: string[]}}
 */
export function ensureBuiltinPresets(store) {
  const added = [];
  const skipped = [];
  // 数据目录从 config 拿（store 自己不持有路径）。
  // 拿不到就退化成空串 —— 那样 projectPathOf 会给出相对路径，
  // 但这是异常情况（config 总是在 store 之前初始化）。
  const dataDir = presetDataDir();

  for (const preset of BUILTIN_MCP_PRESETS) {
    const existing = store.mcpLibrary();
    const byName = existing.some(
      (s) => String(s?.name ?? '').toLowerCase() === preset.name.toLowerCase(),
    );
    const byPresetId = existing.some((s) => s?.presetId === preset.id);
    if (byName || byPresetId) {
      skipped.push(preset.id);
      continue;
    }

    // 参数里的 project_path 要落到数据目录下这个预设专属的子目录，
    // 不能落样本目录、也不能落到用户 HOME 其它地方。
    const args = preset.args.map((a) => (a === '' ? presetOutputDir(dataDir, preset.id) : a));

    const result = store.addMcpServer({
      name: preset.name,
      type: preset.type,
      description: preset.description,
      command: preset.command,
      args,
      // ★ 预设默认不启用：装了不等于要跑
      enabled: false,
      presetId: preset.id,
    });
    if (result?.error) {
      skipped.push(preset.id);
      continue;
    }
    added.push(preset.id);
  }

  return { added, skipped };
}

/**
 * 在本机 PATH 里找一个可执行文件，找到返回绝对路径，否则 null。
 *
 * ★ 只做**查找**，不执行、不下载、不安装。
 *   查的是 PATH 和几个常见安装位置；找不到就返回 null，
 *   由 UI 给安装说明，绝不替用户跑安装命令。
 */
export function whichExecutable(name) {
  const exe = String(name ?? '').trim();
  if (!exe) return null;
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['', '.exe', '.cmd', '.bat'] : [''];
  const dirs = String(process.env.PATH ?? '')
    .split(isWin ? ';' : ':')
    .filter(Boolean);
  // 桌面端拉起的服务端有时 PATH 很短（尤其从 Finder 启动的 GUI），
  // 这里补几个常见位置 —— 仍然只是"看有没有"，不装任何东西。
  dirs.push(
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    ...(process.env.HOME ? [`${process.env.HOME}/.local/bin`, `${process.env.HOME}/bin`] : []),
  );
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = `${dir}/${exe}${ext}`;
      try {
        const st = statSync(full);
        // eslint-disable-next-line no-bitwise
        if (st.isFile() && (isWin || (st.mode & 0o111) !== 0)) return full;
      } catch {
        // 不存在就继续找
      }
    }
  }
  return null;
}

/**
 * 本机检测：这些预设依赖的可执行文件在不在。
 *
 * **只查不装**。找不到就返回安装说明，由 UI 展示。
 * 不执行任何命令、不下载任何东西 —— 自动化装 Ghidra 这种几百 MB、
 * 还要配 JVM 的东西，不该由服务端替用户决定。
 *
 * @param {(name: string) => string|null} which 可执行文件查找函数（注入便于测试）
 */
export function detectPresetAvailability(which) {
  const out = {};
  for (const preset of BUILTIN_MCP_PRESETS) {
    let found = false;
    let detail = '';
    if (preset.detect === 'r2mcp') {
      // r2mcp 可能直接可执行，也可能通过 r2pm 提供
      const direct = which('r2mcp');
      const viaR2pm = which('r2pm');
      found = Boolean(direct || viaR2pm);
      detail = direct
        ? `已检测到 r2mcp：${direct}`
        : viaR2pm
          ? `已检测到 r2pm（可运行 r2mcp）：${viaR2pm}`
          : '未检测到 r2mcp / r2pm';
    } else if (preset.detect === 'pyghidra-mcp') {
      const uvx = which('uvx');
      const ghidra = process.env.GHIDRA_INSTALL_DIR || '';
      const java = which('java');
      // 三样齐了才算可用：uvx 负责拉包，Ghidra + JDK 是 pyghidra 的运行前提
      const missing = [];
      if (!uvx) missing.push('uvx');
      if (!ghidra) missing.push('GHIDRA_INSTALL_DIR');
      if (!java) missing.push('java');
      found = missing.length === 0;
      detail = found
        ? `已检测到 uvx / Ghidra / JDK`
        : `缺少：${missing.join('、')}`;
    }
    out[preset.id] = {
      found,
      detail,
      install: preset.install,
      versionNote: preset.versionNote,
      firstRunDownload: preset.firstRunDownload ?? null,
    };
  }
  return out;
}
