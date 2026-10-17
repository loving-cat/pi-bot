import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/task_board.dart';

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

  testWidgets('输入标题后按加号会回调 onCreate', (tester) async {
    String? created;
    await tester.pumpWidget(host(tasks: const [], onCreate: (t) => created = t));
    await tester.enterText(find.byType(TextField), '  新任务  ');
    await tester.tap(find.byIcon(LucideIcons.plus));
    await tester.pump();
    expect(created, '新任务');
  });

  testWidgets('空任务板给出提示', (tester) async {
    await tester.pumpWidget(host(tasks: const []));
    expect(find.textContaining('还没有任务'), findsOneWidget);
  });
}

