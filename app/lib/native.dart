import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart';

/// 调用 Android 原生能力：常驻前台服务 + 电池优化白名单。
/// 桌面/iOS 上是 no-op。
class Native {
  static const _channel = MethodChannel('pibot/native');

  static bool get _isAndroid => !kIsWeb && Platform.isAndroid;

  /// 起常驻服务：唯一目的是别让系统把进程杀掉，
  /// 这样主 isolate 里的 WebSocket 才能一直收消息。
  static Future<void> startService() async {
    if (!_isAndroid) return;
    try {
      await _channel.invokeMethod('startService');
    } catch (_) {
      /* 桌面/测试环境没有这个 channel */
    }
  }

  static Future<void> stopService() async {
    if (!_isAndroid) return;
    try {
      await _channel.invokeMethod('stopService');
    } catch (_) {}
  }

  static Future<bool> isIgnoringBatteryOptimizations() async {
    if (!_isAndroid) return true;
    try {
      return await _channel.invokeMethod<bool>('isIgnoringBatteryOptimizations') ?? false;
    } catch (_) {
      return false;
    }
  }

  /// 国产 ROM 不加白名单的话，前台服务也会被清掉
  static Future<void> requestIgnoreBatteryOptimizations() async {
    if (!_isAndroid) return;
    try {
      await _channel.invokeMethod('requestIgnoreBatteryOptimizations');
    } catch (_) {}
  }
}
