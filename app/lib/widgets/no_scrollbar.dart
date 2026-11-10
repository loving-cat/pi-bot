import 'package:flutter/material.dart';

/// 不画滚动条（滚动本身照常可用）。
///
/// ★ 只给**聊天消息列表**用，不要挂到 MaterialApp 上。
///
///   聊天内容在流式输出时高度高频变化，系统滑块跟着反复重算 ——
///   观感就是「抽搐」，所以那一处要关掉。
///
///   但挂到 MaterialApp 会影响**所有**可滚动组件：设置页、日志、
///   文件列表、回执二级页全都失去滚动条，长列表再也判断不了
///   「下面还有多少」。那是功能倒退，不是优化。
class NoScrollbarBehavior extends MaterialScrollBehavior {
  const NoScrollbarBehavior();

  @override
  Widget buildScrollbar(
    BuildContext context,
    Widget child,
    ScrollableDetails details,
  ) {
    // 直接返回内容，不套 Scrollbar
    return child;
  }
}
