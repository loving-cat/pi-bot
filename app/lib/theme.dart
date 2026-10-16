import 'package:flutter/material.dart';

/// pi-bot 设计系统。
///
/// 颜色/圆角/字号来自同类客户端的真实 token：
///   · 预先定好的色阶变量
///   · 逐点校准
/// 侧栏 #0E0E0E、聊天区 #121212、气泡 #1B1B1B、圆按钮 #1F1F1F、强调 #1E86FC。
/// 宽屏阈值：>= 这个宽度走左右分栏（微信 PC / 同类客户端 那种），否则单页导航。
/// 只在这里定义一次 —— HomeShell 和"跳会话"的逻辑必须用同一个数，
/// 不然会出现"宽屏下点了跳转却 push 出一个整页聊天"。
const double kTwoPaneMinWidth = 760;

/// 窗口最小尺寸（逻辑像素）。
/// main.dart 建窗口和 WindowResizeOverlay 自己算缩放都要用同一个数 ——
/// 两边写两份的话，拖到最小尺寸时窗口会抖（一边卡住一边还在缩）。
const Size kWindowMinSize = Size(760, 520);

class PB {
  // ---- 背景层次
  static const bgApp = Color(0xFF0E0E0E);
  static const bgPane = Color(0xFF121212);
  static const bgElevated = Color(0xFF1A1A1A);
  static const bgBubble = Color(0xFF1B1B1B);
  static const bgHover = Color(0xFF212121);
  static const bgActive = Color(0xFF282828);
  static const bgInput = Color(0xFF1B1B1B);

  // ---- 文字
  static const textPrimary = Color(0xFFF2F2F2);
  static const textSecondary = Color(0xB8F2F2F2);
  static const textTertiary = Color(0x8AF2F2F2);
  static const textQuaternary = Color(0x5CF2F2F2);

  // ---- 描边
  static const borderPrimary = Color(0x3DF2F2F2);
  static const borderSecondary = Color(0x1FF2F2F2);
  static const borderTertiary = Color(0x12F2F2F2);

  /// 气泡顶部那一道极淡的高光，让平面有厚度
  static const borderHighlight = Color(0x0DFFFFFF);

  // ---- 强调色
  static const accent = Color(0xFF2E8CF6);
  static const accentBright = Color(0xFF4D9BFF);
  static const accentHover = Color(0xFF126FD4);
  static const accentSoft = Color(0x1F2E8CF6);
  static const userBubbleTop = Color(0xFF2C86F0);
  static const userBubbleBottom = Color(0xFF1667C8);

  // ---- 状态色
  static const danger = Color(0xFFFB4B58);
  static const success = Color(0xFF22C878);
  static const warn = Color(0xFFF5A524);

  // ---- 圆角
  static const rSm = 4.0;
  static const rBase = 6.0;
  static const rLg = 8.0;
  static const rXl = 12.0;
  static const r2xl = 14.0;
  static const r3xl = 16.0;
  static const rBubble = 18.0;
  static const rFull = 999.0;

  // ---- 字号
  static const fsXxs = 11.0;
  static const fsXs = 12.0;
  static const fsSm = 13.0;
  static const fsBase = 14.0;
  static const fsLg = 15.0;
  static const fsXl = 17.0;
  static const fsXxl = 22.0;

  /// Latin 用 Inter，中文回落到系统字体（Inter 没有 CJK 字形）
  static const fontFamily = 'Inter';
  static const fontFallback = <String>[
    'Microsoft YaHei UI',
    'Microsoft YaHei',
    'PingFang SC',
    'Noto Sans CJK SC',
    'Noto Sans SC',
    'Source Han Sans SC',
    'sans-serif',
  ];

  static const palette = <Color>[
    Color(0xFF2E8CF6), // blue
    Color(0xFF22C878), // green
    Color(0xFFF9459B), // magenta
    Color(0xFF9A66FA), // purple
    Color(0xFFFD7A22), // orange
    Color(0xFF17BFA9), // cyan
    Color(0xFFFB4B58), // red
    Color(0xFFF5A524), // yellow
    Color(0xFFB07A45), // brown
  ];

  static Color colorFor(String id) {
    if (id.isEmpty) return palette.first;
    var hash = 0;
    for (final unit in id.codeUnits) {
      hash = (hash * 31 + unit) & 0x7fffffff;
    }
    return palette[hash % palette.length];
  }

  /// 气泡/卡片统一的柔和投影（暗色下要很轻，重了就脏）
  static List<BoxShadow> shadow({
    double y = 1,
    double blur = 3,
    double alpha = 0.28,
  }) => [
    BoxShadow(
      color: Colors.black.withValues(alpha: alpha),
      offset: Offset(0, y),
      blurRadius: blur,
    ),
  ];

  static List<BoxShadow> glow(
    Color color, {
    double blur = 12,
    double alpha = 0.35,
  }) => [
    BoxShadow(
      color: color.withValues(alpha: alpha),
      blurRadius: blur,
      spreadRadius: -2,
    ),
  ];

  static ThemeData theme() {
    const scheme = ColorScheme.dark(
      primary: accent,
      onPrimary: Colors.white,
      secondary: accent,
      surface: bgPane,
      onSurface: textPrimary,
      error: danger,
      onError: Colors.white,
      outline: borderSecondary,
    );

    final base = ThemeData(
      brightness: Brightness.dark,
      colorScheme: scheme,
      useMaterial3: true,
      fontFamily: fontFamily,
      fontFamilyFallback: fontFallback,
    );

    /// 统一字距：大标题收紧、正文略放，读起来更"贵"
    TextStyle t(
      double size,
      FontWeight weight, {
      double spacing = 0,
      double height = 1.4,
    }) => TextStyle(
      fontSize: size,
      fontWeight: weight,
      letterSpacing: spacing,
      height: height,
      color: textPrimary,
    );

    return base.copyWith(
      scaffoldBackgroundColor: bgApp,
      canvasColor: bgApp,
      dividerColor: borderTertiary,
      splashFactory: InkSparkle.splashFactory,
      textTheme: base.textTheme.copyWith(
        displaySmall: t(28, FontWeight.w600, spacing: -0.6, height: 1.2),
        headlineSmall: t(22, FontWeight.w600, spacing: -0.4, height: 1.25),
        titleLarge: t(17, FontWeight.w600, spacing: -0.2, height: 1.3),
        titleMedium: t(15, FontWeight.w600, spacing: -0.1, height: 1.35),
        titleSmall: t(13.5, FontWeight.w600, spacing: -0.05),
        bodyLarge: t(15, FontWeight.w400, spacing: 0.05, height: 1.5),
        bodyMedium: t(fsBase, FontWeight.w400, spacing: 0.05, height: 1.5),
        bodySmall: t(fsSm, FontWeight.w400, spacing: 0.05, height: 1.45),
        labelLarge: t(fsBase, FontWeight.w500, spacing: 0.1),
        labelMedium: t(fsXs, FontWeight.w500, spacing: 0.2),
        labelSmall: t(fsXxs, FontWeight.w500, spacing: 0.3),
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: bgApp,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontFamily: fontFamily,
          color: textPrimary,
          fontSize: fsLg,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.1,
        ),
        iconTheme: IconThemeData(color: textSecondary, size: 20),
      ),
      cardTheme: CardThemeData(
        color: bgElevated,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(r2xl),
          side: const BorderSide(color: borderTertiary),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: bgElevated,
        surfaceTintColor: Colors.transparent,
        elevation: 24,
        shadowColor: Colors.black.withValues(alpha: 0.6),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(r3xl),
          side: const BorderSide(color: borderSecondary),
        ),
        titleTextStyle: const TextStyle(
          fontFamily: fontFamily,
          color: textPrimary,
          fontSize: fsLg,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.1,
        ),
        contentTextStyle: const TextStyle(
          fontFamily: fontFamily,
          color: textSecondary,
          fontSize: fsSm,
          height: 1.55,
        ),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: bgElevated,
        surfaceTintColor: Colors.transparent,
        modalBarrierColor: Color(0x99000000),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: bgActive,
        contentTextStyle: const TextStyle(
          fontFamily: fontFamily,
          color: textPrimary,
          fontSize: fsSm,
        ),
        behavior: SnackBarBehavior.floating,
        elevation: 8,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(rXl),
          side: const BorderSide(color: borderSecondary),
        ),
        insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: bgInput,
        isDense: true,
        hintStyle: const TextStyle(
          fontFamily: fontFamily,
          color: textQuaternary,
          fontSize: fsBase,
        ),
        labelStyle: const TextStyle(
          fontFamily: fontFamily,
          color: textTertiary,
          fontSize: fsSm,
        ),
        floatingLabelStyle: const TextStyle(
          fontFamily: fontFamily,
          color: textSecondary,
          fontSize: fsSm,
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 14,
          vertical: 14,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(rXl),
          borderSide: const BorderSide(color: borderSecondary),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(rXl),
          borderSide: const BorderSide(color: borderSecondary),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(rXl),
          borderSide: const BorderSide(color: accent, width: 1.4),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: accent,
          foregroundColor: Colors.white,
          disabledBackgroundColor: bgActive,
          disabledForegroundColor: textQuaternary,
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
          textStyle: const TextStyle(
            fontFamily: fontFamily,
            fontSize: fsBase,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.1,
          ),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(rXl),
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: textSecondary,
          textStyle: const TextStyle(
            fontFamily: fontFamily,
            fontSize: fsSm,
            fontWeight: FontWeight.w500,
          ),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(rLg),
          ),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(foregroundColor: textSecondary),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: const Color(0xFF1D1D1D),
        surfaceTintColor: Colors.transparent,
        elevation: 16,
        shadowColor: Colors.black.withValues(alpha: 0.5),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(r2xl),
          side: const BorderSide(color: borderSecondary),
        ),
        textStyle: const TextStyle(
          fontFamily: fontFamily,
          color: textPrimary,
          fontSize: fsSm,
          fontWeight: FontWeight.w500,
        ),
      ),
      scrollbarTheme: ScrollbarThemeData(
        thickness: const WidgetStatePropertyAll(6),
        radius: const Radius.circular(3),
        thumbColor: WidgetStatePropertyAll(
          textQuaternary.withValues(alpha: 0.5),
        ),
        trackColor: const WidgetStatePropertyAll(Colors.transparent),
        crossAxisMargin: 2,
      ),
      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: accent,
        linearTrackColor: Colors.transparent,
        circularTrackColor: Colors.transparent,
      ),
      segmentedButtonTheme: SegmentedButtonThemeData(
        style: ButtonStyle(
          backgroundColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.selected)
                ? bgActive
                : Colors.transparent,
          ),
          foregroundColor: WidgetStateProperty.resolveWith(
            (states) => states.contains(WidgetState.selected)
                ? textPrimary
                : textTertiary,
          ),
          side: const WidgetStatePropertyAll(
            BorderSide(color: borderSecondary),
          ),
          textStyle: const WidgetStatePropertyAll(
            TextStyle(fontFamily: fontFamily, fontSize: fsSm),
          ),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(borderRadius: BorderRadius.circular(rXl)),
          ),
        ),
      ),
      listTileTheme: const ListTileThemeData(
        iconColor: textTertiary,
        textColor: textPrimary,
        contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 2),
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: const Color(0xFF262626),
          borderRadius: BorderRadius.circular(rLg),
          border: Border.all(color: borderSecondary),
        ),
        textStyle: const TextStyle(
          fontFamily: fontFamily,
          color: textPrimary,
          fontSize: fsXxs,
        ),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
        waitDuration: const Duration(milliseconds: 500),
      ),
    );
  }
}
