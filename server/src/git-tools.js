/**
 * Git 工具：让负责人/主 Bot 在**授权项目内**做普通 Git 操作。
 *
 * 对应规格 §7（Git 权限与工作区策略）与 P0-6。
 *
 * ## 能力边界由 git-ops.js 的白名单决定，不在这里
 *
 * 这个文件只做三件事：把工具参数收成 git-ops 的 op、把结果讲成人话、
 * 提交后做一次"退出码 + HEAD 是否前进"的核对（规格 §7.1：结果真实性）。
 *
 * ## 为什么不给 push
 *
 * G2（push/merge）要走用户确认，而确认框架（P0-4）还没做。
 * 先提供一个"能推但只写日志"的假确认比不提供更糟 ——
 * 用户会以为那两个字挡住了什么。
 *
 * ## hooks 会跑
 *
 * commit 时不传 `--no-verify`（规格 §7.1 禁止静默关闭项目要求）。
 * 跑过哪些 hooks 会写进返回值和审计，用户事后能查到。
 */
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './util.js';
import {
  runGit, parseStatus, verifyCommitLanded, currentHead, listActiveHooks,
  GIT_OPERATIONS, REFUSED_OPERATIONS, locateGit,
} from './git-ops.js';

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const fail = (text, details = {}) => ({ content: [{ type: 'text', text }], details, isError: true });

/**
 * 解析"要操作哪个仓库"。
 *
 * ★ 只接受工作目录**之内**的路径。
 *
 * 规格 §6.1 要求"路径使用最终资源标识"，而最容易犯的错是让模型
 * 传一个 `..` 跳出去操作别的项目。所以这里先落成绝对路径，
 * 再确认它在 workspace 里 —— 越界直接拒绝，不做"警告后继续"。
 */
function resolveRepo(inputPath) {
  const raw = String(inputPath ?? '').trim() || '.';
  const full = path.resolve(config.workspace, raw);
  const rel = path.relative(config.workspace, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return full;
}

function describeStatus(parsed) {
  const lines = [`分支：${parsed.branch || '(未知)'}${parsed.ahead ? ` ↑${parsed.ahead}` : ''}${parsed.behind ? ` ↓${parsed.behind}` : ''}`];
  const section = (title, list) => {
    if (!list.length) return;
    lines.push(`${title}（${list.length}）：`);
    for (const f of list.slice(0, 30)) lines.push(`  ${f}`);
    if (list.length > 30) lines.push(`  …还有 ${list.length - 30} 个`);
  };
  section('已暂存', parsed.staged);
  section('已修改', parsed.modified);
  section('已删除', parsed.deleted);
  section('未跟踪', parsed.untracked);
  if (lines.length === 1) lines.push('工作区干净，没有未提交的改动。');
  return lines.join('\n');
}

/**
 * 构造 git 工具集。
 *
 * @param {object} p
 * @param {object} p.runner
 * @param {object} p.store
 * @param {string} p.roomId
 * @param {string} p.botId
 */
export function buildGitTools({ runner, store, roomId, botId }) {
  /**
   * 统一入口：跑一次 git，失败就说清原因。
   * @returns {{ok:true, res:object, repo:string}|{ok:false, text:string}}
   */
  function run({ repoDir, op, params }) {
    const repo = resolveRepo(repoDir);
    if (!repo) {
      return { ok: false, text: `只能在你的工作目录里操作仓库（${config.workspace}）。指定的路径在目录之外。` };
    }
    const res = runGit({ repoDir: repo, op, params });
    if (res.refused) return { ok: false, text: res.error };
    // ★ 默认仓库是工作目录本身，而工作目录通常不是仓库（里面才是）。
    //   直接抛 "不在任何 git 仓库里" 会让人以为是权限问题，所以补一句怎么用。
    if (!res.ok && /不在任何 git 仓库/.test(String(res.error ?? ''))) {
      let hint = `「${path.relative(config.workspace, repo) || '.'}」不是 git 仓库。`;
      try {
        const subs = fs.readdirSync(repo, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => e.name)
          .filter((n) => { try { return fs.existsSync(path.join(repo, n, '.git')); } catch { return false; } });
        hint += subs.length
          ? `工作目录下这些是仓库：${subs.slice(0, 10).join('、')}。用 repo 参数指定其中之一。`
          : '工作目录下没有 git 仓库。';
      } catch { /* 读不出来就只给前半句 */ }
      return { ok: false, text: hint };
    }
    return { ok: true, res, repo };
  }

  /** 每次操作都留一条审计（规格 §5.5）。 */
  function audit({ op, repo, res, extra = {} }) {
    try {
      store.addAdminAction({
        action: `git.${op}`,
        level: GIT_OPERATIONS[op]?.mutates ? 'data' : 'probe',
        label: `git ${op}${res.ok ? '' : '（失败）'}`,
        method: 'GIT',
        path: path.relative(config.workspace, repo) || '.',
        deviceId: botId,
        deviceName: store.getBot(botId)?.name ?? '',
        ...extra,
      });
    } catch { /* 审计失败不该挡住操作 */ }
  }

  return [
    // ---------------------------------------------------------------- 读
    defineTool({
      name: 'git_status',
      label: '看仓库状态',
      description:
        '看某个仓库现在有哪些改动（已暂存/已修改/未跟踪），以及分支与领先落后情况。'
        + '开始干活前先看一眼，避免把别人的改动一起提交。',
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: '仓库目录（相对工作目录），默认用工作目录本身' })),
      }),
      execute: async (_toolCallId, { repo }) => {
        const r = run({ repoDir: repo, op: 'status' });
        if (!r.ok) return fail(r.text);
        if (!r.res.ok) return fail(r.res.error ?? 'git status 失败');
        const parsed = parseStatus(r.res.stdout);
        audit({ op: 'status', repo: r.repo, res: r.res });
        return ok(describeStatus(parsed), { ...parsed, layout: r.res.layout, git: r.res.git });
      },
    }),

    defineTool({
      name: 'git_diff',
      label: '看改了什么',
      description:
        '看具体改动内容。默认看工作区未暂存的改动；staged=true 看已暂存的。'
        + '提交前用它核对一遍，别把不该交的东西交上去。',
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: '仓库目录（相对工作目录）' })),
        path: Type.Optional(Type.String({ description: '只看这个文件/目录' })),
        staged: Type.Optional(Type.Boolean({ description: '看已暂存的改动（相当于 git diff --cached）' })),
      }),
      execute: async (_toolCallId, { repo, path: p, staged }) => {
        const r = run({ repoDir: repo, op: 'diff', params: { path: p, staged } });
        if (!r.ok) return fail(r.text);
        if (!r.res.ok) return fail(r.res.error ?? 'git diff 失败');
        audit({ op: 'diff', repo: r.repo, res: r.res });
        const body = (r.res.stdout || '').trim();
        if (!body) return ok(staged ? '没有已暂存的改动。' : '工作区没有未暂存的改动。');
        return ok(body, { chars: body.length, truncated: r.res.truncated === true });
      },
    }),

    defineTool({
      name: 'git_log',
      label: '看提交历史',
      description: '看最近的提交（谁、什么时候、改了什么）。想了解这个仓库怎么演进的用它。',
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: '仓库目录（相对工作目录）' })),
        limit: Type.Optional(Type.Number({ description: '看多少条，默认 20，最多 100' })),
      }),
      execute: async (_toolCallId, { repo, limit }) => {
        const r = run({ repoDir: repo, op: 'log', params: { limit } });
        if (!r.ok) return fail(r.text);
        if (!r.res.ok) return fail(r.res.error ?? 'git log 失败');
        audit({ op: 'log', repo: r.repo, res: r.res });
        return ok((r.res.stdout || '').trim() || '还没有提交。', {});
      },
    }),

    defineTool({
      name: 'git_show',
      label: '看某次提交/某个版本',
      description:
        '看某次提交改了什么（默认看 HEAD）。想知道"上一版这段是怎么写的"、"这个 commit 动了哪些文件"时用它。'
        + '看文件内容用 `ref` 指定版本，例如 `ref: "HEAD~1:src/app.js"`。',
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: '仓库目录（相对工作目录）' })),
        ref: Type.Optional(Type.String({ description: '看哪个版本，默认 HEAD。可以写 HEAD~1、分支名、或 HEAD~1:path/to/file' })),
      }),
      execute: async (_toolCallId, { repo, ref }) => {
        const r = run({ repoDir: repo, op: 'show', params: { ref } });
        if (!r.ok) return fail(r.text);
        if (!r.res.ok) return fail(r.res.error ?? 'git show 失败');
        audit({ op: 'show', repo: r.repo, res: r.res });
        const body = (r.res.stdout || '').trim();
        return ok(body || '（这个版本没有内容）', { truncated: r.res.truncated === true });
      },
    }),

    defineTool({
      name: 'git_branches',
      label: '看分支',
      description: '看本地和远端分支，以及各自的最新提交。判断该在哪个分支上干活时用它。',
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: '仓库目录（相对工作目录）' })),
      }),
      execute: async (_toolCallId, { repo }) => {
        const r = run({ repoDir: repo, op: 'branches' });
        if (!r.ok) return fail(r.text);
        if (!r.res.ok) return fail(r.res.error ?? 'git branch 失败');
        audit({ op: 'branches', repo: r.repo, res: r.res });
        return ok((r.res.stdout || '').trim() || '没有分支。');
      },
    }),

    // ---------------------------------------------------------------- 写
    defineTool({
      name: 'git_add',
      label: '把改动加进暂存区',
      description:
        '把某些文件（或全部改动）加进暂存区，准备提交。'
        + '**别简单粗暴加全部**：先 git_status 看清楚，只加你改的那些。',
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: '仓库目录（相对工作目录）' })),
        paths: Type.Optional(Type.Array(Type.String(), { description: '要暂存的文件/目录；不填等于 git add -A' })),
      }),
      execute: async (_toolCallId, { repo, paths }) => {
        const r = run({ repoDir: repo, op: 'add', params: { paths } });
        if (!r.ok) return fail(r.text);
        if (!r.res.ok) return fail(r.res.error ?? 'git add 失败');
        audit({ op: 'add', repo: r.repo, res: r.res });
        // add 之后立刻回读状态：让模型看到"实际进了什么"，而不是"我以为进了什么"
        const st = runGit({ repoDir: r.repo, op: 'status' });
        const parsed = st.ok ? parseStatus(st.stdout) : null;
        return ok(
          `已暂存。\n${parsed ? describeStatus(parsed) : r.res.stdout}`,
          { staged: parsed?.staged ?? [] },
        );
      },
    }),

    defineTool({
      name: 'git_commit',
      label: '提交（本地）',
      description:
        '在本地创建一次提交。**这是普通本地提交**，不会推到远端 —— '
        + 'push 要用户确认（现在还没做确认框架，所以这里不提供 push）。\n'
        + '提交信息写清楚"改了什么、为什么"，不要写"update"。\n'
        + '注意：项目的 git hooks 会照常执行（不会偷偷跳过）。',
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: '仓库目录（相对工作目录）' })),
        message: Type.String({ description: '提交信息。第一行说清改了什么' }),
        paths: Type.Optional(Type.Array(Type.String(), { description: '只提交这些文件（会先 add 再 commit）' })),
      }),
      execute: async (_toolCallId, { repo, message, paths }) => {
        const target = resolveRepo(repo);
        if (!target) return fail(`只能在你的工作目录里操作仓库（${config.workspace}）。`);

        const msg = String(message ?? '').trim();
        if (!msg) return fail('提交信息不能为空。写清楚改了什么。');

        // ★ 提交前记下 HEAD：hooks 可能 exit 0 但什么都没做，
        //   只信退出码不够（规格 §7.1「结果真实性」）。
        const beforeHead = currentHead({ repoDir: target });

        // 有 paths 就先 add 指定的，没有就提交已暂存的（不隐式 -A，
        // 那会把别人的改动一起卷进来）
        if (Array.isArray(paths) && paths.length) {
          const added = runGit({ repoDir: target, op: 'add', params: { paths } });
          if (!added.ok) return fail(added.error ?? 'git add 失败');
        }

        const res = runGit({ repoDir: target, op: 'commit', params: { message: msg } });
        audit({ op: 'commit', repo: target, res });
        if (!res.ok) {
          return fail(
            `${res.error ?? 'git commit 失败'}\n\n`
            + '（如果是因为没有暂存的改动，先 git_add；如果是 hooks 拦下的，看上面的输出 —— '
            + '那是项目自己的要求，不要用 --no-verify 绕过）',
          );
        }

        // 核对这次提交是不是真的产生了
        const verified = verifyCommitLanded({ beforeHead, repoDir: target });
        const hooks = listActiveHooks({ repoDir: target });
        const afterHead = verified.afterHead ?? currentHead({ repoDir: target });

        if (beforeHead && afterHead && beforeHead === afterHead) {
          // 退出码 0 但 HEAD 没动：可能是 --allow-empty，也可能是 hooks 改了行为
          return fail(
            `git commit 报告成功，但 HEAD 没有前进（还是 ${afterHead}）—— 这次提交实际没产生。\n`
            + `原始输出：${(res.stdout || '').slice(0, 400)}`,
          );
        }

        const lines = [`已提交（本地）：${afterHead || '(新仓库)'}`];
        if (res.stdout) lines.push(res.stdout.trim().slice(0, 800));
        if (hooks.length) {
          lines.push(`这次提交时仓库里有这些 hooks（它们照常执行了，没有跳过）：${hooks.join('、')}`);
        }
        lines.push('这是本地提交。要推到远端得由用户确认 —— 现在还没做确认框架，所以 push 不可用。');
        log(`📦 ${store.getBot(botId)?.name ?? botId} 在 ${path.basename(target)} 提交了 ${afterHead}`);
        return ok(lines.join('\n'), { head: afterHead, hooks, beforeHead });
      },
    }),
  ];
}

/** 让提示词能说明"现在能不能 push"（不能）。 */
export function gitCapabilityNote() {
  const git = locateGit();
  if (!git.ok) {
    return '这台机器上没找到 Git：' + git.error;
  }
  return `Git ${git.version}（${git.source}）。当前可用：${Object.keys(GIT_OPERATIONS).join('、')}。`
    + `push/merge/reset 等要用户确认，暂时不提供。`;
}

export { REFUSED_OPERATIONS };
