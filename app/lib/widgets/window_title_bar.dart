import 'dart:async';
import 'dart:math' as math;
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb;
import 'package:flutter/material.dart';

import 'app_logo.dart';

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

    return SizedBox(
      height: widget.height,
      child: Row(
        children: [
          // 左边先放一枚小图标 —— 窗口没有系统标题栏，这是唯一的"品牌位置"
          const Padding(
            padding: EdgeInsets.only(left: 10, right: 2),
            child: AppLogo(size: 18, radius: 5, glow: false),
          ),
          // 剩下的整块是拖拽区（双击 = 最大化 / 还原），和 Windows 原生一样
          Expanded(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onPanStart: (_) => windowManager.startDragging(),
              onDoubleTap: () async {
                if (await windowManager.isMaximized()) {
                  await windowManager.unmaximize();
                } else {
                  await windowManager.maximize();
                }
              },
              child: const SizedBox.expand(),
            ),
          ),
          // 右边是控制按钮 —— 它们**住在这一条里**，不再浮在页面内容上面
          const WindowControlsOverlay(),
        ],
      ),
    );
  }
}

/// 整个窗口右上角的窗口控制按钮（最小化 / 最大化 / 关闭）。
///
/// ★ 图标必须用 Lucide。这个 app 的字体已经全部换成 Lucide，
///   MaterialIcons 字体被 tree-shake 成 1588 字节的空壳，
///   用 `Icons.xxx` 会渲染成**空白按钮** —— 按钮在、能点、有 hover 反馈，
///   但看不到任何图标。
class WindowControlsOverlay extends StatefulWidget {
  const WindowControlsOverlay({super.key});

  static bool get isSupported => WindowTitleBar.isSupported;

  @override
  State<WindowControlsOverlay> createState() => _WindowControlsOverlayState();
}

class _WindowControlsOverlayState extends State<WindowControlsOverlay>
    with WindowListener {
  bool _maximized = false;

  @override
  void initState() {
    super.initState();
    if (!WindowControlsOverlay.isSupported) return;
    windowManager.addListener(this);
    windowManager
        .isMaximized()
        .then((m) {
          if (mounted && m != _maximized) setState(() => _maximized = m);
        })
        .catchError((_) {});
  }

  @override
  void dispose() {
    if (WindowControlsOverlay.isSupported) windowManager.removeListener(this);
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
    if (!WindowControlsOverlay.isSupported) return const SizedBox.shrink();

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _WinBtn(
          tip: '最小化',
          icon: LucideIcons.minus,
          onTap: () => windowManager.minimize(),
        ),
        // ★ 全屏之后图标要变成"还原"（两个叠起来的方块）——
        //   一直是"最大化"的图标，用户按下去会以为又要放大一次。
        //   状态从窗口事件来（window_manager 的 onWindowMaximize/Restore）。
        _WinBtn(
          tip: _maximized ? '还原' : '最大化',
          icon: _maximized ? LucideIcons.copy : LucideIcons.square,
          iconSize: _maximized ? 13 : 12,
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
    //      必须点一下才消失（悬停右上角后整个软件变灰，就是这个）。
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

/// 把"视口内的指针位移"换算成**屏幕上的**指针位移。
///
/// ★ 这是拖动缩放的经典陷阱：`DragUpdateDetails.globalPosition` 是
/// **窗口内容区**里的坐标，不是屏幕坐标。而拖上边/左边时**窗口自己会移动** ——
/// 窗口一移，同一个屏幕位置在窗口内的坐标就变了，于是：
///   算出来的位移 ≈ 0 → 窗口弹回原尺寸 → 下一次算出来又反向 → 来回抽搐。
/// 表现就是从上方拉伸时不断抽搐。
///
/// 补偿办法：窗口被自己移动了多少是已知的（那正是这里设进去的 bounds），
/// 把它加回去就是屏幕位移。
Offset screenDelta({
  required Offset viewDelta,
  required Rect startBounds,
  required Rect lastBounds,
}) => viewDelta + (lastBounds.topLeft - startBounds.topLeft);

/// 把窗口矩形夹进显示器的**可用区域**（逻辑坐标，排除任务栏）。
///
/// 为什么要夹：窗口一旦跨到"缩放比不同的另一块屏"，Windows 会改这个窗口的 DPI，
/// 引擎收到新的 devicePixelRatio 就会**整体重缩放** —— 用户看到的是"整个界面
/// 被放大了"。
/// 夹在当前屏内就不会跨屏，也就不会触发那套重缩放。
///
/// 代价：没法靠拖边框把窗口拖到另一块屏上（要挪窗口请拖标题条）。
/// 抽成纯函数是为了能单测 —— 这种"手感/边界"逻辑只有测试看得住。
Rect clampToWorkArea({
  required Rect rect,
  required Rect workArea,
  required Size minSize,
}) {
  // 可用区本身可能就比最小尺寸小（小屏 / 任务栏占太多），先取个折中
  final minW = math.min(minSize.width, workArea.width);
  final minH = math.min(minSize.height, workArea.height);

  var l = rect.left;
  var t = rect.top;
  var r = rect.right;
  var b = rect.bottom;

  // ① 四条边先夹进可用区
  if (r > workArea.right) r = workArea.right;
  if (b > workArea.bottom) b = workArea.bottom;
  if (l < workArea.left) l = workArea.left;
  if (t < workArea.top) t = workArea.top;

  // ② 再保证不小于最小尺寸：优先往右下要空间
  if (r - l < minW) r = math.min(workArea.right, l + minW);
  if (b - t < minH) b = math.min(workArea.bottom, t + minH);
  // 右边/下边已经顶到屏幕了 → 那就把左边/上边往回让
  if (r - l < minW) l = r - minW;
  if (b - t < minH) t = b - minH;

  return Rect.fromLTRB(l, t, r, b);
}

/// Windows/Linux 无边框窗口的八向缩放热区。
/// macOS 保留 NSWindow 原生边缘命中，不用 Flutter 热区覆盖。
/// 热区位于窗口控制按钮下方，右上角避开按钮占用范围。
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
  /// Windows 自己也从不在标题栏按钮上做缩放。右上角热区不能压在
  /// "关闭"按钮的右上角上：鼠标停在那儿会同时命中"关闭按钮"和"缩放热区"，
  /// 表现很怪（悬停右上角后整窗变灰，就是从这个位置触发的）。
  final double reserveTopRight;

  static bool get isSupported =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.windows ||
          defaultTargetPlatform == TargetPlatform.linux);

  @override
  State<WindowResizeOverlay> createState() => _WindowResizeOverlayState();
}

class _WindowResizeOverlayState extends State<WindowResizeOverlay>
    with WindowListener {
  bool _maximized = false;

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

  /// 将一次边缘拖动交给平台原生缩放循环，不自行发送窗口尺寸。
  Future<void> _beginDrag(ResizeEdge edge, DragStartDetails d) async {
    if (!mounted) return;
    try {
      // 让系统接管缩放：一次调用，之后全部由 Windows 处理到松手为止。
      await windowManager.startResizing(edge);
    } catch (_) {
      // 平台没实现（如单测环境）就什么都不做 —— 宁可不能拖，也不要乱改尺寸
    }
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
        // 只要 onPanStart 就够：系统的缩放循环会自己跑完整个拖动，
        // 包括跟踪鼠标、画预览、松手后重排。不能再挂 onPanUpdate
        // （那会变成“一边原生缩放、一边自己 setBounds”，两套抢尺寸）。
        child: GestureDetector(
          behavior: HitTestBehavior.translucent,
          onPanStart: (d) => _beginDrag(edge, d),
        ),
      ),
    );
  }
}
