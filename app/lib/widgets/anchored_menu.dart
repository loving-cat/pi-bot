import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../motion.dart';
import '../theme.dart';
import 'floating_menu.dart';

/// 浮层里的一项：比 FloatingMenuEntry 多一个副标题。
///
/// 分成两个类型而不是硬塞：右键菜单要的是「一行一个动作」的紧凑感，
/// 这里要的是「图标 + 标题 + 一句解释」的选择感 —— 两种排版不适合混用。
class AnchoredMenuItem {
  const AnchoredMenuItem({
    required this.icon,
    required this.title,
    this.subtitle,
    required this.onTap,
    this.highlight = false,
    this.sectionLabel,
  });

  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;

  /// 主推的那一项（图标底色用强调色）
  final bool highlight;

  /// 这一项上面要不要先画一段分组标题（比如「新建」「私聊某个 bot」）。
  /// 只在需要分组时才填 —— 连续几项只填第一个，读起来就是一组。
  final String? sectionLabel;
}

/// 贴着触发按钮弹出的浮层卡片。
///
/// 为什么不用 showModalBottomSheet：
///   底部弹层是移动端手势范式。在桌面/宽屏上它会从屏幕最底下窜出来，
///   和点的那颗按钮隔着半个屏幕，既不好看也不符合"就近反馈"。
///   这里照 showFloatingMenu 的思路，贴着锚点浮出一张卡片。
///
/// 关闭：点空白处 / Esc / 选中任意一项。
Future<void> showAnchoredMenu({
  required BuildContext context,
  required GlobalKey anchorKey,
  required List<AnchoredMenuItem> items,
  String? title,
  double width = 300,
}) async {
  final box = anchorKey.currentContext?.findRenderObject() as RenderBox?;
  if (box == null || !box.attached) return;
  final anchor = box.localToGlobal(Offset.zero);
  // 按钮的实际高度：往下开时从它的底边算起，浮层才不会盖住按钮本身
  final anchorHeight = box.size.height;

  final overlay = Overlay.maybeOf(context);
  if (overlay == null) return;
  final overlayBox = overlay.context.findRenderObject() as RenderBox?;
  final ready = overlayBox != null && overlayBox.attached && overlayBox.hasSize;
  // Overlay 有自己的坐标系：MaterialApp.builder 在上面加了标题条，
  // 直接把全局坐标交给 Positioned 会整体下移一条标题条的高度。
  final local = ready ? overlayBox.globalToLocal(anchor) : anchor;
  final screen = ready ? overlayBox.size : MediaQuery.sizeOf(context);

  // 每项按「有副标题 56 / 没副标题 44」估高，外加标题和上下留白
  final itemHeight = items.fold<double>(
    0,
    (sum, it) => sum + (it.subtitle == null ? 44 : 56),
  );
  final estHeight = itemHeight + (title == null ? 20 : 46);

  final spot = menuPlacement(
    anchor: local,
    screen: screen,
    entryCount: (estHeight / 36).ceil(),
    width: width,
    gap: 8,
    anchorHeight: anchorHeight,
  );

  late OverlayEntry entry;
  void close() {
    if (entry.mounted) entry.remove();
  }

  entry = OverlayEntry(
    builder: (ctx) => _AnchoredMenuHost(
      left: spot.left,
      top: spot.top,
      bottom: spot.bottom,
      width: width,
      title: title,
      items: items,
      onClose: close,
    ),
  );
  overlay.insert(entry);
}

class _AnchoredMenuHost extends StatefulWidget {
  const _AnchoredMenuHost({
    required this.left,
    required this.top,
    required this.bottom,
    required this.width,
    required this.title,
    required this.items,
    required this.onClose,
  });

  final double left;
  final double? top;
  final double? bottom;
  final double width;
  final String? title;
  final List<AnchoredMenuItem> items;
  final VoidCallback onClose;

  @override
  State<_AnchoredMenuHost> createState() => _AnchoredMenuHostState();
}

class _AnchoredMenuHostState extends State<_AnchoredMenuHost> {
  @override
  void initState() {
    super.initState();
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    super.dispose();
  }

  /// Esc 关掉 —— 浮层没有系统窗口的关闭按钮，键盘是最快的退出方式
  bool _onKey(KeyEvent event) {
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.escape) {
      widget.onClose();
      return true;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        // 点击浮层外任意处关闭
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onClose,
          ),
        ),
        Positioned(
          left: widget.left,
          top: widget.top,
          bottom: widget.bottom,
          width: widget.width,
          child: _Card(
            title: widget.title,
            items: widget.items,
            close: widget.onClose,
          ),
        ),
      ],
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({
    required this.title,
    required this.items,
    required this.close,
  });

  final String? title;
  final List<AnchoredMenuItem> items;
  final VoidCallback close;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    return Material(
      color: Colors.transparent,
      child: Container(
        constraints: const BoxConstraints(maxHeight: 460),
        decoration: BoxDecoration(
          color: PB.bgElevated,
          borderRadius: BorderRadius.circular(PB.rXl),
          border: Border.all(color: PB.borderTertiary),
          boxShadow: PB.shadow(y: 8, blur: 28, alpha: 0.45),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(PB.rXl),
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (title != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 6, 10, 6),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            title!,
                            style: const TextStyle(
                              fontSize: PB.fsXxs,
                              fontWeight: FontWeight.w600,
                              color: PB.textTertiary,
                            ),
                          ),
                        ),
                        IconButton(
                          tooltip: s.t('common.cancel'),
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(
                            minWidth: 24,
                            minHeight: 24,
                          ),
                          visualDensity: VisualDensity.compact,
                          onPressed: close,
                          icon: const Icon(
                            LucideIcons.x,
                            size: 13,
                            color: PB.textQuaternary,
                          ),
                        ),
                      ],
                    ),
                  ),
                for (var i = 0; i < items.length; i++) ...[
                  if (items[i].sectionLabel != null)
                    Padding(
                      padding: EdgeInsets.fromLTRB(
                        14,
                        i == 0 ? 2 : 12,
                        14,
                        5,
                      ),
                      child: Text(
                        items[i].sectionLabel!,
                        style: const TextStyle(
                          fontSize: PB.fsXxs,
                          fontWeight: FontWeight.w600,
                          color: PB.textTertiary,
                        ),
                      ),
                    ),
                  _Row(item: items[i], close: close),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Row extends StatefulWidget {
  const _Row({required this.item, required this.close});

  final AnchoredMenuItem item;
  final VoidCallback close;

  @override
  State<_Row> createState() => _RowState();
}

class _RowState extends State<_Row> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final it = widget.item;
    final accent = PB.colors(context);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          widget.close();
          it.onTap();
        },
        child: AnimatedContainer(
          duration: Motion.fast,
          margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          decoration: BoxDecoration(
            color: _hover ? PB.bgActive : Colors.transparent,
            borderRadius: BorderRadius.circular(PB.rLg),
          ),
          child: Row(
            children: [
              Container(
                width: 32,
                height: 32,
                decoration: BoxDecoration(
                  color: it.highlight ? accent.accentSoft : PB.bgActive,
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Icon(
                  it.icon,
                  size: 16,
                  color: it.highlight ? accent.accentBright : PB.textSecondary,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      it.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: PB.fsSm,
                        fontWeight: FontWeight.w500,
                        color: PB.textPrimary,
                      ),
                    ),
                    if (it.subtitle != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 1),
                        child: Text(
                          it.subtitle!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: PB.fsXxs,
                            color: PB.textQuaternary,
                            height: 1.35,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
