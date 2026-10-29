import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

/// 内部预览只承载宿主创建的空白页和隔离文档，不导航到网络或文件地址。
bool allowOfflineHtmlNavigation(Uri? uri) {
  if (uri == null || uri.scheme != 'about' || uri.hasAuthority) return false;
  if (uri.hasQuery) return false;
  return uri.path == 'blank' || uri.path == 'srcdoc';
}

/// 外部链接只供宿主确认后打开；拒绝凭据、非标准端口和明显的本机目标。
bool allowExternalHtmlLink(Uri uri) {
  if (uri.scheme != 'https' ||
      !uri.hasAuthority ||
      uri.userInfo.isNotEmpty ||
      uri.port != 443 ||
      uri.toString().length > 4096)
    return false;
  final host = uri.host.toLowerCase().replaceFirst(RegExp(r'\.$'), '');
  if (InternetAddress.tryParse(host) != null || !host.contains('.'))
    return false;
  if (RegExp(r'^[0-9.]+$').hasMatch(host)) return false;
  if (host
      .split('.')
      .any(
        (part) =>
            part.isEmpty ||
            part.length > 63 ||
            !RegExp(r'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$').hasMatch(part),
      ))
    return false;
  return ![
    'localhost',
    'local',
    'internal',
    'lan',
    'home',
    'test',
    'invalid',
  ].any((suffix) => host == suffix || host.endsWith('.$suffix'));
}

bool supportsOfflineHtmlPreview(TargetPlatform platform) =>
    platform == TargetPlatform.macOS || platform == TargetPlatform.windows;

/// 两端均使用临时存储；资源与导航分别阻断，不以主导航回调替代资源检查。
InAppWebViewSettings offlineHtmlSettings(TargetPlatform platform) =>
    InAppWebViewSettings(
      javaScriptEnabled: true,
      javaScriptBridgeEnabled: false,
      incognito: true,
      cacheEnabled: false,
      sharedCookiesEnabled: false,
      useShouldOverrideUrlLoading: true,
      useShouldInterceptRequest: platform == TargetPlatform.windows,
      contentBlockers: platform == TargetPlatform.macOS
          ? [
              for (final scheme in [
                'http',
                'https',
                'ws',
                'wss',
                'ftp',
                'file',
              ])
                ContentBlocker(
                  trigger: ContentBlockerTrigger(
                    urlFilter: '^$scheme:',
                    urlFilterIsCaseSensitive: false,
                  ),
                  action: ContentBlockerAction(
                    type: ContentBlockerActionType.BLOCK,
                  ),
                ),
            ]
          : [],
      allowFileAccess: false,
      allowContentAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      javaScriptCanOpenWindowsAutomatically: false,
      supportMultipleWindows: false,
      allowsLinkPreview: false,
      disableContextMenu: true,
      isInspectable: false,
      geolocationEnabled: false,
      databaseEnabled: false,
      domStorageEnabled: false,
      generalAutofillEnabled: false,
      passwordAutosaveEnabled: false,
      thirdPartyCookiesEnabled: false,
      mediaPlaybackRequiresUserGesture: true,
      transparentBackground: false,
      useOnDownloadStart: true,
      disableDefaultErrorPage: true,
    );
