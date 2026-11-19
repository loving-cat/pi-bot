import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/launcher.dart';

/// 品牌改名（pi-bot → orbis）后，状态目录名怎么选。
///
/// 和服务端 `server/src/config.js` 的 `resolveHomeDir` 必须同一套策略：
/// 新版优先，旧版只在「新版不存在、旧版存在」时沿用。
/// 两边不一致会出现「App 日志在新目录、服务端数据在旧目录」的分叉。
void main() {
  group('状态目录名判定', () {
    test('两个都不存在 → 用新名 orbis', () {
      final name = resolveStateDirName(
        '/base',
        exists: (_) => false,
      );
      expect(name, 'orbis');
    });

    test('★ 只有旧目录存在 → 沿用 pi-bot（老用户零迁移）', () {
      final name = resolveStateDirName(
        '/base',
        exists: (p) => p.endsWith('pi-bot'),
      );
      expect(name, 'pi-bot', reason: '不能把老用户的日志/pid 挪走');
    });

    test('旧目录存在但有新目录 → 用新名（已经迁过就按新的走）', () {
      final name = resolveStateDirName('/base', exists: (_) => true);
      expect(name, 'orbis');
    });

    test('只有新目录存在 → 用新名', () {
      final name = resolveStateDirName(
        '/base',
        exists: (p) => p.endsWith('orbis'),
      );
      expect(name, 'orbis');
    });

    test('判存在性时抛异常 → 不崩，按新名走', () {
      final name = resolveStateDirName(
        '/base',
        exists: (_) => throw StateError('boom'),
      );
      expect(name, 'orbis');
    });

    test('两个候选目录都会被问一次，且都以 base 开头', () {
      final sep = Platform.pathSeparator;
      final seen = <String>[];
      final name = resolveStateDirName(
        '/base$sep',
        exists: (p) {
          seen.add(p);
          return false; // 都不存在 → 用新名
        },
      );
      expect(name, 'orbis');
      // 先问 orbis、再问 pi-bot；两个都以 base 开头（没漏拼接）
      expect(seen.length, 2);
      for (final p in seen) {
        expect(p.startsWith('/base'), isTrue, reason: '拼错了：$p');
      }
      expect(seen.any((p) => p.contains('orbis')), isTrue);
      expect(seen.any((p) => p.contains('pi-bot')), isTrue);
    });
  });

  test('品牌常量与服务端保持一致（改一处必须改两处）', () {
    // 服务端 server/src/config.js：
    //   HOME_DIR_NAME = 'orbis'；LEGACY_HOME_DIR_NAME = 'pi-bot'
    expect(stateDirNameNew, 'orbis');
    expect(stateDirNameLegacy, 'pi-bot');
  });
}
