import 'dart:convert';

import 'package:http/http.dart' as http;

class ApiException implements Exception {
  ApiException(this.message, {this.status});
  final String message;
  final int? status;
  @override
  String toString() => message;
}

/// 规范化用户输入的服务器地址：补 http://、去尾部斜杠。
String normalizeBaseUrl(String input) {
  var s = input.trim();
  if (s.isEmpty) return s;
  if (!s.startsWith('http://') && !s.startsWith('https://')) s = 'http://$s';
  while (s.endsWith('/')) {
    s = s.substring(0, s.length - 1);
  }
  return s;
}

class Api {
  Api(this.baseUrl, this.token);

  final String baseUrl;
  String? token;

  /// 客户端标记头：服务端要求所有改状态的请求（POST/PUT/PATCH/DELETE，含上传）都带它。
  /// 浏览器跨站发自定义头必须先过 CORS 预检，服务端从不放行，所以恶意网页伪造不了。
  static const clientHeader = 'x-pi-bot-client';
  static const clientHeaderValue = 'app';

  Map<String, String> get _headers => {
    'content-type': 'application/json; charset=utf-8',
    clientHeader: clientHeaderValue,
    if (token != null && token!.isNotEmpty) 'authorization': 'Bearer $token',
  };

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('$baseUrl$path').replace(queryParameters: query);

  Future<Map<String, dynamic>> _decode(http.Response res) async {
    Map<String, dynamic> body;
    try {
      body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      body = {};
    }
    if (res.statusCode >= 400) {
      throw ApiException(
        (body['error'] as String?) ?? 'HTTP ${res.statusCode}',
        status: res.statusCode,
      );
    }
    return body;
  }

  /// 取文件的**原始字节**。下载、文本预览都要用它 ——
  /// 别的接口都只回 JSON，这个不一样。
  ///
  /// [maxBytes] 用来挡住"预览一个 200MB 的日志"这种事：
  /// 超了就直接说超了，别把内存吃光。
  Future<List<int>> bytes(String path, {int? maxBytes}) async {
    final res = await http
        .get(
          _uri(path),
          headers: {
            if (token != null && token!.isNotEmpty)
              'authorization': 'Bearer $token',
          },
        )
        .timeout(const Duration(seconds: 60));
    if (res.statusCode >= 400) {
      throw ApiException('HTTP ${res.statusCode}', status: res.statusCode);
    }
    final body = res.bodyBytes;
    if (maxBytes != null && body.length > maxBytes) {
      throw ApiException('文件太大（${body.length ~/ 1024}KB），不适合直接预览');
    }
    return body;
  }

  Future<Map<String, dynamic>> get(
    String path, {
    Map<String, String>? query,
  }) async {
    final res = await http
        .get(_uri(path, query), headers: _headers)
        .timeout(const Duration(seconds: 20));
    return _decode(res);
  }

  Future<Map<String, dynamic>> delete(String path) async {
    final res = await http
        .delete(_uri(path), headers: _headers)
        .timeout(const Duration(seconds: 20));
    return _decode(res);
  }

  Future<Map<String, dynamic>> post(
    String path, [
    Map<String, dynamic>? body,
  ]) async {
    final res = await http
        .post(_uri(path), headers: _headers, body: jsonEncode(body ?? const {}))
        .timeout(const Duration(seconds: 30));
    return _decode(res);
  }

  Future<Map<String, dynamic>> patch(
    String path,
    Map<String, dynamic> body,
  ) async {
    final res = await http
        .patch(_uri(path), headers: _headers, body: jsonEncode(body))
        .timeout(const Duration(seconds: 20));
    return _decode(res);
  }

  Future<Map<String, dynamic>> put(
    String path,
    Map<String, dynamic> body,
  ) async {
    final res = await http
        .put(_uri(path), headers: _headers, body: jsonEncode(body))
        .timeout(const Duration(seconds: 20));
    return _decode(res);
  }

  /// 上传附件（图片/文档），返回服务端附件元信息
  Future<Map<String, dynamic>> upload(List<int> bytes, String name) async {
    final res = await http
        .post(
          _uri('/api/uploads', {'name': name}),
          headers: {
            if (token != null && token!.isNotEmpty)
              'authorization': 'Bearer $token',
            'content-type': 'application/octet-stream',
            clientHeader: clientHeaderValue,
          },
          body: bytes,
        )
        .timeout(const Duration(seconds: 90));
    final decoded = await _decode(res);
    return (decoded['attachment'] as Map).cast<String, dynamic>();
  }

  /// 分片上传：大文件走这条（单片 4MB，整体上限由服务端定）
  Future<Map<String, dynamic>> uploadChunked(
    List<int> bytes,
    String name, {
    void Function(int sent, int total)? onProgress,
  }) async {
    final init = await post('/api/uploads/init', {
      'name': name,
      'size': bytes.length,
    });
    final id = init['uploadId'] as String?;
    if (id == null) throw StateError('服务端没有返回 uploadId');
    final chunk = (init['chunkSize'] as num?)?.toInt() ?? 4 * 1024 * 1024;

    for (var offset = 0; offset < bytes.length; offset += chunk) {
      final end = offset + chunk > bytes.length ? bytes.length : offset + chunk;
      final res = await http
          .post(
            _uri('/api/uploads/$id/chunk', {'offset': '$offset'}),
            headers: {
              if (token != null && token!.isNotEmpty)
                'authorization': 'Bearer $token',
              'content-type': 'application/octet-stream',
              clientHeader: clientHeaderValue,
            },
            body: bytes.sublist(offset, end),
          )
          .timeout(const Duration(seconds: 120));
      final decoded = await _decode(res);
      if (decoded['error'] != null) {
        throw StateError('${decoded['error']}');
      }
      onProgress?.call(end, bytes.length);
    }

    final done = await post('/api/uploads/$id/complete', const {});
    return (done['attachment'] as Map).cast<String, dynamic>();
  }

  /// 附件的可访问 URL（token 放 query，方便 <img> 直接用）
  String fileUrl(String id) =>
      '$baseUrl/api/files/$id?token=${Uri.encodeQueryComponent(token ?? '')}';

  /// 用配对码换 token（不需要鉴权）
  static Future<Map<String, dynamic>> pair(
    String baseUrl,
    String code,
    String deviceName,
  ) async {
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/pair'),
          headers: const {
            'content-type': 'application/json; charset=utf-8',
            clientHeader: clientHeaderValue,
          },
          body: jsonEncode({'code': code, 'deviceName': deviceName}),
        )
        .timeout(const Duration(seconds: 20));
    Map<String, dynamic> body;
    try {
      body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      body = {};
    }
    if (res.statusCode >= 400) {
      throw ApiException(
        (body['error'] as String?) ?? 'HTTP ${res.statusCode}',
        status: res.statusCode,
      );
    }
    return body;
  }

  String get wsUrl {
    final ws = baseUrl
        .replaceFirst('http://', 'ws://')
        .replaceFirst('https://', 'wss://');
    return '$ws/ws?token=${Uri.encodeQueryComponent(token ?? '')}';
  }
}
