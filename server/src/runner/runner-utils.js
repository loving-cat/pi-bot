/**
 * 运行器共享常量与无状态工具函数。
 *
 * 收口在底层叶子模块，供 `pi-runner.js` 及 `runner/*` 各子模块复用，避免循环依赖。
 */
import { bus as defaultBus } from '../bus.js';
import { metaFor } from '../attachments.js';
import { readContext } from '../context-budget.js';
import { MERGE_QUIET_MS } from '../merge-messages.js';

/**
 * 多久之内又来一条，算"连发"（于是开始攒）。
 *
 * 比静默窗口略长：用户打完一条、想了两秒、再打一条，
 * 那是两件事，不该合并；差几百毫秒紧挨着发的，才是一段话被拆开。
 */
export const MERGE_BURST_MS = MERGE_QUIET_MS + 900;

/**
 * 主动压缩的失败重试上限与放弃后的冷却时间。
 *
 * 2 次：首次 + 退避后一次。压缩本身很贵（要把几十万 tokens 读一遍），
 * 跟着 retry-policy 的 10 次重试会把用户拖上十几分钟。
 * 冷却 10 分钟：压缩失败通常是上下文真的太满或接口持续不可用，
 * 连着每轮都试只会把每一轮都拖慢。
 */
export const COMPACT_MAX_ATTEMPTS = 2;
export const COMPACT_COOLDOWN_MS = 10 * 60 * 1000;

export const MAX_STEP_TEXT = 200;

/** 重试前等多久（毫秒）：立刻重发大概率撞上同样的偶发问题 */
export const RETRY_DELAY_MS = 3000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sessionKey(roomId, botId) {
  return `${roomId}:${botId}`;
}

export function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
  }
  return '';
}

/** 附件 id -> 完整元信息（存进消息里的必须是对象，不然 App 渲染不了） */
export function hydrate(ids) {
  const out = [];
  for (const id of ids ?? []) {
    const meta = metaFor(id);
    if (!meta) continue;
    out.push({ id: meta.id, name: meta.name, mime: meta.mime, kind: meta.kind, size: meta.size });
  }
  return out;
}

export function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'task', 'text', 'name']) {
    if (typeof args[key] === 'string') return `${key}: ${args[key]}`.slice(0, MAX_STEP_TEXT);
  }
  try {
    const json = JSON.stringify(args);
    return json === '{}' ? '' : json.slice(0, MAX_STEP_TEXT);
  } catch {
    return '';
  }
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  const invoke = () => {
    last = Date.now();
    timer = null;
    const args = pendingArgs;
    pendingArgs = null;
    fn(...(args ?? []));
  };
  const wrapped = (...args) => {
    pendingArgs = args;
    const elapsed = Date.now() - last;
    if (elapsed >= ms) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke();
    } else if (!timer) {
      timer = setTimeout(invoke, ms - elapsed);
    }
  };
  wrapped.flush = () => {
    if (timer) clearTimeout(timer);
    invoke();
  };
  return wrapped;
}

/** 把一个会话的上下文占用推给界面（每轮结束、以及压缩前后都会调） */
export function emitContext(roomId, botId, session, evBus = defaultBus) {
  const u = readContext(session);
  if (!u) return;
  evBus.emit('event', { t: 'context', roomId, botId, ...u });
}
