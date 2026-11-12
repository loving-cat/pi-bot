/**
 * 内置预设的**配置精确形状**定义 —— static 白名单唯一认的形态。
 *
 * ## 为什么不能按"可执行名"认
 *
 * 上一版用 executableNameOf 取 basename 去匹配白名单，冒充太容易：
 *
 *   /tmp/evil/r2mcp                          → basename 是 r2mcp，冒充成功
 *   npx -y r2mcp                             → npm 上叫 r2mcp 的包未必是 radare 官方
 *   uvx --from ./本地目录/pyghidra-mcp        → 谁都能建一个同名本地包
 *   uvx --from git+https://evil/x pyghidra-mcp → 任意包源
 *   uvx --from pyghidra-mcp==0.3.0 --with evil → --with 装的包能通过 .pth 在启动时执行代码
 *   python -m pyghidra_mcp + PYTHONPATH=...   → 加载路径被 env 改写
 *
 * 所以现在的规则是：**只有和预设定义逐项完全相等**的配置才算 static。
 * 任何偏离（换命令、换参数、加 --with、换包源、改环境）一律 dynamic。
 *
 * ## 为什么不用归一化推断
 *
 * 上一版还试图"猜"用户写的是哪个启动器（r2pm -r / uvx --from / npx）。
 * 猜得越多，能钻的空子越多。现在只认**显式列出的精确形态**：
 * r2mcp 的两种等价写法各写一条 SHAPE，逐项比对 args。
 */

/**
 * 已知能改变"加载什么代码"的环境变量 —— **只用于 UI 提示，不参与放行判定**。
 *
 * ★ 放行判定已经改成"env 必须为空"（见 matchPresetShape），
 *   这份清单不再有任何安全作用。留着是因为用户手改配置时，
 *   界面可以据此解释"为什么它变成需要逐次审批了"。
 *
 * 列这些只是举例，不是穷举 —— 正因为列不全，才不能拿它当判定依据：
 *   PATH            决定 command 'r2mcp' 解析到哪个可执行文件
 *   HOME            决定 radare2 去哪读 .radare2rc 与插件目录
 *   R2_*            直接指定 rc / 插件路径
 *   GHIDRA_INSTALL_DIR  指向攻击者准备的 Ghidra
 *   JAVA_TOOL_OPTIONS / _JAVA_OPTIONS  JVM 加载任意 agent
 *   XDG_* / TMPDIR  改各种默认路径
 */
export const LOADER_ENV_HINTS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'R2_',
  'GHIDRA_INSTALL_DIR',
  'JAVA_HOME',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'XDG_',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'NODE_OPTIONS',
  'NODE_PATH',
  'UV_',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
];

/**
 * 预设形状清单。
 *
 * `args` 是**逐项精确比对**的期望值；`projectPathSlot` 指示位置参数里
 * 哪一项要替换成"按数据目录算出来的实际路径"后再比。
 *
 * 每条 shape 对应上一版白名单的一个 key（exe）。
 */
export const PRESET_SHAPES = [
  {
    // 主线：直接用 r2mcp 可执行文件
    id: 'r2mcp',
    exe: 'r2mcp',
    command: 'r2mcp',
    args: ['-R'],
    tools: [
      'calculate', 'decompile_function', 'disassemble', 'disassemble_function',
      'get_current_address', 'get_function_prototype', 'hexdump', 'list_all_strings',
      'list_classes', 'list_decompilers', 'list_entrypoints', 'list_exports',
      'list_functions', 'list_functions_tree', 'list_imports', 'list_libraries',
      'list_methods', 'list_sections', 'list_strings', 'list_symbols',
      'lookup_address', 'lookup_export', 'lookup_symbol',
      'show_function_details', 'show_info', 'xrefs_to',
    ],
  },
  {
    // 等价写法：通过 r2pm 启动。**必须逐字写成 r2pm -r r2mcp -R**，
    // 不做"r2pm 后面随便跟什么都能归一成 r2mcp"的推断。
    id: 'r2mcp-via-r2pm',
    exe: 'r2pm',
    command: 'r2pm',
    args: ['-r', 'r2mcp', '-R'],
    tools: [
      'calculate', 'decompile_function', 'disassemble', 'disassemble_function',
      'get_current_address', 'get_function_prototype', 'hexdump', 'list_all_strings',
      'list_classes', 'list_decompilers', 'list_entrypoints', 'list_exports',
      'list_functions', 'list_functions_tree', 'list_imports', 'list_libraries',
      'list_methods', 'list_sections', 'list_strings', 'list_symbols',
      'lookup_address', 'lookup_export', 'lookup_symbol',
      'show_function_details', 'show_info', 'xrefs_to',
    ],
  },
  {
    // pyghidra：uvx + 锁定的包 + headless + project-path（最后一项按数据目录算）
    id: 'pyghidra-mcp',
    exe: 'pyghidra-mcp',
    command: 'uvx',
    args: ['--from', 'pyghidra-mcp==0.3.0', 'pyghidra-mcp', '--project-path'],
    // args 有 4 个固定项（下标 0..3），project_path 的值是**紧接着的第 5 个**（下标 4）
    projectPathSlot: 4,
    tools: [
      'decompile_function', 'disassemble', 'gen_callgraph', 'get_gui_context',
      'list_exports', 'list_imports', 'list_open_programs',
      'list_project_binaries', 'list_project_binary_metadata', 'list_xrefs',
      'read_bytes', 'search_code', 'search_strings', 'search_symbols_by_name',
    ],
  },
];

/** 预设输出目录的目录名（挂在数据目录下）。 */
export const PRESET_OUTPUT_DIR = 'mcp-data';

/**
 * 某个预设的输出目录（绝对路径）。
 *
 * pyghidra 会在 project_path 下写 chromadb 索引 —— 必须落在 pi-bot 数据目录里，
 * 不能是样本目录，也不能是用户 HOME 其它位置。
 */
export function presetOutputDir(dataDir, presetId) {
  return dataDir ? `${dataDir}/${PRESET_OUTPUT_DIR}/${presetId}` : '';
}

/** 环境里有没有能改加载行为的变量。 */
export function hasAnyEnv(server) {
  const env = server?.env;
  if (!env || typeof env !== 'object') return false;
  // 空对象 {} 也算"没有 env"
  return Object.keys(env).length > 0;
}

/**
 * 这个 server 配置是否**逐项等于**某个预设形状。
 *
 * @param {object} server 运行时配置（含 command / args / env）
 * @param {(presetId: string) => string} projectPathOf 算 project_path 的函数
 * @returns {object|null} 命中的 shape，或 null
 */
export function matchPresetShape(server, projectPathOf = () => '') {
  if (!server || typeof server !== 'object') return null;
  // ★ 只要配置里写了**任何** env 键 → 不给 static。
  //
  //   原来是黑名单（PYTHONPATH / NODE_OPTIONS / UV_* …），但档不全：
  //     · PATH=/tmp/evil     → command 'r2mcp' 解析到假的可执行文件
  //     · HOME=/tmp/evil     → radare2 去加载攻击者的 rc 与插件
  //     · R2_RCFILE / R2_*   → 直接指定 rc 文件
  //     · GHIDRA_INSTALL_DIR → 指向攻击者准备的一份 Ghidra
  //     · JAVA_TOOL_OPTIONS / _JAVA_OPTIONS → JVM 加载任意 agent
  //     · XDG_* / TMPDIR     → 改各种默认路径
  //   这类变量还在不断被发现，黑名单永远补不完。
  //
  //   所以反过来：预设形态**要求 env 为空或不存在**。
  //   安装/运行依赖（GHIDRA_INSTALL_DIR、JAVA_HOME 等）由 pi-bot 自己的
  //   进程环境提供，不写进 server 配置的 env —— 见 detectPresetAvailability。
  if (hasAnyEnv(server)) return null;

  const command = String(server.command ?? '');
  const args = Array.isArray(server.args) ? server.args.map(String) : [];

  for (const shape of PRESET_SHAPES) {
    if (command !== shape.command) continue;

    // 参数个数必须**恰好**：多一个（--with、--gui、-L）就说明不是预设形态。
    const expectedLen = shape.args.length + (shape.projectPathSlot === undefined ? 0 : 1);
    if (args.length !== expectedLen) continue;

    // 固定项逐字比对
    let ok = true;
    for (let i = 0; i < shape.args.length; i += 1) {
      if (args[i] !== shape.args[i]) { ok = false; break; }
    }
    if (!ok) continue;

    // project_path 的实测值必须等于"按数据目录算出来的路径"
    if (shape.projectPathSlot !== undefined) {
      if (args[shape.projectPathSlot] !== projectPathOf(shape.id)) continue;
    }
    return shape;
  }
  return null;
}
