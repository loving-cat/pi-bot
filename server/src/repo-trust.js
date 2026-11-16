/**
 * Git 目标的**信任域判定**（规格 §7.3）。
 *
 * > 所有目标必须属于授予的信任域，否则拒绝并提出授权差异。
 *
 * ## 为什么需要
 *
 * `resolveRepoLayout()` 已经能把一个仓库的**全部真实元数据**解析出来：
 * 仓库根、`.git` 目录（gitDir）、共享目录（commonDir）、以及
 * `objects/info/alternates` 里登记的外部对象库。
 *
 * 但解析出来之后，**没有人拿它跟"用户授权的范围"比**。后果很具体：
 *
 * | 情形 | 实际后果 |
 * |---|---|
 * | 仓库是个 worktree，commondir 指向主仓库 | 一次"普通提交"其实写的是**别人的目录** |
 * | alternates 指向一个外部对象库 | 这个仓库能读到那个库里的**全部提交内容**（别的项目、别人的分支） |
 * | symlink 指到工作目录外面 | 看起来在里面，实际读写的在外面 |
 *
 * 这三件都**不报错**：git 一切正常，审计里也一切正常。
 *
 * ## 判据
 *
 * 只有一条：**解析出来的每一条路径，都必须落在授权根之内**。
 * "之内"用 `path.relative` 判断（同平台大小写规则、符号链接已经解析过）。
 *
 * 不做的两件事：
 *   · 不猜"大概没事"：任何一条越界都整体拒绝，并在错误里点名是哪一条；
 *   · 不自动扩大授权：拒绝之后该做的是让用户明确授权那个路径，
 *     而不是我们替他决定"反正只是读对象"。
 */

import path from 'node:path';

/**
 * 一条路径在不在根目录之内（含根本身）。
 *
 * 两边都必须是已经解析过的绝对路径 —— 这个函数不做 realpath，
 * 那种"看着相等其实不同"的坑要留在上层解析阶段解决（`resolveRepoLayout`
 * 已经做过 realpath / symlink 解析）。
 */
export function insideRoot(root, candidate) {
  const r = String(root ?? '').trim();
  const c = String(candidate ?? '').trim();
  if (!r || !c) return false;
  const rel = path.relative(r, c);
  if (rel === '') return true;
  if (rel === '..') return false;
  return !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * 判一次"这些路径是不是都在信任域里"。
 *
 * @param {object} p
 * @param {object} p.layout `resolveRepoLayout()` 的返回
 * @param {string[]} p.roots 信任域（用户授权的工作目录/项目路径，绝对路径）
 * @returns {{ok:true} | {ok:false, code:string, text:string, outside:Array<{kind:string, path:string}>}}
 */
export function repoTrustVerdict({ layout, roots = [] } = {}) {
  const cleanRoots = (Array.isArray(roots) ? roots : []).map((r) => String(r ?? '').trim()).filter(Boolean);
  if (!cleanRoots.length) {
    return {
      ok: false,
      code: 'no_trust_domain',
      text: '没有可用的信任域（工作目录不知道在哪），这次 Git 操作无法核对范围。',
      outside: [],
    };
  }
  if (!layout || layout.ok !== true) {
    return {
      ok: false,
      code: 'bad_layout',
      text: '仓库布局没解析出来，无法核对范围。',
      outside: [],
    };
  }

  // 要核对的每一条：它们的**真实性**都已经在解析阶段确认过
  const entries = [
    { kind: 'repo', path: layout.root },
    { kind: 'gitdir', path: layout.gitDir },
    { kind: 'commondir', path: layout.commonDir },
    ...(Array.isArray(layout.alternates) ? layout.alternates.map((p) => ({ kind: 'alternates', path: p })) : []),
  ].filter((e) => e.path);

  const outside = [];
  for (const e of entries) {
    const inside = cleanRoots.some((root) => insideRoot(root, e.path));
    if (!inside) outside.push({ kind: e.kind, path: String(e.path) });
  }
  if (!outside.length) return { ok: true };

  // ★ 报错要把"哪一条越界"说清楚，并且**不改口**成"权限不足"：
  //   用户需要知道的是"这个仓库的元数据在工作目录外面"，
  //   而不是"你没有权限"（他会去翻授权，然后发现授权明明有）。
  const label = { repo: '仓库根', gitdir: '.git 目录', commondir: '共享元数据目录', alternates: '外部对象库' };
  const lines = outside.map((o) => `· ${label[o.kind] ?? o.kind}：${o.path}`);
  return {
    ok: false,
    code: 'outside_trust_domain',
    text: `这个仓库的真实路径超出了你给我的范围：\n${lines.join('\n')}\n`
      + '它的元数据（.git / 共享目录 / 外部对象库）在授权根之外 —— '
      + '在这里做的"普通操作"会写到那些目录里。要操作它，请让用户明确授权那个路径。',
    outside,
  };
}

/** 测试用：注入 path 实现（Windows/Linux 两套分支都要能跑）。 */
export function __setPathForTest(mod, sep) {
  pathRelative = (from, to) => mod.relative(from, to);
  isAbsolutePath = (p) => mod.isAbsolute(p);
  pathSep = sep;
}
