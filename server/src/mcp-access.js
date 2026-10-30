/** 外部工具分类与会话授权快照；配置或分配变化后旧会话停止调用。 */
import { createHash } from 'node:crypto';

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

export function externalApprovalSummary(tool) {
  return `调用外部工具 ${String(tool ?? '').slice(0, 100)}`;
}
