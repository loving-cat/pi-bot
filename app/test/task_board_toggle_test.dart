import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/screens/chat_screen.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/task_board.dart';
import 'package:pi_bot/widgets/task_run_sheet.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 任务板交互：
///   · 顶栏那颗按钮是**开关**（点开 → 再点关）；
///   · 任务详情弹窗的叉必须真的关得掉（之前用的是外层 Overlay 的 context）。
void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    BlobAvatar.animationsEnabled = false;
  });

  tearDown(() => BlobAvatar.animationsEnabled = true);

  Future<AppState> pump(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1000, 760);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final room = Room(
      id: 'r1',
      name: '调研组',
      kind: 'group',
      botIds: const ['b1'],
      lastMessageAt: 1000,
    );
    final state = AppState()
      ..bots = [Bot(id: 'b1', name: '技术分析员', role: 'lead')]
      ..rooms = [room]
      ..messages['r1'] = [
        Msg(
          id: 'm1',
          roomId: 'r1',
          authorType: 'bot',
          authorId: 'b1',
          authorName: '技术分析员',
          text: '跑完了',
          status: 'done',
          createdAt: 1000,
        ),
      ]
;
    addTearDown(state.dispose);

    await tester.pumpWidget(
      AppScope(
        state: state,
        child: L10n(
          controller: LocaleController(),
          child: MaterialApp(home: ChatScreen(room: room)),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    return state;
  }

  testWidgets('顶栏任务按钮是开关：点开再点关', (tester) async {
    await pump(tester);
    final button = find.byIcon(LucideIcons.checkCircle2);

    await tester.tap(button);
    await tester.pumpAndSettle();
    expect(find.byType(TaskBoardSheet), findsOneWidget, reason: '第一次点击应打开任务浮层');

    // 弹层开着时它自己有一层遮罩，点钮的位置会被“点外面就关”接住 ——
    // 对用户来说结果一样：再点一下就关了。这里按屏幕坐标点，不管是谁接住。
    await tester.tapAt(tester.getCenter(button));
    await tester.pumpAndSettle();
    expect(find.byType(TaskBoardSheet), findsNothing, reason: '开着的状态下再点应该关掉');
  });

  testWidgets('任务浮层里点任务卡会打开 TaskRun 详情，X 能关掉', (tester) async {
    final state = await pump(tester);
    // 统一数据源后，浮层读的是 TaskRun：先喂一条本房间的根任务
    state.taskRuns.applyHello({
      'taskRuns': [
        {
          'id': 'tr1',
          'roomId': 'r1',
          'rootTaskId': 'tr1',
          'revision': 1,
          'sequence': 1,
          'storeVersion': 1,
          'state': 'running',
          'title': '补一条验证',
          'scope': '验证一下',
          'deliverables': <String>[],
          'updatedAt': 1000,
          'leadBotId': 'b1',
          'leadBotName': '技术分析员',
          'phase': 'active',
        },
      ],
    });

    await tester.tap(find.byIcon(LucideIcons.checkCircle2));
    await tester.pumpAndSettle();
    expect(find.text('补一条验证'), findsWidgets);

    await tester.tap(find.text('补一条验证').first);
    await tester.pumpAndSettle();
    expect(find.byType(TaskRunSheet), findsOneWidget);

    await tester.tap(find.byIcon(Icons.close).last);
    await tester.pumpAndSettle();
    expect(find.byType(TaskRunSheet), findsNothing, reason: '点叉必须关得掉');
  });

  testWidgets('向下弹出时，浮层正下方的空白也能关掉', (tester) async {
    await pump(tester);
    await tester.tap(find.byIcon(LucideIcons.checkCircle2));
    await tester.pumpAndSettle();
    expect(find.byType(TaskBoardSheet), findsOneWidget);

    // 浮层顶部约在按钮下方；窗口 760 高，点它的正下方（横坐标在浮层宽度内）
    final sheet = tester.getRect(find.byType(TaskBoardSheet));
    await tester.tapAt(Offset(sheet.center.dx, 745));
    await tester.pumpAndSettle();
    expect(find.byType(TaskBoardSheet), findsNothing, reason: '向下弹出的下方空白必须能关闭');
  });

  testWidgets('切走页面时浮层要一起收掉（不留在新页面上）', (tester) async {
    await pump(tester);
    await tester.tap(find.byIcon(LucideIcons.checkCircle2));
    await tester.pumpAndSettle();
    expect(find.byType(TaskBoardSheet), findsOneWidget);

    // 模拟切房间/退出：整棵树换掉，ChatScreen 被 dispose
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox())));
    await tester.pumpAndSettle();
    expect(find.byType(TaskBoardSheet), findsNothing, reason: 'dispose 必须收掉挂在根 Overlay 上的浮层');
  });
  testWidgets('顶栏角标数的是 TaskRun：出现与消退都跟着变', (tester) async {
    final state = await pump(tester);

    Map<String, dynamic> run(String id, String st, int ver) => {
          'id': id,
          'roomId': 'r1',
          'rootTaskId': id,
          'revision': 1,
          'sequence': 1,
          'storeVersion': ver,
          'state': st,
          'title': '补一条验证',
          'scope': '验证',
          'deliverables': <String>[],
          'updatedAt': 1000 + ver,
          'leadBotId': 'b1',
          'leadBotName': '技术分析员',
          'phase': 'active',
        };

    state.taskRuns.applyHello({'taskRuns': [run('tr1', 'running', 1)]});
    await tester.pump();
    expect(find.text('1'), findsWidgets, reason: '在跑的任务要计入角标');

    state.taskRuns.applyHello({'taskRuns': [run('tr1', 'completed', 2)]});
    await tester.pump();
    // 完成后角标不该再挂着 1（Badge 的标签消失）
    expect(find.text('1'), findsNothing);
  });

}
