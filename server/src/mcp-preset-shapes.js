/**
 * 预设形状相关 —— **已全部停用**。
 *
 * ## 背景
 *
 * 这里曾经存放 r2mcp / pyghidra-mcp 的"配置精确形状"定义，用来判断
 * 某个 MCP 配置是不是"和预设逐项相同"，从而给它 static（免审批）待遇。
 *
 * 两条原因让它整体下线：
 *
 *   1. **首批不内置任何逆向 MCP**。r2mcp 依赖 LGPL 的 radare2、
 *      pyghidra 依赖 GPL 的 JDK，而内置只收 MIT/Apache/BSD。
 *   2. **不再存在免审批的 static 档**。任何外部 MCP 工具都逐次审批 ——
 *      判据再严也只是"我们以为它安全"，而 MCP 是被调用方，
 *      它随时能在下一次更新里改变行为。
 *
 * ## 现在还剩什么
 *
 * 只保留**纯展示**用的工具函数（UI 里显示"这个 MCP 大概是干嘛的"）。
 * 它们不参与任何安全判定 —— 删掉它们也不会让任何调用多一次或少一次审批。
 *
 * `matchPresetShape` 保留签名但恒返回 null：万一还有调用方，行为是
 * "不匹配任何预设"，即按需要审批处理 —— 安全侧永远是对的。
 */

/** 预设输出目录的目录名（已无预设使用；保留常量避免引用处炸掉）。 */
export const PRESET_OUTPUT_DIR = 'mcp-data';

/** 某个输出目录（绝对路径）。仅工具函数，不参与判定。 */
export function presetOutputDir(dataDir, presetId) {
  return dataDir ? `${dataDir}/${PRESET_OUTPUT_DIR}/${presetId}` : '';
}

/**
 * 这组配置是否**逐项等于**某个启用的预设形状。
 *
 * ★ 恒返回 null —— 已没有任何 static 预设。
 *   保留函数是为了让旧调用点不必改签名，行为是"不匹配 → 需要审批"。
 */
export function matchPresetShape() {
  return null;
}

/** 旧字段：曾经用来判断"env 是否为空"。现已无判定用途，保留占位。 */
export function hasAnyEnv(server) {
  const env = server?.env;
  if (!env || typeof env !== 'object') return false;
  return Object.keys(env).length > 0;
}

/**
 * 已知能改变"加载什么代码"的环境变量 —— **只用于 UI 提示**。
 *
 * 列这些只是举例，不是穷举；正因为列不全，才不能拿它当判定依据。
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
