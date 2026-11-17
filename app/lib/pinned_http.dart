import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter/foundation.dart';

/// 证书指纹固定（certificate pinning）。
///
/// 局域网里没有可信 CA，服务端用的是自签证书 —— 系统默认校验一定会拒
/// （`CERTIFICATE_VERIFY_FAILED`）。所以我们只信**一个具体的指纹**：
/// 配对时从电脑那边拿到（广播应答里带，或者手动填），之后每次连都要求对得上。
///
/// 和"信任所有证书"的区别：`badCertificateCallback => true` 等于谁冒充都行；
/// 这里必须**逐字节相等**，换一张证书就立刻连不上。dnS 名/IP 的校验交给
/// Dart 自己（服务端证书的 SAN 里写了每个局域网 IP）。
///
/// 用 [HttpOverrides.global] 的全局钩子而不是给每个请求塞 client：
/// `package:http`、WebSocket、`Image.network` 走的都是 `dart:io` 的 HttpClient，
/// 一个全局覆盖能把它们一起管住 —— 漏掉任何一条都会在密文链路上留下明文的口子。
class FingerprintPin extends HttpOverrides {
  FingerprintPin(this.fingerprint);

  /// sha256 hex（小写、可带冒号）；null/空 = 没有固定，按系统默认来
  final String? fingerprint;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final client = super.createHttpClient(context);
    final pin = normalizeFingerprint(fingerprint);
    client.badCertificateCallback = (cert, host, port) {
      // dart:io 的 X509Certificate 只给 der / sha1，sha256 自己算（和服务端同一算法）
      return shouldAllowCertificate(pinned: pin, der: cert.der);
    };
    return client;
  }
}

/// sha256 字节 → 十六进制
String hexOf(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

/// 证书 DER 的 sha256（与服务端 `crypto.createHash('sha256')` 同一个值）
String sha256Of(List<int> der) => crypto.sha256.convert(der).toString();

/// 指纹统一形态：小写、去掉冒号和空白（服务端给的是不带冒号的 hex）
String? normalizeFingerprint(String? raw) {
  if (raw == null) return null;
  final cleaned = raw.toLowerCase().replaceAll(RegExp(r'[^0-9a-f]'), '');
  return cleaned.isEmpty ? null : cleaned;
}

/// 这张证书该不该放行：**只有**指纹逐字节相等才放行。
///
/// 单独抽成函数是为了能测 —— `badCertificateCallback` 的参数是 `X509Certificate`，
/// 测试里造不出来；真正决定放行的是这个纯函数。
bool shouldAllowCertificate({String? pinned, List<int>? der}) =>
    fingerprintMatches(pinned: pinned, der: der);

/// 两个指纹是不是同一张证书
bool fingerprintMatches({String? pinned, List<int>? der}) {
  final pin = normalizeFingerprint(pinned);
  if (pin == null || der == null || der.isEmpty) return false;
  return sha256Of(der) == pin;
}

/// 人眼比对的 6 位校验码：取指纹前 6 位，大写。
///
/// 故意做得短：这是给人**念出来对一遍**的（电脑上的弹窗 vs 手机上的设置页），
/// 60 位 hex 没法对。前 6 位 hex = 24 bit，随机碰撞概率足够低（1/1600 万），
/// 而且它的作用只是发现"中间人换了一张证书"，不是抗暴力枚举的密钥。
String fingerprintCode(String? fingerprint) {
  final pin = normalizeFingerprint(fingerprint);
  if (pin == null) return '';
  return pin.substring(0, pin.length < 6 ? pin.length : 6).toUpperCase();
}

/// 把指纹装进进程级的 HttpClient 工厂。传 null = 回到系统默认（不放行自签）。
void installPinnedFingerprint(String? fingerprint) {
  final pin = normalizeFingerprint(fingerprint);
  if (pin == null) {
    HttpOverrides.global = null;
    return;
  }
  HttpOverrides.global = FingerprintPin(pin);
  if (kDebugMode) {
    debugPrint('[pinned] 证书指纹固定为 ${fingerprintCode(pin)}…');
  }
}
