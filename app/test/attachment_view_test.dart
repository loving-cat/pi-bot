// 文件卡 + 站内预览窗。
//
// 要钉住的三件事：
//   1. 文件要像飞书/微信那样直接出现在对话里（一张卡）
//   2. 点卡片弹出一个**站内**悬浮预览窗（而不是跳到系统外部应用）
//   3. 下载按钮要**摆在该在的位置**：卡片上一个、预览窗标题栏 X 左边一个
//
// 第 3 条是位置要求，所以这里用坐标断言 —— 光断言"存在"是钉不住的。
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/attachment_view.dart';
import 'package:pi_bot/widgets/html_attachment_preview.dart';

class _NoNetwork extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) => _NoNetworkClient();
}

class _NoNetworkClient extends Fake implements HttpClient {
  @override
  bool autoUncompress = false;

  @override
  Future<HttpClientRequest> getUrl(Uri url) async =>
      throw const SocketException('fixture request blocked');

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async =>
      throw const SocketException('fixture request blocked');

  @override
  void close({bool force = false}) {}
}

Attachment _file(String name, {int size = 8800}) => Attachment(
  id: 'a1',
  name: name,
  mime: 'text/markdown',
  kind: 'file',
  size: size,
);

Attachment _image(int index) => Attachment(
  id: 'fixture-image-$index',
  name: 'image-$index.png',
  mime: 'image/png',
  kind: 'image',
);

Future<void> _pumpList(
  WidgetTester tester, {
  required List<Attachment> items,
  double width = 900,
  double maxWidth = 400,
  bool alignEnd = false,
  VoidCallback? onLongPress,
}) async {
  tester.view.physicalSize = const Size(1000, 760);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: width,
            child: Align(
              alignment: alignEnd
                  ? Alignment.centerRight
                  : Alignment.centerLeft,
              child: AttachmentList(
                items: items,
                urlFor: (id) => 'http://127.0.0.1:1/api/files/$id',
                maxWidth: maxWidth,
                alignEnd: alignEnd,
                onLongPress: onLongPress,
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _pumpCard(WidgetTester tester, Attachment file) async {
  tester.view.physicalSize = const Size(900, 700);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Center(
          child: AttachmentList(
            items: [file],
            urlFor: (id) => 'http://127.0.0.1:1/api/files/$id',
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  setUp(() {
    final previous = HttpOverrides.current;
    HttpOverrides.global = _NoNetwork();
    addTearDown(() => HttpOverrides.global = previous);
  });

  for (final alignEnd in [false, true]) {
    testWidgets('纯图片限制宽度并按${alignEnd ? '右' : '左'}侧换行对齐', (tester) async {
      await _pumpList(
        tester,
        items: [_image(1), _image(2), _image(3)],
        alignEnd: alignEnd,
      );

      expect(
        tester.getSize(find.byType(AttachmentList)).width,
        lessThanOrEqualTo(400),
      );
      final images = find.byType(Image);
      final first = tester.getRect(images.at(0));
      final second = tester.getRect(images.at(1));
      final third = tester.getRect(images.at(2));
      expect(second.top, first.top);
      expect(third.top, greaterThan(first.bottom));
      if (alignEnd) {
        expect(third.right, closeTo(second.right, 0.1));
      } else {
        expect(third.left, closeTo(first.left, 0.1));
      }
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('窄窗口中的纯图、文件及混合附件均遵守宽度约束', (tester) async {
    for (final items in [
      [_image(4), _image(5)],
      [_file('summary.md'), _file('another-report.md')],
      [_image(6), _file('mixed-report.md')],
    ]) {
      await _pumpList(tester, items: items, width: 320, maxWidth: 220);
      expect(
        tester.getSize(find.byType(AttachmentList)).width,
        lessThanOrEqualTo(220),
      );
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets('文件长按交给消息操作，普通点击仍打开预览', (tester) async {
    var longPresses = 0;
    await _pumpList(
      tester,
      items: [_file('fixture.md')],
      onLongPress: () => longPresses++,
    );

    await tester.longPress(find.text('fixture.md'));
    await tester.pumpAndSettle();
    expect(longPresses, 1);
    expect(find.byIcon(LucideIcons.x), findsNothing);

    await tester.tap(find.text('fixture.md'));
    await tester.pumpAndSettle();
    expect(longPresses, 1);
    expect(find.byIcon(LucideIcons.x), findsOneWidget);
    expect(find.byTooltip('下载'), findsWidgets);
    expect(find.byTooltip('用系统应用打开'), findsOneWidget);
  });

  testWidgets('图片长按交给消息操作，普通点击仍打开看图页', (tester) async {
    var longPresses = 0;
    await _pumpList(
      tester,
      items: [_image(7)],
      onLongPress: () => longPresses++,
    );

    await tester.longPress(find.byType(Image));
    await tester.pumpAndSettle();
    expect(longPresses, 1);
    expect(find.byType(InteractiveViewer), findsNothing);

    await tester.tap(find.byType(Image));
    await tester.pumpAndSettle();
    expect(longPresses, 1);
    expect(find.byType(InteractiveViewer), findsOneWidget);
    expect(find.byIcon(LucideIcons.x), findsOneWidget);
  });

  testWidgets('★ 多个文件 → 独立成块（块头 + 每行等宽排开，不塞进气泡）', (tester) async {
    final files = [
      for (var i = 0; i < 5; i++)
        _file('CSI1000量化多头_基金自主研究报告_$i.html', size: 323000),
    ];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 600,
              child: AttachmentList(
                items: files,
                urlFor: (id) => 'http://127.0.0.1:1/api/files/$id',
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('附件 5 个文件'), findsOneWidget, reason: '块头要写清数量');
    expect(find.textContaining('CSI1000量化多头'), findsNWidgets(5));
    expect(tester.takeException(), isNull, reason: '多文件不能溢出/报错');
  });

  testWidgets('文件卡上有独立的下载按钮（不用点进去再找）', (tester) async {
    await _pumpCard(tester, _file('summary.md'));
    expect(find.text('summary.md'), findsOneWidget);
    expect(find.text('9KB'), findsOneWidget, reason: '大小要看得见');
    expect(find.byIcon(LucideIcons.download), findsOneWidget);
  });

  testWidgets('点卡片本体 → 弹出站内预览窗（不再直接跳系统外部应用）', (tester) async {
    await _pumpCard(tester, _file('summary.md'));
    await tester.tap(find.text('summary.md'));
    await tester.pumpAndSettle();

    // 预览窗起来了：标题栏有文件名、有关闭
    expect(find.byIcon(LucideIcons.x), findsOneWidget);
    expect(find.text('summary.md'), findsWidgets);
  });

  testWidgets('★ 预览窗的下载按钮在 X 左边', (tester) async {
    await _pumpCard(tester, _file('summary.md'));
    await tester.tap(find.text('summary.md'));
    await tester.pumpAndSettle();

    final closeX = tester.getCenter(find.byIcon(LucideIcons.x));

    // ★ 注意：预览窗是压在下层路由上的，下层那张文件卡**还在树里** ——
    //   所以不能直接取 .first，得挑"和 X 同一行"的那个。
    final downloads = find.byIcon(LucideIcons.download);
    final centers = <Offset>[
      for (var i = 0; i < tester.widgetList(downloads).length; i++)
        tester.getCenter(downloads.at(i)),
    ];
    final inBar = centers.where((c) => (c.dy - closeX.dy).abs() < 8).toList();

    expect(inBar, isNotEmpty, reason: '标题栏里必须有一个下载按钮');
    final barDownload = inBar.first;
    expect(barDownload.dx, lessThan(closeX.dx), reason: '★ 用户明确要求：下载按钮在 X 左边');
    expect(
      closeX.dx - barDownload.dx,
      lessThan(120),
      reason: '要挨着 X，不能漂到标题栏另一头',
    );
  });

  testWidgets('预览窗能关掉', (tester) async {
    await _pumpCard(tester, _file('summary.md'));
    await tester.tap(find.text('summary.md'));
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(LucideIcons.x));
    await tester.pumpAndSettle();
    expect(find.byIcon(LucideIcons.x), findsNothing);
  });

  testWidgets('图片附件直接画出来，不当文件卡', (tester) async {
    await _pumpCard(
      tester,
      Attachment(id: 'i1', name: 'shot.png', mime: 'image/png', kind: 'image'),
    );
    expect(find.byIcon(LucideIcons.download), findsNothing);
  });

  testWidgets('HTML进入独立预览，可扩大恢复并正常关闭', (tester) async {
    await _pumpCard(tester, _file('report.HTM'));
    await tester.tap(find.text('report.HTM'));
    await tester.pumpAndSettle();
    expect(find.byType(HtmlAttachmentPreview), findsOneWidget);
    final initialSize = tester.getSize(find.byType(HtmlAttachmentPreview));
    await tester.tap(find.text('放大'));
    await tester.pumpAndSettle();
    final expandedSize = tester.getSize(find.byType(HtmlAttachmentPreview));
    expect(expandedSize.width, greaterThan(initialSize.width));
    expect(expandedSize.height, greaterThan(initialSize.height));
    await tester.tap(find.text('恢复'));
    await tester.pumpAndSettle();
    expect(tester.getSize(find.byType(HtmlAttachmentPreview)), initialSize);
    await tester.tap(find.byIcon(LucideIcons.x));
    await tester.pumpAndSettle();
    expect(find.byType(HtmlAttachmentPreview), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('HTML超限保留下载出口且不尝试截断预览', (tester) async {
    await _pumpCard(tester, _file('large.html', size: 1024 * 1024 + 1));
    await tester.tap(find.text('large.html'));
    await tester.pumpAndSettle();
    expect(find.textContaining('文件超过 1 MiB'), findsOneWidget);
    expect(find.byIcon(LucideIcons.download), findsWidgets);
    expect(find.text('源码'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
