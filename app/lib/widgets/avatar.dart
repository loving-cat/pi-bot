import 'package:flutter/material.dart';

import '../theme.dart';

/// 圆角方形头像 + 渐变底 + 白色字形 —— 照着 同类客户端 的 agent 头像做的。
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
  Widget build(BuildContext context) {
    final color = PB.colorFor(seed);
    final glyph = emoji != null && emoji!.isNotEmpty
        ? emoji!
        : (label.trim().isEmpty ? 'π' : label.trim().characters.first);

    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Container(
            width: size,
            height: size,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(size * 0.28),
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  Color.lerp(color, Colors.white, 0.18)!,
                  Color.lerp(color, Colors.black, 0.30)!,
                ],
              ),
            ),
            alignment: Alignment.center,
            child: Text(
              glyph,
              style: TextStyle(
                fontSize: size * (glyph.runes.length > 1 ? 0.5 : 0.46),
                fontWeight: FontWeight.w600,
                color: Colors.white,
                height: 1.0,
              ),
            ),
          ),
          if (badge != null)
            Positioned(
              right: -2,
              bottom: -2,
              child: Container(
                padding: const EdgeInsets.all(1.5),
                decoration: const BoxDecoration(
                  color: PB.bgApp,
                  shape: BoxShape.circle,
                ),
                child: badge,
              ),
            ),
        ],
      ),
    );
  }
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
