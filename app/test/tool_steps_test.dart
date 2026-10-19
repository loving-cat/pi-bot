import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/tool_steps.dart';

/// 工具调用的显示规则：**跑完就不显示**。
///
/// 这不是终端。用户要看的是"它干成了没有、结果是什么"，不是
/// `bash` / `read_shell` 这些内部命令名 —— 既看不懂，又把真正的回答顶到屏幕外。
///
/// 只保留两个有信息量的瞬间：
///   · 正在跑 —— 显示一行，否则用户以为卡死了
///   · 出错了 —— 把失败露出来，失败不能藏
///
/// 跑完且没出错 → 一个像素都不占。
void main() {
  Widget host(List<ToolStep> steps, {bool quietWhenDone = true}) => MaterialApp(
    home: Scaffold(
      body: Center(
        child: ToolSteps(steps: steps, quietWhenDone: quietWhenDone),
      ),
    ),
  );

  List<ToolStep> sample({String status = 'done'}) => [
    ToolStep(tool: 'bash', detail: 'npm test', status: status, durationMs: 1200),
    ToolStep(tool: 'read', detail: 'lib/main.dart', status: status),
  ];

  testWidgets('★ 跑完且没出错 → 完全不渲染（不占一个像素）', (tester) async {
    await tester.pumpWidget(host(sample()));

    expect(find.textContaining('工具调用'), findsNothing, reason: '不该显示摘要行');
    expect(find.textContaining('npm test'), findsNothing, reason: '不该显示明细');
    expect(find.textContaining('lib/main.dart'), findsNothing);
    // 组件本身应当缩成 0 高度
    expect(find.byType(ToolSteps), findsOneWidget);
    final size = tester.getSize(find.byType(ToolSteps));
    expect(size.height, 0, reason: '不该占任何垂直空间');
  });

  testWidgets('★ 正在跑 → 显示一行进度（否则用户以为卡死）', (tester) async {
    await tester.pumpWidget(host(sample(status: 'running')));

    expect(find.textContaining('正在调用工具'), findsOneWidget);
  });

  testWidgets('★ 失败必须露出来 —— 即使跑完了也要显示', (tester) async {
    await tester.pumpWidget(
      host([
        ToolStep(tool: 'bash', detail: 'npm run build', status: 'error'),
        ToolStep(tool: 'read', detail: 'ok.txt', status: 'done'),
      ]),
    );

    expect(find.textContaining('npm run build'), findsOneWidget);
    final size = tester.getSize(find.byType(ToolSteps));
    expect(size.height, greaterThan(0), reason: '出错时必须有可见高度');
  });

  testWidgets('跑完且成功 + 有一条失败 → 仍然显示（失败优先）', (tester) async {
    await tester.pumpWidget(
      host([
        ToolStep(tool: 'bash', detail: 'ok-1', status: 'done'),
        ToolStep(tool: 'bash', detail: 'bad-one', status: 'error'),
        ToolStep(tool: 'bash', detail: 'ok-2', status: 'done'),
      ]),
    );

    expect(find.textContaining('bad-one'), findsOneWidget);
  });

  testWidgets('空步骤列表 → 不渲染', (tester) async {
    await tester.pumpWidget(host([]));
    final size = tester.getSize(find.byType(ToolSteps));
    expect(size.height, 0);
  });

  testWidgets('quietWhenDone=false 时退回"收起成一行"（给调试留口子）', (tester) async {
    await tester.pumpWidget(host(sample(), quietWhenDone: false));

    expect(find.textContaining('工具调用'), findsOneWidget);
    expect(find.textContaining('npm test'), findsNothing, reason: '仍然是收起的');
  });

  testWidgets('quietWhenDone=false 时可以点开看明细', (tester) async {
    await tester.pumpWidget(host(sample(), quietWhenDone: false));

    await tester.tap(find.textContaining('工具调用'));
    await tester.pump();

    expect(find.textContaining('npm test'), findsOneWidget);
    expect(find.textContaining('lib/main.dart'), findsOneWidget);
  });

  testWidgets('连续重复的调用合并成 ×N（仅 quietWhenDone=false 可见）', (tester) async {
    final steps = List.generate(
      3,
      (_) => ToolStep(tool: 'bash', detail: 'cd server && ls', status: 'done'),
    );
    await tester.pumpWidget(host(steps, quietWhenDone: false));

    await tester.tap(find.textContaining('工具调用'));
    await tester.pump();

    expect(find.textContaining('×'), findsWidgets);
  });
}
