/// 桌面栏宽分配：压缩偏好宽度，空间不足时将已打开的右栏并排浮层展示。
library;

import 'dart:math' as math;

const paneDividerWidth = 6.0;
const paneLeftMin = 240.0;
const paneLeftMax = 480.0;
const paneChatMin = 420.0;
const paneCompactChatMin = 300.0;
const panePanelMin = 280.0;
const panePanelMax = 560.0;
const paneBrowserMin = 360.0;
const paneBrowserMax = 900.0;

class DesktopPaneLayout {
  const DesktopPaneLayout({
    required this.leftWidth,
    this.chatMinimum = paneChatMin,
    this.panelWidth = 0,
    this.browserWidth = 0,
    this.overlayPanelWidth = 0,
    this.overlayBrowserWidth = 0,
  });

  final double leftWidth;
  final double chatMinimum;
  final double panelWidth;
  final double browserWidth;
  final double overlayPanelWidth;
  final double overlayBrowserWidth;

  bool get panelVisible => panelWidth > 0 || overlayPanelWidth > 0;
  bool get browserVisible => browserWidth > 0 || overlayBrowserWidth > 0;
  bool get hasOverlay => overlayPanelWidth > 0 || overlayBrowserWidth > 0;
  bool get pairedOverlay => overlayPanelWidth > 0 && overlayBrowserWidth > 0;
  double get overlayWidth =>
      overlayPanelWidth +
      overlayBrowserWidth +
      (pairedOverlay ? paneDividerWidth : 0);
  double get separators =>
      paneDividerWidth *
      (1 + (panelWidth > 0 ? 1 : 0) + (browserWidth > 0 ? 1 : 0));
}

double _preference(double value, double min, double max, double fallback) =>
    (value.isFinite ? value : fallback).clamp(min, max);

({double panel, double browser}) _rightWidths({
  required double available,
  required double panelMin,
  required double browserMin,
  required double panelPreference,
  required double browserPreference,
}) {
  final minimum = panelMin + browserMin;
  if (minimum == 0) return (panel: 0, browser: 0);
  if (available < minimum) {
    final ratio = math.max(0.0, available) / minimum;
    return (panel: panelMin * ratio, browser: browserMin * ratio);
  }
  final panelExtra = panelPreference - panelMin;
  final browserExtra = browserPreference - browserMin;
  final requestedExtra = panelExtra + browserExtra;
  final extra = math.min(requestedExtra, available - minimum);
  final share = requestedExtra == 0 ? 0.0 : extra / requestedExtra;
  return (
    panel: panelMin + panelExtra * share,
    browser: browserMin + browserExtra * share,
  );
}

/// 所有已打开的右栏都保留；双右栏允许缩小聊天区，仍放不下时覆盖聊天并排显示。
/// 返回值仅用于渲染，不修改用户持久化的宽度偏好。
DesktopPaneLayout resolveDesktopPaneLayout({
  required double width,
  required bool panelOpen,
  required bool browserOpen,
  double leftPreference = 320,
  double panelPreference = 340,
  double browserPreference = 520,
}) {
  final total = width.isFinite ? math.max(0.0, width) : 0.0;
  final left = _preference(leftPreference, paneLeftMin, paneLeftMax, 320);
  final panel = panelOpen
      ? _preference(panelPreference, panePanelMin, panePanelMax, 340)
      : 0.0;
  final browser = browserOpen
      ? _preference(browserPreference, paneBrowserMin, paneBrowserMax, 520)
      : 0.0;
  final panelMin = panelOpen ? panePanelMin : 0.0;
  final browserMin = browserOpen ? paneBrowserMin : 0.0;
  final rightMin = panelMin + browserMin;
  final both = panelOpen && browserOpen;
  final separators =
      paneDividerWidth * (1 + (panelOpen ? 1 : 0) + (browserOpen ? 1 : 0));
  final minChat = both ? paneCompactChatMin : paneChatMin;

  if (rightMin > 0 && paneLeftMin + minChat + rightMin + separators > total) {
    final overlayDivider = both ? paneDividerWidth : 0.0;
    final available = math.max(0.0, total - 24 - overlayDivider);
    final widths = _rightWidths(
      available: available,
      panelMin: panelMin,
      browserMin: browserMin,
      panelPreference: panel,
      browserPreference: browser,
    );
    return DesktopPaneLayout(
      leftWidth: math.min(
        left,
        math.max(0.0, total - paneChatMin - paneDividerWidth),
      ),
      overlayPanelWidth: widths.panel,
      overlayBrowserWidth: widths.browser,
    );
  }

  final chatMinimum = both
      ? math.min(
          paneChatMin,
          math.max(minChat, total - paneLeftMin - rightMin - separators),
        )
      : paneChatMin;
  final actualLeft = math.min(
    left,
    math.max(0.0, total - chatMinimum - rightMin - separators),
  );
  final widths = _rightWidths(
    available: math.max(0.0, total - actualLeft - chatMinimum - separators),
    panelMin: panelMin,
    browserMin: browserMin,
    panelPreference: panel,
    browserPreference: browser,
  );
  return DesktopPaneLayout(
    leftWidth: actualLeft,
    chatMinimum: chatMinimum,
    panelWidth: widths.panel,
    browserWidth: widths.browser,
  );
}

/// 加入文件栏后仍能真实并排时才返回true；与正式栏宽分配共用同一预算。
bool canDisplayFileInline({
  required double width,
  required bool panelOpen,
  double leftPreference = 320,
  double panelPreference = 340,
  double browserPreference = 520,
}) {
  final layout = resolveDesktopPaneLayout(
    width: width,
    panelOpen: panelOpen,
    browserOpen: true,
    leftPreference: leftPreference,
    panelPreference: panelPreference,
    browserPreference: browserPreference,
  );
  return !layout.hasOverlay && layout.browserWidth >= paneBrowserMin;
}
