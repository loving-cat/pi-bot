// 界面文案的唯一来源。
//
// 不引入 flutter_localizations / intl：全部是短句，没有复数、性别、
// 日期格式化需求；一张手写表 + 两个实现，省掉一整套生成步骤和锁文件。
//
// 查询口径：先查当前语言，缺了回退中文，再缺就返回 key 本身
// —— 接口漏配文案时界面显示 "chat.send" 而不是崩，一眼能看出漏了哪条。

import 'strings/registry.dart';

export 'strings/registry.dart';

/// 支持的语言。
enum AppLanguage {
  zh('zh', '简体中文', 'Chinese (Simplified)'),
  en('en', 'English', 'English');

  const AppLanguage(this.code, this.nativeName, this.englishName);

  /// 落盘用的稳定标识（BCP-47 子集）。
  final String code;

  /// 在该语言自己的界面里显示的名字。
  final String nativeName;

  /// 英文界面里显示的名字。
  final String englishName;

  static AppLanguage fromCode(String? code) {
    final value = (code ?? '').toLowerCase();
    if (value.startsWith('en')) return AppLanguage.en;
    return AppLanguage.zh;
  }

  /// 语言切换器里显示的标签：中文界面用本地名，英文界面用英文名。
  String labelIn(AppLanguage ui) =>
      ui == AppLanguage.en ? englishName : nativeName;

  /// 另一个语言（当前只有两种）。
  AppLanguage get other => this == AppLanguage.zh ? AppLanguage.en : AppLanguage.zh;
}

/// 按语言查词表。
class AppStrings {
  const AppStrings(this.language);

  final AppLanguage language;

  /// 合并后的查询表；中英文各建一次，之后只读。
  static final Map<AppLanguage, Map<String, String>> _tables = {
    for (final language in AppLanguage.values)
      language: {
        for (final area in allStringAreas)
          ...switch (language) {
            AppLanguage.zh => area.zh,
            AppLanguage.en => area.en,
          },
      },
  };

  static final Map<AppLanguage, Map<String, String>> _fallback = {
    for (final language in AppLanguage.values)
      language: {
        for (final area in allStringAreas) ...area.zh,
      },
  };

  Map<String, String> get _table => _tables[language]!;

  /// 取一条文案。找不到时按「当前语言 → 中文 → key」的顺序回退。
  String t(String key) {
    final value = _table[key];
    if (value != null) return value;
    final zh = _fallback[language]?[key];
    if (zh != null) return zh;
    // 不 assert、不抛：界面在渲染期的异常会把整页打成红屏。
    // 直接把 key 显示出来，比崩掉更容易定位漏了哪条。
    return key;
  }

  /// 带插值：t 里写 {name}，这里传值。
  String tf(String key, Map<String, Object?> params) {
    var text = t(key);
    for (final entry in params.entries) {
      text = text.replaceAll('{${entry.key}}', '${entry.value ?? ''}');
    }
    return text;
  }

  // ---- 少量需要计算的文案 ----

  /// 8 种轮廓的名字，顺序与 AvatarCharacterKind.values 一致。
  List<String> get avatarShapeNames => [
    for (var i = 0; i < 8; i++) t('avatar.shape.$i'),
  ];

  /// 8 个预设色的名字，顺序与 avatarColorPresets 一致。
  List<String> get avatarColorNames => [
    for (var i = 0; i < 8; i++) t('avatar.color.$i'),
  ];

  /// 把内置颜色值翻译成名字；不认识的（用户自定义）返回 null。
  String? avatarColorName(String hex) {
    final index = _colorIndex[hex.toUpperCase()];
    return index == null ? null : avatarColorNames[index];
  }

  static const _colorIndex = <String, int>{
    '#1E86FC': 0,
    '#12C878': 1,
    '#FB3A9C': 2,
    '#9B5CFF': 3,
    '#10C4AE': 4,
    '#F94A80': 5,
    '#F0901A': 6,
    '#8C939B': 7,
  };
}
