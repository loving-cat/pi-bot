/**
 * 服务端版本：唯一来源是 package.json（以前 /health、ws hello、serverInfo 三处各写死
 * 一个 "0.2.0"，和 package.json 对不上，客户端显示的版本永远是错的）。
 */
import fs from 'node:fs';

const pkg = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

export const VERSION = pkg.version;
