import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/window_escape.dart';

// 无边框窗口的逃生口（规格 spec-intent-and-habits-v1.md §2 第 3 条）。
//
// 这一层最容易写歪的方向是"Esc 顺手把应用退了" —— 用户只是想取消一个对话框，
// 结果整个 App 关掉。所以下面一半用例都在钉"什么时候不许动"。

void main() {
  group('Esc 优先级', () {
    test('有可关的路由（对话框/预览）→ 先关它', () {
      expect(decideEscape(canPop: true, paneOpen: true), WindowEscape.popRoute);
      expect(decideEscape(canPop: true), WindowEscape.popRoute);
    });

    test('没有路由但有栏 → 关栏', () {
      expect(decideEscape(paneOpen: true), WindowEscape.closePane);
    });

    test('★ 什么都没有 → 什么都不做（不是退出应用）', () {
      expect(decideEscape(), WindowEscape.nothing);
      expect(decideEscape(canPop: false, paneOpen: false), WindowEscape.nothing);
    });

    test('★ nothing 这个值永远不等于"退出"：枚举里没有 quit', () {
      // 这条看着傻，但它守的是设计意图：Esc 不该有退出这条路。
      // 将来有人想加 WindowEscape.quit，这条会红，逼他先想清楚误触。
      expect(WindowEscape.values.length, 3);
      expect(WindowEscape.values.map((e) => e.name).toSet(),
          {'popRoute', 'closePane', 'nothing'});
    });
  });

  group('退出组合键', () {
    test('Windows/Linux：Ctrl+Shift+Q；macOS：⌘+Shift+Q', () {
      final list = quitShortcuts;
      expect(list.length, 2);
      expect(list[0].trigger, LogicalKeyboardKey.keyQ);
      expect(list[0].control, isTrue);
      expect(list[0].shift, isTrue);
      expect(list[1].meta, isTrue);
      expect(list[1].shift, isTrue);
    });

    test('★ 不带 Shift 的不算（⌘Q / Ctrl+Q 留给系统习惯）', () {
      expect(isQuitChord(control: true, meta: false, shift: false, key: LogicalKeyboardKey.keyQ), isFalse);
      expect(isQuitChord(control: false, meta: true, shift: false, key: LogicalKeyboardKey.keyQ), isFalse);
    });

    test('必须恰好是 Q 且带 Ctrl 或 ⌘', () {
      expect(isQuitChord(control: true, meta: false, shift: true, key: LogicalKeyboardKey.keyQ), isTrue);
      expect(isQuitChord(control: false, meta: true, shift: true, key: LogicalKeyboardKey.keyQ), isTrue);
      expect(isQuitChord(control: true, meta: false, shift: true, key: LogicalKeyboardKey.keyW), isFalse);
      expect(isQuitChord(control: false, meta: false, shift: true, key: LogicalKeyboardKey.keyQ), isFalse);
    });
  });
}
