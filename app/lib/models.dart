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

/// 一个被改动过的文件
class ChangedFile {
  const ChangedFile({required this.path, this.size = 0});

  final String path;
  final int size;

  factory ChangedFile.fromJson(Map<String, dynamic> json) => ChangedFile(
    path: json['path'] as String? ?? '',
    size: (json['size'] as num?)?.toInt() ?? 0,
  );
}

/// 一条定时任务
class Automation {
  const Automation({
    required this.id,
    required this.title,
    this.roomId,
    this.prompt = '',
    this.enabled = true,
    this.everyMinutes,
    this.dailyAt,
    this.nextRunAt = 0,
    this.lastRunAt = 0,
  });

  final String id;
  final String title;
  final String? roomId;
  final String prompt;
  final bool enabled;
  final int? everyMinutes;
  final String? dailyAt;
  final int nextRunAt;
  final int lastRunAt;

  /// "每 30 分钟" / "每天 09:30"
  String get scheduleLabel {
    if (everyMinutes != null) return '每 $everyMinutes 分钟';
    if (dailyAt != null) return '每天 $dailyAt';
    return '未排期';
  }

  factory Automation.fromJson(Map<String, dynamic> json) => Automation(
    id: json['id'] as String? ?? '',
    title: json['title'] as String? ?? '',
    roomId: json['roomId'] as String?,
    prompt: json['prompt'] as String? ?? '',
    enabled: json['enabled'] != false,
    everyMinutes: (json['everyMinutes'] as num?)?.toInt(),
    dailyAt: json['dailyAt'] as String?,
    nextRunAt: (json['nextRunAt'] as num?)?.toInt() ?? 0,
    lastRunAt: (json['lastRunAt'] as num?)?.toInt() ?? 0,
  );
}

/// 任务板上的一条任务
class TaskItem {
  const TaskItem({
    required this.id,
    required this.title,
    this.status = 'open',
    this.ownerName,
    this.roomId,
    this.detail = '',
    this.unreadAt = 0,
    this.pinnedAt = 0,
    this.updatedAt = 0,
  });

  final String id;
  final String title;

  /// open | doing | done
  final String status;
  final String? ownerName;
  final String? roomId;
  final String detail;
  final int unreadAt;
  final int pinnedAt;
  final int updatedAt;

  bool get isDone => status == 'done';
  bool get isDoing => status == 'doing';
  bool get isPinned => pinnedAt > 0;
  bool get isUnread => unreadAt > 0;

  factory TaskItem.fromJson(Map<String, dynamic> json) => TaskItem(
    id: json['id'] as String? ?? '',
    title: json['title'] as String? ?? '',
    status: json['status'] as String? ?? 'open',
    ownerName: json['ownerName'] as String?,
    roomId: json['roomId'] as String?,
    detail: json['detail'] as String? ?? '',
    unreadAt: (json['unreadAt'] as num?)?.toInt() ?? 0,
    pinnedAt: (json['pinnedAt'] as num?)?.toInt() ?? 0,
    updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
  );
}

/// 一轮里工作目录的改动摘要（新增 / 修改 / 删除）
class ChangedSummary {
  const ChangedSummary({
    this.added = const [],
    this.modified = const [],
    this.removed = const [],
    this.total = 0,
    this.truncated = false,
  });

  final List<ChangedFile> added;
  final List<ChangedFile> modified;
  final List<ChangedFile> removed;
  final int total;
  final bool truncated;

  bool get isEmpty => total == 0;

  factory ChangedSummary.fromJson(Map<String, dynamic> json) {
    List<ChangedFile> parse(Object? raw) => raw is List
        ? raw
              .whereType<Map>()
              .map((e) => ChangedFile.fromJson(e.cast<String, dynamic>()))
              .toList()
        : const [];
    return ChangedSummary(
      added: parse(json['added']),
      modified: parse(json['modified']),
      removed: parse(json['removed']),
      total: (json['total'] as num?)?.toInt() ?? 0,
      truncated: json['truncated'] == true,
    );
  }
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
    this.kind = 'text',
    this.refs = const [],
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

  /// 'text' = 普通消息；'ref' = 不画气泡，只渲染"已发送给 XX"的小浮动条
  final String kind;

  /// 跨会话引用（bot 给别的 bot 发了私信时留在来源房间的指针）
  final List<MsgRef> refs;

  String? error;
  Map<String, dynamic>? usage;
  Map<String, dynamic>? meta;

  bool get isUser => authorType == 'user';
  bool get isStreaming => status == 'streaming';

  /// 用户主动终止的（按 Esc）。服务端写 status='aborted'。
  ///
  /// 为什么单独一个状态而不是复用 'error'：终止不是"出错"。
  /// 在终端里按 Esc 停下就是停下，界面不该冒一个红字气泡问"要不要重试"，
  /// 也不该在聊天记录里留一行"已按你的要求终止" —— 用户自己按的，他知道。
  bool get isAborted => status == 'aborted';
  bool get isRef => kind == 'ref' && refs.isNotEmpty;

  /// 上下文压缩的提示条（服务端在压缩成功后写一条 kind='compact'）
  bool get isCompact => kind == 'compact';

  /// "要用户拿个主意"的卡片（服务端 ask_user 工具写的 kind='ask'）
  bool get isAsk => kind == 'ask';

  /// 卡片上的选项
  List<AskOption> get askOptions {
    final raw = meta?['options'];
    if (raw is! List) return const [];
    return raw
        .whereType<Map>()
        .map((e) => AskOption.fromJson(e.cast<String, dynamic>()))
        .toList();
  }

  /// 本轮改了哪些文件（服务端跑完对比工作目录写进 meta.changed）
  ChangedSummary? get changes {
    final raw = meta?['changed'];
    if (raw is! Map) return null;
    final parsed = ChangedSummary.fromJson(raw.cast<String, dynamic>());
    return parsed.total > 0 ? parsed : null;
  }

  /// 审批卡片（危险动作第三档：ask）
  bool get isApproval => kind == 'approval';
  String? get approvalId => meta?['approvalId'] as String?;
  String? get approvalTool => meta?['tool'] as String?;
  String? get approvalSummary => meta?['summary'] as String?;

  /// 已经决定过了：approved / denied / consumed；空 = 还在等
  String? get approvalDecision => meta?['decision'] as String?;

  /// 要不要同时给一个"我自己说"的输入框
  bool get askAllowCustom => meta?['allowCustom'] != false;

  /// 用户已经回答过这张卡片（点了选项或自己写了一句）
  String? get askAnswer => meta?['answer'] as String?;

  /// 这张卡片是否已经用过 —— 用过就不再接受第二次点击。
  ///
  /// 除了服务端写回的 answer，还兼容一种情况：用户刚点了、请求还在路上，
  /// 由卡片自己先置上本地已答（见 AskCard）。
  bool get askAnswered => (meta?['answer'] as String?)?.isNotEmpty == true;
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
    kind: json['kind'] as String? ?? 'text',
    refs: ((json['refs'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => MsgRef.fromJson(e.cast<String, dynamic>()))
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
    this.leadName,
    this.leadEmoji,
    this.topic = '',
    this.lastMessageAt = 0,
    this.lastMessage,
    this.messageCount = 0,
    this.pinned = false,
    this.hidden = false,
    this.unread = false,
  });

  final String id;
  String name;
  final String kind; // dm | group
  final List<String> botIds;
  final List<String> botNames;
  final String? leadBotId;

  /// 部门老大（群才有）
  final String? leadName;
  final String? leadEmoji;
  final String topic;
  int lastMessageAt;
  Msg? lastMessage;
  int messageCount;

  /// 右键菜单里的「置顶」—— 排在最前面
  final bool pinned;

  /// 「从侧边栏隐藏」—— 列表里不显示（底部留一个入口能翻出来）
  final bool hidden;

  /// 「标为未读」—— 纯手动标记，只是提醒自己回头看
  final bool unread;

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
    leadName: json['leadName'] as String?,
    leadEmoji: json['leadEmoji'] as String?,
    topic: json['topic'] as String? ?? '',
    lastMessageAt: _asInt(json['lastMessageAt']),
    lastMessage: json['lastMessage'] is Map<String, dynamic>
        ? Msg.fromJson(json['lastMessage'] as Map<String, dynamic>)
        : null,
    messageCount: _asInt(json['messageCount']),
    pinned: json['pinned'] as bool? ?? false,
    hidden: json['hidden'] as bool? ?? false,
    unread: json['unread'] as bool? ?? false,
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
    this.tagline = '',
    this.persona = '',
    List<BotSkill>? skills,
    List<String>? mcpServers,
    this.enabled = true,
    this.reserveTokens,
    this.keepRecentTokens,
  }) : skills = skills ?? [],
       mcpServers = mcpServers ?? [];

  final String id;
  String name;
  String? emoji;
  String role; // main | member
  String? model;
  String? thinking;

  /// 上下文预算（null = 用全局默认）。
  /// 服务端一直支持这两个值，客户端以前根本没解析 —— 所以面板里也就改不了。
  int? reserveTokens;
  int? keepRecentTokens;

  /// 给用户看的一句话简介（persona 是给模型的系统提示，不能直接展示）
  String tagline;
  String persona;

  /// 用户手把手教给它的做法（SOP）。服务端会拼进系统提示词，让 bot 真的"学会"。
  List<BotSkill> skills;

  /// 这个 bot 要连哪几个 MCP 服务（存**名字**，不存 id）。
  /// 空 = 不连 —— MCP 会真起子进程，默认一个都不挂。
  List<String> mcpServers;
  bool enabled;

  bool get isMain => role == 'main';

  factory Bot.fromJson(Map<String, dynamic> json) => Bot(
    id: json['id'] as String,
    name: json['name'] as String? ?? json['id'] as String,
    emoji: json['emoji'] as String?,
    role: json['role'] as String? ?? 'member',
    model: json['model'] as String?,
    thinking: json['thinking'] as String?,
    reserveTokens: (json['reserveTokens'] as num?)?.toInt(),
    keepRecentTokens: (json['keepRecentTokens'] as num?)?.toInt(),
    persona: json['persona'] as String? ?? '',
    skills: ((json['skills'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => BotSkill.fromJson(e.cast<String, dynamic>()))
        .toList(),
    mcpServers: ((json['mcpServers'] as List?) ?? const [])
        .map((e) => '$e')
        .where((e) => e.isNotEmpty)
        .toList(),
    enabled: json['enabled'] as bool? ?? true,
  );
}

/// 本机 pi 上已经装好的能力（只读扫描的结果）。
///
/// 存在的意义：用户在终端里用 pi 时早就装了一堆 skill / MCP，
/// 但 pi-bot 是独立进程、默认不加载。扫描出来让他一键导入，
/// 比让他把已有的东西再手抄一遍合理。
class LocalCapabilities {
  LocalCapabilities({
    List<LocalSkillEntry>? skills,
    List<LocalMcpEntry>? mcpServers,
    this.skillsRoot = '',
    this.mcpFile = '',
  })  : skills = skills ?? [],
        mcpServers = mcpServers ?? [];

  final List<LocalSkillEntry> skills;
  final List<LocalMcpEntry> mcpServers;

  /// 从哪儿扫的（界面上展示，让用户知道去哪个目录看）
  final String skillsRoot;
  final String mcpFile;

  bool get isEmpty => skills.isEmpty && mcpServers.isEmpty;

  factory LocalCapabilities.fromJson(Map<String, dynamic> json) {
    final from = (json['scannedFrom'] as Map?) ?? const {};
    return LocalCapabilities(
      skills: ((json['skills'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => LocalSkillEntry.fromJson(e.cast<String, dynamic>()))
          .toList(),
      mcpServers: ((json['mcpServers'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => LocalMcpEntry.fromJson(e.cast<String, dynamic>()))
          .toList(),
      skillsRoot: '${from['skills'] ?? ''}',
      mcpFile: '${from['mcp'] ?? ''}',
    );
  }
}

/// 本机扫到的一条 skill
class LocalSkillEntry {
  LocalSkillEntry({
    required this.title,
    this.summary = '',
    this.howto = '',
    this.imported = false,
    this.truncated = false,
  });

  final String title;
  final String summary;
  final String howto;

  /// 库里已经有了（同名）
  final bool imported;

  /// 正文太长被截断过
  final bool truncated;

  factory LocalSkillEntry.fromJson(Map<String, dynamic> json) => LocalSkillEntry(
    title: json['title'] as String? ?? '',
    summary: json['summary'] as String? ?? '',
    howto: json['howto'] as String? ?? '',
    imported: json['imported'] as bool? ?? false,
    truncated: json['truncated'] as bool? ?? false,
  );
}

/// 本机 mcp.json 里的一条服务
class LocalMcpEntry {
  LocalMcpEntry({
    required this.name,
    this.type = 'stdio',
    this.description = '',
    this.command = '',
    this.url = '',
    this.imported = false,
  });

  final String name;
  final String type;
  final String description;
  final String command;
  final String url;
  final bool imported;

  bool get isHttp => type == 'http';
  String get target => isHttp ? url : command;

  factory LocalMcpEntry.fromJson(Map<String, dynamic> json) => LocalMcpEntry(
    name: json['name'] as String? ?? '',
    type: json['type'] as String? ?? 'stdio',
    description: json['description'] as String? ?? '',
    command: json['command'] as String? ?? '',
    url: json['url'] as String? ?? '',
    imported: json['imported'] as bool? ?? false,
  );
}

/// 一个 MCP 服务（设置 → MCP 里配的）。
///
/// 与技能的区别：技能是往提示词里塞做法，MCP 是**真去起进程 / 连服务**。
/// 所以默认 `enabled == false` —— 加进来只是"待配"，要显式打开才开始连。
class McpServer {
  McpServer({
    required this.id,
    required this.name,
    this.type = 'stdio',
    this.description = '',
    this.enabled = false,
    this.exposure = 'direct',
    this.timeout = 60,
    this.command = '',
    List<String>? args,
    Map<String, String>? env,
    this.cwd = '',
    this.url = '',
    Map<String, String>? headers,
  })  : args = args ?? [],
        env = env ?? const {},
        headers = headers ?? const {};

  final String id;

  /// 名字会变成工具前缀（`mcp__<name>__<tool>`），只能是字母数字下划线短横线
  String name;
  String type; // stdio | http
  String description;
  bool enabled;

  /// 工具怎么暴露给模型：direct / deferred / codemode / hidden
  String exposure;
  int timeout;

  // stdio
  String command;
  List<String> args;
  Map<String, String> env;
  String cwd;

  // http
  String url;
  Map<String, String> headers;

  bool get isHttp => type == 'http';

  /// 一句话目标（列表里显示用）
  String get target =>
      isHttp ? url : ([command, ...args].where((e) => e.isNotEmpty).join(' '));

  factory McpServer.fromJson(Map<String, dynamic> json) => McpServer(
    id: json['id'] as String? ?? '',
    name: json['name'] as String? ?? '',
    type: json['type'] as String? ?? 'stdio',
    description: json['description'] as String? ?? '',
    enabled: json['enabled'] as bool? ?? false,
    exposure: json['exposure'] as String? ?? 'direct',
    timeout: (json['timeout'] as num?)?.toInt() ?? 60,
    command: json['command'] as String? ?? '',
    args: ((json['args'] as List?) ?? const []).map((e) => '$e').toList(),
    env: {
      for (final e in ((json['env'] as Map?) ?? const {}).entries)
        '${e.key}': '${e.value}',
    },
    cwd: json['cwd'] as String? ?? '',
    url: json['url'] as String? ?? '',
    headers: {
      for (final e in ((json['headers'] as Map?) ?? const {}).entries)
        '${e.key}': '${e.value}',
    },
  );
}

/// 一个 (会话 × bot) 的上下文占用情况。
///
/// `tokens == null` 表示"现在还不知道"（刚压缩完、或者还没轮到它说话）——
/// 这时候界面该显示"—"而不是 0%，否则用户会以为上下文是空的。
class ContextInfo {
  ContextInfo({
    this.tokens,
    this.contextWindow,
    this.percent,
    this.compacting = false,
  });

  final int? tokens;
  final int? contextWindow;

  /// 0..100
  final double? percent;

  /// 正在压缩上下文
  final bool compacting;

  bool get known => tokens != null && (contextWindow ?? 0) > 0;

  factory ContextInfo.fromJson(Map<String, dynamic> json) => ContextInfo(
    tokens: (json['tokens'] as num?)?.toInt(),
    contextWindow: (json['contextWindow'] as num?)?.toInt(),
    percent: (json['percent'] as num?)?.toDouble(),
    compacting: json['compacting'] as bool? ?? false,
  );

  ContextInfo copyWith({bool? compacting}) => ContextInfo(
    tokens: tokens,
    contextWindow: contextWindow,
    percent: percent,
    compacting: compacting ?? this.compacting,
  );
}

/// 一张"问用户要选择"的卡片上的一个选项
class AskOption {
  AskOption({required this.label, this.detail = ''});

  final String label;
  final String detail;

  factory AskOption.fromJson(Map<String, dynamic> json) => AskOption(
    label: json['label'] as String? ?? '',
    detail: json['detail'] as String? ?? '',
  );
}

/// 用户自己加的一个「模型组」—— 一套 baseUrl + key + 一组 modelId。
///
/// 服务端那份是真 key（不出服务端），这里拿到的 key 是**打码后的**，
/// 只用来显示"有没有配"和"配的是哪个"。
class ModelGroup {
  ModelGroup({
    required this.id,
    required this.name,
    required this.baseUrl,
    this.api = 'openai-completions',
    this.hasKey = false,
    this.keyMasked = '',
    List<ModelSpec>? models,
    this.enabled = true,
    this.builtin = false,
  }) : models = models ?? [];

  final String id;
  String name;
  String baseUrl;
  String api;
  bool hasKey;

  /// 形如 `sk-abc…xyzw`
  String keyMasked;
  List<ModelSpec> models;
  bool enabled;

  /// 从本机已有配置带出来的（我们自己在用的那套）—— 不给删
  final bool builtin;

  /// 给模型选择器用：`<组id>/<模型id>` —— 和 pi 的 slug 格式一致
  String slugFor(String modelId) => '$id/$modelId';

  factory ModelGroup.fromJson(Map<String, dynamic> json) => ModelGroup(
    id: json['id'] as String,
    name: json['name'] as String? ?? '未命名模型组',
    baseUrl: json['baseUrl'] as String? ?? '',
    api: json['api'] as String? ?? 'openai-completions',
    hasKey: json['hasKey'] as bool? ?? false,
    keyMasked: json['keyMasked'] as String? ?? '',
    enabled: json['enabled'] as bool? ?? true,
    builtin: json['builtin'] as bool? ?? false,
    models: ((json['models'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => ModelSpec.fromJson(e.cast<String, dynamic>()))
        .toList(),
  );
}

/// 模型组里的一个模型
class ModelSpec {
  ModelSpec({
    required this.id,
    this.name = '',
    this.contextWindow = 0,
    this.maxTokens = 0,
    this.reasoning = false,
    this.thinkingFormat = '',
    this.thinkingLevelMap = const {},
    this.thinkingLevels = const [],
  });

  final String id;
  String name;
  int contextWindow;
  int maxTokens;

  /// 这个模型会不会思考（上游支持 reasoning / thinking）
  bool reasoning;

  /// 思考走哪种上游格式（deepseek / openai / zai …）；空 = 用 pi 默认
  String thinkingFormat;

  /// pi 的档位 → 上游值；null 表示这一档不额外传参数
  Map<String, String?> thinkingLevelMap;

  /// 服务端算好的「这个模型实际可选的档位」。
  ///
  /// 后台关掉思考 → 空列表 → 前台不展示思考档位；
  /// 只映射了部分档位 → 前台只给这几档。
  /// 仅由 `/api/models` 回包填充，模型组里保存的那份不带这个字段。
  List<String> thinkingLevels;

  /// 这个模型是否可用某档位（模型组配置里没声明时不做限制，交给后端判断）
  bool supportsThinkingLevel(String level) =>
      thinkingLevels.isEmpty ? false : thinkingLevels.contains(level);

  factory ModelSpec.fromJson(Map<String, dynamic> json) => ModelSpec(
    id: json['id'] as String? ?? '',
    name: json['name'] as String? ?? '',
    contextWindow: _asInt(json['contextWindow']),
    maxTokens: _asInt(json['maxTokens']),
    reasoning: json['reasoning'] as bool? ?? false,
    thinkingFormat: json['thinkingFormat'] as String? ?? '',
    thinkingLevelMap: {
      for (final entry in ((json['thinkingLevelMap'] as Map?) ?? const {}).entries)
        '${entry.key}': entry.value == null ? null : '${entry.value}',
    },
    thinkingLevels: ((json['thinkingLevels'] as List?) ?? const [])
        .map((e) => '$e')
        .toList(),
  );
}

/// 一条"教它做一项任务"的记录。
class BotSkill {
  BotSkill({required this.id, required this.title, required this.howto});

  final String id;
  String title;
  String howto;

  factory BotSkill.fromJson(Map<String, dynamic> json) => BotSkill(
    id: json['id'] as String? ?? '',
    title: json['title'] as String? ?? '',
    howto: json['howto'] as String? ?? '',
  );

  Map<String, dynamic> toJson() => {'id': id, 'title': title, 'howto': howto};
}

/// 已接入的外部 Web 系统。
///
/// 一个系统对应一个部门（"把一个系统简化为一个团队"）。
/// 口令不下发到客户端 —— 只回 hasPassword，改口令时重新提交。
class SiteSystem {
  SiteSystem({
    required this.id,
    required this.name,
    required this.baseUrl,
    this.account = '',
    this.hasPassword = false,
    this.loginPath = '',
    this.teamRoomId = '',
    this.connected = false,
    this.lastError = '',
  });

  final String id;
  String name;
  String baseUrl;
  String account;
  bool hasPassword;
  String loginPath;
  String teamRoomId;
  bool connected;
  String lastError;

  factory SiteSystem.fromJson(Map<String, dynamic> json) => SiteSystem(
    id: json['id'] as String? ?? '',
    name: json['name'] as String? ?? '',
    baseUrl: json['baseUrl'] as String? ?? '',
    account: json['account'] as String? ?? '',
    hasPassword: json['hasPassword'] == true,
    loginPath: json['loginPath'] as String? ?? '',
    teamRoomId: json['teamRoomId'] as String? ?? '',
    connected: json['connected'] == true,
    lastError: json['lastError'] as String? ?? '',
  );
}

/// 技能库（全局，所有 bot 共享）里的一条。
///
/// 与 [BotSkill] 的区别：那是"某个 bot 自己会的事"，全量进它的系统提示；
/// 这里存在库里，可以有很多条，按任务挑几条注入 —— 所以多了摘要、标签和启停。
class LibrarySkill {
  LibrarySkill({
    required this.id,
    required this.title,
    this.summary = '',
    this.howto = '',
    List<String>? tags,
    this.enabled = true,
    this.createdAt = 0,
    this.updatedAt = 0,
  }) : tags = tags ?? [];

  final String id;
  String title;
  String summary;
  String howto;
  List<String> tags;
  bool enabled;
  final int createdAt;
  final int updatedAt;

  factory LibrarySkill.fromJson(Map<String, dynamic> json) => LibrarySkill(
    id: json['id'] as String? ?? '',
    title: json['title'] as String? ?? '',
    summary: json['summary'] as String? ?? '',
    howto: json['howto'] as String? ?? '',
    tags: ((json['tags'] as List?) ?? const [])
        .map((t) => '$t')
        .where((t) => t.isNotEmpty)
        .toList(),
    enabled: json['enabled'] != false,
    createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
    updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
  );

  /// 搜索用：标题 + 摘要 + 标签 + 正文
  bool matches(String query) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return true;
    return title.toLowerCase().contains(q) ||
        summary.toLowerCase().contains(q) ||
        howto.toLowerCase().contains(q) ||
        tags.any((t) => t.toLowerCase().contains(q));
  }
}

/// 一条经验（lessons）：从**实际执行**里长出来的"下次别这么做/就这么做"。
///
/// 和技能的区别：技能是人整理的做法（静态）；经验是做过之后的成败，带证据、
/// 可以被推翻。只有 status == active 的会进主控提示词，而且一次最多 3 条。
class LibraryLesson {
  LibraryLesson({
    required this.id,
    this.roomId = '',
    this.dept = '',
    this.cue = '',
    this.lesson = '',
    List<LessonEvidence>? evidence,
    this.verdict = 'confounded',
    this.status = 'candidate',
    this.hits = 0,
    this.createdAt = 0,
    this.lastUsedAt = 0,
  }) : evidence = evidence ?? [];

  final String id;
  final String roomId;
  final String dept;

  /// 什么情况下用得上（情境的形状，不是这次的事实）
  final String cue;

  /// 下次具体怎么做
  final String lesson;

  /// 证据：哪条消息里说过什么（人审计用，不进提示词）
  final List<LessonEvidence> evidence;

  /// helped / hurt / no_effect / confounded
  final String verdict;

  /// candidate（候选，不注入）/ active（启用）/ archived（归档）
  final String status;

  final int hits;
  final int createdAt;
  final int lastUsedAt;

  bool get isActive => status == 'active';
  bool get isCandidate => status == 'candidate';

  static const verdictLabels = {
    'helped': '有效',
    'hurt': '不好',
    'no_effect': '没差别',
    'confounded': '说不清',
  };

  String get verdictLabel => verdictLabels[verdict] ?? verdict;

  factory LibraryLesson.fromJson(Map<String, dynamic> json) => LibraryLesson(
    id: json['id'] as String? ?? '',
    roomId: json['roomId'] as String? ?? '',
    dept: json['dept'] as String? ?? '',
    cue: json['cue'] as String? ?? '',
    lesson: json['lesson'] as String? ?? '',
    evidence: ((json['evidence'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => LessonEvidence.fromJson(e.cast<String, dynamic>()))
        .toList(),
    verdict: json['verdict'] as String? ?? 'confounded',
    status: json['status'] as String? ?? 'candidate',
    hits: (json['hits'] as num?)?.toInt() ?? 0,
    createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
    lastUsedAt: (json['lastUsedAt'] as num?)?.toInt() ?? 0,
  );
}

/// 一条经验的证据：引用哪条消息里的哪句话
class LessonEvidence {
  LessonEvidence({this.msgId = '', this.quote = ''});

  final String msgId;
  final String quote;

  factory LessonEvidence.fromJson(Map<String, dynamic> json) => LessonEvidence(
    msgId: json['msgId'] as String? ?? '',
    quote: json['quote'] as String? ?? '',
  );
}

/// 跨会话引用：bot 给别的 bot 发了私信，在**来源房间**留下一个指针。
///
/// 用户因此能看到“它把活派给了谁”，点开还能看他们聊了什么。
class MsgRef {
  MsgRef({required this.botId, required this.roomId, this.count});

  /// 收信方的 bot id
  final String botId;

  /// 他们俩那个私聊房间的 id（点开看聊天记录用）
  final String roomId;

  /// 他俩那个私聊里现在有多少条消息。
  /// 界面用它显示「5 条消息往来」—— 用户要的是"进展到哪一步了"，
  /// 只写"已发送给 X"看不出有多少来回。
  final int? count;

  factory MsgRef.fromJson(Map<String, dynamic> json) => MsgRef(
    botId: json['botId'] as String? ?? '',
    roomId: json['roomId'] as String? ?? '',
    count: (json['count'] as num?)?.toInt(),
  );
}

class ServerInfo {
  ServerInfo({
    this.version = '',
    this.hostname = '',
    this.workspace = '',
    this.dataDir = '',
    this.model,
    this.note,
    this.tools = const [],
  });

  final String version;
  final String hostname;
  final String workspace;

  /// 服务端把数据存在哪儿（房间/会话/上传/工作目录都在它下面）。
  /// 这是用户最该知道的东西 —— 不能让它“神秘换掉”。
  final String dataDir;

  final String? model;
  final String? note;
  final List<String> tools;

  factory ServerInfo.fromJson(Map<String, dynamic> json) => ServerInfo(
    version: json['version'] as String? ?? '',
    hostname: json['hostname'] as String? ?? '',
    workspace: json['workspace'] as String? ?? '',
    dataDir: json['dataDir'] as String? ?? '',
    model: json['model'] as String?,
    note: json['note'] as String?,
    tools: ((json['tools'] as List?) ?? const []).whereType<String>().toList(),
  );
}

enum LinkState { offline, connecting, online }
