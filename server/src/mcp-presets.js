/**
 * 曾经的内置 MCP 预设 —— **已全部下线**。
 *
 * ## 为什么撤掉
 *
 * 首批不内置任何逆向 MCP：r2mcp 依赖 LGPL 的 radare2、
 * pyghidra 依赖 GPL 的 JDK，而内置只收 MIT/Apache/BSD 的实现。
 *
 * ## 已经登记进用户库的旧条目怎么办
 *
 * `markRetiredPresets()` 在启动时跑一次：把带 `presetId` 的旧条目
 * 标成 `retired`，**强制 enabled=false**，并保留原样不删 ——
 *
 *   · 不自动删：用户可能往里填过自己的 env / 凭据，删了就是丢数据；
 *   · 不报错：升级后不该因为一个已经不存在的预设而让服务端起不来；
 *   · 强制不启用：这些服务的内容我们已经不再背书，不该继续自动跑。
 *
 * 界面据 `retired` 字段显示「已下线的预设」，用户可以自己决定留还是删。
 */

/** 已经下线的预设 id（只用于把旧条目标出来，不再创建任何新条目）。 */
export const RETIRED_PRESET_IDS = ['r2mcp', 'r2mcp-via-r2pm', 'pyghidra-mcp'];

/**
 * 把库里带 presetId 的旧条目标成"已下线"，并强制不启用。
 *
 * 幂等：重复启动不会改第二遍。
 *
 * @returns {{retired: string[]}}
 */
export function markRetiredPresets(store) {
  const retired = [];
  try {
    for (const server of store.mcpLibrary()) {
      const presetId = String(server?.presetId ?? '');
      if (!presetId) continue;
      // 已经是 retired 且已关闭的，跳过（幂等）
      if (server.retired === true && server.enabled === false) continue;
      const patched = store.updateMcpServer(server.id, {
        // 不再自动跑：这些服务的配置我们已经不再背书
        enabled: false,
        retired: true,
      });
      if (!patched?.error) retired.push(server.name);
    }
  } catch {
    // 升级清理失败不该挡住启动
  }
  return { retired };
}

/** 已下线预设的展示名（UI 用）。 */
export function retiredPresetLabel(presetId) {
  return RETIRED_PRESET_IDS.includes(String(presetId ?? '')) ? '已下线的预设' : '';
}
