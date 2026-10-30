/** 完成一次 MCP 初始化和有界工具发现；不调用任何业务工具。 */
import { createHttpProbe } from './mcp-probe-http.js';
import { createStdioProbe } from './mcp-probe-stdio.js';
import { McpProbeError, displayText, isRecord, probeError, PROBE_LIMITS, PROBE_VERSIONS } from './mcp-probe-protocol.js';

function validateInitialize(result) {
  if (!isRecord(result) || !isRecord(result.serverInfo) ||
      typeof result.serverInfo.name !== 'string' || !result.serverInfo.name.trim() ||
      typeof result.serverInfo.version !== 'string' || !isRecord(result.capabilities)) {
    throw probeError('protocol_error');
  }
  if (!PROBE_VERSIONS.includes(result.protocolVersion)) throw probeError('unsupported_protocol');
}

/** 先替换完整凭据再裁剪，避免长凭据被裁成无法匹配的前缀。 */
function metadataRedactor(server) {
  const values = new Set();
  for (const raw of [...Object.values(server.headers ?? {}), ...Object.values(server.env ?? {})]) {
    const value = String(raw ?? '');
    if (!value) continue;
    values.add(value);
    if (value.trim()) values.add(value.trim());
    const bearer = value.match(/^\s*Bearer\s+(.+?)\s*$/i);
    if (bearer?.[1]) values.add(bearer[1]);
  }
  const secrets = [...values].sort((a, b) => b.length - a.length);
  return (raw, max) => {
    let text = typeof raw === 'string' ? raw : '';
    for (const secret of secrets) text = text.split(secret).join('[已隐藏]');
    return displayText(text, max);
  };
}

function toolSummary(tool, redact) {
  if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(tool.name) ||
      !isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object') throw probeError('protocol_error');
  return {
    name: redact(tool.name, 256),
    title: redact(tool.title, 200),
    description: redact(tool.description, 500),
  };
}

/** 可选 signal 取消整次验证；timeoutMs 仅供内部调用限制全程时长。 */
export async function probeMcpServer(server = {}, options = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutMs = Math.min(15_000, Math.max(50, Number(options.timeoutMs ?? (server.timeout || 15) * 1000) || 15_000));
  const timer = setTimeout(() => controller.abort(probeError('timeout')), timeoutMs);
  const onAbort = () => controller.abort(probeError('cancelled'));
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  let transport;
  let result;
  try {
    const redact = metadataRedactor(server);
    transport = server.type === 'http'
      ? createHttpProbe(server, controller.signal, options)
      : createStdioProbe(server, controller.signal);
    const work = async () => {
      let nextId = 1;
      const request = (method, params) => transport.request({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) });
      const initialized = await request('initialize', {
        protocolVersion: PROBE_VERSIONS[0],
        capabilities: {},
        clientInfo: { name: 'pi-bot', version: '1.0' },
      });
      validateInitialize(initialized);
      transport.setVersion(initialized.protocolVersion);
      await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const tools = [];
      const names = new Set();
      const cursors = new Set();
      let cursor;
      if (initialized.capabilities.tools != null) {
        if (!isRecord(initialized.capabilities.tools)) throw probeError('protocol_error');
        for (let page = 0; ; page++) {
          if (page >= PROBE_LIMITS.pages) throw probeError('response_limit');
          const response = await request('tools/list', cursor ? { cursor } : {});
          if (!Array.isArray(response.tools)) throw probeError('protocol_error');
          if (tools.length + response.tools.length > PROBE_LIMITS.tools) throw probeError('response_limit');
          for (const tool of response.tools) {
            const summary = toolSummary(tool, redact);
            if (names.has(summary.name)) throw probeError('protocol_error');
            names.add(summary.name);
            tools.push(summary);
          }
          const next = response.nextCursor;
          if (next == null) break;
          if (typeof next !== 'string' || !next || next.length > 2000 || cursors.has(next)) throw probeError('pagination');
          cursors.add(next);
          cursor = next;
        }
      }
      return { tools, protocolVersion: initialized.protocolVersion };
    };
    const aborted = new Promise((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const discovered = await Promise.race([work(), aborted]);
    result = {
      ok: true, state: 'ready', via: server.type === 'http' ? 'http' : 'stdio',
      tools: discovered.tools, toolCount: discovered.tools.length,
      protocolVersion: discovered.protocolVersion,
      detail: `MCP 初始化及工具发现完成（${discovered.tools.length} 个工具）`,
    };
  } catch (error) {
    const safe = controller.signal.aborted ? controller.signal.reason
      : error instanceof McpProbeError ? error : probeError('network');
    result = {
      ok: false, state: safe.code === 'auth_required' ? 'auth_required' : 'error',
      errorCode: safe.code, error: safe.message, tools: [], toolCount: 0,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    await transport?.close().catch(() => {});
  }
  return { ...result, ms: Date.now() - startedAt, checkedAt: Date.now() };
}
