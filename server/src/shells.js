/**
 * 后台进程注册表。
 *
 * 普通 bash 工具是阻塞的：跑一个 dev server 就只能等到超时。
 * 这里维护一组长任务：拿到 id 与 pid，之后可以读增量输出、写 stdin、主动结束。
 *
 * 约束：
 *   · 全局同时最多 MAX_SHELLS 个，超出拒绝（由调用方先结束旧的）；
 *   · 每个进程只保留最近 MAX_BUFFER_BYTES 字节输出，超出丢弃最早的并置 truncated；
 *   · 空闲超过 IDLE_MS 自动结束（防忘记关）；
 *   · 只登记输出与状态，不做任何命令判定 —— 规则在调用方（工具层）执行。
 */
import './child-env.js';
import { spawn } from 'node:child_process';
import { childEnv } from './child-env.js';
import { newId, now, log } from './util.js';

/**
 * 把累计输出裁到 maxBytes 以内（只留尾部）。
 *
 * 两个坑：
 *   · **只剩一块时也可能超**：一次大写入、或者 maxBytes 很小，
 *     只判 `chunks.length > 1` 会漏掉这种情况，最后一块必须按字节截断；
 *   · 按字节截断会切断多字节字符，所以要跳过开头那些 UTF-8 续字节，
 *     否则界面第一行会是个乱码方块。
 *
 * @param {{chunks:string[], bytes:number, truncated:boolean}} entry
 * @param {number} maxBytes
 */
export function trimChunks(entry, maxBytes) {
  while (entry.bytes > maxBytes) {
    if (entry.chunks.length > 1) {
      entry.bytes -= Buffer.byteLength(entry.chunks.shift());
      entry.truncated = true;
      continue;
    }
    const buf = Buffer.from(entry.chunks[0] ?? '', 'utf8');
    const tail = buf.subarray(Math.max(0, buf.length - maxBytes));
    let start = 0;
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
    const kept = tail.subarray(start).toString('utf8');
    entry.chunks[0] = kept;
    entry.bytes = Buffer.byteLength(kept);
    entry.truncated = true;
    return;
  }
}

export const MAX_SHELLS = 20;
export const MAX_BUFFER_BYTES = 64 * 1024;
export const IDLE_MS = 30 * 60 * 1000;

export class ShellRegistry {
  constructor({ maxShells = MAX_SHELLS, maxBytes = MAX_BUFFER_BYTES, idleMs = IDLE_MS } = {}) {
    this.maxShells = maxShells;
    this.maxBytes = maxBytes;
    this.idleMs = idleMs;
    /** @type {Map<string, object>} */
    this.shells = new Map();
    this.timer = setInterval(() => this.pruneIdle(), 60_000);
    this.timer.unref?.();
  }

  list({ roomId = null } = {}) {
    return [...this.shells.values()]
      .filter((s) => !roomId || s.roomId === roomId)
      .map((s) => ({
        id: s.id,
        pid: s.pid,
        command: s.command,
        running: s.running,
        exitCode: s.exitCode,
        startedAt: s.startedAt,
        bytes: s.bytes,
      }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id) {
    return this.shells.get(id) ?? null;
  }

  /**
   * 启动一个后台命令。
   * @returns {{id:string, pid:number|null, error?:string}}
   */
  start({ roomId, botId, command, cwd, env = null }) {
    if (this.shells.size >= this.maxShells) {
      return { id: null, pid: null, error: `后台进程已达上限（${this.maxShells} 个），先结束不用的` };
    }
    const text = String(command ?? '').trim();
    if (!text) return { id: null, pid: null, error: '命令为空' };

    const id = newId('sh_');
    let child;
    try {
      // shell: true —— 交给系统 shell 解析管道/重定向/引号；
      // 自己拼 argv 会在 Windows 上把引号转义成字面量（cmd 不认反斜杠转义）。
      child = spawn(text, {
        cwd,
        env: childEnv(process.env, env || undefined),
        windowsHide: true,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return { id: null, pid: null, error: String(err?.message || err) };
    }

    const entry = {
      id,
      command: text,
      roomId,
      botId,
      cwd,
      child,
      pid: child.pid ?? null,
      running: true,
      exitCode: null,
      signal: null,
      startedAt: now(),
      lastOutputAt: now(),
      bytes: 0,
      truncated: false,
      chunks: [],
      waiters: [],
    };
    this.shells.set(id, entry);

    const append = (buf) => {
      const text = buf.toString('utf8');
      if (!text) return;
      entry.chunks.push(text);
      entry.bytes += Buffer.byteLength(text);
      entry.lastOutputAt = now();
      trimChunks(entry, this.maxBytes);
      this.#notify(entry);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const finish = (code, signal) => {
      entry.running = false;
      entry.exitCode = code;
      entry.signal = signal ?? null;
      entry.endedAt = now();
      this.#notify(entry);
    };
    child.on('exit', finish);
    child.on('error', (err) => {
      append(Buffer.from(`\n[启动失败] ${err?.message || err}\n`));
      finish(null, null);
    });

    return { id, pid: entry.pid };
  }

  /** 当前累计输出（受 maxBytes 限制） */
  output(id) {
    const entry = this.shells.get(id);
    if (!entry) return null;
    return entry.chunks.join('');
  }

  /**
   * 读取输出。
   *
   * @param {string} id
   * @param {{since?:number, pattern?:string, waitMs?:number}} opts
   *   since   —— 只要这个字符位置之后的内容（前端翻页用）
   *   pattern —— 匹配到就置 matched=true
   *   waitMs  —— 等新输出最多等多久（毫秒，上限 10s）
   */
  async read(id, { since = 0, pattern = '', waitMs = 0 } = {}) {
    const entry = this.shells.get(id);
    if (!entry) return null;
    const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), 10_000);

    const snapshot = () => {
      const full = entry.chunks.join('');
      const from = Math.min(Math.max(Number(since) || 0, 0), full.length);
      const chunk = full.slice(from);
      return {
        id: entry.id,
        command: entry.command,
        running: entry.running,
        exitCode: entry.exitCode,
        signal: entry.signal,
        truncated: entry.truncated,
        offset: full.length,
        output: chunk,
        matched: pattern ? new RegExp(pattern, 'm').test(chunk) : false,
      };
    };

    let first = snapshot();
    while (pattern && !first.matched && entry.running && Date.now() < deadline) {
      await this.#waitForChange(entry, deadline - Date.now());
      first = snapshot();
    }
    if (!pattern && waitMs > 0 && entry.running && !first.output && Date.now() < deadline) {
      await this.#waitForChange(entry, deadline - Date.now());
      first = snapshot();
    }
    return first;
  }

  write(id, chars) {
    const entry = this.shells.get(id);
    if (!entry) return { ok: false, error: '没有这个后台进程' };
    if (!entry.running) return { ok: false, error: '进程已结束' };
    try {
      entry.child.stdin.write(String(chars ?? ''));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  kill(id) {
    const entry = this.shells.get(id);
    if (!entry) return { ok: false, error: '没有这个后台进程' };
    try {
      if (entry.running) entry.child.kill();
      return { ok: true, wasRunning: entry.running };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /** 结束并移除（用户确认不要了） */
  remove(id) {
    const hit = this.kill(id);
    this.shells.delete(id);
    return hit;
  }

  killRoom(roomId) {
    let n = 0;
    for (const [id, entry] of this.shells) {
      if (entry.roomId !== roomId) continue;
      try {
        if (entry.running) entry.child.kill();
      } catch (_) {}
      this.shells.delete(id);
      n++;
    }
    return n;
  }

  /** 清理空闲过久的进程 */
  pruneIdle(limit = this.idleMs) {
    const at = now();
    let n = 0;
    for (const [id, entry] of this.shells) {
      if (!entry.running && at - (entry.endedAt ?? entry.lastOutputAt) > limit) {
        this.shells.delete(id);
        n++;
        continue;
      }
      if (entry.running && at - entry.lastOutputAt > limit) {
        try {
          entry.child.kill();
        } catch (_) {}
        this.shells.delete(id);
        n++;
        log(`后台进程空闲超时已结束：${entry.command.slice(0, 60)}`);
      }
    }
    return n;
  }

  stopAll() {
    for (const entry of this.shells.values()) {
      try {
        if (entry.running) entry.child.kill();
      } catch (_) {}
    }
    this.shells.clear();
    clearInterval(this.timer);
  }

  #notify(entry) {
    const waiters = entry.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  #waitForChange(entry, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      entry.waiters.push(finish);
      setTimeout(finish, Math.max(50, timeoutMs));
    });
  }
}

/** 全局一份：工具层与服务端共用 */
export const shells = new ShellRegistry();
