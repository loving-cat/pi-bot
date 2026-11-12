/**
 * 本机 token：每次启动随机生成，写进只有当前用户可读的 0600 文件。
 *
 * ## 为什么需要它
 *
 * 原来"来自回环地址的请求 = 主人"（config.trustLocal）。这在单机桌面场景
 * 下方便，但**本机任何进程**（不用提权）只要往 127.0.0.1 发请求就自动是主人 ——
 * 一个跑在同一台机器上的恶意脚本能直接调审批、改策略、挂 MCP。
 *
 * x-pi-bot-client 那个自定义头不构成防护：它挡的是**浏览器跨站**伪造
 * （自定义头要过 CORS 预检），但本机进程可以随便加任何头。
 *
 * ## 方案
 *
 * 服务端启动时生成 32 字节随机 token，写到数据目录下的固定文件（0600）。
 * 桌面端（和同机上的官方客户端）读这个文件、把它带在每个请求上。
 * 攻击者要拿到它，得能读用户的私有文件 —— 那就已经越过了"同机进程"这条线。
 *
 * 文件权限必须是 0600：同机其它用户（多用户机器 / CI）读不到。
 * 每次启动换新 token：上次进程留下的 token 下次就失效，不需要持久化。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 文件名（放在数据目录根下）。 */
export const LOCAL_TOKEN_FILENAME = 'local-token';

/** token 长度（字节）；hex 编码后是 64 个字符。 */
const TOKEN_BYTES = 32;

function tokenPath(dataDir) {
  return path.join(String(dataDir ?? ''), LOCAL_TOKEN_FILENAME);
}

/**
 * 生成并落盘本次启动的 token。
 *
 * 原子写 + 显式 0600：
 *   · 先写临时文件再 rename，避免客户端读到写了一半的内容；
 *   · chmod 0600 必须显式做 —— writeFile 的 mode 只在**新建**时生效，
 *     文件已存在时不会改权限。
 *
 * @returns {string} 本次启动的 token
 */
export function issueLocalToken(dataDir, { log = () => {} } = {}) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const file = tokenPath(dataDir);
  const tmp = file + '.' + process.pid + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, file);
    // rename 保留源文件权限，但有些文件系统（网络盘/容器层）会重置，再兜一次
    try { fs.chmodSync(file, 0o600); } catch {}
    return token;
  } catch (err) {
    // 落盘失败不该让服务端起不来：退回"只认内存里的 token"，
    // 但要在日志里说清楚 —— 桌面端这时读不到文件，只能靠 pair 流程。
    try { fs.rmSync(tmp, { force: true }); } catch {}
    log('⚠️ 本机 token 落盘失败，桌面端可能需要重新配对：', err?.message || err);
    return token;
  }
}

/** 读当前有效 token（桌面端用；服务端自己不需要读）。 */
export function readLocalToken(dataDir) {
  try {
    const text = fs.readFileSync(tokenPath(dataDir), 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** 退出时清掉，避免下次启动前留着一个已失效的 token 被误用。 */
export function clearLocalToken(dataDir) {
  try { fs.rmSync(tokenPath(dataDir), { force: true }); } catch {}
}
