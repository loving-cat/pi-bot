/**
 * 中转帧的编解码。
 *
 * 中转（云服务器）只负责搬字节：电脑侧主动外连到中转，手机连中转，中转把
 * HTTP 请求/响应与 WebSocket 消息在两端之间转发。
 *
 * 帧格式（JSON，一条消息一个帧）：
 *   { t:'req', id, method, path, headers, body?, z? }
 *   { t:'res', id, status, headers, body?, z? }
 *   { t:'ws-open', id, path, headers }
 *   { t:'ws-msg', id, dir:'c2s'|'s2c', data }
 *   { t:'ws-close', id, code?, reason? }
 *
 * body / data 一律 base64；`z:1` 表示先 deflateRaw 压缩过（**无损**，图片也走这条）。
 * 压缩只在小到值得压且确实更小时使用 —— 已经压过的图片再压通常没收益，会自动跳过。
 */
import zlib from 'node:zlib';

/** 单帧上限（压缩前的原始字节） */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** 小于这个就不折腾压缩了 */
const COMPRESS_MIN = 512;

/** 把一段二进制装进帧字段：base64；够大且压得动就顺带压缩 */
export function packBody(buffer) {
  if (!buffer || !buffer.length) return { body: '', z: 0 };
  if (buffer.length > MAX_FRAME_BYTES) {
    throw new Error(`帧太大：${buffer.length} 字节（上限 ${MAX_FRAME_BYTES}）`);
  }
  const compressed = buffer.length >= COMPRESS_MIN
    ? safeDeflate(buffer)
    : null;
  // 只有真的更小才用（图片本身已压缩，通常差别在噪声里）
  if (compressed && compressed.length < buffer.length * 0.95) {
    return { body: compressed.toString('base64'), z: 1 };
  }
  return { body: buffer.toString('base64'), z: 0 };
}

/** 还原 packBody 的字段 */
export function unpackBody(frame = {}) {
  const raw = frame.body ?? frame.data ?? '';
  if (!raw) return Buffer.alloc(0);
  const buf = Buffer.from(String(raw), 'base64');
  if (buf.length > MAX_FRAME_BYTES) throw new Error('帧太大');
  if (frame.z) {
    const out = zlib.inflateRawSync(buf, { maxOutputLength: MAX_FRAME_BYTES });
    return out;
  }
  return buf;
}

function safeDeflate(buffer) {
  try {
    return zlib.deflateRawSync(buffer, { level: zlib.constants.Z_BEST_SPEED });
  } catch {
    return null;
  }
}

/** 组装一个帧字符串（顺便挡住超大帧） */
export function encodeFrame(frame) {
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES * 2) {
    throw new Error('帧太大，拒绝发送');
  }
  return text;
}

/** 解析一个帧字符串；坏帧返回 null（不让一条坏消息打断整条隧道） */
export function decodeFrame(raw) {
  try {
    const text = typeof raw === 'string' ? raw : String(raw);
    if (text.length > MAX_FRAME_BYTES * 2) return null;
    const frame = JSON.parse(text);
    if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') return null;
    return frame;
  } catch {
    return null;
  }
}
