import 'package:flutter/material.dart';

/// 中性表面和文字不随 Bot 的个性色变化。
abstract final class PBNeutral {
  static const bgApp = Color(0xFF101012);
  static const bgPane = Color(0xFF161618);
  static const bgElevated = Color(0xFF1E1E21);
  static const bgBubble = Color(0xFF212124);
  static const bgHover = Color(0xFF29292D);
  static const bgActive = Color(0xFF313136);
  static const bgInput = Color(0xFF212124);
  static const textPrimary = Color(0xFFF4F3F6);
  static const textSecondary = Color(0xFFCAC8CF);
  static const textTertiary = Color(0xFFB6B3BD);
  static const textQuaternary = Color(0xFFA3A0AB);
  static const quoteBorder = Color(0xFF57555E);
  static const quoteBackground = Color(0xFF252529);
  static const quoteText = Color(0xFFE6E4EB);

  // ---- 浅色
  //
  // 背景用略带蓝的灰白（纯白长时间阅读偏刺眼）；
  // 层级越"高"越白，靠 1-2%% 的明度差区分，不靠阴影堆叠。
  // 浅色不是深色的反相，而是一套独立的配色。
  //
  // 思路：背景带一点冷蓝的色相（不是中性灰），这样和主控的强调色
  // 是同一族的、不打架；气泡用接近纯白，靠明度差 + 边框浮起来。
  // 太灰会显得脏，太白会刺眼 —— 取中间那个"纸上带一点天光"的感觉。
  static const lightBgApp = Color(0xFFE8EDF7);
  static const lightBgPane = Color(0xFFF2F5FB);
  static const lightBgElevated = Color(0xFFFFFFFF);
  static const lightBgBubble = Color(0xFFFFFFFF);
  static const lightBgHover = Color(0xFFDEE5F2);
  static const lightBgActive = Color(0xFFCFD9EC);
  static const lightBgInput = Color(0xFFEDF1F9);
  static const lightTextPrimary = Color(0xFF16171A);
  static const lightTextSecondary = Color(0xFF474A52);
  static const lightTextTertiary = Color(0xFF62656E);
  static const lightTextQuaternary = Color(0xFF7C7F89);
  static const lightQuoteBorder = Color(0xFFC9CDD4);
  static const lightQuoteBackground = Color(0xFFF0F2F5);
  static const lightQuoteText = Color(0xFF3A3D45);
}

/// 从种子色生成语义颜色；实心面配白字，链接在最高亮度的中性底上可读。
@immutable
class PBThemeColors extends ThemeExtension<PBThemeColors> {
  const PBThemeColors({
    required this.accent,
    required this.accentBright,
    required this.accentHover,
    required this.accentSoft,
    required this.userBubbleTop,
    required this.userBubbleBottom,
    required this.onAccent,
    required this.link,
    required this.quoteBorder,
    required this.quoteBackground,
    required this.quoteText,
  });

  factory PBThemeColors.derive(Color seed) {
    final opaque = seed.withAlpha(255);
    final fill = _contrastColor(
      opaque,
      Colors.white,
      lighter: false,
      minimum: 5.1,
    );
    final soft = opaque.withValues(alpha: 0.14);
    final tintedSurface = Color.alphaBlend(soft, PBNeutral.bgActive);
    final linkSurface =
        tintedSurface.computeLuminance() > PBNeutral.bgActive.computeLuminance()
        ? tintedSurface
        : PBNeutral.bgActive;
    final bright = _contrastColor(opaque, linkSurface, lighter: true);
    return PBThemeColors(
      accent: fill,
      accentBright: bright,
      accentHover: _darken(fill, 0.045),
      accentSoft: soft,
      userBubbleTop: fill,
      userBubbleBottom: _darken(fill, 0.045),
      onAccent: Colors.white,
      link: bright,
      quoteBorder: PBNeutral.quoteBorder,
      quoteBackground: PBNeutral.quoteBackground,
      quoteText: PBNeutral.quoteText,
    );
  }

  final Color accent;
  final Color accentBright;
  final Color accentHover;
  final Color accentSoft;
  final Color userBubbleTop;
  final Color userBubbleBottom;
  final Color onAccent;
  final Color link;
  final Color quoteBorder;
  final Color quoteBackground;
  final Color quoteText;

  @override
  PBThemeColors copyWith({
    Color? accent,
    Color? accentBright,
    Color? accentHover,
    Color? accentSoft,
    Color? userBubbleTop,
    Color? userBubbleBottom,
    Color? onAccent,
    Color? link,
    Color? quoteBorder,
    Color? quoteBackground,
    Color? quoteText,
  }) => PBThemeColors(
    accent: accent ?? this.accent,
    accentBright: accentBright ?? this.accentBright,
    accentHover: accentHover ?? this.accentHover,
    accentSoft: accentSoft ?? this.accentSoft,
    userBubbleTop: userBubbleTop ?? this.userBubbleTop,
    userBubbleBottom: userBubbleBottom ?? this.userBubbleBottom,
    onAccent: onAccent ?? this.onAccent,
    link: link ?? this.link,
    quoteBorder: quoteBorder ?? this.quoteBorder,
    quoteBackground: quoteBackground ?? this.quoteBackground,
    quoteText: quoteText ?? this.quoteText,
  );

  @override
  PBThemeColors lerp(covariant PBThemeColors? other, double t) {
    if (other == null) return this;
    return PBThemeColors(
      accent: Color.lerp(accent, other.accent, t)!,
      accentBright: Color.lerp(accentBright, other.accentBright, t)!,
      accentHover: Color.lerp(accentHover, other.accentHover, t)!,
      accentSoft: Color.lerp(accentSoft, other.accentSoft, t)!,
      userBubbleTop: Color.lerp(userBubbleTop, other.userBubbleTop, t)!,
      userBubbleBottom: Color.lerp(
        userBubbleBottom,
        other.userBubbleBottom,
        t,
      )!,
      onAccent: Color.lerp(onAccent, other.onAccent, t)!,
      link: Color.lerp(link, other.link, t)!,
      quoteBorder: Color.lerp(quoteBorder, other.quoteBorder, t)!,
      quoteBackground: Color.lerp(quoteBackground, other.quoteBackground, t)!,
      quoteText: Color.lerp(quoteText, other.quoteText, t)!,
    );
  }
}

double _contrast(Color a, Color b) {
  final left = a.computeLuminance();
  final right = b.computeLuminance();
  return (left > right ? left + 0.05 : right + 0.05) /
      (left > right ? right + 0.05 : left + 0.05);
}

/// 沿固定色相、饱和度调整亮度，预留文本混色和像素量化余量。
Color _contrastColor(
  Color source,
  Color background, {
  required bool lighter,
  double minimum = 4.8,
}) {
  if (_contrast(source, background) >= minimum) return source;
  final hsl = HSLColor.fromColor(source);
  var lower = lighter ? hsl.lightness : 0.0;
  var upper = lighter ? 1.0 : hsl.lightness;
  for (var i = 0; i < 24; i++) {
    final middle = (lower + upper) / 2;
    final passes =
        _contrast(hsl.withLightness(middle).toColor(), background) >= minimum;
    if (passes == lighter) {
      upper = middle;
    } else {
      lower = middle;
    }
  }
  return hsl.withLightness(lighter ? upper : lower).toColor();
}

Color _darken(Color color, double amount) {
  final hsl = HSLColor.fromColor(color);
  return hsl.withLightness((hsl.lightness - amount).clamp(0.0, 1.0)).toColor();
}
