/// 协议数据模型：与 server/src/*.js 一一对应。
library;

int _asInt(dynamic v, [int fallback = 0]) => v is int
    ? v
    : (v is num
          ? v.toInt()
          : (v is String ? int.tryParse(v) ?? fallback : fallback));

class ToolStep {
  ToolStep({
    required this.tool,
    this.detail = '',
    this.status = 'running',
    this.durationMs,
  });

  final String tool;
  final String detail;
  String status; // running | done | error
  int? durationMs;

  factory ToolStep.fromJson(Map<String, dynamic> json) => ToolStep(
    tool: json['tool'] as String? ?? '?',
    detail: json['detail'] as String? ?? '',
    status: json['status'] as String? ?? 'running',
    durationMs: json['durationMs'] == null ? null : _asInt(json['durationMs']),
  );
}

class Attachment {
  Attachment({
    required this.id,
    required this.name,
    this.mime = '',
    this.kind = 'file',
    this.size = 0,
  });

  final String id;
  final String name;
  final String mime;
  final String kind; // image | video | file
  final int size;

  bool get isImage => kind == 'image';

  String get sizeText {
    if (size <= 0) return '';
    if (size < 1024) return '${size}B';
    if (size < 1024 * 1024) return '${(size / 1024).toStringAsFixed(0)}KB';
    return '${(size / 1024 / 1024).toStringAsFixed(1)}MB';
  }

  factory Attachment.fromJson(Map<String, dynamic> json) => Attachment(
    id: json['id'] as String,
    name: json['name'] as String? ?? 'file',
    mime: json['mime'] as String? ?? '',
    kind: json['kind'] as String? ?? 'file',
    size: _asInt(json['size']),
  );
}

class Msg {
  Msg({
    required this.id,
    required this.roomId,
    required this.authorType,
    required this.authorName,
    required this.text,
    required this.status,
    required this.createdAt,
    this.authorId,
    this.authorEmoji,
    this.steps = const [],
    this.attachments = const [],
    this.error,
    this.usage,
    this.meta,
  });

  final String id;
  final String roomId;
  final String authorType; // user | bot | system
  final String? authorId;
  final String? authorEmoji;
  final String authorName;
  String text;
  String status; // streaming | done | error
  final int createdAt;
  List<ToolStep> steps;
  List<Attachment> attachments;
  String? error;
  Map<String, dynamic>? usage;
  Map<String, dynamic>? meta;

  bool get isUser => authorType == 'user';
  bool get isStreaming => status == 'streaming';
  bool get wasSteer => meta?['queued'] != null;

  factory Msg.fromJson(Map<String, dynamic> json) => Msg(
    id: json['id'] as String,
    roomId: json['roomId'] as String? ?? '',
    authorType: json['authorType'] as String? ?? 'system',
    authorId: json['authorId'] as String?,
    authorEmoji: json['authorEmoji'] as String?,
    authorName: json['authorName'] as String? ?? '',
    text: json['text'] as String? ?? '',
    status: json['status'] as String? ?? 'done',
    createdAt: _asInt(json['createdAt'], DateTime.now().millisecondsSinceEpoch),
    steps: ((json['steps'] as List?) ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(ToolStep.fromJson)
        .toList(),
    attachments: ((json['attachments'] as List?) ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(Attachment.fromJson)
        .toList(),
    error: json['error'] as String?,
    usage: json['usage'] as Map<String, dynamic>?,
    meta: json['meta'] as Map<String, dynamic>?,
  );
}

class Room {
  Room({
    required this.id,
    required this.name,
    required this.kind,
    required this.botIds,
    this.botNames = const [],
    this.leadBotId,
    this.topic = '',
    this.lastMessageAt = 0,
    this.lastMessage,
    this.messageCount = 0,
  });

  final String id;
  String name;
  final String kind; // dm | group
  final List<String> botIds;
  final List<String> botNames;
  final String? leadBotId;
  final String topic;
  int lastMessageAt;
  Msg? lastMessage;
  int messageCount;

  bool get isGroup => kind == 'group';

  factory Room.fromJson(Map<String, dynamic> json) => Room(
    id: json['id'] as String,
    name: json['name'] as String? ?? '未命名',
    kind: json['kind'] as String? ?? 'group',
    botIds: ((json['botIds'] as List?) ?? const [])
        .whereType<String>()
        .toList(),
    botNames: ((json['botNames'] as List?) ?? const [])
        .whereType<String>()
        .toList(),
    leadBotId: json['leadBotId'] as String?,
    topic: json['topic'] as String? ?? '',
    lastMessageAt: _asInt(json['lastMessageAt']),
    lastMessage: json['lastMessage'] is Map<String, dynamic>
        ? Msg.fromJson(json['lastMessage'] as Map<String, dynamic>)
        : null,
    messageCount: _asInt(json['messageCount']),
  );
}

class Bot {
  Bot({
    required this.id,
    required this.name,
    this.emoji,
    this.role = 'member',
    this.model,
    this.thinking,
    this.persona = '',
    this.enabled = true,
  });

  final String id;
  String name;
  String? emoji;
  String role; // main | member
  String? model;
  String? thinking;
  String persona;
  bool enabled;

  bool get isMain => role == 'main';

  factory Bot.fromJson(Map<String, dynamic> json) => Bot(
    id: json['id'] as String,
    name: json['name'] as String? ?? json['id'] as String,
    emoji: json['emoji'] as String?,
    role: json['role'] as String? ?? 'member',
    model: json['model'] as String?,
    thinking: json['thinking'] as String?,
    persona: json['persona'] as String? ?? '',
    enabled: json['enabled'] as bool? ?? true,
  );
}

class ServerInfo {
  ServerInfo({
    this.version = '',
    this.hostname = '',
    this.workspace = '',
    this.model,
    this.note,
    this.tools = const [],
  });

  final String version;
  final String hostname;
  final String workspace;
  final String? model;
  final String? note;
  final List<String> tools;

  factory ServerInfo.fromJson(Map<String, dynamic> json) => ServerInfo(
    version: json['version'] as String? ?? '',
    hostname: json['hostname'] as String? ?? '',
    workspace: json['workspace'] as String? ?? '',
    model: json['model'] as String?,
    note: json['note'] as String?,
    tools: ((json['tools'] as List?) ?? const []).whereType<String>().toList(),
  );
}

enum LinkState { offline, connecting, online }
