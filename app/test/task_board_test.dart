import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/task_board.dart';

class _TaskState extends AppState {
  @override
  Future<void> refreshTasks() async {}

  @override
  Future<void> createTask({
    required String roomId,
    required String title,
  }) async {
    tasks = [TaskItem(id: 'fixture-task', roomId: roomId, title: title)];
    notifyListeners();
  }

  @override
  Future<void> updateTask(String id, Map<String, dynamic> patch) async {
    tasks = tasks
        .map(
          (task) => TaskItem(
            id: task.id,
            roomId: task.roomId,
            title: task.title,
            status: patch['status'] as String? ?? task.status,
            pinnedAt: patch['pinned'] == true ? 1 : task.pinnedAt,
          ),
        )
        .toList();
    notifyListeners();
  }

  @override
  Future<void> deleteTask(String id) async {
    tasks = tasks.where((task) => task.id != id).toList();
    notifyListeners();
  }
}

void main() {
  Widget host({
    required List<TaskItem> tasks,
    void Function(TaskItem)? onDone,
    void Function(TaskItem)? onPin,
    void Function(TaskItem)? onDelete,
    void Function(String)? onCreate,
  }) => MaterialApp(
    home: Scaffold(
      body: TaskBoardSheet(
        roomName: '量化算法组',
        tasks: tasks,
        onToggleDone: onDone ?? (_) {},
        onTogglePin: onPin ?? (_) {},
        onDelete: onDelete ?? (_) {},
        onCreate: onCreate ?? (_) {},
      ),
    ),
  );

  final tasks = [
    TaskItem(id: 't1', title: '拉日线', status: 'doing', ownerName: '数据工程师'),
    TaskItem(id: 't2', title: '写周报', status: 'open'),
    TaskItem(id: 't3', title: '跑回测', status: 'done', ownerName: '回测工程师'),
  ];

  testWidgets('分三组展示，未完成计数正确', (tester) async {
    await tester.pumpWidget(host(tasks: tasks));
    expect(find.text('任务 · 量化算法组'), findsOneWidget);
    expect(find.text('2 个未完成'), findsOneWidget);
    expect(find.text('进行中'), findsOneWidget);
    expect(find.text('待办'), findsOneWidget);
    expect(find.textContaining('拉日线'), findsOneWidget);
    expect(find.textContaining('写周报'), findsOneWidget);
  });

  testWidgets('已完成默认折叠，点开才出现', (tester) async {
    await tester.pumpWidget(host(tasks: tasks));
    expect(find.textContaining('跑回测'), findsNothing);
    await tester.tap(find.textContaining('已完成 1'));
    await tester.pump();
    expect(find.textContaining('跑回测'), findsOneWidget);
  });

  testWidgets('勾选完成会回调', (tester) async {
    TaskItem? hit;
    await tester.pumpWidget(host(tasks: tasks, onDone: (t) => hit = t));
    // 第一行（进行中）的勾选按钮
    await tester.tap(find.byIcon(LucideIcons.circle).first);
    await tester.pump();
    expect(hit?.id, 't2');
  });

  testWidgets('同一句话派给多人：合并成一行，列出执行者', (tester) async {
    const title = '系统已正式接入，做一次接入自检，让用户看见这个团队确实能用。';
    final dup = [
      TaskItem(id: 'd1', title: title, status: 'doing', ownerName: '基金研究员'),
      TaskItem(id: 'd2', title: title, status: 'doing', ownerName: '组合分析师'),
      TaskItem(id: 'd3', title: title, status: 'doing', ownerName: '记录核对员'),
    ];
    final hits = <String>[];
    await tester.pumpWidget(host(tasks: dup, onDone: (t) => hits.add(t.id)));

    // 只出现一次标题，副标题说清是谁
    expect(find.textContaining('系统已正式接入'), findsOneWidget);
    expect(find.textContaining('3 人：'), findsOneWidget);
    expect(find.textContaining('基金研究员'), findsOneWidget);

    // 勾一次 = 三条一起标完成（同一条指令，不该只标一个人）
    await tester.tap(find.byIcon(LucideIcons.loader).first);
    await tester.pump();
    expect(hits, containsAll(['d1', 'd2', 'd3']));
  });

  testWidgets('输入标题后按加号会回调 onCreate', (tester) async {
    String? created;
    await tester.pumpWidget(
      host(tasks: const [], onCreate: (t) => created = t),
    );
    await tester.enterText(find.byType(TextField), '  新任务  ');
    await tester.tap(find.byIcon(LucideIcons.plus));
    await tester.pump();
    expect(created, '新任务');
  });

  testWidgets('空任务板给出提示', (tester) async {
    await tester.pumpWidget(host(tasks: const []));
    expect(find.textContaining('还没有任务'), findsOneWidget);
  });

  testWidgets('打开的任务板随状态更新增删、置顶和完成结果', (tester) async {
    final state = _TaskState();
    addTearDown(state.dispose);
    final room = Room(id: 'fixture-room', kind: 'dm', name: '验证房间', botIds: []);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showTaskBoard(context, state, room),
              child: const Text('打开任务板'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开任务板'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '验证任务');
    await tester.tap(find.byIcon(LucideIcons.plus));
    await tester.pumpAndSettle();
    expect(find.text('验证任务'), findsOneWidget);
    expect(find.text('1 个未完成'), findsOneWidget);
    await tester.tap(find.byTooltip('置顶'));
    await tester.pumpAndSettle();
    expect(find.byTooltip('取消置顶'), findsOneWidget);
    await tester.tap(find.byTooltip('标为完成'));
    await tester.pumpAndSettle();
    expect(find.text('0 个未完成'), findsOneWidget);
    await tester.tap(find.textContaining('已完成 1'));
    await tester.pumpAndSettle();
    expect(find.text('验证任务'), findsOneWidget);
    await tester.tap(find.byTooltip('删除'));
    await tester.pumpAndSettle();
    expect(find.text('验证任务'), findsNothing);
    expect(find.textContaining('还没有任务'), findsOneWidget);
  });
}
