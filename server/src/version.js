/**
 * 服务端版本：唯一来源是 package.json。
 * 若在 /health、ws hello、serverInfo 三处各写死，就会和 package.json 对不上，
 * 客户端显示的版本也就是错的。
 */
import fs from 'node:fs';

const pkg = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

export const VERSION = pkg.version;

/**
 * 发布版本号的形态（`server/tests/version.mjs` 与发布脚本共用，别再各写一套正则）。
 *
 * 允许标准 semver 预发布：`2.0.0-alpha.1` / `2.0.0-beta.12` / `2.0.0-rc.1`；
 * **禁止平台/日期后缀**（`-win.20261022` / `-macos`）—— 更新检查按 semver 解析 tag，
 * 那种后缀会被判成"预发布"，于是远端永远比当前旧，用户再也收不到更新提示。
 *
 * 预发布段的数字不允许前导零（`alpha.01` 不合法）：`semver` 与 GitHub tag 都严格。
 */
export const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?$/;

/** 这个字符串能不能当发布版本号用 */
export function isReleaseVersion(version) {
  return RELEASE_VERSION_RE.test(String(version ?? ''));
}
