import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/lessons_section.dart';

/// 经验库面板的展示与筛选。
///
/// 盯的是"人能不能在启用前看清楚"：情境 / 做法 / 证据都要在，
/// 候选和已启用要分得开，默认先看待确认的（否则用户永远看不到新经验）。
void main() {
  LibraryLesson lesson({
    String id = 'l1',
    String cue = '给部门配班子、加人时',
    String lessonText = '按功能模块拆 owner，不要让一个人兼两个模块',
    String status = 'candidate',
    String verdict = 'helped',
    String quote = '每个功能模块都有专人负责',
    String dept = '内容运营二组',
  }) => LibraryLesson(
    id: id,
    cue: cue,
    lesson: lessonText,
    status: status,
    verdict: verdict,
    dept: dept,
    evidence: [LessonEvidence(msgId: 'm1', quote: quote)],
  );

  Widget host(AppState state) => AppScope(
    state: state,
    child: MaterialApp(
      theme: PB.theme(),
      home: const Scaffold(
        body: SingleChildScrollView(
          child: SizedBox(width: 720, child: LessonsSection()),
        ),
      ),
    ),
  );

  testWidgets('默认先看待确认：候选显示，已启用的不混进来', (tester) async {
    final state = AppState()
      ..lessons = [
        lesson(id: 'c1', cue: '候选的这条'),
        lesson(id: 'a1', cue: '已启用的这条', status: 'active'),
      ]
      ..lessonsLoaded = true;

    await tester.pumpWidget(host(state));
    await tester.pump();

    expect(find.text('待确认 1'), findsOneWidget);
    expect(find.text('已启用 1'), findsOneWidget);
    expect(find.text('候选的这条'), findsOneWidget);
    expect(find.text('已启用的这条'), findsNothing);
    expect(find.text('启用'), findsOneWidget);
    // 证据要能看到，否则用户没法判断
    expect(find.textContaining('每个功能模块都有专人负责'), findsOneWidget);
  });

  testWidgets('切到「已启用」能看到 active 和停用按钮', (tester) async {
    final state = AppState()
      ..lessons = [
        lesson(id: 'c1', cue: '候选的这条'),
        lesson(id: 'a1', cue: '已启用的这条', status: 'active'),
      ]
      ..lessonsLoaded = true;

    await tester.pumpWidget(host(state));
    await tester.pump();
    await tester.tap(find.text('已启用 1'));
    await tester.pump();

    expect(find.text('已启用的这条'), findsOneWidget);
    expect(find.text('候选的这条'), findsNothing);
    expect(find.text('停用'), findsOneWidget);
    expect(find.text('已启用'), findsOneWidget);
  });

  testWidgets('空库：给出"收尾后会自动复盘"的说明，不显示空白卡片', (tester) async {
    final state = AppState()..lessonsLoaded = true;
    await tester.pumpWidget(host(state));
    await tester.pump();
    expect(find.textContaining('收尾后会自动复盘'), findsOneWidget);
  });

  testWidgets('长文案不溢出（情境/做法都按行收）', (tester) async {
    final state = AppState()
      ..lessons = [
        lesson(
          cue: '给一个覆盖多个功能模块的部门配班子，用户要求每个模块都有专人负责并直接汇报',
          lessonText: '按功能模块拆 owner，收尾时按模块逐个汇报；不要让一个人兼两个模块，' * 4,
        ),
      ]
      ..lessonsLoaded = true;

    await tester.pumpWidget(host(state));
    await tester.pump();
    expect(tester.takeException(), isNull);
  });
}
