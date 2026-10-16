import 'dart:async';
import 'dart:math' as math;
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../resizing.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:screen_retriever/screen_retriever.dart';
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
          // 左边整块是拖拽区（双击 = 最大化 / 还原），和 Windows 原生一样
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
///   但看不到任何图标（这个 bug 骗了我很久）。
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

/// 把"视口内的指针位移"换算成**屏幕上的**指针位移。
///
/// ★ 这是拖动缩放的经典陷阱：`DragUpdateDetails.globalPosition` 是
/// **窗口内容区**里的坐标，不是屏幕坐标。而拖上边/左边时**窗口自己会移动** ——
/// 窗口一移，同一个屏幕位置在窗口内的坐标就变了，于是：
///   算出来的位移 ≈ 0 → 窗口弹回原尺寸 → 下一次算出来又反向 → 来回抽搐。
/// 用户报的"从上方拉伸会不断抽搐"就是这个。
///
/// 补偿办法：我们知道窗口被自己移动了多少（那正是我们设进去的 bounds），
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
/// 被放大了"（用户原话："程序内的不可以乱动"）。
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
    with WindowListener, SingleTickerProviderStateMixin {
  bool _maximized = false;

  // 拖动过程中的基准：起点矩形 + 起点鼠标位置 + 抓的是哪条边
  Rect? _startBounds;
  Offset? _startPointer;
  ResizeEdge? _edge;

  /// 上一次我们自己设进去的矩形 —— 拿它的左上角当"窗口现在在哪"。
  /// 拖上边/左边时要靠它把窗口自身的位移补偿掉（见 screenDelta）。
  Rect? _lastBounds;

  /// 当前显示器的**可用区域**（逻辑坐标，已排除任务栏）。
  /// 拖动开始时取一次；拖动中用它把窗口夹住，避免跨屏触发 DPI 重缩放。
  Rect? _workArea;

  // ---- 平滑 ----
  //
  // 指针事件来得比"窗口真的改完尺寸"快得多。每个事件都硬发一次 setBounds，
  // 就会"上一发还没落地又发下一发"地堆起来 —— 看着就是一跳一跳
  // （用户报的"波动很大、不丝滑"）。
  //
  // 改成：指针只更新**目标**，由 Ticker 按帧率朝目标插值着走。
  // 窗口像被牵引过去，而不是每帧硬跳到新位置。
  Ticker? _ticker;
  Rect? _target;
  Rect? _current;
  bool _sending = false;

  /// 每帧朝目标靠多少：越大越跟手，越小越飘
  static const _follow = 0.55;

  /// 差这么小就直接吸附（否则永远差半个像素、Ticker 停不下来）
  static const _snap = 0.75;

  /// 两次 setBounds 之间至少隔这么久。
  ///
  /// ★ 这是"拖动卡"的关键一条：Ticker 跑 60fps，如果每帧都发一次 setBounds，
  ///   就等于**我们主动每秒发起 60 次整窗重排 + 全量重光栅**（Windows 的尺寸
  ///   变化没有增量路径，每次都整窗重来）。窗口越大越卡。
  ///   限到 ~30 次/秒之后重排少一半，而视觉上完全看不出差别 ——
  ///   因为我们永远发的是**最新位置**（合并，不排队），不会落后。
  /// 限流放宽到 12ms（≈每帧一发）。
  ///
  /// 原来设 28ms（~30 次/秒）是为了省掉"每秒 60 次整窗重排"。但那是**内容没降级**
  /// 时候的账 —— 现在拖动期间内容已经冻成骨架，每帧只要 ~6-7ms（实测），
  /// 平台完全撑得住 60 次/秒。
  /// 而 30 次/秒的代价是"窗口几何一秒只更新 30 次"，快速拖动时每步跨很大，
  /// 看着就是一顿一顿（用户报的"不丝滑、卡卡的"）。
  /// 所以：**留着限流当保险（防止平台真的顶不住时堆积），但把闸门放到几乎不生效**。
  static const _minSendGap = Duration(milliseconds: 12);

  /// 上一次发送的**帧时间戳**（不是墙钟时间）。
  ///
  /// 为什么用帧时钟：限流的本质是"别让一帧里发多次"，而帧时钟正是这件事的标尺；
  /// 墙钟（DateTime.now）在单测里还会骗人 —— `pump(16ms)` 推进的是假时钟，
  /// 墙钟只走了几毫秒，于是 12 帧全被拒掉（我就是这么发现的）。
  Duration? _lastSendAt;

  @override
  void initState() {
    _ticker = createTicker(_onTick);
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
    _resizeQuiet?.cancel();
    _ticker?.dispose();
    if (WindowResizeOverlay.isSupported) windowManager.removeListener(this);
    super.dispose();
  }

  /// 每帧朝目标插值一步
  void _onTick(Duration _) {
    final target = _target;
    final cur = _current;
    if (target == null || cur == null) {
      _ticker?.stop();
      return;
    }
    // ★ 大幅度/快速拖动时**直接跳过去**，不要插值慢慢追。
    //   插值的代价是"窗口永远落后指针一点"，拖得快的时候这个落后会越拉越大，
    //   然后一帧跳一大截 —— 看着就是一顿一顿的（和"闪"混在一起）。
    //   小幅度微调用插值（丝滑），大幅度直接跟手。
    final far =
        (target.left - cur.left).abs() > 80 ||
        (target.top - cur.top).abs() > 80 ||
        (target.right - cur.right).abs() > 80 ||
        (target.bottom - cur.bottom).abs() > 80;
    if (far) {
      _current = target;
      _send(target);
      _ticker?.stop();
      return;
    }
    double mix(double a, double b) => a + (b - a) * _follow;
    var next = Rect.fromLTRB(
      mix(cur.left, target.left),
      mix(cur.top, target.top),
      mix(cur.right, target.right),
      mix(cur.bottom, target.bottom),
    );
    final close =
        (next.left - target.left).abs() < _snap &&
        (next.top - target.top).abs() < _snap &&
        (next.right - target.right).abs() < _snap &&
        (next.bottom - target.bottom).abs() < _snap;
    if (close) next = target; // 吸附上去
    _current = next;
    _send(next);
    if (close) _ticker?.stop();
  }

  /// 发一发 setBounds。
  /// 上一发还没落地就跳过 —— 堆起来只会抖，不会更快。
  void _send(Rect r) {
    if (_sending) return;
    final now = SchedulerBinding.instance.currentFrameTimeStamp;
    final last = _lastSendAt;
    if (last != null && now - last < _minSendGap) {
      // 还太密 —— 这一帧不发。Ticker 还在跑，_current/_target 一直在更新，
      // 下一次 tick 会带着**最新的**位置发出去（所以不会积压、不会落后）
      return;
    }
    _lastSendAt = now;
    // 尺寸几乎没变就别发 —— 每次 setBounds 都是一次平台往返 + 一次整窗重建，
    // 亚像素级别的抖动不值得那个代价（在窗口缩放这种高频路径上尤其）
    final prev = _lastBounds;
    if (prev != null &&
        (r.left - prev.left).abs() < 0.5 &&
        (r.top - prev.top).abs() < 0.5 &&
        (r.width - prev.width).abs() < 0.5 &&
        (r.height - prev.height).abs() < 0.5) {
      return;
    }
    _sending = true;
    // ★ 补偿量必须跟着"**真的发出去**的那个矩形"走，不能跟着目标走。
    //   插值意味着窗口要几帧才走到目标；如果拿目标去补偿，补偿就超前了 ——
    //   窗口飞过头 → 下一帧误差反向 → **震荡**（用户报的"震荡特别明显"）。
    //   跳过发送时不更新（那一次窗口根本没动）。
    _lastBounds = r;
    unawaited(
      windowManager.setBounds(r).whenComplete(() {
        _sending = false;
      }),
    );
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
  /// 降级渲染的"静默期"定时器。
  ///
  /// ★ 这里踩过一个坑：以前是"Ticker 停下来就恢复渲染"。但插值在拖动过程中
  ///   会不停收敛（命中吸附就 stop）—— 于是每收敛一次骨架就恢复成内容、
  ///   你再动一下又变骨架，**内容 ↔ 骨架 反复闪**（用户报的"快速大幅度拖动
  ///   会一直闪"）。
  ///   所以这个状态必须由**手势**驱动：拖动开始置位，每次拖动续期，
  ///   松手（或 220ms 没有新的拖动事件）之后才恢复。
  Timer? _resizeQuiet;

  void _markResizing() {
    if (!appResizing.value) appResizing.value = true;
    _resizeQuiet?.cancel();
    _resizeQuiet = Timer(const Duration(milliseconds: 220), () {
      if (mounted) appResizing.value = false;
    });
  }

  /// 读当前显示器的可用区（拿不到就返回 null —— 那就退回"不夹"的老行为）
  Future<Rect?> _readWorkArea() async {
    try {
      final d = await ScreenRetriever.instance.getPrimaryDisplay();
      final pos = d.visiblePosition;
      final size = d.visibleSize ?? d.size;
      if (pos == null || size.width <= 0 || size.height <= 0) return null;
      return Rect.fromLTWH(pos.dx, pos.dy, size.width, size.height);
    } catch (_) {
      return null;
    }
  }

  /// 松手：清掉间隔闸（让最后落点立刻生效）+ 结束降级渲染
  void _endDrag() {
    _lastSendAt = null;
    _resizeQuiet?.cancel();
    _resizeQuiet = Timer(const Duration(milliseconds: 140), () {
      if (mounted) appResizing.value = false;
    });
  }

  Future<void> _beginDrag(ResizeEdge edge, DragStartDetails d) async {
    _edge = edge;
    _startPointer = d.globalPosition;
    _lastBounds = null;
    _lastSendAt = null;
    _markResizing();
    try {
      _startBounds = await windowManager.getBounds();
      _lastBounds = _startBounds;
      // 插值的起点/目标都设成当前值，免得第一帧从 (0,0) 飞过去
      _current = _startBounds;
      _target = _startBounds;
      _workArea = await _readWorkArea();
    } catch (_) {
      _startBounds = null; // 拿不到就不拖，别乱跳
    }
  }

  void _dragTo(DragUpdateDetails d) {
    final start = _startBounds;
    final from = _startPointer;
    final edge = _edge;
    if (start == null || from == null || edge == null) return;
    var next = resizeBy(
      start: start,
      // 用补偿过的位移：窗口自己移动了多少要加回去，否则拖上/左边会抽搐
      delta: screenDelta(
        viewDelta: d.globalPosition - from,
        startBounds: start,
        lastBounds: _lastBounds ?? start,
      ),
      edge: edge,
      minSize: kWindowMinSize,
    );
    // ★ 夹在当前屏内：不跨屏就不会触发系统的 DPI 重缩放
    //   （用户原话："程序内的不可以乱动"）。
    final area = _workArea;
    if (area != null) {
      next = clampToWorkArea(
        rect: next,
        workArea: area,
        minSize: kWindowMinSize,
      );
    }
    // ★ 只更新**目标**，不直接 setBounds。
    //   由 Ticker 每帧朝目标插值着走 —— 这样窗口是被"牵引"过去的，
    //   而不是每来一个指针事件就硬跳一次（那才是"波动很大"的来源）。
    _target = next;
    _markResizing(); // 降级渲染（每次拖动都续期，不会来回闪）
    if (_ticker?.isActive != true) _ticker?.start();
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
          onPanEnd: (_) => _endDrag(),
          onPanCancel: _endDrag,
        ),
      ),
    );
  }
}
