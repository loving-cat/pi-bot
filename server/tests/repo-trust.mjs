/**
 * Git 目标的信任域判定（规格 §7.3）：纯逻辑测试。
 *   node tests/repo-trust.mjs
 *
 * ## 守什么
 *
 * 这一层回答的是"这个仓库的真实路径，是不是都在用户给我的范围里"。
 * 它**不报错也不会报错**的三种越界（都实测过）：
 *
 *   1. worktree 的 `commondir` 指到主仓库 → 一次"普通提交"其实写别人的目录；
 *   2. `objects/info/alternates` 指到外部对象库 → 能读到那个库里的全部内容；
 *   3. 符号链接把 `.git` 指到工作目录外 → 看着在里面，实际在外面。
 *
 * 第 3 条在解析阶段已经拍平成真实路径，所以到这里只需要判"在不在根里"。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (f) => pathToFileURL(path.join(import.meta.dirname, '..', 'src', f));
const { insideRoot, repoTrustVerdict } = await import(src('repo-trust.js'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: err?.message || String(err) });
  }
}

// 用当前平台的分隔符拼路径，Windows 与 Linux 都能跑
const P = (...parts) => path.join(...parts);
const WS = P(path.sep, 'ws');          // /ws 或 \ws
const OTHER = P(path.sep, 'elsewhere');

const layout = (over) => ({
  ok: true,
  root: P(WS, 'proj', 'repo'),
  gitDir: P(WS, 'proj', 'repo', '.git'),
  commonDir: P(WS, 'proj', 'repo', '.git'),
  alternates: [],
  ...over,
});

// ---------------------------------------------------------------- 单条路径
test('自己在里面；子路径在里面；兄弟/上级都不在', () => {
  assert.equal(insideRoot(WS, WS), true);
  assert.equal(insideRoot(WS, P(WS, 'a', 'b')), true);
  assert.equal(insideRoot(WS, OTHER), false);
  assert.equal(insideRoot(P(WS, 'a'), P(WS, 'ab')), false, 'a 不该覆盖 ab（前缀相同不算）');
  assert.equal(insideRoot(P(WS, 'a', 'b'), P(WS, 'a')), false, '子目录不能反过来包含父目录');
});

test('空值一律不算在内（不猜）', () => {
  assert.equal(insideRoot('', WS), false);
  assert.equal(insideRoot(WS, ''), false);
});

// ---------------------------------------------------------------- 正常仓库
test('普通仓库：全在范围内 → 通过', () => {
  const r = repoTrustVerdict({ layout: layout(), roots: [WS] });
  assert.equal(r.ok, true);
});

test('仓库就在工作目录本身（不是子目录）也算在里面', () => {
  const r = repoTrustVerdict({
    layout: layout({ root: WS, gitDir: P(WS, '.git'), commonDir: P(WS, '.git') }),
    roots: [WS],
  });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- 三种越界
test('★ worktree 的共享元数据在范围外 → 拒绝，并点名是哪一条', () => {
  const r = repoTrustVerdict({
    layout: layout({ commonDir: P(OTHER, 'main', '.git') }),
    roots: [WS],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'outside_trust_domain');
  assert.equal(r.outside.length, 1);
  assert.equal(r.outside[0].kind, 'commondir');
  assert.match(r.text, /共享元数据目录/);
  assert.match(r.text, /让用户明确授权/, '要给出下一步，而不是只说"没有权限"');
});

test('★ alternates 指到外部对象库 → 拒绝（这个仓库能读到别人的全部内容）', () => {
  const r = repoTrustVerdict({
    layout: layout({ alternates: [P(OTHER, 'shared', 'objects'), P(OTHER, 'other-repo', 'objects')] }),
    roots: [WS],
  });
  assert.equal(r.ok, false);
  assert.equal(r.outside.filter((o) => o.kind === 'alternates').length, 2);
});

test('★ 仓库根在范围外（符号链接指出去之后就是这样）→ 拒绝', () => {
  const r = repoTrustVerdict({
    layout: layout({ root: P(OTHER, 'repo'), gitDir: P(OTHER, 'repo', '.git'), commonDir: P(OTHER, 'repo', '.git') }),
    roots: [WS],
  });
  assert.equal(r.ok, false);
  assert.ok(r.outside.some((o) => o.kind === 'repo'));
});

test('多根授权：落到任何一个里面都行', () => {
  const r = repoTrustVerdict({
    layout: layout({ alternates: [P(OTHER, 'shared', 'objects')] }),
    roots: [WS, OTHER],
  });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- 保守方向
test('★ 没有信任域就拒（不能"不知道范围"就当全都行）', () => {
  const r = repoTrustVerdict({ layout: layout(), roots: [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no_trust_domain');
});

test('布局没解析出来也拒，并说清是"解析失败"不是"越界"', () => {
  const r = repoTrustVerdict({ layout: { ok: false }, roots: [WS] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_layout');
});

test('布局缺字段不炸（只核对给出来的那些）', () => {
  const r = repoTrustVerdict({ layout: { ok: true, root: P(WS, 'r') }, roots: [WS] });
  assert.equal(r.ok, true);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' —— ' + r.err}`);
}
console.log(`${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
