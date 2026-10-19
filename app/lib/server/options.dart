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
  Map<String, String> get env => {
    'PI_BOT_PORT': '$port',
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
  });

  final bool ok;

  /// 端口上本来就有人在听（不需要我们拉起来）
  final bool alreadyRunning;

  /// 失败时给人看的原因（含试过的路径 / 日志尾部）
  final String? error;
}
