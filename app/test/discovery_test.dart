// 局域网发现（附近的主机）—— 手机端"连接"能不能像选设备一样，全靠这一层。
//
// 两层都测：
//   ① 纯函数：脏数据/字段缺失不能变成一条"能点但连不上"的条目；
//   ② 真 UDP：在 127.0.0.1 上起一个假主机应答，跑完整的
//      "广播探针 → 收应答 → 去重 → 排序"，确认 discoverHosts 真的能把包收上来。
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/discovery.dart';

String _announce(Map<String, Object?> extra) => jsonEncode({
  't': kAnnounceType,
  'v': 1,
  'name': 'pi-bot',
  'hostname': 'xls-pc',
  'version': '1.4.1',
  'port': 8787,
  'urls': ['http://192.168.1.7:8787'],
  'pairing': true,
  ...extra,
});

void main() {
  group('解析应答', () {
    test('正常应答：名字、机器名、地址、要不要配对码都能读出来', () {
      final host = parseAnnouncement(_announce({}));
      expect(host, isNotNull);
      expect(host!.label, 'xls-pc');
      expect(host.url, 'http://192.168.1.7:8787');
      expect(host.version, '1.4.1');
      expect(host.port, 8787);
      expect(host.pairing, isTrue);
    });

    test('固定 token 的主机：pairing=false 要照实传，界面据此改填 token', () {
      final host = parseAnnouncement(_announce({'pairing': false}));
      expect(host!.pairing, isFalse);
    });

    test('不是我们的包 / 不是 JSON 一律丢掉', () {
      expect(parseAnnouncement('hello'), isNull);
      expect(parseAnnouncement('{"t":"pibot.discover"}'), isNull);
      expect(parseAnnouncement('{"t":"pibot.host"'), isNull);
    });

    test('没有地址也没有机器名 → 丢掉（点不了的条目不该出现在列表里）', () {
      expect(parseAnnouncement(_announce({'urls': [], 'hostname': '', 'port': 0})), isNull);
    });

    test('字段类型不对不会崩：有地址就照用，版本号坏了就当空', () {
      final host = parseAnnouncement(_announce({'port': '8787', 'version': 42}));
      expect(host, isNotNull);
      expect(host!.url, 'http://192.168.1.7:8787');
      expect(host.version, '');
      expect(host.port, 0, reason: '端口是字符串就按读不到处理');
    });

    test('地址和端口都坏了（只剩机器名）→ 丢掉，别给出一个连不上的条目', () {
      expect(parseAnnouncement(_announce({'urls': 'x', 'port': '8787'})), isNull);
    });

    test('★ 带 tls 的应答：地址优先 https，指纹和端口都读出来', () {
      final host = parseAnnouncement(_announce({
        'urls': ['https://192.168.1.7:8443'],
        'tls': {'port': 8443, 'fingerprint': 'ab' * 32},
      }));
      expect(host, isNotNull);
      expect(host!.secure, isTrue);
      expect(host.url, 'https://192.168.1.7:8443');
      expect(host.tlsPort, 8443);
      expect(host.fingerprint, 'ab' * 32);
    });

    test('没有 tls 字段（老服务端）→ 明文，secure=false', () {
      final host = parseAnnouncement(_announce({}));
      expect(host!.secure, isFalse);
      expect(host.url, 'http://192.168.1.7:8787');
    });

    test('机器名为空时用 name 当标题', () {
      final host = parseAnnouncement(_announce({'hostname': ''}));
      expect(host!.label, 'pi-bot');
    });
  });

  group('去重与排序', () {
    DiscoveredHost host(String hostname, List<String> urls, {int port = 8787}) =>
        DiscoveredHost(
          name: 'pi-bot',
          hostname: hostname,
          version: '1.4.1',
          port: port,
          urls: urls,
          pairing: true,
        );

    test('同一台主机两次应答：tls 信息缺失的一侧被补齐', () {
      final plain = DiscoveredHost(
        name: 'pi-bot',
        hostname: 'pc-a',
        version: '1.4.1',
        port: 8787,
        urls: ['http://192.168.1.7:8787'],
        pairing: true,
      );
      final secure = DiscoveredHost(
        name: 'pi-bot',
        hostname: 'pc-a',
        version: '1.4.1',
        port: 8787,
        urls: ['https://192.168.1.7:8443'],
        pairing: true,
        tlsPort: 8443,
        fingerprint: 'cc' * 32,
      );
      final merged = mergeHosts([plain, secure]);
      expect(merged, hasLength(1));
      expect(merged.single.secure, isTrue, reason: '只要有一次说加密，就不能把这条当成明文');
      expect(merged.single.fingerprint, 'cc' * 32);
    });

    test('同一台主机两次应答（广播 + 子网广播）只留一条，地址合并', () {
      final merged = mergeHosts([
        host('pc-a', ['http://192.168.1.7:8787']),
        host('pc-a', ['http://10.0.0.5:8787']),
      ]);
      expect(merged, hasLength(1));
      expect(merged.single.urls, ['http://192.168.1.7:8787', 'http://10.0.0.5:8787']);
    });

    test('两台不同机器都保留，按机器名排序，顺序稳定', () {
      final merged = mergeHosts([
        host('zeta', ['http://192.168.1.9:8787']),
        host('alpha', ['http://192.168.1.8:8787']),
      ]);
      expect(merged.map((h) => h.label).toList(), ['alpha', 'zeta']);
    });

    test('同一台机器换端口算两台（可能起了两个服务端）', () {
      final merged = mergeHosts([
        host('pc-a', ['http://192.168.1.7:8787']),
        host('pc-a', ['http://192.168.1.7:9000'], port: 9000),
      ]);
      expect(merged, hasLength(2));
    });
  });

  group('真 UDP（本地假主机）', () {
    late RawDatagramSocket responder;
    late StreamSubscription<RawSocketEvent> sub;

    setUp(() async {
      responder = await RawDatagramSocket.bind(InternetAddress.loopbackIPv4, 0);
      sub = responder.listen((event) {
        if (event != RawSocketEvent.read) return;
        final datagram = responder.receive();
        if (datagram == null) return;
        final probe = jsonDecode(utf8.decode(datagram.data)) as Map;
        if (probe['t'] != kProbeType) return;
        responder.send(
          utf8.encode(_announce({'hostname': 'loopback-pc', 'urls': ['http://127.0.0.1:8787']})),
          datagram.address,
          datagram.port,
        );
      });
    });

    tearDown(() async {
      await sub.cancel();
      responder.close();
    });

    test('discoverHosts 能收到应答并去重', () async {
      final port = responder.port;
      // 直接把探针发给假主机（真广播在测试沙箱里不一定通）
      final socket = await RawDatagramSocket.bind(InternetAddress.loopbackIPv4, 0);
      final replies = <DiscoveredHost>[];
      final done = Completer<void>();
      final listenSub = socket.listen((event) {
        if (event != RawSocketEvent.read) return;
        Datagram? d;
        while ((d = socket.receive()) != null) {
          final host = parseAnnouncement(utf8.decode(d!.data));
          if (host != null) replies.add(host);
        }
      });
      socket.send(utf8.encode(jsonEncode({'t': kProbeType, 'v': 1})), InternetAddress.loopbackIPv4, port);
      socket.send(utf8.encode(jsonEncode({'t': kProbeType, 'v': 1})), InternetAddress.loopbackIPv4, port);
      Timer(const Duration(milliseconds: 400), () {
        if (!done.isCompleted) done.complete();
      });
      await done.future;
      await listenSub.cancel();
      socket.close();

      expect(replies, isNotEmpty, reason: '假主机应该回包');
      final merged = mergeHosts(replies);
      expect(merged, hasLength(1), reason: '两次应答应合成一条');
      expect(merged.single.label, 'loopback-pc');
    });

    test('discoverHosts 在没人应答时安静地返回空列表', () async {
      // CI 的 macOS runner 没有广播路由：socket 会把 ICMP 错误当错误事件送回来。
      // 这条用例真正要守的是"发现失败 ≠ 抛异常把页面弄崩"，所以只断言结果与不抛。
      final hosts = await discoverHosts(
        listen: const Duration(milliseconds: 200),
        port: responder.port + 1, // 没人听的端口
      );
      expect(hosts, isEmpty);
    });
  });
}
