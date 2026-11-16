import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/onboarding_model.dart';

// 首次授权页的归类（规格 §13.2）。
//
// 测的是 lib/onboarding_model.dart 的真实实现。这一层的错误方向都是
// "让用户以为能开始"或者"让用户永远开始不了"，两种都不会报错，
// 只会在界面上表现为一个点不动的按钮 —— 所以按状态逐个断言。

Map<String, dynamic> planJson({
  bool firstRun = true,
  bool startable = true,
  List<Map<String, dynamic>>? steps,
  List<Map<String, dynamic>> blockers = const [],
  List<String> cannot = const ['"项目受控模式"不是沙箱'],
}) {
  return {
    'firstRun': firstRun,
    'startable': startable,
    'steps': steps ??
        [
          {'id': 1, 'kind': 'tell', 'title': '能看到什么', 'lines': ['屏幕观察：可用']},
          {
            'id': 2,
            'kind': 'choose',
            'title': '项目与 Git 范围',
            'options': {
              'projects': [
                {'id': 'p-quant', 'label': 'quant-all-in', 'path': 'D:/quant-all-in'},
              ],
              'gitScopes': [
                {'id': 'none', 'label': '不用 Git', 'actions': <String>[]},
                {'id': 'commit', 'label': '读 + 本地提交', 'actions': ['git.read', 'git.commit']},
              ],
            },
            'separateApproval': [
              {'id': 'remote', 'title': '远端操作'},
            ],
            'recommended': {'projectId': 'p-quant', 'gitScope': 'commit'},
          },
          {
            'id': 3,
            'kind': 'choose',
            'title': '执行 Bot 的权限',
            'options': {
              'modes': [
                {'id': 'project'},
                {'id': 'isolated'},
              ],
            },
            'recommended': {'mode': 'project'},
          },
          {'id': 4, 'kind': 'confirm', 'title': '开始前的汇总'},
        ],
    'perCallConfirm': [
      {'id': 'security-config', 'title': '改动安全配置', 'always': true},
      {'id': 'external-mcp', 'title': '调用外部 MCP 工具', 'always': true},
    ],
    'boundaries': {
      'can': ['每次执行前核对当次有效授权'],
      'cannot': cannot,
    },
    'warnings': <Map<String, dynamic>>[],
    'blockers': blockers,
  };
}

void main() {
  group('步骤归类', () {
    test('四种 kind 一一对上', () {
      expect(onboardingStepKind('tell'), OnboardingStepKind.tell);
      expect(onboardingStepKind('choose'), OnboardingStepKind.choose);
      expect(onboardingStepKind('confirm'), OnboardingStepKind.confirm);
      expect(onboardingStepKind('report'), OnboardingStepKind.report);
    });

    test('★ 认不出来的当成"告知"，不是"选择"', () {
      // 认成 choose 会出现一个没有控件的选择步骤，把整页卡死
      expect(onboardingStepKind('whatever'), OnboardingStepKind.tell);
      expect(onboardingStepKind(null), OnboardingStepKind.tell);
      expect(onboardingStepKind(42), OnboardingStepKind.tell);
    });

    test('项目步和执行模式步能分出来', () {
      final plan = OnboardingPlan.fromJson(planJson());
      expect(plan.projectStep?.id, 2);
      expect(plan.modeStep?.id, 3);
      expect(plan.choiceSteps.length, 2);
      expect(plan.stepsOf(OnboardingStepKind.confirm).length, 1);
    });

    test('两条确认项是"不受 policy 影响"的那批', () {
      final plan = OnboardingPlan.fromJson(planJson());
      expect(plan.perCallConfirm, ['改动安全配置', '调用外部 MCP 工具']);
    });
  });

  group('页面状态', () {
    test('缺东西 → blocked，且按钮不显示', () {
      final plan = OnboardingPlan.fromJson(
        planJson(startable: false, blockers: [
          {'id': 'no-main-bot', 'text': '没有主 Bot'},
        ]),
      );
      expect(plan.stateOf(), OnboardingPageState.blocked);
      expect(plan.canStart(projectId: 'p-quant', gitScope: 'commit'), isFalse);
      expect(plan.headline(), '没有主 Bot');
      expect(plan.primaryActionText(), '');
    });

    test('★ startable 说是 true 但 blockers 非空 → 仍然 blocked', () {
      // 两个字段打架时按更保守的那个走：宁可拦下，也不要放一个没主 Bot 的任务进去
      final plan = OnboardingPlan.fromJson(planJson(blockers: [
        {'id': 'no-main-bot', 'text': '没有主 Bot'},
      ]));
      expect(plan.stateOf(projectId: 'p-quant', gitScope: 'commit'), OnboardingPageState.blocked);
    });

    test('齐了但没选 → needsChoice', () {
      final plan = OnboardingPlan.fromJson(planJson());
      expect(plan.stateOf(), OnboardingPageState.needsChoice);
      expect(plan.canStart(), isFalse);
      expect(plan.primaryActionText(), '还差选择');
    });

    test('只选了项目、没选 Git 档位 → 还不算选完', () {
      final plan = OnboardingPlan.fromJson(planJson());
      expect(plan.stateOf(projectId: 'p-quant'), OnboardingPageState.needsChoice);
    });

    test('Git 选 none 也算选过了（空不是一个"没选"）', () {
      final plan = OnboardingPlan.fromJson(planJson());
      expect(plan.choicesMade(projectId: 'p-quant', gitScope: 'none'), isTrue);
      expect(plan.stateOf(projectId: 'p-quant', gitScope: 'none'), OnboardingPageState.ready);
    });

    test('选完了 → ready，按钮是"开始"', () {
      final plan = OnboardingPlan.fromJson(planJson());
      expect(plan.stateOf(projectId: 'p-quant', gitScope: 'commit'), OnboardingPageState.ready);
      expect(plan.canStart(projectId: 'p-quant', gitScope: 'commit'), isTrue);
      expect(plan.primaryActionText(projectId: 'p-quant', gitScope: 'commit'), '开始');
    });

    test('不是首次 → configured，按钮换成"保存改动"', () {
      final plan = OnboardingPlan.fromJson(planJson(firstRun: false));
      final state = plan.stateOf(projectId: 'p-quant', gitScope: 'commit');
      expect(state, OnboardingPageState.configured);
      expect(plan.primaryActionText(projectId: 'p-quant', gitScope: 'commit'), '保存改动');
      // configured 不走"开始"，否则会重复发一次授权
      expect(plan.canStart(projectId: 'p-quant', gitScope: 'commit'), isFalse);
    });

    test('每种状态都有话说（不能有一条空文案）', () {
      final plan = OnboardingPlan.fromJson(planJson());
      for (final state in OnboardingPageState.values) {
        final text = switch (state) {
          OnboardingPageState.blocked => OnboardingPlan.fromJson(
              planJson(startable: false, blockers: [
                {'id': 'x', 'text': '缺项目'},
              ]),
            ).headline(),
          OnboardingPageState.needsChoice => plan.headline(),
          OnboardingPageState.ready => plan.headline(projectId: 'p-quant', gitScope: 'commit'),
          OnboardingPageState.configured =>
            OnboardingPlan.fromJson(planJson(firstRun: false)).headline(projectId: 'p-quant', gitScope: 'commit'),
        };
        expect(text.trim(), isNotEmpty, reason: '状态 $state 没有文案');
      }
    });
  });

  group('选项与初始值', () {
    test('推荐值在选项里就用推荐值', () {
      final plan = OnboardingPlan.fromJson(planJson());
      final step = plan.projectStep!;
      expect(initialChoice(step.projects, step.recommendedProjectId), 'p-quant');
      expect(initialChoice(step.gitScopes, step.recommendedGitScope), 'commit');
    });

    test('★ 推荐值不在选项里就退第一个（不显示一个列表里没有的值）', () {
      final plan = OnboardingPlan.fromJson(planJson());
      final step = plan.projectStep!;
      expect(initialChoice(step.projects, 'p-删掉了'), 'p-quant');
      expect(initialChoice(step.gitScopes, 'push'), 'none');
    });

    test('没有选项就是 null，不硬编一个', () {
      expect(initialChoice(const [], 'p-quant'), isNull);
      expect(initialChoice(const [], null), isNull);
    });

    test('选项带动作，界面能据此解释"这一档能不能推远端"', () {
      final plan = OnboardingPlan.fromJson(planJson());
      final scopes = plan.projectStep!.gitScopes;
      final commit = scopes.firstWhere((s) => s.id == 'commit');
      expect(commit.actions, ['git.read', 'git.commit']);
      expect(commit.actions.contains('git.push'), isFalse);
    });

    test('执行模式的选项里不该出现 host（服务端已经保证了，界面再守一遍）', () {
      final plan = OnboardingPlan.fromJson(planJson());
      expect(plan.modeStep!.modes.map((m) => m.id), isNot(contains('host')));
    });
  });

  group('边界文案', () {
    test('"不能"那一半要能解析出来（只说"能"是误导）', () {
      final plan = OnboardingPlan.fromJson(planJson());
      expect(plan.cannotDo, ['"项目受控模式"不是沙箱']);
      expect(plan.canDo, isNotEmpty);
    });

    test('缺字段不炸，只是空', () {
      final plan = OnboardingPlan.fromJson(const {});
      expect(plan.steps, isEmpty);
      expect(plan.cannotDo, isEmpty);
      expect(plan.startable, isFalse);
      expect(plan.stateOf(), OnboardingPageState.blocked);
    });

    test('脏数据不炸：options 不是 Map、steps 里混了非 Map', () {
      final plan = OnboardingPlan.fromJson({
        'firstRun': true,
        'startable': true,
        'steps': [
          42,
          {'id': 2, 'kind': 'choose', 'options': 'oops'},
          {'id': 3, 'kind': 'choose', 'options': {'modes': 'oops'}},
        ],
        'boundaries': 'oops',
      });
      expect(plan.steps.length, 2);
      expect(plan.projectStep, isNull, reason: '没有项目选项就不该当成项目步');
      expect(plan.cannotDo, isEmpty);
    });

    test('空计划 = 常量，不做 null 判断', () {
      const plan = OnboardingPlan.empty;
      expect(plan.steps, isEmpty);
      expect(plan.stateOf(), OnboardingPageState.blocked);
    });
  });
}
