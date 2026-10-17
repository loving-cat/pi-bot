/**
 * 工具调用前的钩子：可以**改写入参**或**直接拦下**。
 *
 * 规则存在 `data/hooks.json`，例：
 *   [
 *     { "id": "no-npm-publish", "enabled": true,
 *       "when": { "tool": "bash", "pattern": "npm\\s+publish" },
 *       "action": "block", "note": "发布要人工来做" },
 *     { "id": "pin-python", "enabled": true,
 *       "when": { "tool": "bash", "pattern": "^python " },
 *       "action": "rewrite", "rewrite": "./.venv/bin/python " }
 *   ]
 *
 * 判定是纯函数（applyHooks），读写与校验在这里；执行点在 policy-hook.js。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './util.js';

const FILE = path.join(config.dataDir, 'hooks.json');

/** 允许的动作 */
const ACTIONS = new Set(['block', 'rewrite']);

/** 取命令文本（不同工具字段名不一样） */
function commandOf(tool, input = {}) {
  if (typeof input?.command === 'string') return input.command;
  if (typeof input?.cmd === 'string') return input.cmd;
  return '';
}

/**
 * 校验一条规则；返回 null 表示合法。
 */
export function validateHook(rule = {}) {
  if (!rule || typeof rule !== 'object') return '规则必须是一个对象';
  if (!ACTIONS.has(rule.action)) return 'action 只能是 block 或 rewrite';
  if (rule.action === 'rewrite' && typeof rule.rewrite !== 'string') {
    return 'rewrite 动作要给出 rewrite 字段（替换成什么）';
  }
  const when = rule.when ?? {};
  // rewrite 的语义是"把命令里的某段换成另一段"：没有 pattern 就无从替换，
  // 而空正则会匹配在字符串开头，表现为"把替换串插到命令前面"，非常反直觉。
  if (rule.action === 'rewrite' && typeof when.pattern !== 'string') {
    return 'rewrite 必须配 when.pattern（指明要替换命令里的哪一段）';
  }
  if (when.tool !== undefined && typeof when.tool !== 'string') return 'when.tool 要是字符串';
  for (const key of ['pattern', 'pathPattern']) {
    if (when[key] === undefined) continue;
    if (typeof when[key] !== 'string') return `when.${key} 要是字符串`;
    try {
      new RegExp(when[key]);
    } catch (err) {
      return `when.${key} 不是合法正则：${err?.message || err}`;
    }
  }
  if (!when.tool && !when.pattern && !when.pathPattern) {
    return 'when 里至少要有 tool / pattern / pathPattern 之一';
  }
  return null;
}

export function normalizeHooks(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((rule) => !validateHook(rule)).slice(0, 100);
}

/** 读规则；文件坏了就当没有（不能让钩子文件把服务端拖挂） */
export function loadHooks() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return normalizeHooks(raw);
  } catch {
    return [];
  }
}

export function saveHooks(list) {
  const clean = normalizeHooks(list);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(clean, null, 2));
  return clean;
}

function matches(rule, tool, input) {
  if (rule.enabled === false) return false;
  const when = rule.when ?? {};
  if (when.tool && when.tool !== '*' && when.tool !== tool) return false;
  if (when.pattern) {
    const text = commandOf(tool, input);
    if (!text) return false;
    try {
      if (!new RegExp(when.pattern, 'm').test(text)) return false;
    } catch {
      return false;
    }
  }
  if (when.pathPattern) {
    const p = typeof input?.path === 'string' ? input.path : '';
    if (!p) return false;
    try {
      if (!new RegExp(when.pathPattern).test(p)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 依次套用规则（纯函数）。
 *
 * @returns {{blocked:boolean, reason?:string, input:object, applied:string[]}}
 */
export function applyHooks(rules, { tool, input = {} } = {}) {
  let current = { ...(input ?? {}) };
  const applied = [];
  for (const rule of rules ?? []) {
    if (!matches(rule, tool, current)) continue;
    if (rule.action === 'block') {
      return {
        blocked: true,
        reason:
          `这次操作被钩子拦下了${rule.id ? `（${rule.id}）` : ''}` +
          `${rule.note ? `：${rule.note}` : ''}。请换一种做法，或让用户手动执行。`,
        input: current,
        applied: [...applied, rule.id ?? 'block'],
      };
    }
    if (rule.action === 'rewrite') {
      const command = commandOf(tool, current);
      if (!command) continue;
      const rewritten = command.replace(new RegExp(rule.when.pattern, 'm'), rule.rewrite);
      current =
        typeof current.command === 'string'
          ? { ...current, command: rewritten }
          : { ...current, cmd: rewritten };
      applied.push(rule.id ?? 'rewrite');
      log(`🪝 钩子改写命令：${command.slice(0, 60)} → ${rewritten.slice(0, 60)}`);
    }
  }
  return { blocked: false, input: current, applied };
}
