import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/task_kanban.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> taskJson({
  required String id,
  required String state,
  required String title,
  String scope = '把任务列成四列',
  List<String> deliverables = const [],
  String leadBotName = '架构师',
  String leadBotId = 'b1',
  int updatedAt = 1000,
  int storeVersion = 1,
}) =>
    {
      'id': id,
      'roomId': 'r1',
      'rootTaskId': id,
      'revision': 1,
      'sequence': 1,
      'storeVersion': storeVersion,
      'state': state,
      'title': title,
      'scope': scope,
      'deliverables': deliverables,
      'updatedAt': updatedAt,
      'leadBotId': leadBotId,
      'leadBotName': leadBotName,
      'phase': 'active',
    };

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    BlobAvatar.animationsEnabled = false;
  });

  tearDown(() {
    BlobAvatar.animationsEnabled = true;
  });

  Future<AppState> pumpBoard(
    WidgetTester tester,
    List<Map<String, dynamic>> tasks, {
    Size size = const Size(1280, 900),
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final state = AppState();
    state.taskRuns.applyHello({'taskRuns': tasks});
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: L10n(
          controller: LocaleController(),
          child: MaterialApp(home: TaskKanbanPage(state: state)),
        ),
      ),
    );
    await tester.pump();
    return state;
  }

  testWidgets('四列都在，卡片按状态落列，统计与列内数量一致', (tester) async {
    await pumpBoard(tester, [
      taskJson(id: 'a', state: 'queued', title: '排期待做'),
      taskJson(id: 'b', state: 'running', title: '正在写代码'),
      taskJson(id: 'c', state: 'waiting_approval', title: '等你批准发布'),
      taskJson(id: 'd', state: 'completed', title: '重构看板数据源'),
    ]);

    for (final name in ['todo', 'doing', 'done', 'needsYou']) {
      expect(find.byKey(ValueKey('kanban-column-$name')), findsOneWidget,
          reason: '缺列 $name');
    }
    // 卡片标题落到对应列
    expect(find.text('排期待做'), findsOneWidget);
    expect(find.text('正在写代码'), findsOneWidget);
    expect(find.text('等你批准发布'), findsOneWidget);
    expect(find.text('重构看板数据源'), findsOneWidget);
    // 顶部一行摘要（不再四格重复）
    expect(find.byKey(const ValueKey('kanban-summary-needs-you')), findsOneWidget);
    expect(find.textContaining('共 4 个任务'), findsOneWidget);
  });

  testWidgets('「只看等我的」只留等你处理列', (tester) async {
    await pumpBoard(tester, [
      taskJson(id: 'a', state: 'running', title: '正在写代码'),
      taskJson(id: 'b', state: 'waiting_input', title: '等你选模型'),
    ]);

    expect(find.text('正在写代码'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('kanban-only-mine')));
    await tester.pump();

    expect(find.text('等你选模型'), findsOneWidget);
    expect(find.text('正在写代码'), findsNothing);
  });

  testWidgets('「只看等我的」与成员过滤可以叠加（不再互相覆盖）', (tester) async {
    await pumpBoard(tester, [
      taskJson(id: 'a1', state: 'waiting_approval', title: '甲等你批', leadBotName: '甲', leadBotId: 'b1'),
      taskJson(id: 'b1', state: 'waiting_input', title: '乙等你选', leadBotName: '乙', leadBotId: 'b2'),
      taskJson(id: 'a2', state: 'running', title: '甲在跑', leadBotName: '甲', leadBotId: 'b1'),
    ]);

    await tester.tap(find.byKey(const ValueKey('kanban-only-mine')));
    await tester.pump();
    // 只剩两张"等你处理"
    expect(find.text('甲等你批'), findsOneWidget);
    expect(find.text('乙等你选'), findsOneWidget);
    expect(find.text('甲在跑'), findsNothing);

    // 再按负责人过滤：只留甲的、且仍是待处理
    await tester.tap(find.byKey(const ValueKey('kanban-lead-甲')));
    await tester.pump();
    expect(find.text('甲等你批'), findsOneWidget);
    expect(find.text('乙等你选'), findsNothing);
  });

  testWidgets('看板页有刷新入口（进板会主动拉历史）', (tester) async {
    await pumpBoard(tester, [taskJson(id: 'x', state: 'completed', title: '历史任务')]);
    expect(find.byKey(const ValueKey('kanban-refresh')), findsOneWidget);
  });

  testWidgets('被取消的任务进「已完成」列要打「已取消」标记', (tester) async {
    await pumpBoard(tester, [
      taskJson(id: 'c1', state: 'cancelled', title: '被取消的活'),
      taskJson(id: 'c2', state: 'completed', title: '真正干完的活'),
    ]);

    expect(find.byKey(const ValueKey('kanban-cancelled-c1')), findsOneWidget);
    expect(find.byKey(const ValueKey('kanban-cancelled-c2')), findsNothing);
    expect(find.text('已取消'), findsOneWidget);
  });

  testWidgets('已完成列里的旧对话片段默认折叠，点开才显示', (tester) async {
    await pumpBoard(tester, [
      taskJson(
        id: 'real',
        state: 'completed',
        title: '重构看板数据源',
        deliverables: ['app/lib/widgets/task_kanban.dart'],
      ),
      taskJson(id: 'legacy', state: 'completed', title: '收到。先看基线和色板…'),
    ]);

    // 真正有交付物的那条一直在
    expect(find.text('重构看板数据源'), findsOneWidget);
    // 旧片段被折叠
    expect(find.text('收到。先看基线和色板…'), findsNothing);
    expect(find.textContaining('旧对话记录'), findsOneWidget);

    await tester.tap(find.textContaining('旧对话记录'));
    await tester.pump();
    expect(find.text('收到。先看基线和色板…'), findsOneWidget);
  });

  testWidgets('成员过滤：选中某个负责人后只剩他的卡', (tester) async {
    await pumpBoard(tester, [
      taskJson(id: 'a', state: 'running', title: '甲的任务', leadBotName: '甲', leadBotId: 'b1'),
      taskJson(id: 'b', state: 'running', title: '乙的任务', leadBotName: '乙', leadBotId: 'b2'),
    ]);

    expect(find.text('甲的任务'), findsOneWidget);
    expect(find.text('乙的任务'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('kanban-lead-甲')));
    await tester.pump();

    expect(find.text('甲的任务'), findsOneWidget);
    expect(find.text('乙的任务'), findsNothing);
  });

  testWidgets('窄屏退化成横向滚动，四列仍都在', (tester) async {
    await pumpBoard(
      tester,
      [taskJson(id: 'a', state: 'running', title: '窄屏也要能看到')],
      size: const Size(420, 800),
    );
    expect(find.text('窄屏也要能看到'), findsOneWidget);
    // 窄屏是横向懒列表：先看得到第一列，滑到底能看到「等你处理」
    expect(find.byKey(const ValueKey('kanban-column-todo')), findsOneWidget);
    await tester.drag(find.byKey(const ValueKey('kanban-hscroll')), const Offset(-900, 0));
    await tester.pump();
    expect(find.byKey(const ValueKey('kanban-column-needsYou')), findsOneWidget);
  });
}
