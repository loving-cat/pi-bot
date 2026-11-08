import 'dart:convert';
import 'dart:typed_data';

/// 共享 WS 帧解码：直连文本帧、relay 二进制 UTF-8 JSON 都接受。
/// 非法/非 JSON/非对象帧返回 null，交由调用方忽略，不猜内容。
Map<String, dynamic>? decodeWebSocketFrame(dynamic raw) {
  String? text;
  if (raw is String) {
    text = raw;
  } else if (raw is List<int>) {
    try {
      text = utf8.decode(raw, allowMalformed: false);
    } catch (_) {
      return null;
    }
  } else if (raw is ByteBuffer) {
    try {
      text = utf8.decode(raw.asUint8List(), allowMalformed: false);
    } catch (_) {
      return null;
    }
  } else if (raw is ByteData) {
    try {
      text = utf8.decode(raw.buffer.asUint8List(raw.offsetInBytes, raw.lengthInBytes), allowMalformed: false);
    } catch (_) {
      return null;
    }
  } else {
    return null;
  }
  try {
    final decoded = jsonDecode(text);
    if (decoded is Map) return decoded.cast<String, dynamic>();
  } catch (_) {}
  return null;
}
