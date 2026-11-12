/** 使用跨平台命令启动器执行有界 MCP stdio 探测，并回收探测进程。 */
import { StringDecoder } from 'node:string_decoder';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildChildEnv, hostLocale, instanceHomeDir, instanceTmpDir } from './child-env-typed.js';
import { spawnCommand } from './spawn-command.js';
import { stopMcpProbeProcess } from './mcp-probe-cleanup.js';
import { assertActive, parseMessage, probeError, PROBE_LIMITS, rpcResult } from './mcp-probe-protocol.js';

export function createStdioProbe(server, signal) {
  assertActive(signal);
  if (typeof server.command !== 'string' || !server.command.trim()) throw probeError('invalid_config');

  // 探测进程的私有目录：HOME 和 TMPDIR 都落在这里，不碰宿主的。
  // 用完即删（见 cleanup 里的实例清理）。
  const probeInstanceDir = mkdtempSync(path.join(os.tmpdir(), 'pi-probe-'));
  mkdirSync(path.join(probeInstanceDir, 'home'), { recursive: true });
  mkdirSync(path.join(probeInstanceDir, 'tmp'), { recursive: true });

  let child;
  try {
    child = spawnCommand(server.command, server.args ?? [], {
      cwd: server.cwd || undefined,
      // ★ 探测进程用**和运行时同一套类型化白名单**，不是 childEnv(process.env)。
      //
      //   原来这里是 childEnv(process.env, ...) —— 等于把服务端整份环境
      //   （含 PI_BOT_TOKEN、SSH_AUTH_SOCK、宿主 PATH）交给了 probe 起的子进程。
      //   MCP server 是被调用方，探一个来路不明的 server 时不该给它这些东西。
      //
      //   inheritEnv: false 明确告诉启动器不要并上 process.env；
      //   buildChildEnv 从空白开始只注入白名单键。
      env: buildChildEnv({
        kind: 'probe',
        homeDir: instanceHomeDir(probeInstanceDir),
        tmpDir: instanceTmpDir(probeInstanceDir),
        locale: hostLocale(),
        // probe 不需要用户配置里的 env（那可能含凭据），一律不给
        extra: null,
      }),
      inheritEnv: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  } catch {
    throw probeError('command_missing');
  }
  let pending = null;
  let closed = false;
  let failure = null;
  let bytes = 0;
  let messages = 0;
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  const fail = (err) => {
    failure ??= err;
    if (pending) { pending.reject(failure); pending = null; }
  };
  const abort = () => fail(signal.reason instanceof Error ? signal.reason : probeError('cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  child.on('error', () => fail(probeError('command_missing')));
  child.on('exit', () => { if (!closed) fail(probeError('process_exit')); });
  child.stdin.on('error', () => fail(probeError('process_exit')));
  let stderrBytes = 0;
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > PROBE_LIMITS.bytes) fail(probeError('response_limit'));
  });
  child.stdout.on('data', (chunk) => {
    if (closed || failure) return;
    bytes += chunk.length;
    if (bytes > PROBE_LIMITS.bytes) return fail(probeError('response_limit'));
    buffer += decoder.write(chunk);
    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      if (++messages > PROBE_LIMITS.messages) return fail(probeError('response_limit'));
      try {
        const parsed = rpcResult(parseMessage(line), pending?.id);
        if (parsed.notification) continue;
        if (!pending) throw probeError('protocol_error');
        const current = pending;
        pending = null;
        current.resolve(parsed.result);
      } catch (err) {
        fail(err);
      }
    }
  });

  const send = (message) => {
    assertActive(signal);
    if (failure) throw failure;
    if (closed) throw probeError('process_exit');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  return {
    request(message) {
      return new Promise((resolve, reject) => {
        if (pending) return reject(probeError('protocol_error'));
        pending = { id: message.id, resolve, reject };
        try { send(message); } catch (err) { fail(err); }
      });
    },
    async notify(message) { send(message); },
    setVersion() {},
    async close() {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', abort);
      fail(probeError('cancelled'));
      await stopMcpProbeProcess(child);
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      // 探测用的私有 HOME/TMP 用完即删 —— 里面可能有 server 落地的东西
      try {
        rmSync(probeInstanceDir, { recursive: true, force: true });
      } catch {
        // 删不掉不影响结果；下次启动会被系统清理
      }
    },
  };
}
