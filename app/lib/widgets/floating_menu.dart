import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../motion.dart';
import '../theme.dart';

/// 悬浮菜单里的一项。
class FloatingMenuEntry {
  const FloatingMenuEntry({
    required this.icon,
    required this.label,
    required this.onTap,
    this.hint,
    this.iconColor,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  /// 右侧灰色小字说明（可以不放）
  final String? hint;

  /// 图标单独染色（比如"教它做任务"用强调红）
  final Color? iconColor;
}

/// 锚定在某个按钮**正上方**的悬浮菜单。
///
/// 为什么不直接用 `showModalBottomSheet`：底部弹层是移动端手势范式，
/// 在桌面/宽屏上会从屏幕最底下窜出来，和触发按钮隔着半个屏幕，
/// 既不好看也不符合"就近反馈"的直觉。同类客户端 用的是贴着按钮浮出来的小卡片，
/// 这里照做 —— 卡片左边缘对齐按钮，垂直方向浮在按钮上方 [gap] 像素。
///
/// 关闭方式：点空白处 / Esc / 选中任意一项。
Future<void> showFloatingMenu({
  required BuildContext context,
  required GlobalKey anchorKey,
  required List<FloatingMenuEntry> entries,
  double gap = 10,
  double width = 214,
}) async {
  final box = anchorKey.currentContext?.findRenderObject() as RenderBox?;
  if (box == null || !box.attached) return;
  final overlay = Overlay.maybeOf(context);
  if (overlay == null) return;

  final anchor = box.localToGlobal(Offset.zero);
  final screen = MediaQuery.sizeOf(context);

  // 水平：默认左边缘贴按钮；右边放不下就往左推
  final left = anchor.dx.clamp(8.0, (screen.width - width - 8).clamp(8.0, double.infinity));
  // 垂直：卡片底边浮在按钮上方 gap 处（用 bottom 定位，卡片高度自适应）
  final bottom = (screen.height - anchor.dy + gap).clamp(8.0, screen.height - 80);

  final done = <VoidCallback>[];
  late OverlayEntry entry;
  void close() {
    if (entry.mounted) entry.remove();
    for (final f in done) {
      f();
    }
  }

  entry = OverlayEntry(
    builder: (ctx) => _FloatingMenuLayer(
      left: left,
      bottom: bottom,
      width: width,
      entries: entries,
      onClose: close,
      registerDispose: done.add,
    ),
  );
  overlay.insert(entry);
}

class _FloatingMenuLayer extends StatefulWidget {
  const _FloatingMenuLayer({
    required this.left,
    required this.bottom,
    required this.width,
    required this.entries,
    required this.onClose,
    required this.registerDispose,
  });

  final double left;
  final double bottom;
  final double width;
  final List<FloatingMenuEntry> entries;
  final VoidCallback onClose;
  final void Function(VoidCallback) registerDispose;

  @override
  State<_FloatingMenuLayer> createState() => _FloatingMenuLayerState();
}

class _FloatingMenuLayerState extends State<_FloatingMenuLayer>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: Motion.base,
  )..forward();

  @override
  void initState() {
    super.initState();
    widget.registerDispose(_c.dispose);
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        // 点空白关掉。transparent + opaque 命中行为，卡片是它的兄弟节点、画在上层，
        // 所以点卡片本身不会被这里吃掉。
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onClose,
            child: const SizedBox.expand(),
          ),
        ),
        Positioned(
          left: widget.left,
          bottom: widget.bottom,
          width: widget.width,
          child: CallbackShortcuts(
            bindings: {
              const SingleActivator(LogicalKeyboardKey.escape): widget.onClose,
            },
            child: Focus(
              autofocus: true,
              child: AnimatedBuilder(
                animation: _c,
                builder: (context, child) {
                  final t = Motion.inC.transform(_c.value);
                  return Opacity(
                    opacity: t,
                    // 从卡片右下角（贴着按钮那侧）弹出，像长出来一样
                    child: Transform.scale(
                      scale: 0.94 + 0.06 * t,
                      alignment: Alignment.bottomLeft,
                      child: Transform.translate(
                        offset: Offset(0, 6 * (1 - t)),
                        child: child,
                      ),
                    ),
                  );
                },
                child: _card(),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _card() {
    return Container(
      padding: const EdgeInsets.all(5),
      decoration: BoxDecoration(
        color: PB.bgElevated,
        borderRadius: BorderRadius.circular(PB.r2xl),
        border: Border.all(color: PB.borderSecondary),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.55),
            blurRadius: 26,
            offset: const Offset(0, 10),
          ),
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.30),
            blurRadius: 4,
            offset: const Offset(0, 1),
          ),
        ],
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < widget.entries.length; i++)
            Padding(
              padding: EdgeInsets.only(top: i == 0 ? 0 : 2),
              child: _row(widget.entries[i]),
            ),
        ],
      ),
    );
  }

  Widget _row(FloatingMenuEntry e) {
    return HoverTap(
      baseColor: Colors.transparent,
      hoverColor: PB.bgHover,
      pressColor: PB.bgActive,
      borderRadius: BorderRadius.circular(PB.rXl),
      onTap: () {
        // 先关掉再执行：避免回调里又开新菜单时和这次的关闭打架
        widget.onClose();
        e.onTap();
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        child: Row(
          children: [
            Icon(e.icon, size: 17, color: e.iconColor ?? PB.textSecondary),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                e.label,
                style: const TextStyle(
                  fontSize: PB.fsSm,
                  color: PB.textPrimary,
                  height: 1.2,
                ),
              ),
            ),
            if (e.hint != null)
              Text(
                e.hint!,
                style: const TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// 一个"+"样子的触发按钮，配合 [showFloatingMenu] 用。
/// 单独抽出来是因为圆角方底的 hover 反馈在圆按钮上要单独调。
class PlusTriggerButton extends StatelessWidget {
  const PlusTriggerButton({
    super.key,
    required this.anchorKey,
    required this.onTap,
    this.size = 36,
    this.tooltip = '更多',
  });

  final GlobalKey anchorKey;
  final VoidCallback onTap;
  final double size;
  final String tooltip;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      waitDuration: const Duration(milliseconds: 550),
      child: HoverTap(
        key: anchorKey,
        onTap: onTap,
        pressScale: 0.9,
        baseColor: PB.bgActive,
        hoverColor: PB.bgHover,
        borderRadius: BorderRadius.circular(PB.rFull),
        child: SizedBox(
          width: size,
          height: size,
          child: const Center(
            child: Icon(LucideIcons.plus, size: 19, color: PB.textSecondary),
          ),
        ),
      ),
    );
  }
}
