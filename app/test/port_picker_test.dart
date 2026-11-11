import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/port_picker.dart';

/// 用假的探测函数驱动 choosePort：不碰真网络，纯逻辑可测。
void main() {
  group('偏好端口可用时', () {
    test('偏好端口空着 → 直接用偏好端口，没有提示', () async {
      final r = await choosePort(8787, probe: (p) async => PortProbeKind.free);
      expect(r.port, 8787);
      expect(r.reused, false);
      expect(r.notice, isNull);
      expect(r.problem, isNull);
    });

    test('★ 偏好端口上已是健康 pi-bot → 复用，不新起', () async {
      final r = await choosePort(
        8787,
        probe: (p) async =>
            p == 8787 ? PortProbeKind.piBot : PortProbeKind.free,
      );
      expect(r.port, 8787);
      expect(r.reused, true, reason: '应复用已有实例');
      expect(r.problem, isNull);
    });
  });

  group('偏好端口被占用时', () {
    test('★ 被非 pi-bot 占用、下一个空闲 → 用下一个，带实际端口', () async {
      final r = await choosePort(
        8787,
        probe: (p) async => switch (p) {
          8787 => PortProbeKind.occupied,
          8788 => PortProbeKind.free,
          _ => PortProbeKind.occupied,
        },
      );
      expect(r.port, 8788);
      expect(r.reused, false);
      expect(r.notice, contains('8787'));
      expect(r.notice, contains('8788'));
    });

    test('★ 邻口上已有 pi-bot → 不复用，继续往后找', () async {
      final r = await choosePort(
        8787,
        probe: (p) async => switch (p) {
          8787 => PortProbeKind.occupied,
          8788 => PortProbeKind.piBot, // 邻口的 pi-bot 也不能连
          8789 => PortProbeKind.free,
          _ => PortProbeKind.occupied,
        },
      );
      expect(r.port, 8789, reason: '应跳过邻口的 pi-bot');
      expect(r.reused, false);
    });

    test('连续多个被占，找到第一个空闲的', () async {
      final r = await choosePort(
        8787,
        probe: (p) async => p < 8792 ? PortProbeKind.occupied : PortProbeKind.free,
      );
      expect(r.port, 8792);
    });

    test('无权限的端口也跳过', () async {
      final r = await choosePort(
        8787,
        probe: (p) async => switch (p) {
          8787 => PortProbeKind.blocked,
          8788 => PortProbeKind.free,
          _ => PortProbeKind.occupied,
        },
      );
      expect(r.port, 8788);
      expect(r.notice, contains('没有权限'));
    });
  });

  group('全部不可用', () {
    test('★ 探测范围内全被占 → 失败，原因可读', () async {
      final r = await choosePort(
        8787,
        maxAttempts: 20,
        probe: (p) async => PortProbeKind.occupied,
      );
      expect(r.problem, isNotNull);
      expect(r.problem, contains('8787'));
      expect(r.problem, contains('设置'));
      expect(r.reused, false);
    });

    test('试的次数不超过上限', () async {
      final tried = <int>[];
      await choosePort(
        8787,
        maxAttempts: 5,
        probe: (p) async {
          tried.add(p);
          return PortProbeKind.occupied;
        },
      );
      // 偏好端口 1 次 + 往后 5 次
      expect(tried.length, 6);
      expect(tried.first, 8787);
      expect(tried.last, 8792);
    });

    test('端口号不会越过 65535', () async {
      final tried = <int>[];
      await choosePort(
        65534,
        maxAttempts: 20,
        probe: (p) async {
          tried.add(p);
          return PortProbeKind.occupied;
        },
      );
      expect(tried.every((p) => p <= 65535), true);
    });
  });

  group('偏好端口不被改动', () {
    test('★ 换端口后，调用方传的偏好值不被修改', () async {
      const preferred = 8787;
      final r = await choosePort(
        preferred,
        probe: (p) async =>
            p == preferred ? PortProbeKind.occupied : PortProbeKind.free,
      );
      expect(r.port, isNot(preferred), reason: '应该换到别的端口');
      expect(preferred, 8787, reason: '偏好值是 const，不该被改');
    });
  });

  group('提示文案', () {
    test('换端口时给出人话提示', () async {
      final r = await choosePort(
        8787,
        probe: (p) async =>
            p == 8787 ? PortProbeKind.occupied : PortProbeKind.free,
      );
      expect(r.notice, isNotNull);
      expect(r.notice, contains('已改用'));
    });

    test('偏好端口直接可用时没有提示', () async {
      final r = await choosePort(8787, probe: (p) async => PortProbeKind.free);
      expect(r.notice, isNull);
    });
  });
}