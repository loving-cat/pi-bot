import 'models.dart';

Map<String, dynamic> _map(Object? value) =>
    value is Map ? value.cast<String, dynamic>() : const {};

List<String> _strings(Object? value) => value is List
    ? value.whereType<String>().where((s) => s.isNotEmpty).toList()
    : const [];

/// 连接目录提供的接入入口。
class ConnectionCatalogItem {
  const ConnectionCatalogItem({
    required this.id,
    required this.name,
    required this.description,
    required this.category,
    required this.action,
    this.type = '',
  });

  final String id;
  final String name;
  final String description;
  final String category;
  final String action;
  final String type;

  factory ConnectionCatalogItem.fromJson(Map<String, dynamic> json) =>
      ConnectionCatalogItem(
        id: '${json['id'] ?? ''}',
        name: '${json['name'] ?? ''}',
        description: '${json['description'] ?? ''}',
        category: '${json['category'] ?? ''}',
        action: '${json['action'] ?? ''}',
        type: '${json['type'] ?? ''}',
      );
}

class ConnectionTool {
  const ConnectionTool({
    required this.name,
    this.title = '',
    this.description = '',
  });
  final String name;
  final String title;
  final String description;

  factory ConnectionTool.fromJson(Map<String, dynamic> json) => ConnectionTool(
    name: '${json['name'] ?? ''}',
    title: '${json['title'] ?? ''}',
    description: '${json['description'] ?? ''}',
  );
}

/// 最近一次验证结果；启用开关不参与验证状态判定。
class ConnectionVerification {
  const ConnectionVerification({
    this.state = 'unverified',
    this.checkedAt,
    this.toolCount,
    this.tools = const [],
    this.error = '',
  });

  final String state;
  final int? checkedAt;
  final int? toolCount;
  final List<ConnectionTool> tools;
  final String error;

  String stateAt(int now) =>
      state == 'ready' &&
          checkedAt != null &&
          now - checkedAt! >= const Duration(minutes: 10).inMilliseconds
      ? 'stale'
      : state;

  String get displayState => stateAt(DateTime.now().millisecondsSinceEpoch);

  String get label => switch (displayState) {
    'checking' => '正在验证',
    'ready' => toolCount == 0 ? '协议正常，未发现工具' : '已验证可用',
    'auth_required' => '认证未通过',
    'error' => '验证失败',
    'stale' => '需要重新验证',
    _ => '尚未验证',
  };

  factory ConnectionVerification.fromJson(Map<String, dynamic> json) =>
      ConnectionVerification(
        state: '${json['state'] ?? 'unverified'}',
        checkedAt: (json['checkedAt'] as num?)?.toInt(),
        toolCount: (json['toolCount'] as num?)?.toInt(),
        tools: ((json['tools'] as List?) ?? const [])
            .whereType<Map>()
            .map((raw) => ConnectionTool.fromJson(raw.cast<String, dynamic>()))
            .toList(),
        error: '${json['error'] ?? ''}',
      );
}

class AppConnection {
  const AppConnection({
    required this.server,
    this.verification = const ConnectionVerification(),
    this.assignedBotIds = const [],
  });

  final McpServer server;
  final ConnectionVerification verification;
  final List<String> assignedBotIds;
  String get id => server.id;

  factory AppConnection.fromJson(Map<String, dynamic> json) => AppConnection(
    server: McpServer.fromJson(json),
    verification: ConnectionVerification.fromJson(_map(json['verification'])),
    assignedBotIds: _strings(json['assignedBotIds']),
  );
}

class ConnectionsSnapshot {
  const ConnectionsSnapshot({
    this.catalog = const [],
    this.connections = const [],
  });
  final List<ConnectionCatalogItem> catalog;
  final List<AppConnection> connections;

  factory ConnectionsSnapshot.fromJson(Map<String, dynamic> json) =>
      ConnectionsSnapshot(
        catalog: ((json['catalog'] as List?) ?? const [])
            .whereType<Map>()
            .map(
              (raw) =>
                  ConnectionCatalogItem.fromJson(raw.cast<String, dynamic>()),
            )
            .toList(),
        connections: ((json['connections'] as List?) ?? const [])
            .whereType<Map>()
            .map((raw) => AppConnection.fromJson(raw.cast<String, dynamic>()))
            .toList(),
      );
}
