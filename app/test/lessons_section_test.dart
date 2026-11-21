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
    List<LessonPendingEdge> pendingEdges = const [],
  }) => LibraryLesson(
    id: id,
    cue: cue,
    lesson: lessonText,
    status: status,
    verdict: verdict,
    dept: dept,
    modelFamily: modelFamily,
    byFamily: byFamily,
    pendingEdges: pendingEdges,
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
  test('「稳定」只对已启用的经验成立：跨 2 族 + 3:1，候选永远不算', () {
    // 只有 active 会被注入 → 只有 active 才可能有 byFamily 胜负。
    // 所以「跨族验证」必须是 active 的徽章，挂在候选上就是个永远亮不起来的死条件。
    final activeStable = lesson(
      id: 's1',
      status: 'active',
      modelFamily: 'glm',
      byFamily: const {
        'glm': LessonFamilyStats(win: 3, fail: 0),
        'deepseek': LessonFamilyStats(win: 1, fail: 0),
      },
    );
    expect(activeStable.isStable, isTrue);
    expect(activeStable.validatedFamilies, 2);
    expect(activeStable.familyLabel, 'glm · 4W/0L (2族)');

    // 单族再赢也不算（跨模型才有说服力）
    final single = lesson(
      id: 's2',
      status: 'active',
      modelFamily: 'glm',
      byFamily: const {'glm': LessonFamilyStats(win: 9, fail: 0)},
    );
    expect(single.isStable, isFalse);
    expect(single.familyLabel, 'glm · 9W/0L');

    // 赢 3 输 2 = 1.5:1，够不着 3:1
    final losing = lesson(
      id: 's3',
      status: 'active',
      modelFamily: 'glm',
      byFamily: const {
        'glm': LessonFamilyStats(win: 3, fail: 2),
        'deepseek': LessonFamilyStats(win: 1, fail: 0),
      },
    );
    expect(losing.isStable, isFalse);

    // 候选用同样的数据也不算：它还没被注入过，胜负是历史遗留
    final candidate = lesson(
      id: 's4',
      modelFamily: 'glm',
      byFamily: const {
        'glm': LessonFamilyStats(win: 3, fail: 0),
        'deepseek': LessonFamilyStats(win: 3, fail: 0),
      },
    );
    expect(candidate.isStable, isFalse);
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

  testWidgets('族标记带族数；「稳定」角标只出现在已启用的经验上', (tester) async {
    final state = AppState()
      ..lessons = [
        lesson(
          id: 'cand',
          cue: '候选的这条',
          modelFamily: 'glm',
          byFamily: const {
            'glm': LessonFamilyStats(win: 3, fail: 0),
            'deepseek': LessonFamilyStats(win: 2, fail: 0),
          },
        ),
        lesson(
          id: 'act',
          cue: '已启用且稳定',
          status: 'active',
          modelFamily: 'glm',
          byFamily: const {
            'glm': LessonFamilyStats(win: 3, fail: 0),
            'deepseek': LessonFamilyStats(win: 1, fail: 0),
          },
        ),
      ]
      ..lessonsLoaded = true;

    await tester.pumpWidget(host(state));
    await tester.pump();

    // 候选页：有族标记，但没有「稳定」角标
    expect(find.text('glm · 5W/0L (2族)'), findsOneWidget);
    expect(find.text('稳定'), findsNothing);

    await tester.tap(find.text('已启用 1'));
    await tester.pump();
    expect(find.text('稳定'), findsOneWidget, reason: '跨族验证达标才给稳定徽章');
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

  testWidgets('已降级：显示「已降级」并只给「解除降级」（同样不给裸切启用）', (tester) async {
    final state = AppState()
      ..lessons = [lesson(id: 'd1', cue: '被自动降级的这条', status: 'archived')]
      ..lessonsLoaded = true;
    state.applyLessonEdges([
      {'from': 'system', 'to': 'd1', 'type': 'contradicts', 'by': 'system'},
    ]);

    await tester.pumpWidget(host(state));
    await tester.pump();

    // 降级一定会归档，所以人要在「全部」里才看得到它
    await tester.tap(find.text('全部'));
    await tester.pump();

    expect(find.text('已降级'), findsOneWidget);
    expect(find.text('解除降级'), findsOneWidget);
    expect(find.text('已否决'), findsNothing, reason: '降级是 system 边，不是用户否决');
    expect(find.text('启用'), findsNothing, reason: 'system 边在的话裸切启用永远注入不进去');
  });

  test('applyLessonEdges：system 降级边也能识别（和 user 否决分开）', () {
    final state = AppState();
    state.applyLessonEdges([
      {'from': 'system', 'to': 'd2', 'type': 'contradicts', 'by': 'system'},
    ]);
    expect(state.isLessonDecayed('d2'), isTrue);
    expect(state.isLessonVetoed('d2'), isFalse);
  });

  testWidgets('蒸馏器建议的边：候选卡上写明启用后会动到谁（取代 / 冲突 / 目标已没）', (tester) async {
    final state = AppState()
      ..lessons = [
        lesson(id: 'old1', cue: '老的配班子做法', status: 'active'),
        lesson(id: 'old2', cue: '老的发布检查单', status: 'active'),
        lesson(
          id: 'cand1',
          cue: '新的配班子做法',
          pendingEdges: [
            LessonPendingEdge(to: 'old1', type: 'supersedes'),
            LessonPendingEdge(to: 'old2', type: 'contradicts'),
          ],
        ),
        lesson(
          id: 'cand2',
          cue: '指向已删的',
          pendingEdges: [LessonPendingEdge(to: 'gone', type: 'supersedes')],
        ),
      ]
      ..lessonsLoaded = true;

    await tester.pumpWidget(host(state));
    await tester.pump();

    expect(find.text('启用后将取代《老的配班子做法》'), findsOneWidget);
    expect(find.text('启用后将标记与《老的发布检查单》的冲突'), findsOneWidget);
    expect(find.textContaining('已经不在'), findsOneWidget, reason: '目标没了要说清楚会被跳过，而不是吓人');
    expect(tester.takeException(), isNull);
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
