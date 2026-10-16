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
import { bus } from './bus.js';
import { config } from './config.js';
import { store } from './store.js';
import { menuText, resolveMenu, menuEntries } from './model-menu.js';
import { extractText } from './extract.js';
import { webSearch, webFetch } from './web.js';
import { log, now, isBusyError, planDispatchRetry } from './util.js';

/** 同一个 bot 连着私信多个人时，多久以内的引用气泡合并成一个（ms） */
export const REF_MERGE_MS = 180_000;

/**
 * 决定「来源房间里那条引用气泡」该新建还是合并。
 *
 * bot 给同事发私信时，用户只在来源房间看到「我发了」，永远不知道活派给了谁。
 * 所以要在来源房间留一条 kind='ref' 的指针（一个「已发送给 XX」的小浮动条）。
 * 同一个 bot 连着私信好几个人时不该刷屏 → 180s 窗口内合并成一个气泡「已发送给 A 和 B」。
 *
 * 抽成纯函数是为了能单测：合并窗口是时间敏感的，写错了只会表现为「界面偶尔刷屏」，
 * 人工点不出来。
 *
 * @returns {{mode:'merge', refs:Array}|{mode:'append', ref:Object}}
 */
export function planRefBubble({
  last,
  botId,
  targetBotId,
  dmRoomId,
  at = now(),
  nowMs = at,
  count = null,
}) {
  // count = 他俩那个私聊里现在有多少条消息。
  // 界面用它显示「5 条消息往来」—— 用户要的是"进展到哪一步了"，
  // 只显示"已发送给 X"看不出有多少来回。
  const ref = { botId: targetBotId, roomId: dmRoomId, at, count };
  const mergeable =
    Boolean(last) &&
    last.kind === 'ref' &&
    // 只有同一个 bot 自己的气泡能合并；换个 bot 说话就要新开一条
    last.authorId === botId &&
    nowMs - Number(last.createdAt || 0) < REF_MERGE_MS;
  if (!mergeable) return { mode: 'append', ref };
  return {
    mode: 'merge',
    // 去重：同一个同事重复私信不该出现两个同名气泡
    refs: [...(last.refs || []).filter((r) => r.botId !== targetBotId), ref],
  };
}

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
    .map((r) => `${r.name}${r.leadBotId === bot.id ? '(负责)' : ''}`);
  // ★ 末尾 «» 里是内部参数，只给模型自己挑模型用。
  //   以前这些直接裸拼在行里，模型会原样念给用户听（“他用 ctyun/glm-5.3-oc，thinking high”）——
  //   用户要的是个同事，不是一份配置清单。
  const internal = [
    bot.model ?? '默认模型',
    `thinking ${bot.thinking}`,
    depts.length ? `部门：${depts.join('、')}` : '',
  ].filter(Boolean);
  const duty = String(bot.persona ?? '').split('\n').find((l) => l.trim())?.slice(0, 60) ?? '';
  return `${bot.id}  ${bot.emoji ?? ''}${bot.name}${duty ? `  ${duty}` : ''}  «${internal.join(' / ')}»`;
}

function deptLine(room) {
  const names = room.botIds.map((id) => {
    const b = store.getBot(id);
    return b ? `${b.emoji ?? ''}${b.name}` : id;
  });
  return `${room.id}  ${room.name}${room.topic ? ` —— ${room.topic}` : ''}\n    成员：${names.join('、') || '（空）'}\n    «对接人：${store.getBot(room.leadBotId)?.name ?? '（未指定）'}»`;
}

// ---------------------------------------------------------------------------
// 所有 bot 都能用
// ---------------------------------------------------------------------------

export function buildCommonTools({ runner, roomId, botId }) {
  /**
   * 派活真没送出去 → **报给主控**，让主控重新派人。
   *
   * 用户原话："发现不通，就立马反馈给 mainbot，main bot 再去把任务交接给 bot
   * 一次，要重试 3 次至少。"
   *
   * 为什么不能只把失败写进工具返回值：截屏里那个 bot 的结论是
   * "私聊派活这条路也不通 —— 这次我直接自己上"。它会自作主张把活抢过来干
   * （往往是它最不擅长的活）。这条路必须抬到主控那儿。具体怎么抬
   * （写哪条消息、叫醒谁）都在 runner.escalate 里，和"心跳断了"共用一套。
   */
  function reportDispatchFailure({ targetName, task, reason, attempts, why }) {
    return runner.escalate({
      roomId,
      fromBotId: botId,
      reason: `给「${targetName}」的活没送出去：${reason}`,
      task,
      attempts,
      why,
      prefer: 'chief',
    });
  }

  return [
    defineTool({
      name: 'ask_user',
      label: '★ 问用户要个选择',
      description:
        '卡住了、或者后面怎么走取决于用户的口味时，用它弹一张**可点的卡片**给用户，' +
        '而不是在聊天里写一段"您看是 A 还是 B？"——卡片用户能直接点，省得打字。' +
        '**只在真的岔路口用**（方向分歧、要不要花钱、要不要删东西、它给的几个方案' +
        '你判断不了哪个好）。能自己判断的就自己判断，别拿小事去问。' +
        '发完你就先停下，等用户回。',
      parameters: Type.Object({
        question: Type.String({ description: '一句话问清楚要用户决定什么' }),
        options: Type.Array(
          Type.Object({
            label: Type.String({ description: '选项短标题，几个字，点了会原样发给你' }),
            detail: Type.Optional(
              Type.String({ description: '一句话说明这个选项是什么意思/代价' }),
            ),
          }),
          { description: '2-4 个选项' },
        ),
        allowCustom: Type.Optional(
          Type.Boolean({ description: '要不要同时给一个"我自己说"的输入框，默认给' }),
        ),
      }),
      execute: async (_toolCallId, { question, options, allowCustom }) => {
        const opts = (Array.isArray(options) ? options : [])
          .map((o) => ({
            label: String(o?.label ?? '').trim().slice(0, 40),
            detail: String(o?.detail ?? '').trim().slice(0, 200),
          }))
          .filter((o) => o.label)
          .slice(0, 6);
        if (!opts.length) return fail('至少要给一个选项');
        const msg = store.appendMessage({
          roomId,
          authorType: 'bot',
          authorId: botId,
          authorName: store.getBot(botId)?.name ?? '',
          authorEmoji: store.getBot(botId)?.emoji ?? null,
          kind: 'ask',
          text: String(question ?? '').slice(0, 500),
          status: 'done',
          meta: { options: opts, allowCustom: allowCustom !== false },
        });
        bus.emit('event', { t: 'msg.new', msg });
        log(`❓ ${store.getBot(botId)?.name ?? botId} 问用户：${String(question).slice(0, 40)}`);
        return ok(
          '卡片已经发给用户了，等他点/答。' +
            '**这一轮到此为止，不要再自己往下猜** —— 猜错了比等着更贵。',
          { options: opts.map((o) => o.label) },
        );
      },
    }),

    defineTool({
      name: 'web_search',
      label: '上网搜',
      description:
        '上网搜东西。**凡是"可能已经变了"的都该用它**：版本号、库的用法、报错信息、' +
        '某产品现在长什么样、价格、新闻、别人的做法。不要凭记忆答这些 —— 记忆是会过期的。' +
        '搜到想要的之后，用 web_fetch 打开链接看正文。',
      parameters: Type.Object({
        query: Type.String({ description: '搜索词，用关键词不要整句话' }),
        limit: Type.Optional(
          Type.Number({ description: '要几条结果，默认 6，最多 12' }),
        ),
      }),
      execute: async (_toolCallId, { query, limit }) => {
        const n = Math.min(Math.max(Math.round(Number(limit) || 6), 1), 12);
        try {
          const { provider, results } = await webSearch(query, { limit: n });
          const body = results
            .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
            .join('\n\n');
          return ok(
            `搜到 ${results.length} 条（来源：${provider}）：\n\n${body}\n\n` +
              '想看哪条的正文就用 web_fetch 打开它的链接。',
            { count: results.length, provider },
          );
        } catch (err) {
          // ★ 搜不到时最危险的是模型开始编。这里把话说死。
          return fail(
            `没搜成：${err?.message || err}\n` +
              '**不要凭记忆编答案**。要么跟用户说"我这边搜不了"，要么换个关键词再试一次。',
          );
        }
      },
    }),

    defineTool({
      name: 'web_fetch',
      label: '打开网页',
      description:
        '打开一个网址把正文读出来（HTML 会转成文本，太长的会截断）。' +
        '接口返回的 JSON 会原样给你 —— 很多 API 直接返回 JSON，那正是你要的。',
      parameters: Type.Object({
        url: Type.String({ description: '完整网址，http/https 开头' }),
      }),
      execute: async (_toolCallId, { url }) => {
        try {
          const r = await webFetch(url);
          const head = r.title ? `《${r.title}》\n` : '';
          const tail = r.truncated ? '\n\n_（内容太长已截断）_' : '';
          return ok(`${head}${r.url}\n\n${r.text}${tail}`, {
            url: r.url,
            truncated: r.truncated,
            contentType: r.contentType,
          });
        } catch (err) {
          return fail(`打不开：${err?.message || err}`);
        }
      },
    }),

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

        // ★ 排一下队，而不是一碰“正忙”就宣布“这条路不通”。
        //
        //   用户报的原话：“发现不通，就立马反馈给 mainbot，main bot 再去把任务
        //   交接给 bot 一次，要重试 3 次至少。”
        //   以前是立刻失败：三个成员同时在群里干活时，第二个私信直接被打回，
        //   主控看到的就是“私聊派活这条路也不通 —— 这次我直接自己上”。其实
        //   对方只是还在忙。
        let result = null;
        let waitedMs = 0;
        let lastWhy = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          result = await runner.runBotOnce({
            roomId: dm.id,
            botId: target.id,
            prompt: params.task,
            timeoutMs: params.timeoutMs ?? 300_000,
            meta: { via: 'message_bot', from: botId, attempt },
          });
          if (result.ok) break;
          const plan = planDispatchRetry({
            attempt,
            error: result.error,
            waitedMs,
          });
          lastWhy = plan.why;
          if (!plan.retry) break;
          // ★ 不是"睡固定时长再看"，而是**等它真的空下来** ——
          //   它那一轮可能还要跑好几分钟，睡 5 秒醒来当然还是忙。
          const deadline = Date.now() + plan.waitMs;
          log(`${target.name} 还在忙，等它空下来再派（第 ${attempt + 1} 次，最多等 ${Math.round(plan.waitMs / 1000)}s）`);
          while (runner.isBusy(dm.id, target.id) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2000));
          }
          waitedMs += Date.now() - (deadline - plan.waitMs);
        }

        if (!result?.ok) {
          const reason = result?.error || '没跑成';
          // 真没派出去 → 报给主控（而不是让派活的那个 bot 自己上手）。
          // 用户要的就是这个：不通就往上抬，让主控重新派人。
          reportDispatchFailure({
            targetName: target.name,
            task: params.task,
            reason,
            attempts: 3,
            why: lastWhy,
          });          return fail(
            `${target.name} 没跑成：${reason}（已重试 3 次：${lastWhy}）。` +
              '我已经把这件事报给主控了，**你不用自己上手** —— 主控会重新派人。',
          );
        }

        // ★ 在来源房间留一条可点击的引用记录。
        //   没有这一步，用户只看到"我发了"，永远不知道它把活派给了谁、
        //   对方回了什么。在来源房间原地浮一个小气泡最直观。
        if (roomId && roomId !== dm.id) {
          const me = store.getBot(botId);
          const recent = store.listMessages(roomId, { limit: 1 });
          const last = recent[recent.length - 1];
          const plan = planRefBubble({
            last,
            botId,
            targetBotId: target.id,
            dmRoomId: dm.id,
            count: (store.listMessages(dm.id) || []).length,
          });
          if (plan.mode === 'merge') {
            // 同一个 bot 连着私信了好几个 → 合并成一个气泡（"已发送给 A 和 B"）
            store.updateMessage(roomId, last.id, { refs: plan.refs });
          } else {
            store.appendMessage({
              roomId,
              authorType: 'bot',
              authorId: botId,
              authorName: me?.name ?? '',
              authorEmoji: me?.emoji ?? null,
              kind: 'ref',
              refs: [plan.ref],
              text: '',
              status: 'done',
              meta: { via: 'message_bot' },
            });
          }
        }

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
        tagline: Type.String({
          description:
            '给用户看的一句话简介，8-16 字，说清它负责什么（如「接口设计与实现」「需求拆解与验收」）。' +
            '★ 这是直接展示在用户界面上的，不要写成系统提示词那种语气，不要提模型/工具/规则',
        }),
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
          tagline: params.tagline,
          model: check.resolved ?? null,
          thinking: params.thinking ?? undefined,
          createdBy: 'chief',
        });
        log(`chief 招了：${bot.emoji} ${bot.name} (${bot.model ?? '默认'}/${bot.thinking})`);
        return ok(`已招到 ${bot.emoji} ${bot.name}（id=${bot.id}）。«内部：${bot.model ?? '默认'}/${bot.thinking}，不要写进给用户看的话»`, {
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
        tagline: Type.Optional(Type.String()),
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
        return ok(`已更新 ${bot.emoji ?? ''}${bot.name}。«内部：${bot.model ?? '默认'}/${bot.thinking}»`);
      },
    }),

    defineTool({
      name: 'set_context_budget',
      label: '调同事的上下文预算',
      description:
        '给某个 bot 调上下文预算（能装多少、单次最多输出多少、什么时候压缩）。' +
        '**默认不用调** —— 只有明显超出常规的活才动它：要读一大批文件、长链路排查、' +
        '上百轮工具调用、或者要它一次写很长的东西。调完在给用户的话里说一句"我把它的' +
        '上下文调大了"，别报数字。',
      parameters: Type.Object({
        botId: Type.String({ description: '给谁调（先 list_bots）' }),
        contextWindow: Type.Optional(
          Type.Number({ description: '上下文窗口，比如 1000000。留空不改' }),
        ),
        maxTokens: Type.Optional(
          Type.Number({ description: '单次回复最多输出多少 token，比如 161000。留空不改' }),
        ),
        reserveTokens: Type.Optional(
          Type.Number({ description: '留给回复的余量，越大越早触发压缩。留空不改' }),
        ),
        keepRecentTokens: Type.Optional(
          Type.Number({ description: '压缩时保留最近多少 token 不总结。留空不改' }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const target = store.getBot(params.botId);
        if (!target) return fail(`找不到 bot ${params.botId}`);
        const patch = {};
        for (const k of ['contextWindow', 'maxTokens', 'reserveTokens', 'keepRecentTokens']) {
          if (params[k] !== undefined) patch[k] = params[k];
        }
        if (Object.keys(patch).length === 0) return fail('至少要给一个数值');
        const bot = store.updateBot(params.botId, patch);
        // ★ 预算是在建会话时套上去的，所以必须重建 —— 但用 reload 而不是 reset：
        //   reset 会清掉会话文件（等于让它失忆），调预算不该有那个副作用。
        runner.reloadSessionForBot(bot.id);
        const shown = Object.entries(patch)
          .map(([k, v]) => `${k}=${v}`)
          .join('、');
        log(`chief 调了 ${bot.name} 的预算：${shown}`);
        return ok(
          `已调好 ${bot.emoji ?? ''}${bot.name} 的上下文预算（${shown}），会话已按新预算重建、对话历史保留。` +
            '«内部：这些数值不用写给用户看，说一句"我把它调大了"就够»',
          { botId: bot.id, patch },
        );
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
        '可用模型来自用户自己配的模型组（App 的「模型」页里配）。' +
        '只能从这里选，写别名或完整 slug 都行。' +
        '★=实测可用，✗=探活没过（仍可选，但可能报错）。一轮只调一次。',
      parameters: Type.Object({}),
      execute: async () =>
        ok(
          '可选模型（只能从这里选）：\n' +
            menuText(health) +
            '\n\n挑的时候看用途那一列；没把握就用列表第一个。',
          { menu: menuEntries().map((m) => m.alias) },
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
            tagline: Type.String({
              description: '给用户看的一句话简介，8-16 字，说清他负责什么（如「页面与交互实现」）。不要写成系统提示词语气',
            }),
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
              tagline: m.tagline,
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
        // ★ 给用户看的公告：像真人老板拉群那样说话。
        //   不列成员名单、不标谁是老大、不提模型/思考等级 ——
        //   职位（工程师/设计师/负责人）本身已经说明了分工和分量，
        //   挨个点评“谁用什么工具、谁当头”只会显得像在念配置表。
        const announce = [`${room.name} 拉好了。`];
        if (params.topic) announce.push(`我们要做的事：${params.topic}`);
        announce.push(
          `活儿直接发进这个群，先找 ${leadBot?.emoji ?? ''}${leadBot?.name ?? params.lead} 对接。`,
        );
        store.appendMessage({
          roomId: room.id,
          authorType: 'bot',
          authorId: me?.id ?? 'chief',
          authorName: me?.name ?? 'Pi',
          authorEmoji: me?.emoji ?? 'π',
          text: announce.join('\n\n'),
          status: 'done',
          meta: { via: 'create_department' },
        });

        log(`chief 建部门：${room.name}，老大=${leadBot?.name}，${created.length} 人`);
        // 返回值里的模型/思考等级是给模型自己看的，用 «» 框起来并明说是内部参数，
        // 否则它会原样转述给用户。
        return ok(
          `已建部门「${room.name}」(roomId=${room.id})，共 ${created.length} 人。\n` +
            `用户往这个群发消息时，由 ${leadBot?.name} 先接单拆活。\n` +
            '下面 «» 里是内部参数（只给你自己挑模型/派活用，**不要写进给用户看的话**）：\n' +
            created.map((b) => `  ${b.id}  ${b.emoji ?? ''}${b.name}  «${b.model ?? '默认'}/${b.thinking}»`).join('\n'),
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
