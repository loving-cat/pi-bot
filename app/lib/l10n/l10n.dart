// 语言选择的持有者与读取入口。
//
// 只有一处状态（LocaleController），界面用 L10n.s(context) 取词表。
// 切换语言只 notify 一次，整棵树跟着重建。

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app_strings.dart';

export 'app_strings.dart';

/// 语言偏好：内存态 + 落盘。
///
/// 落盘失败不影响本次会话（只是下次启动回退默认语言），所以写入不抛出。
class LocaleController extends ChangeNotifier {
  LocaleController({AppLanguage initial = AppLanguage.zh})
    : _language = initial,
      _strings = AppStrings(initial);

  static const prefsKey = 'ui_language';

  AppLanguage _language;
  AppStrings _strings;

  AppLanguage get language => _language;

  AppStrings get strings => _strings;

  /// 启动时读一次；读不到就用中文（历史默认）。
  static Future<LocaleController> load() async {
    AppLanguage initial = AppLanguage.zh;
    try {
      final prefs = await SharedPreferences.getInstance();
      initial = AppLanguage.fromCode(prefs.getString(prefsKey));
    } catch (_) {
      // 平台通道在极早期可能还没就绪：用默认值，不阻塞启动
    }
    return LocaleController(initial: initial);
  }

  Future<void> setLanguage(AppLanguage next) async {
    if (next == _language) return;
    _language = next;
    _strings = AppStrings(next);
    notifyListeners();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(prefsKey, next.code);
    } catch (_) {
      // 落盘失败不回滚界面：本次会话仍然按用户选的走
    }
  }
}

/// 把当前语言与词表下发到整棵树。
class L10n extends InheritedNotifier<LocaleController> {
  const L10n({
    super.key,
    required LocaleController controller,
    required super.child,
  }) : super(notifier: controller);

  /// 取控制器；组件树外（测试 / 单独预览）会回退到默认控制器。
  static LocaleController? maybeControllerOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<L10n>()?.notifier;

  static LocaleController controllerOf(BuildContext context) {
    final controller = maybeControllerOf(context);
    assert(controller != null, 'L10n 未装配到组件树上方');
    return controller ?? _fallback;
  }

  /// 组件树外（测试 / 独立预览）用的默认控制器，固定中文、不落盘。
  static final LocaleController _fallback = LocaleController();

  static AppStrings of(BuildContext context) =>
      maybeControllerOf(context)?.strings ?? _fallback.strings;

  /// 简写：L10n.s(context).t('common.save')
  static AppStrings s(BuildContext context) => of(context);

  /// 不在组件树里（纯逻辑单测）时使用。
  static AppStrings ofLanguage(AppLanguage language) => AppStrings(language);
}
