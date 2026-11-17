// 电脑端那个"允许连接"弹窗：它决定谁能拿到 token，所以按钮行为要逐条钉死。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/pair_request.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/pair_request_dialog.dart';

PairRequestHost _request({int ttlMs = 60_000, String device = '我的手机', String ip = '192.168.1.30'}) =>
    PairRequestHost(
      id: 'a' * 32,
      device: device,
      platform: 'android',
      ip: ip,
      createdAt: DateTime.now().millisecondsSinceEpoch,
      expiresAt: DateTime.now().millisecondsSinceEpoch + ttlMs,
    );

/// 弹出对话框，返回 Future 以便断言"点了什么"
Future<Future<bool?>> _open(WidgetTester tester, PairRequestHost request) async {
  late Future<bool?> result;
  await tester.pumpWidget(
    L10n(
      controller: LocaleController(),
      child: MaterialApp(
        theme: PB.theme(),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () {
                  result = showDialog<bool>(
                    context: context,
                    barrierDismissible: false,
                    builder: (_) => PairRequestDialog(request: request),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
  return result;
}

void main() {
  testWidgets('弹窗里能看到是哪台手机、从哪个 IP 来', (tester) async {
    await _open(tester, _request());
    expect(find.text('一台手机想连接'), findsOneWidget);
    expect(find.textContaining('我的手机'), findsOneWidget);
    expect(find.text('192.168.1.30'), findsOneWidget, reason: '要让人能判断这是不是自己的手机');
    expect(find.text('允许'), findsOneWidget);
    expect(find.text('拒绝'), findsOneWidget);
  });

  testWidgets('点"允许"返回 true（调用方据此 approve）', (tester) async {
    final result = await _open(tester, _request());
    await tester.tap(find.text('允许'));
    await tester.pumpAndSettle();
    expect(await result, isTrue);
  });

  testWidgets('点"拒绝"返回 false', (tester) async {
    final result = await _open(tester, _request());
    await tester.tap(find.text('拒绝'));
    await tester.pumpAndSettle();
    expect(await result, isFalse);
  });

  testWidgets('点空白关不掉（误关会让手机那边一直等）', (tester) async {
    await _open(tester, _request());
    await tester.tapAt(const Offset(8, 8));
    await tester.pumpAndSettle();
    expect(find.text('一台手机想连接'), findsOneWidget, reason: '没选之前不该消失');
  });

  testWidgets('没人管 → 倒计时到 0 自己关掉，返回 null', (tester) async {
    final result = await _open(tester, _request(ttlMs: 1500));
    expect(find.textContaining('秒后自动失效'), findsOneWidget);
    // 1.5 秒后过期：timer 每秒 tick 一次，一秒一秒地推过去
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.text('一台手机想连接'), findsNothing, reason: '过期就该消失，不留一个挂着的授权入口');
    expect(await result, isNull);
  });
}
