import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/automation_sheet.dart';

void main() {
  Widget host({
    required List<Automation> items,
    void Function(String, String, {int? everyMinutes, String? dailyAt})? onCreate,
  }) => MaterialApp(
    home: Scaffold(
      body: AutomationSheet(
        roomName: '量化算法组',
        items: items,
        onCreate: onCreate ?? (_, __, {everyMinutes, dailyAt}) {},
        onToggle: (_) {},
        onRunNow: (_) {},
        onDelete: (_) {},
      ),
    ),
  );

  testWidgets('没有任务时给用途提示', (tester) async {
    await tester.pumpWidget(host(items: const []));
    expect(find.textContaining('还没有定时任务'), findsOneWidget);
    expect(find.text('0 个在跑'), findsOneWidget);
  });

  testWidgets('列出任务与排期', (tester) async {
    await tester.pumpWidget(
      host(items: const [
        Automation(id: 'a1', title: '盘前简报', everyMinutes: 30, enabled: true),
        Automation(id: 'a2', title: '每日巡检', dailyAt: '09:30', enabled: false),
      ]),
    );
    expect(find.text('盘前简报'), findsOneWidget);
    expect(find.textContaining('每 30 分钟'), findsOneWidget);
    expect(find.textContaining('每天 09:30'), findsOneWidget);
    expect(find.text('1 个在跑'), findsOneWidget);
  });

  testWidgets('添加「每隔」任务时按分钟回调', (tester) async {
    String? title;
    String? prompt;
    int? every;
    await tester.pumpWidget(
      host(
        items: const [],
        onCreate: (t, p, {everyMinutes, dailyAt}) {
          title = t;
          prompt = p;
          every = everyMinutes;
        },
      ),
    );
    await tester.enterText(find.widgetWithText(TextField, '任务名（例如 盘前简报）'), '巡检');
    await tester.enterText(
      find.widgetWithText(TextField, '到点要它做什么（发给它的话）'),
      '看一遍日志',
    );
    await tester.tap(find.text('添加'));
    await tester.pump();
    expect(title, '巡检');
    expect(prompt, '看一遍日志');
    expect(every, 30);
  });
}
