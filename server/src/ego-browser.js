/**
 * ego-browser 集成：让 bot 能驱动用户的 ego lite 浏览器。
 *
 * ## 为什么不是一个 webview 面板
 *
 * ego lite 是独立的 Chromium 应用 + CLI（/Applications/ego lite.app，
 * ~/.local/bin/ego-browser），不是可以 link 进 Flutter 的 framework，
 * 也没有可嵌入的渲染控件或 CEF 子进程渲染通道。
 *
 * 所以集成方式是：把 ego 当成一个能给 agent 用的浏览器去驱动，
 * 而不是在界面里再嵌一个浏览器。
 *
 * ## 为什么让模型写脚本
 *
 * ego-browser 的用法是 ego-browser nodejs + 脚本：每次调用起一个
 * Node.js 进程，脚本里有 taskSpace / page 等 helper。这不是 Playwright，
 * 没有 locator() 那种链式 API。
 *
 * 硬造一层「简单参数 -> 脚本」的包装会丢掉它大部分能力（截图、CDP、
 * 多页协作、文件上传都靠脚本表达）。所以直接把脚本交给模型写，
 * 工具本身只负责：找 CLI、跑脚本、把输出和错误整理回去。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** CLI 候选路径：常见安装位置。 */
const CLI_CANDIDATES = [
  path.join(os.homedir(), '.local', 'bin', 'ego-browser'),
  '/opt/homebrew/bin/ego-browser',
  '/usr/local/bin/ego-browser',
];

/** 单次脚本最长跑多久（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 120000;

/** 找一个能用的 ego-browser CLI；找不到时返回命令名交给 PATH 解析。 */
export async function locateEgoBrowser() {
  for (const candidate of CLI_CANDIDATES) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续试下一个
    }
  }
  return 'ego-browser';
}

/**
 * 跑一段 ego-browser 脚本。
 *
 * 脚本写到临时文件再喂给 stdin —— 不用 -e 传参：脚本里必然有中文和引号，
 * 走命令行参数会被 shell 与平台转义规则搞坏（ego 自己的文档也这么建议）。
 */
export async function runEgoScript({ script, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const text = String(script ?? '').trim();
  if (!text) return { ok: false, output: '', error: '脚本是空的' };

  const cli = await locateEgoBrowser();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ego-'));

  try {
    return await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(cli, ['nodejs'], {
        cwd: dir,
        // 脚本通过 stdin 传入：heredoc 在 Windows/cmd 下没有，
        // 输入重定向各平台都支持，spawn 的 stdin 写入也最稳。
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 进程可能已退出
        }
        finish({
          ok: false,
          output: stdout,
          error: '脚本超过 ' + Math.round(timeoutMs / 1000) + ' 秒没结束，已终止',
        });
      }, timeoutMs);

      child.stdout.on('data', (d) => {
        stdout += d.toString();
        if (stdout.length > 200000) stdout = stdout.slice(-200000);
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 200000) stderr = stderr.slice(-200000);
      });
      child.on('error', (err) => {
        finish({
          ok: false,
          output: stdout,
          error:
            err?.code === 'ENOENT'
              ? 'ego-browser 命令不可用（没装或不在 PATH）'
              : String(err?.message || err),
        });
      });
      child.on('close', (code) => {
        // ★ ego-browser 把脚本的 console.log 写到 **stderr**，不是 stdout。
        //
        //   实测：`ego-browser nodejs < t.mjs` 里 console.log 的内容
        //   出现在 stderr 上，stdout 一直是空的。只读 stdout 会得到
        //   "ok: true 但没有任何输出"，模型以为脚本什么都没干。
        //   所以这里合并两路，并滤掉 ego 自己的 notice 行。
        const merged = [stdout, stderr]
          .map((s) => s.trim())
          .filter(Boolean)
          .join('\n');
        const cleaned = stripEgoNoise(merged);
        if (code === 0) {
          finish({ ok: true, output: cleaned });
          return;
        }
        finish({
          ok: false,
          output: cleaned,
          error: (cleaned || '退出码 ' + code).slice(-4000),
        });
      });

      child.stdin.end(text);
    });
  } finally {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结果
    }
  }
}

/**
 * 去掉 ego 自己打的噪音行。
 *
 * 它会往 stderr 写 [ego-browser:notice] 之类的提示（比如有新版本）。
 * 这些对模型没用，混在脚本输出里会干扰判断。
 */
function stripEgoNoise(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => !line.startsWith('[ego-browser:'))
    .join('\n')
    .trim();
}

/** 给模型看的用法说明。ego-browser 不是 Playwright，API 是它自己的。 */
export const EGO_USAGE_GUIDE = [
  'ego-browser 的用法（不是 Playwright）：',
  '',
  '脚本是 ESM，顶层可以用 await。这一段在 Node.js 里跑（不是网页里），',
  '所以 window/document/location 都不存在；要操作页面内容用 page.evaluate()。',
  '',
  '最小骨架：',
  '  const task = await taskSpace("任务名");',
  '  const page = task.page("p1");',
  '  await page.goto("https://example.com");',
  '  console.log(await page.snapshot());   // 看页面结构',
  '',
  '要点：',
  '- 整个目标只用一个 taskSpace；名字唯一，同名会复用。',
  '- 新空间默认已有 p1，直接 goto，不要另开页。',
  '- 每次调用都是新进程：脚本里的变量不保留，页面和标签会保留。',
  '- 复用页面用 goto()，不要每次开新页。',
  '- 只有 click/dblclick/hover/dragAndDrop/mouse.* 接受 label 选项。',
  '- 没有 locator()、getByRole()、expect() 这些 Playwright 方法；',
  '  需要更底层能力时用 page.evaluate() 或 page.cdp()。',
  '- 文件读写用绝对路径；process.env 不继承外层环境变量。',
].join('\n');

export { DEFAULT_TIMEOUT_MS };
