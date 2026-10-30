/** MCP 凭据的加密、编辑合并与公共摘要；不读取文件或发起连接。 */
import { decrypt, encrypt, isEncrypted } from './secrets.js';
import { MCP_LIMITS } from './mcp.js';
import crypto from 'node:crypto';

const PRIVATE_FIELDS = ['env', 'headers'];
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SECRET_QUERY = /^(?:access[-_]?token|refresh[-_]?token|token|api[-_]?key|key|secret|password|passwd|authorization|signature|sig)$/i;
const SECRET_ARGUMENT = /^--?(?:access[-_]?token|refresh[-_]?token|token|api[-_]?key|secret|password|passwd|authorization)(?:=|$)/i;

export class McpCredentialError extends Error {
  constructor(message = '连接凭据无法解密，请恢复密钥或重新配置凭据；原配置未修改。') {
    super(message);
    this.name = 'McpCredentialError';
  }
}

function requireKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new McpCredentialError('凭据加密未就绪，请恢复本机密钥后重试；未保存明文。');
  }
}

/** 校验非空凭据键值；空白值表示不更改已有值。 */
export function credentialPairs(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new McpCredentialError('凭据须使用键值配置。');
  const entries = Object.entries(value);
  if (entries.length > MCP_LIMITS.envPairs) throw new McpCredentialError('凭据项数超过限制。');
  const out = {};
  for (const [name, raw] of entries) {
    const validName = field === 'headers' ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
    if (!validName.test(name) || name.length > MCP_LIMITS.envKeyLength || RESERVED_KEYS.has(name)) {
      throw new McpCredentialError('凭据键名无效。');
    }
    if (raw === null || raw === undefined) continue;
    if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new McpCredentialError('凭据值须为文本。');
    const text = String(raw);
    if (!text.trim()) continue;
    if (text.length > MCP_LIMITS.envValueLength || /[\u0000\r\n]/.test(text)) {
      throw new McpCredentialError('凭据值过长或包含换行。');
    }
    out[name] = text;
  }
  return out;
}

function pairField(record) {
  return record?.type === 'http' ? 'headers' : 'env';
}

/** 返回历史明文凭据是否需要迁移。 */
export function hasPlainMcpCredentials(record) {
  return PRIVATE_FIELDS.some((field) => record?.[field] && Object.values(record[field]).some((value) => String(value ?? '').trim()));
}

/** 还原单个服务凭据；密文必须绑定记录 ID 与连接类型。 */
export function openMcpCredentials(record, key) {
  if (record?.credentialSecret) {
    requireKey(key);
    if (!isEncrypted(record.credentialSecret)) throw new McpCredentialError();
    try {
      const payload = JSON.parse(decrypt(record.credentialSecret, key));
      if (payload.id !== record.id || payload.type !== record.type) throw new McpCredentialError();
      return credentialPairs(payload[pairField(record)], pairField(record));
    } catch {
      throw new McpCredentialError();
    }
  }
  if (hasPlainMcpCredentials(record)) requireKey(key);
  return credentialPairs(record?.[pairField(record)], pairField(record));
}

/** 合并当前类型的凭据；清除指令先执行，非空新值随后覆盖同名键。 */
export function mergeMcpCredentials(record, patch, key, type) {
  const oldType = record?.type ?? type;
  const base = patch?.clearCredentials === true || oldType !== type
    ? {}
    : openMcpCredentials(record ?? {}, key);
  const field = type === 'http' ? 'headers' : 'env';
  const updates = credentialPairs(patch?.[field], field);
  for (const [name, value] of Object.entries(updates)) {
    if (field === 'headers') {
      for (const oldName of Object.keys(base)) {
        if (oldName.toLowerCase() === name.toLowerCase()) delete base[oldName];
      }
    }
    base[name] = value;
  }
  if (Object.keys(base).length > MCP_LIMITS.envPairs) throw new McpCredentialError('凭据项数超过限制。');
  return base;
}

/** 生成落盘记录；任何含凭据的写入必须持有有效密钥。 */
export function sealMcpCredentials(record, pairs, key, previous = null) {
  const out = { ...record };
  delete out.env;
  delete out.headers;
  delete out.credentialSecret;
  delete out.credentialKeys;
  delete out.hasCredentials;
  const names = Object.keys(pairs);
  if (names.length) {
    requireKey(key);
    const oldPairs = previous?.credentialSecret && previous.type === record.type
      ? openMcpCredentials(previous, key) : null;
    const unchanged = oldPairs && Object.keys(oldPairs).length === names.length && names.every((name) => oldPairs[name] === pairs[name]);
    out.credentialSecret = unchanged ? previous.credentialSecret
      : encrypt(JSON.stringify({ id: record.id, type: record.type, [pairField(record)]: pairs }), key);
    out.credentialKeys = names;
  }
  return out;
}

/** 隐藏旧配置中放在地址或命令参数里的常见凭据。 */
export function publicMcpTarget(record) {
  const out = { ...record };
  if (typeof out.url === 'string') {
    try {
      const url = new URL(out.url);
      url.username = '';
      url.password = '';
      for (const name of [...url.searchParams.keys()]) {
        if (SECRET_QUERY.test(name)) url.searchParams.set(name, '[已隐藏]');
      }
      out.url = url.href;
    } catch {
      out.url = '';
    }
  }
  if (Array.isArray(out.args)) {
    let hideNext = false;
    out.args = out.args.map((value) => {
      const text = String(value);
      if (hideNext) { hideNext = false; return '[已隐藏]'; }
      if (!SECRET_ARGUMENT.test(text)) return text;
      if (text.includes('=')) return `${text.slice(0, text.indexOf('='))}=[已隐藏]`;
      hideNext = true;
      return text;
    });
  }
  return out;
}

/** 公共列表只返回已保存键名；不返回明文或密文。 */
export function publicMcpCredentials(record) {
  const out = publicMcpTarget(record);
  const names = Array.isArray(record?.credentialKeys)
    ? record.credentialKeys.filter((name) => typeof name === 'string')
    : Object.keys(record?.[pairField(record)] ?? {});
  delete out.env;
  delete out.headers;
  delete out.credentialSecret;
  out.credentialKeys = names;
  out.hasCredentials = Boolean(record?.credentialSecret || names.length);
  const revisionFields = ['id', 'name', 'type', 'description', 'exposure', 'enabled', 'timeout', 'command', 'args', 'cwd', 'url'];
  const revision = Object.fromEntries(revisionFields.map((name) => [name, out[name] ?? null]));
  revision.credentialSecret = record?.credentialSecret ?? null;
  out.configurationRevision = crypto.createHash('sha256').update(JSON.stringify(revision)).digest('hex');
  return out;
}

/** 落盘前阻止历史明文被再次写入。 */
export function assertMcpCredentialsSealed(records) {
  if (Array.isArray(records) && records.some(hasPlainMcpCredentials)) {
    throw new McpCredentialError('连接凭据尚未完成加密迁移，已保留原文件。');
  }
}
