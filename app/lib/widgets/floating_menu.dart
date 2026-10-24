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
    this.danger = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  /// 右侧灰色小字说明（可以不放）
  final String? hint;

  /// 图标单独染色（比如"教它做任务"用强调红）
  final Color? iconColor;

  /// 危险操作：图标和文字整体染红（删除那一项，和系统右键菜单一样）
  final bool danger;
}

/// 菜单该摆在哪 —— 纯函数，单独拎出来是为了能单测。
///
/// ★ 菜单不能一律往上开：在窗口上边右键时，
///   菜单整个被顶出可视区，前面几项直接看不见。
///
/// 规则：
///   · 水平：左边缘贴锚点；右边放不下就往左推，但永远不越过 8px 边距
///   · 垂直：先看哪边放得下（高度按项数估），放得下就往下开，否则翻上去；
///           两边都放不下就挑空间大的那一边（顶多裁掉一点，不会整块看不见）
///
/// 返回的 top / bottom 只有一个非空：
///   top 非空 = 菜单顶边贴锚点下方（往下开）
///   bottom 非空 = 菜单底边贴锚点上方（往上开）
({double left, double? top, double? bottom}) menuPlacement({
  required Offset anchor,
  required Size screen,
  required int entryCount,
  double width = 214,
  double gap = 10,
}) {
  const margin = 8.0;
  // 每项约 36px + 上下留白。自适应高度在 Positioned 里量不到，只能估；
  // 估大一点顶多是"本来放得下却翻了边"，比截断好。
  final estHeight = entryCount * 36.0 + 12;

  final left = anchor.dx.clamp(
    margin,
    (screen.width - width - margin).clamp(margin, double.infinity),
  );

  final roomBelow = screen.height - anchor.dy - gap - margin;
  final roomAbove = anchor.dy - gap - margin;
  final openDown =
      roomBelow >= estHeight ||
      (roomAbove < estHeight && roomBelow >= roomAbove);

  if (openDown) {
    return (
      left: left,
      top: (anchor.dy + gap).clamp(
        margin,
        (screen.height - 80).clamp(margin, double.infinity),
      ),
      bottom: null,
    );
  }
  return (
    left: left,
    top: null,
    bottom: (screen.height - anchor.dy + gap).clamp(margin, screen.height - 80),
  );
}

/// 锚定在某个按钮**附近**的悬浮菜单（贴着按钮上方或下方，看哪边放得下）。
///
/// 为什么不直接用 `showModalBottomSheet`：底部弹层是移动端手势范式，
/// 在桌面/宽屏上会从屏幕最底下窜出来，和触发按钮隔着半个屏幕，
/// 既不好看也不符合"就近反馈"的直觉。贴着触发点浮出一张小卡片更自然，
/// 这里照做 —— 卡片左边缘对齐按钮，垂直方向浮在按钮上方 [gap] 像素。
///
/// 关闭方式：点空白处 / Esc / 选中任意一项。
Future<void> showFloatingMenu({
  required BuildContext context,
  GlobalKey? anchorKey,
  Offset? at,
  required List<FloatingMenuEntry> entries,
  double gap = 10,
  double width = 214,
}) async {
  Offset anchor;
  if (at != null) {
    // 右键菜单：贴着鼠标弹出，往下开（和系统右键菜单一样的方向）
    anchor = at;
  } else {
    final box = anchorKey?.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.attached) return;
    anchor = box.localToGlobal(Offset.zero);
  }
  final overlay = Overlay.maybeOf(context);
  if (overlay == null) return;

  // ★ 锚点是**窗口全局坐标**，而 Overlay 有自己的坐标系 —— 两者不一定重合。
  //   `MaterialApp.builder` 在 Navigator 上面加了标题条（见 main.dart），
  //   Overlay 随之整体下移了一条标题条的高度；把全局坐标直接交给 Positioned，
  //   菜单就会下移同样的距离。统一换算到 Overlay 的局部坐标，
  //   两条定位路径（鼠标 / anchorKey）都走这一遍。
  final overlayBox = overlay.context.findRenderObject() as RenderBox?;
  final overlayReady =
      overlayBox != null && overlayBox.attached && overlayBox.hasSize;
  if (overlayReady) anchor = overlayBox.globalToLocal(anchor);

  // 可视区也用 Overlay 的尺寸：菜单插在 Overlay 里，边界就是它的边界；
  // MediaQuery 给的是整个窗口高度，比 Overlay 高一截。
  final screen = overlayReady ? overlayBox.size : MediaQuery.sizeOf(context);
  final spot = menuPlacement(
    anchor: anchor,
    screen: screen,
    entryCount: entries.length,
    width: width,
    gap: gap,
  );
  final left = spot.left;
  final top = spot.top;
  final bottom = spot.bottom;

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
      top: top,
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
    required this.top,
    required this.bottom,
    required this.width,
    required this.entries,
    required this.onClose,
    required this.registerDispose,
  });

  final double left;

  /// 往下开时给 top，往上开时给 bottom（两个只有一个非空）
  final double? top;
  final double? bottom;
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
          top: widget.top,
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
    // ★ 卡片外面必须套一层 Material。
    //
    //   菜单是插进 Overlay 的，而 Overlay **不在 app 的 Material 之下** ——
    //   没有 Material 祖先时，Flutter 会故意给所有 Text 画上"黄色双下划线"，
    //   提示你主题没接上（这是它的提示机制，不是渲染 bug）。
    //   表现就是：菜单每一项文字下面都挂着两条杠，而且颜色不受本组件控制。
    //
    //   MaterialType.transparency 只借 DefaultTextStyle，不画底色 ——
    //   卡片的圆角/边框/阴影还是下面这个 Container 自己画。
    return Material(
      type: MaterialType.transparency,
      child: Container(
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
            Icon(
              e.icon,
              size: 17,
              color: e.danger ? PB.danger : (e.iconColor ?? PB.textSecondary),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                e.label,
                style: TextStyle(
                  fontSize: PB.fsSm,
                  color: e.danger ? PB.danger : PB.textPrimary,
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
