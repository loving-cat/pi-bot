import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/chief_summary_card.dart';

/// 主控总汇总浮窗（SPEC-CHIEF-SUMMARY §4 / Stage 3）。
///
/// 盯四条：
///   1. `ready_blocked` 渲展开卡片，三个动作各自的语义文案在；
///   2. `defer` 之后只剩小角标，点开能再展开；
///   3. 多条只渲 1 张 + 「还有 N 条」；
///   4. **静止态 0 Ticker**（动效红线），且 `sending` 是只读胶囊。
void main() {
  ChiefSummary summary({
    String id = 'sum_1',
    String title = '重构行情抓取并发调度',
    String state = 'ready_blocked',
    int done = 1,
    int failed = 0,
    String lastError = '',
  }) => ChiefSummary(
    id: id,
    taskTitle: title,
    state: state,
    originRoomId: 'dm_main',
    lastError: lastError,
    targets: [
      for (var i = 0; i < done; i++)
        ChiefSummaryTarget(key: 'g$i', departmentName: '部门$i', status: 'done', leadSummary: '做完了'),
      for (var i = 0; i < failed; i++)
        ChiefSummaryTarget(key: 'f$i', departmentName: '受阻$i', status: 'failed'),
    ],
  );

  Widget host(AppState state) => AppScope(
    state: state,
    child: MaterialApp(
      theme: PB.theme(),
      home: Scaffold(
        body: Stack(
          children: [
            const SizedBox.expand(),
            Positioned(
              top: 12,
              right: 28,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 300),
                child: const ChiefSummaryCard(),
              ),
            ),
          ],
        ),
      ),
    ),
  );

  testWidgets('ready_blocked：渲展开卡片 + 三个动作 + 部门进度', (tester) async {
    final state = AppState()
      ..summaries = [summary(done: 2, failed: 1)];

    await tester.pumpWidget(host(state));
    await tester.pump();

    expect(find.textContaining('汇总已准备好'), findsOneWidget);
    expect(find.textContaining('2 个部门已完成'), findsOneWidget);
    expect(find.textContaining('1 个受阻'), findsOneWidget);
    expect(find.text('是 · 发送'), findsOneWidget);
    expect(find.text('否 · 暂不'), findsOneWidget);
    expect(find.text('忽略'), findsOneWidget);
  });

  testWidgets('多条：只渲 1 张 + 「还有 N 条汇总待处理」', (tester) async {
    final state = AppState()
      ..summaries = [
        summary(id: 'a', title: '任务 A'),
        summary(id: 'b', title: '任务 B'),
        summary(id: 'c', title: '任务 C'),
      ];

    await tester.pumpWidget(host(state));
    await tester.pump();

    expect(find.textContaining('任务 A'), findsOneWidget);
    expect(find.textContaining('任务 B'), findsNothing, reason: '防刷屏：只渲队首一张');
    expect(find.textContaining('还有 2 条'), findsOneWidget);
  });

  testWidgets('deferred：只剩小角标，点开后能再展开', (tester) async {
    final state = AppState()..summaries = [summary(state: 'deferred')];

    await tester.pumpWidget(host(state));
    await tester.pump();
    expect(find.textContaining('汇总待看'), findsOneWidget);
    expect(find.text('是 · 发送'), findsNothing);

    await tester.tap(find.textContaining('汇总待看'));
    await tester.pump();
    expect(find.text('是 · 发送'), findsOneWidget, reason: '点角标就地展开');
    expect(find.text('收起'), findsOneWidget, reason: '展开态里「否」变成「收起」');
  });

  testWidgets('sending / queued_send：只读胶囊，不给动作', (tester) async {
    for (final (state, label) in [
      ('sending', '正在汇总…'),
      ('queued_send', '本轮结束后发送汇总'),
    ]) {
      final app = AppState()..summaries = [summary(state: state)];
      await tester.pumpWidget(host(app));
      await tester.pump();
      expect(find.text(label), findsOneWidget);
      expect(find.text('是 · 发送'), findsNothing);
      expect(find.text('忽略'), findsNothing);
    }
  });

  testWidgets('发送失败过：把 lastError 显示出来（不静默）', (tester) async {
    final state = AppState()..summaries = [summary(lastError: '429 too many requests')];
    await tester.pumpWidget(host(state));
    await tester.pump();
    expect(find.textContaining('429'), findsOneWidget);
  });

  testWidgets('空列表：什么都不画（不占位、不留空白卡）', (tester) async {
    final state = AppState();
    await tester.pumpWidget(host(state));
    await tester.pump();
    expect(find.byType(ChiefSummaryCard), findsOneWidget);
    expect(find.textContaining('汇总'), findsNothing);
  });

  testWidgets('★ 静止态 0 Ticker：浮卡不常驻动画（动效红线）', (tester) async {
    final state = AppState()..summaries = [summary(done: 3)];
    await tester.pumpWidget(host(state));
    await tester.pump();
    // 有 Ticker 在跑的话 pumpAndSettle 会超时；这里直接断言能静下来
    await tester.pumpAndSettle(const Duration(seconds: 1));
    expect(tester.binding.hasScheduledFrame, isFalse, reason: '静止态不许有持续重绘');
  });
}
