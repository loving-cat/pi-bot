import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pi_bot/api.dart';

/// 服务端要求所有改状态的请求都带 x-pi-bot-client（防本机 CSRF），
/// 这里锁住 App 的每条写路径都带上它。全部是假地址、假 token。
void main() {
  test('头名与服务端一致', () {
    expect(Api.clientHeader, 'x-pi-bot-client');
    expect(Api.clientHeaderValue, isNotEmpty);
  });

  test('★ GET/POST/PATCH/PUT/DELETE/上传/分片上传都带客户端标记头', () async {
    final seen = <String, Map<String, String>>{};
    final client = MockClient((req) async {
      seen['${req.method} ${req.url.path}'] = req.headers;
      final path = req.url.path;
      Object body = const {'ok': true};
      if (path == '/api/uploads/init') {
        body = const {'uploadId': 'u_fake', 'chunkSize': 4};
      } else if (path == '/api/uploads' || path.endsWith('/complete')) {
        body = const {'attachment': {'id': 'a_fake'}};
      }
      return http.Response(jsonEncode(body), 200,
          headers: const {'content-type': 'application/json'});
    });

    await http.runWithClient(() async {
      final api = Api('http://127.0.0.1:1', 'fake-token');
      await api.get('/api/state');
      await api.post('/api/tasks', const {'title': 'fake'});
      await api.patch('/api/user', const {'name': 'fake'});
      await api.put('/api/user', const {'name': 'fake'});
      await api.delete('/api/devices/d_fake');
      await api.upload(const [1, 2, 3], 'fake.bin');
      await api.uploadChunked(const [1, 2, 3, 4, 5], 'fake.bin');
      await Api.pair('http://127.0.0.1:1', '000000', 'fake');
    }, () => client);

    expect(seen.keys, containsAll(<String>[
      'POST /api/tasks',
      'PATCH /api/user',
      'PUT /api/user',
      'DELETE /api/devices/d_fake',
      'POST /api/uploads',
      'POST /api/uploads/init',
      'POST /api/uploads/u_fake/chunk',
      'POST /api/uploads/u_fake/complete',
      'POST /api/pair',
    ]));
    for (final entry in seen.entries) {
      expect(entry.value[Api.clientHeader], Api.clientHeaderValue,
          reason: '${entry.key} 缺少 ${Api.clientHeader}');
    }
  });

  test('★ PUT 管理路由要带 nonce（例：把应用连接分配给 Bot）', () async {
    final seen = <String, Map<String, String>>{};
    final client = MockClient((req) async {
      seen['${req.method} ${req.url.path}'] = req.headers;
      if (req.url.path == '/api/local-nonce') {
        return http.Response(jsonEncode(const {'nonce': 'fake-nonce'}), 200,
            headers: const {'content-type': 'application/json'});
      }
      return http.Response(jsonEncode(const {'ok': true}), 200,
          headers: const {'content-type': 'application/json'});
    });

    await http.runWithClient(() async {
      final api = Api('http://127.0.0.1:1', 'fake-token');
      await api.put('/api/connections/c_fake/bots', const {'botIds': <String>[]});
    }, () => client);

    final put = seen['PUT /api/connections/c_fake/bots'];
    expect(put, isNotNull, reason: 'PUT 请求本身要发出去');
    expect(put!['x-pi-bot-nonce'], 'fake-nonce',
        reason: '服务端对这条路由要求 nonce，不带就是 403 nonce_required');
  });
}