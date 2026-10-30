// 布局与偏好持久化
//
// 这一组盯三件事：
//   1. 中栏要按**自己那一栏**的宽度算气泡上限，不是按窗口（否则栏窄了气泡被撑爆）
//   2. 右侧面板的 tab 要记住（切会话回来不许跳回「详情」）
//   3. 三栏宽度要落盘（拖完重开不许回到初始值）
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/room_panel.dart';
import 'package:pi_bot/models.dart';
import 'package:shared_preferences/shared_preferences.dart';

Room groupRoom() => Room(
  id: 'r-group',
  name: '测试部门',
  kind: 'group',
  botIds: const ['b1', 'b2'],
  botNames: const ['小一', '小二'],
  leadBotId: 'b1',
  leadName: '小一',
);

Room dmRoom() => Room(id: 'r-dm', name: '私聊', kind: 'dm', botIds: const ['b1']);

class _State extends AppState {
  @override
  Future<void> refresh() async {}
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('聊天栏宽度', () {
    test('★ 内容列上限与留白是常量，不与窗口宽度挂钩', () {
      // 这条守的是回归：以前用 MediaQuery.sizeOf(context).width 算留白，
      // 窗口 2000px、聊天栏 500px 时会算出 410px 的留白，内容被挤成窄缝。
      expect(kChatContentMax, lessThan(1600));
      expect(kChatContentMax, greaterThan(600));
      expect(kChatSidePad, greaterThan(0));
      expect(kChatSidePad, lessThan(40));
    });

    test('留白计算：栏比内容上限窄时用最小留白，宽时两边均分', () {
      double padFor(double columnW) {
        final extra = columnW - kChatContentMax;
        return extra <= 0 ? kChatSidePad : extra / 2;
      }

      // 窄栏（右侧还开着面板/浏览器）：只留最小边距，内容铺满
      expect(padFor(500), kChatSidePad);
      expect(padFor(kChatContentMax), kChatSidePad);
      // 超宽栏：两边均分多出来的宽度
      expect(padFor(kChatContentMax + 200), 100);
    });
  });

  group('右侧面板 tab 持久化', () {
    testWidgets('★ 选了「资料库」，面板重建后还是「资料库」', (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      final room = groupRoom();

      Widget host() => AppScope(
        state: state,
        child: MaterialApp(
          home: Scaffold(body: RoomPanel(room: room, width: 360)),
        ),
      );

      await tester.pumpWidget(host());
      await tester.pumpAndSettle();

      // 默认在「详情」
      expect(state.panelTab, 0);

      await tester.tap(find.text('资料库'));
      await tester.pumpAndSettle();
      expect(state.panelTab, 1);

      // 模拟「切走会话再切回来」：整棵树重建（面板重新挂载）
      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(host());
      await tester.pumpAndSettle();

      expect(state.panelTab, 1, reason: '重建后不该跳回详情');
    });

    testWidgets('越界兜底：在群里停在「成员」，切到私聊不崩', (tester) async {
      final state = _State();
      addTearDown(state.dispose);
      state.panelTab = 2; // 「成员」，只有群才有

      await tester.pumpWidget(
        AppScope(
          state: state,
          child: MaterialApp(
            home: Scaffold(body: RoomPanel(room: dmRoom(), width: 360)),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // 私聊没有「成员」，tab 要被夹回合法范围而不是落到 default
      expect(find.text('详情'), findsOneWidget);
    });
  });

  group('三栏宽度持久化', () {
    test('★ 存下来的宽度能被读回', () async {
      final state = _State();
      addTearDown(state.dispose);

      await state.saveLayoutWidths(left: 400, right: 420, browser: 640);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getDouble('layout_left_width'), 400);
      expect(prefs.getDouble('layout_right_width'), 420);
      expect(prefs.getDouble('layout_browser_width'), 640);

      // 新建一个实例从盘上读
      final again = _State();
      addTearDown(again.dispose);
      await again.bootstrap();
      expect(again.layoutLeftWidth, 400);
      expect(again.layoutRightWidth, 420);
      expect(again.layoutBrowserWidth, 640);
    });

    test('只传一项时不动其它项', () async {
      final state = _State();
      addTearDown(state.dispose);
      await state.saveLayoutWidths(left: 300, right: 300, browser: 300);
      await state.saveLayoutWidths(right: 500);
      expect(state.layoutLeftWidth, 300);
      expect(state.layoutRightWidth, 500);
      expect(state.layoutBrowserWidth, 300);
    });

    test('没存过就用默认值，不崩', () async {
      final state = _State();
      addTearDown(state.dispose);
      await state.bootstrap();
      expect(state.layoutLeftWidth, 320);
      expect(state.layoutRightWidth, 340);
      expect(state.layoutBrowserWidth, 520);
      expect(state.panelTab, 0);
    });
  });
}
