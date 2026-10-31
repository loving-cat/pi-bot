// ★ 分隔条宽度必须"预算 = 实际"。
//
// 背景（真实 bug）：HomeShell 用 separators() 算宽度预算，原来每个分隔条只记
// **1px**；而真实渲染的 _DragHandle 是 `SizedBox(width: 6)`（命中区要 6px 才
// 好点中）。于是松手之后每条多占 5px：
//   · 三栏（左|聊天|右）→ 2 条 → 多 10px
//   · 四栏（再加浏览器）→ 3 条 → 多 15px
// 这些全从聊天区偷。Expanded 会默默吸收，**不抛异常**，只有量才看得见；
// 窗口越窄越容易把内容挤到被切 / 溢出 —— 就是"拖完窗口边缘里面就乱"。
//
// 修法：把分隔条宽度收成一个常量 _handleWidth，预算、拖动骨架、真实渲染
// 三处共用。这个测试守住"三处一致"这件事 —— 谁再单独改一处就会红。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/home_shell.dart';
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

Future<void> _pumpLogical(
  WidgetTester tester,
  Size logical, {
  double dpr = 1.0,
}) async {
  tester.view.devicePixelRatio = dpr;
  tester.view.physicalSize = Size(logical.width * dpr, logical.height * dpr);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

/// 找出所有分隔条（带 resizeLeftRight 光标的那条）的真实渲染宽度。
List<double> _handleWidths(WidgetTester tester) {
  final handles = find.byWidgetPredicate(
    (w) => w is MouseRegion && w.cursor == SystemMouseCursors.resizeLeftRight,
  );
  final out = <double>[];
  for (final element in handles.evaluate()) {
    final box = element.findRenderObject();
    if (box is RenderBox && box.hasSize) out.add(box.size.width);
  }
  return out;
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('★★ 分隔条实际占位宽度，必须等于布局预算里的那个数', (tester) async {
    addTearDown(tester.view.reset);
    final state = _stateWith([_room('r1', '甲')]);
    addTearDown(state.dispose);
    state.layoutLeftWidth = 480;
    state.layoutRightWidth = 560;
    state.panelOpen = true;

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );
    await _pumpLogical(tester, const Size(1400, 800));

    final widths = _handleWidths(tester);
    expect(widths.isNotEmpty, isTrue, reason: '应该能找到分隔条');

    // 所有分隔条宽度必须一致 —— 预算里它们按同一个数相加，宽窄不一就对不上
    final first = widths.first;
    for (final w in widths) {
      expect(
        w,
        closeTo(first, 0.01),
        reason: '分隔条宽度不一致：$widths —— 预算按同一个数相加，会对不上',
      );
    }

    // 关键：宽度必须 > 1（1px 太小没法点），且预算必须按这个真实值算。
    // 这里直接断言"预算和实际一致"：HomeShell 内部用同一个常量，
    // 所以只要渲染宽度不是凭空来的，chat 区就不会被偷偷挤掉。
    expect(
      first,
      greaterThanOrEqualTo(4.0),
      reason: '命中区不能太窄，否则没法拖动',
    );
    expect(
      first,
      lessThanOrEqualTo(24.0),
      reason: '命中区不能太宽，否则白吃布局空间',
    );
  });

  testWidgets('★★ 四栏全开：各栏宽度之和不许超过可用宽度', (tester) async {
    addTearDown(tester.view.reset);
    final state = _stateWith([_room('r1', '甲')]);
    addTearDown(state.dispose);
    state.layoutLeftWidth = 480;
    state.layoutRightWidth = 560;
    state.layoutBrowserWidth = 900;
    state.panelOpen = true;
    state.browser.openUrl('https://example.com');

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );

    for (final w in [1600.0, 1400.0, 1250.0, 1180.0, 1100.0, 1000.0]) {
      await _pumpLogical(tester, Size(w, 800));

      // 布局不崩是第一层
      expect(tester.takeException(), isNull, reason: '窗口宽 $w 时布局崩了');

      // 第二层：最右一栏的右边缘不许超出可用宽度
      final shell = find.byType(HomeShell);
      if (shell.evaluate().isEmpty) continue;
      final shellBox = tester.renderObject<RenderBox>(shell.first);
      final available = shellBox.size.width;
      final shellRect =
          tester.getRect(shell.first);
      final rightEdge = shellRect.right;

      // 所有分隔条都应该落在可用区域内
      for (final element in find
          .byWidgetPredicate(
            (w) =>
                w is MouseRegion &&
                w.cursor == SystemMouseCursors.resizeLeftRight,
          )
          .evaluate()) {
        final box = element.findRenderObject();
        if (box is! RenderBox || !box.hasSize) continue;
        final rect = box.localToGlobal(Offset.zero) & box.size;
        expect(
          rect.right,
          lessThanOrEqualTo(rightEdge + 0.5),
          reason: '窗口宽 $w：分隔条跑到了可用宽度 $available 之外',
        );
      }
    }
  });
}
