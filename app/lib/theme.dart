import 'package:flutter/material.dart';

import 'theme_colors.dart';
import 'theme_mode.dart';

export 'theme_mode.dart'
    show
        PBColorMode,
        isLightMode,
        loadColorMode,
        pbColorMode,
        saveColorMode;

export 'theme_colors.dart' show PBThemeColors;

/// 双栏布局和会话跳转共用的逻辑像素宽度阈值。
const double kTwoPaneMinWidth = 760;

/// 聊天内容列的左右最小留白（px）。
const double kChatSidePad = 12;

/// 聊天内容列居中排版的最大宽度；气泡在内容列内继续限制宽度。
const double kChatContentMax = 1180;

/// 窗口创建和边缘缩放共用的最小逻辑尺寸。
const Size kWindowMinSize = Size(760, 520);

class PB {
  // 中性背景与文字跟着明暗模式走；Bot 个性色只影响强调元素。
  //
  // ★ 这些从 const 改成了 getter，是为了让浅色模式能切换。
  //   815 处调用点（PB.bgApp 这种写法）一个字都不用改，
  //   只有原本写在 const 构造里的那 72 处要去掉外层 const。
  static Color get bgApp =>
      isLightMode ? PBNeutral.lightBgApp : PBNeutral.bgApp;
  static Color get bgPane =>
      isLightMode ? PBNeutral.lightBgPane : PBNeutral.bgPane;
  static Color get bgElevated =>
      isLightMode ? PBNeutral.lightBgElevated : PBNeutral.bgElevated;
  static Color get bgBubble =>
      isLightMode ? PBNeutral.lightBgBubble : PBNeutral.bgBubble;
  static Color get bgHover =>
      isLightMode ? PBNeutral.lightBgHover : PBNeutral.bgHover;
  static Color get bgActive =>
      isLightMode ? PBNeutral.lightBgActive : PBNeutral.bgActive;
  /// 文件卡片底。浅色纯白、深色比气泡亮一档 —— 两端都不跟内容抢视线。
  static Color get bgFileCard =>
      isLightMode ? PBNeutral.lightBgFileCard : PBNeutral.bgActive;
  static Color get bgInput =>
      isLightMode ? PBNeutral.lightBgInput : PBNeutral.bgInput;

  // 四级正文颜色在各自模式的常用中性面上均保持至少 4.5:1 的对比度。
  static Color get textPrimary =>
      isLightMode ? PBNeutral.lightTextPrimary : PBNeutral.textPrimary;
  static Color get textSecondary =>
      isLightMode ? PBNeutral.lightTextSecondary : PBNeutral.textSecondary;
  static Color get textTertiary =>
      isLightMode ? PBNeutral.lightTextTertiary : PBNeutral.textTertiary;
  static Color get textQuaternary =>
      isLightMode ? PBNeutral.lightTextQuaternary : PBNeutral.textQuaternary;

  static Color get quoteBorder =>
      isLightMode ? PBNeutral.lightQuoteBorder : PBNeutral.quoteBorder;
  static Color get quoteBackground =>
      isLightMode ? PBNeutral.lightQuoteBackground : PBNeutral.quoteBackground;
  static Color get quoteText =>
      isLightMode ? PBNeutral.lightQuoteText : PBNeutral.quoteText;
  static Color get link =>
      isLightMode ? const Color(0xFF1A6FD4) : const Color(0xFF77B4FF);

  // ---- 描边
  // ★ 边框必须跟着模式反转。
  //
  //   深色下用白色半透明（在深底上是"提亮"），浅色下必须换成深色半透明 ——
  //   白线画在浅灰背景上等于没有，气泡和卡片会失去轮廓。
  static Color get borderPrimary =>
      isLightMode ? const Color(0x2E1A1C21) : const Color(0x3DF2F2F2);
  static Color get borderSecondary =>
      isLightMode ? const Color(0x1F1A1C21) : const Color(0x1FF2F2F2);
  static Color get borderTertiary =>
      isLightMode ? const Color(0x141A1C21) : const Color(0x12F2F2F2);

  /// 气泡顶部那一道极淡的高光，让平面有厚度
  static Color get borderHighlight =>
      isLightMode ? const Color(0x0A000000) : const Color(0x0DFFFFFF);

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

  // 字号按标签、正文和标题的阅读层级取值。
  static const fsXxs = 10.0;
  static const fsXs = 11.0;
  static const fsSm = 12.0;
  static const fsBase = 13.0;
  static const fsLg = 14.0;
  static const fsXl = 16.0;
  static const fsXxl = 21.0;

  /// 中文正文和标题的字号增量，标签字号保持不变。
  static const cjkScale = 1.0;

  /// 工具说明等中英混排小字的可读字号。
  static const fsTinyCjk = 12.0;

  /// 新增图标须核对依赖字体字形；组件测试无法检测缺字。
  /// 代码使用系统已有的等宽字体，中文兜底与正文保持一致。
  static const monoFamily = 'JetBrains Mono';
  static const monoFallback = <String>[
    'Geist Mono',
    'IBM Plex Mono',
    'Cascadia Mono',
    'Consolas',
    'Menlo',
    'monospace',
    'Microsoft YaHei UI',
    'Microsoft YaHei',
    'PingFang SC',
    'Noto Sans CJK SC',
    'Noto Sans SC',
    'Source Han Sans SC',
  ];

  /// 正文的等宽样式（md_text 里代码块用）
  static TextStyle mono(TextStyle base) =>
      base.copyWith(fontFamily: monoFamily, fontFamilyFallback: monoFallback);

  /// 拉丁字母与中文均使用可变字体，保持相同字重层级。
  static const fontFamily = 'Inter';

  /// 中文字体族名（pubspec 里登记的就是这个名字）
  static const cjkFamily = 'NotoSansSC';

  static const fontFallback = <String>[
    // 随包中文字体优先，系统字体只作缺字兜底。
    cjkFamily,
    'Microsoft YaHei UI',
    'Microsoft YaHei',
    'PingFang SC',
    'Noto Sans CJK SC',
    'Noto Sans SC',
    'Source Han Sans SC',
    'sans-serif',
  ];

  /// Bot 头像保留独立的多色标识；灰色用于中性和未分类形象。
  static const palette = <Color>[
    Color(0xFF1E86FC), // blue   S97 L55
    Color(0xFF12C878), // green  S83 L43
    Color(0xFFFB3A9C), // pink   S96 L61
    Color(0xFF9B5CFF), // violet S100 L68
    Color(0xFF8C939B), // gray   S7  L58（刻意低饱和）
    Color(0xFF10C4AE), // teal   S85 L42
    Color(0xFFF94A80), // rose   S94 L63
    Color(0xFFF0901A), // amber  S88 L52
    Color(0xFFB87540), // brown  S48 L49
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

  static final _defaultColors = PBThemeColors.derive(accent);
  /// 浅色模式下也要有一份：derive 的链接色按底色算，不能拿深色那份复用。
  static final _defaultColorsLight = PBThemeColors.derive(accent, light: true);

  /// 从当前主题读取语义颜色，未挂主题时使用默认种子。
  static PBThemeColors colors(BuildContext context) =>
      Theme.of(context).extension<PBThemeColors>() ??
      (isLightMode ? _defaultColorsLight : _defaultColors);

  static ThemeData theme({Color? seed, bool light = false}) {
    final colors = PBThemeColors.derive(seed ?? accent, light: light);
    // colorScheme 必须跟着明暗走：输入框、按钮、弹窗用的是它，
    // 只改 PB.xxx 的话这些组件会停在旧配色上。
    final scheme = (light ? ColorScheme.light : ColorScheme.dark)(
      primary: colors.accent,
      onPrimary: colors.onAccent,
      secondary: colors.accent,
      onSecondary: colors.onAccent,
      surface: bgPane,
      onSurface: textPrimary,
      error: danger,
      onError: Colors.white,
      outline: borderSecondary,
    );

    final base = ThemeData(
      brightness: light ? Brightness.light : Brightness.dark,
      colorScheme: scheme,
      useMaterial3: true,
      fontFamily: fontFamily,
      fontFamilyFallback: fontFallback,
      extensions: [colors],
    );

    // 正文显式携带字体及回退列表，标题与正文按角色设置字距和行距。
    TextStyle t(
      double size,
      FontWeight weight, {
      double spacing = 0,
      double height = 1.4,
    }) => TextStyle(
      fontFamily: fontFamily,
      fontFamilyFallback: fontFallback,
      fontSize: size,
      fontWeight: weight,
      letterSpacing: spacing,
      height: height,
      color: textPrimary,
    );

    return base.copyWith(
      scaffoldBackgroundColor: bgApp,
      canvasColor: bgApp,
      // 所有平台统一使用无位移的淡入页面过渡。
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.windows: _FadePageTransitionsBuilder(),
          TargetPlatform.macOS: _FadePageTransitionsBuilder(),
          TargetPlatform.linux: _FadePageTransitionsBuilder(),
          TargetPlatform.android: _FadePageTransitionsBuilder(),
          TargetPlatform.iOS: _FadePageTransitionsBuilder(),
        },
      ),
      dividerColor: borderTertiary,
      // ★ 选区底色用**固定的中性高亮**，不跟主控色走。
      //
      //   原先用 colors.accentSoft（主控色 14%）。主控色换成蓝色之后，
      //   蓝色 14% 叠在深色背景上几乎和背景同色 —— 用户拖选半天
      //   看不到自己选中了哪一段。选区是"可见性"而非"品牌色"，
      //   所以这里用与主题无关的浅色，任何主控色下都够清楚。
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: colors.accentBright,
        selectionColor: const Color(0x668AA6FF),
        selectionHandleColor: colors.accentBright,
      ),
      splashFactory: InkSparkle.splashFactory,
      textTheme: base.textTheme.copyWith(
        displaySmall: t(28, FontWeight.w600, spacing: -0.6, height: 1.2),
        headlineSmall: t(22, FontWeight.w600, spacing: -0.4, height: 1.25),
        titleLarge: t(17, FontWeight.w600, spacing: -0.2, height: 1.3),
        titleMedium: t(15, FontWeight.w600, spacing: -0.1, height: 1.35),
        titleSmall: t(13.5, FontWeight.w600, spacing: -0.05),
        // 中文长段落保持宽松行距和有限字距。
        bodyLarge: t(15, FontWeight.w400, spacing: 0.12, height: 1.7),
        bodyMedium: t(fsBase, FontWeight.w400, spacing: 0.12, height: 1.7),
        bodySmall: t(fsSm, FontWeight.w400, spacing: 0.1, height: 1.65),
        labelLarge: t(fsBase, FontWeight.w500, spacing: 0.1),
        labelMedium: t(fsXs, FontWeight.w500, spacing: 0.2),
        labelSmall: t(fsXxs, FontWeight.w500, spacing: 0.3),
      ),
      appBarTheme: AppBarTheme(
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
          side: BorderSide(color: borderTertiary),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: bgElevated,
        surfaceTintColor: Colors.transparent,
        elevation: 24,
        shadowColor: Colors.black.withValues(alpha: 0.6),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(r3xl),
          side: BorderSide(color: borderSecondary),
        ),
        titleTextStyle: TextStyle(
          fontFamily: fontFamily,
          color: textPrimary,
          fontSize: fsLg,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.1,
        ),
        contentTextStyle: TextStyle(
          fontFamily: fontFamily,
          color: textSecondary,
          fontSize: fsSm,
          height: 1.55,
        ),
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: bgElevated,
        surfaceTintColor: Colors.transparent,
        modalBarrierColor: Color(0x99000000),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        backgroundColor: bgActive,
        contentTextStyle: TextStyle(
          fontFamily: fontFamily,
          color: textPrimary,
          fontSize: fsSm,
        ),
        behavior: SnackBarBehavior.floating,
        elevation: 8,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(rXl),
          side: BorderSide(color: borderSecondary),
        ),
        insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: bgInput,
        isDense: true,
        hintStyle: TextStyle(
          fontFamily: fontFamily,
          color: textQuaternary,
          fontSize: fsBase,
        ),
        labelStyle: TextStyle(
          fontFamily: fontFamily,
          color: textTertiary,
          fontSize: fsSm,
        ),
        floatingLabelStyle: TextStyle(
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
          borderSide: BorderSide(color: borderSecondary),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(rXl),
          borderSide: BorderSide(color: borderSecondary),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(rXl),
          borderSide: BorderSide(color: colors.accentBright, width: 1.4),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: colors.accent,
          foregroundColor: colors.onAccent,
          overlayColor: Colors.black.withValues(alpha: 0.12),
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
        color: bgElevated,
        surfaceTintColor: Colors.transparent,
        elevation: 16,
        shadowColor: Colors.black.withValues(alpha: 0.5),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(r2xl),
          side: BorderSide(color: borderSecondary),
        ),
        textStyle: TextStyle(
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
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: colors.accentBright,
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
          side: WidgetStatePropertyAll(
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
      listTileTheme: ListTileThemeData(
        iconColor: textTertiary,
        textColor: textPrimary,
        contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 2),
      ),
      tooltipTheme: TooltipThemeData(
        decoration: BoxDecoration(
          color: bgActive,
          borderRadius: BorderRadius.circular(rLg),
          border: Border.all(color: borderSecondary),
        ),
        textStyle: TextStyle(
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

/// 无位移、无缩放的淡入页面过渡。
class _FadePageTransitionsBuilder extends PageTransitionsBuilder {
  const _FadePageTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    // 进场用较快的 easeOut（推页面要跟手），出场交给下面的页面自己淡
    return FadeTransition(
      opacity: CurvedAnimation(parent: animation, curve: Curves.easeOut),
      child: child,
    );
  }
}
