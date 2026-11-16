/**
 * 「独立桌面」（island，规格 §5.6 的 T1 档）的工具层。
 *
 * ## 为什么单独一个文件
 *
 * `tools.js` 已经 2000+ 行，而这三个工具要带一段不短的取舍说明
 * （为什么不要租约、为什么起应用按 cmd.exec 算、为什么取帧要判黑）。
 * 放在一起只会让那 2000 行更难读。
 *
 * ## 这一层只做三件事
 *
 *   1. 把模型的参数翻译成对 `desktop-island-win.js` 的调用；
 *   2. 把结果翻成人话（广场上那个"点了没反应"的经典问题，这里靠回读确认）；
 *   3. 把失败如实报出去 —— 尤其"截到黑帧"和"没有可打的控件"，
 *      这两种情况错误的方向都是"看起来成功"。
 *
 * 授权判定不在这里：工具名 → 动作 → `grant-gate`，和别的工具一样。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import fs from 'node:fs';
import { config } from './config.js';
import { screenshotPath } from './desktop-observe.js';
import {
  ISLAND_FAIL, ISLAND_APPS, TIER, describeTier,
  planIslandLaunch, planIslandMessages, chooseTier,
} from './desktop-island.js';
import {
  isSupported, islandExists, launchOnIsland, listIslandWindows,
  listIslandChildren, captureIslandWindow, postIslandMessages, readIslandText, closeIsland,
} from './desktop-island-win.js';

/** 默认岛名。一个 bot 一个岛够用了；要并行就自己传名字。 */
export const DEFAULT_ISLAND = 'pibot-island';

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const fail = (text, details = {}) => ({ content: [{ type: 'text', text }], details, isError: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 这个进程在这张岛上启动过哪些 pid。
 *
 * ★ 为什么要记：岛上的应用是**当前用户身份下的真实进程**。收尾只关桌面
 *   而不杀进程的话，任务跑完会在用户机器上留下一串孤儿窗口（它们没有桌面
 *   可画，进程还活着）。所以 close 必须把这一轮起过的都杀掉。
 */
const launchedPids = new Map();
function rememberPid(island, pid) {
  const list = launchedPids.get(island) ?? [];
  if (!list.includes(pid)) list.push(pid);
  launchedPids.set(island, list);
}

function islandName(raw) {
  return String(raw ?? '').trim() || DEFAULT_ISLAND;
}

/** 等窗口出现（首帧多久全看机器心情，别写固定 sleep）。 */
async function waitForWindows(name, { timeout = 10_000, wantTitle = '' } = {}) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeout) {
    const r = await listIslandWindows({ name });
    if (r.ok) {
      last = r.windows ?? [];
      const hit = wantTitle
        ? last.some((w) => String(w.title).toLowerCase().includes(wantTitle.toLowerCase()))
        : last.some((w) => w.visible && w.width > 40 && w.height > 40);
      if (hit) return last;
    }
    await sleep(250);
  }
  return last;
}

/** 挑一个窗口：给了 title 就按标题找，否则取最大的那个可见窗口。 */
function pickWindow(windows, title) {
  const usable = (windows ?? []).filter((w) => w.visible && w.width > 40 && w.height > 40);
  if (!usable.length) return null;
  if (title) {
    const needle = String(title).toLowerCase();
    return usable.find((w) => String(w.title).toLowerCase().includes(needle)) ?? null;
  }
  return [...usable].sort((a, b) => b.width * b.height - a.width * a.height)[0];
}

function describeWindows(windows) {
  return (windows ?? [])
    .filter((w) => w.width > 40 && w.height > 40)
    .map((w, i) => {
      const vis = w.visible ? '' : '（不可见）';
      return `${i + 1}. ${w.cls}${w.title ? ` · ${w.title.slice(0, 60)}` : ''} — ${w.width}x${w.height} 客户区 ${w.clientWidth}x${w.clientHeight}${vis}`;
    })
    .join('\n');
}

const head = (tier) => `【${describeTier(tier)}】`;

/**
 * 三个工具都需要的"平台/档位"前置检查。
 *
 * 不通过时返回**说清楚为什么**的失败，而不是一句"不支持" ——
 * 规格 §5.6 要求平台差异如实报，不能静默降级到"动用户鼠标"那一档。
 */
function guardTier({ authorized = true } = {}) {
  if (!isSupported()) {
    return {
      error: fail(
        `${head(TIER.island)}这个平台（${process.platform}）没有 CreateDesktop 等价 API。\n`
        + 'macOS 只能用虚拟机做 GUI 隔离，或者退回"操作当前桌面"（会移动用户的鼠标，需要单独确认）。\n'
        + '不会自动降级。',
      ),
    };
  }
  const pick = chooseTier({ needsGui: true, islandSupported: true, islandAuthorized: authorized });
  if (pick.tier !== TIER.island) return { error: fail(`没有独立桌面权限：${pick.why.join('；')}`) };
  return { tier: pick.tier };
}

/**
 * 构建这三个工具。只在主 Bot 上调用（和 `desktop_observe` 同一个档）。
 *
 * @param {object} p
 * @param {string} p.botId 记日志/文件名用
 * @param {object} [p.runner] 预留（将来要拿任务上下文）
 */
export function buildIslandTools({ botId } = {}) {
  return [
    defineTool({
      name: 'desktop_island_launch',
      label: '★ 在独立桌面里起一个应用',
      description:
        '在当前用户的登录会话里，**另开一张桌面**跑一个 GUI 应用，你自己操作它。\n'
        + '好处：它跑在自己的桌面上，**碰不到用户正在用的窗口和鼠标** —— 不需要 '
        + 'desktop_lease，也不会因为"用户在动鼠标"被挡住。\n'
        + '\n'
        + '代价（先说清，别说我没讲）：\n'
        + '· 岛上的应用是**干净实例**，没有用户现在的登录态；要登录态请用 ego-browser；\n'
        + '· 它记不住什么 —— 应用进程一退，那张桌面也就没了；\n'
        + '· 它**不是沙箱**：里面的程序仍以你的身份读写同一份文件、走同一张网卡。\n'
        + '\n'
        + `只能启动这些应用：${ISLAND_APPS.join(' / ')}。`
        + '参数按"一个参数一项"给，不要拼命令串（含 & | > ; $ 之类的会被拒）。',
      parameters: Type.Object({
        app: Type.String({ description: `可执行文件名，例如 notepad.exe（限：${ISLAND_APPS.slice(0, 4).join(', ')} …）` }),
        args: Type.Optional(Type.Array(Type.String(), { description: '参数数组，一项一个，不要拼成命令串' })),
        island: Type.Optional(Type.String({ description: '岛的名字（默认共用一个；要并行跑两个就各给一个名字）' })),
      }),
      execute: async (_id, { app, args, island }) => {
        const g = guardTier();
        if (g.error) return g.error;
        const name = islandName(island);
        const plan = planIslandLaunch({ exe: app, args: args ?? [] });
        if (!plan.ok) {
          return fail(
            `没启动：${plan.text}\n`
            + (plan.code === ISLAND_FAIL.shellMetachar
              ? '这个工具不接命令串 —— 要给参数就一项一项放在 args 里。'
              : `可放行的应用：${ISLAND_APPS.join(', ')}`),
            { code: plan.code },
          );
        }
        const r = await launchOnIsland({ name, commandLine: plan.commandLine });
        if (!r.ok) return fail(`${head(TIER.island)}启动失败：${r.text}`, { code: r.code });
        if (r.pid) rememberPid(name, r.pid);
        const windows = await waitForWindows(name);
        const visible = windows.filter((w) => w.visible && w.width > 40 && w.height > 40);
        return ok(
          `${head(TIER.island)}已在岛上启动：${plan.exe}（pid ${r.pid}，岛名 ${name}）\n`
          + `岛现在的窗口（${visible.length} 个）：\n${describeWindows(windows) || '（还没出来，稍等再看）'}\n`
          + '\n下一步：desktop_island_observe 看清楚画面，再用 desktop_island_input 点/打字。\n'
          + `收尾记得 desktop_island_input 传 action=close（岛上的进程是真实进程）。`,
          { island: name, pid: r.pid, windows: windows.length },
        );
      },
    }),

    defineTool({
      name: 'desktop_island_observe',
      label: '★ 看独立桌面（截图/列窗口）',
      description:
        '看岛上有什么窗口，或者截一张给自己看。\n'
        + '\n'
        + '只传 island 就是列窗口；再给 window（标题片段）就是看那个窗口里有哪些控件'
        + '（按钮/输入框的类名，点它们时要用）；加 capture=true 就截一张图。\n'
        + '\n'
        + '★ 截回来如果是全黑，会直接告诉你"看不见"而不是给一张黑图 —— '
        + '现代合成应用（新记事本、商店应用）在独立桌面上经常这样，那时候请改用浏览器或让用户在场。',
      parameters: Type.Object({
        island: Type.Optional(Type.String({ description: '岛的名字' })),
        window: Type.Optional(Type.String({ description: '窗口标题片段；不给就看全部' })),
        capture: Type.Optional(Type.Boolean({ description: 'true = 截这个窗口的图' })),
      }),
      execute: async (_id, { island, window, capture }) => {
        const g = guardTier();
        if (g.error) return g.error;
        const name = islandName(island);
        if (!islandExists({ name }).exists) {
          return fail(`岛上什么都没有（还没起应用，或者进程已经退了）。先用 desktop_island_launch 起一个。`);
        }
        const listR = await listIslandWindows({ name });
        if (!listR.ok) return fail(`看不了岛上的窗口：${listR.text}`, { code: listR.code });
        const windows = listR.windows ?? [];
        if (!capture && !window) {
          const usable = windows.filter((w) => w.width > 40 && w.height > 40);
          if (!usable.length) return ok(`${head(TIER.island)}岛上还没有可见窗口。`, { windows: 0 });
          return ok(`${head(TIER.island)}岛上的窗口：\n${describeWindows(windows)}`, { windows: usable.length });
        }

        const target = pickWindow(windows, window);
        if (!target) {
          return fail(`没找到窗口${window ? `（标题含「${window}」）` : ''}。\n当前：\n${describeWindows(windows)}`);
        }
        if (!capture) {
          const kids = await listIslandChildren({ name, hwnd: target.hwnd });
          if (!kids.ok) return fail(`看不了窗口里的控件：${kids.text}`);
          const list = kids.children ?? [];
          return ok(
            `${target.cls}${target.title ? ` · ${target.title}` : ''}\n`
            + `客户区 ${target.clientWidth}x${target.clientHeight}；控件 ${list.length} 个：\n`
            + list.map((c, i) => `${i + 1}. ${c.cls} — ${c.clientWidth}x${c.clientHeight}`).join('\n'),
            { controls: list.length },
          );
        }

        const spot = screenshotPath({ dataDir: config.dataDir, taskId: null, botId });
        const cap = await captureIslandWindow({ name, hwnd: target.hwnd, file: spot.file });
        if (!cap.ok) {
          return fail(
            `${head(TIER.island)}看不到这个窗口：${cap.text}\n`
            + '这种情况下不要凭猜去点 —— 改用 desktop_island_observe 列控件，或者让用户在旁边看。',
            { code: cap.code },
          );
        }
        let data;
        try {
          data = fs.readFileSync(cap.file).toString('base64');
        } catch (err) {
          return fail(`截到了但读不出来：${String(err?.message ?? err)}`);
        }
        return {
          content: [
            { type: 'text', text: `独立桌面截图：${target.cls}${target.title ? ` · ${target.title}` : ''}（${cap.width}x${cap.height}，暗像素 ${(cap.darkRatio * 100).toFixed(1)}%）` },
            { type: 'image', data, mimeType: 'image/png' },
          ],
          details: { island: name, width: cap.width, height: cap.height, darkRatio: cap.darkRatio },
        };
      },
    }),

    defineTool({
      name: 'desktop_island_input',
      label: '★ 操作独立桌面（点/打字/收尾）',
      description:
        '在岛上点一下、输入文字，或者收尾关掉。\n'
        + '\n'
        + '这些动作走的是**窗口消息**（WM_LBUTTONDOWN / WM_CHAR / WM_SETTEXT），'
        + '不移动用户的鼠标、也不抢焦点 —— 这就是它和 desktop_input 的根本区别。\n'
        + '\n'
        + '用法：\n'
        + '· action=click + control=BUTTON → 点那个控件的中心（最省事，不用算坐标）\n'
        + '· action=click + x,y → 按窗口客户区坐标点（先从 observe 的截图对位置）\n'
        + '· action=type + control=EDIT + text → 逐字打（会回读确认）\n'
        + '· action=setText + control=EDIT + text → 一次性替换（更快，不依赖焦点）\n'
        + '· action=close → 关掉岛上的进程与桌面（收尾用）\n'
        + '\n'
        + '★ 打完字会把控件里的内容读回来给你看：读回来对不上就是没打进去，别当成功。',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('click'),
          Type.Literal('type'),
          Type.Literal('setText'),
          Type.Literal('close'),
        ], { description: 'click / type / setText / close' }),
        island: Type.Optional(Type.String({ description: '岛的名字' })),
        window: Type.Optional(Type.String({ description: '窗口标题片段；只有一个窗口时可以不给' })),
        control: Type.Optional(Type.String({ description: '控件类名片段，例如 BUTTON 或 EDIT' })),
        x: Type.Optional(Type.Number({ description: '点击的客户区 x（给了 control 就不用）' })),
        y: Type.Optional(Type.Number({ description: '点击的客户区 y' })),
        text: Type.Optional(Type.String({ description: 'type / setText 要输入的文字' })),
      }),
      execute: async (_id, { action, island, window, control, x, y, text }) => {
        const g = guardTier();
        if (g.error) return g.error;
        const name = islandName(island);

        if (action === 'close') {
          const pids = launchedPids.get(name) ?? [];
          const r = await closeIsland({ name, pids });
          launchedPids.delete(name);
          return ok(
            `已收尾：岛「${name}」的桌面已关${pids.length ? `，并杀掉这一轮起的 ${pids.length} 个进程` : ''}。`,
            { closed: r.ok === true, killed: pids.length },
          );
        }

        if (!islandExists({ name }).exists) {
          return fail('岛上什么都没有，先 desktop_island_launch 起一个。');
        }
        const listR = await listIslandWindows({ name });
        if (!listR.ok) return fail(`看不了岛上的窗口：${listR.text}`);
        const target = pickWindow(listR.windows, window);
        if (!target) return fail(`没找到目标窗口${window ? `（标题含「${window}」）` : ''}。\n${describeWindows(listR.windows)}`);

        let hwnd = target.hwnd;
        let where = `${target.cls}${target.title ? ` · ${target.title}` : ''}`;
        // 控件自己的客户区尺寸（点它的中心要用）；没控件时用窗口的
        let box = { width: Math.max(1, target.clientWidth), height: Math.max(1, target.clientHeight) };
        if (control) {
          const kids = await listIslandChildren({ name, hwnd: target.hwnd });
          if (!kids.ok) return fail(`看不了窗口里的控件：${kids.text}`);
          const needle = String(control).toLowerCase();
          const hit = (kids.children ?? []).find((c) => String(c.cls).toLowerCase().includes(needle));
          if (!hit) {
            return fail(
              `这个窗口里没有类名含「${control}」的控件。现有：\n`
              + (kids.children ?? []).map((c) => `· ${c.cls}`).join('\n'),
            );
          }
          hwnd = hit.hwnd;
          box = { width: Math.max(1, hit.clientWidth), height: Math.max(1, hit.clientHeight) };
          where = `${hit.cls}（在 ${where} 里）`;
        }

        if (action === 'click') {
          // 有控件就点它的中心（模型不用算坐标）；没控件才用给的 x/y，并且照样过越界校验。
          const planPoint = control
            ? { x: Math.floor(box.width / 2), y: Math.floor(box.height / 2) }
            : { x: Number(x), y: Number(y) };
          const plan = planIslandMessages({ kind: 'click', point: planPoint, clientSize: box });
          if (!plan.ok) return fail(`没点：${plan.text}`, { code: plan.code });
          const sent = await postIslandMessages({ name, hwnd, ops: plan.ops });
          if (!sent.ok) return fail(`点不下去：${sent.text}`);
          return ok(
            `已在「${where}」${control ? '的中心' : `（${planPoint.x},${planPoint.y}）`}点了一下。\n`
            + '点完建议 desktop_island_observe 截一张确认 —— 窗口消息发出去不等于界面真的变了。',
            { where, point: planPoint },
          );
        }

        const body = String(text ?? '');
        if (!body) return fail('要输入的文字是空的。');
        const plan = planIslandMessages({ kind: action === 'setText' ? 'setText' : 'type', text: body });
        if (!plan.ok) return fail(`没输入：${plan.text}`, { code: plan.code });
        const ops = action === 'type' ? plan.ops.map((o) => ({ ...o, delayMs: 8 })) : plan.ops;
        const sent = await postIslandMessages({ name, hwnd, ops });
        if (!sent.ok) return fail(`输入失败：${sent.text}`);

        // 回读确认：读回来对不上就是没打进去（这条比"发送成功"有意义得多）
        let back = null;
        for (let i = 0; i < 8; i += 1) {
          const r = await readIslandText({ name, hwnd });
          if (r.ok && String(r.text ?? '').includes(body)) {
            back = String(r.text ?? '');
            break;
          }
          back = r.ok ? String(r.text ?? '') : null;
          await sleep(120);
        }
        if (back == null) {
          return ok(`已发 ${sent.sent} 条消息到「${where}」，但读不回来 —— 无法确认打进去了。`, { where, sent: sent.sent });
        }
        if (!back.includes(body)) {
          return fail(
            `发了 ${sent.sent} 条消息，但控件里读不到这段文字（现在是「${back.slice(0, 80)}」）。\n`
            + '多半是这个控件不吃窗口消息（现代合成应用常见）—— 别当成功，改用 setText，或者换条路。',
            { where, readBack: back.slice(0, 200) },
          );
        }
        return ok(`已在「${where}」输入 ${body.length} 字，回读确认一致。`, { where, readBack: back.slice(0, 200) });
      },
    }),
  ];
}

