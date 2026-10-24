import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../theme.dart';

/// 轻提示（toast）—— 悬浮在窗口右上角，不占布局、不挡输入。
///
/// ## 为什么不用 SnackBar
///
/// SnackBar 铺在**底部**，正好压在聊天输入框和发送按钮上：用户正在打字，
/// 底部冒出一条"已保存"，要么挡住输入框视线，要么把输入框往上顶一下。
/// 桌面 App 里这种交互过时了 —— 通知应该是"飘过去一下就没了"，
/// 不该参与布局，也不该抢注意力。
///
/// 这里改成：
///   · 悬浮在右上角（远离主要输入区）
///   · 不进入布局树（OverlayEntry），窗口内容不会因为它位移
///   · 自动消失（成功 2.4s / 失败 4s，失败要给人时间读完）
///   · 不拦截鼠标（`ignorePointer`），飘着的时候照样能操作
///   · 最多同时显示 3 条，再多就把最老的挤掉（防止刷屏）
///
/// ## 用法
///
/// ```dart
/// toast(context, '已保存');
/// toast(context, '保存失败：${err}', kind: ToastKind.error);
/// ```
///
/// 需要更长的时间就传 `duration`；不想自动消失（比如等着用户点掉）传 `duration: null`。
enum ToastKind { info, success, error }

/// 当前屏幕上的所有 toast（按出现顺序），用于"最多 3 条"的控制。
final Map<OverlayState, List<_ToastHandle>> _live = {};

/// 显示一条轻提示。
///
/// @param context 任意能拿到 Overlay 的 context
/// @param message 要显示的文字（会换行，不会截断）
/// @param kind 图标与配色：info / success / error
/// @param duration 多久后自动消失；传 null 表示不自动消失
void toast(
  BuildContext context,
  String message, {
  ToastKind kind = ToastKind.info,
  Duration? duration,
}) {
  if (message.trim().isEmpty) return;
  final overlay = Overlay.maybeOf(context, rootOverlay: true);
  if (overlay == null) return;

  // 同一条消息连续弹两次（比如重复点保存）就不要再叠一条
  final list = _live.putIfAbsent(overlay, () => <_ToastHandle>[]);
  if (list.any((h) => h.message == message && h.kind == kind && h.alive)) {
    return;
  }

  // 超过 3 条就把最老的收掉 —— 刷屏时不该把整块屏幕盖住
  while (list.length >= 3) {
    list.first.dismiss();
  }

  final handle = _ToastHandle(
    message: message,
    kind: kind,
    overlay: overlay,
  );
  handle.show(duration ?? (kind == ToastKind.error
      ? const Duration(seconds: 4)
      : const Duration(milliseconds: 2400)));
  list.add(handle);
  handle.onGone = () {
    list.remove(handle);
    // ★ Overlay 没了（窗口关闭/切页）就把这个槽位一起清掉。
    //   不清的话 _live 会按"每次销毁的 Overlay"一直累积 ——
    //   桌面端反复开关窗口/面板时这是实实在在的内存泄漏。
    if (list.isEmpty) _live.remove(overlay);
  };
}

/// 一次性清掉当前屏幕上的所有 toast（切换页面时用得上）
void dismissToasts(BuildContext context) {
  final overlay = Overlay.maybeOf(context, rootOverlay: true);
  if (overlay == null) return;
  for (final h in List<_ToastHandle>.from(_live[overlay] ?? const [])) {
    h.dismiss();
  }
}

/// 一条 toast 的生命周期：入场 → 停留 → 出场 → 移除
class _ToastHandle {
  _ToastHandle({
    required this.message,
    required this.kind,
    required this.overlay,
  });

  final String message;
  final ToastKind kind;
  final OverlayState overlay;

  bool alive = true;
  VoidCallback? onGone;

  OverlayEntry? _entry;
  Timer? _timer;

  void show(Duration? duration) {
    _entry = OverlayEntry(builder: (_) => _ToastView(handle: this));
    overlay.insert(_entry!);
    if (duration != null) {
      _timer = Timer(duration, dismiss);
    }
  }

  /// 只取消计时器，不动 OverlayEntry。
  ///
  /// widget dispose 时用这个：那时框架正在拆树，
  /// 再从 dispose 里调 `OverlayEntry.remove()` 会触发断言。
  /// 条目会随 Overlay 一起销毁，不需要本组件处理。
  void cancelTimer() {
    _timer?.cancel();
    _timer = null;
  }

  /// 立即摘掉并取消计时器（切页/主动清理时用）。
  void disposeNow() {
    cancelTimer();
    _entry?.remove();
    _entry = null;
    alive = false;
    onGone?.call();
  }

  /// 请求消失：先让 widget 播完出场动画，再由它回调 [_finish]。
  void dismiss() {
    if (!alive) return;
    _timer?.cancel();
    _view?.reverse();
  }

  /// widget 挂载时登记，方便 handle 反向驱动动画
  void _bind(_ToastViewState view) => _view = view;
  _ToastViewState? _view;

  void _finish() {
    if (!alive) return;
    alive = false;
    _timer?.cancel();
    _timer = null;
    _entry?.remove();
    _entry = null;
    onGone?.call();
  }
}

/// toast 的实际外观。自己管入场/出场动画。
class _ToastView extends StatefulWidget {
  const _ToastView({required this.handle});

  final _ToastHandle handle;

  @override
  State<_ToastView> createState() => _ToastViewState();
}

class _ToastViewState extends State<_ToastView>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 180),
  );
  late final CurvedAnimation _curve = CurvedAnimation(
    parent: _c,
    curve: Curves.easeOutCubic,
  );

  @override
  void initState() {
    super.initState();
    _c.forward();
    // 让 handle 能反过来驱动这个动画（dismiss 时先播出场再移除）
    widget.handle._bind(this);
  }

  /// 播完出场动画后把自己从 Overlay 摘掉
  void reverse() {
    _c.reverse().whenCompleteOrCancel(() {
      widget.handle._finish();
    });
  }

  @override
  void dispose() {
    // ★ 只取消计时器，不要在这里 remove OverlayEntry ——
    //   框架正在拆树，从 dispose 里移除会踩断言。
    //   不取消的话，测试里会报 `A Timer is still pending`。
    widget.handle.cancelTimer();
    _curve.dispose();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final (icon, color) = switch (widget.handle.kind) {
      ToastKind.success => (LucideIcons.check, PB.success),
      ToastKind.error => (LucideIcons.x, PB.danger),
      ToastKind.info => (LucideIcons.info, PB.accent),
    };

    return Positioned(
      // 右上角，避开标题栏和主要输入区
      top: 56,
      right: 18,
      child: IgnorePointer(
        child: FadeTransition(
          opacity: _curve,
          child: SlideTransition(
            position: Tween<Offset>(
              begin: const Offset(0.06, 0),
              end: Offset.zero,
            ).animate(_curve),
            child: Material(
              color: Colors.transparent,
              child: Container(
                constraints: const BoxConstraints(maxWidth: 360),
                padding: const EdgeInsets.fromLTRB(12, 10, 14, 10),
                decoration: BoxDecoration(
                  color: PB.bgElevated,
                  borderRadius: BorderRadius.circular(PB.rXl),
                  border: Border.all(color: color.withValues(alpha: 0.35)),
                  boxShadow: PB.glow(Colors.black, blur: 24, alpha: 0.45),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(icon, size: 14, color: color),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        widget.handle.message,
                        style: const TextStyle(
                          fontSize: PB.fsXs,
                          color: PB.textPrimary,
                          height: 1.5,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
