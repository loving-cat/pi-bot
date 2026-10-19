import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/local_capabilities_section.dart';

/// 「本机已装」区块的布局回归。
///
/// 这个区块的头部是「标题 + 名单预览 + 全部导入」。名单可能有 20 条、
/// 每条都是长英文名 —— Row 里的 Text 按固有宽度占位，一旦放不下就会把
/// 右边的「全部导入」整个挤到屏幕外（用户看到的就是按钮消失了）。
/// 这里盯两件事：
///   1. 长名单下按钮仍然在、且落在可视宽度内；
///   2. 不产生 RenderFlex overflow。
void main() {
  Widget host(AppState state, {double width = 480}) => AppScope(
    state: state,
    child: MaterialApp(
      theme: PB.theme(),
      home: Scaffold(
        body: MediaQuery(
          data: const MediaQueryData(size: Size(480, 720)),
          child: SizedBox(
            width: width,
            child: SingleChildScrollView(
              child: const LocalCapabilitiesSection(kind: 'skill', title: '技能'),
            ),
          ),
        ),
      ),
    ),
  );

  AppState stateWithSkills(List<String> names) {
    return AppState()
      ..localCapabilities = LocalCapabilities(
        skills: [
          for (final name in names) LocalSkillEntry(title: name, summary: '摘要'),
        ],
        skillsRoot: r'C:\Users\someone\.pi\agent\skills',
      );
  }

  final longNames = [
    for (var i = 0; i < 20; i++)
      'very-long-skill-name-$i-with-a-committee-suffix-and-more',
  ];

  testWidgets('20 个长名字：全部导入 按钮不会被挤掉', (tester) async {
    await tester.binding.setSurfaceSize(const Size(480, 720));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(host(stateWithSkills(longNames)));
    await tester.pump();

    expect(tester.takeException(), isNull, reason: '不应有布局溢出');

    final btn = find.text('全部导入');
    expect(btn, findsOneWidget);

    // 头部只放计数：不能把整个 List.toString() 打进界面（曾经的 $pending.length
    // 就插值成了整份名单 + 字面量 ".length"，一行扫出 11545px）。
    expect(find.textContaining('20 个 · 20 个可导入'), findsOneWidget);
    expect(find.textContaining('['), findsNothing);

    final rect = tester.getRect(btn);
    // 480 是容器宽度；按钮必须完整落在里面（溢出时它会跑到 >480）
    expect(rect.left, greaterThanOrEqualTo(0));
    expect(rect.right, lessThanOrEqualTo(480));
    expect(rect.width, greaterThan(30), reason: '按钮不能只剩一条缝');
  });

  testWidgets('纳窄到 280：文本省略，按钮仍在', (tester) async {
    await tester.binding.setSurfaceSize(const Size(280, 720));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(host(stateWithSkills(longNames), width: 280));
    await tester.pump();

    expect(tester.takeException(), isNull);
    final rect = tester.getRect(find.text('全部导入'));
    expect(rect.right, lessThanOrEqualTo(280));
    expect(rect.width, greaterThan(30));
  });

  testWidgets('全部已导入时不显示按钮，也不溢出', (tester) async {
    final state = AppState()
      ..localCapabilities = LocalCapabilities(
        skills: [
          for (final name in longNames)
            LocalSkillEntry(title: name, imported: true),
        ],
      );
    await tester.binding.setSurfaceSize(const Size(480, 720));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(host(state));
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(find.text('全部导入'), findsNothing);
    expect(find.textContaining('都导入了'), findsOneWidget);
  });
}
