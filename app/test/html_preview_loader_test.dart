import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:pi_bot/html_preview_loader.dart';

class _Client extends http.BaseClient {
  _Client(this.response);
  final Future<http.StreamedResponse> Function(http.BaseRequest) response;
  int calls = 0;
  int closes = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    calls++;
    return response(request);
  }

  @override
  void close() => closes++;
}

final _url = Uri.parse(
  'https://example.test/api/files/fixture?token=fixture-secret-value',
);
Matcher _code(String code) => isA<HtmlPreviewLoadException>()
    .having((e) => e.code, 'code', code)
    .having((e) => e.message.contains('fixture-secret-value'), '没有凭据', false);

void main() {
  test('仅按HTML扩展名或MIME开启预览', () {
    expect(isHtmlAttachment('report.HTML', 'application/octet-stream'), true);
    expect(isHtmlAttachment('report.htm', ''), true);
    expect(isHtmlAttachment('report', 'Text/HTML; charset=utf-8'), true);
    expect(isHtmlAttachment('report.html.txt', 'text/plain'), false);
    expect(isHtmlAttachment('image.svg', 'image/svg+xml'), false);
  });

  test('UTF-8、BOM和内联脚本完整保留', () {
    const html =
        '<!doctype html><meta charset="UTF-8"><p>报告🧪</p><script>const a=1;</script>';
    expect(decodeHtmlPreview(utf8.encode(html)), html);
    expect(decodeHtmlPreview([0xef, 0xbb, 0xbf, ...utf8.encode(html)]), html);
  });

  test('无效UTF-8、UTF-16和不支持的编码声明给出固定错误', () {
    for (final bytes in [
      [0xff, 0xfe, 0x61, 0x00],
      [0xc3, 0x28],
      utf8.encode('<meta charset="gbk"><p>fixture</p>'),
      utf8.encode(
        '<meta http-equiv="Content-Type" content="text/html; charset=GB18030">',
      ),
    ]) {
      expect(() => decodeHtmlPreview(bytes), throwsA(_code('encoding')));
    }
    expect(
      () => decodeHtmlPreview([65], contentType: 'text/html; charset=latin1'),
      throwsA(_code('encoding')),
    );
  });

  test('单文件最大1MiB，边界内不截断', () {
    final bytes = List.filled(htmlPreviewMaxBytes, 65);
    expect(decodeHtmlPreview(bytes).length, htmlPreviewMaxBytes);
    expect(
      () => decodeHtmlPreview([...bytes, 65]),
      throwsA(_code('too_large')),
    );
  });

  test('读取使用GET且不跟随携凭据的重定向', () async {
    final client = _Client((request) async {
      expect(request.method, 'GET');
      expect(request.followRedirects, false);
      expect(request.url, _url);
      return http.StreamedResponse(
        Stream.value(utf8.encode('<h1>完整报告</h1>')),
        200,
      );
    });
    expect(await HtmlPreviewLoader(client: client).load(_url), '<h1>完整报告</h1>');
    expect(client.closes, 1);
  });

  test('声明超限时不发请求', () async {
    final client = _Client((_) async => throw StateError('不应调用'));
    await expectLater(
      HtmlPreviewLoader(client: client)
          .load(_url, declaredSize: htmlPreviewMaxBytes + 1),
      throwsA(_code('too_large')),
    );
    expect(client.calls, 0);
    expect(client.closes, 1);
  });

  test('拒绝重定向、部分内容及HTTP错误', () async {
    for (final status in [302, 307, 206, 401, 500]) {
      final client = _Client(
        (_) async => http.StreamedResponse(
          const Stream.empty(),
          status,
          headers: {'location': 'https://example.test/other'},
        ),
      );
      await expectLater(
        HtmlPreviewLoader(client: client).load(_url),
        throwsA(_code(status >= 300 && status < 400 ? 'redirect' : 'http')),
      );
      expect(client.calls, 1);
      expect(client.closes, 1);
    }
  });

  test('Content-Length超限时不订阅正文', () async {
    var listened = false;
    final body = StreamController<List<int>>(onListen: () => listened = true);
    final client = _Client(
      (_) async => http.StreamedResponse(
        body.stream,
        200,
        contentLength: htmlPreviewMaxBytes + 1,
      ),
    );
    await expectLater(
      HtmlPreviewLoader(client: client).load(_url),
      throwsA(_code('too_large')),
    );
    expect(listened, false);
    expect(client.closes, 1);
    unawaited(body.close());
  });

  test('无长度的超限流会终止读取，不交付截断内容', () async {
    var cancelled = false;
    final body = StreamController<List<int>>(onCancel: () => cancelled = true);
    final client = _Client(
      (_) async => http.StreamedResponse(body.stream, 200),
    );
    final loading = HtmlPreviewLoader(client: client).load(_url);
    final expected = expectLater(loading, throwsA(_code('too_large')));
    await Future<void>.delayed(Duration.zero);
    body.add(List.filled(htmlPreviewMaxBytes, 65));
    body.add([65]);
    await expected;
    expect(cancelled, true);
    expect(client.closes, 1);
    await body.close();
  });

  test('取消正文流与晚到响应不再交付内容', () async {
    var cancelled = false;
    final body = StreamController<List<int>>(onCancel: () => cancelled = true);
    final client = _Client(
      (_) async => http.StreamedResponse(body.stream, 200),
    );
    final loader = HtmlPreviewLoader(client: client);
    final expected = expectLater(
      loader.load(_url),
      throwsA(_code('cancelled')),
    );
    await Future<void>.delayed(Duration.zero);
    loader.cancel();
    await expected;
    expect(cancelled, true);
    expect(client.closes, 1);
    await body.close();
  });

  test('响应头等待同样受超时约束，错误不含URL', () async {
    final response = Completer<http.StreamedResponse>();
    final client = _Client((_) => response.future);
    final loader = HtmlPreviewLoader(
      client: client,
      timeout: const Duration(milliseconds: 10),
    );
    await expectLater(loader.load(_url), throwsA(_code('timeout')));
    expect(client.closes, 1);
    response.complete(http.StreamedResponse(const Stream.empty(), 200));
    await Future<void>.delayed(Duration.zero);
  });

  test('读取异常和非法地址使用脱敏错误', () async {
    final client = _Client((_) async => throw Exception(_url.toString()));
    await expectLater(
      HtmlPreviewLoader(client: client).load(_url),
      throwsA(_code('network')),
    );
    final invalid = _Client((_) async => throw StateError('不应请求'));
    await expectLater(
      HtmlPreviewLoader(client: invalid)
          .load(Uri.parse('file:///fixture.html')),
      throwsA(_code('address')),
    );
    expect(invalid.calls, 0);
  });
}
