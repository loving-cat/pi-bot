/**
 * 主控（superroot）专属工具。
 *
 * 这些工具只挂给 role === "main" 的 bot，让它能：
 *   · 造 bot（名字/emoji/人设/模型/思考等级）
 *   · 建群、拉人、指定群里的主答人
 *   · 往群里播报
 *   · ask_bot：真的让另一个 bot 独立跑一轮，并把它的回复发到群里（用户在手机上看得到）
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import path from 'node:path';
import { config } from './config.js';
import { store } from './store.js';
import { menuText, resolveMenu, MODEL_MENU } from './model-menu.js';
import { extractText } from './extract.js';
import { log } from './util.js';

/** 相对工作目录解析路径，越界就拒绝 */
function insideWorkspace(input) {
  const full = path.resolve(config.workspace, String(input ?? ''));
  const rel = path.relative(config.workspace, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

/**
 * 所有 bot 都有的通用工具：读文件正文 + 发文件给用户。
 */
export function buildCommonTools({ runner, roomId, botId }) {
  return [
    defineTool({
      name: 'extract_file',
      label: '读文件正文',
      description:
        '读取文件正文并转成文本。支持 pdf / xlsx / xls / docx / csv / tsv / html / md / txt / json / yaml / 代码文件。' +
        '扫描件 PDF 和老的 .doc 提取不出来。用户发的附件被放在 _inbox/ 目录下。',
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

const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'];

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const fail = (text, details = {}) => ({ content: [{ type: 'text', text }], details, isError: true });

/** 模型白名单：只能选 kimi k3 / glm 5.3 / deepseek v4.1 flash 这一小撮 */
function checkModel(runner, slug, health) {
  if (!slug) return { ok: true };
  const picked = resolveMenu(slug, health);
  if (!picked) {
    return {
      ok: false,
      suggestions: ['只能从白名单里选：', ...menuText(health).split('\n')],
    };
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
    `模型「${slug}」不存在，没动。可用的相近模型：\n${suggestions.length ? suggestions.join('\n') : '（没有相近的，先用 list_models 看看）'}`,
    { invalidModel: slug },
  );
}

function rosterLine(bot) {
  const flags = [bot.role === 'main' ? '主控' : '成员', bot.model ?? '默认模型', `thinking ${bot.thinking}`];
  return `${bot.id}  ${bot.emoji} ${bot.name}  [${flags.join(' / ')}]  人设: ${(bot.persona || '(空)').slice(0, 60).replace(/\n/g, ' ')}`;
}

export function buildChiefTools({ runner, health, roomId }) {
  const modelLine = (m) => {
    const slug = `${m.provider}/${m.id}`;
    const h = health?.get(slug);
    const mark = h ? (h.ok ? '★' : '✗') : '?';
    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : '?';
    const cost = m.cost ? `$${m.cost.input}/$${m.cost.output}` : '';
    return `${mark} ${slug}  ctx=${ctx}  ${cost}`;
  };

  return [
    defineTool({
      name: 'list_bots',
      label: '查看花名册',
      description: '列出所有 bot（含 id、角色、模型、思考等级、人设摘要）。造人之前先看一眼，避免重复造。',
      parameters: Type.Object({}),
      execute: async () => {
        const bots = store.listBots();
        return ok(bots.length ? bots.map(rosterLine).join('\n') : '(还没有成员 bot)', { count: bots.length });
      },
    }),

    defineTool({
      name: 'create_bot',
      label: '造一个 bot',
      description:
        '创建一个专职 bot。按任务特点自己决定 model 和 thinking。人设要写具体：负责什么、什么风格、有什么约束。',
      parameters: Type.Object({
        name: Type.String({ description: 'bot 名字，2-8 个字，能一眼看出职责，如「爬虫工程师」「法务顾问」' }),
        persona: Type.String({ description: '人设/系统提示：职责、工作方式、输出风格、禁忌。写得越具体它干得越准' }),
        emoji: Type.Optional(Type.String({ description: '头像用的一个 emoji，如 🕷️ 📊 ⚖️' })),
        model: Type.Optional(Type.String({ description: '模型：ds-4.1-flash / glm-5.3 / kimi-k3 / glm-5.3-flash 之一，写别名或完整 slug 都行。不填用默认' })),
        thinking: Type.Optional(Type.String({ description: `思考等级：${THINKING_LEVELS.join(' / ')}` })),
      }),
      execute: async (_toolCallId, params) => {
        const check = checkModel(runner, params.model, health);
        if (!check.ok) return modelError(params.model, check.suggestions);
        const existing = store.listBots().find((b) => b.name === params.name);
        if (existing) {
          return fail(`已经有一个叫「${params.name}」的 bot 了（id=${existing.id}）。直接用 update_bot 改它，或者换个名字。`, {
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
        log(`chief 造了 bot：${bot.emoji} ${bot.name} (${bot.model ?? '默认'}/${bot.thinking})`);
        return ok(`已创建 ${bot.emoji} ${bot.name}（id=${bot.id}，模型 ${bot.model ?? '默认'}，thinking ${bot.thinking}）`, {
          botId: bot.id,
        });
      },
    }),

    defineTool({
      name: 'update_bot',
      label: '调整 bot',
      description: '改某个 bot 的名字/人设/模型/思考等级/emoji。换了模型会自动重开会话。',
      parameters: Type.Object({
        botId: Type.String({ description: 'bot id' }),
        name: Type.Optional(Type.String()),
        persona: Type.Optional(Type.String()),
        emoji: Type.Optional(Type.String()),
        model: Type.Optional(Type.String({ description: '模型：ds-4.1-flash / glm-5.3 / kimi-k3 / glm-5.3-flash；传空回到默认' })),
        thinking: Type.Optional(Type.String({ description: THINKING_LEVELS.join(' / ') })),
      }),
      execute: async (_toolCallId, params) => {
        const { botId, ...patch } = params;
        if (patch.model !== undefined && patch.model !== '') {
          const check = checkModel(runner, patch.model, health);
          if (!check.ok) return modelError(patch.model, check.suggestions);
          patch.model = check.resolved;
        }
        const bot = store.updateBot(botId, patch);
        if (!bot) return ok(`找不到 bot ${botId}`);
        if (patch.model !== undefined || patch.thinking !== undefined) {
          runner.resetSessionForBot(botId);
        }
        return ok(`已更新 ${bot.emoji} ${bot.name}（模型 ${bot.model ?? '默认'}，thinking ${bot.thinking}）`);
      },
    }),

    defineTool({
      name: 'delete_bot',
      label: '删掉 bot',
      description: '删除一个成员 bot（主控删不掉）。',
      parameters: Type.Object({ botId: Type.String() }),
      execute: async (_toolCallId, { botId }) => {
        const r = store.deleteBot(botId);
        return r ? ok(`已删除 ${botId}`) : fail(`删不了：${botId} 不存在或是主控`);
      },
    }),

    defineTool({
      name: 'list_models',
      label: '模型菜单',
      description:
        '可用的模型白名单。只能从这里面选：kimi 就是 k3、glm 就是 5.3、deepseek 就是 v4.1 flash，其他都不许用。' +
        '★=实测可用。写别名（如 ds-4.1-flash）或完整 slug 都行。一轮只调一次。',
      parameters: Type.Object({
        showAll: Type.Optional(Type.Boolean({ description: '调试用：把本机所有模型都列出来（正常选型不要用）' })),
      }),
      execute: async (_toolCallId, { showAll }) => {
        if (showAll) {
          const all = runner.availableModels;
          return ok(
            `本机共 ${all.length} 个模型（仅调试，不要用）：\n` +
              all
                .slice(0, 40)
                .map((m) => `${m.provider}/${m.id}`)
                .join('\n'),
          );
        }
        return ok(
          '白名单（只能从这里选）：\n' +
            menuText(health) +
            '\n\n选型建议：写代码/改文件/跑命令 → ds-4.1-flash；' +
            '长文档/方案/写作 → kimi-k3；通用中文活 → glm-5.3；简单批量 → glm-5.3-flash。',
          { menu: MODEL_MENU.map((m) => m.alias) },
        );
      },
    }),

    defineTool({
      name: 'check_models',
      label: '重新探活模型',
      description: '强制重新实测模型可用性（后台跑，需要几十秒到几分钟）。不确定某个模型能不能用时调它。',
      parameters: Type.Object({
        keyword: Type.Optional(Type.String({ description: '只测名字包含这个词的模型' })),
      }),
      execute: async (_toolCallId, { keyword }) => {
        if (!health) return fail('探活模块未启用');
        if (health.running) {
          return ok(`正在探活中（${health.progress.done}/${health.progress.total}），完事再看 list_models`);
        }
        if (keyword) {
          const kw = keyword.toLowerCase();
          const targets = runner.availableModels
            .map((m) => `${m.provider}/${m.id}`)
            .filter((s) => s.toLowerCase().includes(kw));
          let okCount = 0;
          for (const slug of targets) {
            const r = await health.probe(slug);
            if (r.ok) okCount++;
          }
          health.save();
          return ok(`测完 ${targets.length} 个，活的 ${okCount} 个`);
        }
        health.runAll({ force: true }).catch(() => {});
        return ok('已在后台全量重测，过一会儿再 list_models');
      },
    }),

    defineTool({
      name: 'create_team',
      label: '一次建一个团队',
      description:
        '★ 用户说「建个团队/拉几个人/做个多角色协作」时用这个，一次搞定：造 N 个成员 bot + 建群 + 拉人 + 发开工说明。' +
        '每个成员都要有独立的名字、emoji、人设，模型和思考等级按分工分别选。',
      parameters: Type.Object({
        groupName: Type.String({ description: '群名，如「爬虫攻坚组」「德赛西威投研组」' }),
        topic: Type.Optional(Type.String({ description: '这个团队要干嘛' })),
        members: Type.Array(
          Type.Object({
            name: Type.String({ description: '成员名字，体现职责，如「后端工程师」「测试工程师」' }),
            persona: Type.String({ description: '该成员的人设：职责范围、交付物、输出风格、禁忌' }),
            emoji: Type.Optional(Type.String({ description: '头像 emoji' })),
            model: Type.Optional(Type.String({ description: '模型：ds-4.1-flash / glm-5.3 / kimi-k3 / glm-5.3-flash 之一' })),
            thinking: Type.Optional(Type.String({ description: THINKING_LEVELS.join(' / ') })),
          }),
          { description: '成员列表，建议 3-6 个，每个都要职责不同' },
        ),
      }),
      execute: async (_toolCallId, params) => {
        const members = params.members ?? [];
        if (!members.length) return fail('至少要有一个成员');

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
            '有成员选了不存在的模型，什么都没建：\n' +
              bad
                .map((b) => `  ${b.name} → ${b.model}；相近可用：${b.suggestions.slice(0, 5).join('、') || '（无）'}`)
                .join('\n'),
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

        const room = store.createGroup({
          name: params.groupName,
          topic: params.topic,
          botIds: created.map((b) => b.id),
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
            `群建好了：**${room.name}**${params.topic ? `\n主题：${params.topic}` : ''}\n\n` +
            '成员：\n' +
            created.map((b) => `- ${b.emoji} **${b.name}**（${b.model ?? '默认模型'} / thinking ${b.thinking}）`).join('\n') +
            '\n\n把任务发进这个群，我会分给对应的人。',
          status: 'done',
          meta: { via: 'create_team' },
        });

        log(`chief 建团队：${room.name}，${created.length} 个成员`);
        return ok(
          `已建群「${room.name}」(id=${room.id})，成员 ${created.length} 个：\n` +
            created.map((b) => `  ${b.id}  ${b.emoji} ${b.name}  ${b.model ?? '默认'}/${b.thinking}`).join('\n'),
          { roomId: room.id, botIds: created.map((b) => b.id) },
        );
      },
    }),

    defineTool({
      name: 'list_groups',
      label: '查看群',
      description: '列出所有群（含 id、成员、谁负责接话）。',
      parameters: Type.Object({}),
      execute: async () => {
        const groups = store.listRooms().filter((r) => r.kind === 'group');
        if (!groups.length) return ok('还没有群');
        return ok(
          groups
            .map((g) => {
              const names = g.botIds.map((id) => store.getBot(id)?.name ?? id).join('、');
              const lead = store.getBot(g.leadBotId)?.name ?? '无';
              return `${g.id}  ${g.name}  [${names}]  主答: ${lead}${g.topic ? `  主题: ${g.topic}` : ''}`;
            })
            .join('\n'),
        );
      },
    }),

    defineTool({
      name: 'create_group',
      label: '建群',
      description: '建一个新群。把合适的 bot 拉进去；不传 botIds 就只有你和主控。建完可以用 post_to_group 往群里发第一条消息。',
      parameters: Type.Object({
        name: Type.String({ description: '群名，如「爬虫攻坚组」' }),
        topic: Type.Optional(Type.String({ description: '这个群要干嘛' })),
        botIds: Type.Optional(Type.Array(Type.String(), { description: '要拉进来的 bot id 列表' })),
        leadBotId: Type.Optional(Type.String({ description: '群里负责接用户话的 bot id，默认主控' })),
      }),
      execute: async (_toolCallId, params) => {
        const room = store.createGroup({
          name: params.name,
          topic: params.topic,
          botIds: params.botIds ?? [],
          leadBotId: params.leadBotId,
          createdBy: 'chief',
        });
        log(`chief 建群：${room.name} (${room.botIds.length} 成员)`);
        return ok(`已建群「${room.name}」(id=${room.id})，成员 ${room.botIds.length} 个。用户能在手机上看到它。`, {
          roomId: room.id,
        });
      },
    }),

    defineTool({
      name: 'add_bot_to_group',
      label: '拉人进群',
      description: '把 bot 加进群。',
      parameters: Type.Object({ groupId: Type.String(), botId: Type.String() }),
      execute: async (_toolCallId, { groupId, botId }) => {
        const room = store.getRoom(groupId);
        if (!room || room.kind !== 'group') return fail(`找不到群 ${groupId}`);
        if (!store.getBot(botId)) return fail(`找不到 bot ${botId}`);
        if (room.botIds.includes(botId)) return ok(`${botId} 已经在群里了`);
        store.updateRoom(groupId, { botIds: [...room.botIds, botId] });
        return ok(`已把 ${store.getBot(botId).name} 拉进「${room.name}」`);
      },
    }),

    defineTool({
      name: 'remove_bot_from_group',
      label: '移出群',
      description: '把 bot 移出群。',
      parameters: Type.Object({ groupId: Type.String(), botId: Type.String() }),
      execute: async (_toolCallId, { groupId, botId }) => {
        const room = store.getRoom(groupId);
        if (!room || room.kind !== 'group') return fail(`找不到群 ${groupId}`);
        store.updateRoom(groupId, { botIds: room.botIds.filter((b) => b !== botId) });
        return ok(`已把 ${botId} 移出「${room.name}」`);
      },
    }),

    defineTool({
      name: 'post_to_group',
      label: '往群里发消息',
      description:
        '以主控身份往指定群发一条消息，用户会立刻在手机上看到。用于播报进度、给结论、贴清单。不要发无意义的寒暄。',
      parameters: Type.Object({
        groupId: Type.String({ description: '群 id；就是当前会话时可以不填' }),
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
          meta: { via: 'post_to_group' },
        });
        return ok(`已发到「${room.name}」`);
      },
    }),

    defineTool({
      name: 'ask_bot',
      label: '派活给某个 bot',
      description:
        '让指定 bot 独立跑一轮并把它的回复发到群里（用户看得到）。这是你派活的唯一方式——不要替它干活。' +
        '它的回复会作为那个 bot 的消息出现，你随后可以总结。一次可以并行派多个（同一轮里多次调用）。',
      parameters: Type.Object({
        botId: Type.String({ description: '要派给谁（bot id）' }),
        task: Type.String({ description: '完整、自包含的任务描述。对方看不到你的上下文，必须写全' }),
        groupId: Type.Optional(Type.String({ description: '发到哪个群，默认当前会话。不在群里会自动拉进去' })),
        timeoutMs: Type.Optional(Type.Number({ description: '超时毫秒，默认 300000（5 分钟）' })),
      }),
      execute: async (_toolCallId, params) => {
        const targetRoom = params.groupId || roomId;
        const room = store.getRoom(targetRoom);
        if (!room) return fail(`找不到会话 ${targetRoom}`);
        const bot = store.getBot(params.botId);
        if (!bot) return fail(`找不到 bot ${params.botId}`);

        if (room.kind === 'group' && !room.botIds.includes(bot.id)) {
          store.updateRoom(room.id, { botIds: [...room.botIds, bot.id] });
        }
        const result = await runner.runBotOnce({
          roomId: room.id,
          botId: bot.id,
          prompt: params.task,
          timeoutMs: params.timeoutMs ?? 300_000,
          meta: { via: 'ask_bot', from: store.mainBot()?.id ?? 'chief' },
        });
        if (!result.ok) {
          return fail(`${bot.name} 这轮没跑成：${result.error}`, { failed: true });
        }
        return ok(`【${bot.name} 的回复】\n${result.text}`, { botId: bot.id, ms: result.ms });
      },
    }),
  ];
}
