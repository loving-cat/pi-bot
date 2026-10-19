import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// 桌面端快捷键：按**系统习惯**绑定，不要硬编码 Ctrl。
///
/// ## 为什么不能一律用 Ctrl
///
/// macOS 用户的肌肉记忆是 ⌘C / ⌘V / ⌘A / ⌘X，Windows/Linux 是 Ctrl。
/// 写死 `LogicalKeyboardKey.control` 会让 Mac 用户按 ⌘ 没反应，
/// 反过来写死 meta 会让 Windows 用户按 Ctrl 没反应。两边都得照顾。
///
/// Flutter 自带的 `DefaultTextEditingShortcuts` 已经做了这个映射，
/// 但它只覆盖"文本框内"的标准编辑行为；一旦我们自己接管了某个键
/// （比如拦截回车发送、或者给粘贴加"有图就发图"的逻辑），
/// 就得自己把平台差异补上，否则那个键在某一边就是死的。
///
/// 这里提供两个东西：
///   · [isMacLike]  —— 当前平台是不是用 ⌘ 的那一类
///   · [shortcutModifier] —— 当前平台对应的修饰键
///
/// 以及 [desktopEditingShortcuts]：一份包含常用编辑操作的
/// `ShortcutActivator → Intent` 映射，按平台生成。

/// macOS 系（用 ⌘）。iOS 外接键盘也遵循 ⌘ 习惯，一并算进来。
bool get isMacLike =>
    defaultTargetPlatform == TargetPlatform.macOS ||
    defaultTargetPlatform == TargetPlatform.iOS;

/// 当前平台的主修饰键：Mac 是 ⌘（meta），其余是 Ctrl。
LogicalKeyboardKey get shortcutModifier =>
    isMacLike ? LogicalKeyboardKey.meta : LogicalKeyboardKey.control;

/// 带主修饰键的单键快捷方式（如 ⌘C / Ctrl+C）。
SingleActivator withModifier(LogicalKeyboardKey key, {bool shift = false}) =>
    SingleActivator(key, meta: isMacLike, control: !isMacLike, shift: shift);

/// 给某个文本框用的编辑快捷键。
///
/// 之所以要自己写一份：我们接管了 Enter（发送），并在 PasteTextIntent 上
/// 加了"剪贴板有图就发图"的逻辑。这种情况下 Flutter 的默认映射不一定完整，
/// 显式声明一遍最稳 —— 用户按 ⌘C 就该复制，不该因为我们的自定义而失效。
///
/// 用法：
/// ```dart
/// Shortcuts(
///   shortcuts: desktopEditingShortcuts(),
///   child: TextField(...),
/// )
/// ```
Map<ShortcutActivator, Intent> desktopEditingShortcuts({
  VoidCallback? onCopy,
  VoidCallback? onCut,
  VoidCallback? onPaste,
  VoidCallback? onSelectAll,
  VoidCallback? onUndo,
  VoidCallback? onRedo,
}) {
  final map = <ShortcutActivator, Intent>{};

  // 复制 / 剪切 / 粘贴 / 全选 / 撤销 / 重做
  map[withModifier(LogicalKeyboardKey.keyC)] = CopySelectionTextIntent.copy;
  map[withModifier(LogicalKeyboardKey.keyX)] = const CopySelectionTextIntent.cut(
    SelectionChangedCause.keyboard,
  );
  // 粘贴用 Flutter 的 PasteTextIntent：调用方可以在 Actions 里接管它
  // （聊天输入框就是靠这个实现"有截图就发图"）。
  map[withModifier(LogicalKeyboardKey.keyV)] = PasteTextIntent(
    SelectionChangedCause.keyboard,
  );
  map[withModifier(LogicalKeyboardKey.keyA)] = const SelectAllTextIntent(
    SelectionChangedCause.keyboard,
  );
  map[withModifier(LogicalKeyboardKey.keyZ)] = const UndoTextIntent(
    SelectionChangedCause.keyboard,
  );
  // ⌘⇧Z / Ctrl+Shift+Z 重做（Mac 习惯；Windows 还有 Ctrl+Y，两个都绑）
  map[withModifier(LogicalKeyboardKey.keyZ, shift: true)] = const RedoTextIntent(
    SelectionChangedCause.keyboard,
  );
  map[withModifier(LogicalKeyboardKey.keyY)] = const RedoTextIntent(
    SelectionChangedCause.keyboard,
  );

  // 行首/行尾：Mac 是 ⌘←/→，Windows 是 Home/End（后者是默认行为，不用绑）
  if (isMacLike) {
    map[withModifier(LogicalKeyboardKey.arrowLeft)] =
        const _MoveToLineStartIntent();
    map[withModifier(LogicalKeyboardKey.arrowRight)] =
        const _MoveToLineEndIntent();
  }

  return map;
}

/// 把光标移到当前行行首（Mac ⌘←）
class _MoveToLineStartIntent extends Intent {
  const _MoveToLineStartIntent();
}

/// 把光标移到当前行行尾（Mac ⌘→）
class _MoveToLineEndIntent extends Intent {
  const _MoveToLineEndIntent();
}

/// 给 `desktopEditingShortcuts()` 配的 Actions 实现。
///
/// 直接操作 controller，不依赖 EditableText 的内部状态 —— 这样在任何
/// 包了 Shortcuts 的地方都能用。
Map<Type, Action<Intent>> desktopEditingActions(TextEditingController controller) {
  return {
    _MoveToLineStartIntent: CallbackAction<_MoveToLineStartIntent>(
      onInvoke: (_) {
        final value = controller.value;
        final offset = value.selection.baseOffset;
        if (offset < 0) return null;
        final text = value.text;
        final lineStart = text.lastIndexOf('\n', (offset - 1).clamp(0, text.length));
        final target = lineStart < 0 ? 0 : lineStart + 1;
        controller.selection = TextSelection.collapsed(offset: target);
        return null;
      },
    ),
    _MoveToLineEndIntent: CallbackAction<_MoveToLineEndIntent>(
      onInvoke: (_) {
        final value = controller.value;
        final offset = value.selection.baseOffset;
        if (offset < 0) return null;
        final text = value.text;
        final lineEnd = text.indexOf('\n', offset);
        final target = lineEnd < 0 ? text.length : lineEnd;
        controller.selection = TextSelection.collapsed(offset: target);
        return null;
      },
    ),
  };
}

/// 给用户看的快捷键提示（按当前平台生成）。
///
/// 界面上写"Ctrl+Enter"在 Mac 上是错的，应该写"⌘+Enter"。
String shortcutLabel(String key) => isMacLike ? '⌘+$key' : 'Ctrl+$key';
