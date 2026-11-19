/**
 * 贾维斯（主控）对话式系统管家工具集（Jarvis Steward Tools）。
 *
 * 让主控 Bot 在电脑/手机聊天框里就能直接代用户修改系统配置：
 *   · list_automations / manage_automation     定时任务 CRUD + 立即触发
 *   · manage_user_profile                      用户称呼与行为习惯（偏好）
 *   · manage_department                        部门属性、轮次预算与模板保存
 *   · manage_knowledge                         全局技能库与经验库管理
 *   · import_local_capabilities                扫描并导入本机 ~/.pi/agent 技能与 MCP
 *   · manage_mcp_server                        已登记 MCP 的启停、编辑与删除
 *   · manage_model_group                       API 模型组（Key 加密落盘 + 聊天记录自动打码）、默认模型、快决策路由
 *   · set_policy                               行为策略与桌面输入安全开关
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { normalizePreference, STRENGTH, ORIGIN } from './preferences.js';
import { publicMcpTarget } from './mcp-credentials.js';
import { modelGroups as defaultModelGroups, API_TYPES } from './model-groups.js';
import { createServices } from './services/index.js';

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const fail = (text, details = {}) => ({ content: [{ type: 'text', text }], details, isError: true });

export function buildJarvisTools({
  runner, store, roomId, botId, modelGroups = runner?.modelGroups ?? defaultModelGroups,
}) {
  const services = runner?.services ?? createServices({ store, runner, modelGroups });
  const actorName = () => store.getBot(botId)?.name ?? '主控';

  function recordAudit(action, label, pathStr, level = 'defense') {
    try {
      store.addAdminAction({
        action,
        level,
        label,
        method: 'TOOL',
        path: String(pathStr ?? '').slice(0, 200),
        deviceId: botId,
        deviceName: actorName(),
      });
    } catch { /* 审计失败不阻断管家操作 */ }
  }

  return [
    // ---------------------------------------------------------------- 定时任务
    defineTool({
      name: 'list_automations',
      label: '看定时任务',
      description: '列出已配置的定时任务（id、标题、触发周期/时间、启用状态、所属会话）。',
      parameters: Type.Object({
        roomId: Type.Optional(Type.String({ description: '只看某个会话的定时任务；不填列全部' })),
      }),
      execute: async (_toolCallId, params) => {
        const list = services.automations.list({ roomId: params.roomId || null });
        if (!list.length) return ok('还没有任何定时任务。', { count: 0, automations: [] });
        const lines = list.map((a) => {
          const sched = a.everyMinutes ? `每 ${a.everyMinutes} 分钟` : (a.dailyAt ? `每天 ${a.dailyAt}` : '未排期');
          const roomName = store.getRoom(a.roomId)?.name ?? a.roomId ?? '—';
          return `${a.enabled === false ? '[已停用]' : '[启用中]'} ${a.title}（id=${a.id}｜${sched}｜会话：${roomName}）\n  内容：${String(a.prompt ?? '').slice(0, 120)}`;
        });
        return ok(lines.join('\n'), { count: list.length, automations: list });
      },
    }),

    defineTool({
      name: 'manage_automation',
      label: '管理定时任务',
      description:
        '创建、修改、启停、删除或立即执行一条定时任务。\n' +
        '排期二选一：everyMinutes（至少 5 分钟）或 dailyAt（"HH:MM" 24 小时制）。',
      parameters: Type.Object({
        op: Type.Union([
          Type.Literal('create'),
          Type.Literal('update'),
          Type.Literal('delete'),
          Type.Literal('run_now'),
        ]),
        automationId: Type.Optional(Type.String({ description: 'update / delete / run_now 必填，先 list_automations 看 id' })),
        roomId: Type.Optional(Type.String({ description: '在哪个会话触发；create 时不填默认为当前对话房间' })),
        botId: Type.Optional(Type.String({ description: '指定执行该任务的 botId（可选）' })),
        title: Type.Optional(Type.String({ description: '任务标题（create 必填）' })),
        prompt: Type.Optional(Type.String({ description: '到点要执行什么指令（create 必填）' })),
        everyMinutes: Type.Optional(Type.Number({ description: '每 N 分钟跑一次（至少 5）' })),
        dailyAt: Type.Optional(Type.String({ description: '每天几点几分跑，格式 HH:MM，如 "09:30"' })),
        enabled: Type.Optional(Type.Boolean({ description: '启用或停用' })),
      }),
      execute: async (_toolCallId, params) => {
        const op = params.op;
        if (op === 'create') {
          const res = services.automations.create({
            roomId: params.roomId || roomId,
            title: params.title ?? '',
            prompt: params.prompt ?? '',
            botId: params.botId ?? null,
            everyMinutes: params.everyMinutes ?? null,
            dailyAt: params.dailyAt ?? null,
            enabled: params.enabled !== false,
            createdBy: botId,
          });
          if (!res.ok) return fail(res.error);
          const created = res.automation;
          recordAudit('policy.change', `创建定时任务：${created.title}`, `/automations/${created.id}`, 'data');
          return ok(`已创建定时任务「${created.title}」（id=${created.id}）。`, { automation: created });
        }

        const id = String(params.automationId ?? '').trim();
        if (!id) return fail(`${op} 需要传 automationId`);
        const cur = services.automations.get(id);
        if (!cur) return fail(`找不到定时任务 ${id}`);

        if (op === 'delete') {
          services.automations.remove(id);
          recordAudit('policy.change', `删除定时任务：${cur.title}`, `/automations/${id}`, 'data');
          return ok(`已删除定时任务「${cur.title}」。`, { deleted: true, id });
        }

        if (op === 'run_now') {
          const res = services.automations.runNow(id);
          if (!res.ok) return fail(res.error);
          recordAudit('policy.change', `立即触发定时任务：${cur.title}`, `/automations/${id}/run`, 'probe');
          return ok(`已触发执行定时任务「${cur.title}」。`, { started: true, id });
        }

        const patch = {};
        for (const k of ['title', 'prompt', 'botId', 'enabled', 'everyMinutes', 'dailyAt']) {
          if (params[k] !== undefined) patch[k] = params[k];
        }
        const res = services.automations.update(id, patch);
        if (!res.ok) return fail(res.error);
        recordAudit('policy.change', `修改定时任务：${res.automation.title}`, `/automations/${id}`, 'data');
        return ok(`已更新定时任务「${res.automation.title}」。`, { automation: res.automation });
      },
    }),

    // ---------------------------------------------------------------- 用户称呼与偏好
    defineTool({
      name: 'manage_user_profile',
      label: '管用户称呼与习惯',
      description:
        '查看或修改用户自己的称呼（userName）以及长期强偏好（preferences）。\n' +
        '改完后自动刷新空闲会话，让所有 bot 立刻记住新称呼或新习惯。',
      parameters: Type.Object({
        op: Type.Union([
          Type.Literal('get'),
          Type.Literal('set_name'),
          Type.Literal('add_preference'),
          Type.Literal('retire_preference'),
        ]),
        name: Type.Optional(Type.String({ description: 'set_name 必填：用户希望被怎么称呼' })),
        topic: Type.Optional(Type.String({ description: 'add_preference 必填：英文主题标识，如 reply-style' })),
        text: Type.Optional(Type.String({ description: 'add_preference 必填：具体偏好内容（不超过 160 字）' })),
        strength: Type.Optional(Type.Union([Type.Literal('strong'), Type.Literal('weak')])),
        preferenceId: Type.Optional(Type.String({ description: 'retire_preference 必填' })),
      }),
      execute: async (_toolCallId, params) => {
        if (params.op === 'get') {
          const prefs = store.preferences();
          const active = prefs.filter((p) => p.status === 'active');
          const lines = [`当前用户称呼：${store.userName()}`];
          if (active.length) {
            lines.push('生效中的用户习惯：');
            for (const p of active) {
              lines.push(`- [${p.strength}] ${p.topic}: ${p.text}（id=${p.id}）`);
            }
          } else {
            lines.push('暂无已保存的用户习惯。');
          }
          return ok(lines.join('\n'), { userName: store.userName(), preferences: active });
        }

        if (params.op === 'set_name') {
          const clean = String(params.name ?? '').trim();
          if (!clean) return fail('称呼不能为空');
          const user = store.updateUserName(clean);
          const reloaded = runner?.reloadAllSessions?.() ?? 0;
          recordAudit('policy.change', `修改用户称呼为 ${user.name}`, '/user', 'data');
          return ok(`已把你的称呼改为「${user.name}」，已同步给全部同事。`, { user, reloaded });
        }

        if (params.op === 'add_preference') {
          const norm = normalizePreference({
            topic: params.topic,
            text: params.text,
            strength: params.strength === STRENGTH.weak ? STRENGTH.weak : STRENGTH.strong,
            origin: ORIGIN.explicit,
            scope: 'user',
          });
          if (!norm.ok) return fail(norm.text);
          const res = store.addPreference(norm.preference);
          const reloaded = runner?.reloadAllSessions?.() ?? 0;
          recordAudit('policy.change', `记录用户习惯：${norm.preference.topic}`, '/preferences', 'data');
          return ok(`已记住偏好「${norm.preference.text}」（topic=${norm.preference.topic}）。`, {
            added: res.added,
            superseded: res.superseded,
            reloaded,
          });
        }

        // retire_preference
        const id = String(params.preferenceId ?? '').trim();
        if (!id) return fail('retire_preference 需要传 preferenceId');
        const retired = store.retirePreference(id);
        if (!retired) return fail(`找不到偏好 ${id}`);
        runner?.reloadAllSessions?.();
        recordAudit('policy.change', `移除用户习惯：${retired.topic}`, `/preferences/${id}`, 'data');
        return ok(`已停用偏好「${retired.text}」。`, { retired });
      },
    }),

    // ---------------------------------------------------------------- 部门与预算
    defineTool({
      name: 'manage_department',
      label: '管部门与轮次预算',
      description:
        '改部门名字/主题/置顶/隐藏、解散部门、保存部门模板，或调整全局群聊轮次预算与单轮超时（groupLimits）。',
      parameters: Type.Object({
        op: Type.Union([
          Type.Literal('update'),
          Type.Literal('delete'),
          Type.Literal('set_limits'),
          Type.Literal('save_template'),
        ]),
        groupId: Type.Optional(Type.String({ description: '目标部门/会话 id（update/delete/save_template 用）' })),
        name: Type.Optional(Type.String()),
        topic: Type.Optional(Type.String()),
        leadBotId: Type.Optional(Type.String()),
        pinned: Type.Optional(Type.Boolean()),
        hidden: Type.Optional(Type.Boolean()),
        templateName: Type.Optional(Type.String({ description: 'save_template 时的模板名称' })),
        leadTurns: Type.Optional(Type.Number()),
        memberTurns: Type.Optional(Type.Number()),
        maxRuns: Type.Optional(Type.Number()),
        maxSteps: Type.Optional(Type.Number()),
        turnMaxMs: Type.Optional(Type.Number()),
      }),
      execute: async (_toolCallId, params) => {
        if (params.op === 'set_limits') {
          const patch = {};
          for (const k of ['leadTurns', 'memberTurns', 'maxRuns', 'maxSteps', 'turnMaxMs']) {
            if (params[k] !== undefined) patch[k] = params[k];
          }
          if (!Object.keys(patch).length) return fail('set_limits 至少传一个预算数值');
          const { limits } = services.rooms.updateGroupLimits(patch);
          recordAudit('policy.change', '调整群聊轮次预算', '/group-limits', 'data');
          return ok(
            `已调整群聊预算：负责人 ${limits.leadTurns} 轮、成员 ${limits.memberTurns} 轮、单轮最多 ${limits.maxRuns} 次跑动。`,
            { limits },
          );
        }

        const gid = String(params.groupId ?? '').trim();
        if (!gid) return fail(`${params.op} 需要传 groupId`);
        const room = services.rooms.get(gid);
        if (!room) return fail(`找不到会话/部门 ${gid}`);

        if (params.op === 'save_template') {
          const res = services.rooms.saveTemplateFromRoom(gid, { name: params.templateName || room.name });
          if (!res.ok) return fail(res.error);
          recordAudit('policy.change', `保存部门模板：${res.template.name}`, `/templates/${res.template.id}`, 'data');
          return ok(`已将「${room.name}」存为部门模板「${res.template.name}」。`, { template: res.template });
        }

        if (params.op === 'delete') {
          if (gid === roomId) return fail('不能删除当前正在对话的这个房间');
          const mainDm = store.mainBot() ? store.findDm(store.mainBot().id) : null;
          if (mainDm && gid === mainDm.id) return fail('不能删除主控自己的私聊房间');
          const res = services.rooms.remove(gid, { killShells: false });
          if (!res.ok) return fail(res.error ?? `删除失败：${gid}`);
          recordAudit('file.delete', `删除部门/会话：${room.name}`, `/rooms/${gid}`, 'data');
          return ok(`已删除「${room.name}」。`, { deleted: true, id: gid });
        }

        const patch = {};
        for (const k of ['name', 'topic', 'leadBotId', 'pinned', 'hidden']) {
          if (params[k] !== undefined) patch[k] = params[k];
        }
        const res = services.rooms.update(gid, patch);
        if (!res.ok) return fail(res.error);
        recordAudit('policy.change', `更新会话属性：${res.room.name}`, `/rooms/${gid}`, 'data');
        return ok(`已更新「${res.room.name}」。`, { room: res.room });
      },
    }),

    // ---------------------------------------------------------------- 知识库（技能 + 经验）
    defineTool({
      name: 'manage_knowledge',
      label: '管技能库与经验库',
      description: '修改/删除全局技能（skill），以及查看/增/改/删经验库条目（lesson）。',
      parameters: Type.Object({
        op: Type.Union([
          Type.Literal('update_skill'),
          Type.Literal('delete_skill'),
          Type.Literal('list_lessons'),
          Type.Literal('add_lesson'),
          Type.Literal('update_lesson'),
          Type.Literal('delete_lesson'),
        ]),
        id: Type.Optional(Type.String({ description: '目标 skillId 或 lessonId' })),
        title: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        howto: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        enabled: Type.Optional(Type.Boolean()),
        roomId: Type.Optional(Type.String()),
        dept: Type.Optional(Type.String()),
        cue: Type.Optional(Type.String()),
        lesson: Type.Optional(Type.String()),
        verdict: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        evidence: Type.Optional(Type.Array(Type.Object({
          taskId: Type.Optional(Type.String()),
          msgId: Type.Optional(Type.String()),
          quote: Type.String(),
        }))),
      }),
      execute: async (_toolCallId, params) => {
        const { op, id } = params;
        if (op === 'list_lessons') {
          const all = services.capabilities.listLessons();
          if (!all.length) return ok('经验库还是空的。', { count: 0, lessons: [] });
          const lines = all.map((l) => `- [${l.status}/${l.verdict}] ${l.cue} → ${l.lesson}（id=${l.id}）`);
          return ok(lines.join('\n'), { count: all.length, lessons: all });
        }
        if (op === 'update_skill') {
          if (!id) return fail('update_skill 需要 id');
          const patch = {};
          for (const k of ['title', 'summary', 'howto', 'tags', 'enabled']) {
            if (params[k] !== undefined) patch[k] = params[k];
          }
          const r = services.capabilities.updateSkill(id, patch);
          if (!r.ok) return fail(r.error);
          recordAudit('policy.change', `修改技能：${r.skill.title}`, `/skills/${id}`, 'data');
          return ok(`已更新技能「${r.skill.title}」。`, { skill: r.skill });
        }
        if (op === 'delete_skill') {
          if (!id) return fail('delete_skill 需要 id');
          const r = services.capabilities.removeSkill(id);
          if (!r.ok) return fail(r.error);
          recordAudit('policy.change', `删除技能 ${id}`, `/skills/${id}`, 'data');
          return ok(`已删除技能 ${id}。`, { deleted: true, id });
        }
        if (op === 'add_lesson') {
          const r = services.capabilities.addLesson({
            roomId: params.roomId ?? '',
            dept: params.dept ?? '',
            cue: params.cue ?? '',
            lesson: params.lesson ?? '',
            verdict: params.verdict,
            status: params.status,
            evidence: params.evidence ?? [],
          });
          if (!r.ok) return fail(r.error);
          recordAudit('policy.change', `新增经验：${r.lesson.cue}`, `/lessons/${r.lesson.id}`, 'data');
          return ok(`已加入经验库：「${r.lesson.cue}」（id=${r.lesson.id}）。`, { lesson: r.lesson });
        }
        if (op === 'update_lesson') {
          if (!id) return fail('update_lesson 需要 id');
          const patch = {};
          for (const k of ['roomId', 'dept', 'cue', 'lesson', 'verdict', 'status', 'evidence']) {
            if (params[k] !== undefined) patch[k] = params[k];
          }
          const r = services.capabilities.updateLesson(id, patch);
          if (!r.ok) return fail(r.error);
          recordAudit('policy.change', `更新经验：${r.lesson.cue}`, `/lessons/${id}`, 'data');
          return ok(`已更新经验「${r.lesson.cue}」（状态：${r.lesson.status}）。`, { lesson: r.lesson });
        }
        if (!id) return fail('delete_lesson 需要 id');
        const r = services.capabilities.removeLesson(id);
        if (!r.ok) return fail(r.error);
        recordAudit('policy.change', `删除经验 ${id}`, `/lessons/${id}`, 'data');
        return ok(`已删除经验 ${id}。`, { deleted: true, id });
      },
    }),

    // ---------------------------------------------------------------- 导入本机能力
    defineTool({
      name: 'import_local_capabilities',
      label: '导入本机技能与 MCP',
      description:
        '把用户电脑上本机 pi（~/.pi/agent）已装的技能或 MCP 一键导入 Orbis 库。\n' +
        '传 enable=true 可在导入 MCP 后顺便启用（启用需用户在聊天卡上点一次确认）。',
      parameters: Type.Object({
        kind: Type.Union([Type.Literal('skill'), Type.Literal('mcp')]),
        names: Type.Optional(Type.Array(Type.String(), { description: '要导入的名称列表' })),
        all: Type.Optional(Type.Boolean({ description: '传 true 导入本机全部尚未导入的条目' })),
        enable: Type.Optional(Type.Boolean({ description: '仅 kind=mcp 有效：是否同时启用（默认 false）' })),
      }),
      execute: async (_toolCallId, params) => {
        if (params.all !== true && (!Array.isArray(params.names) || !params.names.some((n) => String(n).trim()))) {
          return fail('请指定要导入的 names，或传 all=true。');
        }
        const res = await services.capabilities.importLocal({
          kind: params.kind,
          names: params.names,
          all: params.all === true,
          enable: params.enable === true,
        });
        if (!res.ok) return fail(res.error);
        const skippedText = res.skipped.length
          ? `；跳过：${res.skipped.map((s) => `${s.title}（${s.reason}）`).join('、')}`
          : '';
        if (res.kind === 'skill') {
          recordAudit('policy.change', `导入本机技能 ${res.imported.length} 项`, '/local-capabilities/import', 'data');
          return ok(
            `已导入技能 ${res.imported.length} 项${res.imported.length ? `（${res.imported.join('、')}）` : ''}${skippedText}`,
            { imported: res.imported, skipped: res.skipped },
          );
        }
        recordAudit('mcp.add', `导入本机 MCP ${res.imported.length} 项`, '/local-capabilities/import', 'defense');
        return ok(
          `已导入 MCP ${res.imported.length} 项${res.imported.length ? `（${res.imported.join('、')}${res.enabled ? '，已启用' : '，未启用'}）` : ''}${skippedText}`,
          { imported: res.imported, skipped: res.skipped },
        );
      },
    }),

    // ---------------------------------------------------------------- MCP 生命周期管理
    defineTool({
      name: 'manage_mcp_server',
      label: '管 MCP 服务',
      description:
        '列出、修改、启用、停用或删除已登记的 MCP 服务。\n' +
        '把原本未启用的 MCP 启用时（op="enable" 或 enabled=true），系统会在聊天里弹一张一次性确认卡，确认后再执行。',
      parameters: Type.Object({
        op: Type.Union([
          Type.Literal('list'),
          Type.Literal('enable'),
          Type.Literal('disable'),
          Type.Literal('update'),
          Type.Literal('delete'),
        ]),
        id: Type.Optional(Type.String({ description: 'MCP 服务 id' })),
        name: Type.Optional(Type.String({ description: 'MCP 服务名（不知道 id 时可传 name）' })),
        type: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        command: Type.Optional(Type.String()),
        args: Type.Optional(Type.Array(Type.String())),
        url: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params) => {
        if (params.op === 'list') {
          const all = services.capabilities.listMcp();
          if (!all.length) return ok('MCP 服务库是空的。', { count: 0, servers: [] });
          const lines = all.map((raw) => {
            const s = publicMcpTarget(raw);
            return `${raw.enabled ? '[启用]' : '[停用]'} ${s.name}（id=${raw.id}｜${s.type}）：${s.command ?? s.url}`;
          });
          return ok(lines.join('\n'), { count: all.length, servers: all });
        }

        const target = services.capabilities.findMcp(params.id || params.name);
        if (!target) return fail(`找不到 MCP 服务：${params.id || params.name || '(空)'}`);

        if (params.op === 'delete') {
          const r = await services.capabilities.removeMcp(target.id);
          if (!r.ok) return fail(r.error);
          recordAudit('mcp.add', `删除 MCP 服务：${target.name}`, `/mcp/${target.id}`, 'defense');
          return ok(`已删除 MCP 服务「${target.name}」。`, { deleted: true, id: target.id });
        }

        const patch = {};
        for (const k of ['name', 'type', 'description', 'command', 'args', 'url']) {
          if (params[k] !== undefined) patch[k] = params[k];
        }
        if (params.op === 'enable') patch.enabled = true;
        else if (params.op === 'disable') patch.enabled = false;
        else if (params.enabled !== undefined) patch.enabled = params.enabled;

        const r = await services.capabilities.updateMcp(target.id, patch);
        if (!r.ok) return fail(r.error);
        recordAudit('mcp.add', `${params.op} MCP 服务：${r.server.name}`, `/mcp/${target.id}`, 'defense');
        return ok(`已更新 MCP 服务「${r.server.name}」（当前${r.server.enabled ? '已启用' : '已停用'}）。`, { server: r.server });
      },
    }),

    // ---------------------------------------------------------------- API 模型组 / 默认模型 / 决策路由
    defineTool({
      name: 'manage_model_group',
      label: '管 API 模型组与路由',
      description:
        '管理模型组（baseUrl + apiKey + models）、测试模型组连通性、切换全局默认模型，或配置快速决策路由（Jev）。\n' +
        '★ 安全约束：API Key 落盘时自动加密，本工具绝不返回明文 Key，且会自动对聊天框中刚出现的明文 Key 原地打码。',
      parameters: Type.Object({
        op: Type.Union([
          Type.Literal('list'),
          Type.Literal('upsert'),
          Type.Literal('delete'),
          Type.Literal('test'),
          Type.Literal('set_default_model'),
          Type.Literal('set_decision_router'),
        ]),
        id: Type.Optional(Type.String({ description: '模型组 id（留空=新建，填 id=更新）' })),
        name: Type.Optional(Type.String({ description: '模型组显示名' })),
        baseUrl: Type.Optional(Type.String({ description: 'API Base URL（须 http:// 或 https:// 开头）' })),
        apiKey: Type.Optional(Type.String({ description: 'API Key（落盘加密且聊天消息自动打码）' })),
        api: Type.Optional(Type.Union(API_TYPES.map((a) => Type.Literal(a)))),
        models: Type.Optional(Type.Array(Type.Union([
          Type.String(),
          Type.Object({
            id: Type.String(),
            name: Type.Optional(Type.String()),
            contextWindow: Type.Optional(Type.Number()),
            maxTokens: Type.Optional(Type.Number()),
            reasoning: Type.Optional(Type.Boolean()),
            thinkingFormat: Type.Optional(Type.String()),
          }),
        ]), { description: '模型 ID 列表或配置对象列表' })),
        endpoints: Type.Optional(Type.Array(Type.Object({
          baseUrl: Type.String(),
          apiKey: Type.Optional(Type.String()),
          label: Type.Optional(Type.String()),
        }))),
        enabled: Type.Optional(Type.Boolean()),
        model: Type.Optional(Type.String({ description: 'set_default_model / test / set_decision_router 用的模型名或 slug' })),
        decisionEnabled: Type.Optional(Type.Boolean({ description: '是否启用快速决策路由 Jev' })),
        decisionMode: Type.Optional(Type.Union([Type.Literal('typesafe'), Type.Literal('custom')])),
      }),
      execute: async (_toolCallId, params) => {
        if (params.op === 'list') {
          const snap = services.models.list();
          const lines = [
            `当前默认模型：${snap.activeDefaultModel ?? snap.defaultModel ?? '(未设置)'}`,
            `模型组（${snap.modelGroups.length} 个）：`,
            ...snap.modelGroups.map((g) => `- ${g.name}（id=${g.id}｜${g.enabled ? '启用' : '停用'}｜key=${g.keyMasked || '无'}）：${g.models.map((m) => m.id).join(', ')}`),
            `快速决策路由（Jev）：${snap.decision.enabled ? '开启' : '关闭'}（mode=${snap.decision.mode}，key=${snap.decision.keyMasked || '无'}）`,
          ];
          return ok(lines.join('\n'), snap);
        }

        if (params.op === 'test') {
          const res = await services.models.testGroup({
            id: params.id,
            baseUrl: params.baseUrl,
            apiKey: params.apiKey,
            api: params.api,
            model: params.model,
          }, { redactRoomId: roomId });
          recordAudit('net.fetch', '测试模型组连通性', '/model-groups/test', 'probe');
          return res.ok
            ? ok(`连通性测试通过（${res.ms ?? 0}ms，检测到 ${res.count ?? 0} 个模型）。`, res)
            : fail(`连通性测试失败：${res.error || res.note || '未知错误'}`, res);
        }

        if (params.op === 'delete') {
          const id = String(params.id ?? '').trim();
          if (!id) return fail('delete 需要传模型组 id');
          const r = await services.models.removeGroup(id, { awaitRefresh: true });
          if (!r.ok) return fail(`删不了 ${id}（不存在，或属于内置保护组）`);
          recordAudit('secret.use', `删除模型组 ${id}`, `/model-groups/${id}`, 'defense');
          return ok(`已删除模型组 ${id}。`, { deleted: true, id });
        }

        if (params.op === 'set_default_model') {
          const r = await services.models.setDefaultModel(params.model ?? '');
          if (!r.ok) return fail(r.error);
          recordAudit('policy.change', `切换全局默认模型：${r.model ?? '(默认)'}`, '/models/default', 'defense');
          return ok(`已把全局默认模型切换为：${r.model ?? '(自动回退默认)'}。`, r);
        }

        if (params.op === 'set_decision_router') {
          const patch = {};
          if (params.decisionEnabled !== undefined) patch.enabled = params.decisionEnabled;
          if (params.decisionMode !== undefined) patch.mode = params.decisionMode;
          if (params.baseUrl !== undefined) patch.baseUrl = params.baseUrl;
          if (params.model !== undefined) patch.model = params.model;
          if (params.apiKey !== undefined) patch.apiKey = params.apiKey;
          const res = services.models.updateDecision(patch, { redactRoomId: roomId });
          recordAudit('policy.change', '更新快速决策路由配置', '/decision', 'defense');
          return ok(`已更新快速决策路由（enabled=${res.decision.enabled}，mode=${res.decision.mode}，key=${res.decision.keyMasked || '无'}）。`, { decision: res.decision });
        }

        const input = {};
        for (const k of ['id', 'name', 'baseUrl', 'apiKey', 'api', 'models', 'endpoints', 'enabled']) {
          if (params[k] !== undefined) input[k] = params[k];
        }
        const res = await services.models.upsertGroup(input, { awaitRefresh: true, redactRoomId: roomId });
        if (!res.ok) return fail(res.error);
        const pub = res.group;
        recordAudit('secret.use', `${params.id ? '更新' : '新建'}模型组：${pub.name}`, `/model-groups/${pub.id}`, 'defense');
        return ok(
          `已保存模型组「${pub.name}」（id=${pub.id}，key=${pub.keyMasked || '无'}，模型 ${pub.models.length} 个` +
            `${res.total !== null ? `，当前总可用模型 ${res.total} 个` : ''}）。`,
          { group: pub, total: res.total },
        );
      },
    }),

    // ---------------------------------------------------------------- 部门规矩与桌面安全开关
    defineTool({
      name: 'set_policy',
      label: '看/改部门规矩与桌面设置',
      description: '查看或修改全局行为策略（dangerous、requireProof、denyCommands、allowCommands）以及桌面交互安全开关。',
      parameters: Type.Object({
        op: Type.Union([Type.Literal('get'), Type.Literal('update')]),
        dangerous: Type.Optional(Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny')])),
        requireProof: Type.Optional(Type.Boolean()),
        denyCommands: Type.Optional(Type.Array(Type.String())),
        allowCommands: Type.Optional(Type.Array(Type.String())),
        trustPhantomInput: Type.Optional(Type.Boolean()),
        awayAfterMs: Type.Optional(Type.Number()),
        allowLocalApproval: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params) => {
        if (params.op === 'get') {
          return ok('当前规矩与桌面设置如 details 所示。', services.policy.get());
        }

        const policyPatch = {};
        for (const k of ['dangerous', 'requireProof', 'denyCommands', 'allowCommands']) {
          if (params[k] !== undefined) policyPatch[k] = params[k];
        }
        const desktopPatch = {};
        for (const k of ['trustPhantomInput', 'awayAfterMs', 'allowLocalApproval']) {
          if (params[k] !== undefined) desktopPatch[k] = params[k];
        }
        if (!Object.keys(policyPatch).length && !Object.keys(desktopPatch).length) {
          return fail('请至少提供一项要修改的 policy 或 desktop 配置。');
        }

        const policyRes = Object.keys(policyPatch).length
          ? services.policy.updatePolicy(policyPatch)
          : { policy: store.policy(), policyChange: null };
        const desktopRes = Object.keys(desktopPatch).length
          ? services.policy.updateDesktopSettings(desktopPatch)
          : { settings: store.desktopSettings() };

        recordAudit('policy.change', '主控调整部门规矩/桌面设置', '/policy', 'defense');
        return ok(
          `已更新：危险动作=${policyRes.policy.dangerous}，交付强求证据=${policyRes.policy.requireProof}` +
            `，桌面合成输入=${desktopRes.settings.trustPhantomInput ? '信任' : '拦截'}。`,
          { policy: policyRes.policy, desktop: desktopRes.settings, change: policyRes.policyChange },
        );
      },
    }),
  ];
}
