/**
 * 极小的 CDP（Chrome DevTools Protocol）客户端。
 *
 * ## 为什么需要它
 *
 * 规格 `docs/spec-intent-and-habits-v1.md` §1 把 GUI 分成两档：用户要看的走 ego，
 * 用户只要结果的走后台。而"后台但要跑 JS + 要登录态"这一档，之前**没有工具**：
 *
 *   · `web_fetch`：拿不到 JS 渲染后的内容，也带不了登录态；
 *   · 岛里的浏览器：有窗口（虽然用户看不见），但驱动只能靠窗口消息 —— 对 Chromium 不可靠；
 *   · ego：有登录态、能跑 JS，但**窗口就在用户屏幕上**。
 *
 * 于是 bot 只能选 ego，于是用户的屏幕就弹出来了。缺的那一档是：
 * **无头 Chromium + CDP**（无窗口、真浏览器、登录态用配置快照）。
 *
 * ## 这个文件只做协议
 *
 * 不管进程、不管登录态、不管重试 —— 那些在 `headless-browser.js`。
 * 这里只负责：连上 ws、发一条命令、等对应的回包、关掉。
 *
 * ★ 一定要按 `id` 对回包：CDP 会把**事件**（`Runtime.consoleAPICalled` 之类）
 *   和**回包**混在一条流里发回来，按顺序取第一条会拿到事件，然后永远等不到结果。
 */
import { WebSocket } from 'ws';

/** 单条命令默认超时。页面卡住时不能让调用方一直等。 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * 连上一个 CDP 端点。
 *
 * @param {object} p
 * @param {string} p.wsUrl 形如 `ws://127.0.0.1:PORT/devtools/page/<id>`
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{send:Function, close:Function, wsUrl:string}>}
 */
export async function connectCdp({ wsUrl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = String(wsUrl ?? '');
  if (!url.startsWith('ws://')) throw new Error(`不是 ws 端点：${url}`);

  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  let seq = 0;
  /** id → {resolve, reject, timer} */
  const pending = new Map();
  const events = [];

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连 CDP 超时')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`连 CDP 失败：${err?.message ?? err}`));
    });
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(`${msg.error.message ?? 'CDP 错误'}（${msg.error.code ?? '?'}）`));
      else waiter.resolve(msg.result ?? {});
      return;
    }
    // 事件：留最近一批给诊断用（不消费，也不阻塞）
    events.push(msg);
    if (events.length > 200) events.shift();
  });

  const send = (method, params = {}, { timeout = timeoutMs } = {}) =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error('CDP 连接已关闭'));
        return;
      }
      seq += 1;
      const id = seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时（${timeout}ms）`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`发不出去：${err?.message ?? err}`));
      }
    });

  const close = () => {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('CDP 已关闭'));
    }
    pending.clear();
    try {
      ws.close();
    } catch { /* 已经关了 */ }
  };

  return { send, close, wsUrl: url, recentEvents: () => events.slice() };
}

/**
 * 在页面里跑一段 JS，返回它 `await` 之后的 JSON 值。
 *
 * ★ 用 `awaitPromise: true` + `returnByValue: true`：页面里的异步操作
 *   （`fetch`、`await new Promise(...)`）也能拿到结果；返回值必须是可 JSON 化的，
 *   拿到 DOM 节点会失败 —— 要节点就在表达式里自己取需要的字段。
 */
export async function evaluate(page, expression, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const text = String(expression ?? '');
  if (!text.trim()) throw new Error('表达式是空的');
  const res = await page.send(
    'Runtime.evaluate',
    { expression: text, awaitPromise: true, returnByValue: true, userGesture: true },
    { timeout },
  );
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(`页面里报错：${d.exception?.description ?? d.text ?? '未知'}`);
  }
  return res.result?.value ?? null;
}

/** 打开一个网址，等 `load` 事件。 */
export async function navigate(page, url, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const target = String(url ?? '').trim();
  if (!/^(https?|data|file|about):/i.test(target)) throw new Error(`不支持的地址：${target}`);
  await page.send('Page.enable', {}, { timeout });
  const res = await page.send('Page.navigate', { url: target }, { timeout });
  if (res.errorText) throw new Error(`打开失败：${res.errorText}`);
  return res.frameId ?? null;
}

/**
 * 截一张图（PNG base64）。**全页**而不是视口：调研常常要看到折叠以下的内容。
 */
export async function screenshot(page, { fullPage = true, timeout = 30_000 } = {}) {
  // ★ `captureBeyondViewport` 在"页面不是活动页"时会报 -32000
  //   （无头新建的空白页、或后台标签都可能碰上）。这不是致命错误，
  //   退一步只截视口 —— 有图总比报错好，调用方还能自己滚动再截。
  // ★ 先把它设成活动页：`captureScreenshot` 对"非活动页"会报 -32000
  //   （无头里新建的空白页、后台标签都会碰上）。失败不影响主流程。
  try {
    await page.send('Page.bringToFront', {}, { timeout: 3000 });
  } catch { /* 有些目标不支持，直接往下试 */ }

  const attempt = async (beyond) => {
    const res = await page.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: beyond },
      { timeout },
    );
    const data = res.data;
    if (!data) throw new Error('截图没有返回内容');
    return Buffer.from(data, 'base64');
  };
  try {
    return await attempt(fullPage);
  } catch (err) {
    if (!fullPage) throw err;
    return attempt(false);
  }
}
