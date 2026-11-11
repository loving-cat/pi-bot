import 'package:flutter/widgets.dart';

/// 浮层开合时搬运焦点。
///
/// ## 为什么需要
///
/// HomeShell 的浮层是盖在聊天区上面的 ModalBarrier。它只负责挡点击，
/// **不会**让下面的输入框失焦 —— 用户的键盘输入照样打进那个看不见的输入框
/// （表现为「我在别处打字，结果发到聊天里了」）。
///
/// 所以浮层打开时要主动撤焦点；关闭时如果原来焦点在输入框，还要还回去
/// （不然关掉浮层还得再点一下输入框才能继续打字）。
///
/// ## 为什么抽成类
///
/// 这段逻辑原来直接写在 HomeShell 里，测试只能复制一份等价代码去测 ——
/// 那样 home_shell 的实现改了，测试照样是绿的，等于没测。
/// 抽出来之后 HomeShell 和测试调的是同一份 sync()。
class OverlayFocusKeeper {
  bool _hadOverlay = false;
  FocusNode? _focusBeforeOverlay;

  /// 上一次 sync 传进来的浮层状态。
  bool get hasOverlay => _hadOverlay;

  /// 按当前浮层状态搬运焦点。状态没变就什么都不做（可每帧调用）。
  ///
  /// 用 post-frame 是因为要在这一帧布局完之后再动焦点：
  /// 浮层刚插入时立即 unfocus 会被随后的重建覆盖掉。
  ///
  /// [isMounted] 用来在异步回调里确认宿主还活着（传 `() => mounted`）；
  /// 宿主已经销毁就别再碰焦点，否则会往已经 dispose 的节点上 requestFocus。
  void sync(bool hasOverlay, {required bool Function() isMounted}) {
    if (hasOverlay == _hadOverlay) return;
    _hadOverlay = hasOverlay;

    if (hasOverlay) {
      // 记下当前焦点；没有就不管
      _focusBeforeOverlay = FocusManager.instance.primaryFocus;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!isMounted()) return;
        FocusManager.instance.primaryFocus?.unfocus();
      });
      return;
    }

    final previous = _focusBeforeOverlay;
    _focusBeforeOverlay = null;
    if (previous == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!isMounted()) return;
      // 那个节点可能已经随子树销毁了 —— canRequestFocus 会把这种情况挡掉
      if (previous.canRequestFocus) previous.requestFocus();
    });
  }

  /// 宿主销毁时调用：只清状态，不动焦点。
  void dispose() {
    _focusBeforeOverlay = null;
    _hadOverlay = false;
  }
}