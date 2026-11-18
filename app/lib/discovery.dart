/// 局域网发现：喊一嗓子，服务端应答，于是手机能"看到附近的电脑"。
///
/// 协议（和 `server/src/discovery.js` 一一对应，改一边必须改另一边）：
///
///   App  → 广播 UDP :  {"t":"pibot.discover","v":1}
///   主机 → 单播应答  :  {"t":"pibot.host","v":1,"name":…,"hostname":…,
///                       "version":…,"port":8787,"urls":[…],"pairing":true}
///
/// 为什么不用扫码/手抄 IP：扫码在真机上相机起不来（见 pair_screen 的注释），
/// 手抄 IP 是每次换电脑都要重来一遍的苦活。广播发现是"连上同一个 Wi-Fi 就能看见"，
/// 而真正的安全边界仍然是电脑屏幕上那 6 位配对码 —— 发现不等于授权。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

/// 服务端默认的发现端口（`PI_BOT_DISCOVERY_PORT`）。
const int kDiscoveryPort = 8788;

/// 探针/应答的类型标记。
const String kProbeType = 'pibot.discover';
const String kAnnounceType = 'pibot.host';

/// 局域网里应答的一台 pi-bot 主机。
class DiscoveredHost {
  const DiscoveredHost({
    required this.name,
    required this.hostname,
    required this.version,
    required this.port,
    required this.urls,
    required this.pairing,
    this.approve = false,
    this.tlsPort = 0,
    this.fingerprint = '',
  });

  /// 用户给这台主机起的名字（`PI_BOT_NAME`，默认 "pi-bot"）
  final String name;

  /// 机器名：同一个 Wi-Fi 下有两台 pi-bot 时靠它区分
  final String hostname;

  final String version;
  final int port;

  /// 这台机器可达的地址（局域网 IPv4），第一条优先
  final List<String> urls;

  /// false 表示这台主机用固定 token，没有配对码可填
  final bool pairing;

  /// 支持"请求连接"：手机点一下，电脑上弹窗让人点允许（老版本服务端没有这个字段）
  final bool approve;

  /// 加密监听的端口（0 = 这台主机只有明文 http）
  final int tlsPort;

  /// 证书指纹（sha256 hex）。有了它才谈得上"固定证书"，见 pinned_http.dart
  final String fingerprint;

  /// 是不是走加密链路
  bool get secure => tlsPort > 0 && fingerprint.isNotEmpty;

  /// 列表里显示什么：机器名比 "pi-bot" 有用（两台都是 pi-bot 时只能靠它）
  String get label => hostname.trim().isNotEmpty ? hostname : name;

  /// 从哪个地址连。加密优先：服务端开了 TLS 就给 https，否则退回 http。
  String get url {
    if (urls.isNotEmpty) return urls.first;
    return secure ? 'https://$hostname:$tlsPort' : 'http://$hostname:$port';
  }

  /// 同一台主机的应答可能来自多次探测（255.255.255.255 + 子网广播各一次），
  /// 去重按"机器名 + 端口" —— 同一台机器换 IP（Wi-Fi/有线）也该算同一个条目。
  String get key => '${hostname.toLowerCase()}:$port';

  @override
  String toString() => 'DiscoveredHost($label @ $url)';
}

/// 解析一条应答。只认自家协议；格式不对就丢（返回 null）。
///
/// 独立成纯函数是为了能测：真 UDP 那层在测试里也能跑，但"字段缺失/类型不对"
/// 这种脏数据用纯函数断言更省事。
DiscoveredHost? parseAnnouncement(String text) {
  Object? decoded;
  try {
    decoded = jsonDecode(text);
  } catch (_) {
    return null;
  }
  if (decoded is! Map) return null;
  if (decoded['t'] != kAnnounceType) return null;

  final urls = <String>[];
  final rawUrls = decoded['urls'];
  if (rawUrls is List) {
    for (final item in rawUrls) {
      if (item is String && item.trim().isNotEmpty) urls.add(item.trim());
    }
  }
  final port = decoded['port'] is num
      ? (decoded['port'] as num).toInt()
      : 0;
  final hostname = decoded['hostname'] is String
      ? (decoded['hostname'] as String).trim()
      : '';
  final name = decoded['name'] is String && (decoded['name'] as String).trim().isNotEmpty
      ? (decoded['name'] as String).trim()
      : 'Orbis';
  // 没有地址也没有机器名 —— 这条应答没法连，丢掉。
  if (urls.isEmpty && (hostname.isEmpty || port <= 0)) return null;

  return DiscoveredHost(
    name: name,
    hostname: hostname,
    version: decoded['version'] is String ? decoded['version'] as String : '',
    port: port,
    urls: urls,
    // 缺省当作"要配对码"：宁可多问一次，也不要静默切到 token 模式让用户困惑
    pairing: decoded['pairing'] is bool ? decoded['pairing'] as bool : true,
    // 老服务端没有这个字段 → 只能走配对码
    approve: decoded['approve'] is bool ? decoded['approve'] as bool : false,
    tlsPort: decoded['tls'] is Map && (decoded['tls'] as Map)['port'] is num
        ? ((decoded['tls'] as Map)['port'] as num).toInt()
        : 0,
    fingerprint: decoded['tls'] is Map && (decoded['tls'] as Map)['fingerprint'] is String
        ? (decoded['tls'] as Map)['fingerprint'] as String
        : '',
  );
}

/// 去重并排序：同名同端口的只留一条，按机器名排。
List<DiscoveredHost> mergeHosts(Iterable<DiscoveredHost> hosts) {
  final byKey = <String, DiscoveredHost>{};
  for (final host in hosts) {
    final existing = byKey[host.key];
    if (existing == null) {
      byKey[host.key] = host;
      continue;
    }
    // 两次应答的地址集合可能不同（一台机器有多个网卡）：并起来，别丢。
    final merged = <String>[...existing.urls];
    for (final url in host.urls) {
      if (!merged.contains(url)) merged.add(url);
    }
    byKey[host.key] = DiscoveredHost(
      name: existing.name,
      hostname: existing.hostname,
      version: existing.version.isNotEmpty ? existing.version : host.version,
      port: existing.port,
      urls: merged,
      pairing: existing.pairing && host.pairing,
      approve: existing.approve || host.approve,
      tlsPort: existing.tlsPort != 0 ? existing.tlsPort : host.tlsPort,
      fingerprint: existing.fingerprint.isNotEmpty ? existing.fingerprint : host.fingerprint,
    );
  }
  final list = byKey.values.toList()
    ..sort((a, b) => a.label.toLowerCase().compareTo(b.label.toLowerCase()));
  return list;
}

/// 广播探测一次，返回 [listen] 内应答过来的主机。
///
/// **绝不抛异常**：发现失败只意味着"手动填地址"，不该让整个配对页报错。
/// 返回空列表时，界面要去提示"确认同一个 Wi-Fi / 电脑上服务端在跑"。
///
/// 为什么要 runZonedGuarded 包一层：UDP 广播失败有两种送达方式 ——
/// send() 同步抛（能 try/catch），以及系统把 ICMP 错误当**异步错误**送回来
/// （macOS 的 CI runner 上就是这样，`No route to host` 直接变成未捕获异常）。
/// 后一种只能从 zone 上接。
Future<List<DiscoveredHost>> discoverHosts({
  Duration listen = const Duration(milliseconds: 1600),
  int port = kDiscoveryPort,
}) {
  final found = <DiscoveredHost>[];
  final done = Completer<List<DiscoveredHost>>();
  void finish() {
    if (!done.isCompleted) done.complete(mergeHosts(found));
  }

  runZonedGuarded(() async {
    try {
      await _discoverOnce(listen: listen, port: port, found: found);
    } catch (_) {
      // 兜底：任何一种失败都退化成"没找到"
    }
    finish();
  }, (_, _) => finish());

  return done.future;
}

/// 真正干活的这一段（异常由 [discoverHosts] 兜住）。
Future<void> _discoverOnce({
  required Duration listen,
  required int port,
  required List<DiscoveredHost> found,
}) async {
  RawDatagramSocket? socket;
  try {
    socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
    socket.broadcastEnabled = true;

    final probe = utf8.encode(jsonEncode({'t': kProbeType, 'v': 1}));
    // 有些路由器会吃掉 255.255.255.255，但对本网段的广播地址放行 —— 两个都发。
    // 一张网卡都没有（CI 上的 macOS/容器）时别发广播：send 会抛
    // "No route to host"，而我们只是想"没找到"。
    final subnets = await _subnetBroadcasts();
    final targets = <InternetAddress>[
      if (subnets.isNotEmpty) InternetAddress('255.255.255.255'),
      ...subnets,
    ];

    for (final target in targets) {
      try {
        socket.send(probe, target, port);
      } catch (_) {
        // 某个网卡发不出去（没权限/没网）不影响别的
      }
    }

    final done = Completer<void>();
    late StreamSubscription<RawSocketEvent> sub;
    // onError 必须有：没有广播路由的机器上，系统的 ICMP 错误会以 socket 错误事件
    // 回到这条流里，不接就是未捕获异常 —— 发现失败只该是"没找到"，不该炸掉页面。
    sub = socket.listen(onError: (_) {}, (event) {
      if (event != RawSocketEvent.read) return;
      Datagram? datagram;
      while ((datagram = socket?.receive()) != null) {
        final host = parseAnnouncement(utf8.decode(datagram!.data, allowMalformed: true));
        if (host != null) found.add(host);
      }
    });
    Timer(listen, () {
      if (!done.isCompleted) done.complete();
    });
    await done.future;
    await sub.cancel();
  } catch (_) {
    // 没网、被系统拒绝广播、端口被占 —— 都退化成"没找到"，由界面提示手填
  } finally {
    socket?.close();
  }
}

/// 本机各网卡的 /24 广播地址（192.168.1.37 → 192.168.1.255）。
///
/// 只做 /24 是因为家用/办公 Wi-Fi 基本都是这个掩码；猜错也只是多发几个包。
Future<List<InternetAddress>> _subnetBroadcasts() async {
  final out = <InternetAddress>[];
  try {
    final interfaces = await NetworkInterface.list(
      type: InternetAddressType.IPv4,
      includeLinkLocal: false,
    );
    for (final interface in interfaces) {
      for (final addr in interface.addresses) {
        if (addr.isLoopback || addr.rawAddress.length != 4) continue;
        final bytes = List<int>.from(addr.rawAddress);
        bytes[3] = 255;
        out.add(InternetAddress.fromRawAddress(Uint8List.fromList(bytes)));
      }
    }
  } catch (_) {
    // 拿不到网卡就只靠 255.255.255.255
  }
  return out;
}
