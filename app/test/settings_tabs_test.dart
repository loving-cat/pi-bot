import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/settings_screen.dart';
import 'package:pi_bot/theme.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 技能库与设置页标签的纯展示测试。
///
/// 不渲染整个 SettingsScreen：它依赖 AppScope、网络和路由，
/// 在单元测试里搭那一整套容易变成"测了个假的"。
/// 这里只验两件真正容易出错的事：
///   1. [LibrarySkill] 的解析与搜索（标签页的搜索框靠它过滤）；
///   2. 标签条在切换时确实重建内容（用 AnimatedSwitcher 的 key 变化）。
void main() {
  Widget host(Widget child) => MaterialApp(
        theme: PB.theme(),
        home: Scaffold(body: child),
      );

  group('技能条目解析', () {
    test('完整字段', () {
      final s = LibrarySkill.fromJson({
        'id': 'sk_1',
        'title': '线上排查三步',
        'summary': '线上出问题先走这个',
        'howto': '1. 看日志\n2. 看 pid',
        'tags': ['运维', '排查'],
        'enabled': true,
      });
      expect(s.id, 'sk_1');
      expect(s.title, '线上排查三步');
      expect(s.summary, '线上出问题先走这个');
      expect(s.tags, ['运维', '排查']);
      expect(s.enabled, isTrue);
    });

    test('字段缺失时按空处理，不崩', () {
      final s = LibrarySkill.fromJson({});
      expect(s.title, '');
      expect(s.tags, isEmpty);
      expect(s.enabled, isTrue, reason: '没写 enabled 视为启用');
    });

    test('enabled 显式 false 才算停用', () {
      expect(LibrarySkill.fromJson({'enabled': false}).enabled, isFalse);
      expect(LibrarySkill.fromJson({'enabled': true}).enabled, isTrue);
    });
  });

  group('技能搜索', () {
    final skill = LibrarySkill(
      id: 'sk_1',
      title: '线上排查三步',
      summary: '线上出问题先走这个',
      howto: '先看 server.log 再看 pid',
      tags: const ['运维'],
    );

    test('空查询匹配一切', () {
      expect(skill.matches(''), isTrue);
      expect(skill.matches('   '), isTrue);
    });

    test('按标题 / 摘要 / 标签 / 正文都能搜到', () {
      expect(skill.matches('排查'), isTrue, reason: '标题');
      expect(skill.matches('出问题'), isTrue, reason: '摘要');
      expect(skill.matches('运维'), isTrue, reason: '标签');
      expect(skill.matches('server.log'), isTrue, reason: '正文');
    });

    test('大小写不敏感', () {
      expect(skill.matches('SERVER.LOG'), isTrue);
    });

    test('搜不到就是不匹配', () {
      expect(skill.matches('发版'), isFalse);
    });
  });

  group('标签切换机制', () {
    testWidgets('AnimatedSwitcher 在 key 变化时换内容', (tester) async {
      // 复刻设置页的切换方式：key 随 _tab 变化 → 触发过渡动画
      Widget build(int tab) => host(
            Column(
              children: [
                Text('当前: $tab'),
                Expanded(
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 200),
                    child: Text(
                      '页面 $tab',
                      key: ValueKey<int>(tab),
                    ),
                  ),
                ),
              ],
            ),
          );

      await tester.pumpWidget(build(0));
      expect(find.text('页面 0'), findsOneWidget);

      await tester.pumpWidget(build(1));
      await tester.pump(const Duration(milliseconds: 250));
      expect(find.text('页面 1'), findsOneWidget);
      // 切换完成后旧内容必须消失（否则会叠在一起）
      expect(find.text('页面 0'), findsNothing);
    });
  });

  // 标签与内容错位过一次：四个 tab 的文案是 连接 / 服务端 / 技能 / 应用连接 /
  // 系统 / 高级，而 switch 分支把"系统"接到了应用连接的内容上 —— 点开"系统"
  // 看到的是网站集成，还以为是权限页坏了。所以这里直接钉接线。
  group('标签与内容对齐', () {
    late String source;
    setUpAll(() {
      source = File('lib/screens/settings_screen.dart').readAsStringSync();
    });

    test('标签顺序固定（内容分支按下标取，顺序一变就全错位）', () {
      final itemsStart = source.indexOf('static const _items');
      final itemsEnd = source.indexOf('];', itemsStart);
      final seg = source.substring(itemsStart, itemsEnd);
      final keys = RegExp(r"labelKey: '([^']+)'")
          .allMatches(seg)
          .map((m) => m.group(1))
          .toList();
      expect(keys, [
        'settings.tab.connect',
        'settings.tab.server',
        'settings.tab.skills',
        'settings.tab.sites',
        'settings.tab.system',
        'settings.tab.advanced',
      ]);
    });

    test('「系统」页给的是权限那几块（不是网站集成）', () {
      expect(source.contains('4 => const ['), isTrue);
      final branch = source.substring(source.indexOf('4 => const ['));
      final body = branch.substring(0, branch.indexOf('],') + 2);
      expect(body, contains('DesktopApprovalSection'));
      expect(body, contains('GrantsSection'));
      expect(body, isNot(contains('SitesSection')), reason: '网站集成不属于系统页');
    });

    test('网站集成归到「应用连接」页（和 MCP 一起）', () {
      expect(source, contains('3 => const [McpSection(), SitesSection()]'));
    });
  });

  group('手机端与桌面端设置隔离', () {
    AppState buildState() {
      final s = AppState()
        ..serverUrl = 'https://192.168.1.10:8443'
        ..token = 't_test'
        ..deviceName = '我的Pixel'
        ..link = LinkState.online
        ..serverFingerprint = 'ab' * 32
        ..grantsLoaded = true
        ..grantAuditLoaded = true
        ..serverInfo = ServerInfo(
          hostname: 'workstation-pc',
          model: 'openai/gpt-5',
          version: '1.4.2',
          workspace: 'D:/secret/pc-workspace',
          dataDir: 'D:/secret/pc-data',
        );
      return s;
    }

    Future<void> pumpSettings(
      WidgetTester tester, {
      required bool hostOverride,
      required Size size,
    }) async {
      SharedPreferences.setMockInitialValues({});
      tester.view.devicePixelRatio = 2.0;
      tester.view.physicalSize = Size(size.width * 2, size.height * 2);
      addTearDown(tester.view.reset);

      final state = buildState();
      addTearDown(state.dispose);

      await tester.pumpWidget(
        AppScope(
          state: state,
          child: L10n(
            controller: LocaleController(),
            child: MaterialApp(
              theme: PB.theme(),
              home: SettingsScreen(hostOverride: hostOverride),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));
    }

    testWidgets('★ 手机端仅显示 3 个精简标签，隔离 PC 宿主设置与本地路径', (tester) async {
      for (final size in const [Size(360, 800), Size(320, 640)]) {
        await pumpSettings(tester, hostOverride: false, size: size);
        expect(tester.takeException(), isNull);

        expect(find.text('连接与设备'), findsOneWidget);
        expect(find.text('权限与安全'), findsOneWidget);
        expect(find.text('通知与偏好'), findsOneWidget);

        // PC 专属宿主运维标签彻底隔离
        expect(find.text('服务端'), findsNothing);
        expect(find.text('技能'), findsNothing);
        expect(find.text('应用连接'), findsNothing);
        expect(find.text('系统'), findsNothing);
        expect(find.text('高级'), findsNothing);

        // Tab 0：连接与设备只展示主机摘要，不暴露 PC 本地目录与固定口令引导
        expect(find.text('workstation-pc'), findsOneWidget);
        expect(find.text('openai/gpt-5'), findsOneWidget);
        expect(find.text('1.4.2'), findsOneWidget);
        expect(find.text('我的Pixel'), findsOneWidget);
        expect(find.text('换一台电脑'), findsOneWidget);
        expect(find.text('断开重新配对'), findsOneWidget);
        expect(find.textContaining('pc-workspace'), findsNothing);
        expect(find.textContaining('pc-data'), findsNothing);
        expect(find.textContaining('PI_BOT_TOKEN'), findsNothing);
      }

      // Tab 1：权限与安全仅保留授权与审计，不出现 PC 本机批准/合成鼠标开关
      await tester.tap(find.text('权限与安全'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));
      expect(tester.takeException(), isNull);
      expect(find.text('授权'), findsOneWidget);
      expect(find.text('最近的授权判定'), findsOneWidget);
      expect(find.text('允许在本机批准'), findsNothing);

      // Tab 2：通知与偏好含后台通知、称呼、外观与语言
      await tester.tap(find.text('通知与偏好'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));
      expect(tester.takeException(), isNull);
      expect(find.text('后台通知'), findsOneWidget);
      expect(find.text('我是谁'), findsOneWidget);
      expect(find.text('外观'), findsOneWidget);
      expect(find.text('深色'), findsOneWidget);
      expect(find.text('浅色'), findsOneWidget);
      expect(find.text('语言'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('appearance-light')));
      await tester.pump();
      expect(pbColorMode.value, PBColorMode.light);
      addTearDown(() => pbColorMode.value = PBColorMode.dark);
    });

    testWidgets('★ 桌面端（PC 宿主）完整保留原有 6 个设置标签', (tester) async {
      await pumpSettings(tester, hostOverride: true, size: const Size(1200, 800));
      expect(tester.takeException(), isNull);

      expect(find.text('连接'), findsOneWidget);
      expect(find.text('服务端'), findsOneWidget);
      expect(find.text('技能'), findsOneWidget);
      expect(find.text('应用连接'), findsOneWidget);
      expect(find.text('系统'), findsOneWidget);
      expect(find.text('高级'), findsOneWidget);
      expect(find.text('连接与设备'), findsNothing);
    });
  });
}
