import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/l10n/l10n.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/bot_delete_confirm.dart';

/// 删除助手必须二次确认 —— 这个动作没有撤销。
///
/// 之前助手编辑页的删除按钮直接调 deleteBot，点一下就没了；
/// 会话列表右键删除却有确认框。两处行为不一致，编辑页那条是隐患。
void main() {
  Bot bot() => Bot(
    id: 'b_x',
    name: '数据工程师',
    emoji: '📊',
    persona: '',
  );

  Widget host({required Future<void> Function(String) onDelete, required void Function(bool) onResult}) {
    return L10n(
      controller: LocaleController(),
      child: MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (ctx) => Center(
              child: ElevatedButton(
                onPressed: () async {
                  final r = await confirmDeleteBot(ctx, bot(), delete: onDelete);
                  onResult(r);
                },
                child: const Text('删除'),
              ),
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('★ 点删除先弹确认框，不直接删', (tester) async {
    var deleted = false;
    await tester.pumpWidget(host(
      onDelete: (_) async => deleted = true,
      onResult: (_) {},
    ));
    await tester.tap(find.text('删除'));
    await tester.pumpAndSettle();

    // 确认框出现，且还没删
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(deleted, false, reason: '只弹框，不能已经删了');
  });

  testWidgets('★ 取消 → 不删除', (tester) async {
    var deleted = false;
    bool? result;
    await tester.pumpWidget(host(
      onDelete: (_) async => deleted = true,
      onResult: (r) => result = r,
    ));
    await tester.tap(find.text('删除'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();

    expect(deleted, false, reason: '取消必须什么都不做');
    expect(result, false);
  });

  testWidgets('★ 确认 → 删除，返回 true', (tester) async {
    String? deletedId;
    bool? result;
    await tester.pumpWidget(host(
      onDelete: (id) async => deletedId = id,
      onResult: (r) => result = r,
    ));
    await tester.tap(find.text('删除'));
    await tester.pumpAndSettle();

    // 确认框里的确认按钮（rooms.confirmDelete 文案）
    final confirm = find.byType(FilledButton).last;
    await tester.tap(confirm);
    await tester.pumpAndSettle();

    expect(deletedId, 'b_x', reason: '应删掉这个 bot');
    expect(result, true);
  });
}