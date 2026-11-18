import 'package:flutter/material.dart';

import 'blob_avatar.dart';

/// 轻量级 Grok 风格思考流光：单层线性渐变 ShaderMask，零离屏模糊；
/// 停用或关闭全局动画时不创建控制器、零帧损耗。
class ThinkingShimmer extends StatefulWidget {
  const ThinkingShimmer({
    super.key,
    required this.child,
    this.enabled = true,
    this.baseColor,
    this.highlightColor,
  });

  final Widget child;
  final bool enabled;
  final Color? baseColor;
  final Color? highlightColor;

  @override
  State<ThinkingShimmer> createState() => _ThinkingShimmerState();
}

class _ThinkingShimmerState extends State<ThinkingShimmer>
    with SingleTickerProviderStateMixin {
  AnimationController? _controller;

  bool get _active => widget.enabled && BlobAvatar.animationsActive;

  @override
  void initState() {
    super.initState();
    _syncController();
  }

  @override
  void didUpdateWidget(ThinkingShimmer oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncController();
  }

  void _syncController() {
    if (!_active) {
      _controller?.stop();
      _controller?.dispose();
      _controller = null;
      return;
    }
    _controller ??= AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1600),
    )..repeat();
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) return widget.child;

    final onSurface =
        Theme.of(context).textTheme.bodyMedium?.color ?? Colors.white;
    final base = widget.baseColor ?? onSurface.withValues(alpha: 0.62);
    final highlight = widget.highlightColor ?? onSurface;

    return AnimatedBuilder(
      animation: controller,
      builder: (context, child) {
        final t = controller.value * 2.2 - 0.6;
        return ShaderMask(
          blendMode: BlendMode.srcIn,
          shaderCallback: (bounds) {
            return LinearGradient(
              begin: Alignment(t - 0.45, -0.15),
              end: Alignment(t + 0.45, 0.15),
              colors: [base, highlight, base],
              stops: const [0.0, 0.5, 1.0],
            ).createShader(bounds);
          },
          child: child,
        );
      },
      child: widget.child,
    );
  }
}
