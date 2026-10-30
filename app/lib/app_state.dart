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
import 'server/launcher.dart';
import 'server/options.dart';
import 'text_utils.dart';
import 'update_info.dart';

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
  static const _kLocalToken = 'local_server_token';
  // 本机服务端的启动配置（开源里每个人环境不同，得能自己指）
  static const _kDataDir = 'server_data_dir';
  static const _kPort = 'server_port';
  static const _kEntry = 'server_entry';
  static const _kNode = 'server_node';
  static const _kDevice = 'device_name';
  // 用户点了"以后再说"的那个版本：同一个版本不再反复弹，出了更新的版本才再问
  static const _kSkippedUpdate = 'skipped_update_version';

  String? serverUrl;
  String? token;
  String deviceName = '我的手机';
  Api? api;

  /// 用户点过"以后再说"的版本号
  String skippedUpdateVersion = '';

  /// 最近一次检查更新的结果（null = 还没查过）
  UpdateInfo? updateInfo;

  /// 全局技能库（所有 bot 共享）
  List<LibrarySkill> skills = const [];

  /// MCP 服务库（设置 → MCP）。跟技能库一起由服务端下发，
  /// 但**机制完全不同**：技能只是提示词，MCP 会真起进程/连服务。
  List<McpServer> mcpServers = const [];
  bool mcpLoaded = false;
  int connectionsRevision = 0;
  bool skillsLoaded = false;

  /// 经验库（从执行里学到的“下次别这样”）。只有 active 的会进主控提示词。
  List<LibraryLesson> lessons = const [];
  bool lessonsLoaded = false;

  /// 本机 pi 上已经装好的能力（只读扫描结果）。
  /// 用户在终端里早就装了一堆，这里让他一键导进来，不用手抄。
  LocalCapabilities? localCapabilities;

  /// 已接入的外部 Web 系统
  List<SiteSystem> sites = const [];
  bool sitesLoaded = false;

  ServerInfo? serverInfo;
  List<Room> rooms = const [];
  List<Bot> bots = const [];

  /// 用户自己配的模型组（key 是打码的 —— 真 key 不出服务端）
  List<ModelGroup> modelGroups = const [];
  final Map<String, List<Msg>> messages = {};

  /// 记忆摘要缓存（roomId → 摘要）
  final Map<String, MemorySummary> memorySummaries = {};
  final Map<String, bool> typing = {};

  /// 每个会话里排队/插话中的用户消息条数
  final Map<String, int> queued = {};

  /// 上下文占用，key 是 `房间:bot`（服务端 /api/state 和 context 事件都按这个格式给）
  final Map<String, ContextInfo> contexts = {};

  /// 群聊轮次预算（防止 bot 解不了就互相聊个没完）
  Map<String, int> groupLimits = const {};

  /// 部门规矩（危险动作 / 交付要附证据）。
  /// 服务端一直在收，这里提供界面入口，否则 bot 跑命令无从约束。
  Map<String, dynamic> policy = const {
    'dangerous': 'allow',
    'requireProof': false,
  };

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

  /// 本机服务端开了服务器模式（设了 PI_BOT_TOKEN），本机也要带 token。
  /// 连接页据此显示「填 token」，而不是拿着空 token 一直重连。
  bool localNeedsToken = false;

  /// 用户为本机服务端填的 token（服务器模式下才用；和远程配对的 token 分开存）
  String localToken = '';

  /// 本机服务端是不是正在拉起（界面据此显示"正在启动"而不是"连不上"）
  bool serverStarting = false;

  /// 拉不起来时给人看的原因（找不到 node / 端口没应答 / 试过哪些路径）
  String? serverProblem;

  /// 服务端进程的日志尾部（诊断用，失败时贴在界面上）
  List<String> get serverLog => serverLauncher.logLines;

  /// 服务端目录 / 日志位置（界面上的手动命令和排查要用真实路径）
  String? get serverDir => serverLauncher.serverDir;
  String get serverLogPath => serverLauncher.logPath;

  /// 启动编排（找 node / 装依赖 / 拉起 / 等健康）都在这一个对象里
  final LocalServerLauncher serverLauncher = LocalServerLauncher();
  int _lastServerNotify = 0;

  /// 本机服务端巡检：离线时按退避间隔尝试重新启动。
  Timer? _serverWatch;
  DateTime _lastSpawnAt = DateTime.fromMillisecondsSinceEpoch(0);
  int _spawnFails = 0;

  /// 连续失败达到上限后暂停自动重试，等待手动触发。
  bool serverRetryPaused = false;

  /// 已发起的启动尝试次数（界面展示用）
  int serverAttempts = 0;

  /// 用户配置的启动参数。空 = 自动探测。
  String serverDataDir = '';
  int serverPort = 8787;
  String serverEntryPath = '';
  String serverNodePath = '';

  /// 本机服务端地址（端口可在设置里改）
  String get localUrl => 'http://127.0.0.1:$serverPort';

  bool get paired =>
      serverUrl != null && (localMode || (token ?? '').isNotEmpty);

  /// 任务板（每条任务带状态/负责人/未读/置顶）
  List<TaskItem> tasks = const [];

  /// 定时任务
  List<Automation> automations = const [];

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
    localToken = prefs.getString(_kLocalToken) ?? '';
    deviceName = prefs.getString(_kDevice) ?? '我的手机';
    serverDataDir = prefs.getString(_kDataDir) ?? '';
    serverPort = prefs.getInt(_kPort) ?? 8787;
    serverEntryPath = prefs.getString(_kEntry) ?? '';
    serverNodePath = prefs.getString(_kNode) ?? '';
    skippedUpdateVersion = prefs.getString(_kSkippedUpdate) ?? '';
    if (paired) {
      api = Api(serverUrl!, token ?? '');
      unawaited(refresh());
      connect();
    } else if (isHostPlatform) {
      // 桌面端即宿主：先确保本机服务端就绪，再直连（不走配对）。
      serverLauncher.resetLogForNewRun();
      await bootLocalServer();
      _startServerWatchdog();
    }
    _notify();
    // 启动后顺手查一次更新：不 await、失败静默 —— 检查更新绝不该拖慢启动
    if (paired) unawaited(checkUpdate());
  }

  /// 桌面端启动：确保本机服务端就绪后连接。
  ///
  /// 幂等：端口上已有服务端时只建立连接，不重复启动进程。
  Future<void> bootLocalServer({bool manual = false}) async {
    if (!isHostPlatform) return;
    if (serverStarting) return;
    if (manual) {
      // 手动点"重新启动"：重置失败计数，再给一轮机会
      _spawnFails = 0;
      serverRetryPaused = false;
    }
    serverAttempts++;
    _lastSpawnAt = DateTime.now();
    serverStarting = true;
    serverProblem = null;
    _notify();
    var ok = false;
    try {
      serverLauncher.options = ServerLaunchOptions(
        entryPath: serverEntryPath.isEmpty ? null : serverEntryPath,
        nodePath: serverNodePath.isEmpty ? null : serverNodePath,
        dataDir: serverDataDir.isEmpty ? null : serverDataDir,
        port: serverPort,
      );
      final result = await serverLauncher.ensureRunning(
        baseUrl: localUrl,
        onProgress: () {
          // 探活是 300ms 一轮，别把整棵树按这个频率重建
          final t = DateTime.now().millisecondsSinceEpoch;
          if (t - _lastServerNotify < 700) return;
          _lastServerNotify = t;
          _notify();
        },
      );
      ok = result.ok;
      serverProblem = result.ok ? null : result.error;
    } finally {
      serverStarting = false;
      _notify();
    }

    // 失败计数统一在此处累加：所有重试来源（界面定时器 / 后台巡检 / 手动）都经过这里。
    if (ok) {
      _spawnFails = 0;
      serverRetryPaused = false;
    } else {
      _spawnFails++;
      if (_spawnFails >= 4 && !serverRetryPaused) {
        serverRetryPaused = true;
        _notify();
      }
    }

    await connectLocal();
  }

  /// 每 4s 看一次：本机服务端不在就拉回来（带退避，连续失败 4 次就停手）。
  void _startServerWatchdog() {
    _serverWatch?.cancel();
    _lastSpawnAt = DateTime.now();
    _serverWatch = Timer.periodic(const Duration(seconds: 4), (_) async {
      if (_disposed || !isHostPlatform || !localMode) return;
      if (link == LinkState.online || serverStarting) {
        if (link == LinkState.online) {
          _spawnFails = 0;
          serverRetryPaused = false;
        }
        return;
      }
      if (serverRetryPaused) return;
      // 服务端在跑，只是要 token 而用户还没填：等用户，不要反复重启
      if (localNeedsToken && localToken.isEmpty) return;
      // _lastSpawnAt 已经在 bootLocalServer 里刷新过，这里只判断退避
      final backoff = Duration(
        seconds: const [0, 4, 8, 15, 30][_spawnFails.clamp(0, 4)],
      );
      if (DateTime.now().difference(_lastSpawnAt) < backoff) return;
      await bootLocalServer();
    });
  }

  /// 保存「本机服务端」配置并重启。换端口/换数据目录必须重启才生效 ——
  /// 所以这里直接把服务端停掉重拉，用户不需要自己去任务管理器。
  Future<void> applyServerSettings({
    required String dataDir,
    required int port,
    required String entryPath,
    required String nodePath,
  }) async {
    if (serverStarting) {
      serverProblem = '本机服务端正在启动或停止，请等待完成后再保存配置';
      lastError = serverProblem;
      _notify();
      return;
    }
    serverStarting = true;
    try {
      serverDataDir = dataDir.trim();
      serverPort = port;
      serverEntryPath = entryPath.trim();
      serverNodePath = nodePath.trim();
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kDataDir, serverDataDir);
      await prefs.setInt(_kPort, serverPort);
      await prefs.setString(_kEntry, serverEntryPath);
      await prefs.setString(_kNode, serverNodePath);
    } finally {
      serverStarting = false;
    }
    await restartLocalServer();
  }

  /// 重启本机服务端（改完配置用它）
  Future<void> restartLocalServer() async {
    if (!isHostPlatform) return;
    if (serverStarting) return;
    serverStarting = true;
    disconnect();
    try {
      await serverLauncher.stop();
    } catch (err) {
      serverProblem = '停止本机服务端失败：$err';
      lastError = serverProblem;
      serverRetryPaused = true;
      serverStarting = false;
      _notify();
      return;
    }
    serverStarting = false;
    _spawnFails = 0;
    serverRetryPaused = false;
    serverProblem = null;
    await bootLocalServer(manual: true);
  }

  /// 桌面端：直连本机服务端
  ///
  /// 服务端一般信任本机（不带 token）；开了服务器模式（设了 PI_BOT_TOKEN）时本机也要带，
  /// 这时用用户在连接页填的 [localToken]。
  Future<void> connectLocal({String? url}) async {
    localMode = true;
    serverUrl = url ?? localUrl;
    localNeedsToken = await localServerRequiresToken(serverUrl!);
    token = localNeedsToken ? localToken : '';
    api = Api(serverUrl!, token!);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kUrl, serverUrl!);
    await prefs.setString(_kToken, '');
    if (localNeedsToken && localToken.isEmpty) {
      // 没 token 就不去撞 401 了：直接停在连接页等用户填
      serverProblem = localTokenHint;
      link = LinkState.offline;
      _notify();
      return;
    }
    await refresh();
    if (localNeedsToken && _lastRefreshStatus == 401) {
      // token 不对：清掉存下的，回到「填 token」，而不是拿着错的一直重连
      localToken = '';
      await prefs.remove(_kLocalToken);
      serverProblem = localTokenRejected;
      link = LinkState.offline;
      _notify();
      return;
    }
    connect();
  }

  /// 连接页上的提示：为什么连不上、去哪里填
  static const localTokenHint =
      '本机服务端开了服务器模式（设了 PI_BOT_TOKEN），本机连接也要带 token。\n'
      '把服务端的 PI_BOT_TOKEN 填在下面。只是自己电脑上用的话，去掉 PI_BOT_TOKEN 重启服务端即可。';

  /// 填的 token 被服务端拒了
  static const localTokenRejected =
      'token 不对：服务端拒绝了这个 token。请核对服务端的 PI_BOT_TOKEN 后重新填写。';

  /// 连接页填了本机 token：保存并重连
  Future<void> setLocalToken(String value) async {
    localToken = value.trim();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_kLocalToken, localToken);
    serverProblem = null;
    await connectLocal();
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

  /// 某个房间的任务（未完成在前、置顶优先）
  List<TaskItem> tasksFor(String roomId) {
    final list = tasks.where((t) => t.roomId == roomId).toList()
      ..sort((a, b) {
        if (a.isPinned != b.isPinned) return a.isPinned ? -1 : 1;
        if (a.isDone != b.isDone) return a.isDone ? 1 : -1;
        return b.updatedAt.compareTo(a.updatedAt);
      });
    return list;
  }

  /// 未完成 + 未读的任务数（侧边栏小红点用）
  int get openTaskCount => tasks.where((t) => !t.isDone || t.isUnread).length;

  Future<void> refreshTasks() async {
    final client = api;
    if (client == null) return;
    try {
      final res = await client.get('/api/tasks');
      tasks = ((res['tasks'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(TaskItem.fromJson)
          .toList();
      automations = ((res['automations'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(Automation.fromJson)
          .toList();
      _notify();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<void> updateTask(String id, Map<String, dynamic> patch) async {
    try {
      final res = await api?.patch('/api/tasks/$id', patch);
      final task = res?['task'];
      if (task is Map) {
        final parsed = TaskItem.fromJson(task.cast<String, dynamic>());
        final idx = tasks.indexWhere((t) => t.id == parsed.id);
        tasks = [...tasks];
        if (idx >= 0) {
          tasks[idx] = parsed;
        } else {
          tasks.add(parsed);
        }
        _notify();
      }
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<void> createTask({
    required String roomId,
    required String title,
  }) async {
    try {
      await api?.post('/api/tasks', {'roomId': roomId, 'title': title});
      await refreshTasks();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<void> deleteTask(String id) async {
    try {
      await api?.delete('/api/tasks/$id');
      tasks = tasks.where((t) => t.id != id).toList();
      _notify();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  /// 批准 / 拒绝一次危险动作（服务端会顺手让那个 bot 继续或记一条拒绝）
  Future<void> decideApproval(
    String approvalId, {
    required bool approve,
  }) async {
    try {
      await api?.post('/api/approvals/$approvalId', {'approve': approve});
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  // ---------------------------------------------------------------- 定时任务

  List<Automation> automationsFor(String roomId) =>
      automations.where((a) => a.roomId == roomId).toList();

  Future<void> refreshAutomations() async {
    try {
      final res = await api?.get('/api/automations');
      automations = ((res?['automations'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(Automation.fromJson)
          .toList();
      _notify();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<void> createAutomation({
    required String roomId,
    required String title,
    required String prompt,
    int? everyMinutes,
    String? dailyAt,
  }) async {
    try {
      await api?.post('/api/automations', {
        'roomId': roomId,
        'title': title,
        'prompt': prompt,
        if (everyMinutes != null) 'everyMinutes': everyMinutes,
        if (dailyAt != null) 'dailyAt': dailyAt,
      });
      await refreshAutomations();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<void> updateAutomation(String id, Map<String, dynamic> patch) async {
    try {
      await api?.patch('/api/automations/$id', patch);
      await refreshAutomations();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<void> deleteAutomation(String id) async {
    try {
      await api?.delete('/api/automations/$id');
      automations = automations.where((a) => a.id != id).toList();
      _notify();
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  Future<void> runAutomationNow(String id) async {
    try {
      await api?.post('/api/automations/$id/run', const {});
    } catch (err) {
      lastError = '$err';
      _notify();
    }
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

  // ---------------------------------------------------------------- 本机已装能力

  /// 扫描本机 pi 上已装的 skill / MCP（只读，不会改用户配置）
  Future<void> loadLocalCapabilities() async {
    if (api == null) return;
    try {
      final json = await api!.get('/api/local-capabilities');
      localCapabilities = LocalCapabilities.fromJson(json);
      _notify();
    } catch (err) {
      lastError = '扫描本机能力失败：$err';
      _notify();
    }
  }

  /// 一键导入本机已装的能力。
  /// [kind] 是 'skill' 或 'mcp'，[names] 是要导入的名字列表。
  /// 返回 (成功导入的名字, 跳过明细)
  Future<({List<String> imported, List<String> skipped})> importLocalCapabilities({
    required String kind,
    required List<String> names,
  }) async {
    if (api == null) {
      return (imported: <String>[], skipped: <String>['未连接服务端']);
    }
    try {
      final json = await api!.post('/api/local-capabilities/import', {
        'kind': kind,
        'names': names,
      });
      final imported = <String>[
        ...((json['imported'] as List?) ?? const []).map((e) => '$e'),
      ];
      final skipped = <String>[
        ...((json['skipped'] as List?) ?? const [])
            .whereType<Map>()
            .map((e) => '${e['title']}：${e['reason']}'),
      ];
      // 导入后两边的库都变了，刷新
      if (kind == 'skill') {
        await loadSkills();
      } else {
        await loadMcpServers();
      }
      await loadLocalCapabilities();
      return (imported: imported, skipped: skipped);
    } catch (err) {
      return (imported: <String>[], skipped: <String>['$err']);
    }
  }

  // ---------------------------------------------------------------- MCP 服务库

  /// 同步已加载的公共连接库，不触发连接中心再次刷新。
  void applyMcpServers(List<McpServer> servers) {
    mcpServers = List<McpServer>.of(servers);
    mcpLoaded = true;
    _notify();
  }

  /// 拉 MCP 服务库
  Future<void> loadMcpServers() async {
    if (api == null) return;
    try {
      final json = await api!.get('/api/mcp');
      mcpServers = ((json['servers'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => McpServer.fromJson(e.cast<String, dynamic>()))
          .toList();
      mcpLoaded = true;
      _notify();
    } catch (err) {
      lastError = 'MCP 库加载失败：$err';
      _notify();
    }
  }

  /// 新增或更新一个 MCP 服务（[id] 为空 = 新增）。返回错误文案，成功为 null。
  Future<String?> saveMcpServer(Map<String, dynamic> patch) async {
    if (api == null) return '未连接服务端';
    try {
      final id = patch['id'] as String?;
      if (id == null || id.isEmpty) {
        await api!.post('/api/mcp', patch);
      } else {
        await api!.patch('/api/mcp/${Uri.encodeComponent(id)}', patch);
      }
      await loadMcpServers();
      return null;
    } catch (err) {
      return '$err';
    }
  }

  /// 删一个 MCP 服务
  Future<String?> removeMcpServer(String id) async {
    if (api == null) return '未连接服务端';
    try {
      await api!.delete('/api/mcp/${Uri.encodeComponent(id)}');
      await loadMcpServers();
      return null;
    } catch (err) {
      return '$err';
    }
  }

  /// 测一下这个服务能不能连上。
  /// 返回服务端给的结果：{ok, ms, via, detail, error}
  Future<Map<String, dynamic>> testMcpServer(Map<String, dynamic> body) async {
    if (api == null) return {'ok': false, 'error': '未连接服务端'};
    try {
      return await api!.post('/api/mcp/test', body);
    } catch (err) {
      return {'ok': false, 'error': '$err'};
    }
  }

  // ---------------------------------------------------------------- 技能库

  /// 拉技能库（设置页打开时调）
  Future<void> loadSkills() async {
    if (api == null) return;
    try {
      final json = await api!.get('/api/skills');
      skills = ((json['skills'] as List?) ?? const [])
          .map((e) => LibrarySkill.fromJson(e as Map<String, dynamic>))
          .toList();
      skillsLoaded = true;
      _notify();
    } catch (err) {
      lastError = '技能库加载失败：$err';
      _notify();
    }
  }

  /// 加一条技能。返回错误文案（成功时返回 null）。
  Future<String?> addSkill({
    required String title,
    String summary = '',
    String howto = '',
    List<String> tags = const [],
  }) async {
    if (api == null) return '未连接服务端';
    try {
      await api!.post('/api/skills', {
        'title': title,
        'summary': summary,
        'howto': howto,
        'tags': tags,
      });
      await loadSkills();
      return null;
    } catch (err) {
      return '$err';
    }
  }

  /// 改一条技能。返回错误文案（成功时返回 null）。
  Future<String?> updateSkill(
    String id, {
    String? title,
    String? summary,
    String? howto,
    List<String>? tags,
    bool? enabled,
  }) async {
    if (api == null) return '未连接服务端';
    try {
      await api!.patch('/api/skills/${Uri.encodeComponent(id)}', {
        if (title != null) 'title': title,
        if (summary != null) 'summary': summary,
        if (howto != null) 'howto': howto,
        if (tags != null) 'tags': tags,
        if (enabled != null) 'enabled': enabled,
      });
      await loadSkills();
      return null;
    } catch (err) {
      return '$err';
    }
  }

  // ---------------------------------------------------------------- 经验库

  /// 用服务端推来的列表更新本地（WS 事件和主动拉取共用这一条路径）
  void applyLessons(List raw) {
    lessons = raw
        .whereType<Map>()
        .map((e) => LibraryLesson.fromJson(e.cast<String, dynamic>()))
        .toList();
    lessonsLoaded = true;
    _notify();
  }

  Future<void> loadLessons() async {
    if (api == null) return;
    try {
      final json = await api!.get('/api/lessons');
      applyLessons((json['lessons'] as List?) ?? const []);
    } catch (err) {
      lastError = '经验库加载失败：$err';
      _notify();
    }
  }

  /// 启用 / 停用一条经验（启用前服务端会校验它有没有证据）
  Future<String?> setLessonStatus(String id, String status) async {
    if (api == null) return '未连接服务端';
    try {
      await api!.patch('/api/lessons/${Uri.encodeComponent(id)}', {
        'status': status,
      });
      await loadLessons();
      return null;
    } catch (err) {
      // 失败也刷一次：这条可能已经被删了（列表是旧的），不能让用户
      // 对着一条不存在的经验反复点“停用/删除”。
      await loadLessons();
      return '$err';
    }
  }

  Future<String?> removeLesson(String id) async {
    if (api == null) return '未连接服务端';
    try {
      await api!.delete('/api/lessons/${Uri.encodeComponent(id)}');
      await loadLessons();
      return null;
    } catch (err) {
      await loadLessons();
      return '$err';
    }
  }

  /// 删一条技能
  Future<String?> removeSkill(String id) async {
    if (api == null) return '未连接服务端';
    try {
      await api!.delete('/api/skills/${Uri.encodeComponent(id)}');
      await loadSkills();
      return null;
    } catch (err) {
      return '$err';
    }
  }

  /// 导入若干 SKILL.md（内容由调用方读出来）
  /// @returns (成功数, 跳过明细)
  Future<({int imported, List<String> skipped})> importSkillFiles(
    List<({String name, String text})> files,
  ) async {
    if (api == null) return (imported: 0, skipped: ['未连接服务端']);
    try {
      final json = await api!.post('/api/skills/import', {
        'files': files.map((f) => {'name': f.name, 'text': f.text}).toList(),
      });
      final imported = (json['imported'] as List?)?.length ?? 0;
      final skipped = ((json['skipped'] as List?) ?? const [])
          .map(
            (s) =>
                '${(s as Map)['title'] ?? s['name'] ?? ''}：${s['reason'] ?? '跳过'}',
          )
          .toList();
      await loadSkills();
      return (imported: imported, skipped: skipped);
    } catch (err) {
      return (imported: 0, skipped: ['$err']);
    }
  }

  // ---------------------------------------------------------------- 外部系统

  Future<void> loadSites() async {
    if (api == null) return;
    try {
      final json = await api!.get('/api/sites');
      sites = ((json['sites'] as List?) ?? const [])
          .map((e) => SiteSystem.fromJson(e as Map<String, dynamic>))
          .toList();
      sitesLoaded = true;
      _notify();
    } catch (err) {
      lastError = '系统列表加载失败：$err';
      _notify();
    }
  }

  /// 添加前探测：这个站能不能连、登录字段叫什么
  Future<Map<String, dynamic>> probeSite({
    required String baseUrl,
    required String account,
    required String password,
    String accountField = '',
    String passwordField = '',
  }) async {
    if (api == null) return {'ok': false, 'reason': '未连接服务端'};
    try {
      return await api!.post('/api/sites/probe', {
        'baseUrl': baseUrl,
        'account': account,
        'password': password,
        if (accountField.isNotEmpty) 'accountField': accountField,
        if (passwordField.isNotEmpty) 'passwordField': passwordField,
      });
    } catch (err) {
      return {'ok': false, 'reason': '$err'};
    }
  }

  Future<String?> addSite({
    required String baseUrl,
    required String account,
    required String password,
    String name = '',
    Map<String, dynamic>? auth,
  }) async {
    if (api == null) return '未连接服务端';
    try {
      await api!.post('/api/sites', {
        'name': name,
        'baseUrl': baseUrl,
        'account': account,
        'password': password,
        if (auth != null) 'auth': auth,
      });
      await loadSites();
      return null;
    } catch (err) {
      return '$err';
    }
  }

  Future<String?> removeSite(String id) async {
    if (api == null) return '未连接服务端';
    try {
      await api!.delete('/api/sites/${Uri.encodeComponent(id)}');
      await loadSites();
      return null;
    } catch (err) {
      return '$err';
    }
  }

  /// 给系统绑定/创建团队（交给主控去做）
  Future<String?> bindSiteTeam(String id, String siteName) async {
    if (api == null) return '未连接服务端';
    try {
      await api!.post('/api/sites/${Uri.encodeComponent(id)}/team', {'name': '$siteName 团队'});
      await loadSites();
      return null;
    } catch (err) {
      return '$err';
    }
  }

  /// 测一下某个系统现在通不通
  Future<Map<String, dynamic>> testSite(String id) async {
    if (api == null) return {'ok': false, 'reason': '未连接服务端'};
    try {
      return await api!.post('/api/sites/${Uri.encodeComponent(id)}/test');
    } catch (err) {
      return {'ok': false, 'reason': '$err'};
    }
  }

  /// 查一次有没有新版本。
  ///
  /// 失败不抛错也不打扰用户：检查更新是锦上添花，断网/服务端旧了都不该显示红字。
  /// @param force 跳过服务端缓存（用户点"重新检查"时用）
  Future<UpdateInfo?> checkUpdate({bool force = false}) async {
    if (!paired || api == null) return null;
    try {
      final json = await api!.get(
        '/api/update',
        query: {'platform': UpdateInfo.platformParam, if (force) 'force': '1'},
      );
      final info = UpdateInfo.fromJson(json);
      updateInfo = info;
      _notify();
      return info;
    } catch (_) {
      // 静默：检查更新失败不是错误
      return null;
    }
  }

  /// 记下"这个版本先不更新"，之后同一个版本不再弹（新版本出来还会问）
  Future<void> skipUpdateVersion(String version) async {
    skippedUpdateVersion = version;
    _notify();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_kSkippedUpdate, version);
    } catch (_) {}
  }

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
          ((res['policy'] as Map?) ??
                  const {'dangerous': 'allow', 'requireProof': false})
              .cast<String, dynamic>();
      groupLimits = ((res['groupLimits'] as Map?) ?? const {}).map(
        (k, v) => MapEntry('$k', (v as num?)?.toInt() ?? 0),
      );
      tasks = ((res['tasks'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(TaskItem.fromJson)
          .toList();
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
      _lastRefreshStatus = 200;
    } catch (err) {
      lastError = '$err';
      _lastRefreshStatus = err is ApiException ? err.status : null;
    }
    _notify();
  }

  /// 最近一次 /api/state 的结果（只用来判断「本机 token 填错了」）
  int? _lastRefreshStatus;

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
      // 空私聊：让 bot 自己开口（自我介绍 + 询问卡片）。
      // 服务端按房间标记只做一次，重复调用无副作用。
      final room = rooms.where((r) => r.id == roomId).firstOrNull;
      final botId = (room?.kind == 'dm') ? room?.botIds.firstOrNull : null;
      if (list.isEmpty && botId != null) {
        unawaited(ensureDm(botId));
      }
    } catch (err) {
      lastError = '$err';
      _notify();
    }
  }

  String _memoryKey(String roomId, String? botId) =>
      botId == null ? roomId : '$roomId:$botId';

  /// 读某个会话的记忆摘要（群聊可指定 botId）
  Future<MemorySummary?> loadMemory(String roomId, {String? botId}) async {
    final client = api;
    if (client == null) return null;
    try {
      final query = botId == null
          ? ''
          : '?botId=${Uri.encodeQueryComponent(botId)}';
      final res = await client.get('/api/rooms/$roomId/memory$query');
      final m = MemorySummary.fromJson(res);
      memorySummaries[_memoryKey(roomId, botId)] = m;
      _notify();
      return m;
    } catch (err) {
      lastError = '$err';
      _notify();
      return null;
    }
  }

  /// 重新整理记忆摘要（会调模型，可能几秒；群聊可指定 botId）
  Future<MemorySummary?> refreshMemory(String roomId, {String? botId}) async {
    final client = api;
    if (client == null) return null;
    try {
      final res = await client.post(
        '/api/rooms/$roomId/memory/refresh',
        {if (botId != null) 'botId': botId},
      );
      final m = MemorySummary.fromJson(res);
      memorySummaries[_memoryKey(roomId, botId)] = m;
      _notify();
      return m;
    } catch (err) {
      lastError = '$err';
      _notify();
      return null;
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
      // 超过 8MB 走分片：普通接口是整包读进内存的，大文件会被拒或把服务端拖慢
      final json = bytes.length > 8 * 1024 * 1024
          ? await client.uploadChunked(bytes, name)
          : await client.upload(bytes, name);
      return Attachment.fromJson(json);
    } catch (err) {
      lastError = '上传失败：$err';
      _notify();
      return null;
    }
  }

  String? fileUrl(String id) => api?.fileUrl(id);

  /// 发消息。busy 时用 steer（插话引导）或 followUp（排队），不报错。
  /// 发一条消息。
  ///
  /// [flushMerge] = true 表示"这一条是用户明确按发送发的"，
  /// 服务端会立刻把之前攒着的连发消息连同这条一起投递，不等静默窗口。
  /// 用户连打三条然后按回车时，体感就应该是"咔一下全部生效"，
  /// 而不是再多等 700ms。
  Future<void> sendMessage(
    String roomId,
    String text, {
    String mode = 'steer',
    List<Attachment> attachments = const [],
    bool flushMerge = true,
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
          if (flushMerge) 'flushMerge': true,
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
    //   只发请求（走 WS）、本地什么都不动的话，服务端那边在收尾，
    //   界面上却是**转圈照转、消息照流**，看起来就是“没反应”。
    //   服务端的 session 可能正卡在一个长命令里，几秒到几分钟才真的断。
    //   所以这里乐观地先改本地状态：说停就停。
    typing[roomId] = false;
    queued[roomId] = 0;
    for (final m in messages[roomId] ?? const <Msg>[]) {
      if (m.status == 'streaming') {
        // 本地乐观终止：用 aborted 而不是 error —— 用户按 Esc 不是"出错"，
        // 不要弹红色错误气泡（在 pi agent 里终止就是终止，界面不留痕）
        m.status = 'aborted';
        m.error = '';
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

  /// 思考强度的可选项（档位 / 上游格式）。服务端是唯一的真源，
  /// Windows 与 Mac 两端都从这里取，不在客户端写死枚举。
  Future<Map<String, dynamic>> loadThinkingOptions() async {
    try {
      return await api?.get('/api/model-thinking/options') ?? {};
    } catch (err) {
      return {};
    }
  }

  Future<void> deleteModelGroup(String id) async {
    try {
      // ★ URL 必须用真正的 id：写成 '\$id'（转义）的话，实际发出去的是
      //   字面量 "$id"，服务端找不到叫 "$id" 的组 —— 表现就是“删不掉”。
      await api?.delete('/api/model-groups/$id');
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

  /// 应用已确认保存的 Bot；调用方负责核对响应所属的服务端。
  void applyBotUpdate(Bot bot) {
    if (_disposed) return;
    _upsertBot(bot);
    connectionsRevision++;
    _notify();
  }

  void _upsertBot(Bot bot) {
    final index = bots.indexWhere((item) => item.id == bot.id);
    bots = index < 0 ? [...bots, bot] : ([...bots]..[index] = bot);
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
        connectionsRevision++;
        link = LinkState.online;
        unawaited(Native.startService());
        _attempt = 0;
        lastError = null;
        // ★ 重连（或服务端重启）之后，"谁在干活"要重新算。
        //
        //   不清的话：服务端中途重启（或连接断过一次），正在跑的那一轮
        //   就永远不会再发"干完了"，侧边栏会一直显示"正在干活…"、群里一直
        //   停在"正在调用工具…"，圈一直在转但什么也没发生。
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

      case 'lessons.updated':
        // 复盘是在服务端后台跑的：不接这个事件，界面就要等用户切标签页
        // 才能看到新候选（更糟的是操作一条已经被删的经验 →“经验不存在”）。
        applyLessons((ev['lessons'] as List?) ?? const []);
        break;

      case 'mcp.updated':
        mcpServers = ((ev['servers'] as List?) ?? const [])
            .whereType<Map>()
            .map((e) => McpServer.fromJson(e.cast<String, dynamic>()))
            .toList();
        mcpLoaded = true;
        connectionsRevision++;
        break;

      case 'mcp.changed':
      case 'connections.changed':
        connectionsRevision++;
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

      case 'msg.moved':
        {
          // 插话重排：服务端把"正在写的那条回复"挪到用户插话后面。
          // 事件带消息本体（createdAt 可能也被 touch 过），本地整条替换。
          final roomId = ev['roomId'] as String? ?? '';
          final list = messages[roomId];
          final msgId = ev['msgId'] as String?;
          final raw = ev['msg'];
          if (list == null || msgId == null || raw is! Map) break;
          final idx = list.indexWhere((m) => m.id == msgId);
          if (idx < 0) break;
          list.removeAt(idx);
          final afterId = ev['afterId'] as String?;
          final after = afterId == null
              ? -1
              : list.indexWhere((m) => m.id == afterId);
          list.insert(
            after >= 0 ? after + 1 : list.length,
            Msg.fromJson(raw.cast<String, dynamic>()),
          );
          _notify();
        }
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
        policy = ((ev['policy'] as Map?) ?? policy).cast<String, dynamic>();
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
        connectionsRevision++;
        final bot = Bot.fromJson((ev['bot'] as Map).cast<String, dynamic>());
        _upsertBot(bot);
        break;

      case 'bot.deleted':
        connectionsRevision++;
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
