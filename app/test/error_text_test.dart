import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/api.dart';
import 'package:pi_bot/error_text.dart';
import 'package:pi_bot/l10n/l10n.dart';

void main() {
  const zh = AppStrings(AppLanguage.zh);
  const en = AppStrings(AppLanguage.en);

  group('服务端错误码本地化', () {
    test('有 code 时按当前语言取文案', () {
      final err = ApiException('会话不存在', status: 404, code: 'ROOM_NOT_FOUND');
      expect(describeError(err, zh), contains('会话'));
      expect(describeError(err, en), isNot(contains('会话')));
      expect(describeError(err, en), contains('conversation'));
    });

    test('没有 code 时退回服务端原文', () {
      final err = ApiException('某个没编码的错误', status: 500);
      expect(describeError(err, zh), '某个没编码的错误');
      expect(describeError(err, en), '某个没编码的错误');
    });

    test('code 在词表里没有时退回原文，不丢信息', () {
      final err = ApiException('未知情形', code: 'SOME_FUTURE_CODE');
      expect(describeError(err, en), '未知情形');
    });

    test('非 ApiException 也能转成文本', () {
      expect(describeError(StateError('boom'), en), contains('boom'));
    });

    test('所有已定义错误码在中英两种语言下都有翻译', () {
      for (final code in const [
        'PAIR_CODE_INVALID',
        'BAD_CONTENT_TYPE',
        'APPROVAL_NOT_PENDING',
        'ROOM_NOT_FOUND',
        'AUTOMATION_INVALID',
        'AUTOMATION_NOT_FOUND',
        'TASK_NEEDS_TITLE',
        'TASK_NOT_FOUND',
        'SITE_NOT_FOUND',
        'IMPORT_NOTHING_SELECTED',
        'INVALID_KIND',
        'CHUNK_TOO_LARGE',
        'FILE_TOO_LARGE',
        'EMPTY_FILE',
        'FILE_NOT_FOUND',
        'NAME_REQUIRED',
        'BOT_NOT_FOUND',
        'CANNOT_DELETE_MAIN_BOT',
        'MODEL_GROUP_NOT_FOUND',
        'CANNOT_DELETE_DM',
        'ROOM_HAS_NO_BOT',
        'BOT_NOT_IN_ROOM',
      ]) {
        for (final strings in [zh, en]) {
          final key = 'err.$code';
          expect(
            strings.t(key),
            isNot(key),
            reason: '错误码 $code 缺少 ${strings.language.code} 文案',
          );
        }
      }
    });

    test('英文错误文案里没有中文', () {
      final cjk = RegExp(r'[\u4e00-\u9fff]');
      for (final code in const ['ROOM_NOT_FOUND', 'FILE_TOO_LARGE', 'TASK_NOT_FOUND']) {
        expect(cjk.hasMatch(en.t('err.$code')), isFalse, reason: code);
      }
    });
  });
}
