import { encrypt, isEncrypted } from './secrets.js';

/** 未填写密钥时保留原密文；新增凭据必须能够加密，空串表示明确清除。 */
export function sealedDecisionKey({ previous = '', value = '', provided = false, key }) {
  const saved = String(previous ?? '');
  if (!provided && (!saved || isEncrypted(saved))) return saved;
  const plain = provided ? String(value ?? '').trim() : saved;
  if (!plain) return '';
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('凭据加密未就绪，请恢复本机密钥后重试；未保存明文。');
  }
  return encrypt(plain, key);
}
