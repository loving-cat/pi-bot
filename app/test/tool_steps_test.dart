import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/tool_steps.dart';

/// 工具调用默认收起：只显示一行摘要，点开才看明细。
///
/// 用户看的是"干成了没有"，十几行 `bash` 会盖住正文；
/// 但**失败必须露出来**，不能因为收起就看不见。
void main() {
  Widget host(List<ToolStep> steps) => MaterialApp(
    home: Scaffold(body: Center(child: ToolSteps(steps: steps))),
  );

  List<ToolStep> sample({String status = 'done'}) => [
    ToolStep(tool: 'bash', detail: 'npm test', status: status, durationMs: 1200),
    ToolStep(tool: 'read', detail: 'lib/main.dart', status: status),
  ];

  testWidgets('默认收起：只显示步数，不显示明细', (tester) async {
    await tester.pumpWidget(host(sample()));

    expect(find.textContaining('工具调用 · 2 步'), findsOneWidget);
    expect(find.textContaining('npm test'), findsNothing);
    expect(find.textContaining('lib/main.dart'), findsNothing);
    expect(find.textContaining('点开看明细'), findsOneWidget);
  });

  testWidgets('点一下展开：明细出现，再点收起', (tester) async {
    await tester.pumpWidget(host(sample()));

    await tester.tap(find.textContaining('工具调用'));
    await tester.pump();

    expect(find.textContaining('npm test'), findsOneWidget);
    expect(find.textContaining('lib/main.dart'), findsOneWidget);

    await tester.tap(find.textContaining('工具调用'));
    await tester.pump();
    expect(find.textContaining('npm test'), findsNothing);
  });

  testWidgets('★ 失败的行收起时也要露出来', (tester) async {
    await tester.pumpWidget(
      host([
        ToolStep(tool: 'bash', detail: 'npm run build', status: 'error'),
        ToolStep(tool: 'read', detail: 'ok.txt', status: 'done'),
      ]),
    );

    expect(find.textContaining('npm run build'), findsOneWidget);
  });

  testWidgets('★ 连续重复的调用合并成 ×N', (tester) async {
    final steps = List.generate(
      3,
      (_) => ToolStep(tool: 'bash', detail: 'cd server && ls', status: 'done'),
    );
    await tester.pumpWidget(host(steps));

    await tester.tap(find.textContaining('工具调用'));
    await tester.pump();

    expect(find.textContaining('×3'), findsOneWidget);
  });

  test('mergeSteps：只合并相邻的相同调用', () {
    final steps = [
      ToolStep(tool: 'bash', detail: 'a', status: 'done'),
      ToolStep(tool: 'bash', detail: 'a', status: 'done'),
      ToolStep(tool: 'bash', detail: 'b', status: 'done'),
      ToolStep(tool: 'bash', detail: 'a', status: 'done'),
    ];
    final merged = mergeSteps(steps);
    expect(merged.map((m) => m.count).toList(), [2, 1, 1]);
  });
}
