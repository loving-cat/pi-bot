import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/token_count.dart';

void main() {
  group('parseTokenCount', () {
    test('纯数字按 tokens 处理', () {
      expect(parseTokenCount('128000'), 128000);
      expect(parseTokenCount('1'), 1);
      expect(parseTokenCount(' 8192 '), 8192);
    });

    test('K 与 M 都能换算，大小写不敏感', () {
      expect(parseTokenCount('256K'), 256000);
      expect(parseTokenCount('256k'), 256000);
      expect(parseTokenCount('1M'), 1000000);
      expect(parseTokenCount('1m'), 1000000);
      expect(parseTokenCount('128K'), 128000);
    });

    test('支持小数：1.5M / 0.5K', () {
      expect(parseTokenCount('1.5M'), 1500000);
      expect(parseTokenCount('0.5K'), 500);
      expect(parseTokenCount('2.25M'), 2250000);
    });

    test('单位与数字之间允许空格', () {
      expect(parseTokenCount('256 K'), 256000);
      expect(parseTokenCount('1 M'), 1000000);
    });

    test('非法输入一律返回 null', () {
      for (final bad in <String>[
        '',
        '   ',
        'auto',
        '0',
        '-1',
        '1G',
        '1.2.3M',
        'K',
        '1e6',
        '128000 tokens',
        '1_000',
      ]) {
        expect(parseTokenCount(bad), isNull, reason: '应拒绝："$bad"');
      }
    });

    test('不带单位的小数不合法（token 没有半个）', () {
      expect(parseTokenCount('1.5'), isNull);
      expect(parseTokenCount('8192.0'), isNull);
      // 带单位的小数才是表达数量级，合法
      expect(parseTokenCount('1.5M'), 1500000);
    });

    test('超出安全整数范围返回 null', () {
      expect(parseTokenCount('9999999999999999M'), isNull);
    });
  });

  group('formatTokenCount', () {
    test('整除时收成 M / K', () {
      expect(formatTokenCount(1000000), '1M');
      expect(formatTokenCount(2000000), '2M');
      expect(formatTokenCount(128000), '128K');
      expect(formatTokenCount(256000), '256K');
    });

    test('不整除时原样显示，不丢精度', () {
      expect(formatTokenCount(128001), '128001');
      expect(formatTokenCount(999), '999');
      expect(formatTokenCount(0), '');
    });

    test('格式化结果能被解析回原值（往返一致）', () {
      for (final value in <int>[500, 999, 1000, 128000, 256000, 999999, 1000000, 2000000]) {
        expect(parseTokenCount(formatTokenCount(value)), value, reason: '$value');
      }
    });
  });

  group('词表完整性', () {
    test('中英两种语言都有 8 个轮廓名与 8 个颜色名', () {
      for (final language in AppLanguage.values) {
        final strings = AppStrings(language);
        expect(strings.avatarShapeNames.length, 8, reason: language.code);
        expect(strings.avatarColorNames.length, 8, reason: language.code);
        for (final name in strings.avatarShapeNames) {
          expect(name.trim(), isNotEmpty, reason: language.code);
        }
        for (final name in strings.avatarColorNames) {
          expect(name.trim(), isNotEmpty, reason: language.code);
        }
      }
    });

    test('两种语言的轮廓名互不相同（确实翻译了，不是照搬）', () {
      final zh = AppStrings(AppLanguage.zh).avatarShapeNames;
      final en = AppStrings(AppLanguage.en).avatarShapeNames;
      for (var i = 0; i < zh.length; i++) {
        expect(zh[i], isNot(equals(en[i])), reason: '第 $i 个轮廓没有翻译');
      }
    });

    test('预设色都有对应名字，未知色返回 null', () {
      for (final language in AppLanguage.values) {
        final strings = AppStrings(language);
        for (final hex in const [
          '#1E86FC', '#12C878', '#FB3A9C', '#9B5CFF',
          '#10C4AE', '#F94A80', '#F0901A', '#8C939B',
        ]) {
          expect(strings.avatarColorName(hex), isNotNull, reason: hex);
          expect(strings.avatarColorName(hex.toLowerCase()), isNotNull);
        }
        expect(strings.avatarColorName('#123456'), isNull);
      }
    });

    test('语言标识可以往返解析', () {
      expect(AppLanguage.fromCode('en'), AppLanguage.en);
      expect(AppLanguage.fromCode('en-US'), AppLanguage.en);
      expect(AppLanguage.fromCode('zh'), AppLanguage.zh);
      expect(AppLanguage.fromCode(null), AppLanguage.zh);
      expect(AppLanguage.fromCode('unknown'), AppLanguage.zh);
    });

    test('落盘用的语言标识稳定（改动会让老用户语言丢失）', () {
      expect(AppLanguage.zh.code, 'zh');
      expect(AppLanguage.en.code, 'en');
    });
  });

  group('词表结构', () {
    test('中英文 key 集合完全一致（漏翻会在这里红）', () {
      final zhKeys = <String>{};
      final enKeys = <String>{};
      for (final area in allStringAreas) {
        zhKeys.addAll(area.zh.keys);
        enKeys.addAll(area.en.keys);
      }
      final missingInEn = zhKeys.difference(enKeys);
      final missingInZh = enKeys.difference(zhKeys);
      expect(missingInEn, isEmpty, reason: '英文缺少：${missingInEn.join(', ')}');
      expect(missingInZh, isEmpty, reason: '中文缺少：${missingInZh.join(', ')}');
    });

    test('所有文案都不为空', () {
      for (final area in allStringAreas) {
        for (final entry in area.zh.entries) {
          expect(entry.value.trim(), isNotEmpty, reason: '中文空文案：${entry.key}');
        }
        for (final entry in area.en.entries) {
          expect(entry.value.trim(), isNotEmpty, reason: '英文空文案：${entry.key}');
        }
      }
    });

    test('英文文案里不留中日韩字符（漏翻的直接抓出来）', () {
      final cjk = RegExp(r'[\u4e00-\u9fff]');
      final offenders = <String>[];
      for (final area in allStringAreas) {
        for (final entry in area.en.entries) {
          if (cjk.hasMatch(entry.value)) {
            offenders.add('${entry.key} => ${entry.value}');
          }
        }
      }
      expect(offenders, isEmpty, reason: '英文值里还有中文：${offenders.join(' | ')}');
    });

    test('key 不重复（同一 key 在两个区域出现会互相覆盖）', () {
      final seen = <String>{};
      final duplicates = <String>[];
      for (final area in allStringAreas) {
        for (final key in area.zh.keys) {
          if (!seen.add(key)) duplicates.add(key);
        }
      }
      expect(duplicates, isEmpty, reason: '重复 key：${duplicates.join(', ')}');
    });

    test('查不到的 key 回退成 key 本身，不抛异常', () {
      final strings = AppStrings(AppLanguage.en);
      expect(strings.t('nope.not.exists'), 'nope.not.exists');
    });

    test('插值替换 {name} 占位', () {
      final strings = AppStrings(AppLanguage.en);
      expect(strings.tf('model.duplicateId', {'id': 'gpt-x'}), contains('gpt-x'));
    });
  });
}
