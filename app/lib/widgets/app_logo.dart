import 'package:flutter/material.dart';

import '../theme.dart';

/// 应用图标（黑洞）。桌面标题栏、连接页、配对页统一用它。
///
/// 图标本身是方形的深空底，这里按圆角裁一下再配一圈很淡的外发光 ——
/// 深色界面上看起来像"浮着的一块"，不会糊进背景。
class AppLogo extends StatelessWidget {
  const AppLogo({
    super.key,
    this.size = 64,
    this.radius = 18,
    this.glow = true,
  });

  final double size;
  final double radius;
  final bool glow;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        boxShadow: glow
            ? [
                BoxShadow(
                  color: const Color(0xFFFF9A4A).withValues(alpha: 0.28),
                  blurRadius: size * 0.5,
                  spreadRadius: -size * 0.1,
                ),
              ]
            : null,
      ),
      clipBehavior: Clip.antiAlias,
      child: Image.asset(
        'assets/icon/app-icon-1024.png',
        fit: BoxFit.cover,
        filterQuality: FilterQuality.medium,
        // 图标是深色底：加载失败时也不要闪一块白
        errorBuilder: (_, __, ___) => Container(
          color: PB.bgBubble,
          alignment: Alignment.center,
          child: const Icon(Icons.circle, size: 10, color: PB.accent),
        ),
      ),
    );
  }
}
