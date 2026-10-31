// 窗口缩放后**内容是否还待在栏里**（不是只看"崩不崩"）。
//
// 为什么单开一个文件：four_pane_layout_test 只验证"不抛异常 / 不溢出"。
// 但用户看到的"乱"有两种，溢出只是其中一种：
//   ① 溢出 —— RenderFlex 黄黑条，框架会报错，容易被测出来；
//   ② 内容按**旧宽度**排版、被 ClipRect 裁掉右边一截 —— **不报错**，
//      测试全绿，用户看到的是边缘被切、列表项被截断。
//
// 这里量的是 ②：栏位实际占多宽，里面面板的实际渲染宽度就必须等于它。
//
// 真实成因（写在这里免得下次再找）：
//   home_shell 的面板/浏览器栏为了滑入动画不变形，外面套了
//   `SizedBox(width: 目标宽度) > ClipRect > OverflowBox(min/max = 偏好宽度)`。
//   只要窗口缩小让目标宽度 < 偏好宽度，内容仍按偏好宽度排版 —— 右边就被裁掉。
//   而 `_rightWidth` 是**用户偏好**（最大 560），窗口一拉窄它不跟着变。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/home_shell.dart';
import 'package:pi_bot/widgets/room_panel.dart';
import 'package:shared_preferences/shared_preferences.dart';

Room _room(String id, String name) => Room(
  id: id,
  name: name,
  kind: 'dm',
  botIds: const [],
  lastMessageAt: 0,
);

AppState _stateWith(List<Room> rooms) {
  final s = AppState();
  s.rooms = rooms;
  return s;
}

Future<void> _pumpAt(WidgetTester tester, Size logical) async {
  tester.view.physicalSize = logical;
  tester.view.devicePixelRatio = 1.0;
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('★★ 窄窗口下面板内容不许超出自己的栏（被裁 = 用户说的"乱"）', (tester) async {
    addTearDown(tester.view.reset);
    final state = _stateWith([_room('r1', '甲')]);
    addTearDown(state.dispose);

    // 用户偏好拉满：左 480 / 右 560（面板上限）
    state.layoutLeftWidth = 480;
    state.layoutRightWidth = 560;
    state.panelOpen = true;

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );

    for (final w in [1600.0, 1300.0, 1150.0, 1050.0, 950.0]) {
      await _pumpAt(tester, Size(w, 800));

      final panel = find.byType(RoomPanel);
      if (panel.evaluate().isEmpty) continue; // 已被自动收栏，跳过

      // 栏位里真实可用的宽度 = 父级 ClipRect 给的约束上界
      final clip = find.ancestor(of: panel, matching: find.byType(ClipRect));
      if (clip.evaluate().isEmpty) continue;

      final clipBox = tester.renderObject<RenderBox>(clip.first);
      final panelBox = tester.renderObject<RenderBox>(panel.first);

      expect(
        panelBox.size.width,
        lessThanOrEqualTo(clipBox.size.width + 0.5),
        reason:
            '窗口宽 $w 时，面板按 ${panelBox.size.width} 排版，'
            '但栏位只有 ${clipBox.size.width} —— 右边会被裁掉（用户看到的"乱"）',
      );
    }
  });

  testWidgets('★ 拖窄再拖宽：松手后内容必须回到自己的栏里（不许一直错位）', (tester) async {
    addTearDown(tester.view.reset);
    final state = _stateWith([_room('r1', '甲')]);
    addTearDown(state.dispose);
    state.layoutLeftWidth = 440;
    state.layoutRightWidth = 520;
    state.panelOpen = true;

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );

    await _pumpAt(tester, const Size(1500, 800));
    // 拉到很窄（模拟用户拖窗口边缘），再拉回来
    await _pumpAt(tester, const Size(900, 700));
    await _pumpAt(tester, const Size(1500, 800));

    final panel = find.byType(RoomPanel);
    if (panel.evaluate().isNotEmpty) {
      final clip = find.ancestor(of: panel, matching: find.byType(ClipRect));
      if (clip.evaluate().isNotEmpty) {
        final clipBox = tester.renderObject<RenderBox>(clip.first);
        final panelBox = tester.renderObject<RenderBox>(panel.first);
        expect(
          panelBox.size.width,
          lessThanOrEqualTo(clipBox.size.width + 0.5),
          reason: '拖窄再拖宽之后仍然错位：内容 ${panelBox.size.width} > 栏位 ${clipBox.size.width}',
        );
      }
    }
    expect(tester.takeException(), isNull);
  });
}
