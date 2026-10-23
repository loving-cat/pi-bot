import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/widgets/md_text.dart';

void main() {
  testWidgets('★ 行内代码里的网址点一下就能复制（不用拖选）', (tester) async {
    String? copied;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copied = (call.arguments as Map)['text'] as String?;
      }
      return null;
    });

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: Center(child: MdText('`http://127.0.0.1:8765/`'))),
      ),
    );
    await tester.pump();

    await tester.tap(find.textContaining('127.0.0.1', findRichText: true));
    await tester.pump();

    expect(copied, 'http://127.0.0.1:8765/');
  });

  testWidgets('★ 裸网址也点一下复制', (tester) async {
    String? copied;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copied = (call.arguments as Map)['text'] as String?;
      }
      return null;
    });

    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: Center(child: MdText('地址 http://127.0.0.1:8765/ 收好'))),
      ),
    );
    await tester.pump();

    final rect = tester.getRect(find.textContaining('127.0.0.1', findRichText: true));
    // 点网址所在区域（文本为单行，网址在中间偏右）
    await tester.tapAt(Offset(rect.center.dx, rect.center.dy));
    await tester.pump();

    expect(copied, 'http://127.0.0.1:8765/');
  });
}
