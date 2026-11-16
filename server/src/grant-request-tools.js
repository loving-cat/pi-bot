/**
 * 「Bot 申请一次权限，用户在手机上点一下」的工具层。
 *
 * 单独一个文件的原因和 `desktop-island-tools.js` 一样：它要带一段不短的
 * 取舍说明（为什么不让 Bot 自己发授权、哪些能申请、卡片上写什么）。
 *
 * ## 谁可以发起
 *
 * 主 Bot 和**部门负责人**。理由：普通成员向用户要"给我动鼠标"，用户根本
 * 判断不了该不该给；负责人知道这个部门在干什么、要动哪台电脑。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { log } from './util.js';
import { buildConfirmation } from './confirm.js';
import {
  REQUESTABLE_ACTIONS, planGrantRequest, describeGrantRequest, DEFAULT_TTL_MS,
} from './grant-request.js';

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const fail = (text, details = {}) => ({ content: [{ type: 'text', text }], details, isError: true });

/**
 * @param {object} p
 * @param {object} p.store
 * @param {string} p.botId 发起人
 * @param {string} p.roomId
 * @param {string} p.role 'main' | 'lead'
 */
export function buildGrantRequestTools({ store, botId, roomId, role = 'member' }) {
  if (role !== 'main' && role !== 'lead') return [];
  return [
    defineTool({
      name: 'request_permission',
      label: '★ 向用户申请一次权限',
      description:
        '当你需要某种权限（比如"在这个部门动鼠标"）而现在没有时，用这个工具**发起申请**。\n'
        + '用户会在**手机上**看到一张卡片，点批准之后权限才真的生效 —— 你自己批准不了，'
        + '这是故意的：模型能给自己扩权，前面所有闸就都不算数了。\n'
        + '\n'
        + `能申请的动作（别的去各自的设置里改）：${REQUESTABLE_ACTIONS.join('、')}。\n`
        + '申请要写清楚**给谁、能干什么、多久**：卡片上就那么几行，用户要能一眼读懂。\n'
        + '\n'
        + '批准之后：这张授权绑当前规矩版本、到期自动失效、一条 bot 一条（好撤销）。',
      parameters: Type.Object({
        actions: Type.Array(Type.String(), {
          description: `要申请的动作，例如 ["desktop.observe","desktop.input"]（可选：${REQUESTABLE_ACTIONS.join(' / ')}）`,
        }),
        scope: Type.Optional(Type.Union([
          Type.Literal('self'),
          Type.Literal('department'),
        ], { description: 'self=只给我自己；department=给当前部门所有人（默认 self）' })),
        botIds: Type.Optional(Type.Array(Type.String(), {
          description: '要给哪几个 bot（给了就按这个，忽略 scope）',
        })),
        ttlHours: Type.Optional(Type.Number({ description: '有效几小时（默认 2，最多 24）' })),
        reason: Type.Optional(Type.String({ description: '为什么要这个权限（写给人看，一句话）' })),
      }),
      execute: async (_toolCallId, { actions, scope, botIds, ttlHours, reason }) => {
        const room = roomId ? store.getRoom(roomId) : null;
        let targets = [];
        if (Array.isArray(botIds) && botIds.length) {
          targets = botIds.map((id) => store.getBot(String(id))).filter(Boolean);
        } else if (scope === 'department') {
          if (!room || room.kind !== 'group') {
            return fail('这里不是部门（群），没法"给整个部门"申请。要给自己就用 scope=self。');
          }
          targets = (room.botIds ?? []).map((id) => store.getBot(id)).filter(Boolean);
        } else {
          const me = store.getBot(botId);
          targets = me ? [me] : [];
        }
        if (!targets.length) return fail('没有找到要授权的 bot。');

        const plan = planGrantRequest({
          actions,
          bots: targets,
          ttlMs: (Number(ttlHours) || DEFAULT_TTL_MS / 3600_000) * 3600_000,
          reason,
        });
        if (!plan.ok) return fail(plan.text, { code: plan.code });

        const req = plan.request;
        const summary = describeGrantRequest({ request: req });
        const confirmation = {
          ...buildConfirmation({
            id: `cf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            // ★ 这个动作名不在动作目录里 → `isIrreversible` 默认按不可撤销算 →
            //   必须手机通道。本机桌面点批准不算数（主 Bot 能操作桌面）。
            action: 'grant.request',
            target: { actions: req.actions, botIds: req.bots.map((b) => b.id), ttlMs: req.ttlMs, reason: req.reason },
            summary,
            display: { actions: req.actions, bots: req.bots.map((b) => b.name || b.id), ttlMs: req.ttlMs },
            requestedBy: botId,
            roomId,
            policyRevision: store.policyVersion(),
          }),
          // 批准之后要靠它把授权建出来（http 的确认路由读这个字段）
          targetJson: JSON.stringify(req),
        };
        const saved = store.requestConfirmation(confirmation);
        store.appendMessage({
          roomId,
          authorType: 'bot',
          authorId: botId,
          authorName: store.getBot(botId)?.name ?? '',
          authorEmoji: store.getBot(botId)?.emoji ?? null,
          kind: 'confirmation',
          text: `${store.getBot(botId)?.name ?? '它'} 想申请权限，等你在手机上确认：${summary}`,
          status: 'done',
          meta: { confirmationId: saved.id, action: 'grant.request' },
        });
        log(`🛡 ${store.getBot(botId)?.name ?? botId} 申请权限：${summary}`);

        return ok(
          [
            `已经发起申请：${summary}`,
            `给的是：${req.bots.map((b) => b.name || b.id).join('、')}`,
            req.reason ? `理由：${req.reason}` : '',
            '',
            '用户会在**手机上**看到这张卡片，点批准之后权限才生效。',
            '本机桌面上的批准不算数 —— 那样模型就能给自己扩权了。',
            '批准前不要反复重复申请；用户拒绝就说明原因不够，换个说法或先做别的。',
          ].filter(Boolean).join('\n'),
          { ticket: saved.id, request: req },
        );
      },
    }),
  ];
}
