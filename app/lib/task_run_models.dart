/// TaskRun 用户投影模型（独立于旧 TaskItem）。
///
/// 只解析服务端用户投影；不暴露内部字段名、模型路由参数或凭据。
/// revision（目标版本）/ sequence（领域事件序号）/ storeVersion（持久变化版本）
/// 各司其职，不能用其中一个替代另一个。
library;

int _asInt(Object? v, [int fallback = 0]) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v) ?? fallback;
  return fallback;
}

String _asString(Object? v, [String fallback = '']) =>
    v is String ? v : (v == null ? fallback : '$v');

/// 子任务参与者：谁在跟这份活、做到哪了。
class TaskRunChild {
  const TaskRunChild({
    required this.botId,
    required this.name,
    required this.state,
    required this.done,
  });

  final String botId;
  final String name;
  final String state;
  final bool done;

  factory TaskRunChild.fromJson(Map<String, dynamic> json) => TaskRunChild(
    botId: _asString(json['botId']),
    name: _asString(json['name']),
    state: _asString(json['state']),
    done: json['done'] == true,
  );
}
/// 子任务进度摘要：几份交了、几份还在跑。
class TaskRunChildren {
  const TaskRunChildren({
    required this.total,
    required this.done,
    required this.running,
    required this.waiting,
    this.participants = const [],
    this.participantsTruncated = 0,
    this.participantTotal = 0,
  });

  final int total;
  final int done;
  final int running;
  final int waiting;

  /// 参与者（谁在跟进这份任务）。
  final List<TaskRunChild> participants;

  /// 名单之外还有多少人。
  ///
  /// 部门人数超过名单上限时，界面必须说出来 —— 否则用户以为只有这几个人在跟，
  /// 实际有一整个部门在跑。
  final int participantsTruncated;

  /// 实际参与人数（含名单外的）。
  final int participantTotal;

  /// 名单之外还有人的提示文案（没有则为空串）。
  String get truncatedHint =>
      participantsTruncated > 0 ? '另有 $participantsTruncated 人参与' : '';

  factory TaskRunChildren.fromJson(Map<String, dynamic> json) => TaskRunChildren(
    total: _asInt(json['total']),
    done: _asInt(json['done']),
    running: _asInt(json['running']),
    waiting: _asInt(json['waiting']),
    participants: ((json['participants'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => TaskRunChild.fromJson(e.cast<String, dynamic>()))
        .toList(growable: false),
    participantsTruncated: _asInt(json['participantsTruncated']),
    participantTotal: _asInt(json['participantTotal']),
  );

  bool get isEmpty => total == 0;

  /// 给人看的一句话：`3/4 成员已交`。
  String get progressText => '$done/$total 成员已交';
}
class TaskRunBudget {
  const TaskRunBudget({
    this.maxRuns,
    this.usedRuns,
    this.extraRuns = 0,
    this.remaining,
  });

  final int? maxRuns;
  final int? usedRuns;
  final int extraRuns;
  final int? remaining;

  factory TaskRunBudget.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const TaskRunBudget();
    return TaskRunBudget(
      maxRuns: json['maxRuns'] == null ? null : _asInt(json['maxRuns']),
      usedRuns: json['usedRuns'] == null ? null : _asInt(json['usedRuns']),
      extraRuns: _asInt(json['extraRuns']),
      remaining: json['remaining'] == null ? null : _asInt(json['remaining']),
    );
  }

  bool get unlimited => maxRuns == null;
}

class TaskRunWaiting {
  const TaskRunWaiting({required this.kind, required this.ref, this.describe = ''});
  final String kind;
  final String ref;
  final String describe;

  factory TaskRunWaiting.fromJson(Map<String, dynamic>? json) => TaskRunWaiting(
        kind: _asString(json?['kind']),
        ref: _asString(json?['ref']),
        describe: _asString(json?['describe']),
      );
}

class TaskRunResult {
  const TaskRunResult({
    this.prepared = false,
    this.delivered = false,
    this.summary = '',
    this.at,
  });
  final bool prepared;
  final bool delivered;
  final String summary;
  final int? at;

  factory TaskRunResult.fromJson(Map<String, dynamic>? json) => TaskRunResult(
        prepared: json?['prepared'] == true,
        delivered: json?['delivered'] == true,
        summary: _asString(json?['summary']),
        at: json?['at'] == null ? null : _asInt(json!['at']),
      );
}

class TaskRun {
  const TaskRun({
    required this.id,
    required this.roomId,
    required this.rootTaskId,
    required this.parentTaskId,
    required this.revision,
    required this.sequence,
    required this.storeVersion,
    required this.state,
    required this.stateText,
    required this.title,
    required this.scope,
    required this.deliverables,
    required this.verificationCount,
    required this.unmet,
    required this.waiting,
    required this.blockedReason,
    required this.phase,
    this.childrenSummary,
    this.plan,
    this.leadBotId = '',
    this.leadBotName = '',
    required this.budget,
    required this.result,
    required this.admissionStatus,
    required this.updatedAt,
  });

  final String id;
  final String? roomId;
  final String rootTaskId;
  final String? parentTaskId;
  final int revision;
  final int sequence;
  final int storeVersion;
  final String state;
  final String stateText;
  final String title;
  final String scope;
  final List<String> deliverables;
  final int verificationCount;
  final List<String> unmet;
  final TaskRunWaiting? waiting;

  /// 受阻原因（非受阻时为空串）。
  final String blockedReason;

  /// 对外四类阶段：active / needs_user / paused / done。
  final String phase;

  /// 子任务进度（没有子任务时为 null）。
  final TaskRunChildren? childrenSummary;

  /// 分工计划（负责人列的步骤）。没列计划时为 null。
  final TaskRunPlan? plan;

  /// 负责人 Bot（谁在带这个任务）。
  final String leadBotId;
  final String leadBotName;
  final TaskRunBudget budget;
  final TaskRunResult result;
  final String? admissionStatus;
  final int updatedAt;

  factory TaskRun.fromJson(Map<String, dynamic> json) {
    final waiting = json['waiting'];
    return TaskRun(
      id: _asString(json['id']),
      roomId: json['roomId'] == null ? null : _asString(json['roomId']),
      rootTaskId: _asString(json['rootTaskId'], _asString(json['id'])),
      parentTaskId: json['parentTaskId'] == null ? null : _asString(json['parentTaskId']),
      revision: _asInt(json['revision'], 1),
      sequence: _asInt(json['sequence']),
      storeVersion: _asInt(json['storeVersion']),
      state: _asString(json['state'], 'unknown'),
      stateText: _asString(json['stateText'], '未知'),
      title: _asString(json['title']),
      scope: _asString(json['scope']),
      deliverables: ((json['deliverables'] as List?) ?? const [])
          .map(_asString)
          .where((x) => x.isNotEmpty)
          .toList(growable: false),
      verificationCount: _asInt(json['verificationCount']),
      unmet: ((json['unmet'] as List?) ?? const [])
          .map(_asString)
          .where((x) => x.isNotEmpty)
          .toList(growable: false),
      waiting: waiting is Map ? TaskRunWaiting.fromJson(waiting.cast<String, dynamic>()) : null,
      blockedReason: _asString(json['blockedReason']),
      phase: _asString(json['phase'], 'active'),
      leadBotId: _asString(json['leadBotId']),
      leadBotName: _asString(json['leadBotName']),
      childrenSummary: json['childrenSummary'] is Map
          ? TaskRunChildren.fromJson((json['childrenSummary'] as Map).cast<String, dynamic>())
          : null,
      plan: json['plan'] is Map
          ? TaskRunPlan.fromJson((json['plan'] as Map).cast<String, dynamic>())
          : null,
      budget: TaskRunBudget.fromJson(
        json['budget'] is Map ? (json['budget'] as Map).cast<String, dynamic>() : null,
      ),
      result: TaskRunResult.fromJson(
        json['result'] is Map ? (json['result'] as Map).cast<String, dynamic>() : null,
      ),
      admissionStatus: json['admission'] is Map
          ? _asString((json['admission'] as Map)['status'])
          : null,
      updatedAt: _asInt(json['updatedAt']),
    );
  }

  /// 是不是这棵任务树的根（列表里只展示根，子任务收在父任务下）。
  bool get isRoot => parentTaskId == null || parentTaskId!.isEmpty;

  bool get isActive => state != 'completed' && state != 'cancelled';
  bool get isDone => state == 'completed';
  bool get needsUser => state == 'waiting_approval' || state == 'waiting_input';
  bool get canPause => isActive && state != 'paused_user' && state != 'paused_budget';
  bool get canResume => state == 'paused_user';
  String get budgetText {
    final max = budget.maxRuns;
    if (max == null) return '不限';
    final left = budget.remaining ?? (max - (budget.usedRuns ?? 0));
    return '$left / $max';
  }
}


/// 负责人列的分工计划。
///
/// 计划一直存在服务端 taskRun.plan.steps 里，但以前从来没投影出来 ——
/// 用户看不出模型到底有没有先列计划，这一项等于不可验证。
class TaskRunPlan {
  const TaskRunPlan({this.steps = const [], this.at = 0, this.revision = 0});

  final List<TaskRunPlanStep> steps;
  final int at;
  final int revision;

  factory TaskRunPlan.fromJson(Map<String, dynamic> json) => TaskRunPlan(
    steps: ((json['steps'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => TaskRunPlanStep.fromJson(e.cast<String, dynamic>()))
        .toList(growable: false),
    at: _asInt(json['at']),
    revision: _asInt(json['revision']),
  );

  bool get isEmpty => steps.isEmpty;
  int get count => steps.length;
}

/// 计划里的一步。
class TaskRunPlanStep {
  const TaskRunPlanStep({
    this.index = 0,
    this.title = '',
    this.owner = '',
    this.status = 'pending',
  });

  final int index;
  final String title;
  final String owner;
  final String status;

  factory TaskRunPlanStep.fromJson(Map<String, dynamic> json) => TaskRunPlanStep(
    index: _asInt(json['index']),
    title: _asString(json['title']),
    owner: _asString(json['owner']),
    status: _asString(json['status'], 'pending'),
  );
}
