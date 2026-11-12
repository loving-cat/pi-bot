/**
 * 测试用：本机 token 的签发与注入。
 *
 * ★ 为什么测试也要带 token
 *
 *   改完之后"来自回环地址"不再自动等于主人 —— 必须带本次启动的 token
 *   （见 src/local-token.js）。这是 P0-2 的目的：本机任意进程不能再
 *   直接调审批/策略/挂 MCP。
 *
 *   所以测试不能再"裸发请求"，要像真实桌面端一样先读 token。
 *   这里把签发 + 读取包成一行，用例里改成 call(host, path, { token: localToken() }) 即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { issueLocalToken, readLocalToken } from '../src/local-token.js';

/**
 * 给当前测试的数据目录签发一个 token 并返回。
 *
 * 测试通常在 await import('../src/http.js') **之前**设好 process.env.PI_BOT_HOME，
 * 这里直接读那个目录，和 config.dataDir 同一处。
 */
export function installLocalToken() {
  const dataDir = process.env.PI_BOT_HOME || path.join(process.cwd(), 'data');
  issueLocalToken(dataDir);
  const token = readLocalToken(dataDir);
  if (!token) throw new Error('签发本机 token 失败：' + dataDir);
  return token;
}

/**
 * 把 token 注入一个 call() helper 的默认参数里。
 *
 * 用法：
 *   const callWithToken = withLocalToken(call, localToken);
 *   await callWithToken('127.0.0.1', '/api/approvals');
 */
export function withLocalToken(call, token) {
  const value = typeof token === 'function' ? token() : token;
  return (host, pathname, opts = {}) => call(host, pathname, { token: value, ...opts });
}

/** 清理（部分测试会自己清目录）。 */
export function removeLocalToken() {
  const dataDir = process.env.PI_BOT_HOME || path.join(process.cwd(), 'data');
  try { fs.rmSync(path.join(dataDir, 'local-token'), { force: true }); } catch {}
}
