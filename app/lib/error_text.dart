import 'package:flutter/widgets.dart';

import 'api.dart';
import 'l10n/l10n.dart';

/// 把任意异常转成当前语言下的可读文案。
///
/// 服务端返回 { error, code }：error 是中文兜底，code 是稳定标识。
/// 有 code 就走本地化词表；没有（或词表里没有这一条）就原样显示，
/// 不能什么都不说 —— 用户至少要知道失败了。
String describeError(Object error, AppStrings strings) {
  if (error is ApiException) {
    final code = error.code;
    if (code != null && code.isNotEmpty) {
      final key = 'err.$code';
      final localized = strings.t(key);
      // 词表里没有这个 code 时 t() 会返回 key 本身，说明没翻译过
      if (localized != key) return localized;
    }
    return error.message;
  }
  return '$error';
}

/// 组件树里用：自动取当前语言。
String describeErrorOf(Object error, BuildContext context) =>
    describeError(error, L10n.s(context));
