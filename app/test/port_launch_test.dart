import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/options.dart';
import 'package:pi_bot/server/port_picker.dart';

/// 端口自适应在启动器层面的契约：实际端口必须能回传到调用方。
///
/// 真实的探测与启动需要网络和子进程，这些只测数据结构与偏好值保持。
void main() {
  group('ServerLaunchResult 回传实际端口', () {
    test('★ 成功时可以带上实际端口', () {
      const r = ServerLaunchResult(
        ok: true,
        alreadyRunning: false,
        port: 8788,
        notice: '8787 被占用，已改用 8788',
      );
      expect(r.ok, true);
      expect(r.port, 8788);
      expect(r.notice, contains('8788'));
    });

    test('没有端口信息时 portOr 退回偏好值', () {
      const r = ServerLaunchResult(ok: true, alreadyRunning: true);
      expect(r.port, isNull);
      expect(r.portOr(8787), 8787);
    });

    test('失败时也可以带上次试过的端口，便于排查', () {
      const r = ServerLaunchResult(
        ok: false,
        alreadyRunning: false,
        port: 8800,
        error: '端口全被占',
      );
      expect(r.ok, false);
      expect(r.port, 8800);
    });
  });

  group('ServerLaunchOptions 的端口语义', () {
    test('★ port 字段始终是偏好值，不被实际端口改写', () {
      const o = ServerLaunchOptions(port: 8787);
      expect(o.port, 8787);
      // 换端口只影响环境变量，不改偏好
      final env = o.envForPort(8788);
      expect(env['PI_BOT_PORT'], '8788');
      expect(o.port, 8787, reason: '偏好端口必须保持不变');
    });

    test('env 用的是偏好端口', () {
      const o = ServerLaunchOptions(port: 9000);
      expect(o.env['PI_BOT_PORT'], '9000');
    });

    test('数据目录在换端口时保持不变', () {
      const o = ServerLaunchOptions(port: 8787, dataDir: '/tmp/pb-data');
      final env = o.envForPort(8788);
      expect(env['PI_BOT_PORT'], '8788');
      expect(env['PI_BOT_HOME'], '/tmp/pb-data');
    });

    test('没设数据目录时不写 PI_BOT_HOME', () {
      const o = ServerLaunchOptions(port: 8787);
      expect(o.envForPort(8788).containsKey('PI_BOT_HOME'), false);
    });

    test('两个不同端口的 options 不相等（设置变化能被识别）', () {
      const a = ServerLaunchOptions(port: 8787);
      const b = ServerLaunchOptions(port: 8788);
      expect(a == b, false);
      expect(a.hashCode == b.hashCode, false);
    });
  });

  group('真实端口探测（本机回环）', () {
    test('探测一个肯定空闲的高位端口 → free', () async {
      // 绑一个随机高位端口再立刻释放，确保它是空的
      final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final port = probe.port;
      await probe.close();
      final kind = await probePort(port);
      expect(kind, PortProbeKind.free);
    });

    test('★ 探测一个被 bind 占着的端口 → 不是 free', () async {
      // 关键：这个端口**服务端还没有 listen**，只是被别的东西 bind 了。
      // 老实现只看「连得上吗」，连不上就当 free —— 于是这种端口会被选中，
      // spawn 出去服务端 bind 失败立刻 exit 1，用户看到"启动失败"。
      // 新实现在判 free 前会试绑一次，所以这里必然是 occupied。
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final port = server.port;
      try {
        final kind = await probePort(port);
        expect(kind, isNot(PortProbeKind.free),
            reason: '被 bind 占着的端口不能判成 free');
      } finally {
        await server.close();
      }
    });

    test('★ 监听中的端口 → occupied 或 piBot，绝不是 free', () async {
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final port = server.port;
      try {
        final kind = await probePort(port);
        expect(
          kind,
          anyOf(PortProbeKind.occupied, PortProbeKind.piBot),
          reason: '有人在听的端口只能是这两个之一',
        );
      } finally {
        await server.close();
      }
    });

    test('释放之后立刻可以判成 free', () async {
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final port = server.port;
      await server.close();
      // 关掉后端口应该可以被试绑 → free
      final kind = await probePort(port);
      expect(kind, PortProbeKind.free);
    });
  });

  group('权限错误判为 blocked（注入式）', () {
    test('★ blocked 的端口在选端口时会被跳过', () async {
      // 真实环境里非 root 绑 1024 以下会 EACCES，但测试机可能是 root，
      // 也可能有别的限制 —— 用注入的方式验证 choosePort 的处理路径。
      final r = await choosePort(
        8787,
        probe: (p) async => switch (p) {
          8787 => PortProbeKind.blocked,
          8788 => PortProbeKind.free,
          _ => PortProbeKind.occupied,
        },
      );
      expect(r.port, 8788, reason: '无权限的端口必须跳过');
      expect(r.notice, contains('没有权限'));
    });

    test('blocked 时不会把它当成可用端口返回', () async {
      final r = await choosePort(
        8787,
        maxAttempts: 3,
        probe: (p) async => p == 8787 ? PortProbeKind.blocked : PortProbeKind.free,
      );
      expect(r.port, 8788);
      expect(r.port, isNot(8787));
    });
  });
}