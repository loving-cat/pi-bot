/**
 * 能力库领域服务：全局技能、经验库、MCP 服务库与本机 pi 能力导入（SDK / HTTP / Jarvis 共用）。
 */
import { parseSkillMarkdown } from '../skills.js';
import { scanLocalCapabilities, localSkillToLibrary, localMcpToLibrary } from '../local-capabilities.js';
import { publicMcpCredentials } from '../mcp-credentials.js';

export function createCapabilityService({ store, runner = null }) {
  function findMcp(selector) {
    const clean = String(selector ?? '').trim().toLowerCase();
    if (!clean) return null;
    const all = store.mcpLibrary();
    return all.find((s) => s.id.toLowerCase() === clean)
      ?? all.find((s) => s.name.toLowerCase() === clean)
      ?? null;
  }

  return {
    // ---- Skills ----
    listSkills() {
      return store.skillLibrary();
    },

    addSkill(raw = {}) {
      const r = store.addSkill(raw);
      if (r.error) return { ok: false, status: 400, code: 'SKILL_INVALID', error: r.error };
      return { ok: true, skill: r.skill };
    },

    updateSkill(id, patch = {}) {
      const r = store.updateSkill(id, patch);
      if (r.error) return { ok: false, status: 404, code: 'SKILL_NOT_FOUND', error: r.error };
      return { ok: true, skill: r.skill };
    },

    removeSkill(id) {
      const r = store.removeSkill(id);
      if (r.error) return { ok: false, status: 404, code: 'SKILL_NOT_FOUND', error: r.error };
      return { ok: true };
    },

    importSkillMarkdown(files = []) {
      const list = Array.isArray(files) ? files : [];
      const parsed = [];
      const unparsed = [];
      for (const f of list.slice(0, 100)) {
        const skill = parseSkillMarkdown(f?.text, f?.name);
        if (skill) parsed.push(skill);
        else unparsed.push({ name: String(f?.name ?? ''), reason: '解析不出内容' });
      }
      const r = store.importSkills(parsed);
      return { ok: true, imported: r.imported, skipped: [...r.skipped, ...unparsed] };
    },

    // ---- Lessons ----
    listLessons() {
      return store.lessonLibrary();
    },

    addLesson(raw = {}) {
      const r = store.addLesson(raw);
      if (r.error) return { ok: false, status: 400, code: 'LESSON_INVALID', error: r.error };
      return { ok: true, lesson: r.lesson };
    },

    updateLesson(id, patch = {}) {
      const r = store.updateLesson(id, patch);
      if (r.error) return { ok: false, status: 404, code: 'LESSON_NOT_FOUND', error: r.error };
      return { ok: true, lesson: r.lesson };
    },

    removeLesson(id) {
      const r = store.removeLesson(id);
      if (r.error) return { ok: false, status: 404, code: 'LESSON_NOT_FOUND', error: r.error };
      return { ok: true };
    },

    // ---- MCP Library ----
    listMcp() {
      return store.mcpLibrary();
    },

    findMcp,

    async addMcp(raw = {}, { applyChange = true } = {}) {
      const r = store.addMcpServer(raw);
      if (r.error) return { ok: false, status: 400, code: 'MCP_INVALID', error: r.error };
      if (applyChange) await runner?.applyMcpChange?.();
      return { ok: true, server: r.server };
    },

    async updateMcp(idOrName, patch = {}) {
      const target = findMcp(idOrName);
      const id = target?.id ?? idOrName;
      const r = store.updateMcpServer(id, patch);
      if (r.error) return { ok: false, status: 404, code: 'MCP_NOT_FOUND', error: r.error };
      await runner?.applyMcpChange?.();
      return { ok: true, server: r.server };
    },

    async removeMcp(idOrName) {
      const target = findMcp(idOrName);
      const id = target?.id ?? idOrName;
      const r = store.removeMcpServer(id);
      if (r.error) return { ok: false, status: 404, code: 'MCP_NOT_FOUND', error: r.error };
      await runner?.applyMcpChange?.();
      return { ok: true, id };
    },

    // ---- Local Pi Capabilities Import ----
    scanLocal({ sanitizeMcp = false } = {}) {
      const found = scanLocalCapabilities({
        existingSkills: store.skillLibrary(),
        existingMcp: store.mcpLibrary(),
      });
      if (!sanitizeMcp) return found;
      return { ...found, mcpServers: found.mcpServers.map(publicMcpCredentials) };
    },

    async importLocal({ kind, names = [], all = false, enable = false } = {}) {
      const cleanKind = String(kind ?? '');
      const wanted = new Set(
        (Array.isArray(names) ? names : []).map((n) => String(n).trim().toLowerCase()).filter(Boolean),
      );
      const takeAll = all === true;
      if (!takeAll && !wanted.size) {
        return { ok: false, status: 400, code: 'IMPORT_NOTHING_SELECTED', error: '没选要导入的条目' };
      }

      const found = scanLocalCapabilities({
        existingSkills: store.skillLibrary(),
        existingMcp: store.mcpLibrary(),
      });
      const imported = [];
      const skipped = [];

      if (cleanKind === 'skill') {
        for (const entry of found.skills) {
          if (!takeAll && !wanted.has(String(entry.title ?? '').trim().toLowerCase())) continue;
          if (entry.imported) {
            skipped.push({ title: entry.title, reason: '已经导入过了' });
            continue;
          }
          const sk = localSkillToLibrary(entry);
          if (!sk) {
            skipped.push({ title: entry.title, reason: '内容不合法' });
            continue;
          }
          const r = store.addSkill(sk);
          if (r.error) skipped.push({ title: entry.title, reason: r.error });
          else imported.push(r.skill.title);
        }
        return { ok: true, kind: 'skill', imported, skipped };
      }

      if (cleanKind === 'mcp') {
        const enableOnImport = enable === true;
        for (const entry of found.mcpServers) {
          if (!takeAll && !wanted.has(String(entry.name ?? '').trim().toLowerCase())) continue;
          if (entry.imported) {
            skipped.push({ title: entry.name, reason: '已经导入过了' });
            continue;
          }
          const srv = localMcpToLibrary(entry);
          if (!srv) {
            skipped.push({ title: entry.name, reason: '配置不合法' });
            continue;
          }
          const r = store.addMcpServer(enableOnImport ? { ...srv, enabled: true } : srv);
          if (r.error) skipped.push({ title: entry.name, reason: r.error });
          else imported.push(r.server.name);
        }
        if (imported.length) await runner?.applyMcpChange?.();
        return { ok: true, kind: 'mcp', imported, skipped, enabled: enableOnImport };
      }

      return { ok: false, status: 400, code: 'INVALID_KIND', error: 'kind 只能是 skill 或 mcp' };
    },
  };
}
