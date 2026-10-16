// 文件卡 + 站内预览窗。
//
// 用户要的三件事：
//   1. 文件要像飞书/微信那样直接出现在对话里（一张卡）
//   2. 点卡片弹出一个**站内**悬浮预览窗（不是把你踢到系统外部应用）
//   3. 下载按钮要**摆在该在的位置**：卡片上一个、预览窗标题栏 X 左边一个
//
// 第 3 条是位置要求，所以这里用坐标断言 —— 光断言"存在"是钉不住的。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/attachment_view.dart';

Attachment _file(String name, {int size = 8800}) => Attachment(
  id: 'a1',
  name: name,
  mime: 'text/markdown',
  kind: 'file',
  size: size,
);

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
    expect(
      barDownload.dx,
      lessThan(closeX.dx),
      reason: '★ 用户明确要求：下载按钮在 X 左边',
    );
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
}
