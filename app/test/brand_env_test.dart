import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/locate.dart';

/// 品牌环境变量的读取规则：`ORBIS_*` 优先，回退 `PI_BOT_*`。
///
/// 与 `server/src/brand.js` 的 `readBrandEnv` 同一套语义 —— 服务端和桌面端
/// 对「同一个配置该读哪个变量」必须给出同一个答案，否则会出现
/// "设了 ORBIS_SERVER 但 App 没看见"这类只有真机才暴露的错。
void main() {
  group('readBrandEnv', () {
    test('新名优先于旧名', () {
      expect(
        readBrandEnv({'ORBIS_SERVER': '/new', 'PI_BOT_SERVER': '/old'}, 'SERVER'),
        '/new',
      );
    });

    test('★ 只有旧名时回退（1.x 存下来的配置不用改）', () {
      expect(readBrandEnv({'PI_BOT_SERVER': '/old'}, 'SERVER'), '/old');
    });

    test('都没有 → null', () {
      expect(readBrandEnv({}, 'SERVER'), isNull);
    });

    test('新名是空串/纯空白 → 视为没设，继续回退旧名', () {
      expect(
        readBrandEnv({'ORBIS_SERVER': '', 'PI_BOT_SERVER': '/old'}, 'SERVER'),
        '/old',
      );
      expect(
        readBrandEnv({'ORBIS_SERVER': '   ', 'PI_BOT_SERVER': '/old'}, 'SERVER'),
        '/old',
      );
    });

    test('两处都空 → null', () {
      expect(
        readBrandEnv({'ORBIS_SERVER': '', 'PI_BOT_SERVER': '  '}, 'SERVER'),
        isNull,
      );
    });

    test('去掉首尾空白（用户从终端复制路径时很常见）', () {
      expect(
        readBrandEnv({'ORBIS_SERVER': '  /path/with/space  '}, 'SERVER'),
        '/path/with/space',
      );
    });

    test('只认完整键名：ORBIS_SERVER_DIR 不是 ORBIS_SERVER', () {
      expect(readBrandEnv({'ORBIS_SERVER_DIR': '/x'}, 'SERVER'), isNull);
    });
  });

  group('定位时认新名', () {
    late Directory tmp;
    setUp(() {
      tmp = Directory.systemTemp.createTempSync('orbis-brand-');
    });
    tearDown(() {
      try {
        tmp.deleteSync(recursive: true);
      } catch (_) {}
    });

    test('★ ORBIS_SERVER 指定的入口排在最前', () {
      final custom = File('${tmp.path}/custom/src/index.js');
      custom.parent.createSync(recursive: true);
      custom.writeAsStringSync('// custom');

      final candidates = serverEntryCandidates(
        tmp.path,
        environment: {'ORBIS_SERVER': custom.path},
        operatingSystem: 'macos',
      );
      expect(candidates.first, custom.path);
    });

    test('旧名 PI_BOT_SERVER 仍然生效', () {
      final legacy = File('${tmp.path}/legacy/src/index.js');
      legacy.parent.createSync(recursive: true);
      legacy.writeAsStringSync('// legacy');

      final candidates = serverEntryCandidates(
        tmp.path,
        environment: {'PI_BOT_SERVER': legacy.path},
        operatingSystem: 'macos',
      );
      expect(candidates.first, legacy.path);
    });

    test('两个都设时新名赢', () {
      final modern = File('${tmp.path}/m/server/src/index.js');
      modern.parent.createSync(recursive: true);
      modern.writeAsStringSync('// m');
      final legacy = File('${tmp.path}/l/server/src/index.js');
      legacy.parent.createSync(recursive: true);
      legacy.writeAsStringSync('// l');

      final candidates = serverEntryCandidates(
        tmp.path,
        environment: {
          'ORBIS_SERVER': modern.path,
          'PI_BOT_SERVER': legacy.path,
        },
        operatingSystem: 'macos',
      );
      expect(candidates.first, modern.path);
      expect(candidates.contains(legacy.path), isFalse);
    });
  });
}
