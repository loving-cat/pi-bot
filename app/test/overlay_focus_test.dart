import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/overlay_focus_keeper.dart';

/// 浮层打开时，下面聊天输入框不该继续接键盘。
///
/// ModalBarrier 只负责挡点击，**不会**让下层输入框失焦。
/// HomeShell 用 OverlayFocusKeeper 在浮层开合时搬焦点 ——
/// 这里测的就是 HomeShell 用的那一份实现（不是复制的等价代码）。
void main() {
  testWidgets('★ 浮层打开后输入框失焦，关闭后还回去', (tester) async {
    final focus = FocusNode();
    final input = TextEditingController();
    final keeper = OverlayFocusKeeper();
    var overlay = false;

    Widget build() {
      // 与 HomeShell 的调用方式完全一致
      keeper.sync(overlay, isMounted: () => true);
      return MaterialApp(
        home: Scaffold(
          body: Stack(
            children: [
              TextField(focusNode: focus, controller: input),
              if (overlay) const ModalBarrier(color: Colors.black38),
            ],
          ),
        ),
      );
    }

    await tester.pumpWidget(build());
    focus.requestFocus();
    await tester.pumpAndSettle();
    expect(focus.hasFocus, isTrue, reason: '起步时输入框应该聚焦');

    overlay = true;
    await tester.pumpWidget(build());
    await tester.pumpAndSettle();
    expect(focus.hasFocus, isFalse, reason: '浮层打开后输入框必须失焦');

    overlay = false;
    await tester.pumpWidget(build());
    await tester.pumpAndSettle();
    expect(focus.hasFocus, isTrue, reason: '关闭后焦点应该回到输入框');
  });

  testWidgets('状态没变时不重复搬（可每帧调用）', (tester) async {
    final focus = FocusNode();
    final keeper = OverlayFocusKeeper();

    await tester.pumpWidget(MaterialApp(
      home: Scaffold(body: TextField(focusNode: focus)),
    ));
    focus.requestFocus();
    await tester.pumpAndSettle();

    // 连调三次 false：不该有任何副作用
    keeper.sync(false, isMounted: () => true);
    keeper.sync(false, isMounted: () => true);
    keeper.sync(false, isMounted: () => true);
    await tester.pumpAndSettle();
    expect(focus.hasFocus, isTrue, reason: '状态没变就不该动焦点');
    expect(keeper.hasOverlay, isFalse);
  });

  testWidgets('没有旧焦点时，关闭浮层不会乱抢焦点', (tester) async {
    final keeper = OverlayFocusKeeper();
    var overlay = false;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (_) {
            keeper.sync(overlay, isMounted: () => true);
            return const Text('x');
          },
        ),
      ),
    ));
    await tester.pumpAndSettle();

    overlay = true;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (_) {
            keeper.sync(overlay, isMounted: () => true);
            return const Text('x');
          },
        ),
      ),
    ));
    await tester.pumpAndSettle();

    overlay = false;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (_) {
            keeper.sync(overlay, isMounted: () => true);
            return const Text('x');
          },
        ),
      ),
    ));
    await tester.pumpAndSettle();
    // 没崩就算过：守的是别去 requestFocus 一个不存在的节点
    expect(find.text('x'), findsOneWidget);
  });

  testWidgets('宿主已销毁时不再碰焦点', (tester) async {
    final keeper = OverlayFocusKeeper();
    var alive = true;
    await tester.pumpWidget(const MaterialApp(home: Scaffold()));

    keeper.sync(true, isMounted: () => alive);
    alive = false;   // 模拟宿主在 post-frame 前就没了
    await tester.pumpAndSettle();
    // 不崩即通过
    expect(find.byType(Scaffold), findsOneWidget);
  });
}