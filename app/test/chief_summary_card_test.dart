import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'dart:async';

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

  Widget host(AppState state, {String roomId = ''}) => AppScope(
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
                child: ChiefSummaryCard(roomId: roomId),
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

  testWidgets('★ 三个动作真的把 (id, action) 传给 resolveSummary', (tester) async {
    final fake = _FakeState()..summaries = [summary(id: 'sum_x')];
    await tester.pumpWidget(host(fake));
    await tester.pump();

    await tester.tap(find.text('是 · 发送'));
    await tester.pump();
    expect(fake.calls, contains('send:sum_x'));

    await tester.tap(find.text('否 · 暂不'));
    await tester.pump();
    expect(fake.calls, contains('defer:sum_x'));

    await tester.tap(find.text('忽略'));
    await tester.pump();
    expect(fake.calls, contains('ignore:sum_x'));
  });

  testWidgets('★ 防连点：一次点击只打一次 resolveSummary', (tester) async {
    final fake = _FakeState()..summaries = [summary(id: 'sum_y')]..hold = true;
    await tester.pumpWidget(host(fake));
    await tester.pump();

    await tester.tap(find.text('是 · 发送'));
    await tester.pump();
    await tester.tap(find.text('是 · 发送'));
    await tester.pump();
    expect(fake.calls.length, 1, reason: '提交中不许重复请求');

    fake.release();
    await tester.pumpAndSettle();
  });

  testWidgets('★ 失败要出声：resolveSummary 返回错误 → SnackBar', (tester) async {
    final fake = _FakeState()
      ..summaries = [summary(id: 'sum_z')]
      ..nextError = '汇总不存在';
    await tester.pumpWidget(host(fake));
    await tester.pump();

    await tester.tap(find.text('忽略'));
    await tester.pump();
    await tester.pump();
    expect(find.text('汇总不存在'), findsOneWidget, reason: '错误不许被吞掉');
  });

  testWidgets('★ 本房间发送不弹「去查看」；跨房间才弹且能跳回去', (tester) async {
    // 本房间：originRoomId == 当前房间 → 用户就在这儿，不该再提示
    final same = _FakeState()..summaries = [summary(id: 'sum_same')];
    await tester.pumpWidget(host(same, roomId: 'dm_main'));
    await tester.pump();
    await tester.tap(find.text('是 · 发送'));
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('汇总已发到'), findsNothing, reason: '本房间发送不该弹提示');

    // 跨房间：在部门群里点发送 → 提示 + 「去查看」
    final cross = _FakeState()..summaries = [summary(id: 'sum_cross')];
    await tester.pumpWidget(host(cross, roomId: 'room_dev'));
    await tester.pump();
    await tester.tap(find.text('是 · 发送'));
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('汇总已发到'), findsOneWidget);
    await tester.pumpAndSettle(); // 等 SnackBar 入场动画结束，否则命中测试落空
    await tester.tap(find.text('去查看'));
    await tester.pump();
    expect(cross.openedRooms, contains('dm_main'), reason: '跳转走 state 方法，不依赖回调时的 context');
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

/// 只覆写 `resolveSummary` 的假状态：用来断言浮窗到底把什么传给了服务端。
class _FakeState extends AppState {
  final List<String> calls = [];
  String? nextError;

  /// true = 挂住请求（测防连点）
  bool hold = false;
  final List<Completer<String?>> _pending = [];

  void release() {
    for (final c in _pending) {
      if (!c.isCompleted) c.complete(nextError);
    }
    _pending.clear();
  }

  @override
  Future<String?> resolveSummary(String id, String action) async {
    calls.add('$action:$id');
    if (!hold) return nextError;
    final completer = Completer<String?>();
    _pending.add(completer);
    return completer.future;
  }

  @override
  Future<void> loadSummaries() async {}

  final List<String> openedRooms = [];

  @override
  void requestRoom(String roomId) {
    openedRooms.add(roomId);
  }
}
