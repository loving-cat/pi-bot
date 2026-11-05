import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/l10n/l10n.dart';

void main() {
  group('语言切换实际生效', () {
    test('切换后 strings 跟着换（不是只在 UI 层改）', () async {
      final c = LocaleController(initial: AppLanguage.zh);
      expect(c.strings.t('settings.title'), '设置');
      await c.setLanguage(AppLanguage.en);
      expect(c.strings.t('settings.title'), 'Settings');
      expect(c.language, AppLanguage.en);
    });

    test('切换会通知监听者（整棵树重建的前提）', () async {
      final c = LocaleController(initial: AppLanguage.zh);
      var notified = 0;
      c.addListener(() => notified++);
      await c.setLanguage(AppLanguage.en);
      expect(notified, 1);
      // 设成同一个语言不应该再通知，避免无谓重建
      await c.setLanguage(AppLanguage.en);
      expect(notified, 1);
    });

    test('英文界面下主要区域都已翻译', () {
      final en = AppStrings(AppLanguage.en);
      // 抽查各区域的代表 key，确认不是回退到中文
      final samples = <String>[
        'settings.title',
        'window.minimize',
        'avatar.shape',
        'common.cancel',
        'room.tab.detail',
        'model.testConnection',
        'onboard.title',
      ];
      final cjk = RegExp(r'[\u4e00-\u9fff]');
      for (final key in samples) {
        final value = en.t(key);
        expect(value, isNot(key), reason: '缺少英文文案: $key');
        expect(cjk.hasMatch(value), isFalse, reason: '$key 的英文里还有中文: $value');
      }
    });

    test('中文界面下对应文案是中文', () {
      final zh = AppStrings(AppLanguage.zh);
      final cjk = RegExp(r'[\u4e00-\u9fff]');
      for (final key in const ['settings.title', 'window.minimize', 'common.cancel']) {
        expect(cjk.hasMatch(zh.t(key)), isTrue, reason: '$key 应该是中文');
      }
    });
  });
}
