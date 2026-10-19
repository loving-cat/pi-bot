/**
 * 扫描本机 pi 已装好的技能与 MCP，让用户能一键导入而不是重新手打。
 *
 * 为什么：用户在终端里用 pi，早就装了一堆 skill 和 MCP；但 pi-bot 是独立进程，
 * 默认不加载这些（见 config.js 的 resourceSwitches）—— App 里是一张白纸，
 * 用户得把已经有的东西再手抄一遍，这没有道理。
 *
 * 两个原则：
 *   1. 只读，绝不改用户的 pi 配置。只 readdir / readFile，不写、不删。
 *   2. 导入是复制一份过来，不是引用。两边独立，想同步就再导一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SKILL_LIMITS, normalizeSkill } from './skills.js';
import { MCP_LIMITS, mcpNameError, normalizeMcpServer } from './mcp.js';

/** pi 的 agent 目录（跟 SDK 的 getAgentDir 保持一致） */
function agentDir() {
  return process.env.PI_CODING_AGENT_DIR
    ? process.env.PI_CODING_AGENT_DIR
    : path.join(os.homedir(), '.pi', 'agent');
}

/**
 * 解析 SKILL.md 的 frontmatter。
 *
 * 格式是：
 *   ---
 *   name: 名字
 *   description: 一句话说明
 *   ---
 *   正文…
 *
 * 解析要宽松：拿不到 frontmatter 就用目录名当标题、正文当做法 ——
 * 用户装了个格式不标准的 skill 也不该被跳过。
 */
function parseFrontmatter(text) {
  const out = { name: '', description: '', body: text };
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return out;
  const [, head, body] = m;
  out.body = body;

  // 逐行解析。YAML 有两种多行写法必须支持，否则摘要会变成 ">"：
  //   description: >        （折叠成一行，换行变空格）
  //     Build AI-powered…
  //     can use like…
  //   description: |        （保留换行）
  const lines = head.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^\s*([A-Za-z_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();

    // 块标量：> 折叠 / | 保留。后面的缩进行都算这个字段的内容。
    if (/^[>|][+-]?$/.test(value)) {
      const fold = value.startsWith('>');
      const buf = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        // 空行属于块内；非缩进行（且非空）说明块结束了
        if (next.trim() && !/^\s+/.test(next)) break;
        buf.push(next);
        i++;
      }
      const indent = Math.min(
        ...buf.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length),
        Infinity,
      );
      const stripped = buf.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      value = (fold ? stripped.join(' ').replace(/\s+/g, ' ') : stripped.join('\n')).trim();
    } else {
      // 单行：去掉包裹的引号
      value = value.replace(/^['"]|['"]$/g, '');
    }

    if (key === 'name') out.name = value;
    else if (key === 'description') out.description = value;
  }
  return out;
}

/**
 * 扫描本机已装的 skill。
 *
 * 支持两种布局：
 *   · `skills/<name>/SKILL.md`     —— pi 的标准布局
 *   · `skills/<name>/*.md`         —— 有些 skill 没有 SKILL.md（比如自带一堆
 *                                      文档的），取最大的那个 md 当正文
 *
 * @returns {Array<{dirName, title, summary, howto, source}>}
 */
export function scanLocalSkills() {
  const root = path.join(agentDir(), 'skills');
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // 没装过 skill，或者没有权限 —— 都不是错误
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let file = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(file)) {
      // 没有 SKILL.md：找一个 md 当正文（优先最大的，通常是主文档）
      try {
        const candidates = fs
          .readdirSync(dir)
          .filter((f) => f.toLowerCase().endsWith('.md'))
          .map((f) => {
            const full = path.join(dir, f);
            let size = 0;
            try { size = fs.statSync(full).size; } catch {}
            return { full, size };
          })
          .sort((a, b) => b.size - a.size);
        if (!candidates.length) continue; // 既没 SKILL.md 也没 md，跳过
        file = candidates[0].full;
      } catch {
        continue;
      }
    }

    let text = '';
    try {
      // 只读前 64KB：skill 正文可能很长，没必要全读进内存（也没必要全存进库）
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      text = buf.subarray(0, n).toString('utf8');
    } catch {
      continue;
    }
    if (!text.trim()) continue;

    const fm = parseFrontmatter(text);
    const title = (fm.name || entry.name).slice(0, SKILL_LIMITS.title);
    const body = fm.body.trim();
    if (!title || !body) continue;

    // 摘要：frontmatter 里的 description，否则正文第一段非标题行
    const summary =
      fm.description.slice(0, SKILL_LIMITS.summary) ||
      (body
        .split(/\r?\n/)
        .find((l) => l.trim() && !l.startsWith('#'))
        ?.trim()
        .slice(0, SKILL_LIMITS.summary) ?? '');

    out.push({
      dirName: entry.name,
      title,
      summary,
      // 正文过长会撑爆提示词：截断到上限，导入后用户还能在界面里编辑
      howto: body.slice(0, SKILL_LIMITS.howto),
      // 标一下来源，导入时能提示"这条是从本机 pi 拿的"
      source: file,
      truncated: body.length > SKILL_LIMITS.howto,
    });
  }
  return out;
}

/**
 * 扫描本机 pi 的 mcp.json。
 *
 * 只读，不写回。用户在终端里改 mcp.json，这边重新扫一次就能看到新的。
 *
 * @returns {Array<{name, type, command, args, env, url, headers, description}>}
 */
export function scanLocalMcpServers() {
  const file = path.join(agentDir(), 'mcp.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const servers = raw?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];

  const out = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (mcpNameError(name)) continue; // 名字不能被拼进工具名的一律跳过
    // pi 的 mcp.json 里，有 url 就是 http，否则是 stdio
    const type = cfg.url ? 'http' : 'stdio';
    out.push({
      name,
      type,
      ...(type === 'http'
        ? { url: String(cfg.url).slice(0, MCP_LIMITS.url), headers: cfg.headers ?? {} }
        : {
            command: String(cfg.command ?? '').slice(0, MCP_LIMITS.command),
            args: Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [],
            env: cfg.env ?? {},
            cwd: cfg.cwd ? String(cfg.cwd) : '',
          }),
      description: String(cfg.description ?? '').slice(0, MCP_LIMITS.description),
      // pi 的 exposure 是给终端 agent 的；导入到 bot 时统一用 direct
      // （bot 会话不会跑 codemode，deferred 反而让模型看不到工具）
      exposure: 'direct',
      // 导入过来默认**不启用**：用户点一次"启用"才真的开始连。
      // 因为 MCP 会起进程，不该在用户没意识到的时候就把机器占上。
      enabled: false,
      source: file,
    });
  }
  return out;
}

/**
 * 本机能力总览：给设置页用的。
 *
 * 每一条都标出"库里是否已经有过"（按名字/标题比对），
 * 这样界面能直接显示"已导入"而不是让用户点了才发现重复。
 */
export function scanLocalCapabilities({ existingSkills = [], existingMcp = [] } = {}) {
  const haveSkill = new Set(
    (Array.isArray(existingSkills) ? existingSkills : [])
      .map((s) => String(s?.title ?? '').trim().toLowerCase())
      .filter(Boolean),
  );
  const haveMcp = new Set(
    (Array.isArray(existingMcp) ? existingMcp : [])
      .map((s) => String(s?.name ?? '').trim().toLowerCase())
      .filter(Boolean),
  );

  const skills = scanLocalSkills().map((s) => ({
    ...s,
    imported: haveSkill.has(s.title.trim().toLowerCase()),
  }));
  const mcpServers = scanLocalMcpServers().map((s) => ({
    ...s,
    imported: haveMcp.has(s.name.trim().toLowerCase()),
  }));

  return {
    // 扫描根目录，让用户知道"从哪儿找的"
    scannedFrom: {
      skills: path.join(agentDir(), 'skills'),
      mcp: path.join(agentDir(), 'mcp.json'),
    },
    skills,
    mcpServers,
  };
}

/**
 * 从扫描结果造一条可入库的 skill（走同一套 normalizeSkill）。
 * @returns {object|null}
 */
export function localSkillToLibrary(entry = {}) {
  if (!entry?.title) return null;
  return normalizeSkill({
    title: entry.title,
    summary: entry.summary,
    howto: entry.howto,
    tags: [],
  });
}

/**
 * 从扫描结果造一条可入库的 MCP 服务（走同一套 normalizeMcpServer）。
 * @returns {object|null}
 */
export function localMcpToLibrary(entry = {}) {
  if (!entry?.name) return null;
  return normalizeMcpServer({
    name: entry.name,
    type: entry.type,
    description: entry.description,
    exposure: 'direct',
    enabled: false,
    ...(entry.type === 'http'
      ? { url: entry.url, headers: entry.headers }
      : {
          command: entry.command,
          args: entry.args,
          env: entry.env,
          cwd: entry.cwd,
        }),
  });
}
