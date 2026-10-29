import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:pi_bot/html_preview_loader.dart';
import 'package:pi_bot/widgets/html_attachment_preview.dart';

class _Client extends http.BaseClient {
  _Client(this.response);
  final Future<http.StreamedResponse> Function(http.BaseRequest) response;
  int closes = 0;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      response(request);
  @override
  void close() => closes++;
}

final _source = Uri.parse(
  'https://example.test/file?token=fixture-secret-value',
);
HtmlPreviewLoader _loader(String html) => HtmlPreviewLoader(
  client: _Client(
    (_) async => http.StreamedResponse(Stream.value(utf8.encode(html)), 200),
  ),
);

Widget _renderer(
  BuildContext context, {
  required String html,
  required VoidCallback onReady,
  required ValueChanged<String> onError,
  required ValueChanged<Uri> onExternalLink,
}) {
  onReady();
  return const ColoredBox(color: Colors.white, child: Text('fixture rendered'));
}

Widget _host({
  required HtmlPreviewLoader Function() loader,
  Uri? source,
  HtmlPreviewRendererBuilder? renderer,
  Future<void> Function(Uri)? onExternalLink,
  Duration renderTimeout = const Duration(seconds: 20),
}) => MaterialApp(
  home: Scaffold(
    body: SizedBox(
      width: 700,
      height: 500,
      child: HtmlAttachmentPreview(
        source: source ?? _source,
        loaderFactory: loader,
        rendererBuilder: renderer ?? _renderer,
        onExternalLink: onExternalLink,
        renderTimeout: renderTimeout,
      ),
    ),
  ),
);

void main() {
  testWidgets('默认预览，渲染器只收到完整HTML而非带凭据地址', (tester) async {
    const html =
        '<html><body>报告内容<script>const value=1;</script></body></html>';
    String? received;
    await tester.pumpWidget(
      _host(
        loader: () => _loader(html),
        renderer:
            (
              context, {
              required html,
              required onReady,
              required onError,
              required onExternalLink,
            }) {
              received = html;
              return _renderer(
                context,
                html: html,
                onReady: onReady,
                onError: onError,
                onExternalLink: onExternalLink,
              );
            },
      ),
    );
    await tester.pumpAndSettle();
    expect(received, html);
    expect(received, isNot(contains('fixture-secret-value')));
    expect(find.text('fixture rendered'), findsOneWidget);
    expect(find.byType(SelectableText), findsNothing);
    expect(find.text('离线预览，外部资源不会加载'), findsOneWidget);
  });

  testWidgets('源码可选择复制，切回预览会重新等待渲染就绪', (tester) async {
    const html = '<h1>合成报告</h1>';
    final callbacks = <VoidCallback>[];
    await tester.pumpWidget(
      _host(
        loader: () => _loader(html),
        renderer:
            (
              context, {
              required html,
              required onReady,
              required onError,
              required onExternalLink,
            }) {
              callbacks.add(onReady);
              return const Text('fixture renderer');
            },
      ),
    );
    await tester.pump();
    callbacks.last();
    await tester.pumpAndSettle();
    await tester.tap(find.text('源码'));
    await tester.pumpAndSettle();
    expect(find.byType(SelectableText), findsOneWidget);
    expect(find.text(html), findsOneWidget);
    await tester.tap(find.text('预览'));
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    callbacks.last();
    await tester.pumpAndSettle();
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('渲染失败可切源码，晚到ready不覆盖错误', (tester) async {
    VoidCallback? ready;
    await tester.pumpWidget(
      _host(
        loader: () => _loader('<p>fixture</p>'),
        renderer:
            (
              context, {
              required html,
              required onReady,
              required onError,
              required onExternalLink,
            }) {
              ready = onReady;
              onError('此系统暂时无法预览网页。');
              return const SizedBox();
            },
      ),
    );
    await tester.pumpAndSettle();
    ready!();
    await tester.pump();
    expect(find.text('此系统暂时无法预览网页。'), findsOneWidget);
    await tester.tap(find.text('查看源码'));
    await tester.pumpAndSettle();
    expect(find.text('<p>fixture</p>'), findsOneWidget);
  });

  testWidgets('网页加载超时释放渲染视图并提供源码出口', (tester) async {
    await tester.pumpWidget(
      _host(
        loader: () => _loader('<p>fixture</p>'),
        renderTimeout: const Duration(milliseconds: 50),
        renderer: (
          context, {
          required html,
          required onReady,
          required onError,
          required onExternalLink,
        }) => const Text('fixture waiting'),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 80));
    await tester.pump();
    expect(find.text('fixture waiting'), findsNothing);
    expect(find.text('查看源码'), findsOneWidget);
  });

  testWidgets('获取失败不显示地址凭据，重试可以恢复', (tester) async {
    var attempts = 0;
    await tester.pumpWidget(
      _host(
        loader: () {
          attempts++;
          if (attempts == 1)
            return HtmlPreviewLoader(
              client: _Client((_) async => throw Exception(_source.toString())),
            );
          return _loader('<p>fixture</p>');
        },
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('fixture-secret-value'), findsNothing);
    expect(find.text('重试'), findsOneWidget);
    await tester.tap(find.text('重试'));
    await tester.pumpAndSettle();
    expect(find.text('fixture rendered'), findsOneWidget);
  });

  testWidgets('切换附件或销毁后丢弃旧请求结果', (tester) async {
    final response = Completer<http.StreamedResponse>();
    final client = _Client((_) => response.future);
    await tester.pumpWidget(
      _host(loader: () => HtmlPreviewLoader(client: client)),
    );
    await tester.pump();
    await tester.pumpWidget(
      _host(
        source: Uri.parse('https://example.test/next'),
        loader: () => _loader('<p>new</p>'),
      ),
    );
    await tester.pumpAndSettle();
    response.complete(
      http.StreamedResponse(Stream.value(utf8.encode('<p>old</p>')), 200),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('源码'));
    await tester.pumpAndSettle();
    expect(find.text('<p>new</p>'), findsOneWidget);
    expect(find.text('<p>old</p>'), findsNothing);
    expect(client.closes, 1);
    await tester.pumpWidget(const SizedBox());
    expect(tester.takeException(), isNull);
  });

  testWidgets('关闭预览中止读取并忽略晚到渲染回调', (tester) async {
    VoidCallback? ready;
    ValueChanged<String>? error;
    await tester.pumpWidget(
      _host(
        loader: () => _loader('fixture'),
        renderer:
            (
              context, {
              required html,
              required onReady,
              required onError,
              required onExternalLink,
            }) {
              ready = onReady;
              error = onError;
              return const SizedBox();
            },
      ),
    );
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    ready!();
    error!('late');
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('报告脚本发来的外链回调不能打开浏览器', (tester) async {
    var opened = 0;
    await tester.pumpWidget(
      _host(
        loader: () => _loader('<p>fixture</p>'),
        onExternalLink: (_) async => opened++,
        renderer:
            (
              context, {
              required html,
              required onReady,
              required onError,
              required onExternalLink,
            }) {
              onExternalLink(Uri.parse('https://example.com/forged'));
              onReady();
              return const SizedBox();
            },
      ),
    );
    await tester.pumpAndSettle();
    expect(opened, 0);
    expect(find.text('在浏览器中打开？'), findsNothing);
  });

  testWidgets('静态外链只有用户在宿主确认后才打开', (tester) async {
    Uri? opened;
    const html = '<a href="https://example.com/report">来源</a>';
    await tester.pumpWidget(
      _host(
        loader: () => _loader(html),
        onExternalLink: (target) async => opened = target,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('外部链接'));
    await tester.pumpAndSettle();
    expect(find.text('fixture rendered'), findsNothing);
    await tester.tap(find.text('example.com'));
    await tester.pumpAndSettle();
    expect(opened, isNull);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(opened, isNull);
    await tester.tap(find.text('外部链接'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('example.com'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('打开链接'));
    await tester.pumpAndSettle();
    expect(opened.toString(), 'https://example.com/report');
    expect(find.text('fixture rendered'), findsOneWidget);
  });

  testWidgets('窄窗口工具栏不溢出', (tester) async {
    tester.view.physicalSize = const Size(320, 600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      _host(loader: () => _loader('<a href="https://example.com">来源</a>')),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('外部链接'), findsOneWidget);
  });
}
