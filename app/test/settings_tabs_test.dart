import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/theme.dart';

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
}
