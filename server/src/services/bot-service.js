/**
 * Bot 与部门/会话管理领域服务（SDK / HTTP / Agent 工具共用）。
 *
 * 复用统一模型校验、开发角色工程基线挂载、开场招呼与会话失效策略，
 * 不再让 HTTP 路由与 Bot 工具各自维护不一致的分支。
 */
import { modelGroups as defaultModelGroups } from '../model-groups.js';
import { capacityError } from '../model-capacity.js';
import { resolveBotModelSelection } from '../model-dispatch.js';
import { checkAssignableModel } from '../coordination/department-spec.js';
import { CODING_BASELINE_HOWTO, CODING_BASELINE_TITLE, isCodingRole } from '../coding-baseline.js';
import { shells as defaultShells } from '../shells.js';

export function normalizeAvatarShape(raw) {
  if (raw === -1 || raw === null) return null;
  if (Number.isInteger(raw)) return Math.max(0, Math.min(15, raw));
  return undefined;
}

export function createBotService({
  store,
  runner = null,
  modelGroups = defaultModelGroups,
  shells = defaultShells,
}) {
  const bots = {
    list() {
      return store.listBots();
    },

    get(id) {
      return store.getBot(id);
    },

    main() {
      return store.mainBot();
    },

    create(input = {}, {
      uniqueName = false,
      autoBaseline = false,
      validateModel = false,
      greet = true,
      createdBy = null,
      health = runner?.health ?? null,
    } = {}) {
      if (!input?.name) {
        return { ok: false, status: 400, code: 'NAME_REQUIRED', error: '需要 name' };
      }
      if (uniqueName) {
        const existing = store.listBots().find((b) => b.name === input.name);
        if (existing) {
          return {
            ok: false,
            status: 409,
            code: 'BOT_DUPLICATE',
            error: `已经有一个叫「${input.name}」的了（id=${existing.id}）。`,
            botId: existing.id,
          };
        }
      }

      const next = { ...input };
      if (Object.hasOwn(next, 'avatarShape')) {
        const normalized = normalizeAvatarShape(next.avatarShape);
        if (normalized === undefined) delete next.avatarShape;
        else next.avatarShape = normalized;
      }

      if (validateModel && runner) {
        const check = checkAssignableModel({ runner, slug: next.model, health });
        if (!check.ok) {
          return {
            ok: false,
            status: 400,
            code: 'MODEL_INVALID',
            error: `模型「${next.model}」不可用`,
            suggestions: check.suggestions ?? [],
          };
        }
        next.model = check.resolved ?? null;
      }

      let coding = false;
      if (autoBaseline) {
        const skills = [...(next.skills ?? [])];
        coding = isCodingRole({
          name: next.name,
          persona: next.persona ?? '',
          tagline: next.tagline ?? '',
        });
        if (coding && !skills.some((k) => k?.title === CODING_BASELINE_TITLE)) {
          skills.unshift({ title: CODING_BASELINE_TITLE, howto: CODING_BASELINE_HOWTO });
        }
        next.skills = skills;
      }

      if (createdBy !== null && next.createdBy === undefined) next.createdBy = createdBy;
      const bot = store.createBot(next);
      if (greet && typeof runner?.greetDm === 'function') {
        const dm = store.findDm(bot.id);
        if (dm) void runner.greetDm(dm.id, bot.id).catch(() => {});
      }
      return { ok: true, bot, coding };
    },

    update(id, patch = {}, {
      checkModel = 'none', // 'none' | 'resolve' | 'assignable'
      checkCapacity = false,
      verifyMcp = false,
      resetOnModelChange = false,
      health = runner?.health ?? null,
    } = {}) {
      const previous = store.getBot(id);
      if (!previous) {
        return { ok: false, status: 404, code: 'BOT_NOT_FOUND', error: 'bot 不存在' };
      }

      const nextPatch = { ...patch };
      if (Object.hasOwn(nextPatch, 'avatarShape')) {
        const normalized = normalizeAvatarShape(nextPatch.avatarShape);
        if (normalized === undefined) delete nextPatch.avatarShape;
        else nextPatch.avatarShape = normalized;
      }

      let selectedModel = null;
      let modelWarning = null;
      if (checkModel === 'resolve' && Object.hasOwn(nextPatch, 'model')) {
        const checked = resolveBotModelSelection(nextPatch.model, {
          entries: modelGroups.menuEntries(),
          groups: modelGroups.list(),
          availableModels: runner?.availableModels ?? [],
          resolveModel: (slug) => runner?.resolveModel?.(slug),
        });
        if (checked.error) return { ok: false, status: 400, code: 'MODEL_INVALID', error: checked.error };
        nextPatch.model = checked.model;
        selectedModel = checked.resolved ?? runner?.model;
      } else if (checkModel === 'assignable' && nextPatch.model !== undefined && nextPatch.model !== '') {
        if (runner) {
          const check = checkAssignableModel({ runner, slug: nextPatch.model, health });
          if (!check.ok) {
            return {
              ok: false,
              status: 400,
              code: 'MODEL_INVALID',
              error: `模型「${nextPatch.model}」不可用`,
              suggestions: check.suggestions ?? [],
            };
          }
          nextPatch.model = check.resolved;
          if (check.warning) modelWarning = check.warning;
        }
      }

      if (checkCapacity) {
        const model = Object.hasOwn(nextPatch, 'model')
          ? selectedModel ?? {}
          : runner?.resolveModel?.(previous.model) ?? runner?.model ?? {};
        const problem = capacityError({ ...previous, ...nextPatch }, model, { allowNull: true });
        if (problem) return { ok: false, status: 400, code: 'CAPACITY_INVALID', error: problem };
      }

      if (verifyMcp && Array.isArray(nextPatch.mcpServers) && nextPatch.mcpServers.length) {
        const known = new Map(store.mcpLibrary().map((s) => [s.name.toLowerCase(), s]));
        const missing = nextPatch.mcpServers.filter((n) => !known.has(String(n).toLowerCase()));
        if (missing.length) {
          return { ok: false, status: 400, code: 'MCP_MISSING', error: `没有这些 MCP 服务：${missing.join('、')}` };
        }
        const disabled = nextPatch.mcpServers.filter(
          (n) => known.get(String(n).toLowerCase())?.enabled !== true,
        );
        if (disabled.length) {
          return {
            ok: false,
            status: 400,
            code: 'MCP_DISABLED',
            error: `${disabled.join('、')} 还没启用（在设置里打开开关才行）—— 没启用的服务不会真的去连，配上去也没用。`,
          };
        }
      }

      const bot = store.updateBot(id, nextPatch);
      if (!bot) return { ok: false, status: 404, code: 'BOT_NOT_FOUND', error: 'bot 不存在' };

      if (resetOnModelChange && (nextPatch.model !== undefined || nextPatch.thinking !== undefined)) {
        runner?.resetSessionForBot?.(bot.id);
      } else if (
        ['model', 'thinking', 'contextWindow', 'maxTokens', 'reserveTokens', 'keepRecentTokens', 'mcpServers']
          .some((k) => nextPatch[k] !== undefined)
      ) {
        runner?.reloadSessionForBot?.(bot.id);
      }
      return { ok: true, bot, warning: modelWarning };
    },

    remove(id) {
      const r = store.deleteBot(id);
      if (!r) return { ok: false, status: 400, code: 'CANNOT_DELETE_MAIN_BOT', error: '删不了（不存在或它是主控）' };
      return { ok: true, ...r };
    },
  };

  const rooms = {
    list() {
      return store.listRooms().map((r) => store.roomSummary(r));
    },

    get(id) {
      return store.getRoom(id);
    },

    ensureDm(botId, { greet = true } = {}) {
      const room = store.ensureDm(botId);
      if (!room) return { ok: false, status: 404, code: 'BOT_NOT_FOUND', error: 'bot 不存在' };
      if (greet && typeof runner?.greetDm === 'function') {
        void runner.greetDm(room.id, botId).catch(() => {});
      }
      return { ok: true, room: store.roomSummary(room), rawRoom: room };
    },

    createGroup(input = {}) {
      const room = store.createGroup(input);
      return { ok: true, room: store.roomSummary(room), rawRoom: room };
    },

    createDepartment(input = {}) {
      const res = store.createDepartment(input);
      return { ok: true, ...res, summary: store.roomSummary(res.room) };
    },

    update(id, patch = {}) {
      const room = store.updateRoom(id, patch);
      if (!room) return { ok: false, status: 404, code: 'ROOM_NOT_FOUND', error: '会话不存在' };
      return { ok: true, room: store.roomSummary(room), rawRoom: room };
    },

    remove(id, { killShells = true } = {}) {
      if (killShells) shells?.killRoom?.(id);
      const r = store.deleteRoom(id);
      if (!r) return { ok: false, status: 400, code: 'CANNOT_DELETE_DM', error: '删不了（不存在或是 DM）' };
      return { ok: true, ...r };
    },

    groupLimits() {
      return store.groupLimits();
    },

    updateGroupLimits(patch = {}) {
      const limits = store.updateGroupLimits(patch);
      return { ok: true, limits };
    },

    saveTemplateFromRoom(roomId, opts = {}) {
      const r = store.saveTemplateFromRoom(roomId, opts);
      if (r.error) return { ok: false, status: 400, code: 'TEMPLATE_INVALID', error: r.error };
      return { ok: true, template: r.template };
    },
  };

  return { bots, rooms };
}
