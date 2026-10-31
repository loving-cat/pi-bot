// 真实 DPI 下的窗口缩放：125% / 150% 缩放（Windows 用户最常见的设置）。
//
// 为什么单开一个文件：全仓所有 widget 测试都写死 devicePixelRatio = 1.0，
// 等于**从没在真实缩放比下跑过布局**。而用户机器是 125%，macOS 常见 2.0：
// 一旦某处把"逻辑尺寸"和"物理尺寸"搞混，只有在 dpr != 1 时才暴露。
//
// 这里同时守住两条：
//   ① 不许抛异常 / 溢出；
//   ② 栏位里的内容宽度必须等于栏位可用宽度（被裁 = 用户看到的"超出范围"）。
//
// 注意 physicalSize 与 dpr 的关系：MediaQuery.sizeOf 得到的是
// physicalSize / dpr，所以模拟"逻辑宽 W"必须设 physicalSize = W * dpr。

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

/// 按**逻辑尺寸**摆一帧；physicalSize = 逻辑 × dpr。
Future<void> _pumpLogical(
  WidgetTester tester,
  Size logical, {
  required double dpr,
}) async {
  tester.view.devicePixelRatio = dpr;
  tester.view.physicalSize = Size(logical.width * dpr, logical.height * dpr);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  for (final dpr in [1.25, 1.5, 2.0]) {
    testWidgets('★★ dpr=$dpr：连续缩窗口，内容不许超出栏位', (tester) async {
      addTearDown(tester.view.reset);
      final state = _stateWith([_room('r1', '甲')]);
      addTearDown(state.dispose);
      state.layoutLeftWidth = 480;
      state.layoutRightWidth = 560;
      state.panelOpen = true;

      await tester.pumpWidget(
        AppScope(state: state, child: const MaterialApp(home: HomeShell())),
      );

      for (final w in [1600.0, 1300.0, 1150.0, 1000.0, 900.0, 800.0]) {
        await _pumpLogical(tester, Size(w, 800), dpr: dpr);
        expect(
          tester.takeException(),
          isNull,
          reason: 'dpr=$dpr 窗口宽 $w 时布局崩了',
        );

        final panel = find.byType(RoomPanel);
        if (panel.evaluate().isEmpty) continue;
        final clip = find.ancestor(of: panel, matching: find.byType(ClipRect));
        if (clip.evaluate().isEmpty) continue;

        final clipBox = tester.renderObject<RenderBox>(clip.first);
        final panelBox = tester.renderObject<RenderBox>(panel.first);
        expect(
          panelBox.size.width,
          lessThanOrEqualTo(clipBox.size.width + 0.5),
          reason:
              'dpr=$dpr 宽 $w：面板按 ${panelBox.size.width} 排版，'
              '栏位只有 ${clipBox.size.width}',
        );
      }
    });

    testWidgets('★★ dpr=$dpr：拖窄再拖宽，内容要跟着回到栏位', (tester) async {
      addTearDown(tester.view.reset);
      final state = _stateWith([_room('r1', '甲')]);
      addTearDown(state.dispose);
      state.layoutLeftWidth = 440;
      state.layoutRightWidth = 520;
      state.panelOpen = true;

      await tester.pumpWidget(
        AppScope(state: state, child: const MaterialApp(home: HomeShell())),
      );

      await _pumpLogical(tester, const Size(1500, 800), dpr: dpr);
      // 模拟用户抓边缘往左拖（窗口变窄）
      await _pumpLogical(tester, const Size(1000, 750), dpr: dpr);
      await _pumpLogical(tester, const Size(860, 720), dpr: dpr);
      // 再拖回来
      await _pumpLogical(tester, const Size(1500, 800), dpr: dpr);

      expect(tester.takeException(), isNull, reason: 'dpr=$dpr 缩放往返后崩了');

      final panel = find.byType(RoomPanel);
      if (panel.evaluate().isEmpty) return;
      final clip = find.ancestor(of: panel, matching: find.byType(ClipRect));
      if (clip.evaluate().isEmpty) return;
      final clipBox = tester.renderObject<RenderBox>(clip.first);
      final panelBox = tester.renderObject<RenderBox>(panel.first);
      expect(
        panelBox.size.width,
        lessThanOrEqualTo(clipBox.size.width + 0.5),
        reason: 'dpr=$dpr 缩放往返后仍错位',
      );
    });
  }
}
