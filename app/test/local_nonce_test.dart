import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/api.dart';

/// D3：改安全配置要一次性 nonce。
///
/// 起一个最小的假服务端（不让它真的起 pi 会话），只回 /api/local-nonce
/// 和 /api/policy，用来验证客户端确实"先申请、再带上"。
void main() {
  late HttpServer server;
  late int port;
  final seenNonces = <String>[];
  final issued = <String>[];

  setUpAll(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    port = server.port;
    server.listen((req) async {
      final path = req.uri.path;
      if (path == '/api/local-nonce' && req.method == 'POST') {
        final body = await utf8.decodeStream(req);
        final purpose = (jsonDecode(body) as Map)['purpose'];
        final nonce = 'nonce-for-${purpose.toString()}-${issued.length.toString()}';
        issued.add(nonce);
        req.response.headers.contentType = ContentType.json;
        req.response.write(jsonEncode({'nonce': nonce, 'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000}));
        await req.response.close();
        return;
      }
      if (path == '/api/policy' && req.method == 'PATCH') {
        seenNonces.add(req.headers.value('x-pi-bot-nonce') ?? '');
        req.response.headers.contentType = ContentType.json;
        req.response.write(jsonEncode({'policy': {}}));
        await req.response.close();
        return;
      }
      req.response.statusCode = 404;
      await req.response.close();
    });
  });

  tearDownAll(() async {
    await server.close(force: true);
  });

  setUp(() {
    seenNonces.clear();
    issued.clear();
  });

  test('改策略会先申请 nonce 再带上', () async {
    final api = Api('http://127.0.0.1:$port', 'test-token');
    await api.patchPolicy({'dangerous': 'ask'});

    expect(issued.length, 1, reason: '应该申请过一次 nonce');
    expect(seenNonces.length, 1);
    expect(seenNonces.first, issued.first, reason: '带的应该是刚申请的那一个');

  });

  test('每次改策略都申请新的 nonce（不复用）', () async {
    final api = Api('http://127.0.0.1:$port', 'test-token');
    await api.patchPolicy({'dangerous': 'ask'});
    await api.patchPolicy({'dangerous': 'allow'});

    expect(issued.length, 2, reason: '两次调用应各申请一次');
    expect(seenNonces[0], isNot(seenNonces[1]), reason: '两次用的 nonce 必须不同');

  });

  test('MCP 增删改也各申请一次 nonce，且用途是 mcp', () async {
    final api = Api('http://127.0.0.1:$port', 'test-token');
    // 这几个端点在本假服务端里是 404，但 nonce 申请发生在请求之前
    try {
      await api.addMcpServer({'name': 'x'});
    } catch (_) {}
    expect(issued.where((n) => n.startsWith('nonce-for-mcp')).length, 1);

  });
}
