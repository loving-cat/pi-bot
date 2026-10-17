import 'dart:convert';
import 'dart:ui';

/// 窗口位置/大小记忆。
///
/// 为什么要有：桌面端每次启动都回到 1180x760 居中，用户调好的大小和位置（尤其是
/// 双屏、副屏）每次都要重来一遍。这里把"上次的窗口"存下来，下次原样还原。
///
/// 纯函数放前面（encode / decode / clamp），便于单测；读写与窗口 API 在
/// main.dart 里接（window_manager + shared_preferences）。
class WindowBounds {
  const WindowBounds({required this.rect, this.maximized = false});

  final Rect rect;
  final bool maximized;
}

/// 最小可用尺寸：再小就什么都点不到了
const Size kMinWindowSize = Size(720, 480);

/// 至少要露出这么宽/高，否则视为"跑到屏幕外了"
const double kMinVisible = 120;

String encodeWindowBounds(WindowBounds bounds) => jsonEncode({
  'x': bounds.rect.left,
  'y': bounds.rect.top,
  'w': bounds.rect.width,
  'h': bounds.rect.height,
  'max': bounds.maximized,
});

WindowBounds? decodeWindowBounds(String? raw) {
  if (raw == null || raw.isEmpty) return null;
  try {
    final map = jsonDecode(raw);
    if (map is! Map) return null;
    final x = (map['x'] as num?)?.toDouble();
    final y = (map['y'] as num?)?.toDouble();
    final w = (map['w'] as num?)?.toDouble();
    final h = (map['h'] as num?)?.toDouble();
    if (x == null || y == null || w == null || h == null) return null;
    if (w < kMinWindowSize.width || h < kMinWindowSize.height) return null;
    return WindowBounds(
      rect: Rect.fromLTWH(x, y, w, h),
      maximized: map['max'] == true,
    );
  } catch (_) {
    return null;
  }
}

/// 把记忆里的窗口夹进当前可见区域。
///
/// 场景：外接屏拔了 / 分辨率变了 / 缩放改了 —— 上次的位置可能整个在屏幕外，
/// 直接还原会让窗口"消失"。规则：
///   · 尺寸不超过可见区域，不小于最小尺寸；
///   · 至少要露出 kMinVisible；
///   · 完全露不出来时居中。
Rect clampWindowRect(Rect desired, Rect visible) {
  final width = desired.width.clamp(
    kMinWindowSize.width,
    visible.width < kMinWindowSize.width ? visible.width : visible.width,
  );
  final height = desired.height.clamp(
    kMinWindowSize.height,
    visible.height < kMinWindowSize.height ? visible.height : visible.height,
  );

  var left = desired.left;
  var top = desired.top;

  // 右边/下边超出 → 拉回来
  if (left + width > visible.right) left = visible.right - width;
  if (top + height > visible.bottom) top = visible.bottom - height;
  // 左边/上边超出 → 贴边
  if (left < visible.left) left = visible.left;
  if (top < visible.top) top = visible.top;

  final rect = Rect.fromLTWH(left, top, width, height);
  final intersection = rect.intersect(visible);
  final visibleEnough =
      intersection.width >= kMinVisible && intersection.height >= kMinVisible;
  if (visibleEnough) return rect;

  // 完全/几乎看不见 → 居中
  return Rect.fromLTWH(
    visible.left + (visible.width - width) / 2,
    visible.top + (visible.height - height) / 2,
    width,
    height,
  );
}
