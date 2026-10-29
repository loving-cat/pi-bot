/** 使用跨平台命令启动器执行有界 MCP stdio 探测，并回收探测进程。 */
import { StringDecoder } from 'node:string_decoder';
import { childEnv } from './child-env.js';
import { spawnCommand } from './spawn-command.js';
import { stopMcpProbeProcess } from './mcp-probe-cleanup.js';
import { assertActive, parseMessage, probeError, PROBE_LIMITS, rpcResult } from './mcp-probe-protocol.js';

export function createStdioProbe(server, signal) {
  assertActive(signal);
  if (typeof server.command !== 'string' || !server.command.trim()) throw probeError('invalid_config');
  let child;
  try {
    child = spawnCommand(server.command, server.args ?? [], {
      cwd: server.cwd || undefined,
      env: childEnv(process.env, server.env ?? {}),
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
    },
  };
}
