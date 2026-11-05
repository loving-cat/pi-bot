import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 界面明暗模式。
///
/// 为什么不用 Theme.of(context).brightness 一把梭：
///   项目里 815 处颜色是直接读 `PB.bgApp` 这类静态量的，
///   散落在各种 `const TextStyle(color: PB.textPrimary)` 里。
///   全部改成 context 读取等于重写整个界面层。
///   这里用一个全局可读的当前模式，让 `PB.xxx` 保持调用方式不变，
///   内部按模式返回对应颜色 —— 调用点零改动。
enum PBColorMode { dark, light }

/// 当前生效的明暗模式。
///
/// 只在 App 启动和用户切换时写；界面通过 `PB.bgApp` 等 getter 读。
/// 用 ValueNotifier 是为了让切换按钮能监听（做动画）。
final ValueNotifier<PBColorMode> pbColorMode =
    ValueNotifier<PBColorMode>(PBColorMode.dark);

bool get isLightMode => pbColorMode.value == PBColorMode.light;

/// 把当前模式持久化 / 启动时读回来。
///
/// 用 SharedPreferences 而不是服务端：这是本机偏好，
/// 换台电脑看到的不该跟着变（有人台式机用深色、笔记本用浅色）。
const String _prefsKey = 'ui_color_mode';

Future<void> loadColorMode() async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(_prefsKey);
    if (saved == 'light') pbColorMode.value = PBColorMode.light;
    if (saved == 'dark') pbColorMode.value = PBColorMode.dark;
  } catch (_) {
    // 读不到就用默认深色，不该因此启动失败
  }
}

Future<void> saveColorMode(PBColorMode mode) async {
  pbColorMode.value = mode;
  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_prefsKey, mode == PBColorMode.light ? 'light' : 'dark');
  } catch (_) {
    // 存不下就算了，本次会话仍然生效
  }
}
