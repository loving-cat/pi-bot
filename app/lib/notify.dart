import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// 本地通知：机器人干完活时推给你，不用一直盯着 App。
///
/// 不走 FCM（国内不稳），靠常驻前台服务保住 WebSocket，收到消息自己弹通知。
class Notifier {
  static final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  static bool _ready = false;
  static void Function(String? roomId)? onTap;

  static bool get _supported => !kIsWeb && (Platform.isAndroid || Platform.isIOS);

  static Future<void> init() async {
    if (_ready || !_supported) return;
    try {
      const android = AndroidInitializationSettings('@mipmap/ic_launcher');
      const ios = DarwinInitializationSettings();
      await _plugin.initialize(
        const InitializationSettings(android: android, iOS: ios),
        onDidReceiveNotificationResponse: (response) => onTap?.call(response.payload),
      );

      if (Platform.isAndroid) {
        final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
        await android?.requestNotificationsPermission();
      }
      _ready = true;
    } catch (_) {
      // 通知不可用不该影响主流程
    }
  }

  static Future<void> show({
    required String title,
    required String body,
    String? roomId,
  }) async {
    if (!_ready) await init();
    if (!_ready) return;
    try {
      await _plugin.show(
        roomId.hashCode & 0x7fffffff,
        title,
        body.length > 160 ? '${body.substring(0, 160)}…' : body,
        const NotificationDetails(
          android: AndroidNotificationDetails(
            'pibot_messages',
            '机器人消息',
            channelDescription: '部门/成员干完活时通知你',
            importance: Importance.high,
            priority: Priority.high,
            styleInformation: BigTextStyleInformation(''),
            groupKey: 'pibot',
          ),
          iOS: DarwinNotificationDetails(),
        ),
        payload: roomId,
      );
    } catch (_) {}
  }
}
