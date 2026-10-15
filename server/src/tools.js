/**
 * bot 的工具集。
 *
 * 组织架构：
 *   主控（role=main）= 总经理 —— 直接对用户负责，可以往任何部门下达任务
 *   群（group）      = 部门 —— 有部门老大（leadBotId），老大接单、拆活、@ 成员
 *   成员（member）   = 部门员工 —— 只做被派到的事，能 @ 同事协作
 *
 * 工具分两层：
 *   buildCommonTools —— 所有 bot 都有（读文件、发文件、看花名册、看部门、私信同事）
 *   buildChiefTools  —— 只有总经理有（造人、建部门、指定老大、下达任务）
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import path from 'node:path';
import { config } from './config.js';
import { store } from './store.js';
import { menuText, resolveMenu, MODEL_MENU } from './model-menu.js';
import { extractText } from './extract.js';
import { log } from './util.js';

const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'];

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const fail = (text, details = {}) => ({ content: [{ type: 'text', text }], details, isError: true });

/** 相对工作目录解析路径，越界就拒绝 */
function insideWorkspace(input) {
  const full = path.resolve(config.workspace, String(input ?? ''));
  const rel = path.relative(config.workspace, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

/** 模型白名单：只能选 kimi k3 / glm 5.3 / deepseek v4.1 flash 这一小撮 */
function checkModel(runner, slug, health) {
  if (!slug) return { ok: true };
  const picked = resolveMenu(slug, health);
  if (!picked) {
    return { ok: false, suggestions: ['只能从白名单里选：', ...menuText(health).split('\n')] };
  }
  if (!picked.alive) {
    return { ok: false, suggestions: [`${picked.entry.alias} 当前的线路实测不可用（${picked.slug}）`] };
  }
  if (!runner.resolveModel(picked.slug)) {
    return { ok: false, suggestions: [`${picked.slug} 在本机 models.json 里不存在`] };
  }
  return { ok: true, resolved: picked.slug };
}

function modelError(slug, suggestions) {
  return fail(
    `模型「${slug}」不可用，什么都没做。\n${suggestions.length ? suggestions.join('\n') : '（先用 list_models 看看）'}`,
    { invalidModel: slug },
  );
}

function botLine(bot) {
  const depts = store
    .listRooms()
    .filter((r) => r.kind === 'group' && r.botIds.includes(bot.id))
    .map((r) => `${r.name}${r.leadBotId === bot.id ? '(老大)' : ''}`);
  const tags = [
    bot.role === 'main' ? '总经理' : '成员',
    bot.model ?? '默认模型',
    `thinking ${bot.thinking}`,
    depts.length ? `部门：${depts.join('、')}` : '',
  ].filter(Boolean);
  const duty = String(bot.persona ?? '').split('\n').find((l) => l.trim())?.slice(0, 60) ?? '';
  return `${bot.id}  ${bot.emoji ?? ''}${bot.name}  [${tags.join(' / ')}]${duty ? `  ${duty}` : ''}`;
}

function deptLine(room) {
  const names = room.botIds.map((id) => {
    const b = store.getBot(id);
    return b ? `${b.emoji ?? ''}${b.name}${id === room.leadBotId ? '(老大)' : ''}` : id;
  });
  return `${room.id}  ${room.name}${room.topic ? ` —— ${room.topic}` : ''}\n    成员：${names.join('、') || '（空）'}`;
}

// ---------------------------------------------------------------------------
// 所有 bot 都能用
// ---------------------------------------------------------------------------

export function buildCommonTools({ runner, roomId, botId }) {
  return [
    defineTool({
      name: 'list_bots',
      label: '看花名册',
      description:
        '列出所有 bot（名字、职责、所在部门、谁是老大、用的什么模型）。想知道有哪些同事、该找谁协作时用它。',
      parameters: Type.Object({}),
      execute: async () => {
        const bots = store.listBots();
        return ok(bots.map(botLine).join('\n'), { count: bots.length });
      },
    }),

    defineTool({
      name: 'list_departments',
      label: '看部门',
      description: '列出所有部门（群）：谁在里面、谁是部门老大、这个部门负责什么。',
      parameters: Type.Object({}),
      execute: async () => {
        const groups = store.listRooms().filter((r) => r.kind === 'group');
        if (!groups.length) return ok('还没有部门');
        return ok(groups.map(deptLine).join('\n\n'));
      },
    }),

    defineTool({
      name: 'read_department',
      label: '看部门聊天记录',
      description: '读某个部门（群）最近的消息，了解他们在做什么、进展到哪了。',
      parameters: Type.Object({
        groupId: Type.String({ description: '部门 id；传 "here" 表示当前所在部门' }),
        limit: Type.Optional(Type.Number({ description: '读最近多少条，默认 30' })),
      }),
      execute: async (_toolCallId, { groupId, limit }) => {
        const target = groupId === 'here' ? roomId : groupId;
        const room = store.getRoom(target);
        if (!room) return fail(`找不到部门 ${groupId}`);
        const msgs = store.listMessages(room.id, { limit: Math.min(limit ?? 30, 80) });
        if (!msgs.length) return ok(`「${room.name}」还没有消息`);
        const lines = msgs.map((m) => {
          const who = m.authorType === 'user' ? '用户' : m.authorName;
          const body = (m.text ?? '').trim();
          return `${who}: ${body.length > 700 ? `${body.slice(0, 700)}…` : body}`;
        });
        return ok(`「${room.name}」最近 ${msgs.length} 条：\n${lines.join('\n')}`);
      },
    }),

    defineTool({
      name: 'message_bot',
      label: '私信某个 bot',
      description:
        '直接给某个 bot 发一条私信，让它独立干一件事并把结果回给你。\n' +
        '★ 在部门里派活请**直接用 @名字**（用户要看得到谁领了什么活），不要用这个。\n' +
        '这个工具只用于：跨部门找人、或者确实不该让用户看到的内部确认。',
      parameters: Type.Object({
        botId: Type.String({ description: '对方的 bot id（先 list_bots）' }),
        task: Type.String({ description: '完整、自包含的任务描述。对方看不到你的上下文，必须写全' }),
        timeoutMs: Type.Optional(Type.Number({ description: '超时毫秒，默认 300000' })),
      }),
      execute: async (_toolCallId, params) => {
        const target = store.getBot(params.botId);
        if (!target) return fail(`找不到 bot ${params.botId}`);
        if (target.id === botId) return fail('不能给自己发私信');
        const dm = store.ensureDm(target.id);
        if (!dm) return fail('开不了私信会话');
        const result = await runner.runBotOnce({
          roomId: dm.id,
          botId: target.id,
          prompt: params.task,
          timeoutMs: params.timeoutMs ?? 300_000,
          meta: { via: 'message_bot', from: botId },
        });
        if (!result.ok) return fail(`${target.name} 没跑成：${result.error}`);
        return ok(`【${target.name} 的回复】\n${result.text}`, { botId: target.id, ms: result.ms });
      },
    }),

    defineTool({
      name: 'extract_file',
      label: '读文件正文',
      description:
        '读取文件正文并转成文本。支持 pdf / xlsx / xls / docx / csv / tsv / html / md / txt / json / yaml / 代码文件。' +
        '扫描件 PDF 和老的 .doc 提取不出来。用户发的附件在 _inbox/ 目录下。',
      parameters: Type.Object({
        path: Type.String({ description: '相对工作目录的路径，如 _inbox/abc123_报表.xlsx' }),
        maxChars: Type.Optional(Type.Number({ description: '最多返回多少字，默认 12 万' })),
      }),
      execute: async (_toolCallId, { path: inputPath, maxChars }) => {
        const full = insideWorkspace(inputPath);
        if (!full) return fail('只能读工作目录里的文件');
        const result = await extractText(full, maxChars ? { maxChars } : undefined);
        if (!result.ok) return fail(result.error);
        return ok(result.text, { chars: result.chars, ext: result.ext, truncated: result.truncated });
      },
    }),

    defineTool({
      name: 'send_image',
      label: '发文件给用户',
      description:
        '把工作目录里的文件（图片、图表、导出的表格等）直接发给用户，会作为一条带附件的消息出现。' +
        '画完图/导出表格后用它发出来，用户才看得到。',
      parameters: Type.Object({
        path: Type.String({ description: '相对工作目录的路径，如 charts/revenue.png' }),
        caption: Type.Optional(Type.String({ description: '配一句话说明' })),
      }),
      execute: async (_toolCallId, { path: inputPath, caption }) => {
        const full = insideWorkspace(inputPath);
        if (!full) return fail('只能发工作目录里的文件');
        try {
          const { meta } = runner.sendImage({ roomId, botId, filePath: full, caption });
          return ok(`已发给用户：${meta.name}（${meta.kind}，${Math.round(meta.size / 1024)}KB）`, {
            attachmentId: meta.id,
          });
        } catch (err) {
          return fail(`发送失败：${err?.message || err}`);
        }
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// 只有总经理（主控）能用
// ---------------------------------------------------------------------------

export function buildChiefTools({ runner, health, roomId }) {
  return [
    defineTool({
      name: 'create_bot',
      label: '招一个人',
      description:
        '创建一个 bot。按任务特点自己决定 model 和 thinking。人设要写具体：负责什么、什么风格、有什么约束。' +
        '只是要一个能干活的专才时用它；要一整个部门用 create_department。',
      parameters: Type.Object({
        name: Type.String({ description: '名字，2-8 个字，一眼看出职责，如「爬虫工程师」「法务顾问」' }),
        persona: Type.String({ description: '人设/职责：干什么、交付物、输出风格、禁忌。越具体干得越准' }),
        emoji: Type.Optional(Type.String({ description: '头像 emoji，如 🕷️ 📊 ⚖️' })),
        model: Type.Optional(Type.String({ description: 'ds-4.1-flash / glm-5.3 / kimi-k3 / glm-5.3-flash' })),
        thinking: Type.Optional(Type.String({ description: THINKING_LEVELS.join(' / ') })),
      }),
      execute: async (_toolCallId, params) => {
        const check = checkModel(runner, params.model, health);
        if (!check.ok) return modelError(params.model, check.suggestions);
        const existing = store.listBots().find((b) => b.name === params.name);
        if (existing) {
          return fail(`已经有一个叫「${params.name}」的了（id=${existing.id}）。用 update_bot 改它，或者换个名字。`, {
            botId: existing.id,
            duplicated: true,
          });
        }
        const bot = store.createBot({
          name: params.name,
          persona: params.persona,
          emoji: params.emoji,
          model: check.resolved ?? null,
          thinking: params.thinking ?? undefined,
          createdBy: 'chief',
        });
        log(`chief 招了：${bot.emoji} ${bot.name} (${bot.model ?? '默认'}/${bot.thinking})`);
        return ok(`已招到 ${bot.emoji} ${bot.name}（id=${bot.id}，模型 ${bot.model ?? '默认'}，thinking ${bot.thinking}）`, {
          botId: bot.id,
        });
      },
    }),

    defineTool({
      name: 'update_bot',
      label: '调整某人',
      description: '改某个 bot 的名字/人设/模型/思考等级/emoji。换了模型会自动重开会话。',
      parameters: Type.Object({
        botId: Type.String(),
        name: Type.Optional(Type.String()),
        persona: Type.Optional(Type.String()),
        emoji: Type.Optional(Type.String()),
        model: Type.Optional(Type.String({ description: '模型；传空字符串表示回到默认' })),
        thinking: Type.Optional(Type.String({ description: THINKING_LEVELS.join(' / ') })),
      }),
      execute: async (_toolCallId, params) => {
        const { botId: target, ...patch } = params;
        if (patch.model !== undefined && patch.model !== '') {
          const check = checkModel(runner, patch.model, health);
          if (!check.ok) return modelError(patch.model, check.suggestions);
          patch.model = check.resolved;
        }
        const bot = store.updateBot(target, patch);
        if (!bot) return fail(`找不到 bot ${target}`);
        if (patch.model !== undefined || patch.thinking !== undefined) runner.resetSessionForBot(bot.id);
        return ok(`已更新 ${bot.emoji ?? ''}${bot.name}（模型 ${bot.model ?? '默认'}，thinking ${bot.thinking}）`);
      },
    }),

    defineTool({
      name: 'delete_bot',
      label: '开掉一个人',
      description: '删除一个成员 bot（总经理删不掉）。',
      parameters: Type.Object({ botId: Type.String() }),
      execute: async (_toolCallId, { botId: target }) => {
        const r = store.deleteBot(target);
        return r ? ok(`已删除 ${target}`) : fail(`删不了：${target} 不存在，或者它是总经理`);
      },
    }),

    defineTool({
      name: 'list_models',
      label: '模型菜单',
      description:
        '可用的模型白名单。只能从这里选：kimi 就是 k3、glm 就是 5.3、deepseek 就是 v4.1 flash，其他不许用。' +
        '★=实测可用。写别名（如 ds-4.1-flash）或完整 slug 都行。一轮只调一次。',
      parameters: Type.Object({}),
      execute: async () =>
        ok(
          '白名单（只能从这里选）：\n' +
            menuText(health) +
            '\n\n选型建议：写代码/改文件/跑命令 → ds-4.1-flash；长文档/方案/写作 → kimi-k3；' +
            '通用中文活 → glm-5.3；简单批量 → glm-5.3-flash。',
          { menu: MODEL_MENU.map((m) => m.alias) },
        ),
    }),

    defineTool({
      name: 'check_models',
      label: '重新探活模型',
      description: '强制重新实测模型可用性（后台跑）。不确定某个模型能不能用时调它。',
      parameters: Type.Object({
        keyword: Type.Optional(Type.String({ description: '只测名字包含这个词的模型' })),
      }),
      execute: async (_toolCallId, { keyword }) => {
        if (!health) return fail('探活模块未启用');
        if (health.running) return ok(`正在探活中（${health.progress.done}/${health.progress.total}）`);
        if (keyword) {
          const kw = keyword.toLowerCase();
          const targets = runner.availableModels
            .map((m) => `${m.provider}/${m.id}`)
            .filter((s) => s.toLowerCase().includes(kw));
          let alive = 0;
          for (const slug of targets) {
            const r = await health.probe(slug);
            if (r.ok) alive++;
          }
          health.save();
          return ok(`测完 ${targets.length} 个，活的 ${alive} 个`);
        }
        health.runAll({ force: true }).catch(() => {});
        return ok('已在后台全量重测，过一会儿再 list_models');
      },
    }),

    defineTool({
      name: 'create_department',
      label: '★ 建一个部门',
      description:
        '★ 用户说「建个团队 / 拉几个人 / 做个多角色协作」时用这个，一次搞定：' +
        '造 N 个人 + 建部门 + 指定部门老大 + 发开工说明。\n' +
        '每个成员都要有独立的名字、emoji、人设，模型和思考等级按分工分别选。\n' +
        '**部门老大（lead）**：用户往部门里发消息时由它先接，负责把活拆开 @ 给成员。' +
        '选最有统筹能力、懂全局的那个人当老大（通常是产品/架构/负责人角色），别选只会闷头写代码的。',
      parameters: Type.Object({
        name: Type.String({ description: '部门名，如「爬虫攻坚组」「A股数据看板开发组」' }),
        topic: Type.Optional(Type.String({ description: '这个部门负责什么' })),
        lead: Type.String({ description: '部门老大的名字，必须是 members 里某一个的 name' }),
        members: Type.Array(
          Type.Object({
            name: Type.String({ description: '成员名字，体现职责，如「后端工程师」「测试工程师」' }),
            persona: Type.String({ description: '该成员的人设：职责范围、交付物、输出风格、禁忌' }),
            emoji: Type.Optional(Type.String({ description: '头像 emoji' })),
            model: Type.Optional(Type.String({ description: '模型，必须照抄 list_models 的输出' })),
            thinking: Type.Optional(Type.String({ description: THINKING_LEVELS.join(' / ') })),
          }),
          { description: '成员列表，建议 3-6 个，每个职责不同' },
        ),
      }),
      execute: async (_toolCallId, params) => {
        const members = params.members ?? [];
        if (!members.length) return fail('至少要有一个成员');
        if (!members.some((m) => m.name === params.lead)) {
          return fail(`lead「${params.lead}」不在 members 里。members 有：${members.map((m) => m.name).join('、')}`);
        }

        // 先校验全部模型，有一个不行就整体不动，避免建出一半
        const bad = [];
        const resolved = [];
        for (const m of members) {
          if (!m.model) {
            resolved.push({ ...m, model: null });
            continue;
          }
          const check = checkModel(runner, m.model, health);
          if (!check.ok) bad.push({ name: m.name, model: m.model, suggestions: check.suggestions });
          else resolved.push({ ...m, model: check.resolved });
        }
        if (bad.length) {
          return fail(
            '有成员选了不可用的模型，什么都没建：\n' +
              bad.map((b) => `  ${b.name} → ${b.model}；${b.suggestions.slice(0, 3).join('、')}`).join('\n'),
          );
        }

        const created = [];
        for (const m of resolved) {
          const dup = store.listBots().find((b) => b.name === m.name);
          if (dup) {
            created.push(dup);
            continue;
          }
          created.push(
            store.createBot({
              name: m.name,
              persona: m.persona,
              emoji: m.emoji,
              model: m.model,
              thinking: m.thinking ?? undefined,
              createdBy: 'chief',
            }),
          );
        }

        const leadBot = created.find((b) => b.name === params.lead);
        const room = store.createGroup({
          name: params.name,
          topic: params.topic,
          botIds: created.map((b) => b.id),
          leadBotId: leadBot?.id,
          createdBy: 'chief',
        });

        const me = store.mainBot();
        store.appendMessage({
          roomId: room.id,
          authorType: 'bot',
          authorId: me?.id ?? 'chief',
          authorName: me?.name ?? 'Pi',
          authorEmoji: me?.emoji ?? 'π',
          text:
            `部门成立：**${room.name}**${params.topic ? `\n职责：${params.topic}` : ''}\n\n` +
            `**部门老大：${leadBot?.emoji ?? ''}${leadBot?.name ?? params.lead}** —— 用户往这里发指令时由它先接、拆活、派给下面的人。\n\n` +
            '成员：\n' +
            created
              .map(
                (b) =>
                  `- ${b.emoji ?? ''} **${b.name}**（${b.model ?? '默认模型'} / thinking ${b.thinking}）` +
                  `${b.id === leadBot?.id ? ' ← 老大' : ''}`,
              )
              .join('\n') +
            '\n\n把任务发进这个群，老大会分给对应的人。',
          status: 'done',
          meta: { via: 'create_department' },
        });

        log(`chief 建部门：${room.name}，老大=${leadBot?.name}，${created.length} 人`);
        return ok(
          `已建部门「${room.name}」(id=${room.id})，老大 **${leadBot?.name}**，成员 ${created.length} 个：\n` +
            created.map((b) => `  ${b.id}  ${b.emoji ?? ''}${b.name}  ${b.model ?? '默认'}/${b.thinking}`).join('\n'),
          { roomId: room.id, leadBotId: leadBot?.id, botIds: created.map((b) => b.id) },
        );
      },
    }),

    defineTool({
      name: 'dispatch_to_department',
      label: '★ 给部门下达任务',
      description:
        '★ 总经理往某个部门下达任务。发出去之后**部门老大会接着接单**，把活拆开 @ 给成员。' +
        '用户让你推进某个部门的事，就用这个。',
      parameters: Type.Object({
        groupId: Type.String({ description: '部门 id（先 list_departments）' }),
        task: Type.String({ description: '要这个部门做什么。写清楚目标和交付物' }),
      }),
      execute: async (_toolCallId, { groupId, task }) => {
        const room = store.getRoom(groupId);
        if (!room || room.kind !== 'group') return fail(`找不到部门 ${groupId}`);
        const lead = store.getBot(room.leadBotId);
        const res = await runner.dispatchToGroup({ roomId: groupId, text: task });
        if (!res.ok) return fail(res.error ?? '下达失败');
        return ok(
          `已向「${room.name}」下达任务，部门老大 ${lead?.emoji ?? ''}${lead?.name ?? '?'} 正在接单拆活。` +
            '（它和成员的产出会直接出现在这个部门里，用户看得到）',
          { roomId: groupId },
        );
      },
    }),

    defineTool({
      name: 'set_department_lead',
      label: '换部门老大',
      description: '把某个部门的负责人换成另一个人（必须是这个部门的成员）。',
      parameters: Type.Object({
        groupId: Type.String(),
        botId: Type.String({ description: '新的部门老大' }),
      }),
      execute: async (_toolCallId, { groupId, botId: newLead }) => {
        const room = store.getRoom(groupId);
        if (!room || room.kind !== 'group') return fail(`找不到部门 ${groupId}`);
        if (!room.botIds.includes(newLead)) return fail(`${newLead} 不在这个部门里`);
        store.updateRoom(groupId, { leadBotId: newLead });
        const bot = store.getBot(newLead);
        return ok(`「${room.name}」的老大换成 ${bot?.emoji ?? ''}${bot?.name ?? newLead} 了`);
      },
    }),

    defineTool({
      name: 'add_to_department',
      label: '调人进部门',
      description: '把某个 bot 调进部门。',
      parameters: Type.Object({ groupId: Type.String(), botId: Type.String() }),
      execute: async (_toolCallId, { groupId, botId: target }) => {
        const room = store.getRoom(groupId);
        if (!room || room.kind !== 'group') return fail(`找不到部门 ${groupId}`);
        const bot = store.getBot(target);
        if (!bot) return fail(`找不到 bot ${target}`);
        if (room.botIds.includes(target)) return ok(`${bot.name} 已经在这个部门了`);
        store.updateRoom(groupId, { botIds: [...room.botIds, target] });
        return ok(`已把 ${bot.emoji ?? ''}${bot.name} 调进「${room.name}」`);
      },
    }),

    defineTool({
      name: 'remove_from_department',
      label: '调人出部门',
      description: '把某个 bot 调出部门。',
      parameters: Type.Object({ groupId: Type.String(), botId: Type.String() }),
      execute: async (_toolCallId, { groupId, botId: target }) => {
        const room = store.getRoom(groupId);
        if (!room || room.kind !== 'group') return fail(`找不到部门 ${groupId}`);
        store.updateRoom(groupId, { botIds: room.botIds.filter((b) => b !== target) });
        return ok(`已把 ${target} 调出「${room.name}」`);
      },
    }),

    defineTool({
      name: 'announce',
      label: '在部门里说一句',
      description:
        '以总经理身份往部门里发一条消息（不会触发部门老大接单）。用于宣布决定、给结论、提醒注意事项。' +
        '要派活请用 dispatch_to_department。',
      parameters: Type.Object({
        groupId: Type.Optional(Type.String({ description: '部门 id；不填就是当前会话' })),
        text: Type.String({ description: '要发的内容，支持 markdown' }),
      }),
      execute: async (_toolCallId, { groupId, text }) => {
        const target = groupId || roomId;
        const room = store.getRoom(target);
        if (!room) return fail(`找不到会话 ${target}`);
        const me = store.mainBot();
        store.appendMessage({
          roomId: target,
          authorType: 'bot',
          authorId: me?.id ?? 'chief',
          authorName: me?.name ?? 'Pi',
          authorEmoji: me?.emoji ?? 'π',
          text,
          status: 'done',
          meta: { via: 'announce' },
        });
        return ok(`已发到「${room.name}」`);
      },
    }),
  ];
}
