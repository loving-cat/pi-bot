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
    String modelFamily = 'unknown',
    Map<String, LessonFamilyStats> byFamily = const {},
  }) => LibraryLesson(
    id: id,
    cue: cue,
    lesson: lessonText,
    status: status,
    verdict: verdict,
    dept: dept,
    modelFamily: modelFamily,
    byFamily: byFamily,
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

  test('applyLessons：服务端推来的列表能直接落到状态里（复盘是后台跑的）', () {
    final state = AppState();
    state.applyLessons([
      {
        'id': 'l9',
        'cue': '给部门配班子',
        'lesson': '按模块拆 owner',
        'status': 'candidate',
        'evidence': [
          {'msgId': 'm1', 'quote': '每个模块都要有人'},
        ],
      },
    ]);
    expect(state.lessonsLoaded, isTrue);
    expect(state.lessons, hasLength(1));
    expect(state.lessons.first.cue, '给部门配班子');
    expect(state.lessons.first.evidence.first.msgId, 'm1');
  });

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

  testWidgets('空库：给出会复盘出候选的说明，不显示空白卡片', (tester) async {
    final state = AppState()..lessonsLoaded = true;
    await tester.pumpWidget(host(state));
    await tester.pump();
    // 断言的是"会给用户一句解释"，而不是具体措辞 —— 文案精简时不该测试跟着碎
    expect(find.textContaining('复盘'), findsOneWidget);
  });

  // ---- SIM-Lite：族标记 / 推荐启用 / 否决与解除 ----
  test('推荐启用的判定只影响排序：跨 2 族 + 3:1 才算，且必须还是候选', () {
    final recommended = lesson(
      id: 'r1',
      modelFamily: 'glm',
      byFamily: const {
        'glm': LessonFamilyStats(win: 3, fail: 0),
        'deepseek': LessonFamilyStats(win: 1, fail: 0),
      },
    );
    expect(recommended.isRecommended, isTrue);
    expect(recommended.validatedFamilies, 2);
    expect(recommended.totalWins, 4);

    // 单族再赢也不算（跨模型才有说服力）
    final single = lesson(
      id: 'r2',
      modelFamily: 'glm',
      byFamily: const {'glm': LessonFamilyStats(win: 9, fail: 0)},
    );
    expect(single.isRecommended, isFalse);

    // 赢 3 输 2 = 1.5:1，够不着 3:1
    final losing = lesson(
      id: 'r3',
      modelFamily: 'glm',
      byFamily: const {
        'glm': LessonFamilyStats(win: 3, fail: 2),
        'deepseek': LessonFamilyStats(win: 1, fail: 0),
      },
    );
    expect(losing.isRecommended, isFalse);

    // 已启用就不再提示「推荐启用」
    final active = lesson(
      id: 'r4',
      status: 'active',
      modelFamily: 'glm',
      byFamily: const {
        'glm': LessonFamilyStats(win: 3, fail: 0),
        'deepseek': LessonFamilyStats(win: 3, fail: 0),
      },
    );
    expect(active.isRecommended, isFalse);
  });

  test('applyLessonEdges：边表能落到状态里，并能判断某条是否被否决', () {
    final state = AppState();
    state.applyLessonEdges([
      {'from': 'user', 'to': 'l1', 'type': 'contradicts', 'by': 'user'},
      {'from': 'l2', 'to': 'l3', 'type': 'requires', 'by': 'distiller'},
    ]);
    expect(state.lessonEdges, hasLength(2));
    expect(state.isLessonVetoed('l1'), isTrue);
    expect(state.isLessonVetoed('l2'), isFalse, reason: 'relations 不是否决');
    // 不带 edges 的事件（老服务端）不该把本地边表清空
    state.applyLessonEdges(null);
    expect(state.lessonEdges, hasLength(2));
  });

  testWidgets('族标记与推荐角标：推荐启用的候选排在最前', (tester) async {
    final state = AppState()
      ..lessons = [
        lesson(id: 'plain', cue: '普通候选'),
        lesson(
          id: 'rec',
          cue: '推荐候选',
          modelFamily: 'glm',
          byFamily: const {
            'glm': LessonFamilyStats(win: 3, fail: 0),
            'deepseek': LessonFamilyStats(win: 2, fail: 0),
          },
        ),
      ]
      ..lessonsLoaded = true;

    await tester.pumpWidget(host(state));
    await tester.pump();

    expect(find.text('推荐启用'), findsOneWidget);
    expect(find.text('glm · 5W/0L'), findsOneWidget, reason: '族标记要带胜负，不只是一个族名');
    // 推荐的那条要排在前面（第一条卡片）
    final firstCardY = tester.getTopLeft(find.text('推荐候选')).dy;
    final secondCardY = tester.getTopLeft(find.text('普通候选')).dy;
    expect(firstCardY, lessThan(secondCardY));
  });

  testWidgets('已否决：显示「已否决」并只给「解除否决」，不给「启用」', (tester) async {
    final state = AppState()
      ..lessons = [lesson(id: 'v1', cue: '被否决的这条')]
      ..lessonsLoaded = true;
    state.applyLessonEdges([
      {'from': 'user', 'to': 'v1', 'type': 'contradicts', 'by': 'user'},
    ]);

    await tester.pumpWidget(host(state));
    await tester.pump();

    expect(find.text('已否决'), findsOneWidget);
    expect(find.text('解除否决'), findsOneWidget);
    expect(find.text('启用'), findsNothing, reason: '裸切启用会变成"看似启用实则永不注入"');
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
