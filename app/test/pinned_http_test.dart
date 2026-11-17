// 证书指纹固定：手机认"这一张证书"，不认"任何证书"。
//
// 这层的错法只有两种，而且都很危险：
//   · 比对太松（只比前缀/忽略大小写和冒号以外的东西）→ 别人拿近似值就能冒充；
//   · 没有指纹时也放行 → 等于 `badCertificateCallback => true`，自签证书谁都能换。
// 所以这里逐条钉：规范化、要不要放行、6 位校验码怎么取。
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/pinned_http.dart';

/// 和 Node 那边 `crypto.createHash('sha256').update(der)` 一样的算法
const _certHex =
    '65032811075b2846dcb0b5f8c3edd89d9e270464c3af7322138134f980ce1123';

void main() {
  test('指纹规范化：大小写、冒号、空格都不影响比对', () {
    expect(
      normalizeFingerprint('65:03:28:11:07:5B:28:46:DC:B0:B5:F8:C3:ED:D8:9D:9E:27:04:64:C3:AF:73:22:13:81:34:F9:80:CE:11:23'),
      _certHex,
    );
    expect(normalizeFingerprint('  $_certHex  '), _certHex);
    expect(normalizeFingerprint(''), isNull);
    expect(normalizeFingerprint(null), isNull);
  });

  test('6 位校验码取前 6 位并大写（给人念的，不是密钥）', () {
    expect(fingerprintCode(_certHex), '650328');
    expect(fingerprintCode(null), '');
    expect(fingerprintCode(''), '');
  });

  test('同一张证书的 DER 能对上；别人的 DER 对不上', () {
    final der = <int>[1, 2, 3, 4, 5];
    final sha = sha256Of(der);
    expect(fingerprintMatches(pinned: sha, der: der), isTrue);
    expect(fingerprintMatches(pinned: sha, der: <int>[1, 2, 3, 4, 6]), isFalse);
    expect(fingerprintMatches(pinned: sha, der: null), isFalse);
    expect(fingerprintMatches(pinned: null, der: der), isFalse);
  });

  test('★ 没有固定指纹时不许放行自签证书（否则等于信任一切证书）', () {
    expect(shouldAllowCertificate(pinned: null, der: const [1, 2, 3]), isFalse);
    expect(shouldAllowCertificate(pinned: '', der: const [1, 2, 3]), isFalse);
  });

  test('装了指纹之后，只有 DER 的 sha256 与其一致才放行', () {
    final pin = sha256Of(const [9, 9, 9]);
    expect(shouldAllowCertificate(pinned: pin, der: const [9, 9, 9]), isTrue);
    expect(shouldAllowCertificate(pinned: pin, der: const [9, 9, 8]), isFalse);
  });

  test('装上/卸下全局固定：不抛、且能回到系统默认', () {
    installPinnedFingerprint(sha256Of(const [1]));
    installPinnedFingerprint(null);
    installPinnedFingerprint('');
  });
}
