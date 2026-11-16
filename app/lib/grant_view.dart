/// 授权记录的展示口径（纯逻辑，无网络、无 Widget）。
///
/// 规格 §11「用户始终可以接管、取消、收回授权」。
///
/// 服务端从 P0-1 起就有授权记录和 `revoke()`，但界面里一个字都没有 ——
/// 用户看不到“谁能动什么”，那等于收不回：他连该收哪一条都不知道。
///
/// 这一层只做三件事，都不需要 Widget 就能测：
///   1. 把服务端的授权记录读成能显示的东西（动作、范围、期限、次数）；
///   2. 判断它相对**当前规矩版本**是不是“按旧规矩批的”；
///   3. 给出人话。
///
/// 为什么“旧规矩”要在界面上单独标出来：规矩一改，服务端的网关就会按
/// `policyChanged` 拒掉这些授权（grants.js 的 checkGrantValidity）。
/// 也就是说它们**此刻已经不管用了**。界面上还把它们画成正常授权，
/// 用户会以为“我明明授权了，它怎么还在报没权限”—— 那是我们没讲清楚。
library;

/// 动作名 → 人话。服务端 `grants.js` 的 ACTION 就是这么几个点号名字。
const Map<String, String> grantActionLabels = {
  'file.read': '读文件',
  'file.write': '写文件',
  'file.delete': '删文件',
  'cmd.exec': '跑命令',
  'cmd.background': '后台进程',
  'git.read': '读仓库',
  'git.commit': '本地提交',
  'git.push': '推远端',
  'git.destructive': '破坏性 Git',
  'desktop.observe': '看屏幕',
  'desktop.input': '操作屏幕',
  'net.fetch': '访问网络',
  'net.send': '对外发送',
  'secret.use': '用凭据',
  'policy.change': '改规矩',
  'mcp.add': '加 MCP',
};

/// 一条授权的展示快照。
class GrantView {
  GrantView({
    required this.id,
    required this.botId,
    this.role = '',
    this.source = '',
    this.actions = const [],
    this.resourceRefs = const [],
    this.mode = '',
    this.policyRevision,
    this.generation,
    this.expiresAt,
    this.maxUses,
    this.usedUses = 0,
    this.canDelegate = false,
  });

  final String id;
  final String botId;
  final String role;
  final String source;
  final List<String> actions;

  /// 资源范围的 `kind:ref` 文本。空表示“不设限”（迁移授权就是这样）。
  final List<String> resourceRefs;
  final String mode;

  /// 这条授权是基于哪一版规矩批的。和当前版本不一致时它已经不管用了。
  final String? policyRevision;

  /// 这条授权绑在哪个进程实例上 —— **只有任务级授权才有值**。
  ///
  /// 规格 §6.3：上个进程给任务的批准，重启后不该续命。所以任务级授权带世代，
  /// 而用户/规矩立的长期授权**不带**（它们不该因为重启失效 ——
  /// 2026-11-16 修过一个 bug：以前所有授权都带，重启一次全灭）。
  final String? generation;
  final int? expiresAt;
  final int? maxUses;
  final int usedUses;
  final bool canDelegate;

  factory GrantView.fromJson(Map<String, dynamic> json) => GrantView(
    id: json['id'] as String? ?? '',
    botId: (json['subject'] as Map?)?['botId'] as String? ?? '',
    role: (json['subject'] as Map?)?['role'] as String? ?? '',
    source: json['source'] as String? ?? '',
    actions: ((json['actions'] as List?) ?? const [])
        .map((a) => '$a')
        .where((a) => a.isNotEmpty)
        .toList(),
    resourceRefs: ((json['resources'] as List?) ?? const [])
        .whereType<Map>()
        .map((r) => '${r['kind']}:${r['ref']}')
        .where((s) => s != 'null:null')
        .toList(),
    mode: json['mode'] as String? ?? '',
    policyRevision: json['policyRevision'] as String?,
    generation: json['generation'] as String?,
    expiresAt: (json['expiresAt'] as num?)?.toInt(),
    maxUses: (json['maxUses'] as num?)?.toInt(),
    usedUses: (json['usedUses'] as num?)?.toInt() ?? 0,
    canDelegate: json['canDelegate'] == true,
  );

  /// 这条授权是按旧规矩批的 —— 服务端此刻会以 policy_changed 拒掉它。
  ///
  /// 只比“两版都非空”的情况：迁移授权在旧数据里可能没有版本号，
  /// 拿 null 去比会把它们全标成过期，反而制造噪音。
  bool staleForPolicy(String? currentRevision) {
    final mine = policyRevision;
    final now = currentRevision;
    if (mine == null || mine.isEmpty || now == null || now.isEmpty) return false;
    return mine != now;
  }

  /// 这条授权是不是**本实例不可用**（任务级授权跨重启就失效）。
  ///
  /// 只比"两边都非空"：长期授权不带世代，拿 null 去比会把它全标成不可用，
  /// 反而制造噪音（和 `staleForPolicy` 同一个口径）。
  bool staleForGeneration(String? currentGeneration) {
    final mine = generation;
    final now = currentGeneration;
    if (mine == null || mine.isEmpty || now == null || now.isEmpty) return false;
    return mine != now;
  }

  /// 动作清单的短句（超过三个折叠成“等 N 项”）。
  String get actionSummary {
    final labels = actions.map((a) => grantActionLabels[a] ?? a).toList();
    if (labels.isEmpty) return '（空）';
    if (labels.length <= 3) return labels.join('、');
    return '${labels.take(3).join('、')} 等 ${labels.length} 项';
  }

  /// 范围短句。空范围是“不设限”，必须明说 —— 那是最宽的一档。
  String get scopeSummary => resourceRefs.isEmpty ? '不限范围' : resourceRefs.join('、');

  /// 期限 / 次数的短句。
  String get limitSummary {
    if (maxUses == null) return '不限次数';
    return '已用 $usedUses/$maxUses 次';
  }

  bool expiredAt(int nowMs) => expiresAt != null && expiresAt! <= nowMs;
}

/// 把 `/api/grants` 的返回读成展示用列表。坏数据直接跳过，不让界面崩。
List<GrantView> grantsFromResponse(Map<String, dynamic>? json) {
  final list = (json?['grants'] as List?) ?? const [];
  return list
      .whereType<Map>()
      .map((e) => GrantView.fromJson(e.cast<String, dynamic>()))
      .where((g) => g.id.isNotEmpty && g.botId.isNotEmpty)
      .toList();
}

/// 一条网关判定记录（`GET /api/grant-audit`）。
///
/// 规格 §5.5：动作要可审计。服务端一直在记，但之前没有接口读出去 ——
/// 出问题时“这活为什么被拒”只能翻服务端日志，而日志重启就滚没了。
class GrantAuditEntry {
  GrantAuditEntry({
    required this.at,
    this.botId = '',
    this.role = '',
    this.action = '',
    this.risk = '',
    this.result = '',
    this.code = '',
    this.detail = '',
    this.targets = const [],
    this.grantId,
  });

  final int at;
  final String botId;
  final String role;
  final String action;
  final String risk;

  /// `allow` 或 `deny`。
  final String result;

  /// 拒绝原因码（`no_grant` / `resource_not_covered` …），放行时为空。
  final String code;
  final String detail;
  final List<String> targets;
  final String? grantId;

  bool get allowed => result == 'allow';

  factory GrantAuditEntry.fromJson(Map<String, dynamic> json) => GrantAuditEntry(
    at: (json['at'] as num?)?.toInt() ?? 0,
    botId: json['botId'] as String? ?? '',
    role: json['role'] as String? ?? '',
    action: json['action'] as String? ?? '',
    risk: json['risk'] as String? ?? '',
    result: json['result'] as String? ?? '',
    code: json['code'] as String? ?? '',
    detail: json['detail'] as String? ?? '',
    targets: ((json['targets'] as List?) ?? const [])
        .map((t) => '$t')
        .where((t) => t.isNotEmpty)
        .toList(),
    grantId: json['grantId'] as String?,
  );

  /// 一句话摘要：动作 + 结果 + 目标。
  String get summary {
    final label = grantActionLabels[action] ?? action;
    final verdict = allowed ? '放行' : '拒绝';
    final scope = targets.isEmpty ? '' : '（${targets.join('、')}）';
    return '$label · $verdict$scope';
  }
}

/// 把 `/api/grant-audit` 的返回读成展示用列表。
List<GrantAuditEntry> grantAuditFromResponse(Map<String, dynamic>? json) {
  final list = (json?['audit'] as List?) ?? const [];
  return list
      .whereType<Map>()
      .map((e) => GrantAuditEntry.fromJson(e.cast<String, dynamic>()))
      .where((e) => e.action.isNotEmpty)
      .toList();
}
