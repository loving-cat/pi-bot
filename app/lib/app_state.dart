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
import 'server_launcher.dart';
import 'text_utils.dart';

/// 全局状态：连接、房间、消息、流式输出。
/// 把新成员接到名单后面：去重、保持原有顺序。
///
/// 抽成纯函数是为了能单测 —— "加人之后名单长什么样"这种事，
/// 一旦只靠网络往返验证，就没人真的验过它了。
List<String> mergeMemberIds(List<String> current, List<String> added) {
  final out = [...current];
  for (final id in added) {
    if (!out.contains(id)) out.add(id);
  }
  return out;
}

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

  /// 用户自己配的模型组（key 是打码的 —— 真 key 不出服务端）
  List<ModelGroup> modelGroups = const [];
  final Map<String, List<Msg>> messages = {};
  final Map<String, bool> typing = {};

  /// 每个会话里排队/插话中的用户消息条数
  final Map<String, int> queued = {};

  /// 上下文占用，key 是 `房间:bot`（服务端 /api/state 和 context 事件都按这个格式给）
  final Map<String, ContextInfo> contexts = {};

  /// 群聊轮次预算（防止 bot 解不了就互相聊个没完）
  Map<String, int> groupLimits = const {};

  /// 部门规矩（危险动作 / 交付要附证据）。
  /// 服务端一直在收，界面以前没有入口 —— 用户只能看着 bot 随便跑命令。
  Map<String, dynamic> policy = const {'dangerous': 'allow', 'requireProof': false};

  /// 用户自己叫什么。
  /// bot 的系统提示里会用这个名字称呼你（服务端拼进去的），
  /// 界面上左上角显示它 —— 显示主机名没意义，那是机器的名字，不是人的。
  String userName = '';

  /// 右侧详情面板开着没（点聊天顶部胶囊开的）。
  ///
  /// 放 AppState 里是因为它**跨了两个层**：胶囊在 ChatScreen 里，
  /// 而面板本身是 HomeShell 布局里的一栏 —— 需要一个共同的地方放这个开关。
  bool panelOpen = false;

  void togglePanel() {
    panelOpen = !panelOpen;
    _notify();
  }

  void closePanel() {
    if (!panelOpen) return;
    panelOpen = false;
    _notify();
  }

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

  /// 本机服务端是不是正在拉起（界面据此显示"正在启动"而不是"连不上"）
  bool serverStarting = false;

  /// 拉不起来时给人看的原因（找不到 node / 端口没应答 / 试过哪些路径）
  String? serverProblem;

  /// 服务端进程的日志尾部（诊断用，失败时贴在界面上）
  List<String> serverLog = const [];
  int _lastServerNotify = 0;

  /// 本机服务端的巡检：因为任何原因挂了（被系统杀掉、端口被抢、异常退出）
  /// 都自动拉回来 —— 用户不该为了这个重启 App。
  Timer? _serverWatch;
  DateTime _lastSpawnAt = DateTime.fromMillisecondsSinceEpoch(0);
  int _spawnFails = 0;

  bool get paired =>
      serverUrl != null && (localMode || (token ?? '').isNotEmpty);

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
      // 桌面端就是宿主：**先把服务端拉起来**，再直连本机（不走配对）。
      //
      //   以前这里只做了一半 —— 直接连 127.0.0.1:8787 当作"服务端就在那儿"，
      //   但没人去起它。双击 exe 后看到的是"离线 · 自动重连中"，永远连不上。
      await bootLocalServer();
      _startServerWatchdog();
    }
    _notify();
  }

  /// 桌面端启动：确保本机服务端在跑（没有就拉起来），然后连它。
  ///
  /// 幂等：端口上已经有人在听就只是连上去（第二次打开 App 不会再拉一个进程）。
  Future<void> bootLocalServer() async {
    if (!isHostPlatform) return;
    if (serverStarting) return;
    _lastSpawnAt = DateTime.now();
    serverStarting = true;
    serverProblem = null;
    _notify();
    try {
      final result = await ensureLocalServer(
        baseUrl: localServerUrl,
        onProgress: () {
          // 探活是 300ms 一轮，别把整棵树按这个频率重建
          final t = DateTime.now().millisecondsSinceEpoch;
          if (t - _lastServerNotify < 700) return;
          _lastServerNotify = t;
          serverLog = serverLogTail;
          _notify();
        },
      );
      serverProblem = result.ok ? null : result.error;
    } finally {
      serverStarting = false;
      serverLog = serverLogTail;
      _notify();
    }
    await connectLocal();
  }

  /// 每 4s 看一次：本机服务端不在就拉回来（带退避，别把机器拖死）。
  void _startServerWatchdog() {
    _serverWatch?.cancel();
    _lastSpawnAt = DateTime.now();
    _serverWatch = Timer.periodic(const Duration(seconds: 4), (_) async {
      if (_disposed || !isHostPlatform || !localMode) return;
      if (link == LinkState.online || serverStarting) {
        if (link == LinkState.online) _spawnFails = 0;
        return;
      }
      // _lastSpawnAt 已经在 bootLocalServer 里刷新过，这里只判断退避
      final backoff = Duration(seconds: const [0, 4, 8, 15, 30][_spawnFails.clamp(0, 4)]);
      if (DateTime.now().difference(_lastSpawnAt) < backoff) return;
      await bootLocalServer();
      if (link != LinkState.online) _spawnFails++;
    });
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
      modelGroups = ((res['modelGroups'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(ModelGroup.fromJson)
          .toList();
      // 用户自己叫什么（bot 用它称呼你）。漏了这句左上角就会退回显示服务端地址。
      userName = ((res['user'] as Map?)?['name'] as String?)?.trim() ?? '';
      policy =
          ((res['policy'] as Map?) ?? const {'dangerous': 'allow', 'requireProof': false})
              .cast<String, dynamic>();
      groupLimits = ((res['groupLimits'] as Map?) ?? const {}).map(
        (k, v) => MapEntry('$k', (v as num?)?.toInt() ?? 0),
      );
      final ctx = (res['context'] as Map?)?.cast<String, dynamic>() ?? const {};
      contexts
        ..clear()
        ..addAll(
          ctx.map(
            (k, v) => MapEntry(
              k,
              ContextInfo.fromJson((v as Map).cast<String, dynamic>()),
            ),
          ),
        );
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

  /// 「请切到某个会话」的一次性请求 —— 点 @提及 / 点引用气泡 / 点通知这些
  /// **外部入口**用。
  ///
  /// 为什么不直接用 openRoom：那个是"我正在看哪个房间"，由 ChatScreen 在
  /// didChangeDependencies / dispose 里维护 —— 那两处都在 build 阶段附近，
  /// 不能触发通知；而且它一变，分栏布局的选中项会被 ChatScreen 的生命周期带跑
  /// （切房间时旧页面 dispose 会把它清成 null，于是又跳回第一个会话）。
  /// 两个语义不同，所以分开。
  String? _pendingRoomId;

  /// 请求切到某个会话（会通知界面，由 HomeShell 决定怎么切）
  void requestRoom(String roomId) {
    _pendingRoomId = roomId;
    _notify();
  }

  /// 取走待处理的切房间请求（取走即清空，只生效一次）
  String? takePendingRoom() {
    final id = _pendingRoomId;
    _pendingRoomId = null;
    return id;
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
    // ★ 先当场把界面停下来，再去告诉服务端。
    //
    //   用户原话：“这个终止按钮 我点了要立即反应 立即终止，现在都要等很久。”
    //   以前这里只发了个请求（走 WS），本地什么都不动 —— 于是服务端那边
    //   真的在收尾，用户看到的却是**转圈照转、消息照流**，自然觉得“没反应”。
    //   服务端的 session 可能正卡在一个长命令里，几秒到几分钟才真的断。
    //   所以这里乐观地先改本地状态：说停就停。
    typing[roomId] = false;
    queued[roomId] = 0;
    for (final m in messages[roomId] ?? const <Msg>[]) {
      if (m.status == 'streaming') {
        m.status = 'error';
        m.error = '已按你的要求终止';
        for (final s in m.steps) {
          if (s.status == 'running') s.status = 'error';
        }
      }
    }
    _notify();
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

  /// 改会话属性（置顶 / 隐藏 / 标为未读 / 改名）。
  /// 改完拉一次全量 —— 置顶会改变排序，只打补丁的话列表顺序会不对。
  Future<void> updateRoom(String roomId, Map<String, dynamic> patch) async {
    try {
      await api?.patch('/api/rooms/$roomId', patch);
      await refresh();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  /// 把一个 bot 移出群。
  ///
  /// 服务端的 updateRoom 收 botIds 时会顺手把老大改掉（如果被移走的正好是老大），
  /// 所以这里只要把"去掉他之后的名单"发过去就行。
  Future<void> removeBotFromRoom(String roomId, String botId) async {
    try {
      final room = rooms.firstWhere(
        (r) => r.id == roomId,
        orElse: () => Room(id: '', name: '', kind: '', botIds: const []),
      );
      final next = room.botIds.where((id) => id != botId).toList();
      await api?.patch('/api/rooms/$roomId', {'botIds': next});
      await refresh();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  /// 往群里加 bot —— 用户自己加成员（不用再跟主控说）。
  ///
  /// 服务端收 botIds 时本来就会：过滤掉不存在的 bot、名单里没有老大时顺手指定一个，
  /// 所以这里只负责"接在后面 + 去重"。
  Future<void> addBotsToRoom(String roomId, List<String> botIds) async {
    if (botIds.isEmpty) return;
    try {
      final room = rooms.firstWhere(
        (r) => r.id == roomId,
        orElse: () => Room(id: '', name: '', kind: '', botIds: const []),
      );
      await api?.patch('/api/rooms/$roomId', {
        'botIds': mergeMemberIds(room.botIds, botIds),
      });
      await refresh();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  /// 改"我叫什么"。服务端会把它写进每个 bot 的系统提示（下一轮生效）。
  Future<void> saveUserName(String name) async {
    try {
      await api?.patch('/api/user', {'name': name});
      await refresh();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  /// 改群聊轮次预算。服务端会挡掉非法值（0/负数会被保持原值），
  /// 所以这里不用自己校验，改完拉一次就是真值。
  /// 把一个部门存成模板（只存班子，不存聊天记录）。返回错误文案或 null。
  Future<String?> saveTemplateFromRoom(String roomId, String name) async {
    try {
      await api?.post('/api/templates', {'roomId': roomId, 'name': name});
      await refresh();
      return null;
    } catch (err) {
      lastError = '$err';
      _notify();
      return '$err';
    }
  }

  /// 改部门规矩（危险动作 / 要不要附证据）
  Future<void> savePolicy(Map<String, dynamic> patch) async {
    try {
      await api?.patch('/api/policy', patch);
      await refresh();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<void> saveGroupLimits(Map<String, dynamic> patch) async {
    try {
      await api?.patch('/api/group-limits', patch);
      await refresh();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  // ---------------------------------------------------------------- 模型组

  /// 新增或更新一个模型组。`id` 为空 = 新增。
  /// 服务端会**热注册**，不用重启就能在模型列表里选到。
  Future<String?> saveModelGroup(Map<String, dynamic> patch) async {
    try {
      final id = patch['id'] as String?;
      if (id == null || id.isEmpty) {
        await api?.post('/api/model-groups', patch);
      } else {
        await api?.patch('/api/model-groups/$id', patch);
      }
      await refresh();
      return null; // null = 成功
    } catch (err) {
      lastError = '$err';
      _notify();
      return '$err';
    }
  }

  /// 测一下这套 baseUrl + key 通不通（学 CC Switch 那种"先测一下"）。
  /// 返回服务端给的结果：{ok, ms, via, count, models, note, error}
  Future<Map<String, dynamic>> testModelGroup(Map<String, dynamic> body) async {
    try {
      return await api?.post('/api/model-groups/test', body) ?? {};
    } catch (err) {
      return {'ok': false, 'error': '$err'};
    }
  }

  Future<void> deleteModelGroup(String id) async {
    try {
      await api?.delete('/api/model-groups/\$id');
      await refresh();
    } catch (err) {
      lastError = '$err';
      _notify();
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
        // ★ 重连（或服务端重启）之后，"谁在干活"要重新算。
        //
        //   以前不清：服务端中途重启（或者连接断过一次），正在跑的那一轮
        //   就永远不会再发"干完了"，于是侧边栏永远是"正在干活…"、群里永远
        //   停在"正在调用工具…"，圈一直在转但什么也没发生。
        //   用户原话："怎么一直转 但是没开始操作"。
        //   一份全新的快照进来了，这些临时状态就该归零。
        typing.clear();
        queued.clear();
        for (final k in contexts.keys.toList()) {
          final c = contexts[k];
          if (c != null && c.compacting) {
            contexts[k] = c.copyWith(compacting: false);
          }
        }
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
        if (!list.any((m) => m.id == msg.id)) {
          // 插队：服务端说这条插在哪条之前，本地就插哪。
          // 不按它的话，本地顺序和"重新加载后的顺序"会不一样 ——
          // 用户会看到消息跳一下。
          final before = ev['insertBefore'] as String?;
          final at = before == null
              ? -1
              : list.indexWhere((m) => m.id == before);
          if (at >= 0) {
            list.insert(at, msg);
          } else {
            list.add(msg);
          }
        }
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
      case 'msg.done':
        {
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

      case 'user.updated':
        userName = ((ev['user'] as Map?)?['name'] as String?)?.trim() ?? '';
        break;
      case 'policy.updated':
        policy =
            ((ev['policy'] as Map?) ?? policy).cast<String, dynamic>();
        _notify();
        break;

      case 'groupLimits.updated':
        groupLimits = ((ev['limits'] as Map?) ?? const {}).map(
          (k, v) => MapEntry('$k', (v as num?)?.toInt() ?? 0),
        );
        break;
      case 'context':
        {
          // 每轮结束（以及压缩前后）服务端都会报一次
          final key = '${ev['roomId']}:${ev['botId']}';
          contexts[key] = ContextInfo.fromJson(ev.cast<String, dynamic>());
          break;
        }
      case 'bot.compacting':
        {
          final key = '${ev['roomId']}:${ev['botId']}';
          final prev = contexts[key];
          final active = ev['active'] as bool? ?? false;
          contexts[key] = (prev ?? ContextInfo()).copyWith(compacting: active);
          break;
        }
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
      // 通知标题也用现查的名字（bot 改名后，老消息的通知不该还是旧名）
      title: room?.isGroup == true
          ? '${room!.name} · ${botById(msg.authorId)?.name ?? msg.authorName}'
          : (botById(msg.authorId)?.name ?? msg.authorName),
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

  /// 按名字找 bot —— @提及 的 chip 和悬停卡要用它把"名字"换成"那个 bot"。
  /// 名字可能带前后空格（模型写 @名字 时爱这么干），所以两边都 trim 一下。
  /// 某个会话的上下文占用。
  ///
  /// 私聊就一个 bot；群里可能会有好几个（各自一个会话），取**占用最高的那个** ——
  /// 头部显示不下那么多，而"哪个快满了"才是用户要看的。
  ContextInfo? contextFor(String roomId) {
    ContextInfo? worst;
    String prefix = '$roomId:';
    for (final e in contexts.entries) {
      if (!e.key.startsWith(prefix)) continue;
      final c = e.value;
      if (worst == null) {
        worst = c;
        continue;
      }
      final a = c.percent ?? -1;
      final b = worst.percent ?? -1;
      if (a > b) worst = c;
    }
    return worst;
  }

  /// 这个会话里有没有谁在压缩上下文
  bool compactingIn(String roomId) {
    final prefix = '$roomId:';
    for (final e in contexts.entries) {
      if (e.key.startsWith(prefix) && e.value.compacting) return true;
    }
    return false;
  }

  Bot? botByName(String name) {
    final key = name.trim();
    if (key.isEmpty) return null;
    for (final b in bots) {
      if (b.name.trim() == key) return b;
    }
    return null;
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
    _serverWatch?.cancel();
    _serverWatch = null;
    disconnect();
    streamTick.dispose();
    super.dispose();
  }
}
