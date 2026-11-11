/// 本机服务端的启动参数与结果类型。
library;

/// 用户配置的服务端启动参数（留空表示自动探测）。
class ServerLaunchOptions {
  const ServerLaunchOptions({
    this.entryPath,
    this.nodePath,
    this.dataDir,
    this.port = 8787,
  });

  /// 服务端入口（server/src/index.js）
  final String? entryPath;

  /// node 可执行文件路径
  final String? nodePath;

  /// 数据目录（房间 / 会话 / 上传 / 工作目录都在它下面）
  final String? dataDir;

  /// 本机服务端监听端口。
  final int port;

  String get entry => (entryPath ?? '').trim();
  String get node => (nodePath ?? '').trim();
  String get data => (dataDir ?? '').trim();

  /// 监听端口与数据目录，通过环境变量传递给服务端。
  Map<String, String> get env => envForPort(port);

  /// 同上，但用**本次实际选定的端口**。
  ///
  /// 偏好端口被占用时桌面端会换一个空闲端口启动，
  /// 环境变量必须传实际端口，否则服务端会去抢那个被占的端口然后退出。
  /// 注意：[port] 字段始终是用户的偏好值，不会被这次换端口改掉。
  Map<String, String> envForPort(int actualPort) => {
    'PI_BOT_PORT': '$actualPort',
    if (data.isNotEmpty) 'PI_BOT_HOME': data,
  };

  @override
  bool operator ==(Object other) =>
      other is ServerLaunchOptions &&
      entry == other.entry &&
      node == other.node &&
      data == other.data &&
      port == other.port;

  @override
  int get hashCode => Object.hash(entry, node, data, port);
}

/// 一次启动尝试的结果
class ServerLaunchResult {
  const ServerLaunchResult({
    required this.ok,
    required this.alreadyRunning,
    this.error,
    this.port,
    this.notice,
  });

  final bool ok;

  /// 端口上本来就有人在听（不需要我们拉起来）
  final bool alreadyRunning;

  /// 失败时给人看的原因（含试过的路径 / 日志尾部）
  final String? error;

  /// 这次**真正**在监听的端口。
  ///
  /// 偏好端口被占用时桌面端会自动换一个（见 port_picker.dart），
  /// 界面和连接地址必须用这个值，不能用偏好值 —— 否则连到占用端口的
  /// 那个程序上去，表现为"连上了但什么都不对"。
  ///
  /// 为 null 表示这次没走到"确定端口"那一步（失败早于选端口）。
  final int? port;

  /// 换端口时给人看的一句话（如「8787 被占用，已改用 8788」）。
  final String? notice;

  /// 结果里能用的端口；没拿到就退回 [fallback]。
  int portOr(int fallback) => port ?? fallback;
}
