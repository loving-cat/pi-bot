import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/approval_card.dart';

void main() {
  Msg card({String? decision}) => Msg(
    id: 'm1',
    roomId: 'r1',
    authorType: 'bot',
    authorId: 'b1',
    authorName: '数据工程师',
    text: '数据工程师 想执行：rm -rf build',
    status: 'done',
    kind: 'approval',
    createdAt: DateTime.now().millisecondsSinceEpoch,
    meta: {
      'approvalId': 'ap_1',
      'tool': 'bash',
      'summary': 'rm -rf build',
      if (decision != null) 'decision': decision,
    },
  );

  Widget host(Msg msg, void Function(bool) onDecide) => MaterialApp(
    home: Scaffold(body: Center(child: ApprovalCard(msg: msg, onDecide: onDecide))),
  );

  testWidgets('待批准：两个按钮，点批准回调 true', (tester) async {
    bool? decided;
    await tester.pumpWidget(host(card(), (v) => decided = v));
    expect(find.textContaining('需要你批准'), findsOneWidget);
    expect(find.text('rm -rf build'), findsOneWidget);

    await tester.tap(find.text('批准这一次'));
    await tester.pump();
    expect(decided, true);
    // 点过之后按钮禁用（不重复发）
    final btn = tester.widget<FilledButton>(find.byType(FilledButton));
    expect(btn.onPressed, isNull);
  });

  testWidgets('拒绝：回调 false', (tester) async {
    bool? decided;
    await tester.pumpWidget(host(card(), (v) => decided = v));
    await tester.tap(find.text('拒绝'));
    await tester.pump();
    expect(decided, false);
  });

  testWidgets('已批准：显示结果，不再有按钮', (tester) async {
    await tester.pumpWidget(host(card(decision: 'approved'), (_) {}));
    expect(find.text('已批准'), findsOneWidget);
    expect(find.textContaining('接着做完'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('已拒绝：说明不会执行', (tester) async {
    await tester.pumpWidget(host(card(decision: 'denied'), (_) {}));
    expect(find.text('已拒绝'), findsOneWidget);
    expect(find.textContaining('不会执行'), findsOneWidget);
  });
}
