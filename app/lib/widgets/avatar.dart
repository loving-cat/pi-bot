import 'package:flutter/material.dart';

import '../theme.dart';
import 'blob_avatar.dart';

/// 兼容头像入口，使用统一角色绘制并保留可访问名称。
class BotAvatar extends StatelessWidget {
  const BotAvatar({
    super.key,
    required this.seed,
    required this.label,
    this.emoji,
    this.size = 44,
    this.badge,
  });

  /// 决定颜色的稳定 id
  final String seed;
  final String label;
  final String? emoji;
  final double size;
  final Widget? badge;

  @override
  Widget build(BuildContext context) => Semantics(
    label: label,
    image: true,
    child: BlobAvatar(
      seed: seed,
      color: PB.colorFor(seed),
      emoji: emoji,
      size: size,
      badge: badge,
      animate: false,
    ),
  );
}

/// 顶部/工具栏用的圆形图标按钮（截图里搜索、新建那两个）
class CircleIconButton extends StatelessWidget {
  const CircleIconButton({
    super.key,
    required this.icon,
    required this.onPressed,
    this.tooltip,
    this.filled = false,
  });

  final IconData icon;
  final VoidCallback? onPressed;
  final String? tooltip;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final button = Material(
      color: filled ? PB.accent : PB.bgHover,
      shape: const CircleBorder(),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onPressed,
        child: SizedBox(
          width: 36,
          height: 36,
          child: Icon(
            icon,
            size: 18,
            color: filled ? Colors.white : PB.textSecondary,
          ),
        ),
      ),
    );
    return tooltip == null ? button : Tooltip(message: tooltip!, child: button);
  }
}

/// 小圆点（未读 / 在线状态）
class Dot extends StatelessWidget {
  const Dot({super.key, required this.color, this.size = 8, this.glow = false});

  final Color color;
  final double size;
  final bool glow;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        boxShadow: glow
            ? [BoxShadow(color: color.withValues(alpha: 0.55), blurRadius: 6)]
            : null,
      ),
    );
  }
}
