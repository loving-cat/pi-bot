import 'package:flutter/widgets.dart';

/// 输入法组词状态判断 —— 中文/日文/韩文用户按回车时到底是"选候选词"还是"提交"。
///
/// ## 这个坑到底是什么
///
/// 用中文输入法打英文（或者打拼音还没选字）时，屏幕上有一个**候选框**，
/// 候选框里的内容还没落进输入框。此时 `TextEditingController.value.composing`
/// 是一片**有效且非折叠**的区间，表示"这一部分正在组词"。
///
/// 这时候按回车，用户的意图是「确认这个候选词」，而 `onSubmitted` /
/// 键盘事件会把同一个回车理解成「提交」。结果就是：
///   · 消息带着半截内容发出去
///   · 输入框被清空
///   · 用户看到的就是"输入法吃字了"
///
/// 正确做法：**组词期间的回车一律不当作提交**，交给输入法自己处理；
/// 用户再按一次回车（此时 composing 已空）才真提交。
///
/// ## 为什么单独抽成函数
///
/// 这个判断要在好几处用（聊天输入框、询问卡片、任务板、改名弹窗…），
/// 每处各写一遍 `composing.isValid && !composing.isCollapsed` 迟早会漏。
/// 漏一处，那个输入框就继续"吃字"。
///
/// @param controller 输入框的 controller
/// @returns true = 正在组词，**不要**把它当提交
bool isImeComposing(TextEditingController controller) {
  final composing = controller.value.composing;
  // TextRange.empty 是 isValid=false 的；折叠区间（start == end）表示没有选中内容
  return composing.isValid && !composing.isCollapsed;
}

/// 给 `onSubmitted` 用的包装：正在组词时什么都不做。
///
/// ```dart
/// onSubmitted: submitUnlessComposing(controller, () => _send()),
/// ```
///
/// 直接写 `onSubmitted: (_) => _send()` 在中文输入法下会吃字 —— 见上面的说明。
ValueChanged<String> submitUnlessComposing(
  TextEditingController controller,
  VoidCallback onSubmit,
) {
  return (_) {
    if (isImeComposing(controller)) return;
    onSubmit();
  };
}
