/**
 * 群消息路由器。
 *
 * 用户在群里发言时，程序先判断「这条该谁接」：
 *   1. 有 @某某 → 只给被点名的（@all 就是全体）
 *   2. 否则用一个便宜模型当调度，看群成员职责挑 1~N 个相关的
 *   3. 调度失败就退回到 leadBot
 *
 * 注意：所有成员都会通过「群记录」看到这条消息（见 pi-runner 的游标机制），
 * 这里只是决定谁现在开口。
 */
import { store } from './store.js';
import { log } from './util.js';

function firstLine(text, max = 60) {
  return String(text || '').split('\n').find((l) => l.trim())?.slice(0, max) ?? '';
}

function parseMentions(text, room) {
  const mentions = new Set();
  let all = false;
  const names = room.botIds.map((id) => ({ id, name: store.getBot(id)?.name })).filter((x) => x.name);
  for (const { id, name } of names) {
    if (text.includes(`@${name}`)) mentions.add(id);
  }
  if (/@(all|全体|所有人|大家)/.test(text)) all = true;
  return { mentions: [...mentions], all };
}

/** 向全体的发言（大家/各自/报一下/自我介绍…）→ 全员都要接 */
const BROADCAST = /(大家|各位|全员|所有人|每个人|各自|都来|都报|报一下|报个数|自我介绍|自报|挨个|一个一个)/;

function extractIds(raw, allowed) {
  const ids = new Set();
  const re = /"([^"]+)"/g;
  for (const m of raw.matchAll(re)) {
    if (allowed.has(m[1])) ids.add(m[1]);
  }
  for (const id of allowed) {
    if (!ids.has(id) && raw.includes(id)) ids.add(id);
  }
  return [...ids];
}

export async function pickResponders({ runner, room, text }) {
  const max = Math.max(1, Math.min(runner.groupMaxResponders, room.botIds.length));
  const members = room.botIds.map((id) => store.getBot(id)).filter(Boolean);
  if (!members.length) return [];
  const chiefId = members.find((b) => b.role === 'main')?.id ?? null;
  const others = members.filter((b) => b.id !== chiefId);

  const { mentions, all } = parseMentions(text, room);
  if (all) return members.map((b) => b.id);
  if (mentions.length) return mentions;

  // 向全体的发言：程序直接广播给每个成员，不让主控去一个个派
  if (BROADCAST.test(text)) {
    return (others.length ? others : members).map((b) => b.id).slice(0, 8);
  }

  const lead = room.leadBotId ?? members[0].id;
  const model = runner.routerModel ?? runner.model;
  if (!model || members.length === 1) return [lead];

  const roster = members
    .map((b) => `- id=${b.id} | ${b.emoji ?? ''}${b.name} | 职责：${firstLine(b.persona, 90)}`)
    .join('\n');

  const system = [
    '你是多 bot 群聊的调度器。根据群成员的职责，判断用户这条消息该由谁来回应。',
    '规则：',
    '- 只选真的该出手的，不相关的绝不选。',
    '- 需要多人协作时最多选 ' + max + ' 个。',
    '- 用户向全体提问 / 要求各自汇报 / 让所有人自我介绍 → 把成员全选上。',
    '- 只是闲聊或笼统的总体安排 → 选主控（role=main 的那个）。',
    '- 只输出 JSON 数组，元素是成员 id，不要任何解释。',
  ].join('\n');

  try {
    const reply = await Promise.race([
      runner.modelRuntime.completeSimple(
        model,
        {
          systemPrompt: system,
          messages: [
            {
              role: 'user',
              content: `群名：${room.name}\n${room.topic ? `群主题：${room.topic}\n` : ''}成员：\n${roster}\n\n用户说：${text}\n\n该谁回？`,
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens: 200, reasoning: 'off' },
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('路由超时')), 20_000)),
    ]);
    const raw = (reply?.content ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    const allowed = new Set(members.map((b) => b.id));
    const picked = extractIds(raw, allowed).slice(0, max);
    if (picked.length) return picked;
    log(`路由：没解析出成员（${raw.slice(0, 80)}），回退到 lead`);
  } catch (err) {
    log('路由失败：', err?.message || err);
  }
  return [lead];
}
