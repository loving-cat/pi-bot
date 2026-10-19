import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/health.dart';
import 'package:pi_bot/server/launcher.dart';

const _healthy = '{"ok":true,"serverName":"pi-bot","version":"1.1.0"}';

void main() {
  test('健康响应接受完整身份、自定义服务名称与额外字段', () {
    expect(isPiBotHealthResponse(_healthy), isTrue);
    expect(
      isPiBotHealthResponse(
        jsonEncode({
          'ok': true,
          'serverName': '我的服务端',
          'version': '1.1.0',
          'stats': {'rooms': 1},
        }),
      ),
      isTrue,
    );
  });

  final invalid = <String, String>{
    '外部服务的 status ok': '{"status":"ok"}',
    '只有成功标记': '{"ok":true}',
    '缺少名称': '{"ok":true,"version":"1.1.0"}',
    '缺少版本': '{"ok":true,"serverName":"pi-bot"}',
    '损坏 JSON': '{"ok":',
    'JSON 数组': '[]',
    'JSON 字符串': '"ok"',
    'JSON null': 'null',
    '失败标记': '{"ok":false,"serverName":"pi-bot","version":"1.1.0"}',
    '字符串成功标记': '{"ok":"true","serverName":"pi-bot","version":"1.1.0"}',
    '非字符串名称': '{"ok":true,"serverName":123,"version":"1.1.0"}',
    '空名称': '{"ok":true,"serverName":"  ","version":"1.1.0"}',
    '非字符串版本': '{"ok":true,"serverName":"pi-bot","version":1}',
    '空版本': '{"ok":true,"serverName":"pi-bot","version":"  "}',
  };
  for (final entry in invalid.entries) {
    test('健康响应拒绝${entry.key}', () {
      expect(isPiBotHealthResponse(entry.value), isFalse);
    });
  }

  group('正文大小上限', () {
    test('合法小响应完整读取', () async {
      final body = await readHealthResponseBody(
        Stream.value(utf8.encode(_healthy)),
      );
      expect(body, _healthy);
    });

    test('恰好 64KiB 的合法响应可以读取', () async {
      final prefix = utf8.encode(_healthy);
      final body = await readHealthResponseBody(
        Stream.fromIterable([
          prefix,
          List.filled(maxHealthResponseBytes - prefix.length, 32),
        ]),
      );
      expect(body!.length, maxHealthResponseBytes);
      expect(isPiBotHealthResponse(body), isTrue);
    });

    test('超过原始字节上限立即停止消费后续块', () async {
      var consumedTail = false;
      Stream<List<int>> chunks() async* {
        yield List.filled(maxHealthResponseBytes, 32);
        yield [32];
        consumedTail = true;
        yield [32];
      }

      expect(await readHealthResponseBody(chunks()), isNull);
      expect(consumedTail, isFalse);
    });

    test('多字节 UTF8 按字节数限制，不按字符串字符数限制', () async {
      final bytes = utf8.encode(
        List.filled(maxHealthResponseBytes ~/ 2, '图').join(),
      );
      expect(bytes.length, greaterThan(maxHealthResponseBytes));
      expect(await readHealthResponseBody(Stream.value(bytes)), isNull);
    });
  });

  group('真实 HTTP 探活', () {
    late HttpServer server;

    setUp(() async {
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    });

    tearDown(() => server.close(force: true));

    String url() => 'http://127.0.0.1:${server.port}';

    final responses = [
      (name: '完整健康身份', body: _healthy, status: 200, expected: true),
      (
        name: '外部 status ok 服务',
        body: '{"status":"ok"}',
        status: 200,
        expected: false,
      ),
      (
        name: '没有身份的 ok true 服务',
        body: '{"ok":true}',
        status: 200,
        expected: false,
      ),
      (name: '无效 JSON', body: 'not json', status: 200, expected: false),
      (name: '失败 HTTP 状态', body: _healthy, status: 503, expected: false),
    ];
    for (final response in responses) {
      test(response.name, () async {
        server.listen((request) {
          expect(request.uri.path, '/health');
          request.response.statusCode = response.status;
          request.response.headers.contentType = ContentType.json;
          request.response.write(response.body);
          unawaited(request.response.close());
        });
        expect(await serverAlive(url()), response.expected);
      });
    }

    test('响应正文无效 UTF8 时拒绝', () async {
      server.listen((request) {
        request.response.add([0xff, 0xfe]);
        unawaited(request.response.close());
      });
      expect(await serverAlive(url()), isFalse);
    });

    test('没有 Content-Length 的分块正文超限后立即拒绝', () async {
      server.listen((request) async {
        final response = request.response;
        response.contentLength = -1;
        response.bufferOutput = false;
        try {
          response.write(_healthy);
          response.write(List.filled(maxHealthResponseBytes, ' ').join());
          await response.flush();
        } on IOException {
          // 拒绝超限正文时客户端会主动关闭连接。
        }
      });
      expect(
        await serverAlive(
          url(),
          timeout: const Duration(seconds: 3),
        ).timeout(const Duration(seconds: 1)),
        isFalse,
      );
    });

    test('恰好上限的分块健康响应可正常探活', () async {
      server.listen((request) {
        request.response.contentLength = -1;
        request.response.write(_healthy);
        request.response.write(
          List.filled(
            maxHealthResponseBytes - utf8.encode(_healthy).length,
            ' ',
          ).join(),
        );
        unawaited(request.response.close());
      });
      expect(await serverAlive(url()), isTrue);
    });

    test('Content-Length 已经超限时拒绝', () async {
      server.listen((request) async {
        final response = request.response;
        response.contentLength = maxHealthResponseBytes + 1;
        response.write(_healthy);
        try {
          await response.flush();
        } on IOException {
          // 已知正文超限时客户端无需等待传输完成。
        }
      });
      expect(await serverAlive(url()), isFalse);
    });

    test('响应正文一直不结束时在超时内返回失败', () async {
      server.listen((request) async {
        request.response.write('{"ok":true');
        try {
          await request.response.flush();
        } on HttpException {
          // 探活超时会主动关闭连接。
        }
      });
      final watch = Stopwatch()..start();
      expect(
        await serverAlive(url(), timeout: const Duration(milliseconds: 80)),
        isFalse,
      );
      expect(watch.elapsed, lessThan(const Duration(seconds: 2)));
    });
  });
}
