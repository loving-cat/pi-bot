import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:window_manager/window_manager.dart';

import '../theme.dart';

/// 无边框窗口顶部的**拖拽条**。
///
/// 只负责拖拽（和双击最大化/还原）—— 窗口控制按钮统一由
/// [WindowControlsOverlay] 画在整个窗口的右上角，
/// 聊天区自己不再放一套，否则会出现两套按钮。
class WindowTitleBar extends StatefulWidget {
  const WindowTitleBar({super.key, this.height = 38});

  final double height;

  static bool get isSupported =>
      !kIsWeb && (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

  @override
  State<WindowTitleBar> createState() => _WindowTitleBarState();
}

class _WindowTitleBarState extends State<WindowTitleBar> {
  @override
  Widget build(BuildContext context) {
    if (!WindowTitleBar.isSupported) return const SizedBox.shrink();

    return GestureDetector(
      behavior: HitTestBehavior.translucent,
      onPanStart: (_) => windowManager.startDragging(),
      onDoubleTap: () async {
        if (await windowManager.isMaximized()) {
          await windowManager.unmaximize();
        } else {
          await windowManager.maximize();
        }
      },
      child: SizedBox(height: widget.height, width: double.infinity),
    );
  }
}

/// 整个窗口右上角的窗口控制按钮（最小化 / 最大化 / 关闭）。
///
/// ★ 图标必须用 Lucide。这个 app 的字体已经全部换成 Lucide，
///   MaterialIcons 字体被 tree-shake 成 1588 字节的空壳，
///   用 `Icons.xxx` 会渲染成**空白按钮** —— 按钮在、能点、有 hover 反馈，
///   但看不到任何图标（这个 bug 骗了我很久）。
class WindowControlsOverlay extends StatelessWidget {
  const WindowControlsOverlay({super.key});

  static bool get isSupported => WindowTitleBar.isSupported;

  @override
  Widget build(BuildContext context) {
    if (!isSupported) return const SizedBox.shrink();

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _WinBtn(
          tip: '最小化',
          icon: LucideIcons.minus,
          onTap: () => windowManager.minimize(),
        ),
        _WinBtn(
          tip: '最大化 / 还原',
          icon: LucideIcons.square,
          iconSize: 12,
          onTap: () async {
            if (await windowManager.isMaximized()) {
              await windowManager.unmaximize();
            } else {
              await windowManager.maximize();
            }
          },
        ),
        _WinBtn(
          tip: '关闭',
          icon: LucideIcons.x,
          danger: true,
          onTap: () => windowManager.close(),
        ),
      ],
    );
  }
}

/// 给"右上角窗口控制按钮"让位的占位块 —— 各页面的 AppBar actions 末尾都该放一个。
///
/// 控制按钮是**画在整个窗口右上角**的（无边框窗口，见 [WindowControlsOverlay]），
/// 而 AppBar 的 actions 也在右上角 —— 两者会叠在一起。
/// 用户截图里"设置页的刷新和关闭叠在一块"就是这么来的。没让位的页面全中招。
class WindowControlsSpacer extends StatelessWidget {
  const WindowControlsSpacer({super.key});

  /// 三个按钮 × 44
  static const double width = 132;

  @override
  Widget build(BuildContext context) {
    // 手机/网页上没有自绘的窗口按钮，不用留
    if (!WindowTitleBar.isSupported) return const SizedBox.shrink();
    return const SizedBox(width: width);
  }
}

/// 单个窗口按钮。hover 时浮出底色（关闭键是红色），和 Windows 原生行为一致。
class _WinBtn extends StatefulWidget {
  const _WinBtn({
    required this.tip,
    required this.icon,
    required this.onTap,
    this.iconSize = 14,
    this.danger = false,
  });

  final String tip;
  final IconData icon;
  final VoidCallback onTap;
  final double iconSize;
  final bool danger;

  @override
  State<_WinBtn> createState() => _WinBtnState();
}

class _WinBtnState extends State<_WinBtn> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final bg = _hover
        ? (widget.danger ? const Color(0xFFE81123) : PB.bgHover)
        : Colors.transparent;
    final fg = _hover && widget.danger ? Colors.white : PB.textSecondary;

    // ★ 这里**故意不放 Tooltip**。
    //
    //   两个原因：
    //   1. Windows 自己的最小化/最大化/关闭本来就没有 tooltip —— 加了反而多一层噪音。
    //   2. 更重要的：Tooltip 在这个叠层里会出问题 —— 悬停 600ms 后它浮出来，
    //      但没能正常画成小卡片，而是**整窗铺了一层半透明灰**；而且它不会自己收，
    //      必须点一下才消失（用户报的"悬停右上角后整个软件变灰"就是这个）。
    //      这个叠层是：无边框窗口 + MaterialApp.builder 里套的 Stack(fit: expand)，
    //      Tooltip 的 OverlayPortal 在里面算错了尺寸。
    //
    //   无障碍信息用 Semantics 给，不靠 tooltip。
    return Semantics(
      label: widget.tip,
      button: true,
      child: MouseRegion(
        cursor: SystemMouseCursors.basic,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          onTap: widget.onTap,
          child: Container(
            width: 44,
            height: 34,
            alignment: Alignment.center,
            color: bg,
            child: Icon(widget.icon, size: widget.iconSize, color: fg),
          ),
        ),
      ),
    );
  }
}

/// 算出"拖动之后窗口该是哪块矩形"（逻辑像素）。
///
/// 抽成纯函数是为了能单测：这段数学错了的表现是"某个方向拖起来不对劲"，
/// 手感问题最难靠肉眼定位，而这里一行 assert 就能钉死。
///
/// 约定：start 是拖动开始时的窗口矩形，delta 是鼠标相对起点的位移，
/// edge 是抓的哪条边/哪个角。只有被抓住的那些边会跟着动。
Rect resizeBy({
  required Rect start,
  required Offset delta,
  required ResizeEdge edge,
  required Size minSize,
}) {
  var l = start.left;
  var t = start.top;
  var r = start.right;
  var b = start.bottom;

  const leftEdges = {
    ResizeEdge.left,
    ResizeEdge.topLeft,
    ResizeEdge.bottomLeft,
  };
  const rightEdges = {
    ResizeEdge.right,
    ResizeEdge.topRight,
    ResizeEdge.bottomRight,
  };
  const topEdges = {ResizeEdge.top, ResizeEdge.topLeft, ResizeEdge.topRight};
  const bottomEdges = {
    ResizeEdge.bottom,
    ResizeEdge.bottomLeft,
    ResizeEdge.bottomRight,
  };

  if (leftEdges.contains(edge)) l += delta.dx;
  if (rightEdges.contains(edge)) r += delta.dx;
  if (topEdges.contains(edge)) t += delta.dy;
  if (bottomEdges.contains(edge)) b += delta.dy;

  // 顶到最小尺寸时，只把"正在被拖的那条边"卡住，另一条边不许动 ——
  // 否则窗口会自己往反方向漂（拖右下角拖过头，左上角会跟着跑）。
  if (r - l < minSize.width) {
    if (leftEdges.contains(edge)) {
      l = r - minSize.width;
    } else {
      r = l + minSize.width;
    }
  }
  if (b - t < minSize.height) {
    if (topEdges.contains(edge)) {
      t = b - minSize.height;
    } else {
      b = t + minSize.height;
    }
  }
  return Rect.fromLTRB(l, t, r, b);
}

/// 无边框窗口的**八向缩放热区**。
///
/// `setAsFrameless()` 去掉了系统标题栏，Windows 的窗口过程就不再给边框做命中
/// 测试 —— 窗口属性上仍然"可缩放"，但四个边、四个角全拖不动，看着像被锁死了。
/// 这里在窗口四周铺一层透明热区，把拖动转给 windowManager.startResizing：
///
///   四个角 = 斜着等比缩放（`resizeUpLeft` 那种对角光标）
///   四条边 = 单方向拉伸/压缩
///
/// 铺在最上层但**在窗口控制按钮下面**（main.dart 里的 Stack 顺序），
/// 所以右上角"关闭"按钮的右上角不会被角热区抢走点击。
class WindowResizeOverlay extends StatefulWidget {
  const WindowResizeOverlay({
    super.key,
    this.edge = 5,
    this.corner = 11,
    this.reserveTopRight = 132,
  });

  /// 四条边的热区厚度。太薄点不中，太厚会盖住贴边的按钮
  final double edge;

  /// 四个角的热区边长 —— 比边厚一点，斜着拖更容错
  final double corner;

  /// 右上角要避开多宽 —— 那是窗口控制按钮的地盘。
  ///
  /// Windows 自己也从不在标题栏按钮上做缩放。以前这里的右上角热区正好压在
  /// "关闭"按钮的右上角上，鼠标停在那儿会同时命中"关闭按钮"和"缩放热区"，
  /// 表现很怪（用户报的悬停右上角后整窗变灰，就是从这个位置触发的）。
  final double reserveTopRight;

  static bool get isSupported => WindowTitleBar.isSupported;

  @override
  State<WindowResizeOverlay> createState() => _WindowResizeOverlayState();
}

class _WindowResizeOverlayState extends State<WindowResizeOverlay>
    with WindowListener {
  bool _maximized = false;

  // 拖动过程中的基准：起点矩形 + 起点鼠标位置 + 抓的是哪条边
  Rect? _startBounds;
  Offset? _startPointer;
  ResizeEdge? _edge;

  @override
  void initState() {
    super.initState();
    if (!WindowResizeOverlay.isSupported) return;
    windowManager.addListener(this);
    // 启动时窗口可能已经是最大化（比如上次退出时就是）
    windowManager
        .isMaximized()
        .then((m) {
          if (mounted && m != _maximized) setState(() => _maximized = m);
        })
        .catchError((_) {
          // 平台没实现（比如跑单测时没有插件）就当"没最大化"：
          // 铺上热区最多是多余，不铺就是彻底不能缩放
        });
  }

  @override
  void dispose() {
    if (WindowResizeOverlay.isSupported) windowManager.removeListener(this);
    super.dispose();
  }

  @override
  void onWindowMaximize() {
    if (mounted) setState(() => _maximized = true);
  }

  @override
  void onWindowUnmaximize() {
    if (mounted) setState(() => _maximized = false);
  }

  @override
  void onWindowRestore() {
    if (mounted) setState(() => _maximized = false);
  }

  @override
  Widget build(BuildContext context) {
    // 最大化时铺热区只会挡住边缘的按钮，而且系统本来也不让拉
    if (!WindowResizeOverlay.isSupported || _maximized) {
      return const SizedBox.shrink();
    }
    final t = widget.edge;
    final c = widget.corner;
    return Stack(
      children: [
        // 四个角：斜着等比缩放
        _zone(
          left: 0,
          top: 0,
          width: c,
          height: c,
          edge: ResizeEdge.topLeft,
          cursor: SystemMouseCursors.resizeUpLeft,
        ),
        // 右上角让开控制按钮（见 reserveTopRight）
        _zone(
          right: widget.reserveTopRight,
          top: 0,
          width: c,
          height: c,
          edge: ResizeEdge.topRight,
          cursor: SystemMouseCursors.resizeUpRight,
        ),
        _zone(
          left: 0,
          bottom: 0,
          width: c,
          height: c,
          edge: ResizeEdge.bottomLeft,
          cursor: SystemMouseCursors.resizeDownLeft,
        ),
        _zone(
          right: 0,
          bottom: 0,
          width: c,
          height: c,
          edge: ResizeEdge.bottomRight,
          cursor: SystemMouseCursors.resizeDownRight,
        ),
        // 四条边：单方向拉伸（左右两端让开角热区，免得抢）
        _zone(
          left: c,
          right: widget.reserveTopRight,
          top: 0,
          height: t,
          edge: ResizeEdge.top,
          cursor: SystemMouseCursors.resizeUp,
        ),
        _zone(
          left: c,
          right: c,
          bottom: 0,
          height: t,
          edge: ResizeEdge.bottom,
          cursor: SystemMouseCursors.resizeDown,
        ),
        _zone(
          left: 0,
          top: c,
          bottom: c,
          width: t,
          edge: ResizeEdge.left,
          cursor: SystemMouseCursors.resizeLeft,
        ),
        _zone(
          right: 0,
          top: c,
          bottom: c,
          width: t,
          edge: ResizeEdge.right,
          cursor: SystemMouseCursors.resizeRight,
        ),
      ],
    );
  }

  /// 拖动开始：记下窗口当前的矩形和鼠标位置。
  ///
  /// 这里**不用** windowManager.startResizing —— 那条路会进 Windows 的原生
  /// 模态缩放循环，WM_SIZE 按消息速率猛刷，每一发都要把整个窗口重新光栅化一遍
  /// （实测拉伸时 raster 5~8ms、20~30% 的帧超过 16ms 预算，拖起来就是"不丝滑"）。
  /// 改成自己算：每个 pointer 事件算一次矩形交给 setBounds，节奏跟着 Flutter
  /// 的帧走，不跟系统消息队列赛跑。
  Future<void> _beginDrag(ResizeEdge edge, DragStartDetails d) async {
    _edge = edge;
    _startPointer = d.globalPosition;
    try {
      _startBounds = await windowManager.getBounds();
    } catch (_) {
      _startBounds = null; // 拿不到就不拖，别乱跳
    }
  }

  void _dragTo(DragUpdateDetails d) {
    final start = _startBounds;
    final from = _startPointer;
    final edge = _edge;
    if (start == null || from == null || edge == null) return;
    unawaited(
      windowManager.setBounds(
        resizeBy(
          start: start,
          delta: d.globalPosition - from,
          edge: edge,
          minSize: kWindowMinSize,
        ),
      ),
    );
  }

  Widget _zone({
    double? left,
    double? top,
    double? right,
    double? bottom,
    double? width,
    double? height,
    required ResizeEdge edge,
    required MouseCursor cursor,
  }) {
    return Positioned(
      left: left,
      top: top,
      right: right,
      bottom: bottom,
      width: width,
      height: height,
      child: MouseRegion(
        cursor: cursor,
        child: GestureDetector(
          behavior: HitTestBehavior.translucent,
          onPanStart: (d) => _beginDrag(edge, d),
          onPanUpdate: _dragTo,
        ),
      ),
    );
  }
}
