// R43 任务板：Markdown 标记不能裸露、进行中的图标要真的转。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/text_utils.dart';
import 'package:pi_bot/widgets/task_board.dart';

TaskItem mkTask({String id = 't1', required String title, String status = 'open', String? owner, String detail = ''}) =>
    TaskItem(id: id, title: title, status: status, ownerName: owner, detail: detail);

Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  test('R43a stripMarkdown 去掉加粗/代码/标题标记', () {
    expect(stripMarkdown('**结论：** 这条不行'), isNot(contains('**')));
    expect(stripMarkdown('## 小标题'), isNot(contains('##')));
    expect(stripMarkdown('用 `config.yaml` 改'), isNot(contains('`')));
  });

  testWidgets('R43b 列表里的标题不显示裸 Markdown 标记', (tester) async {
    await tester.pumpWidget(wrap(TaskBoardSheet(
      roomName: '测试群',
      tasks: [mkTask(title: '**重要结论：** 渠道还能拿到')],
      onToggleDone: (_) {},
      onTogglePin: (_) {},
      onDelete: (_) {},
      onCreate: (_) {},
    )));
    await tester.pump();
    final texts = tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? '').toList();
    final joined = texts.join(' ');
    expect(joined.contains('**'), isFalse, reason: '列表里不能裸露 Markdown 标记');
    expect(joined.contains('重要结论'), isTrue);
  });

  testWidgets('R43c 进行中的任务图标真的在转', (tester) async {
    await tester.pumpWidget(wrap(TaskBoardSheet(
      roomName: '测试群',
      tasks: [mkTask(title: '正在跑的任务', status: 'doing')],
      onToggleDone: (_) {},
      onTogglePin: (_) {},
      onDelete: (_) {},
      onCreate: (_) {},
    )));
    await tester.pump();
    final rotations = find.byType(RotationTransition);
    expect(rotations, findsWidgets, reason: '进行中的任务必须有旋转动画');
    final before = tester.widgetList<RotationTransition>(rotations).first.turns.value;
    await tester.pump(const Duration(milliseconds: 400));
    final after = tester.widgetList<RotationTransition>(rotations).first.turns.value;
    expect(after, isNot(equals(before)), reason: '图标必须真的在转');
  });

  testWidgets('R43d 点任务能打开二级详情', (tester) async {
    await tester.pumpWidget(wrap(TaskBoardSheet(
      roomName: '测试群',
      tasks: [mkTask(title: '**结论**：渠道能拿到', detail: '## 完整分析 企业档价格 真实席位数')],
      onToggleDone: (_) {},
      onTogglePin: (_) {},
      onDelete: (_) {},
      onCreate: (_) {},
    )));
    await tester.pump();
    await tester.tap(find.textContaining('结论').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('企业档价格'), findsWidgets, reason: '点开必须能看到全文');
  });
}