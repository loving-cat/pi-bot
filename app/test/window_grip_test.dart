import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/window_buttons.dart';
import 'package:pi_bot/window_actions.dart';

/// 窗控把手的结构断言。
///
/// 把手是"能拖的空白"，不是产品署名 —— 它不该出现任何文字。
/// 早先这里画的是字母 π，后来是三颗圆点；现在是应用图标的缩小版记号。
/// 锁住"不含文字"这一条，防止有人又往回塞字母。
void main() {
  testWidgets('把手不含任何文字（不是字母署名）', (tester) async {
    final controller = WindowActionsController(backend: _FakeBackend());
    await tester.pumpWidget(
      L10n(
        controller: LocaleController(),
        child: MaterialApp(
          theme: PB.theme(),
          home: Scaffold(
            body: Center(
              child: SizedBox(
                width: 128,
                height: 28,
                child: WindowButtons(
                  controller: controller,
                  platform: TargetPlatform.macOS,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 50));

    // 把手存在
    expect(find.byKey(const ValueKey('window-brand-grip')), findsOneWidget);
    // 整个控制簇里不应有任何文字 widget（π 就是被这条挡住的）
    final texts = tester.widgetList<Text>(
      find.descendant(
        of: find.byKey(const ValueKey('window-control-cluster')),
        matching: find.byType(Text),
      ),
    );
    expect(
      texts.map((t) => t.data ?? '').where((s) => s.trim().isNotEmpty),
      isEmpty,
      reason: '窗控簇只应有自绘图形，不应再有文字/字母',
    );

    controller.dispose();
  });
}

class _FakeBackend implements WindowActionsBackend {
  @override
  void addListener(dynamic listener) {}
  @override
  void removeListener(dynamic listener) {}
  @override
  Future<bool> isMaximized() async => false;
  @override
  Future<bool> isFullScreen() async => false;
  @override
  Future<void> maximize() async {}
  @override
  Future<void> unmaximize() async {}
  @override
  Future<void> setFullScreen(bool value) async {}
  @override
  Future<void> minimize() async {}
  @override
  Future<void> close() async {}
  @override
  Future<void> startDragging() async {}
}
