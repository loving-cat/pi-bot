import 'package:flutter/material.dart';

import 'theme.dart';

/// 全局动效 token。
///
/// 桌面端的体感要求和移动端不一样：鼠标 hover 必须**立刻**有反馈（>150ms 就觉得拖沓），
/// 但按下回弹可以稍微慢一点显得有分量。这套数字是照着「丝滑」调的：
/// 短时长 + easeOut（减速）进场 = 手感跟手，不会像线性动画那样发木。
class Motion {
  const Motion._();

  /// 按下反馈：必须极快，否则觉得"没点上"
  static const Duration instant = Duration(milliseconds: 70);

  /// hover / 小状态切换
  static const Duration fast = Duration(milliseconds: 130);

  /// 展开收起、卡片浮现
  static const Duration base = Duration(milliseconds: 200);

  /// 面板、页面切换
  static const Duration slow = Duration(milliseconds: 300);

  /// 消息入场
  static const Duration enter = Duration(milliseconds: 240);

  // ---- 曲线 ----
  /// 进场：先快后慢，最"顺"的一条
  static const Curve inC = Curves.easeOutCubic;

  /// 位移
  static const Curve move = Curves.easeInOutCubic;

  /// 通用 hover
  static const Curve hover = Curves.easeOut;

  /// 轻微过冲，给"弹出来"的东西（面板、头像选中）
  static const Curve pop = Curves.easeOutBack;
}

/// 把 [duration] 按系统「减弱动态效果」设置折半 —— 无障碍要求，也顺便省电。
Duration _respect(BuildContext context, Duration duration) {
  final reduce = MediaQuery.maybeOf(context)?.disableAnimations ?? false;
  return reduce ? Duration.zero : duration;
}

/// **hover + 按下** 二合一的交互容器 —— 全项目按钮的手感都从这里来。
///
/// ★ 性能关键：`child` 通过 [AnimatedBuilder] 的 `child` 参数传入，**只构建一次**。
///   每帧只重跑最外层的 `Transform.scale` + `DecoratedBox`，
///   不会像 `setState(() => _hover = true)` 那样把整棵子树重建一遍
///   （列表里每个 item 都这么干 = 直接掉到 20 帧）。
class HoverTap extends StatefulWidget {
  const HoverTap({
    super.key,
    required this.child,
    this.onTap,
    this.onLongPress,
    this.onSecondaryTap,
    this.enabled = true,
    this.cursor = SystemMouseCursors.click,
    this.borderRadius,
    this.baseColor,
    this.hoverColor,
    this.pressColor,
    this.pressScale = 0.975,
    this.duration,
    this.border,
  });

  final Widget child;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final VoidCallback? onSecondaryTap;
  final bool enabled;
  final MouseCursor cursor;
  final BorderRadius? borderRadius;

  /// 静止底色（null = 不画底，只做缩放反馈）
  final Color? baseColor;
  final Color? hoverColor;
  final Color? pressColor;

  /// 按下时缩到多少（1.0 = 不缩）
  final double pressScale;

  final Duration? duration;
  final BoxBorder? border;

  @override
  State<HoverTap> createState() => _HoverTapState();
}

class _HoverTapState extends State<HoverTap> with TickerProviderStateMixin {
  late final AnimationController _hoverC = AnimationController(
    vsync: this,
    duration: Motion.fast,
  );
  late final AnimationController _pressC = AnimationController(
    vsync: this,
    duration: Motion.instant,
  );
  late final Listenable _merged = Listenable.merge([_hoverC, _pressC]);

  @override
  void dispose() {
    _hoverC.dispose();
    _pressC.dispose();
    super.dispose();
  }

  bool get _interactive =>
      widget.enabled && (widget.onTap != null || widget.onLongPress != null);

  void _setHover(bool on) {
    if (!_interactive) return;
    _hoverC.animateTo(
      on ? 1 : 0,
      duration: _respect(context, widget.duration ?? Motion.fast),
      curve: Motion.hover,
    );
  }

  void _setPress(bool on) {
    if (!_interactive) return;
    _pressC.animateTo(
      on ? 1 : 0,
      duration: _respect(context, Motion.instant),
      curve: Motion.move,
    );
  }

  @override
  Widget build(BuildContext context) {
    final radius = widget.borderRadius ?? BorderRadius.circular(PB.rLg);

    return MouseRegion(
      cursor: widget.enabled ? widget.cursor : SystemMouseCursors.basic,
      onEnter: (_) => _setHover(true),
      onExit: (_) {
        _setHover(false);
        _setPress(false);
      },
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => _setPress(true),
        onTapUp: (_) => _setPress(false),
        onTapCancel: () => _setPress(false),
        onTap: widget.enabled ? widget.onTap : null,
        onLongPress: widget.enabled ? widget.onLongPress : null,
        onSecondaryTap: widget.enabled ? widget.onSecondaryTap : null,
        // ★ child 只构建一次；每帧只重算 Transform + 底色
        child: AnimatedBuilder(
          animation: _merged,
          child: widget.child,
          builder: (context, child) {
            final hover = Curves.easeOut.transform(_hoverC.value);
            final press = Curves.easeOut.transform(_pressC.value);

            Widget out = child!;

            if (widget.pressScale != 1.0 && press > 0) {
              final scale = 1 - (1 - widget.pressScale) * press;
              out = Transform.scale(scale: scale, child: out);
            }

            if (widget.baseColor != null || widget.hoverColor != null) {
              final base = widget.baseColor ?? Colors.transparent;
              final hoverCol = widget.hoverColor ?? base;
              final pressCol = widget.pressColor ?? hoverCol;
              final col = Color.lerp(
                Color.lerp(base, hoverCol, hover)!,
                pressCol,
                press,
              )!;
              out = DecoratedBox(
                decoration: BoxDecoration(
                  color: col,
                  borderRadius: radius,
                  border: widget.border,
                ),
                child: out,
              );
            }

            return out;
          },
        ),
      ),
    );
  }
}

/// 圆形图标按钮：hover 浮底 + 按下回弹。替代裸 `IconButton`（那个默认动画是 200ms 的
/// 水波纹，桌面端显得又慢又"糊"）。
class HoverIconButton extends StatelessWidget {
  const HoverIconButton({
    super.key,
    required this.icon,
    this.onTap,
    this.tooltip,
    this.size = 34,
    this.iconSize = 17,
    this.color,
    this.hoverColor,
    this.danger = false,
    this.active = false,
    this.circle = true,
  });

  final IconData icon;
  final VoidCallback? onTap;
  final String? tooltip;
  final double size;
  final double iconSize;
  final Color? color;
  final Color? hoverColor;
  final bool danger;
  final bool active;
  final bool circle;

  @override
  Widget build(BuildContext context) {
    final fg = color ?? (danger ? PB.danger : PB.textSecondary);
    final hoverBg =
        hoverColor ?? (danger ? const Color(0x22FB4B58) : PB.bgHover);
    final base = active ? PB.bgActive : Colors.transparent;

    Widget btn = HoverTap(
      onTap: onTap,
      enabled: onTap != null,
      pressScale: 0.9,
      baseColor: base,
      hoverColor: hoverBg,
      borderRadius: BorderRadius.circular(circle ? PB.rFull : PB.rLg),
      child: SizedBox(
        width: size,
        height: size,
        child: Center(
          child: Icon(icon, size: iconSize, color: fg),
        ),
      ),
    );

    if (tooltip != null) {
      btn = Tooltip(
        message: tooltip!,
        waitDuration: const Duration(milliseconds: 550),
        child: btn,
      );
    }
    return btn;
  }
}

/// 列表项入场：淡入 + 轻微上移。用在会话列表和消息列表的第一屏。
///
/// [index] 用来做 stagger（错开 22ms），超过 8 项就不再延迟 —— 否则长列表
/// 滚到底部的项要等半天才出现。
class FadeSlideIn extends StatefulWidget {
  const FadeSlideIn({
    super.key,
    required this.child,
    this.index = 0,
    this.offset = 10,
    this.enabled = true,
  });

  final Widget child;
  final int index;
  final double offset;
  final bool enabled;

  @override
  State<FadeSlideIn> createState() => _FadeSlideInState();
}

class _FadeSlideInState extends State<FadeSlideIn>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: Motion.enter,
  );

  @override
  void initState() {
    super.initState();
    if (!widget.enabled) {
      _c.value = 1;
      return;
    }
    final delay = Duration(milliseconds: 22 * (widget.index.clamp(0, 8)));
    Future<void>.delayed(delay, () {
      if (mounted) _c.forward();
    });
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.enabled) return widget.child;
    return AnimatedBuilder(
      animation: _c,
      child: widget.child,
      builder: (context, child) {
        final t = Motion.inC.transform(_c.value);
        return Opacity(
          opacity: t,
          child: Transform.translate(
            offset: Offset(0, widget.offset * (1 - t)),
            child: child,
          ),
        );
      },
    );
  }
}

/// 数字/尺寸变化的平滑过渡（用于"3 人 → 4 人"这类文案切换时的轻微弹动）
class PopIn extends StatefulWidget {
  const PopIn({super.key, required this.child, this.scale = 0.94});

  final Widget child;
  final double scale;

  @override
  State<PopIn> createState() => _PopInState();
}

class _PopInState extends State<PopIn> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: Motion.base,
  )..forward();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      child: widget.child,
      builder: (context, child) {
        final t = Motion.pop.transform(_c.value.clamp(0.0, 1.0));
        return Transform.scale(
          scale: widget.scale + (1 - widget.scale) * t,
          child: child,
        );
      },
    );
  }
}

/// 从右侧滑入的面板容器（不遮住整屏，左边留 scrim 可点关闭）。
///
/// 用 [SlideTransition] + [FadeTransition]，两者都是 GPU 合成层，不触发重排。
class SlideInPanel extends StatelessWidget {
  const SlideInPanel({
    super.key,
    required this.open,
    required this.child,
    required this.width,
    this.onClose,
  });

  final bool open;
  final Widget child;
  final double width;
  final VoidCallback? onClose;

  @override
  Widget build(BuildContext context) {
    final d = _respect(context, Motion.slow);

    return IgnorePointer(
      ignoring: !open,
      child: Stack(
        children: [
          // scrim：点一下关掉（只淡入淡出，不参与滑动）
          Positioned.fill(
            child: IgnorePointer(
              ignoring: !open,
              child: AnimatedOpacity(
                opacity: open ? 1 : 0,
                duration: d,
                curve: Motion.hover,
                child: GestureDetector(
                  onTap: onClose,
                  child: Container(color: Colors.black.withValues(alpha: 0.42)),
                ),
              ),
            ),
          ),
          // 面板本体：横向滑动，纯 GPU 合成层，不触发重排
          Align(
            alignment: Alignment.centerRight,
            child: AnimatedSlide(
              offset: open ? Offset.zero : const Offset(1, 0),
              duration: d,
              curve: Motion.inC,
              child: SizedBox(width: width, child: child),
            ),
          ),
        ],
      ),
    );
  }
}
