import 'dart:convert';
import 'dart:typed_data';

/// 健康响应正文的原始字节上限。
const maxHealthResponseBytes = 64 * 1024;

/// 读取有大小上限的 UTF8 正文；超限立即停止消费并返回 null。
Future<String?> readHealthResponseBody(Stream<List<int>> chunks) async {
  final bytes = BytesBuilder();
  await for (final chunk in chunks) {
    if (chunk.length > maxHealthResponseBytes - bytes.length) return null;
    bytes.add(chunk);
  }
  return utf8.decode(bytes.takeBytes());
}

/// 校验本机服务端健康响应：成功标记与非空的服务名称、版本缺一不可。
bool isPiBotHealthResponse(String body) {
  try {
    final value = jsonDecode(body);
    if (value is! Map<String, dynamic>) return false;
    final name = value['serverName'];
    final version = value['version'];
    return value['ok'] == true &&
        name is String &&
        name.trim().isNotEmpty &&
        version is String &&
        version.trim().isNotEmpty;
  } on FormatException {
    return false;
  }
}
