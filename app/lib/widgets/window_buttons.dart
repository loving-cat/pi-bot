import 'dart:async';

import 'package:flutter/material.dart';

import '../l10n/l10n.dart';
import '../theme.dart';
import '../window_actions.dart';
import '../window_chrome.dart';

enum _WindowGlyph { close, minimize, maximize, restore }

/// 角落中的轻量控制簇；品牌把手可拖动，其余按钮只执行各自动作。
class WindowButtons extends StatelessWidget {
  const WindowButtons({
    super.key,
    required this.controller,
    required this.platform,
  });

  final WindowActionsController controller;
  final TargetPlatform platform;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      final restoring = controller.maximized || controller.fullScreen;
      final strings = L10n.s(context);
      final minimize = _WindowButton(
        key: const ValueKey('window-minimize'),
        label: strings.t('window.minimize'),
        glyph: _WindowGlyph.minimize,
        enabled: !controller.busy && !controller.fullScreen,
        onPressed: () => unawaited(controller.minimize()),
      );
      final zoom = _WindowButton(
        key: const ValueKey('window-maximize'),
        label: controller.fullScreen
            ? strings.t('window.exitFullScreen')
            : (restoring
                  ? strings.t('window.restore')
                  : strings.t('window.maximize')),
        glyph: restoring ? _WindowGlyph.restore : _WindowGlyph.maximize,
        enabled: !controller.busy,
        onPressed: () => unawaited(controller.toggleMaximize()),
      );
      final close = _WindowButton(
        key: const ValueKey('window-close'),
        label: strings.t('window.close'),
        glyph: _WindowGlyph.close,
        danger: true,
        enabled: !controller.busy,
        onPressed: () => unawaited(controller.close()),
      );
      // 品牌把手：极简几何记号 + 可拖动区域。
      //
      // 不用文字/字母：这里只是"能拖的空白"，不是产品署名。
      // 用三颗渐次的圆点表示"正在流动"，颜色取当前主控色，换主题会跟着变。
      final accent = PB.colors(context).link;
      final grip = Semantics(
        label: strings.t('window.dragHint'),
        child: WindowDragArea(
          child: SizedBox(
            key: const ValueKey('window-brand-grip'),
            width: 24,
            height: 26,
            child: Center(
              child: ExcludeSemantics(
                child: CustomPaint(
                  size: const Size(13, 13),
                  painter: _GripDotsPainter(accent),
                ),
              ),
            ),
          ),
        ),
      );
      final buttons = platform == TargetPlatform.macOS
          ? [close, minimize, zoom, grip]
          : [grip, minimize, zoom, close];
      return Material(
        type: MaterialType.transparency,
        child: Semantics(
          container: true,
          liveRegion: controller.lastError != null,
          label: controller.lastError == null
              ? strings.t('window.controls')
              : strings.t('window.controlsFailed'),
          child: Container(
            key: const ValueKey('window-control-cluster'),
            width: 128,
            height: 28,
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
            decoration: BoxDecoration(
              color: PB.bgApp.withValues(alpha: .78),
              borderRadius: BorderRadius.circular(11),
              border: Border.all(
                color: controller.lastError == null
                    ? PB.borderTertiary
                    : PB.danger.withValues(alpha: .55),
                width: .6,
              ),
            ),
            child: Row(
              children: [
                for (var i = 0; i < buttons.length; i++) ...[
                  if (i > 0) const SizedBox(width: 4),
                  buttons[i],
                ],
              ],
            ),
          ),
        ),
      );
    },
  );
}

class _WindowButton extends StatefulWidget {
  const _WindowButton({
    super.key,
    required this.label,
    required this.glyph,
    required this.enabled,
    required this.onPressed,
    this.danger = false,
  });

  final String label;
  final _WindowGlyph glyph;
  final bool enabled;
  final VoidCallback onPressed;
  final bool danger;

  @override
  State<_WindowButton> createState() => _WindowButtonState();
}

class _WindowButtonState extends State<_WindowButton> {
  bool _hover = false;
  bool _focus = false;

  @override
  Widget build(BuildContext context) {
    final active = widget.enabled && (_hover || _focus);
    final tint = widget.danger ? PB.danger : PB.colors(context).link;
    final foreground = !widget.enabled
        ? PB.textQuaternary.withValues(alpha: .5)
        : active
        ? tint
        : PB.textSecondary;
    return Semantics(
      label: widget.label,
      button: true,
      enabled: widget.enabled,
      onTap: widget.enabled ? widget.onPressed : null,
      child: ExcludeSemantics(
        child: Material(
          color: active ? tint.withValues(alpha: .14) : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: widget.enabled ? widget.onPressed : null,
            onHover: (value) => setState(() => _hover = value),
            onFocusChange: (value) => setState(() => _focus = value),
            borderRadius: BorderRadius.circular(8),
            mouseCursor: SystemMouseCursors.basic,
            hoverColor: Colors.transparent,
            focusColor: Colors.transparent,
            highlightColor: tint.withValues(alpha: .2),
            splashFactory: NoSplash.splashFactory,
            child: SizedBox(
              width: 26,
              height: 26,
              child: Center(
                child: CustomPaint(
                  size: const Size(13, 13),
                  painter: _WindowGlyphPainter(widget.glyph, foreground),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 把手记号：三颗从大到小的圆，暗示"连着、可以推"。
///
/// 纯几何、不依赖字体字形 —— 换设备或字体缺失都不会渲染成空白。
class _GripDotsPainter extends CustomPainter {
  const _GripDotsPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color;
    final c = size.center(Offset.zero);
    // 三个点沿一条轻斜线排开，半径递减
    const offsets = [Offset(-3.6, 1.6), Offset(0, 0), Offset(3.6, -1.6)];
    const radii = [2.0, 1.6, 1.1];
    for (var i = 0; i < offsets.length; i++) {
      canvas.drawCircle(c + offsets[i], radii[i], paint);
    }
  }

  @override
  bool shouldRepaint(_GripDotsPainter oldDelegate) => color != oldDelegate.color;
}

class _WindowGlyphPainter extends CustomPainter {
  const _WindowGlyphPainter(this.glyph, this.color);

  final _WindowGlyph glyph;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.width / 13, size.height / 13);
    final pen = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.35
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    switch (glyph) {
      case _WindowGlyph.close:
        canvas.drawLine(const Offset(3.5, 3.5), const Offset(9.5, 9.5), pen);
        canvas.drawLine(const Offset(9.5, 3.5), const Offset(3.5, 9.5), pen);
      case _WindowGlyph.minimize:
        canvas.drawLine(const Offset(3, 8.5), const Offset(10, 8.5), pen);
      case _WindowGlyph.maximize:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(3, 3, 7, 7),
            const Radius.circular(1.5),
          ),
          pen,
        );
      case _WindowGlyph.restore:
        canvas.drawPath(
          Path()
            ..moveTo(4.5, 2.5)
            ..lineTo(10.5, 2.5)
            ..lineTo(10.5, 8.5),
          pen,
        );
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            const Rect.fromLTWH(2.5, 4.5, 6, 6),
            const Radius.circular(1.2),
          ),
          pen,
        );
    }
  }

  @override
  bool shouldRepaint(_WindowGlyphPainter oldDelegate) =>
      glyph != oldDelegate.glyph || color != oldDelegate.color;
}
