import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/tool_steps.dart';

/// 工具调用的显示规则：**跑完就不显示**。
///
/// 默认模式仅在运行时显示提示，完成或失败均隐藏；调试模式可展开明细。
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

  testWidgets('★ 正在跑 → 只显示一句人话，不露工具名和参数', (tester) async {
    await tester.pumpWidget(host(sample(status: 'running')));

    expect(find.text('正在干活…'), findsOneWidget);
    // ★ 关键：跑的过程中也**不能**把命令名、shell_id、参数漏给用户。
    //   用户截屏里那一整列 `run_background / read_shell {shell_id...}`
    //   就是漏出来的样子 —— 既看不懂，又把回答顶到屏幕外。
    expect(find.textContaining('bash'), findsNothing, reason: '不该露工具名');
    expect(find.textContaining('npm test'), findsNothing, reason: '不该露命令');
    expect(find.textContaining('lib/main.dart'), findsNothing, reason: '不该露参数');
    expect(find.textContaining('点开看明细'), findsNothing, reason: '不该给展开入口');
  });

  testWidgets('★ 失败步骤也不显示 —— 工具链完全不出现在聊天里', (tester) async {
    await tester.pumpWidget(
      host([
        ToolStep(tool: 'bash', detail: 'npm run build 失败：exit 1', status: 'error'),
        ToolStep(tool: 'read', detail: 'ok.txt', status: 'done'),
      ]),
    );

    // 默认模式不显示命令、参数及失败明细。
    expect(find.text('有一步没成功'), findsNothing);
    expect(find.textContaining('exit 1'), findsNothing);
    expect(find.textContaining('bash'), findsNothing);
    final size = tester.getSize(find.byType(ToolSteps));
    expect(size.height, 0, reason: '失败也一个像素都不占');
  });

  testWidgets('跑完且成功 + 有一条失败 → 同样不显示', (tester) async {
    await tester.pumpWidget(
      host([
        ToolStep(tool: 'bash', detail: 'ok-1', status: 'done'),
        ToolStep(tool: 'bash', detail: 'bad-one 报错', status: 'error'),
        ToolStep(tool: 'bash', detail: 'ok-2', status: 'done'),
      ]),
    );

    expect(find.text('有一步没成功'), findsNothing);
    expect(find.textContaining('bad-one'), findsNothing);
    expect(tester.getSize(find.byType(ToolSteps)).height, 0);
  });

  testWidgets('★ 回归：一长串工具调用跑完后，一个字都不显示', (tester) async {
    // 复现用户截屏里的场景：一轮里跑了 20 多步 shell 调用
    final many = List.generate(
      24,
      (i) => ToolStep(
        tool: i.isEven ? 'run_background' : 'read_shell',
        detail: '{"shell_id":"sh_abc$i"}',
        status: 'done',
      ),
    );
    await tester.pumpWidget(host(many));

    final size = tester.getSize(find.byType(ToolSteps));
    expect(size.height, 0, reason: '跑完就该完全不占空间');
    expect(find.textContaining('run_background'), findsNothing);
    expect(find.textContaining('read_shell'), findsNothing);
    expect(find.textContaining('shell_id'), findsNothing);
  });

  testWidgets('★ 回归：一长串工具调用**正在跑**时，也只给一行', (tester) async {
    // 这是用户实际报的那个：跑的时候整列铺出来
    final many = List.generate(
      24,
      (i) => ToolStep(
        tool: i.isEven ? 'run_background' : 'read_shell',
        detail: '{"shell_id":"sh_abc$i"}',
        status: 'done',
      ),
    )..add(ToolStep(tool: 'read_shell', detail: '{"shell_id":"sh_last"}', status: 'running'));

    await tester.pumpWidget(host(many));

    expect(find.text('正在干活…'), findsOneWidget);
    expect(find.textContaining('run_background'), findsNothing);
    expect(find.textContaining('shell_id'), findsNothing);
    // 高度应该只有一行，不能是二十多行
    final size = tester.getSize(find.byType(ToolSteps));
    expect(size.height, lessThan(40), reason: '只能占一行的高度，实际 ${size.height}');
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
