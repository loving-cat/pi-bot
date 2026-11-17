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
  REQUESTABLE_ACTIONS, planGrantRequest, describeGrantRequest, minChannelForRequest, DEFAULT_TTL_MS,
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
        const roomName = room?.name ?? '';
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
            // ★ 这条申请要手机还是桌面：看它申请的是**什么**，不是看它叫什么。
            //   要"动鼠标/跑命令/写文件"→ 手机（否则它自己就能点掉这张卡）；
            //   只是"看屏幕/读文件"→ 桌面上点一下就行。
            minChannel: minChannelForRequest({ actions: req.actions }),
          }),
          // 批准之后要靠它把授权建出来（http 的确认路由读这个字段）
          targetJson: JSON.stringify(req),
        };
        const saved = store.requestConfirmation(confirmation);
        const me = store.getBot(botId);
        const meName = me?.name ?? '它';
        const minChan = saved.minChannel ?? minChannelForRequest({ actions: req.actions });
        store.appendMessage({
          roomId,
          authorType: 'bot',
          authorId: botId,
          authorName: meName,
          authorEmoji: me?.emoji ?? null,
          kind: 'confirmation',
          text: `${meName} 想申请权限，等你确认：${summary}`,
          status: 'done',
          meta: {
            confirmationId: saved.id,
            action: 'grant.request',
            summary,
            minChannel: minChan,
            irreversible: minChan !== 'local',
          },
        });

        // ★ 转呈：负责人发起的申请，**同时**挂到「用户 ↔ 主 Bot」的私聊里。
        //
        //   产品意图（用户原话）："负责人 bot 也要找主 Bot 批准"。
        //   注意这里**不是**让主 Bot 替用户批准 —— 那等于模型能发授权，
        //   一句提示注入就能自批。主 Bot 在这里只做两件事：
        //     ① 把事摊到用户最常看的那一个地方（不用满群找卡片）；
        //     ② 说清这个部门在要什么。
        //   真正点批准的还是用户自己。
        let forwardedTo = null;
        if (role !== 'main') {
          const chief = store.mainBot?.() ?? null;
          const dm = chief ? store.ensureDm?.(chief.id) : null;
          if (dm?.id) {
            store.appendMessage({
              roomId: dm.id,
              authorType: 'bot',
              authorId: botId,
              authorName: meName,
              authorEmoji: me?.emoji ?? null,
              kind: 'confirmation',
              text: `${meName}（${roomName || '这个部门'}）申请权限，转呈给你确认：${summary}`,
              status: 'done',
              meta: {
                confirmationId: saved.id,
                action: 'grant.request',
                forwardedFrom: roomId,
                summary,
                minChannel: minChan,
                irreversible: minChan !== 'local',
              },
            });
            forwardedTo = dm.id;
          }
        }
        log(`🛡 ${meName} 申请权限：${summary}${forwardedTo ? '（已转呈给主 Bot 的私聊）' : ''}`);

        const needDevice = minChannelForRequest({ actions: req.actions }) === 'device';
        return ok(
          [
            `已经发起申请：${summary}`,
            `给的是：${req.bots.map((b) => b.name || b.id).join('、')}`,
            req.reason ? `理由：${req.reason}` : '',
            '',
            needDevice
              ? '这条要**手机上**批准：批的是"能动手"的权限，本机桌面能自己点掉的话就等于自己批自己。'
                + '（用户不用手机端的话，可以在设置里打开「允许在本机批准」—— 那会把这条保证降一档，所以默认关。）'
              : '这条**桌面上**点一下就行：批的是只读权限，批错了也只是"能看"，授权面板一眼能收。',
            forwardedTo
              ? '这条申请已经**转呈到你和主 Bot 的私聊**里了 —— 你在那一处点就行，不用在群里翻。'
              : '',
            '批准前不要反复重复申请；用户拒绝就说明原因不够，换个说法或先做别的。',
          ].filter(Boolean).join('\n'),
          { ticket: saved.id, request: req, minChannel: needDevice ? 'device' : 'local' },
        );
      },
    }),
  ];
}
