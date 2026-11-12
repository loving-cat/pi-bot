/**
 * D4：子进程环境按类型白名单。
 *   node tests/child-env-typed.mjs
 *
 * 这一类漏洞是"服务端把自己的环境原样传给子进程"：
 *   · PI_BOT_TOKEN / SECRET_KEY 泄漏 → 子进程能直接调服务端接口
 *   · SSH_AUTH_SOCK → 子进程能用用户的 ssh 密钥签名
 *   · 宿主 PATH → 子进程里的命令可能解析到攻击者放的可执行文件
 *   · 真实 HOME → 子进程能读写用户的 rc 文件、密钥目录
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-typed-env-'));
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

const {
  buildChildEnv,
  hostLocale,
  instanceHomeDir,
  instanceTmpDir,
  ensureInstanceDirs,
  safePath,
  NEVER_PASS,
} = await import('../src/child-env-typed.js');

/** 假凭据：设进父进程环境，看子进程能不能读到。 */
// 样例值故意用重复字符：形状像真凭据的值会被 CI 的 secret scan 判成泄漏
// （见 memory-sanitize.mjs 里同样的处理）。要验的是"它没被子进程看到"，
// 值本身长什么样不影响测试语义。
const FAKE_TOKEN = 'X'.repeat(24);
const FAKE_SECRET = 'Y'.repeat(24);
const FAKE_SSH = '/tmp/fake-agent-sock-for-test';

process.env.PI_BOT_TOKEN = FAKE_TOKEN;
process.env.PI_BOT_SECRET_KEY = FAKE_SECRET;
process.env.SSH_AUTH_SOCK = FAKE_SSH;
process.env.UV_INDEX_URL = 'http://evil.example/simple';
process.env.PIP_INDEX_URL = 'http://evil.example/simple';
process.env.NODE_OPTIONS = '--require /tmp/evil.js';
process.env.DYLD_INSERT_LIBRARIES = '/tmp/evil.dylib';
process.env.LD_PRELOAD = '/tmp/evil.so';
process.env.HOME = '/Users/someone-real';
process.env.PATH = '/tmp/evil-bin:/usr/bin';

const instanceDir = path.join(root, 'inst');
ensureInstanceDirs(instanceDir);

/** 起一个真子进程打印自己的 env 键，验证"实际传进去的是什么"。 */
function realChildEnv(kind, extra = null) {
  const script = 'process.stdout.write(JSON.stringify(process.env))';
  const res = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: buildChildEnv({
      kind,
      homeDir: instanceHomeDir(instanceDir),
      tmpDir: instanceTmpDir(instanceDir),
      locale: hostLocale(),
      extra,
    }),
  });
  // 失败时把 stdout/stderr 都带上：Windows CI 上曾经只报
  // "PATH 应是固定安全值"，看不到真正原因（子进程根本起不来）
  assert.equal(
    res.status,
    0,
    '子进程启动失败 status=' + res.status
      + ' stdout=' + JSON.stringify(res.stdout ?? '').slice(0, 200)
      + ' stderr=' + JSON.stringify(res.stderr ?? '').slice(0, 300),
  );
  return JSON.parse(res.stdout);
}

await test('★ 假 token 在各类子进程里都读不到', () => {
  for (const kind of ['mcp', 'bash', 'probe']) {
    const env = realChildEnv(kind);
    assert.equal(env.PI_BOT_TOKEN, undefined, kind + ' 不该有 PI_BOT_TOKEN');
    assert.equal(env.PI_BOT_SECRET_KEY, undefined, kind + ' 不该有 PI_BOT_SECRET_KEY');
    assert.ok(!JSON.stringify(env).includes(FAKE_TOKEN), kind + ' 环境里不该出现 token 值');
    assert.ok(!JSON.stringify(env).includes(FAKE_SECRET), kind + ' 环境里不该出现 secret 值');
  }
});

await test('★ SSH_AUTH_SOCK 在各类子进程里都读不到', () => {
  for (const kind of ['mcp', 'bash', 'probe']) {
    const env = realChildEnv(kind);
    assert.equal(env.SSH_AUTH_SOCK, undefined, kind + ' 不该有 SSH_AUTH_SOCK');
    assert.ok(!JSON.stringify(env).includes(FAKE_SSH));
  }
});

await test('★ 能改变加载行为的变量一律不传', () => {
  const banned = ['UV_INDEX_URL', 'PIP_INDEX_URL', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD'];
  for (const kind of ['mcp', 'bash', 'probe']) {
    const env = realChildEnv(kind);
    for (const name of banned) {
      assert.equal(env[name], undefined, kind + ' 不该有 ' + name);
    }
  }
});

await test('★ PATH 不继承宿主（含宿主里那个 evil 目录）', () => {
  const env = realChildEnv('bash');
  // Windows 上环境变量名大小写不敏感，子进程可能拿到 Path / PATH
  const gotPath = env.PATH ?? env.Path ?? '';
  assert.equal(gotPath, safePath(), 'PATH 应是固定安全值');
  assert.ok(!gotPath.includes('evil-bin'), '不该含宿主 PATH 里的目录');
  // 平台相关的系统目录断言
  if (process.platform === 'win32') {
    assert.match(gotPath, /System32/i, '要含 Windows 系统目录');
  } else {
    assert.ok(gotPath.includes('/usr/bin'), '要含系统目录');
  }
});

await test('★ HOME 指向实例目录，不是用户真实 HOME', () => {
  for (const kind of ['mcp', 'bash', 'probe']) {
    const env = realChildEnv(kind);
    assert.equal(env.HOME, instanceHomeDir(instanceDir), kind + ' 的 HOME 应是实例目录');
    assert.notEqual(env.HOME, '/Users/someone-real', kind + ' 不该是真实 HOME');
  }
});

await test('★ TMPDIR 指向实例私有 tmp', () => {
  const env = realChildEnv('bash');
  assert.equal(env.TMPDIR, instanceTmpDir(instanceDir));
  assert.equal(env.TMP, instanceTmpDir(instanceDir));
  assert.equal(env.TEMP, instanceTmpDir(instanceDir));
});

await test('locale 正常透传（LANG / LC_ALL）', () => {
  const env = realChildEnv('bash');
  assert.ok(env.LANG, '应有 LANG');
  // 宿主没有 LC_ALL 时不强求；有则应为原值
  if (process.env.LC_ALL) assert.equal(env.LC_ALL, process.env.LC_ALL);
});

await test('显式传入的普通变量保留（MCP 配置里的 API key 要能用）', () => {
  const env = realChildEnv('mcp', { SPECIAL_API_KEY: 'user-key-1' });
  assert.equal(env.SPECIAL_API_KEY, 'user-key-1', '用户显式配的 key 应保留');
});

await test('★ 显式传入也挡服务端凭据和用户 agent socket', () => {
  for (const kind of ['mcp', 'bash', 'probe']) {
    const env = realChildEnv(kind, {
      PI_BOT_TOKEN: 'sneaky',
      SSH_AUTH_SOCK: '/tmp/sneaky.sock',
    });
    assert.equal(env.PI_BOT_TOKEN, undefined, kind + ' 显式传也不给 PI_BOT_TOKEN');
    assert.equal(env.SSH_AUTH_SOCK, undefined, kind + ' 显式传也不给 SSH_AUTH_SOCK');
  }
});

await test('代理变量透传（企业内网必需，不是凭据）', () => {
  const prev = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = 'http://proxy.example:8080';
  try {
    const env = buildChildEnv({ kind: 'bash', locale: hostLocale() });
    assert.equal(env.HTTP_PROXY, 'http://proxy.example:8080');
  } finally {
    if (prev === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = prev;
  }
});

await test('NEVER_PASS 覆盖关键项', () => {
  for (const name of [
    'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR', 'NODE_OPTIONS', 'PI_BOT_TOKEN', 'PI_BOT_SECRET_KEY',
  ]) {
    assert.ok(NEVER_PASS.has(name), name + ' 应在 NEVER_PASS 里');
  }
});

await test('实例目录以 0700 创建', () => {
  ensureInstanceDirs(instanceDir);
  for (const dir of [instanceDir, instanceHomeDir(instanceDir), instanceTmpDir(instanceDir)]) {
    assert.ok(fs.existsSync(dir), dir + ' 应存在');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(dir).mode & 0o777;
      assert.equal(mode, 0o700, dir + ' 权限应是 0700，实际 ' + mode.toString(8));
    }
  }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failed.length ? 1 : 0;
