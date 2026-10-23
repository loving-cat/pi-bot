/**
 * 模型 key 加密、站点口令解密失败不落盘、子进程白名单。
 *   node tests/secrets-regress.mjs
 *
 * 假值只用于断言，目录用 os.tmpdir()。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.PI_BOT_SECRET_KEY;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bot-secrets-regress-'));
process.env.PI_BOT_HOME = root;
process.env.PI_BOT_WORKSPACE = path.join(root, 'workspace');

const { loadOrCreateKey } = await import('../src/secrets.js');
const { ModelGroupStore } = await import('../src/model-groups.js');
const { store } = await import('../src/store.js');
const {
  CHILD_ENV_MARKER,
  attachSpawnSyncScrub,
  childEnv,
  childEnvDirect,
} = await import('../src/child-env.js');
const { runPiCli } = await import('../src/pi-args.js');
const { providerKeys } = await import('../src/provider-keys.js');
const { ShellRegistry } = await import('../src/shells.js');
const { spawnCommand } = await import('../src/spawn-command.js');
const { toMcpServersConfig } = await import('../src/mcp.js');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    pass++;
  } catch (err) {
    console.log(`✗ ${name} ${err?.message || err}`);
    if (err?.stack) console.log(err.stack);
    fail++;
  }
}

const groupsFile = path.join(root, 'model-groups.json');
const keyFile = path.join(root, 'secret.key');
const stateFile = path.join(root, 'state.json');

function clearSaveTimer() {
  if (store.saveTimer) {
    clearTimeout(store.saveTimer);
    store.saveTimer = null;
  }
}

function writePlainGroups() {
  fs.writeFileSync(groupsFile, JSON.stringify({
    version: 1,
    extra: 'keep-extra',
    groups: [{
      id: 'mg_legacy',
      name: '迁移组',
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key-b',
      api: 'openai-completions',
      models: [{ id: 'demo-model' }],
      enabled: true,
      note: 'keep-note',
    }],
  }, null, 2));
}

function tamper(value) {
  // enc:v1:<iv>:<tag>:<data>。tag 是第 4 段。
  // base64url 末字符的低位是填充，改它大约有 1/4 解码后字节不变，认证仍能通过。
  const parts = String(value).split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('密文格式不是 enc:v1:<iv>:<tag>:<data>');
  }
  const tag = parts[3];
  if (tag.length < 6) throw new Error('认证 tag 太短');
  parts[3] = tag.slice(0, 4) + (tag[4] === 'A' ? 'B' : 'A') + tag.slice(5);
  return parts.join(':');
}

await test('新写入的模型 key 落盘是密文，内存仍是明文', () => {
  const groups = new ModelGroupStore();
  const saved = groups.upsert({
    name: '自建',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key-a',
    models: ['demo-model'],
  });
  assert.ok(!saved.error, saved.error);
  assert.equal(saved.group.apiKey, 'test-key-a');
  assert.equal(groups.get(saved.group.id).apiKey, 'test-key-a');
  const disk = fs.readFileSync(groupsFile, 'utf8');
  assert.ok(!disk.includes('test-key-a'), '文件里出现了明文 key');
  assert.ok(disk.includes('enc:v1:'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  }
});

await test('明文模型 key 迁移一次，再次载入不改文件', () => {
  writePlainGroups();
  const first = new ModelGroupStore();
  first.load();
  const once = fs.readFileSync(groupsFile);
  const text = once.toString('utf8');
  assert.ok(!text.includes('test-key-b'));
  assert.ok(text.includes('enc:v1:'));
  assert.ok(text.includes('keep-extra'));
  assert.ok(text.includes('keep-note'));
  assert.equal(first.get('mg_legacy').apiKey, 'test-key-b');
  const second = new ModelGroupStore();
  second.load();
  assert.deepEqual(fs.readFileSync(groupsFile), once);
  assert.equal(second.get('mg_legacy').apiKey, 'test-key-b');
});

await test('模型密文损坏时报错，文件不被清空', () => {
  writePlainGroups();
  new ModelGroupStore().load();
  const raw = JSON.parse(fs.readFileSync(groupsFile, 'utf8'));
  raw.groups[0].apiKey = tamper(raw.groups[0].apiKey);
  fs.writeFileSync(groupsFile, JSON.stringify(raw, null, 2));
  const before = fs.readFileSync(groupsFile);
  const broken = new ModelGroupStore();
  assert.throws(() => broken.list(), /解密失败/);
  assert.throws(() => broken.upsert({ id: 'mg_legacy', name: '改名' }), /解密失败/);
  assert.deepEqual(fs.readFileSync(groupsFile), before);
  assert.ok(!before.toString('utf8').includes('"apiKey": ""'));
});

await test('换掉密钥文件后模型 key 解不开，文件不改写', () => {
  writePlainGroups();
  new ModelGroupStore().load();
  const original = fs.readFileSync(keyFile);
  const before = fs.readFileSync(groupsFile);
  try {
    fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    assert.throws(() => new ModelGroupStore().list(), /解密失败/);
    assert.deepEqual(fs.readFileSync(groupsFile), before);
  } finally {
    fs.writeFileSync(keyFile, original, { mode: 0o600 });
  }
});

await test('错误的 PI_BOT_SECRET_KEY 不改模型文件和密钥文件', () => {
  writePlainGroups();
  new ModelGroupStore().load();
  const beforeModel = fs.readFileSync(groupsFile);
  const beforeKey = fs.readFileSync(keyFile);
  process.env.PI_BOT_SECRET_KEY = 'ab'.repeat(32);
  try {
    assert.throws(() => new ModelGroupStore().list(), /解密失败/);
    assert.deepEqual(fs.readFileSync(groupsFile), beforeModel);
    assert.deepEqual(fs.readFileSync(keyFile), beforeKey);
  } finally {
    delete process.env.PI_BOT_SECRET_KEY;
  }
  const again = new ModelGroupStore();
  again.load();
  assert.equal(again.get('mg_legacy').apiKey, 'test-key-b');
});

await test('PI_BOT_SECRET_KEY 覆盖密钥文件，且不创建 secret.key', () => {
  const dir = fs.mkdtempSync(path.join(root, 'env-key-'));
  process.env.PI_BOT_SECRET_KEY = 'cd'.repeat(32);
  try {
    const key = loadOrCreateKey(dir);
    assert.equal(key.toString('hex'), 'cd'.repeat(32));
    assert.equal(fs.existsSync(path.join(dir, 'secret.key')), false);
  } finally {
    delete process.env.PI_BOT_SECRET_KEY;
  }
});

await test('明文站点口令迁移一次，再次保存密文不变', () => {
  store.state.sites = [{
    id: 'site_plain',
    name: '老系统',
    baseUrl: 'https://legacy.example.com',
    account: 'old@example.com',
    password: 'test-pw',
    auth: {
      kind: 'json',
      loginPath: '/api/login',
      accountField: 'account',
      passwordField: 'password',
      tokenPath: 'token',
      header: 'Authorization',
      scheme: 'Bearer',
    },
    createdAt: 1,
    updatedAt: 1,
  }];
  const key = loadOrCreateKey(root);
  store.useSecretsKey(key);
  store.saveNow();
  clearSaveTimer();
  const once = fs.readFileSync(stateFile);
  const cipher = store.state.sites[0].password;
  assert.ok(cipher.startsWith('enc:v1:'));
  assert.ok(!once.includes('test-pw'));
  assert.equal(store.siteList()[0].password, 'test-pw');
  store.useSecretsKey(key);
  store.saveNow();
  clearSaveTimer();
  assert.equal(store.state.sites[0].password, cipher);
  assert.deepEqual(fs.readFileSync(stateFile), once);
});

await test('站点口令密文损坏时更新会报错，存储不被清空', () => {
  const cipher = store.state.sites[0].password;
  const name = store.state.sites[0].name;
  store.state.sites[0].password = tamper(cipher);
  store.saveNow();
  clearSaveTimer();
  const snap = fs.readFileSync(stateFile);
  assert.throws(() => store.updateSite('site_plain', { name: '改名' }), /解密失败/);
  store.saveNow();
  clearSaveTimer();
  assert.deepEqual(fs.readFileSync(stateFile), snap);
  assert.equal(store.state.sites[0].password, tamper(cipher));
  assert.notEqual(store.state.sites[0].password, '');
  assert.equal(store.state.sites[0].name, name);
});

await test('站点口令密钥不对时改不了，文件保持原样', () => {
  const original = store.secretsKey;
  const snap = fs.readFileSync(stateFile);
  try {
    store.useSecretsKey(crypto.randomBytes(32));
    assert.throws(() => store.updateSite('site_plain', { name: '改名' }), /解密失败/);
    assert.throws(() => store.addSite({
      name: '另一个',
      baseUrl: 'https://other.example.com',
      account: 'a@example.com',
      password: 'test-pw',
      auth: { loginPath: '/api/auth/login' },
    }), /解密失败/);
    assert.deepEqual(fs.readFileSync(stateFile), snap);
  } finally {
    store.useSecretsKey(original);
  }
});

const leaked = {
  PI_BOT_TOKEN: 'test-tok',
  OPENAI_API_KEY: 'test-key-o',
  ANTHROPIC_OAUTH_TOKEN: 'test-oaut',
  RELAY_SECRET: 'test-sec',
  PI_BOT_SECRET_KEY: 'ef'.repeat(32),
  UNRELATED_CUSTOM: 'test-drop',
};
Object.assign(process.env, leaked);
process.env.LC_ALL = 'C';
process.env.HTTP_PROXY = 'http://proxy.example:8080';

const dumpJs = path.join(root, 'dump-env.js');
fs.writeFileSync(dumpJs, 'process.stdout.write(JSON.stringify(process.env));\n');

function assertClean(envObj, explicit = {}) {
  const blob = JSON.stringify(envObj);
  for (const [name, value] of Object.entries(leaked)) {
    assert.equal(envObj[name], undefined, name);
    assert.ok(!blob.includes(value), name);
  }
  assert.equal(envObj[CHILD_ENV_MARKER], undefined);
  assert.ok(envObj.PATH || envObj.Path, 'PATH 应该还在');
  assert.equal(envObj.LC_ALL, 'C');
  assert.equal(envObj.HTTP_PROXY, 'http://proxy.example:8080');
  for (const [name, value] of Object.entries(explicit)) {
    assert.equal(envObj[name], value, name);
  }
}

function readEnv(options = {}) {
  const res = cp.spawnSync(process.execPath, [dumpJs], { encoding: 'utf8', ...options });
  assert.equal(res.status, 0, res.stderr || res.error?.message || 'dump 失败');
  return JSON.parse(res.stdout);
}

await test('具名导入的 spawn（pi 的 shell 工具走这条）也不继承 token', async () => {
  const { spawn } = await import('node:child_process');
  const run = (options) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dumpJs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (buf) => { out += buf; });
    child.stderr?.on('data', (buf) => { err += buf; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
  const plain = await run({});
  assert.equal(plain.code, 0, plain.err);
  assertClean(JSON.parse(plain.out));
  const copied = await run({ env: { ...process.env } });
  assert.equal(copied.code, 0, copied.err);
  assertClean(JSON.parse(copied.out));
});

await test('子进程默认环境只有白名单，没有 token 和 key', () => {
  const prepared = childEnv(process.env, { SPECIAL_API_KEY: 'test-key-e' });
  assert.equal(prepared.PI_BOT_TOKEN, undefined);
  assert.equal(prepared.SPECIAL_API_KEY, 'test-key-e');
  assert.ok(String(prepared[CHILD_ENV_MARKER] || '').startsWith('v1:'));
  const direct = childEnvDirect(process.env, { SPECIAL_API_KEY: 'test-key-e' });
  assertClean(direct, { SPECIAL_API_KEY: 'test-key-e' });
  assertClean(readEnv());
  assertClean(readEnv({ env: { ...process.env } }));
  const forged = { ...process.env, [CHILD_ENV_MARKER]: 'OPENAI_API_KEY,PI_BOT_TOKEN' };
  assertClean(readEnv({ env: forged }));
});

await test('MCP 显式 env 在并上 process.env 之后仍然留下，继承的 key 不留', () => {
  const cfg = toMcpServersConfig([{
    name: 'local',
    type: 'stdio',
    command: process.execPath,
    enabled: true,
    env: { SPECIAL_API_KEY: 'test-key-e', PLAIN_OK: 'hello-explicit' },
  }]);
  assert.equal(cfg.local.inheritEnv, false);
  assert.equal(cfg.local.env.SPECIAL_API_KEY, 'test-key-e');
  assert.equal(cfg.local.env.PLAIN_OK, 'hello-explicit');
  assert.equal(cfg.local.env.PI_BOT_TOKEN, undefined);
  const merged = { ...process.env, ...cfg.local.env };
  assertClean(readEnv({ env: merged }), {
    SPECIAL_API_KEY: 'test-key-e',
    PLAIN_OK: 'hello-explicit',
  });
  const twice = childEnv(childEnv(process.env, { SPECIAL_API_KEY: 'test-key-e' }));
  assert.equal(twice.SPECIAL_API_KEY, 'test-key-e');
  assert.equal(twice.PI_BOT_TOKEN, undefined);
});

await test('spawnCommand 与后台 shell 也不继承 token', async () => {
  const child = spawnCommand(process.execPath, [dumpJs], {
    env: childEnv(process.env, { SPECIAL_API_KEY: 'test-key-e' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const captured = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout?.on('data', (buf) => { out += buf; });
    child.stderr?.on('data', (buf) => { err += buf; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
  assert.equal(captured.code, 0, captured.err);
  assertClean(JSON.parse(captured.out), { SPECIAL_API_KEY: 'test-key-e' });

  const reg = new ShellRegistry({ idleMs: 60_000 });
  try {
    const started = reg.start({
      roomId: 'r',
      botId: 'b',
      command: `node ${JSON.stringify(dumpJs)}`,
      cwd: root,
      env: { SPECIAL_API_KEY: 'test-key-e' },
    });
    assert.ok(started.id, started.error);
    const got = await reg.read(started.id, { pattern: 'SPECIAL_API_KEY', waitMs: 5000 });
    assert.equal(got.matched, true, got.output);
    assertClean(JSON.parse(got.output), { SPECIAL_API_KEY: 'test-key-e' });
  } finally {
    reg.stopAll();
  }
});

await test('execFileSync 同样不带 token', () => {
  const out = cp.execFileSync(process.execPath, [dumpJs], { encoding: 'utf8' });
  assertClean(JSON.parse(out));
});

await test('POSIX 上 env 输出没有 token 和 key，PATH 还在', () => {
  if (process.platform === 'win32') return;
  const res = cp.spawnSync('env', { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.error?.message);
  for (const value of Object.values(leaked)) {
    assert.ok(!res.stdout.includes(value));
  }
  assert.ok(!res.stdout.includes(CHILD_ENV_MARKER));
  assert.match(res.stdout, /(^|\n)PATH=/);
  assert.match(res.stdout, /(^|\n)LC_ALL=C(\n|$)/);
  assert.match(res.stdout, /(^|\n)HTTP_PROXY=http:\/\/proxy\.example:8080(\n|$)/);
});

await test('白名单环境里 node、npm、git 仍能启动', () => {
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  // Windows 上可执行文件是 npm.cmd。直接 spawnSync('npm') 会 ENOENT，
  // 要带扩展名并交给 shell，cmd 才能按 PATHEXT 把它拉起来。
  const commands = [
    [process.execPath, ['-v'], false],
    ['node', ['-v'], false],
    [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['-v'], process.platform === 'win32'],
    ['git', ['--version'], false],
  ];
  for (const [cmd, args, useShell] of commands) {
    const res = cp.spawnSync(cmd, args, { encoding: 'utf8', shell: useShell });
    assert.equal(res.status, 0, `${cmd} ${res.stderr || res.error?.message || ''}`);
    assert.ok(String(res.stdout || '').trim().length > 0, cmd);
  }
});

await test('新放行的变量会进子进程，云凭证和敏感 PI_BOT_ 不进', () => {
  const added = {
    PI_CODING_AGENT_DIR: 'agent-dir',
    XDG_CACHE_HOME: 'xdg-cache',
    SSH_AUTH_SOCK: 'ssh.sock',
    GIT_SSH_COMMAND: 'ssh-cmd',
    NODE_EXTRA_CA_CERTS: 'ca.pem',
    SSL_CERT_FILE: 'cert.pem',
    DISPLAY: ':9',
    ProgramFiles: 'pf-test',
    'ProgramFiles(x86)': 'pf86-test',
    ProgramData: 'pdata-test',
    PSModulePath: 'psmod-test',
    NUMBER_OF_PROCESSORS: '4',
    PROCESSOR_ARCHITECTURE: 'x64',
    OS: 'Windows_NT',
    PUBLIC: 'public-test',
    PI_BOT_SEARCH_KEY: 'test-seek',
    AWS_ACCESS_KEY_ID: 'aws-id-x',
    AWS_SECRET_ACCESS_KEY: 'aws-sec-x',
    GOOGLE_APPLICATION_CREDENTIALS: 'gac-file',
  };
  const previous = {};
  for (const name of Object.keys(added)) previous[name] = process.env[name];
  Object.assign(process.env, added);
  try {
    const env = readEnv();
    for (const [name, value] of Object.entries(added)) {
      if (name.startsWith('AWS_') || name === 'GOOGLE_APPLICATION_CREDENTIALS') {
        assert.equal(env[name], undefined, name);
        assert.ok(!JSON.stringify(env).includes(value), name);
      } else {
        assert.equal(env[name], value, name);
      }
    }
    assert.equal(env.PI_BOT_HOME, root);
    assert.equal(env.PI_BOT_TOKEN, undefined);
    assert.equal(env.PI_BOT_SECRET_KEY, undefined);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

await test('spawnSync 子进程看不到 *_TOKEN', () => {
  const env = readEnv();
  const blob = JSON.stringify(env);
  assert.equal(env.PI_BOT_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_OAUTH_TOKEN, undefined);
  assert.ok(!blob.includes('test-tok'));
  assert.ok(!blob.includes('test-oaut'));
});

await test('拿不到 spawn_sync 时会警告', () => {
  const lines = [];
  const orig = console.warn;
  console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    assert.equal(attachSpawnSyncScrub(null), false);
    assert.ok(lines.some((line) => line.includes('拿不到 spawn_sync')));
  } finally {
    console.warn = orig;
  }
});

await test('别的目录里的 index.js 拿不到 provider key', () => {
  const previous = process.env.PI_BOT_MODEL;
  process.env.PI_BOT_MODEL = 'openai/gpt-test';
  const otherDir = path.join(root, 'mcp-fake');
  fs.mkdirSync(otherDir, { recursive: true });
  const otherIndex = path.join(otherDir, 'index.js');
  const dump = 'process.stdout.write(JSON.stringify(process.env));\n';
  fs.writeFileSync(otherIndex, dump);
  try {
    const direct = cp.spawnSync(process.execPath, [otherIndex, '--mode', 'json'], { encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr || direct.error?.message);
    const directEnv = JSON.parse(direct.stdout);
    assert.equal(directEnv.OPENAI_API_KEY, undefined);
    assert.ok(!JSON.stringify(directEnv).includes('test-key-o'));

    const viaEval = cp.spawnSync(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify(process.env));',
      otherIndex,
      '--mode',
      'x',
    ], { encoding: 'utf8' });
    assert.equal(viaEval.status, 0, viaEval.stderr || viaEval.error?.message);
    const evalEnv = JSON.parse(viaEval.stdout);
    assert.equal(evalEnv.OPENAI_API_KEY, undefined);
    assert.ok(!JSON.stringify(evalEnv).includes('test-key-o'));
  } finally {
    if (previous === undefined) delete process.env.PI_BOT_MODEL;
    else process.env.PI_BOT_MODEL = previous;
  }
});

await test('pi 子 agent 拿到目录和当前 provider 的 key，bash 拿不到', async () => {
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_BOT_MODEL: process.env.PI_BOT_MODEL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ACME_KEY: process.env.ACME_KEY,
  };
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: { acme: { apiKey: '$ACME_KEY' } },
  }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_BOT_MODEL = 'openai/gpt-test';
  process.env.ANTHROPIC_API_KEY = 'test-key-n';
  process.env.ACME_KEY = 'test-key-c';
  try {
    const child = new EventEmitter();
    child.kill = () => {};
    let seen;
    const code = await runPiCli(['--mode', 'json', '-p', 'hi'], {
      env: process.env,
      spawnImpl(_cmd, _args, opts) {
        seen = opts.env;
        queueMicrotask(() => child.emit('exit', 0, null));
        return child;
      },
    });
    assert.equal(code, 0);
    assert.equal(seen.OPENAI_API_KEY, 'test-key-o');
    assert.equal(seen.ANTHROPIC_API_KEY, undefined);
    const scrubbed = readEnv({ env: seen });
    assert.equal(scrubbed.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(scrubbed.OPENAI_API_KEY, 'test-key-o');
    assert.equal(scrubbed.ANTHROPIC_API_KEY, undefined);
    assert.equal(scrubbed.ACME_KEY, undefined);
    assert.equal(scrubbed.PI_BOT_TOKEN, undefined);
    assert.equal(scrubbed[CHILD_ENV_MARKER], undefined);

    const bash = readEnv();
    assert.equal(bash.OPENAI_API_KEY, undefined);
    assert.equal(bash.ANTHROPIC_API_KEY, undefined);
    assert.equal(bash.ACME_KEY, undefined);
    assert.equal(bash.PI_CODING_AGENT_DIR, agentDir);

    process.env.PI_BOT_MODEL = 'acme/widget';
    const acmeKeys = providerKeys(process.env, []);
    assert.deepEqual(acmeKeys, { ACME_KEY: 'test-key-c' });
    const acmeChild = readEnv({ env: childEnv(process.env, acmeKeys) });
    assert.equal(acmeChild.ACME_KEY, 'test-key-c');
    assert.equal(acmeChild.OPENAI_API_KEY, undefined);

    assert.equal(readEnv().OPENAI_API_KEY, undefined);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

clearSaveTimer();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n密钥回归：${pass}/${pass + fail} 通过`);
process.exit(fail > 0 ? 1 : 0);
