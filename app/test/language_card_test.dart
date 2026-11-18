import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/language_card.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<LocaleController> pump(WidgetTester tester) async {
    final controller = LocaleController();
    await tester.pumpWidget(
      L10n(
        controller: controller,
        child: const MaterialApp(home: Scaffold(body: LanguageCard())),
      ),
    );
    await tester.pump();
    return controller;
  }

  Color? pillColor(WidgetTester tester, String code) {
    final material = tester.widget<Material>(
      find.byKey(ValueKey('language-$code')),
    );
    return material.color;
  }

  testWidgets('卡片内不再重复标题，只留一句说明', (tester) async {
    await pump(tester);
    // 小节标题在卡片外面（settings 页），卡片里不该再说一次「语言」
    expect(find.text('语言'), findsNothing);
    expect(find.text('切换后立即生效，不需要重启'), findsOneWidget);
  });

  testWidgets('选中只靠颜色：选中的有底色，未选中是透明的', (tester) async {
    await pump(tester);
    final context = tester.element(find.byType(LanguageCard));
    final accentSoft = PB.colors(context).accentSoft;

    expect(pillColor(tester, 'zh'), accentSoft);
    expect(pillColor(tester, 'en'), Colors.transparent);
  });

  testWidgets('点另一个语言就换色，没有对勾', (tester) async {
    final controller = await pump(tester);
    await tester.tap(find.byKey(const ValueKey('language-en')));
    await tester.pump(const Duration(milliseconds: 200));

    expect(controller.language, AppLanguage.en);
    final context = tester.element(find.byType(LanguageCard));
    final accentSoft = PB.colors(context).accentSoft;
    expect(pillColor(tester, 'en'), accentSoft);
    expect(pillColor(tester, 'zh'), Colors.transparent);
    // 不再有对勾图标
    expect(find.byIcon(Icons.check), findsNothing);
  });
}
