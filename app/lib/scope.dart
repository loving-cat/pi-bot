import 'package:flutter/material.dart';

import 'app_state.dart';
import 'models.dart';

/// 用 InheritedNotifier 把 AppState 发给整棵树，避免引 provider 依赖。
class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child})
    : super(notifier: state);

  static AppState of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<AppScope>();
    assert(scope != null, 'AppScope 未挂载');
    return scope!.notifier!;
  }

  /// 只读取、不订阅（在回调里用）
  static AppState read(BuildContext context) {
    final scope = context.getInheritedWidgetOfExactType<AppScope>();
    return scope!.notifier!;
  }
}

/// 从任何地方请求"切到某个会话"（点 @提及 / 点引用气泡 / 点通知都走这里）。
///
/// 具体怎么切由 HomeShell 决定：宽屏切左侧选中项，窄屏 push 一个新页面。
/// 调用方不需要知道现在是哪种布局，也不需要自己 push —— 所以这里只发一个请求。
///
/// ★ 别改回 openRoom：分栏布局的选中项是 HomeShell 的本地状态，
///   openRoom 只是记一个"正在看哪个房间"，切不动界面（点了没反应就是这么来的）。
void requestRoom(BuildContext context, String roomId) {
  if (roomId.isEmpty) return;
  AppScope.read(context).requestRoom(roomId);
}

String formatTime(int millis) {
  if (millis <= 0) return '';
  final dt = DateTime.fromMillisecondsSinceEpoch(millis);
  final now = DateTime.now();
  final hm =
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  if (dt.year == now.year && dt.month == now.month && dt.day == now.day)
    return hm;
  return '${dt.month}/${dt.day} $hm';
}

String shortText(String text, int max) {
  final flat = text.replaceAll('\n', ' ').trim();
  return flat.length <= max ? flat : '${flat.substring(0, max)}…';
}

/// `provider/model-id` → `model-id`
String shortModel(String? slug) {
  if (slug == null || slug.isEmpty) return '';
  final parts = slug.split('/');
  return parts.last;
}

class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.state});

  final LinkState state;

  @override
  Widget build(BuildContext context) {
    final (color, label) = switch (state) {
      LinkState.online => (Colors.greenAccent, '在线'),
      LinkState.connecting => (Colors.amberAccent, '连接中'),
      LinkState.offline => (Colors.redAccent, '离线'),
    };
    return Tooltip(
      message: label,
      child: Container(
        width: 9,
        height: 9,
        decoration: BoxDecoration(
          color: color,
          shape: BoxShape.circle,
          boxShadow: [
            BoxShadow(color: color.withValues(alpha: 0.6), blurRadius: 6),
          ],
        ),
      ),
    );
  }
}
