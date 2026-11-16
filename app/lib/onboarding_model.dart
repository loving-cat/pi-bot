/// 首次授权页的**归类与判定**（纯逻辑，无网络、无 Widget）。
///
/// 规格 §13.2。服务端 `server/src/onboarding.js` 负责"该说什么"，
/// 这一层只负责三件事：
///
///   1. 把服务端那五步归成**四类**：告知 / 选择 / 汇总确认 / 收尾报告；
///   2. 把整页归成**四种状态**：被阻断 / 等用户选 / 可以开始 / 已经配过；
///   3. 决定"开始"按钮能不能点、以及点不了的时候第一句该说什么。
///
/// ## 为什么要归类，而不是照着服务端的话原样渲染
///
/// 五步里只有两步需要用户动手，而且两处选择的交互完全不同
/// （一处选项目和 Git 档位，一处选执行模式）。如果界面按"第几步"排版，
/// 就得写死"第 2 步和第 3 步有控件"，服务端哪天改了顺序，
/// 界面上就会出现一个没有控件的"选择"步骤 —— 用户点不动也退不出。
///
/// ## 为什么要四种状态而不是一个 bool
///
/// `startable` 一个字段说不清三件不同的事："缺东西动不了"（该去补 bot/项目）、
/// "东西齐了但你没选"（该点选）、"都好了"（该点开始）、
/// "你早就配过了，这页是给你回头调整的"。这四种情况下按钮文案、
/// 主色、能否关闭都不一样，压成一个 bool 就只能猜。
library;

/// 步骤的四种类型。服务端的 `kind` 就这几个值。
enum OnboardingStepKind {
  /// 只是告知（这台机器上能看到什么、硬隔离的边界在哪）
  tell,

  /// 要用户选（项目与 Git 范围 / 执行 Bot 的模式）
  choose,

  /// 开始前的汇总确认
  confirm,

  /// 跑完之后的收尾报告（产物、测试边界、回收）
  report,
}

/// 服务端的 `kind` → 界面用的枚举。
///
/// 认不出来的一律当成 [OnboardingStepKind.tell]：告知类**没有交互控件**，
/// 认错最坏的结果是"少显示一个选择框"，用户还能继续往下走；
/// 反过来认成 `choose` 就会出现一个永远选不完的步骤，把整页卡死。
OnboardingStepKind onboardingStepKind(Object? raw) {
  switch (raw) {
    case 'choose':
      return OnboardingStepKind.choose;
    case 'confirm':
      return OnboardingStepKind.confirm;
    case 'report':
      return OnboardingStepKind.report;
    default:
      return OnboardingStepKind.tell;
  }
}

/// 一页的四种状态。
enum OnboardingPageState {
  /// 有阻断项（没有主 Bot / 没有可选项目）—— 先去补，这页只能看
  blocked,

  /// 可以开始，但用户还没选完
  needsChoice,

  /// 都齐了，可以点开始
  ready,

  /// 已经有授权了。这页当"查看 / 调整"用，不再是首启
  configured,
}

/// 一个可选项（项目 / Git 档位 / 执行模式都用它）。
class OnboardingChoice {
  const OnboardingChoice({required this.id, required this.label, this.actions = const [], this.note = ''});

  final String id;
  final String label;
  final List<String> actions;
  final String note;

  factory OnboardingChoice.fromJson(Map<String, dynamic> json) {
    return OnboardingChoice(
      id: (json['id'] ?? '').toString(),
      label: (json['label'] ?? json['id'] ?? '').toString(),
      actions: (json['actions'] is List)
          ? (json['actions'] as List).map((e) => e.toString()).toList(growable: false)
          : const [],
      note: (json['note'] ?? '').toString(),
    );
  }
}

/// 一步。
class OnboardingStep {
  const OnboardingStep({
    required this.id,
    required this.kind,
    required this.title,
    this.lines = const [],
    this.projects = const [],
    this.gitScopes = const [],
    this.modes = const [],
    this.recommendedProjectId,
    this.recommendedGitScope,
    this.recommendedMode,
  });

  final int id;
  final OnboardingStepKind kind;
  final String title;
  final List<String> lines;

  /// 第 2 步的选项（其他步骤是空表）
  final List<OnboardingChoice> projects;
  final List<OnboardingChoice> gitScopes;

  /// 第 3 步的选项
  final List<OnboardingChoice> modes;

  final String? recommendedProjectId;
  final String? recommendedGitScope;
  final String? recommendedMode;

  /// 这一步要不要画控件。
  bool get hasChoices =>
      kind == OnboardingStepKind.choose && (projects.isNotEmpty || gitScopes.isNotEmpty || modes.isNotEmpty);

  factory OnboardingStep.fromJson(Map<String, dynamic> json) {
    List<OnboardingChoice> choices(Object? raw) {
      if (raw is! List) return const [];
      final out = <OnboardingChoice>[];
      for (final item in raw) {
        if (item is Map) out.add(OnboardingChoice.fromJson(item.cast<String, dynamic>()));
      }
      return out;
    }

    final options = json['options'] is Map ? (json['options'] as Map).cast<String, dynamic>() : const <String, dynamic>{};
    final recommended =
        json['recommended'] is Map ? (json['recommended'] as Map).cast<String, dynamic>() : const <String, dynamic>{};
    return OnboardingStep(
      id: json['id'] is int ? json['id'] as int : int.tryParse('${json['id']}') ?? 0,
      kind: onboardingStepKind(json['kind']),
      title: (json['title'] ?? '').toString(),
      lines: (json['lines'] is List) ? (json['lines'] as List).map((e) => e.toString()).toList(growable: false) : const [],
      projects: choices(options['projects']),
      gitScopes: choices(options['gitScopes']),
      modes: choices(options['modes']),
      recommendedProjectId: recommended['projectId']?.toString(),
      recommendedGitScope: recommended['gitScope']?.toString(),
      recommendedMode: recommended['mode']?.toString(),
    );
  }
}

/// 整页。
class OnboardingPlan {
  const OnboardingPlan({
    required this.firstRun,
    this.legacyGrants = 0,
    required this.steps,
    required this.perCallConfirm,
    required this.canDo,
    required this.cannotDo,
    required this.warnings,
    required this.blockers,
    required this.startable,
  });

  final bool firstRun;

  /// 升级前遗留的迁移授权条数。
  ///
  /// ★ 它和 [firstRun] 是两个方向的事：迁移授权存在 ≠ 用户走过首启流程
  ///   （服务端每次启动都会补发，见 `migration-grants.js`）。
  ///   界面要把它们分开说：那些授权范围 = 旧规矩，**不会**因为这次选择而自动收窄。
  final int legacyGrants;

  final List<OnboardingStep> steps;

  /// 要逐次确认的条目**标题**（服务端已经把"不受 policy 影响"的那几条分开列好了）
  final List<String> perCallConfirm;

  /// 硬隔离边界：能保证的 / 不能保证的。
  /// 界面必须把 [cannotDo] 显示出来 —— 只说"能"是误导。
  final List<String> canDo;
  final List<String> cannotDo;

  final List<String> warnings;
  final List<String> blockers;
  final bool startable;

  static const empty = OnboardingPlan(
    firstRun: true,
    steps: [],
    perCallConfirm: [],
    canDo: [],
    cannotDo: [],
    warnings: [],
    blockers: [],
    startable: false,
  );

  List<OnboardingStep> stepsOf(OnboardingStepKind kind) =>
      steps.where((s) => s.kind == kind).toList(growable: false);

  /// 需要用户动手的步骤（一到两步，看服务端有几处选择）
  List<OnboardingStep> get choiceSteps => stepsOf(OnboardingStepKind.choose);

  OnboardingStep? stepOrNull(int id) {
    for (final s in steps) {
      if (s.id == id) return s;
    }
    return null;
  }

  /// 第 2 步（项目 + Git 范围）
  OnboardingStep? get projectStep {
    for (final s in choiceSteps) {
      if (s.projects.isNotEmpty || s.gitScopes.isNotEmpty) return s;
    }
    return null;
  }

  /// 第 3 步（执行模式）
  OnboardingStep? get modeStep {
    for (final s in choiceSteps) {
      if (s.projects.isEmpty && s.gitScopes.isEmpty && s.modes.isNotEmpty) return s;
    }
    return null;
  }

  /// 两个选择都做完了才算选完。
  ///
  /// ★ 项目必须选：没有项目就没有授权边界，那等于"什么都能碰"。
  ///   Git 档位允许是 `none`，但那也是一个明确的值 —— `null` 才叫没选。
  bool choicesMade({String? projectId, String? gitScope}) =>
      (projectId ?? '').isNotEmpty && (gitScope ?? '').isNotEmpty;

  OnboardingPageState stateOf({String? projectId, String? gitScope}) {
    if (!startable || blockers.isNotEmpty) return OnboardingPageState.blocked;
    if (!firstRun) return OnboardingPageState.configured;
    if (!choicesMade(projectId: projectId, gitScope: gitScope)) {
      return OnboardingPageState.needsChoice;
    }
    return OnboardingPageState.ready;
  }

  /// "开始"能不能点。**只有 ready**。配过的状态单独走"保存改动"。
  bool canStart({String? projectId, String? gitScope}) =>
      stateOf(projectId: projectId, gitScope: gitScope) == OnboardingPageState.ready;

  /// 顶上的第一句话。状态不同说什么完全不同 —— 用一句通用文案盖住，
  /// 用户就会在"缺东西"和"没选完"之间反复点同一个灰按钮。
  String headline({String? projectId, String? gitScope}) {
    switch (stateOf(projectId: projectId, gitScope: gitScope)) {
      case OnboardingPageState.blocked:
        return blockers.isNotEmpty ? blockers.first : '还差东西，先按下面的提示补齐';
      case OnboardingPageState.needsChoice:
        return '还差两处要做决定：项目与 Git 范围、执行 Bot 的权限';
      case OnboardingPageState.ready:
        return '都齐了。开始之后它会在你选的范围里干活，越界会被拒';
      case OnboardingPageState.configured:
        return '你已经配过了。这里可以回头调整范围，或收回不再需要的授权';
    }
  }

  /// 状态对应的按钮文案（空串 = 不显示主按钮）。
  String primaryActionText({String? projectId, String? gitScope}) {
    switch (stateOf(projectId: projectId, gitScope: gitScope)) {
      case OnboardingPageState.blocked:
        return '';
      case OnboardingPageState.needsChoice:
        return '还差选择';
      case OnboardingPageState.ready:
        return '开始';
      case OnboardingPageState.configured:
        return '保存改动';
    }
  }

  factory OnboardingPlan.fromJson(Map<String, dynamic> json) {
    List<String> strings(Object? raw) {
      if (raw is! List) return const [];
      return raw.map((e) => e is Map ? (e['text'] ?? e['title'] ?? '').toString() : e.toString()).toList(growable: false);
    }

    final boundaries =
        json['boundaries'] is Map ? (json['boundaries'] as Map).cast<String, dynamic>() : const <String, dynamic>{};
    return OnboardingPlan(
      firstRun: json['firstRun'] != false,
      legacyGrants: json['legacyGrants'] is int ? json['legacyGrants'] as int : 0,
      steps: (json['steps'] is List)
          ? (json['steps'] as List)
              .whereType<Map>()
              .map((e) => OnboardingStep.fromJson(e.cast<String, dynamic>()))
              .toList(growable: false)
          : const [],
      perCallConfirm: (json['perCallConfirm'] is List)
          ? (json['perCallConfirm'] as List)
              .whereType<Map>()
              .map((e) => (e['title'] ?? e['id'] ?? '').toString())
              .toList(growable: false)
          : const [],
      canDo: strings(boundaries['can']),
      cannotDo: strings(boundaries['cannot']),
      warnings: strings(json['warnings']),
      blockers: strings(json['blockers']),
      startable: json['startable'] == true,
    );
  }
}

/// 初始值：先看服务端推荐，推荐值**不在选项里**就退第一个。
///
/// 为什么不能直接信推荐值：服务端的推荐是按它当时看到的项目算的，
/// 界面可能拿着旧数据（服务刚重启、项目刚被删）。信了就会出现
/// "下拉框显示的项目不在列表里"这种查起来很费劲的状态。
String? initialChoice(List<OnboardingChoice> options, String? recommended) {
  if (options.isEmpty) return null;
  final rec = recommended ?? '';
  if (rec.isNotEmpty && options.any((o) => o.id == rec)) return rec;
  return options.first.id;
}
