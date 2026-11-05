import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../theme.dart';

/// 明暗模式切换按钮：一圈渐变环 + 旋转的日月图标。
///
/// ## 为什么用自绘而不是 IconButton
///
/// 要做的是"点击时渐变环转动、图标从太阳变成月亮"。用现成按钮
/// 只能换图标颜色，做不出环的旋转和渐变收放。自绘一个
/// CustomPainter 反而代码更短，也能精确控制帧。
///
/// ## 帧率
///
/// AnimationController 跑 vsync 提供的刷新率（本机 60/120Hz），
/// 配合 RepaintBoundary 只重绘这一小块，不连累整个侧栏。
class ThemeToggleButton extends StatefulWidget {
  const ThemeToggleButton({super.key, this.size = 26});

  final double size;

  @override
  State<ThemeToggleButton> createState() => _ThemeToggleButtonState();
}

class _ThemeToggleButtonState extends State<ThemeToggleButton>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 520),
  );

  /// 0 = 深色，1 = 浅色。切换时在两者之间补间。
  late final Animation<double> _t = CurvedAnimation(
    parent: _c,
    curve: Curves.easeInOutCubic,
  );

  bool _hover = false;

  @override
  void initState() {
    super.initState();
    // 启动时如果已经是浅色，把动画直接放到终点，别播一遍
    _c.value = isLightMode ? 1 : 0;
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _toggle() async {
    final next = !isLightMode;
    // 存偏好和切模式一起做：动画立刻开始，不阻塞在磁盘上
    unawaited(saveColorMode(next ? PBColorMode.light : PBColorMode.dark));
    // 双向播放：深 -> 浅 正放，浅 -> 深 倒放。
    // 这样图标始终朝同一个方向转，不会"弹回去"。
    if (next) {
      await _c.forward();
    } else {
      await _c.reverse();
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    return Tooltip(
      message: isLightMode ? s.t('theme.toDark') : s.t('theme.toLight'),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          onTap: _toggle,
          behavior: HitTestBehavior.opaque,
          child: RepaintBoundary(
            child: AnimatedBuilder(
              animation: _t,
              builder: (context, _) {
                return SizedBox(
                  width: widget.size,
                  height: widget.size,
                  child: CustomPaint(
                    painter: _TogglePainter(
                      t: _t.value,
                      hover: _hover ? 1 : 0,
                      ringColor: isLightMode
                          ? const Color(0xFFF5A524)
                          : const Color(0xFF6C8CFF),
                      glowColor: isLightMode
                          ? const Color(0xFFFFC24D)
                          : const Color(0xFF3D5AFE),
                    ),
                    child: Center(
                      child: Transform.rotate(
                        // 转 180°：太阳转到背面就成了月亮，语义上刚好
                        angle: _t.value * math.pi,
                        child: Icon(
                          LucideIcons.sun,
                          size: widget.size * 0.52,
                          color: Color.lerp(
                            const Color(0xFFB8C4FF),
                            const Color(0xFFFFB020),
                            _t.value,
                          ),
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

class _TogglePainter extends CustomPainter {
  _TogglePainter({
    required this.t,
    required this.hover,
    required this.ringColor,
    required this.glowColor,
  });

  /// 0 = 深色，1 = 浅色
  final double t;
  final double hover;
  final Color ringColor;
  final Color glowColor;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.width / 2 - 1;

    // 渐变环：用 SweepGradient 让"转动"看得出来。
    // 起止角跟着 t 走 —— 切到浅色时环转半圈，视觉上和图标共同指向"换了"。
    final start = t * math.pi;
    final sweep = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..strokeCap = StrokeCap.round
      ..shader = SweepGradient(
        startAngle: start,
        endAngle: start + math.pi * 2,
        colors: [
          ringColor.withValues(alpha: 0.25 + hover * 0.25),
          ringColor.withValues(alpha: 0.95),
          ringColor.withValues(alpha: 0.25 + hover * 0.25),
        ],
        stops: const [0.0, 0.5, 1.0],
        transform: GradientRotation(start),
      ).createShader(Rect.fromCircle(center: center, radius: radius));

    // 环内的微光：深色时偏冷、浅色时偏暖，切换过程中颜色自然过渡
    final fill = Paint()
      ..style = PaintingStyle.fill
      ..shader = RadialGradient(
        colors: [
          glowColor.withValues(alpha: 0.10 + hover * 0.10),
          glowColor.withValues(alpha: 0.0),
        ],
      ).createShader(Rect.fromCircle(center: center, radius: radius));

    canvas.drawCircle(center, radius, fill);
    canvas.drawCircle(center, radius, sweep);
  }

  @override
  bool shouldRepaint(_TogglePainter old) =>
      old.t != t ||
      old.hover != hover ||
      old.ringColor != ringColor ||
      old.glowColor != glowColor;
}
