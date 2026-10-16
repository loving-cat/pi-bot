const fs = require('fs');
const p = 'lib/app_state.dart';
let s = fs.readFileSync(p, 'utf8');

s = s.replace(
  "import 'api.dart';\nimport 'models.dart';",
  "import 'api.dart';\nimport 'models.dart';\nimport 'platform.dart';",
);

s = s.replace(
  `  bool get paired => serverUrl != null && (token ?? '').isNotEmpty;`,
  `  /// 本机模式：桌面端直连 127.0.0.1，服务端信任 loopback，不需要 token
  bool localMode = false;

  bool get paired => serverUrl != null && (localMode || (token ?? '').isNotEmpty);

  /// 已配对的远程设备（设置页用）
  List<Map<String, dynamic>> devices = const [];
  Map<String, dynamic>? pairing;`,
);

s = s.replace(
  `    ready = true;
    if (paired) {
      api = Api(serverUrl!, token);
      unawaited(refresh());
      connect();
    }
    _notify();
  }`,
  `    ready = true;
    if (paired) {
      api = Api(serverUrl!, token ?? '');
      unawaited(refresh());
      connect();
    } else if (isHostPlatform) {
      // 桌面端就是宿主：直连本机，不走配对
      await connectLocal();
    }
    _notify();
  }

  /// 桌面端：直连本机服务端
  Future<void> connectLocal({String url = localServerUrl}) async {
    localMode = true;
    serverUrl = url;
    token = '';
    api = Api(url, '');
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kUrl, url);
    await prefs.setString(_kToken, '');
    await refresh();
    connect();
  }`,
);

s = s.replace(
  `    serverUrl = base;
    token = res['token'] as String;
    if (device != null && device.isNotEmpty) deviceName = device;`,
  `    serverUrl = base;
    token = res['token'] as String;
    localMode = false;
    if (device != null && device.isNotEmpty) deviceName = device;`,
);

s = s.replace(
  `  Future<void> useToken(String url, String rawToken, {String? device}) async {
    serverUrl = normalizeBaseUrl(url);
    token = rawToken.trim();
    if (device != null && device.isNotEmpty) deviceName = device;`,
  `  Future<void> useToken(String url, String rawToken, {String? device}) async {
    serverUrl = normalizeBaseUrl(url);
    token = rawToken.trim();
    localMode = token!.isEmpty;
    if (device != null && device.isNotEmpty) deviceName = device;`,
);

s = s.replace(
  `    serverUrl = null;
    token = null;
    api = null;`,
  `    serverUrl = null;
    token = null;
    localMode = false;
    devices = const [];
    pairing = null;
    api = null;`,
);

// 拉配对信息 + 已配对设备
s = s.replace(
  `  Future<void> loadMessages(String roomId, {bool force = false}) async {`,
  `  /// 设置页用：当前配对码 / 二维码信息 / 已配对设备
  Future<void> loadPairingInfo() async {
    final client = api;
    if (client == null) return;
    try {
      final p = await client.get('/api/pairing');
      pairing = p.containsKey('static') ? null : p;
      final d = await client.get('/api/devices');
      devices = ((d['devices'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .toList();
    } catch (err) {
      lastError = '$err';
    }
    _notify();
  }

  Future<void> revokeDevice(String token) async {
    try {
      await api?.delete('/api/devices/$token');
      await loadPairingInfo();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<void> loadMessages(String roomId, {bool force = false}) async {`,
);

fs.writeFileSync(p, s);
console.log('app_state 补丁完成');
