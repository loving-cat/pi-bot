import 'dart:io';

/// 更新检查的**纯逻辑**部分：解析服务端返回、判断是否值得提示。
///
/// 单独拆出来的原因：这部分全是"数据进、结论出"，能直接单测；
/// 弹窗、下载这些带副作用的动作放在 `update_prompt.dart` 里。
class UpdateInfo {
  const UpdateInfo({
    required this.ok,
    required this.update,
    required this.current,
    required this.latest,
    this.reason = '',
    this.notes = '',
    this.pageUrl = '',
    this.assetUrl = '',
    this.assetName = '',
    this.assetSize = 0,
  });

  /// 服务端这次检查本身是否成功（网络挂了 → false，但不是"没有更新"）
  final bool ok;

  /// 是否真的有新版本
  final bool update;

  final String current;
  final String latest;

  /// 服务端给的原因（没有更新时的说明 / 失败原因）
  final String reason;

  /// 更新说明（可能是 Markdown）
  final String notes;

  /// 发布页（没有直接下载包时给用户一个去处）
  final String pageUrl;

  /// 直链下载地址（服务端按平台挑好的，可能为空）
  final String assetUrl;
  final String assetName;
  final int assetSize;

  /// 能不能直接下载（没有直链就只能打开发布页）
  bool get canDownload => assetUrl.isNotEmpty;

  /// 版本号里"有没有内容的更新说明"
  bool get hasNotes => notes.trim().isNotEmpty;

  /// 人类可读的体积
  String get sizeLabel {
    if (assetSize <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    var size = assetSize.toDouble();
    var unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit++;
    }
    final text = unit == 0 ? size.toStringAsFixed(0) : size.toStringAsFixed(1);
    return '$text ${units[unit]}';
  }

  /// 从服务端 `/api/update` 的响应构造。
  factory UpdateInfo.fromJson(Map<String, dynamic> json) {
    final assets = (json['assets'] as List?) ?? const [];
    final recommended = json['recommended'] as Map?;
    // 服务端会直接给 recommended；没给就从 assets 里挑第一个有 url 的
    String url = '${recommended?['url'] ?? ''}';
    String name = '${recommended?['name'] ?? ''}';
    int size = (recommended?['size'] as num?)?.toInt() ?? 0;
    if (url.isEmpty) {
      for (final a in assets) {
        if (a is Map && '${a['url'] ?? ''}'.isNotEmpty) {
          url = '${a['url']}';
          name = '${a['name'] ?? ''}';
          size = (a['size'] as num?)?.toInt() ?? 0;
          break;
        }
      }
    }
    return UpdateInfo(
      ok: json['ok'] == true,
      update: json['update'] == true,
      current: '${json['current'] ?? ''}',
      latest: '${json['latest'] ?? ''}',
      reason: '${json['reason'] ?? ''}',
      notes: '${json['notes'] ?? ''}',
      pageUrl: '${json['pageUrl'] ?? ''}',
      assetUrl: url,
      assetName: name,
      assetSize: size,
    );
  }

  /// 请求时告诉服务端我们在哪个平台（它据此挑下载包）
  static String get platformParam {
    if (Platform.isWindows) return 'win32';
    if (Platform.isMacOS) return 'darwin';
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    if (Platform.isLinux) return 'linux';
    return 'unknown';
  }
}

/// 该不该弹窗提示。
///
/// 规则：
///   · 检查本身失败 → 不弹（不打扰用户干活）；
///   · 没有新版本 → 不弹；
///   · 这个版本已经提示过（用户点了"以后再说"）→ 不弹，
///     除非出现了**更新**的版本（用户拒绝的是 1.2.0，1.3.0 出来还要问）。
bool shouldPromptUpdate(UpdateInfo info, String? dismissedVersion) {
  if (!info.ok || !info.update) return false;
  if (info.latest.isEmpty) return false;
  return dismissedVersion != info.latest;
}
