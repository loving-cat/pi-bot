/** 应用连接目录、短期验证结果和 Bot 分配；凭据由 MCP 库解析。 */
import { testMcpServer } from './mcp.js';

export const CONNECTION_CATALOG = [
  { id: 'remote_mcp', name: '远程服务', description: '通过服务地址和授权凭据连接应用工具。', category: 'remote', type: 'http', action: 'create' },
  { id: 'local_mcp', name: '本地工具', description: '连接已安装在电脑上的工具，按需启动。', category: 'local', type: 'stdio', action: 'create' },
  { id: 'import_local', name: '本机已配置', description: '导入这台电脑已有的工具配置，导入后单独管理。', category: 'local', action: 'import' },
];
export const VERIFICATION_TTL = 10 * 60 * 1000;

/** 只返回探测协议定义的字段，并移除可能被服务端回显的凭据。 */
export function publicProbeResult(result = {}, config = {}) {
  const secrets = [...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})]
    .flatMap((v) => [String(v), String(v).replace(/^Bearer\s+/i, '')]).filter((v) => v.length >= 3);
  const safe = (value, limit) => {
    let text = String(value ?? '');
    for (const secret of secrets) text = text.split(secret).join('[已隐藏]');
    return text.slice(0, limit);
  };
  const ok = result.ok === true;
  const tools = (Array.isArray(result.tools) ? result.tools : []).slice(0, 500)
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => ({ name: safe(t.name, 160), title: safe(t.title, 160), description: safe(t.description, 600) }));
  return {
    ok, state: ok ? 'ready' : result.state === 'auth_required' ? 'auth_required' : 'error',
    checkedAt: Number(result.checkedAt) || Date.now(),
    ms: Math.max(0, Number(result.ms) || 0), via: safe(result.via, 40),
    detail: safe(result.detail, 250), tools, toolCount: ok ? tools.length : 0,
    ...(!ok ? { errorCode: safe(result.errorCode || 'connection_failed', 60), error: safe(result.error || '连接验证失败，请检查配置。', 300) } : {}),
  };
}

/** 服务端探测结果只证明最近一次可用，配置变更或超过期限后须再次验证。 */
export function createConnections({ store, runner, probe = testMcpServer, now = Date.now, onChange = () => {} }) {
  const verified = new Map();
  const pending = new Map();
  let draftCount = 0;
  const find = (id) => store.mcpLibrary().find((s) => s.id === id);
  const connection = (id) => {
    const server = find(id);
    if (!server) return null;
    const saved = verified.get(id);
    const revision = server.configurationRevision;
    let verification = { state: 'unverified', checkedAt: null, toolCount: 0, tools: [] };
    if (saved) {
      const stale = saved.revision !== revision || now() - saved.result.checkedAt > VERIFICATION_TTL;
      verification = { ...saved.result, ...(stale ? { state: 'stale' } : {}) };
    }
    if (pending.get(id)?.revision === revision) verification = { ...verification, state: 'checking' };
    return {
      ...server, verification,
      assignedBotIds: store.listBots().filter((b) => (b.mcpServers ?? []).some((name) => name.toLowerCase() === server.name.toLowerCase())).map((b) => b.id),
    };
  };
  return {
    connection,
    list() {
      const ids = new Set(store.mcpLibrary().map((s) => s.id));
      for (const id of verified.keys()) if (!ids.has(id)) verified.delete(id);
      return { catalog: CONNECTION_CATALOG, connections: [...ids].map(connection), limits: { maxTotal: 50, verificationTtlMs: VERIFICATION_TTL } };
    },
    async testDraft(raw) {
      if (pending.size + draftCount >= 3) return { ok: false, error: '正在验证其他连接，请稍后再试' };
      const draft = store.mcpProbeDraft(raw);
      if (draft.error) return { ok: false, error: draft.error };
      draftCount++;
      try { return publicProbeResult(await probe(draft.server), draft.server); }
      catch { return { ok: false, error: '无法验证连接，请检查配置。' }; }
      finally { draftCount--; }
    },
    async verify(id) {
      const saved = find(id);
      if (!saved) return { status: 404, error: '连接不存在' };
      if (pending.has(id)) {
        const result = await pending.get(id).promise;
        return { ...result, connection: connection(id) };
      }
      if (pending.size + draftCount >= 3) return { status: 429, error: '正在验证其他连接，请稍后再试' };
      const revision = saved.configurationRevision;
      const entry = { revision, promise: null };
      pending.set(id, entry);
      entry.promise = Promise.resolve().then(async () => {
        let result;
        try {
          const runtime = store.mcpRuntimeServer(id);
          if (!runtime) return { status: 404, error: '连接不存在' };
          result = publicProbeResult(await probe(runtime), runtime);
        } catch {
          result = { ok: false, state: 'error', checkedAt: now(), toolCount: 0, tools: [], error: '无法验证连接，请检查配置和已保存的凭据。', errorCode: 'connection_failed' };
        }
        if (find(id)) verified.set(id, { revision, result });
        return { ...result, connection: connection(id) };
      }).finally(() => { pending.delete(id); onChange(); });
      onChange();
      const result = await entry.promise;
      return { ...result, connection: connection(id) };
    },
    async assign(id, botIds) {
      const server = find(id);
      if (!server) return { status: 404, error: '连接不存在' };
      if (!Array.isArray(botIds) || botIds.length > 200 || botIds.some((id) => typeof id !== 'string' || !store.getBot(id))) {
        return { status: 400, error: '所选 Bot 不存在，请刷新后重试' };
      }
      const wanted = new Set(botIds);
      const name = server.name.toLowerCase();
      const changes = store.listBots().map((bot) => {
        const previous = bot.mcpServers ?? [];
        const next = previous.filter((n) => n.toLowerCase() !== name);
        if (wanted.has(bot.id)) next.push(server.name);
        return { bot, next, changed: JSON.stringify(previous) !== JSON.stringify(next) };
      }).filter((c) => c.changed);
      if (changes.some((c) => c.next.length > 20)) return { status: 400, error: '所选 Bot 的连接已达上限（20 个），请先取消其他分配' };
      for (const { bot, next } of changes) store.updateBot(bot.id, { mcpServers: next });
      for (const { bot } of changes) await runner.reloadSessionForBot?.(bot.id);
      onChange();
      return { connection: connection(id) };
    },
  };
}
