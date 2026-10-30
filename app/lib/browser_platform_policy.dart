/// 内置浏览器栏的导航与 webview 策略。
///
/// ⚠️ 这里和 `html_preview_platform_policy.dart` 是**两套不同的东西**，不要混用：
///
/// | | 附件 HTML 预览 | 内置浏览器栏 |
/// |---|---|---|
/// | 用途 | 看 bot 生成的本地 HTML | 真的浏览网页 |
/// | 导航 | 只许 about:blank / srcdoc | 允许 http/https |
/// | Cookies | 关 | **开**（不然登录状态存不住，等于没用） |
/// | localStorage | 关 | **开**（同上） |
/// | incognito | 开（不落盘） | 关 |
///
/// 放开的只是「能浏览网页」必需的那几样；下面这些**始终关着**：
///   · file:// / content:// —— 网页不该能读本机文件
///   · JS bridge —— 网页拿不到 pi-bot 的接口
///   · window.open / 多窗口 —— 一律收进同一栏，不弹独立窗
///   · 定位、自动填充、密码保存、第三方 cookie
library;


import 'package:flutter/foundation.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

/// 内置浏览器只在桌面端提供（手机屏放不下侧栏，按需求不做）。
bool supportsBrowserPane(TargetPlatform platform) =>
    platform == TargetPlatform.macOS || platform == TargetPlatform.windows;

/// 内置浏览器能导航到的地址。只认 http/https，且必须有主机名。
bool allowBrowserNavigation(Uri? uri) {
  if (uri == null) return false;
  final scheme = uri.scheme.toLowerCase();
  if (scheme != 'http' && scheme != 'https') return false;
  return uri.host.isNotEmpty;
}

/// 点击栏内链接前的判断：能导航就留在栏里，其它交给外部处理（例如 mailto:）。
bool shouldLoadInPlace(Uri uri) => allowBrowserNavigation(uri);

/// 内置浏览器的 webview 设置。
///
/// [platform] 决定资源拦截的落地方式：macOS 用 ContentBlocker，
/// Windows 用 shouldInterceptRequest —— 和附件预览那边的处理一致，
/// 因为这两个平台的能力不一样，不能用同一招。
InAppWebViewSettings browserPaneSettings(TargetPlatform platform) =>
    InAppWebViewSettings(
      javaScriptEnabled: true,
      // ★ 不给网页 JS bridge：网页不能直接调 pi-bot 的接口
      javaScriptBridgeEnabled: false,
      // ★ 不落盘：浏览记录、缓存留在内存里，退出就没了
      incognito: true,
      cacheEnabled: true,
      // ★ 这两样必须开，否则所有需要登录的站点都用不了
      sharedCookiesEnabled: true,
      domStorageEnabled: true,
      databaseEnabled: true,
      // 第三方 cookie 不要（跟踪器）
      thirdPartyCookiesEnabled: false,
      useShouldOverrideUrlLoading: true,
      useShouldInterceptRequest: platform == TargetPlatform.windows,
      // 本地文件一律不给
      allowFileAccess: false,
      allowContentAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      // 不弹独立窗
      javaScriptCanOpenWindowsAutomatically: false,
      supportMultipleWindows: false,
      allowsLinkPreview: false,
      // 隐私项一律关
      geolocationEnabled: false,
      generalAutofillEnabled: false,
      passwordAutosaveEnabled: false,
      isInspectable: false,
      // 媒体要用户自己点才播
      mediaPlaybackRequiresUserGesture: true,
      transparentBackground: false,
      disableDefaultErrorPage: false,
      // 允许 https 页面加载 http 混合内容的行为交给系统默认（不主动放开）
      mixedContentMode: MixedContentMode.MIXED_CONTENT_COMPATIBILITY_MODE,
    );

/// Windows 上要拦掉的请求：非 http/https 一律不加载。
///
/// macOS 那边靠 ContentBlocker 拦 http 以外的 scheme；Windows 没有等价物，
/// 所以在 shouldInterceptRequest 里直接返回空响应。
bool shouldBlockBrowserRequest(Uri? uri) {
  if (uri == null) return true;
  final scheme = uri.scheme.toLowerCase();
  // about:/data: 是页面自身需要的，不拦
  if (scheme == 'about' || scheme == 'data' || scheme == 'blob') return false;
  return scheme != 'http' && scheme != 'https';
}

/// 这个地址要不要交给系统浏览器/邮件客户端处理（mailto:、tel: 等）。
bool isExternalScheme(Uri uri) {
  final scheme = uri.scheme.toLowerCase();
  return scheme == 'mailto' || scheme == 'tel' || scheme == 'sms' || scheme == 'magnet';
}
