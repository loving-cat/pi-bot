/**
 * 「后台浏览器」工具：调研专用（规格 `spec-intent-and-habits-v1.md` §1）。
 *
 * ## 它不是 ego 的替代，是**另一档**
 *
 * | 需求 | 工具 |
 * |---|---|
 * | 用户**要看**（打开给我看、播放、演示） | `ego_browser` —— 在你眼前那个浏览器里 |
 * | 用户只要**结果**（查资料、抓数据、核对口径） | **这个** —— 岛里的浏览器 / 无头，你看不见 |
 * | 只要 HTML、不需要 JS | `web_fetch` 更省 |
 *
 * 为什么要有这一档：调研常常要**登录态 + JS 渲染**，而之前只有 ego 同时具备这两点
 * —— 于是调研会把浏览器弹到用户屏幕上，还拿走控制权。实测过：
 * 用户在群里让它"调研 xAI 的接口细节"，它开了 ego，用户看到一整块不能点的页面
 * 底下挂着 "Agent is in control"。
 *
 * ## 权威性
 *
 * 它驱动的是**真 Chromium**（不是无头解析器）：默认 `mode: 'island'` 在独立桌面上
 * 开真窗口（用户看不见），靠 CDP 驱动；需要更省资源时 `mode: 'headless'`。
 * 登录态用用户浏览器配置的**副本**（不会同步回本机）。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './config.js';
import { screenshotPath } from './desktop-observe.js';
import { openBrowser, closeHeadless, listHeadless } from './headless-browser.js';

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const fail = (text, details = {}) => ({ content: [{ type: 'text', text }], details, isError: true });

/** 页面内容摘要：正文太长会给模型灌一屏，这里只留开头一段 + 长度。 */
const MAX_TEXT = 4000;

export function buildResearchBrowserTools({ botId, roomId = '' } = {}) {
  const sessionKey = String(botId || roomId || 'default');
  const withSession = async () => {
    const r = await openBrowser({
      key: sessionKey,
      mode: 'island',
      app: 'chrome.exe',
      shareLogin: true,
      dataDir: config.dataDir,
    });
    return r;
  };

  return [
    defineTool({
      name: 'browser_research',
      label: '★ 后台浏览器（调研用，不占屏幕）',
      description:
        '**调研专用**：在独立桌面上开一个真浏览器（你看不见它），用 CDP 驱动它读页面、跑 JS、截图。\n'
        + '\n'
        + '什么时候用它：要查资料、抓数据、核对官方口径，而**用户只要结果**（不需要看见那个浏览器）。\n'
        + '什么时候**不要**用它：用户要看（"打开给我看"/"播放这个"）→ 用 ego_browser。\n'
        + '\n'
        + '它会带上用户浏览器配置的**副本**（Cookies 登录态），所以能读需要登录的页面；\n'
        + '那份副本不同步回本机 —— 你在里面登录/退出，用户那边不受影响。\n'
        + '\n'
        + 'action 用法：\n'
        + '· open  + url：打开页面，返回标题 + 正文开头（够判断内容对不对）\n'
        + '· eval  + js ：在页面里跑一段 JS，返回它的值（异步也行，`await` 会被等）\n'
        + '· shot  ：截一张整页图存到工作目录，返回路径（要看图就自己用 send_image 发）\n'
        + '· close ：收掉浏览器（用完记得收，它占着一个进程）',
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal('open'), Type.Literal('eval'), Type.Literal('shot'), Type.Literal('close'),
        ], { description: 'open / eval / shot / close' }),
        url: Type.Optional(Type.String({ description: 'open 要打开的地址' })),
        js: Type.Optional(Type.String({ description: 'eval 要执行的表达式（返回可 JSON 化的值）' })),
        mode: Type.Optional(Type.Union([
          Type.Literal('island'), Type.Literal('headless'),
        ], { description: 'island=另一张桌面上的真窗口（默认，兼容性最好）；headless=无窗口（更省，部分站点会识别）' })),
      }),
      execute: async (_toolCallId, { action, url, js, mode }) => {
        if (action === 'close') {
          const r = await closeHeadless({ key: sessionKey });
          return ok(r.alreadyClosed ? '本来就没开着。' : '已收掉后台浏览器。');
        }

        const opened = mode === 'headless'
          ? await openBrowser({ key: sessionKey, mode: 'headless', app: 'chrome.exe', shareLogin: true, dataDir: config.dataDir })
          : await withSession();
        if (!opened.ok) {
          return fail(
            `后台浏览器起不来：${opened.text}\n`
            + '（没有可用浏览器时，纯文本抓取可以退到 web_fetch —— 但它拿不到 JS 渲染和登录态。）',
            { code: opened.code },
          );
        }
        const session = opened.session;

        if (action === 'open') {
          const target = String(url ?? '').trim();
          if (!target) return fail('要打开哪个地址？给 url。');
          await session.navigate(target);
          // 等页面稳定：`load` 之后还有 JS 在渲染，给一小会儿
          await new Promise((r) => setTimeout(r, 800));
          const info = await session.evaluate(`(() => {
            const t = document.title || '';
            const body = (document.body && document.body.innerText) || '';
            return { title: t, url: location.href, text: body.slice(0, ${MAX_TEXT}), length: body.length };
          })()`);
          const meta = `标题：${info?.title || '(无)'}\n地址：${info?.url || target}\n正文长度：${info?.length ?? 0} 字`;
          return ok(`${meta}\n\n--- 正文开头 ---\n${(info?.text ?? '').trim() || '(空)'}`, {
            title: info?.title ?? '', url: info?.url ?? target, length: info?.length ?? 0,
            mode: session.mode ?? 'headless',
          });
        }

        if (action === 'eval') {
          const expr = String(js ?? '').trim();
          if (!expr) return fail('要执行什么？给 js。');
          const value = await session.evaluate(expr);
          const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
          return ok((text ?? '(空)').slice(0, MAX_TEXT), { mode: session.mode ?? 'headless' });
        }

        // shot
        const spot = screenshotPath({ dataDir: config.dataDir, taskId: null, botId });
        const png = await session.screenshot({ fullPage: true });
        fs.mkdirSync(path.dirname(spot.file), { recursive: true });
        fs.writeFileSync(spot.file, png);
        return ok(`已截图：${spot.file}（${Math.round(png.length / 1024)} KB）`, {
          file: spot.file, bytes: png.length, mode: session.mode ?? 'headless',
        });
      },
    }),
  ];
}

export { listHeadless };
