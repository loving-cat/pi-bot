/** MCP 探测的消息校验、资源上限和面向用户的固定错误。 */
export const PROBE_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, messages: 1024, tools: 500, pages: 20 });
export const PROBE_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const ERRORS = {
  auth_required: '服务需要有效凭据或重新授权。',
  timeout: '验证超时，请检查服务是否支持 MCP 及网络是否可达。',
  cancelled: '验证已取消。',
  invalid_config: '连接配置不完整或不受支持。',
  network: '无法连接服务，请检查地址、网络及代理设置。',
  unsafe_target: '目标地址不允许访问。',
  redirect: '服务返回了重定向，请填写最终的 MCP 地址。',
  http_error: '服务返回了 HTTP 错误，未完成 MCP 验证。',
  protocol_error: '响应不符合 MCP 协议，未完成验证。',
  unsupported_protocol: '服务使用的 MCP 协议版本暂不支持。',
  rpc_error: '服务拒绝了 MCP 初始化或工具发现请求。',
  server_request: '探测期间不执行服务发起的操作，请检查服务配置。',
  response_limit: '服务响应超出验证上限。',
  pagination: '工具列表分页异常，未完成验证。',
  command_missing: '启动命令不存在，请确认已安装且位于 PATH 中。',
  process_exit: '服务进程提前退出，未完成 MCP 验证。',
};

export class McpProbeError extends Error {
  constructor(code) {
    super(ERRORS[code] ?? ERRORS.protocol_error);
    this.code = code;
  }
}

export function probeError(code) {
  return new McpProbeError(code);
}

export function assertActive(signal) {
  if (signal?.aborted) throw signal.reason instanceof McpProbeError ? signal.reason : probeError('cancelled');
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 校验单条 JSON-RPC 消息；探测不提供任何服务端发起的能力。 */
export function rpcResult(message, id) {
  if (!isRecord(message) || message.jsonrpc !== '2.0') throw probeError('protocol_error');
  if (typeof message.method === 'string') {
    if (Object.hasOwn(message, 'id')) throw probeError('server_request');
    return { notification: true };
  }
  if (message.id !== id) throw probeError('protocol_error');
  if (Object.hasOwn(message, 'error')) throw probeError('rpc_error');
  if (!Object.hasOwn(message, 'result') || !isRecord(message.result)) throw probeError('protocol_error');
  return { result: message.result };
}

export function parseMessage(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw probeError('protocol_error');
  }
}

export function displayText(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}
