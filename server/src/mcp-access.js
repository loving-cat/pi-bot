/** 外部工具分类与会话授权快照；配置或分配变化后旧会话停止调用。 */
import { createHash } from 'node:crypto';

import { windowsSandboxMessage } from './sandbox-win.js';

const RESOURCE_TOOLS = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']);
export function isExternalMcpTool(name) {
  return typeof name === 'string' && (name.startsWith('mcp__') || RESOURCE_TOOLS.has(name));
}

export function mcpAccessSignature(bot, library = []) {
  const names = new Set((bot?.mcpServers ?? []).map((name) => String(name).toLowerCase()));
  const selected = library.filter((s) => s.enabled && names.has(s.name.toLowerCase()))
    .map((s) => [s.id, s.name, s.configurationRevision ?? s.updatedAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash('sha256').update(JSON.stringify([bot?.enabled !== false, [...names].sort(), selected])).digest('hex');
}

/**
 * 把 `mcp__<server>__<tool>` 拆成 { server, tool }；资源类工具返回 null
 * （它们不属于任何具体 server 的 tools/list）。
 */
/** 沙箱不可用时给用户的话。 */
export function sandboxUnavailableMessage(reason, detail = '') {
  if (reason === 'unsupported_platform') {
    return '当前平台没有可用的沙箱（macOS 用 sandbox-exec，Linux 用 bwrap，'
      + 'Windows 用仓库自带的 pibot-sandbox.exe），这个 bot 挂了 MCP，'
      + '为安全起见拒绝执行 shell 命令。';
  }
  if (reason === 'no_binary') {
    return '沙箱程序不存在：macOS 需要系统自带 sandbox-exec，Linux 需要 bubblewrap（bwrap），'
      + 'Windows 需要 pibot-sandbox.exe（随发行包提供，源码在 native/pibot-sandbox）。'
      + '为安全起见拒绝执行。';
  }
  // Windows 启动器自己的机读错误码，文案在 sandbox-win.js 里维护
  if (typeof reason === 'string' && /^[A-Z0-9_]+$/.test(reason)) {
    return windowsSandboxMessage(reason, detail);
  }
  return '沙箱启动失败（' + reason + '），为安全起见拒绝执行，不降级成无沙箱运行。';
}

export function splitExternalToolName(name) {
  if (typeof name !== 'string') return null;
  const m = /^mcp__([A-Za-z0-9_-]{1,80})__(.+)$/.exec(name);
  if (!m) return null;
  return { server: m[1], tool: m[2] };
}

export function externalApprovalSummary(tool) {
  return `调用外部工具 ${String(tool ?? '').slice(0, 100)}`;
}
