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
