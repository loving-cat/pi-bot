/** MCP 服务库的公共投影、运行配置、迁移和原子编辑。 */
import { MCP_LIMITS, mcpRejectReason, normalizeMcpServer } from './mcp.js';
import {
  hasPlainMcpCredentials,
  mergeMcpCredentials,
  openMcpCredentials,
  publicMcpCredentials,
  sealMcpCredentials,
  McpCredentialError,
} from './mcp-credentials.js';

const records = (store) => Array.isArray(store.state.mcpServers) ? store.state.mcpServers : [];

function normalizedRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const safe = { ...record };
  delete safe.env;
  delete safe.headers;
  const normalized = normalizeMcpServer(safe);
  return normalized ? { ...normalized, ...(record.credentialSecret ? { credentialSecret: record.credentialSecret } : {}),
    ...(Array.isArray(record.credentialKeys) ? { credentialKeys: record.credentialKeys } : {}),
    ...(record.env ? { env: record.env } : {}), ...(record.headers ? { headers: record.headers } : {}) } : null;
}

/** 不解密公共列表，密钥不可用时仍允许查看配置摘要。 */
export function mcpLibrary(store) {
  return records(store).map(normalizedRecord).filter(Boolean).map(publicMcpCredentials);
}

export function mcpRuntimeServer(store, id) {
  const raw = records(store).find((item) => item.id === id);
  if (!raw) return null;
  const server = normalizeMcpServer({ ...raw, env: undefined, headers: undefined });
  if (!server) return null;
  const pairs = openMcpCredentials(raw, store.secretsKey);
  if (Object.keys(pairs).length) server[server.type === 'http' ? 'headers' : 'env'] = pairs;
  return server;
}

/** 全部记录准备成功后一次替换，失败不留下部分迁移。 */
export function migrateMcpCredentials(store) {
  const before = records(store);
  let changed = false;
  const after = before.map((item) => {
    if (item?.credentialSecret) openMcpCredentials(item, store.secretsKey);
    if (!hasPlainMcpCredentials(item)) return item;
    const pairs = openMcpCredentials(item, store.secretsKey);
    changed = true;
    return sealMcpCredentials(item, pairs, store.secretsKey);
  });
  if (changed) {
    store.state.mcpServers = after;
    store.scheduleSave();
  }
  return changed;
}

function draft(store, patch, existing) {
  const merged = { ...existing, ...patch, ...(existing ? { id: existing.id } : {}) };
  delete merged.env;
  delete merged.headers;
  const reason = mcpRejectReason(merged);
  if (reason) return { error: reason };
  const server = normalizeMcpServer(merged);
  if (!server) return { error: 'MCP 服务内容不合法' };
  const pairs = mergeMcpCredentials(existing, patch, store.secretsKey, server.type);
  if (Object.keys(pairs).length) server[server.type === 'http' ? 'headers' : 'env'] = pairs;
  return { server, pairs };
}

/** 为连接测试生成临时执行配置，不改动已保存记录。 */
export function mcpProbeDraft(store, raw = {}) {
  const existing = raw.id ? records(store).find((item) => item.id === raw.id) : null;
  if (raw.id && !existing) return { error: '连接不存在' };
  try {
    const result = draft(store, raw, existing);
    return result.error ? result : { server: result.server };
  } catch (err) {
    return { error: safeError(err) };
  }
}

function publish(store, list, emit) {
  store.state.mcpServers = list;
  store.scheduleSave();
  emit({ t: 'mcp.updated', servers: mcpLibrary(store) });
}

function safeError(err) {
  return err instanceof McpCredentialError ? err.message : '连接配置处理失败，原配置未修改。';
}

export function addMcpServer(store, raw, emit) {
  const list = records(store);
  if (list.length >= MCP_LIMITS.total) return { error: `最多保存 ${MCP_LIMITS.total} 个连接` };
  try {
    const result = draft(store, { ...raw, id: undefined, updatedAt: Date.now() }, null);
    if (result.error) return result;
    const { server, pairs } = result;
    if (list.some((item) => item.name.toLowerCase() === server.name.toLowerCase())) return { error: '已经有同名服务' };
    const sealed = sealMcpCredentials(server, pairs, store.secretsKey);
    publish(store, [...list, sealed], emit);
    return { server: publicMcpCredentials(sealed) };
  } catch (err) {
    return { error: safeError(err) };
  }
}

export function updateMcpServer(store, id, patch, emit) {
  const list = records(store);
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return { error: 'MCP 服务不存在' };
  try {
    const result = draft(store, { ...patch, updatedAt: Date.now() }, list[index]);
    if (result.error) return result;
    const { server, pairs } = result;
    if (list.some((item, i) => i !== index && item.name.toLowerCase() === server.name.toLowerCase())) return { error: '已经有同名服务' };
    const sealed = sealMcpCredentials(server, pairs, store.secretsKey, patch.clearCredentials === true ? null : list[index]);
    const next = [...list];
    next[index] = sealed;
    publish(store, next, emit);
    return { server: publicMcpCredentials(sealed) };
  } catch (err) {
    return { error: safeError(err) };
  }
}

export function removeMcpServer(store, id, emit) {
  const list = records(store);
  const next = list.filter((item) => item.id !== id);
  if (next.length === list.length) return { error: 'MCP 服务不存在' };
  publish(store, next, emit);
  return { ok: true };
}
