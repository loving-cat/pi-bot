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

/// `cline/cline-pass/deepseek-v4.1-flash` → `deepseek-v4.1-flash`
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
