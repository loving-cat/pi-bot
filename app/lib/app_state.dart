import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';
import 'models.dart';
import 'native.dart';
import 'notify.dart';
import 'platform.dart';
import 'text_utils.dart';

/// 全局状态：连接、房间、消息、流式输出。
class AppState extends ChangeNotifier {
  static const _kUrl = 'server_url';
  static const _kToken = 'server_token';
  static const _kDevice = 'device_name';

  String? serverUrl;
  String? token;
  String deviceName = '我的手机';
  Api? api;

  ServerInfo? serverInfo;
  List<Room> rooms = const [];
  List<Bot> bots = const [];
  final Map<String, List<Msg>> messages = {};
  final Map<String, bool> typing = {};

  /// 每个会话里排队/插话中的用户消息条数
  final Map<String, int> queued = {};

  /// App 是不是在前台（不在前台才弹通知）
  bool foreground = true;

  /// 流式输出的高频更新走这个，不走 notifyListeners。
  /// 否则每 80ms 一次 delta 会把整个界面（含左侧会话列表）重建一遍。
  final ValueNotifier<int> streamTick = ValueNotifier<int>(0);
  LinkState link = LinkState.offline;
  String? lastError;
  bool ready = false;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Timer? _reconnectTimer;
  int _attempt = 0;
  bool _disposed = false;
  String? _openRoomId;

  /// 本机模式：桌面端直连 127.0.0.1，服务端信任 loopback，不需要 token
  bool localMode = false;

  bool get paired => serverUrl != null && (localMode || (token ?? '').isNotEmpty);

  /// 已配对的远程设备（设置页用）
  List<Map<String, dynamic>> devices = const [];
  Map<String, dynamic>? pairing;

  // ---------------------------------------------------------------- 启动

  Future<void> bootstrap() async {
    try {
      await _bootstrapInner();
    } catch (err) {
      lastError = "启动失败：$err";
    } finally {
      ready = true;
      _notify();
    }
  }

  Future<void> _bootstrapInner() async {
    final prefs = await SharedPreferences.getInstance();
    serverUrl = prefs.getString(_kUrl);
    token = prefs.getString(_kToken);
    deviceName = prefs.getString(_kDevice) ?? '我的手机';
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
  }

  Future<void> pairWithCode(String url, String code, {String? device}) async {
    final base = normalizeBaseUrl(url);
    final res = await Api.pair(base, code.trim(), device ?? deviceName);
    serverUrl = base;
    token = res['token'] as String;
    localMode = false;
    if (device != null && device.isNotEmpty) deviceName = device;
    api = Api(serverUrl!, token);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kUrl, serverUrl!);
    await prefs.setString(_kToken, token!);
    await prefs.setString(_kDevice, deviceName);
    await refresh();
    connect();
  }

  Future<void> useToken(String url, String rawToken, {String? device}) async {
    serverUrl = normalizeBaseUrl(url);
    token = rawToken.trim();
    localMode = token!.isEmpty;
    if (device != null && device.isNotEmpty) deviceName = device;
    api = Api(serverUrl!, token);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kUrl, serverUrl!);
    await prefs.setString(_kToken, token!);
    await prefs.setString(_kDevice, deviceName);
    await refresh();
    connect();
  }

  Future<void> signOut() async {
    disconnect();
    await Native.stopService();
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kUrl);
    await prefs.remove(_kToken);
    serverUrl = null;
    token = null;
    localMode = false;
    devices = const [];
    pairing = null;
    api = null;
    rooms = const [];
    bots = const [];
    messages.clear();
    serverInfo = null;
    _notify();
  }

  // ---------------------------------------------------------------- HTTP

  Future<void> refresh() async {
    final client = api;
    if (client == null) return;
    try {
      final res = await client.get('/api/state');
      serverInfo = ServerInfo.fromJson(
        (res['server'] as Map?)?.cast<String, dynamic>() ?? const {},
      );
      rooms = ((res['rooms'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(Room.fromJson)
          .toList();
      bots = ((res['bots'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(Bot.fromJson)
          .toList();
      lastError = null;
    } catch (err) {
      lastError = '$err';
    }
    _notify();
  }

  /// 设置页用：当前配对码 / 二维码信息 / 已配对设备
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

  Future<void> loadMessages(String roomId, {bool force = false}) async {
    final client = api;
    if (client == null) return;
    if (!force && messages.containsKey(roomId)) return;
    try {
      final res = await client.get(
        '/api/rooms/$roomId/messages',
        query: {'limit': '200'},
      );
      final list = ((res['messages'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(Msg.fromJson)
          .toList();
      messages[roomId] = list;
      _notify();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  void openRoom(String? roomId) {
    _openRoomId = roomId;
  }

  /// 上传一个本地文件（图片/文档）→ 返回附件元信息
  Future<Attachment?> uploadFile(List<int> bytes, String name) async {
    final client = api;
    if (client == null) return null;
    try {
      final json = await client.upload(bytes, name);
      return Attachment.fromJson(json);
    } catch (err) {
      lastError = '上传失败：$err';
      _notify();
      return null;
    }
  }

  String? fileUrl(String id) => api?.fileUrl(id);

  /// 发消息。busy 时用 steer（插话引导）或 followUp（排队），不报错。
  Future<void> sendMessage(
    String roomId,
    String text, {
    String mode = 'steer',
    List<Attachment> attachments = const [],
  }) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty && attachments.isEmpty) return;
    final ids = attachments.map((a) => a.id).toList();
    final channel = _channel;
    if (channel != null && link == LinkState.online) {
      channel.sink.add(
        jsonEncode({
          't': 'send',
          'roomId': roomId,
          'text': trimmed,
          'mode': mode,
          if (ids.isNotEmpty) 'attachments': ids,
          'clientId': DateTime.now().microsecondsSinceEpoch.toString(),
        }),
      );
      return;
    }
    final client = api;
    if (client == null) return;
    try {
      await client.post('/api/rooms/$roomId/send', {
        'text': trimmed,
        'mode': mode,
        if (ids.isNotEmpty) 'attachments': ids,
      });
    } catch (err) {
      lastError = '$err';
      _notify();
      rethrow;
    }
  }

  Future<void> abort(String roomId) async {
    try {
      final channel = _channel;
      if (channel != null && link == LinkState.online) {
        channel.sink.add(jsonEncode({'t': 'abort', 'roomId': roomId}));
      } else {
        await api?.post('/api/rooms/$roomId/abort');
      }
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<void> resetSession(String roomId) async {
    try {
      await api?.post('/api/rooms/$roomId/reset');
      messages[roomId] = [];
      _notify();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<Room?> createRoom(String name) async {
    return createGroup(name);
  }

  Future<Room?> createGroup(
    String name, {
    String? topic,
    List<String>? botIds,
    String? leadBotId,
  }) async {
    try {
      final res = await api?.post('/api/rooms', {
        'name': name,
        if (topic != null) 'topic': topic,
        if (botIds != null) 'botIds': botIds,
        if (leadBotId != null) 'leadBotId': leadBotId,
      });
      final room = Room.fromJson((res?['room'] as Map).cast<String, dynamic>());
      final idx = rooms.indexWhere((r) => r.id == room.id);
      if (idx >= 0) {
        rooms = [...rooms]..[idx] = room;
      } else {
        rooms = [...rooms, room];
      }
      messages[room.id] = [];
      _notify();
      return room;
    } catch (err) {
      lastError = '$err';
      _notify();
      return null;
    }
  }

  /// 拿到（或新建）和某个 bot 的私聊
  Future<Room?> ensureDm(String botId) async {
    try {
      final res = await api?.post('/api/rooms/dm', {'botId': botId});
      final room = Room.fromJson((res?['room'] as Map).cast<String, dynamic>());
      final idx = rooms.indexWhere((r) => r.id == room.id);
      if (idx >= 0) {
        rooms = [...rooms]..[idx] = room;
      } else {
        rooms = [...rooms, room];
      }
      _notify();
      return room;
    } catch (err) {
      lastError = '$err';
      _notify();
      return null;
    }
  }

  Future<void> deleteRoom(String roomId) async {
    try {
      await api?.delete('/api/rooms/$roomId');
      rooms = rooms.where((r) => r.id != roomId).toList();
      messages.remove(roomId);
      _notify();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<Bot?> createBot({
    required String name,
    String persona = '',
    String? emoji,
    String? model,
    String? thinking,
  }) async {
    try {
      final res = await api?.post('/api/bots', {
        'name': name,
        'persona': persona,
        if (emoji != null) 'emoji': emoji,
        if (model != null) 'model': model,
        if (thinking != null) 'thinking': thinking,
      });
      final bot = Bot.fromJson((res?['bot'] as Map).cast<String, dynamic>());
      bots = [...bots, bot];
      _notify();
      return bot;
    } catch (err) {
      lastError = '$err';
      _notify();
      return null;
    }
  }

  Future<void> deleteBot(String botId) async {
    try {
      await api?.delete('/api/bots/$botId');
      bots = bots.where((b) => b.id != botId).toList();
      _notify();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<void> updateBot(String botId, Map<String, dynamic> patch) async {
    try {
      await api?.patch('/api/bots/$botId', patch);
      await refresh();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  // ---------------------------------------------------------------- WS

  void connect() {
    final client = api;
    if (client == null || _disposed) return;
    disconnect(keepConfig: true);
    link = LinkState.connecting;
    _notify();
    try {
      final channel = WebSocketChannel.connect(Uri.parse(client.wsUrl));
      _channel = channel;
      _sub = channel.stream.listen(
        _onFrame,
        onError: (Object err) => _onClosed('$err'),
        onDone: () => _onClosed('连接已断开'),
        cancelOnError: true,
      );
    } catch (err) {
      _onClosed('$err');
    }
  }

  void _onFrame(dynamic raw) {
    Map<String, dynamic> ev;
    try {
      ev = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (ev['t'] as String?) {
      case 'hello':
        link = LinkState.online;
        unawaited(Native.startService());
        _attempt = 0;
        lastError = null;
        serverInfo = ServerInfo.fromJson(
          (ev['server'] as Map?)?.cast<String, dynamic>() ?? const {},
        );
        rooms = ((ev['rooms'] as List?) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(Room.fromJson)
            .toList();
        bots = ((ev['bots'] as List?) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(Bot.fromJson)
            .toList();
        final open = _openRoomId;
        if (open != null) unawaited(loadMessages(open, force: true));
        break;

      case 'msg.new':
        final msg = Msg.fromJson((ev['msg'] as Map).cast<String, dynamic>());
        final list = messages.putIfAbsent(msg.roomId, () => []);
        if (!list.any((m) => m.id == msg.id)) list.add(msg);
        _touchRoom(msg.roomId, msg);
        break;

      case 'msg.delta':
        final msg = _find(ev['roomId'] as String, ev['msgId'] as String);
        if (msg != null) {
          msg.text = ev['text'] as String? ?? msg.text;
          msg.status = 'streaming';
          streamTick.value++;
          return; // 不走 notifyListeners
        }
        break;

      case 'msg.steps':
        final msg = _find(ev['roomId'] as String, ev['msgId'] as String);
        if (msg != null) {
          msg.steps = ((ev['steps'] as List?) ?? const [])
              .whereType<Map<String, dynamic>>()
              .map(ToolStep.fromJson)
              .toList();
          streamTick.value++;
          return; // 不走 notifyListeners
        }
        break;

      case 'msg.updated':
      case 'msg.done': {
        final msg = Msg.fromJson((ev['msg'] as Map).cast<String, dynamic>());
        _replace((ev['msg'] as Map).cast<String, dynamic>());
        _maybeNotify(msg);
        break;
      }

      case 'msg.error':
        final roomId = ev['roomId'] as String?;
        final msgId = ev['msgId'] as String?;
        final msg = (roomId != null && msgId != null)
            ? _find(roomId, msgId)
            : null;
        if (msg != null) {
          msg.status = 'error';
          msg.error = ev['error'] as String?;
        }
        if (ev['msg'] is Map)
          _replace((ev['msg'] as Map).cast<String, dynamic>());
        lastError = ev['error'] as String?;
        break;

      case 'msg.deleted':
        final roomId = ev['roomId'] as String?;
        final msgId = ev['msgId'] as String?;
        if (roomId != null && msgId != null) {
          messages[roomId]?.removeWhere((m) => m.id == msgId);
        }
        break;

      case 'typing':
        typing[ev['roomId'] as String] = ev['active'] as bool? ?? false;
        if (ev['active'] != true) queued.remove(ev['roomId']);
        break;

      case 'queue':
        final roomId = ev['roomId'] as String?;
        if (roomId != null) {
          final n =
              ((ev['steering'] as List?)?.length ?? 0) +
              ((ev['followUp'] as List?)?.length ?? 0);
          if (n > 0) {
            queued[roomId] = n;
          } else {
            queued.remove(roomId);
          }
        }
        break;

      case 'steer.accepted':
        final roomId = ev['roomId'] as String?;
        if (roomId != null) queued[roomId] = (queued[roomId] ?? 0) + 1;
        break;

      case 'room.created':
      case 'room.updated':
        final room = Room.fromJson((ev['room'] as Map).cast<String, dynamic>());
        final idx = rooms.indexWhere((r) => r.id == room.id);
        if (idx >= 0) {
          rooms = [...rooms]..[idx] = room;
        } else {
          rooms = [...rooms, room];
        }
        rooms = [...rooms]..sort(_roomOrder);
        break;

      case 'room.deleted':
        final roomId = ev['roomId'] as String?;
        if (roomId != null) {
          rooms = rooms.where((r) => r.id != roomId).toList();
          messages.remove(roomId);
        }
        break;

      case 'bot.updated':
      case 'bot.created':
        final bot = Bot.fromJson((ev['bot'] as Map).cast<String, dynamic>());
        final idx = bots.indexWhere((b) => b.id == bot.id);
        if (idx >= 0) {
          bots = [...bots]..[idx] = bot;
        } else {
          bots = [...bots, bot];
        }
        break;

      case 'bot.deleted':
        final botId = ev['botId'] as String?;
        if (botId != null) bots = bots.where((b) => b.id != botId).toList();
        break;

      case 'error':
        lastError = ev['error'] as String?;
        break;

      case 'pong':
      case 'ack':
      case 'room.reset':
        return;
    }
    _notify();
  }

  /// 不在前台、或不是当前打开的房间 → 弹本地通知
  void _maybeNotify(Msg msg) {
    if (msg.authorType != 'bot') return;
    final text = msg.text.trim();
    if (text.isEmpty) return;
    if (foreground && _openRoomId == msg.roomId) return;
    final room = rooms.where((r) => r.id == msg.roomId).firstOrNull;
    Notifier.show(
      title: room?.isGroup == true ? '${room!.name} · ${msg.authorName}' : msg.authorName,
      body: preview(text, 120),
      roomId: msg.roomId,
    );
  }

  void _touchRoom(String roomId, Msg msg) {
    final idx = rooms.indexWhere((r) => r.id == roomId);
    if (idx >= 0) {
      final room = rooms[idx];
      room.lastMessage = msg;
      room.lastMessageAt = msg.createdAt;
      rooms = [...rooms]..sort(_roomOrder);
    }
  }

  /// 主控 DM 置顶，其他按最新消息排
  int _roomOrder(Room a, Room b) {
    final mainId = bots.where((x) => x.isMain).map((x) => x.id).firstOrNull;
    final aPin = !a.isGroup && a.botIds.contains(mainId) ? 1 : 0;
    final bPin = !b.isGroup && b.botIds.contains(mainId) ? 1 : 0;
    if (aPin != bPin) return bPin - aPin;
    return b.lastMessageAt.compareTo(a.lastMessageAt);
  }

  Bot? botById(String? id) {
    if (id == null) return null;
    for (final b in bots) {
      if (b.id == id) return b;
    }
    return null;
  }

  Bot? get mainBot {
    for (final b in bots) {
      if (b.isMain) return b;
    }
    return bots.isEmpty ? null : bots.first;
  }

  Msg? _find(String roomId, String msgId) {
    final list = messages[roomId];
    if (list == null) return null;
    for (final m in list) {
      if (m.id == msgId) return m;
    }
    return null;
  }

  void _replace(Map<String, dynamic> json) {
    final msg = Msg.fromJson(json);
    final list = messages.putIfAbsent(msg.roomId, () => []);
    final idx = list.indexWhere((m) => m.id == msg.id);
    if (idx >= 0) {
      list[idx] = msg;
    } else {
      list.add(msg);
    }
    _touchRoom(msg.roomId, msg);
  }

  void _onClosed(String reason) {
    _channel = null;
    _sub = null;
    if (_disposed) return;
    link = LinkState.offline;
    if (reason.isNotEmpty && !reason.contains('连接已断开')) lastError = reason;
    _notify();
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    if (!paired || _disposed) return;
    final delay = Duration(
      seconds: [1, 2, 3, 5, 8, 13, 20][_attempt.clamp(0, 6)],
    );
    _attempt++;
    _reconnectTimer = Timer(delay, () {
      if (_disposed) return;
      connect();
    });
  }

  void disconnect({bool keepConfig = false}) {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _sub?.cancel();
    _sub = null;
    try {
      _channel?.sink.close();
    } catch (_) {}
    _channel = null;
    if (!keepConfig) {
      link = LinkState.offline;
      _notify();
    }
  }

  void clearError() {
    lastError = null;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    disconnect();
    streamTick.dispose();
    super.dispose();
  }
}
