/** 测试用 stdio MCP 服务，只提供工具目录，不执行业务工具。 */
import fs from 'node:fs';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const [mode = 'ok', pidFile] = process.argv.slice(2);
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
let descendantReady = Promise.resolve();
if (mode === 'tree' || mode === 'stubborn-tree') {
  const child = spawn(process.execPath, ['-e',
    `${mode === 'stubborn-tree' ? 'process.on("SIGTERM", () => {});' : ''}process.stdout.write("ready\\n");setInterval(() => {}, 1000)`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  fs.writeFileSync(`${pidFile}.child`, String(child.pid));
  descendantReady = new Promise((resolve) => child.stdout.once('data', resolve));
}
if (mode === 'exit') process.exit(2);
if (mode === 'idle') {
  process.stdin.resume();
} else {
  const lines = readline.createInterface({ input: process.stdin });
  let ready = false;
  lines.on('line', async (line) => {
    const message = JSON.parse(line);
    await descendantReady;
    if (mode === 'broken') { process.stdout.write('plain log\n'); return; }
    if (mode === 'server-request') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'server1', method: 'sampling/createMessage', params: {} }) + '\n');
      return;
    }
    if (mode === 'flood') { process.stdout.write('x'.repeat(3 * 1024 * 1024)); return; }
    if (message.method === 'notifications/initialized') { ready = true; return; }
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-11-25', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } };
    } else if (message.method === 'tools/list' && ready) {
      result = { tools: [{ name: 'fixture_query', title: '测试查询', description: '仅用于验证目录', inputSchema: { type: 'object' } }] };
      if (mode === 'env') result.tools[0].description = process.env.PROBE_FIXTURE_VALUE ?? 'missing';
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'invalid order' } }) + '\n');
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  });
}
process.stdin.on('end', () => process.exit(0));
