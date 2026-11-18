import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/onboarding_model.dart';
import 'package:pi_bot/widgets/permission_setup_gate.dart';

// 首次授权页的界面（规格 §13.2）。
//
// 测的是 PermissionSetupView 的真实实现。三条是这里的重点，因为它们在界面上
// 出错时**不会报错**：
//   · "不能保证"那一段被折叠/漏渲染 → 用户以为硬隔离有保障；
//   · 按钮在不该能点的时候能点 → 提交一次没选完的授权；
//   · 下拉框的初始值取错 → 用户以为自己选的是 A，实际提交的是 B。

Map<String, dynamic> planJson({
  bool startable = true,
  List<Map<String, dynamic>> blockers = const [],
  bool firstRun = true,
}) {
  return {
    'firstRun': firstRun,
    'startable': startable,
    'blockers': blockers,
    'steps': [
      {
        'id': 1,
        'kind': 'tell',
        'title': '这台机器上，它能看到什么',
        'lines': ['屏幕观察：可用', '桌面键鼠：系统拒绝了授权'],
      },
      {
        'id': 2,
        'kind': 'choose',
        'title': '负责人项目与普通 Git 动作范围',
        'lines': ['选一个负责人项目'],
        'options': {
          'projects': [
            {'id': 'p-demo', 'label': 'orbis-demo', 'path': 'D:/projects/orbis-demo'},
            {'id': 'p-other', 'label': '另一个项目', 'path': 'D:/other'},
          ],
          'gitScopes': [
            {'id': 'none', 'label': '不用 Git', 'actions': <String>[]},
            {'id': 'commit', 'label': '读 + 本地提交（不碰远端）', 'actions': ['git.read', 'git.commit']},
          ],
        },
        'recommended': {'projectId': 'p-demo', 'gitScope': 'commit'},
      },
      {
        'id': 3,
        'kind': 'tell',
        'title': '执行 Bot 拿到什么、拿不到什么',
        'lines': ['host（可信宿主）只属于主 Bot'],
      },
      {'id': 4, 'kind': 'confirm', 'title': '开始前的汇总', 'lines': ['Git 范围：读 + 本地提交']},
    ],
    'perCallConfirm': [
      {'id': 'security-config', 'title': '改动安全配置', 'always': true},
      {'id': 'external-mcp', 'title': '调用外部 MCP 工具', 'always': true},
    ],
    'boundaries': {
      'can': ['每次执行前核对当次有效授权'],
      'cannot': ['"项目受控模式"不是沙箱：同用户下任何进程仍能读到别的文件'],
    },
    'warnings': [
      {'id': 'dangerous-not-ask', 'text': '危险动作现在是"照常放行"'},
    ],
  };
}

Widget host({
  Map<String, dynamic>? json,
  Future<void> Function(String, String)? onApply,
  VoidCallback? onDismiss,
  bool busy = false,
  String? initialProjectId,
  String? initialGitScope,
}) {
  final plan = OnboardingPlan.fromJson(json ?? planJson());
  return MaterialApp(
    home: Scaffold(
      body: PermissionSetupView(
        plan: plan,
        onApply: onApply,
        onDismiss: onDismiss,
        busy: busy,
        initialProjectId: initialProjectId,
        initialGitScope: initialGitScope,
      ),
    ),
  );
}

/// 桌面窗口够高才点得到按钮：这一页内容比手臂测试窗口长，
/// 默认 800x600 会把"开始"挤到屏幕外（点不到 ≠ 按钮禁用，两者要分清）。
Future<void> pumpPage(WidgetTester tester, Widget child) async {
  await tester.pumpWidget(child);
}

/// 这一页内容比测试窗口长，"开始"在屏幕外。
/// 先滚到它可见再点 —— 点不到和按钮禁用是两件事，别混。
Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pump();
}

void main() {
  testWidgets('四步都渲染出来（标题来自服务端）', (tester) async {
    await pumpPage(tester, host());
    expect(find.text('这台机器上，它能看到什么'), findsOneWidget);
    expect(find.text('负责人项目与普通 Git 动作范围'), findsOneWidget);
    expect(find.text('执行 Bot 拿到什么、拿不到什么'), findsOneWidget);
    expect(find.text('开始前的汇总'), findsOneWidget);
  });

  testWidgets('★ "不能保证"那一段必须显示（只说"能"是误导）', (tester) async {
    await pumpPage(tester, host());
    expect(find.textContaining('不是沙箱'), findsOneWidget);
    expect(find.textContaining('✓ 每次执行前核对'), findsOneWidget);
  });

  testWidgets('逐次确认那两条也在页面上（调宽档位也免不了）', (tester) async {
    await pumpPage(tester, host());
    expect(find.text('改动安全配置'), findsOneWidget);
    expect(find.text('调用外部 MCP 工具'), findsOneWidget);
  });

  testWidgets('选完了才点得动"开始"，且回传的是选中的值', (tester) async {
    String? gotProject;
    String? gotScope;
    await tester.pumpWidget(
      host(
        onApply: (p, g) async {
          gotProject = p;
          gotScope = g;
        },
      ),
    );
    final button = find.byType(FilledButton);
    expect(tester.widget<FilledButton>(button).onPressed, isNotNull);
    await tapVisible(tester, button);
    expect(gotProject, 'p-demo', reason: '推荐值应该被回填');
    expect(gotScope, 'commit');
  });

  testWidgets('★ 换项目后提交的是新选的那个（不是推荐值）', (tester) async {
    String? gotProject;
    await tester.pumpWidget(
      host(
        onApply: (p, g) async {
          gotProject = p;
        },
      ),
    );
    await tester.tap(find.text('orbis-demo').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('另一个项目').last);
    await tester.pumpAndSettle();
    await tapVisible(tester, find.byType(FilledButton));
    expect(gotProject, 'p-other');
  });

  testWidgets('★ 有阻断项时按钮点不动，文案说"还差东西"', (tester) async {
    var applied = false;
    await tester.pumpWidget(
      host(
        json: planJson(
          startable: false,
          blockers: [
            {'id': 'no-main-bot', 'text': '没有主 Bot'},
          ],
        ),
        onApply: (p, g) async {
          applied = true;
        },
      ),
    );
    final button = find.byType(FilledButton);
    expect(tester.widget<FilledButton>(button).onPressed, isNull);
    expect(find.text('还差东西'), findsOneWidget);
    await tester.ensureVisible(button);
    await tester.tap(button, warnIfMissed: false);
    expect(applied, isFalse);
  });

  testWidgets('没选完时按钮也点不动（避免提交一个没有边界的授权）', (tester) async {
    var applied = false;
    final json = planJson();
    (json['steps'] as List)[1] = {
      'id': 2,
      'kind': 'choose',
      'title': '负责人项目与普通 Git 动作范围',
      'options': {
        'projects': [
          {'id': 'p-demo', 'label': 'orbis-demo', 'path': 'D:/projects/orbis-demo'},
        ],
        'gitScopes': <Map<String, dynamic>>[],
      },
    };
    await tester.pumpWidget(
      host(
        json: json,
        onApply: (p, g) async {
          applied = true;
        },
      ),
    );
    expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull);
    expect(applied, isFalse);
  });

  testWidgets('★ 上次的选择优先于"推荐值"（回填是真的）', (tester) async {
    String? gotProject;
    String? gotScope;
    await tester.pumpWidget(
      host(
        initialProjectId: 'p-other',
        initialGitScope: 'none',
        onApply: (p, g) async {
          gotProject = p;
          gotScope = g;
        },
      ),
    );
    await tapVisible(tester, find.byType(FilledButton));
    expect(gotProject, 'p-other');
    expect(gotScope, 'none');
  });

  testWidgets('提交中按钮禁用并显示转圈（不重复提交）', (tester) async {
    await pumpPage(tester, host(busy: true, onApply: (p, g) async {}));
    expect(tester.widget<FilledButton>(find.byType(FilledButton)).onPressed, isNull);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('"稍后再说"能关掉，且不会提交任何东西', (tester) async {
    var dismissed = false;
    var applied = false;
    await tester.pumpWidget(
      host(
        onDismiss: () => dismissed = true,
        onApply: (p, g) async {
          applied = true;
        },
      ),
    );
    await tapVisible(tester, find.text('稍后再说'));
    expect(dismissed, isTrue);
    expect(applied, isFalse);
  });

  testWidgets('警告单独一段，不和"阻断"混在一起', (tester) async {
    await tester.pumpWidget(
      host(
        json: planJson(
          startable: false,
          blockers: [
            {'id': 'no-project', 'text': '没有可选的项目'},
          ],
        ),
      ),
    );
    expect(find.text('要留意'), findsOneWidget);
    expect(find.text('还差东西，开始不了'), findsOneWidget);
    expect(find.textContaining('没有可选的项目'), findsWidgets);
  });

  testWidgets('已配过的机器：按钮是"保存改动"，不是"开始"', (tester) async {
    await pumpPage(tester, host(json: planJson(firstRun: false)));
    expect(find.text('保存改动'), findsOneWidget);
    expect(find.text('开始'), findsNothing);
  });

  testWidgets('★ 提交失败要把错误显示出来（否则看起来像"点了没反应"）', (tester) async {
    await pumpPage(
      tester,
      MaterialApp(
        home: Scaffold(
          body: PermissionSetupView(
            plan: OnboardingPlan.fromJson(planJson()),
            errorText: '授权建立失败：网关未启用',
            onApply: (p, g) async {},
          ),
        ),
      ),
    );
    expect(find.textContaining('网关未启用'), findsOneWidget);
  });
}
