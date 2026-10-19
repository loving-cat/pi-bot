import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/update_info.dart';
import 'package:pi_bot/widgets/update_prompt.dart';

/// 更新判定的纯逻辑测试。
///
/// 这里只测"要不要提示"和"解析得对不对"，不测弹窗（弹窗在 widget 测试里是另一回事）。
/// 重点是那几条容易写错的产品规则：
///   · 检查失败不能当成"有新版本"；
///   · 用户点了"以后再说"的版本不再问；
///   · 但出了更新的版本还要问。
void main() {
  UpdateInfo info({
    bool ok = true,
    bool update = true,
    String current = '1.1.0',
    String latest = 'v1.2.0',
    String assetUrl = '',
    String assetName = '',
    int assetSize = 0,
    String pageUrl = '',
    String notes = '',
  }) => UpdateInfo(
    ok: ok,
    update: update,
    current: current,
    latest: latest,
    assetUrl: assetUrl,
    assetName: assetName,
    assetSize: assetSize,
    pageUrl: pageUrl,
    notes: notes,
  );

  group('要不要提示', () {
    test('有新版本 → 提示', () {
      expect(shouldPromptUpdate(info(), null), isTrue);
      expect(shouldPromptUpdate(info(), ''), isTrue);
    });

    test('没有新版本 → 不提示', () {
      expect(shouldPromptUpdate(info(update: false), null), isFalse);
    });

    test('检查本身失败 → 不提示（不能当成有更新）', () {
      expect(shouldPromptUpdate(info(ok: false, update: false), null), isFalse);
    });

    test('用户对这个版本点过"以后再说" → 不再提示', () {
      expect(shouldPromptUpdate(info(latest: 'v1.2.0'), 'v1.2.0'), isFalse);
    });

    test('出了更新的版本 → 即使之前忽略过也要提示', () {
      expect(shouldPromptUpdate(info(latest: 'v1.3.0'), 'v1.2.0'), isTrue);
    });

    test('远端版本号为空 → 不提示（数据不完整）', () {
      expect(shouldPromptUpdate(info(latest: ''), null), isFalse);
    });
  });

  group('解析服务端响应', () {
    test('完整响应', () {
      final i = UpdateInfo.fromJson({
        'ok': true,
        'update': true,
        'current': '1.1.0',
        'latest': 'v1.2.0',
        'reason': '发现新版本',
        'notes': '修了三个 bug',
        'pageUrl': 'https://example.com',
        'recommended': {
          'name': 'pi-bot-setup.exe',
          'url': 'https://x/setup.exe',
          'size': 5242880,
        },
        'assets': [],
      });
      expect(i.ok, isTrue);
      expect(i.update, isTrue);
      expect(i.latest, 'v1.2.0');
      expect(i.canDownload, isTrue);
      expect(i.assetName, 'pi-bot-setup.exe');
      expect(i.sizeLabel, '5.0 MB');
      expect(i.hasNotes, isTrue);
    });

    test('没有 Mac 推荐包时只保留发布页，不下载其它平台附件', () {
      final i = UpdateInfo.fromJson({
        'ok': true,
        'update': true,
        'current': '1.0.0',
        'latest': '1.1.0',
        'pageUrl': 'https://example.com/releases',
        'recommended': null,
        'assets': [
          {'name': 'windows.exe', 'url': 'https://x/windows.exe'},
          {'name': 'android.apk', 'url': 'https://x/android.apk'},
        ],
      });
      expect(i.canDownload, isFalse);
      expect(i.assetUrl, isEmpty);
      expect(i.assetName, isEmpty);
      expect(i.sizeLabel, isEmpty);
      expect(i.pageUrl, 'https://example.com/releases');
      expect(shouldPromptUpdate(i, null), isTrue);
    });

    test('混合平台附件使用指定的合法 DMG，不取首个附件', () {
      final i = UpdateInfo.fromJson({
        'ok': true,
        'update': true,
        'current': '1.1.0',
        'latest': '1.2.0',
        'recommended': {
          'name': 'pi-bot-1.2.0.dmg',
          'url': 'https://x/pi-bot-1.2.0.dmg?download=1',
          'size': 1024,
        },
        'assets': [
          {'name': 'windows.exe', 'url': 'https://x/windows.exe'},
          {'name': 'android.apk', 'url': 'https://x/android.apk'},
          {
            'name': 'pi-bot-1.2.0.dmg',
            'url': 'https://x/pi-bot-1.2.0.dmg?download=1',
          },
        ],
      });
      expect(i.canDownload, isTrue);
      expect(i.assetUrl, 'https://x/pi-bot-1.2.0.dmg?download=1');
      expect(i.assetName, 'pi-bot-1.2.0.dmg');
      expect(i.sizeLabel, '1.0 KB');
    });

    test('缺少推荐字段或推荐 URL 为空时均不猜测 DMG', () {
      for (final recommended in [
        <String, dynamic>{},
        {'recommended': null},
        {
          'recommended': {'name': 'pi-bot.dmg', 'url': ''},
        },
      ]) {
        final i = UpdateInfo.fromJson({
          ...recommended,
          'assets': [
            {'name': 'pi-bot.dmg', 'url': 'https://x/pi-bot.dmg'},
          ],
        });
        expect(i.canDownload, isFalse);
        expect(i.assetUrl, isEmpty);
      }
    });

    test('没有下载包 → canDownload 为 false，不崩', () {
      final i = UpdateInfo.fromJson({
        'ok': true,
        'update': true,
        'current': '1.0.0',
        'latest': '1.1.0',
        'assets': [],
      });
      expect(i.canDownload, isFalse);
      expect(i.sizeLabel, '');
      expect(i.hasNotes, isFalse);
    });

    test('字段缺失时按空处理', () {
      final i = UpdateInfo.fromJson({});
      expect(i.ok, isFalse);
      expect(i.update, isFalse);
      expect(i.current, '');
      expect(i.latest, '');
    });

    test('体积格式化', () {
      expect(info(assetSize: 0).sizeLabel, '');
      expect(info(assetSize: 512).sizeLabel, '512 B');
      expect(info(assetSize: 2048).sizeLabel, '2.0 KB');
      expect(info(assetSize: 1024 * 1024 * 3).sizeLabel, '3.0 MB');
      expect(info(assetSize: 1024 * 1024 * 1024 * 2).sizeLabel, '2.0 GB');
    });
  });

  group('下载地址校验', () {
    test('只接受 https 直链', () {
      expect(isSafeDownloadUrl('https://github.com/x/y.exe'), isTrue);
      expect(
        isSafeDownloadUrl('http://github.com/x/y.exe'),
        isFalse,
        reason: 'http 会被降级',
      );
      expect(isSafeDownloadUrl('file:///C:/x.exe'), isFalse);
      expect(isSafeDownloadUrl('https://'), isFalse, reason: '没有主机名');
      expect(isSafeDownloadUrl(''), isFalse);
      expect(isSafeDownloadUrl('not a url'), isFalse);
    });

    test('发布页地址同样校验', () {
      expect(isSafeWebUrl('https://github.com/a/b/releases'), isTrue);
      expect(isSafeWebUrl('http://evil.test'), isFalse);
      expect(isSafeWebUrl('javascript:alert(1)'), isFalse);
    });
  });

  group('平台参数', () {
    test('给出服务端认识的平台名', () {
      // 测试跑在桌面，至少不能是 unknown
      expect(UpdateInfo.platformParam, isNot('unknown'));
      expect([
        'win32',
        'darwin',
        'linux',
        'android',
        'ios',
      ], contains(UpdateInfo.platformParam));
    });
  });
}
