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
import { shells } from './shells.js';
import { verdictForTool, commitStdin, resetStdin } from './shell-policy.js';
import { readonlyBlockReason } from './role-tools.js';
import { log, now, isBusyError, planDispatchRetry } from './util.js';
import { CODING_BASELINE_TITLE, CODING_BASELINE_HOWTO, isCodingRole } from './coding-baseline.js';
import { scanLocalCapabilities } from './local-capabilities.js';
import { siteDrafts, describeDraftForConfirm, draftConfirmOptions } from './site-draft.js';

/** 同一个 bot 连着私信多个人时，多久以内的引用气泡合并成一个（ms） */
export const REF_MERGE_MS = 180_000;

/**
 * 一次派活的任务描述上限（字符）。
 *
 * 超长一律退回，不做截断：截断会静默削掉约束与禁止项，
 * 对方拿着一份不完整的活去干，比直接退回更危险。
 */
export const MAX_TASK_CHARS = 4000;

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

export function buildCommonTools({ runner, roomId, botId, isMain = false }) {
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
    // ★ 主控（mainbot）不给询问卡片。
    //
    //   卡片是给"被派活的人卡住了、要用户拍个板"设计的：
    //   它在私聊里弹一张，用户点一下就能继续。
    //   但主控本来就在跟用户直接对话 —— 有疑问直接说一句就行，
    //   弹卡片等于把一句话拆成"卡片 + 一次点击"，反而更远。
    //   而且主控一轮要推进整件事，停下来等点击会卡住整个流程。
    ...(isMain ? [] : [defineTool({
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
        // 群聊里不弹卡片：任务要往下走，不能停在这里等用户点。
        // 要确认的事写进正文；用户想回会直接在群里说。
        const room = store.getRoom(roomId);
        if (room?.kind === 'group') {
          return fail(
            '群聊里不要用询问卡片（会让整件事停下来等）。' +
              '把需要确认的点写进你这条回复的正文里，然后**继续把能做的部分做完**；' +
              '用户有意见会直接在群里说。',
          );
        }
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
    })]),

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
        task: Type.String({
          description:
            '**工作说明书**，不是转述用户那句：\n' +
            '· 要做的事（做什么 / 查什么）\n' +
            '· **要它交回什么**（交付物越具体越好）\n' +
            '· **验收标准**：一句话说清怎么算做完，比如「跑通 node tests/unit.mjs」\n' +
            '· 所有约束、禁止项、必须取得同意的环节\n' +
            '用户原话只在「措辞本身就是任务的一部分」时才带。\n' +
            `不超过 ${MAX_TASK_CHARS} 字；超了会被**退回**（不截断 —— 截断会让约束悄悄没掉）。`,
        }),
        timeoutMs: Type.Optional(Type.Number({ description: '超时毫秒，默认 300000' })),
      }),
      execute: async (_toolCallId, params) => {
        const target = store.getBot(params.botId);
        if (!target) return fail(`找不到 bot ${params.botId}`);
        if (target.id === botId) return fail('不能给自己发私信');
        // 超长直接退回，不截断：截断会把「约束 / 禁止项 / 要报批」悄悄切掉，
        // 对方拿着缺约束的活去干比不收更危险；宁可让它分两次派。
        if (params.task.length > MAX_TASK_CHARS) {
          return fail(
            `任务描述太长（${params.task.length} 字，上限 ${MAX_TASK_CHARS} 字）。` +
              '请压成一份自包含的工作说明书：做什么、要交回什么、有哪些约束。' +
              '不要靠截断 —— 分两次派也行。',
          );
        }
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

    // ---------------- 长任务：后台进程 ----------------

    defineTool({
      name: 'run_background',
      label: '后台跑命令',
      description:
        '在后台跑一条命令并立刻返回（拿到 id 与 pid），适合要一直开着的东西：' +
        'dev server、watch、长脚本、需要交互输入的程序。\n' +
        '普通一次性的命令请用 bash（它是阻塞的，能直接拿到结果）。\n' +
        '跑起来之后用 read_shell 看输出、write_stdin 送输入、kill_shell 结束。\n' +
        '命令同样受部门规矩约束（被禁的会直接拒绝）。',
      parameters: Type.Object({
        command: Type.String({ description: '要执行的命令（一整行）' }),
        cwd: Type.Optional(Type.String({ description: '工作目录，相对工作区；不填就是工作区根' })),
      }),
      execute: async (_toolCallId, { command, cwd }) => {
        const policy = store.policy();
        const blocked = readonlyBlockReason(policy, 'run_background');
        if (blocked) return fail(blocked);
        const verdict = verdictForTool('run_background', { command }, policy);
        if (verdict && !verdict.allowed) {
          const bot = store.getBot(botId);
          store.addDenial({
            roomId,
            botId,
            botName: bot?.name ?? '',
            command,
            rule: verdict.rule ?? verdict.deniedBy,
            reason: verdict.reason,
          });
          return fail(verdict.message);
        }

        const dir = cwd ? insideWorkspace(cwd) : config.workspace;
        if (!dir) return fail('工作目录必须在工作区里');

        const started = shells.start({ roomId, botId, command, cwd: dir });
        if (started.error) return fail(started.error);

        const first = await shells.read(started.id, { waitMs: 1200 });
        const head = first?.output?.trim()
          ? `首屏输出：\n${first.output.trim().slice(0, 1500)}`
          : '（还没有输出）';
        return ok(
          `已在后台运行：id=${started.id}${started.pid ? ` pid=${started.pid}` : ''}\n` +
            `${head}\n\n` +
            'read_shell 看后续输出（可传 pattern 匹配到就返回）、write_stdin 送输入、kill_shell 结束。',
          { shellId: started.id },
        );
      },
    }),

    defineTool({
      name: 'read_shell',
      label: '看后台输出',
      description:
        '读后台进程的输出。传 since（上次返回的 offset）就只看新增部分；' +
        '传 pattern 时，等待期间命中就提前返回（适合等"启动完成 / 出现错误"）。\n' +
        '返回里 running 表示还在跑，exitCode 是退出码。',
      parameters: Type.Object({
        shell_id: Type.String({ description: 'run_background 返回的 id' }),
        since: Type.Optional(Type.Number({ description: '只看这个字符位置之后的输出（用上次返回的 offset）' })),
        pattern: Type.Optional(Type.String({ description: '输出里出现这个正则就返回（最多等 wait_ms）' })),
        wait_ms: Type.Optional(Type.Number({ description: '等新输出最多多少毫秒，默认 0（立即返回），上限 10000' })),
      }),
      execute: async (_toolCallId, { shell_id, since, pattern, wait_ms }) => {
        const result = await shells.read(shell_id, {
          since: Number(since) || 0,
          pattern: pattern || '',
          waitMs: Number(wait_ms) || 0,
        });
        if (!result) return fail(`没有这个后台进程：${shell_id}`);
        const state = result.running
          ? '运行中'
          : `已结束${result.exitCode === null ? '' : `（退出码 ${result.exitCode}）`}`;
        const body = result.output.trim() || '（没有新输出）';
        return ok(`${state}${result.truncated ? ' · 早期输出已截断' : ''}\n${body}`, {
          shellId: shell_id,
          running: result.running,
          exitCode: result.exitCode,
          offset: result.offset,
          matched: result.matched,
        });
      },
    }),

    defineTool({
      name: 'write_stdin',
      label: '给后台进程送输入',
      description:
        '往后台进程的 stdin 写内容（交互式命令、确认提示都能用）。需要换行就自己带上 \\n。' +
        '写入内容受部门规矩约束，被禁命令即使拆成多次写入也会被拒绝。',
      parameters: Type.Object({
        shell_id: Type.String({ description: 'run_background 返回的 id' }),
        chars: Type.String({ description: '要写入的内容' }),
      }),
      execute: async (_toolCallId, { shell_id, chars }) => {
        const policy = store.policy();
        const blocked = readonlyBlockReason(policy, 'write_stdin');
        if (blocked) return fail(blocked);
        // 与 bash 同一套判定；半截输入要和上次没换行的内容拼起来看
        const verdict = verdictForTool('write_stdin', { shell_id, chars }, policy);
        if (verdict && !verdict.allowed) {
          const bot = store.getBot(botId);
          store.addDenial({
            roomId,
            botId,
            botName: bot?.name ?? '',
            command: chars,
            rule: verdict.rule ?? verdict.deniedBy,
            reason: verdict.reason,
          });
          return fail(verdict.message);
        }
        const r = shells.write(shell_id, chars);
        if (r.ok) commitStdin(shell_id, chars);
        return r.ok ? ok(`已写入 ${String(chars).length} 个字符`) : fail(r.error);
      },
    }),

    defineTool({
      name: 'kill_shell',
      label: '结束后台进程',
      description: '结束后台进程（默认同时移除记录）。',
      parameters: Type.Object({
        shell_id: Type.String({ description: 'run_background 返回的 id' }),
        keep: Type.Optional(Type.Boolean({ description: '只结束、保留记录以便回看输出' })),
      }),
      execute: async (_toolCallId, { shell_id, keep }) => {
        const blocked = readonlyBlockReason(store.policy(), 'kill_shell');
        if (blocked) return fail(blocked);
        resetStdin(shell_id);
        const r = keep ? shells.kill(shell_id) : shells.remove(shell_id);
        if (!r.ok) return fail(r.error);
        return ok(keep ? '已结束（记录保留）' : '已结束并移除');
      },
    }),

    // ---------------------------------------------------------------- 外部系统
    defineTool({
      name: 'query_site',
      label: '查外部系统',
      description:
        '去已接入的外部 Web 系统查数据（比如投研系统、后台管理系统）。' +
        '用法：先用 list_sites 看接了哪些系统、每个系统的接口前缀是什么，' +
        '再用 query_site 带上路径和查询参数去查。返回的是对方接口的原始 JSON。' +
        '★ 不确定接口路径时，先查一个列表接口看结构，再决定要不要带筛选参数。',
      parameters: Type.Object({
        site: Type.String({ description: '系统标识（用 list_sites 查到的 id 或名字）' }),
        path: Type.String({ description: '接口路径，以 / 开头，如 /api/rankings' }),
        query: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description: '查询参数。值都是字符串；数组用逗号连接',
          }),
        ),
      }),
      execute: async (_toolCallId, { site, path, query }) => {
        const runtime = runner?.sites;
        if (!runtime) return fail('这个会话没有接入外部系统的能力');

        // 按 id 或名字找站点（模型不一定记得 id）
        const all = store.siteList();
        const found =
          all.find((s) => s.id === site) ??
          all.find((s) => s.name === site) ??
          all.find((s) => s.name.includes(site) || site.includes(s.name));
        if (!found) {
          return fail(
            `没有叫「${site}」的系统。已接入的有：${all.map((s) => `${s.name}(${s.id})`).join('、') || '（空）'}`,
          );
        }

        const res = await runtime.request({
          site: found,
          path,
          query: query ?? {},
        });
        if (!res.ok) {
          return fail(`查 ${found.name} 失败：${res.reason}`, { siteId: found.id });
        }

        // 结果可能很大：截一段给模型，并说清总量，避免把上下文撑爆
        const text = JSON.stringify(res.data);
        const limit = 12000;
        if (text.length > limit) {
          return ok(
            `查 ${found.name} 成功，但结果较大（${text.length} 字符），下面是前 ${limit} 字符。` +
              `需要更精确的结果就加筛选参数或翻页：\n\n${text.slice(0, limit)}`,
            { siteId: found.id, truncated: true },
          );
        }
        return ok(text, { siteId: found.id });
      },
    }),

    defineTool({
      name: 'list_sites',
      label: '看接了哪些系统',
      description: '列出已接入的外部 Web 系统，以及各自对应的部门。派活前先看一眼。',
      parameters: Type.Object({}),
      execute: async () => {
        const all = store.siteList();
        if (!all.length) {
          return ok('还没有接入任何外部系统。用户可以在设置的「系统接入」里添加。');
        }
        const lines = all.map((s) => {
          const room = s.teamRoomId ? store.getRoom(s.teamRoomId) : null;
          return [
            `- ${s.name}（id=${s.id}）`,
            `  ${s.baseUrl}`,
            `  账号：${s.account}`,
            `  团队：${room ? room.name : '（还没建）'}`,
          ].join('\n');
        });
        return ok(`已接入 ${all.length} 个系统：\n\n${lines.join('\n')}`);
      },
    }),

  ];
}

// ---------------------------------------------------------------------------
// 只有总经理（主控）能用
// ---------------------------------------------------------------------------

export function buildChiefTools({ runner, health, roomId, botId }) {
  return [
    // ★ 加技能 / 加 MCP：主控的权力仅次于用户。
    //
    //   为什么不只让用户在设置里点：用户说话是"我想让它能查数据库"，
    //   不是"你去设置页第三栏点添加、填 baseUrl、再点保存"。
    //   主控有权直接把这件事件掉 —— 但它加的东西**和用户加的完全一样**，
    //   都落在同一个库里、走同一套校验，没有后门。
    defineTool({
      name: 'add_skill',
      label: '教大家一门本事',
      description:
        '往全局技能库里加一条做法（所有 bot 共享，按任务自动挑相关的注入提示词）。' +
        '用户说"让它学会 X"、或者你发现某类活反复摸索时用它。' +
        '标题要具体（"如何调某某接口"而不是"开发技巧"），做法要写成能照着执行的步骤。',
      parameters: Type.Object({
        title: Type.String({ description: '标题，具体到能一眼看出这是干什么的' }),
        summary: Type.Optional(Type.String({ description: '一句话说明' })),
        howto: Type.String({ description: '具体做法/步骤。写清楚命令、路径、注意事项' }),
        tags: Type.Optional(Type.Array(Type.String(), { description: '几个关键词，用于按任务匹配' })),
      }),
      execute: async (_toolCallId, params) => {
        const r = store.addSkill({
          title: params.title,
          summary: params.summary ?? '',
          howto: params.howto,
          tags: params.tags ?? [],
        });
        if (r.error) return fail(r.error);
        return ok(`已加进技能库：${r.skill.title}（所有 bot 都能用上）`);
      },
    }),

    defineTool({
      name: 'add_mcp_server',
      label: '接一个 MCP 能力',
      description:
        '往 MCP 服务库里加一个服务（给模型加外部能力：读文件、查数据库、调接口…）。' +
        '**加完默认是不启用的** —— 要不要真连、连给谁，得看用户的意思，' +
        '因为每个 MCP 都会起子进程吃内存。' +
        '本地服务用 type=stdio + command/args；远端用 type=http + url。',
      parameters: Type.Object({
        name: Type.String({ description: '名字，只能字母数字下划线短横线（会被拼进工具名）' }),
        type: Type.Optional(Type.String({ description: 'stdio（本地命令）或 http（远端服务），默认 stdio' })),
        description: Type.Optional(Type.String({ description: '一句话说明这个服务能干什么' })),
        command: Type.Optional(Type.String({ description: 'stdio 的启动命令，如 npx' })),
        args: Type.Optional(Type.Array(Type.String(), { description: 'stdio 的命令参数' })),
        url: Type.Optional(Type.String({ description: 'http 的服务地址' })),
        enabled: Type.Optional(
          Type.Boolean({ description: '是否立即启用（默认 false —— 会起进程，通常等用户确认）' }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const r = store.addMcpServer({
          name: params.name,
          type: params.type ?? 'stdio',
          description: params.description ?? '',
          command: params.command,
          args: params.args ?? [],
          url: params.url,
          // 默认不启用：主控加进来只是"登记"，真连不连让用户定
          enabled: params.enabled === true,
        });
        if (r.error) return fail(r.error);
        const state = r.server.enabled ? '已启用' : '已登记但未启用';
        return ok(
          `已加进 MCP 库：${r.server.name}（${state}）。` +
            (r.server.enabled ? '' : '要真连上，需要在设置里打开它的开关，或者在 bot 上挂载时由用户确认。'),
        );
      },
    }),

    defineTool({
      name: 'list_local_capabilities',
      label: '看看本机装了什么',
      description:
        '扫描用户电脑上 pi 已经装好的 skill 和 MCP（只读，不会改用户配置）。' +
        '用户说"用我装过的那个"、或者你觉得某个能力机器上可能已经有了时，先看一眼，' +
        '避免重复造一遍。',
      parameters: Type.Object({}),
      execute: async () => {
        const found = scanLocalCapabilities({
          existingSkills: store.skillLibrary(),
          existingMcp: store.mcpLibrary(),
        });
        const lines = [];
        if (found.skills.length) {
          lines.push('本机已装的技能：');
          for (const s of found.skills) {
            lines.push(`- ${s.title}${s.imported ? '（已在库里）' : ''}：${s.summary || '（无说明）'}`);
          }
        }
        if (found.mcpServers.length) {
          lines.push('', '本机已配的 MCP：');
          for (const s of found.mcpServers) {
            lines.push(
              `- ${s.name}${s.imported ? '（已在库里）' : ''}（${s.type}）：${s.command ?? s.url}`,
            );
          }
        }
        if (!lines.length) {
          return ok('本机没有装额外的 skill 或 MCP。');
        }
        lines.push('', '要让某个进来，让用户在「设置 → 技能 / MCP」点导入（一键复制，不动用户原配置）。');
        return ok(lines.join('\n'));
      },
    }),

    // ★ 接一个 Web 系统：抓 -> 存草稿 -> 让用户确认 -> 才真入库。
    //
    //   为什么分两步：自动探测会猜错（登录路径、字段名、哪些算"模块"）。
    //   猜错了直接建出一个连不上的系统，用户还得去设置里删，比先确认更烦。
    defineTool({
      name: 'stage_site',
      label: '记下摸到的系统结构',
      description:
        '把你在某个 Web 系统里摸到的结构记成一份**待确认的草稿**（不会真的建）。' +
        '流程：先用 MCP（比如 rea）或 web_fetch 把系统的页面/接口抓一遍，' +
        '把发现的模块路径逐个填进 modules；可以分多次提交，同名路径会自动合并。' +
        '抓齐后调 confirm_site 让用户拍板。' +
        '**注意：modules 必须是真实的接口路径**（如 /api/assets），不要编。',
      parameters: Type.Object({
        name: Type.String({ description: '系统名字，如「投研系统」' }),
        baseUrl: Type.String({ description: '系统地址，如 https://demo.example.com' }),
        account: Type.Optional(Type.String({ description: '登录账号' })),
        password: Type.Optional(Type.String({ description: '登录口令（只在确认入库时用到）' })),
        loginPath: Type.Optional(Type.String({ description: '登录接口路径，如 /api/auth/login' })),
        modules: Type.Array(
          Type.Object({
            path: Type.String({ description: '接口路径，以 / 开头' }),
            name: Type.Optional(Type.String({ description: '这个模块管什么' })),
            note: Type.Optional(Type.String({ description: '补充说明，如参数/返回结构' })),
            verified: Type.Optional(Type.Boolean({ description: '是否实际请求验证过' })),
          }),
          { description: '这次摸到的模块（可分批提交，按 path 合并）' },
        ),
        summary: Type.Optional(Type.String({ description: '整体说明：这个系统有哪几块' })),
      }),
      execute: async (_toolCallId, params) => {
        const r = siteDrafts.upsert({ roomId, botId, data: params });
        if (r.error) return fail(r.error);
        const d = r.draft;
        return ok(
          `已记下「${d.name}」的结构：${d.modules.length} 个模块。\n` +
            `还没入库 —— 抓齐后调 confirm_site 让用户确认。\n` +
            `当前模块：${d.modules.map((m) => m.path).join('、')}`,
        );
      },
    }),

    defineTool({
      name: 'confirm_site',
      label: '请用户确认接入',
      description:
        '把 stage_site 记下的草稿摊给用户看，请他拍板。' +
        '**必须等用户确认**：用户点「确认，接进来」才算同意；' +
        '用户说要改就回到 stage_site 改，说算了就 discard_site。' +
        '用户确认后，主控要接着调 commit_site 真正入库并建团队。',
      parameters: Type.Object({}),
      execute: async () => {
        const draft = siteDrafts.get(roomId, botId);
        if (!draft) {
          return fail('还没有草稿。先用 stage_site 记下摸到的结构。');
        }
        const text = describeDraftForConfirm(draft);
        const options = draftConfirmOptions(draft);
        // 主控本身不带 ask_user（它直接跟用户说话），所以这里自己写一条卡片。
        // 这是**唯一**允许主控发卡片的场景：接入一个外部系统是长期契约，
        // 必须留一份用户明确点过头的记录。
        const msg = store.appendMessage({
          roomId,
          authorType: 'bot',
          authorId: botId,
          authorName: store.getBot(botId)?.name ?? '',
          authorEmoji: store.getBot(botId)?.emoji ?? null,
          kind: 'ask',
          text,
          status: 'done',
          meta: { options, allowCustom: true, siteDraftId: draft.id },
        });
        bus.emit('event', { t: 'msg.new', msg });
        log(`🗂️ ${store.getBot(botId)?.name ?? botId} 请用户确认接入「${draft.name}」`);
        return ok(
          '确认卡片已经发出去了。**这一轮先停在这里**，等用户回。\n' +
            '用户点「确认，接进来」→ 调 commit_site；说改 → 回 stage_site 补；说算了 → discard_site。',
        );
      },
    }),

    defineTool({
      name: 'commit_site',
      label: '入库并建团队',
      description:
        '**只有在用户明确确认之后**才调这个。把草稿变成真的系统接入，' +
        '并按现有逻辑自动建一个专门管它的部门团队。',
      parameters: Type.Object({
        teamName: Type.Optional(Type.String({ description: '团队名，默认「<系统名> 团队」' })),
      }),
      execute: async (_toolCallId, params) => {
        const draft = siteDrafts.get(roomId, botId);
        if (!draft) return fail('没有待确认的草稿（可能已经提交过或已丢弃）');
        if (!draft.account) return fail('还没拿到登录账号，没法接。先跟用户要。');

        const added = store.addSite({
          name: draft.name,
          baseUrl: draft.baseUrl,
          account: draft.account,
          password: draft.password,
          auth: {
            kind: 'json',
            ...(draft.loginPath ? { loginPath: draft.loginPath } : {}),
          },
        });
        if (added.error) return fail(added.error);
        const site = added.site;

        // 建团队：沿用现成的"一个系统一个团队"逻辑（与设置页按钮完全一致）
        const teamName = String(params.teamName ?? `${site.name} 团队`).slice(0, 40);
        const persona =
          `你负责「${site.name}」这个系统（${site.baseUrl}）。` +
          `用户在手机上问你跟这个系统有关的事时，你用 query_site 去查真实数据再回答。` +
          `查之前先用 list_sites 确认系统标识；结果有可能是大 JSON，挑用户关心的说出来，不要整段贴。` +
          `查不到就直说查不到，不要猜。`;
        const { room, bots } = store.createDepartment({
          name: teamName,
          topic: `接入的外部系统：${site.name}`,
          members: [
            {
              name: `${site.name} 助手`,
              persona,
              emoji: '🔌',
              tagline: `查 ${site.name} 的数据`,
              skills: [
                {
                  title: `查询 ${site.name}`,
                  howto:
                    `用 query_site(site="${site.id}", path="/api/...") 查数据。\n` +
                    `已摸清的模块：\n` +
                    draft.modules.map((m) => `- ${m.path}${m.note ? `（${m.note}）` : ''}`).join('\n'),
                },
              ],
              mcpServers: [],
            },
          ],
          lead: `${site.name} 助手`,
          createdBy: 'chief',
        });
        store.bindSiteTeam(site.id, room.id);
        siteDrafts.consume(roomId, botId);

        log(`🌐 主控接入系统「${site.name}」→ 团队 ${teamName}`);
        return ok(
          `已接入「${site.name}」：${draft.modules.length} 个模块，团队「${teamName}」已建好。` +
            `之后用户在手机上问这个系统的事，那个团队会去查真实数据。`,
        );
      },
    }),

    defineTool({
      name: 'discard_site',
      label: '不接这个系统',
      description: '用户说不接、或者发现抓错了时，丢掉草稿。',
      parameters: Type.Object({}),
      execute: async () => {
        const dropped = siteDrafts.discard(roomId, botId);
        return ok(dropped ? '已经把草稿丢了，没有入库。' : '本来就没有草稿。');
      },
    }),

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
        skills: Type.Optional(
          Type.Array(
            Type.Object({
              title: Type.String({ description: '技能名，如「爬虫反爬 SOP」' }),
              howto: Type.String({ description: '具体怎么做，越细越好' }),
            }),
            { description: '额外技能。开发类的 bot 会自动带上工程基线，不用你写' },
          ),
        ),
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
        // ★ 造"开发类"bot 时**自动挂上工程基线**。
        //
        //   用户要的："建立 coding 相关的 bot 的时候 优先让开发类 bot 必须调用
        //   这类 skill。" 靠主控每次记得手写是不现实的 —— 它一忙就忘。
        //   所以在这里一刀切：命中就是开发类，基线必须带。
        const skills = [...(params.skills ?? [])];
        const coding = isCodingRole({
          name: params.name,
          persona: params.persona,
          tagline: params.tagline ?? '',
        });
        if (coding && !skills.some((k) => k?.title === CODING_BASELINE_TITLE)) {
          skills.unshift({ title: CODING_BASELINE_TITLE, howto: CODING_BASELINE_HOWTO });
        }
        const bot = store.createBot({
          name: params.name,
          persona: params.persona,
          emoji: params.emoji,
          tagline: params.tagline,
          model: check.resolved ?? null,
          thinking: params.thinking ?? undefined,
          createdBy: 'chief',
          skills,
        });
        log(
          `chief 招了：${bot.emoji} ${bot.name} (${bot.model ?? '默认'}/${bot.thinking})` +
            (coding ? ' ＋工程基线' : ''),
        );
        return ok(`已招到 ${bot.emoji} ${bot.name}（id=${bot.id}）。«内部：${bot.model ?? '默认'}/${bot.thinking}，不要写进给用户看的话»`, {
          botId: bot.id,
        });
      },
    }),

    defineTool({
      name: 'update_bot',
      label: '调整某人',
      description:
        '改某个 bot 的名字/人设/模型/思考等级/emoji，以及给它配 MCP 服务。' +
        '换了模型或改了 MCP 会自动重开会话。',
      parameters: Type.Object({
        botId: Type.String(),
        name: Type.Optional(Type.String()),
        persona: Type.Optional(Type.String()),
        tagline: Type.Optional(Type.String()),
        emoji: Type.Optional(Type.String()),
        model: Type.Optional(Type.String({ description: '模型；传空字符串表示回到默认' })),
        thinking: Type.Optional(Type.String({ description: THINKING_LEVELS.join(' / ') })),
        mcpServers: Type.Optional(
          Type.Array(Type.String(), {
            description:
              '给这个人挂哪几个 MCP 服务（传名字）。传空数组 = 全撤掉。' +
              '只给它真正需要的 —— 每个 MCP 都会起进程吃内存，别一股脑全挂。',
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const { botId: target, ...patch } = params;
        if (patch.model !== undefined && patch.model !== '') {
          const check = checkModel(runner, patch.model, health);
          if (!check.ok) return modelError(patch.model, check.suggestions);
          patch.model = check.resolved;
        }
        // MCP 名字必须真在库里存在，否则配上去也连不上，模型会以为配好了
        if (Array.isArray(patch.mcpServers) && patch.mcpServers.length) {
          const known = new Map(store.mcpLibrary().map((s) => [s.name.toLowerCase(), s]));
          const missing = patch.mcpServers.filter((n) => !known.has(String(n).toLowerCase()));
          if (missing.length) {
            return fail(
              `没有这些 MCP 服务：${missing.join('、')}。` +
                `先让用户在「设置 → MCP」里加，或者看提示词里列出的可用清单。`,
            );
          }
          const disabled = patch.mcpServers.filter(
            (n) => known.get(String(n).toLowerCase())?.enabled !== true,
          );
          if (disabled.length) {
            return fail(
              `${disabled.join('、')} 还没启用（在设置里打开开关才行）—— ` +
                '没启用的服务不会真的去连，配上去也没用。',
            );
          }
        }
        const bot = store.updateBot(target, patch);
        if (!bot) return fail(`找不到 bot ${target}`);
        if (patch.model !== undefined || patch.thinking !== undefined || patch.mcpServers !== undefined) {
          runner.resetSessionForBot(bot.id);
        }
        const mcpNote = Array.isArray(bot.mcpServers) && bot.mcpServers.length
          ? `，MCP：${bot.mcpServers.join(', ')}`
          : '';
        return ok(
          `已更新 ${bot.emoji ?? ''}${bot.name}。«内部：${bot.model ?? '默认'}/${bot.thinking}${mcpNote}»`,
        );
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
      name: 'list_department_templates',
      label: '看有哪些部门模板',
      description:
        '这台机器上存过的部门模板（班子 = 人 + 人设 + 模型 + 技能，不含聊天记录）。\n' +
        '用户说「照上次那个再开一个」「用 XX 模板开个部门」时，先看这里拿 id。',
      parameters: Type.Object({}),
      execute: async () => {
        const list = store.templates();
        if (!list.length) {
          return ok(
            '还没有部门模板。建部门时带上 saveAs（写个模板名）就会存一份；\n' +
              '或者让用户右键一个部门选「存成部门模板」。',
          );
        }
        return ok(
          list
            .map(
              (t) =>
                `${t.name}  «id=${t.id}»  —— ${t.members.length} 人，负责人 ${t.lead ?? '—'}` +
                (t.topic ? `；${t.topic}` : ''),
            )
            .join('\n'),
          { templates: list.map((t) => t.id) },
        );
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
        templateId: Type.Optional(
          Type.String({
            description:
              '★ 照已有的部门模板开（先 list_department_templates 拿 id）。\n' +
              '给这个就不用再给 lead/members —— 人、人设、模型、技能都照模板来。',
          }),
        ),
        saveAs: Type.Optional(
          Type.String({ description: '顺手把这次这套班子存成模板（写模板名），以后能照开' }),
        ),
        lead: Type.Optional(Type.String({ description: '部门老大的名字，必须是 members 里某一个的 name' })),
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
        // ★ 照模板开：人 / 人设 / 模型 / 技能 全从模板来，不再要求 lead+members。
        //   这是"这个班子不错，再来一个一样的"那条路 —— 用户不必重述一遍要求。
        if (params.templateId) {
          const r = store.applyTemplate(params.templateId, { name: params.name });
          if (r.error) {
            return fail(
              `${r.error}。现有模板：${
                store.templates().map((t) => `${t.name}(${t.id})`).join('、') || '（还没有）'
              }`,
            );
          }
          if (params.saveAs) store.saveTemplateFromRoom(r.room.id, { name: params.saveAs });
          return ok(
            `照模板「${r.template.name}」开好了：${r.room.name}（${r.bots.length} 人，` +
              `负责人 ${store.getBot(r.room.leadBotId)?.name ?? '—'}）。«内部：roomId=${r.room.id}»`,
          );
        }
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
        // 顺手存一份模板：下次"再开一个这样的"或"照这个改"就不用重描述一遍
        if (params.saveAs) store.saveTemplateFromRoom(room.id, { name: params.saveAs });

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

    // ---------------------------------------------------------------- 技能库
    defineTool({
      name: 'list_skills',
      label: '看技能库',
      description:
        '看技能库里有哪些现成的做法（用户整理或导入的 SOP）。' +
        '派活前先看一眼，能把合适的技能交给新人或直接拿来做。',
      parameters: Type.Object({
        keyword: Type.Optional(Type.String({ description: '按标题/标签/内容搜，不填就全列' })),
      }),
      execute: async (_toolCallId, { keyword }) => {
        const all = store.skillLibrary();
        if (!all.length) {
          return ok('技能库现在是空的。用户可以往库里加，或者导入 SKILL.md。', { total: 0 });
        }
        const q = String(keyword ?? '').trim().toLowerCase();
        const list = q
          ? all.filter(
              (s) =>
                s.title.toLowerCase().includes(q) ||
                s.summary.toLowerCase().includes(q) ||
                s.howto.toLowerCase().includes(q) ||
                s.tags.some((t) => t.toLowerCase().includes(q)),
            )
          : all;
        if (!list.length) return ok(`技能库里没有匹配「${keyword}」的`, { total: all.length });
        const lines = list.map(
          (s, i) =>
            `${i + 1}. ${s.title}${s.summary ? ` —— ${s.summary}` : ''}` +
            `${s.tags.length ? `\n   标签：${s.tags.join('、')}` : ''}` +
            `${s.enabled ? '' : '\n   （已停用）'}\n   id: ${s.id}`,
        );
        return ok(
          `技能库共 ${all.length} 条，下面是 ${list.length} 条：\n\n${lines.join('\n')}\n\n` +
            '要给某个 bot 用，用 assign_skill(botName, skillId)。',
          { total: all.length, matched: list.length },
        );
      },
    }),

    defineTool({
      name: 'assign_skill',
      label: '把技能交给某人',
      description:
        '从技能库挑一条，挂到某个 bot 身上（会进它的系统提示，相当于「教会了它」）。' +
        '技能库是共享的，挂上去不影响别人；同一条可以挂给多人。',
      parameters: Type.Object({
        botName: Type.String({ description: '给谁，写名字' }),
        skillId: Type.String({ description: '技能 id（用 list_skills 查）' }),
      }),
      execute: async (_toolCallId, { botName, skillId }) => {
        const bot = store.listBots().find((b) => b.name === botName);
        if (!bot) return fail(`找不到叫「${botName}」的 bot`);
        const skill = store.skillLibrary().find((s) => s.id === skillId);
        if (!skill) return fail(`技能库里没有 id=${skillId}，用 list_skills 查一下`);

        const own = Array.isArray(bot.skills) ? bot.skills : [];
        if (own.some((s) => s.title === skill.title)) {
          return ok(`${bot.name} 已经会「${skill.title}」了，不用重复给`);
        }
        const next = [...own, { title: skill.title, howto: skill.howto }];
        store.updateBot(bot.id, { skills: next });
        log(`chief 把技能「${skill.title}」交给了 ${bot.name}`);
        return ok(`已把「${skill.title}」交给 ${bot.emoji} ${bot.name}（它现在会 ${next.length} 项）`);
      },
    }),

    defineTool({
      name: 'create_skill',
      label: '存一条做法',
      description:
        '把一套做法存进技能库（只存文档，不存代码）。以后可以反复分配给不同的人，' +
        '不用每次重新教。用户手工摸索出来的流程也适合存进来。',
      parameters: Type.Object({
        title: Type.String({ description: '技能名，如「线上排查三步」' }),
        howto: Type.String({ description: '具体怎么做，步骤要能照着执行' }),
        summary: Type.Optional(Type.String({ description: '一句话说明什么时候用' })),
        tags: Type.Optional(
          Type.Array(Type.String(), { description: '标签，如 运维 / 发版 / 数据' }),
        ),
      }),
      execute: async (_toolCallId, { title, howto, summary, tags }) => {
        const res = store.addSkill({ title, howto, summary, tags });
        if (res.error) return fail(res.error);
        return ok(`已存进技能库：「${res.skill.title}」（id=${res.skill.id}）`, {
          skillId: res.skill.id,
        });
      },
    }),
  ];
}
