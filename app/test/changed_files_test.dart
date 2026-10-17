import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/widgets/changed_files.dart';

/// 「改了哪些文件」：默认收起成一行，点开看清单。
void main() {
  Widget host(ChangedSummary summary) => MaterialApp(
    home: Scaffold(body: Center(child: ChangedFilesView(summary: summary))),
  );

  final sample = ChangedSummary(
    added: const [ChangedFile(path: 'src/new.dart', size: 10)],
    modified: const [ChangedFile(path: 'src/old.dart', size: 20)],
    removed: const [ChangedFile(path: 'tmp/x.txt')],
    total: 3,
  );

  testWidgets('默认收起：只显示数量，不显示文件名', (tester) async {
    await tester.pumpWidget(host(sample));
    expect(find.textContaining('改动 3 个文件'), findsOneWidget);
    expect(find.textContaining('新增 1'), findsOneWidget);
    expect(find.textContaining('src/new.dart'), findsNothing);
  });

  testWidgets('点开看到三个文件与标记', (tester) async {
    await tester.pumpWidget(host(sample));
    await tester.tap(find.textContaining('改动 3 个文件'));
    await tester.pump();
    expect(find.text('src/new.dart'), findsOneWidget);
    expect(find.text('src/old.dart'), findsOneWidget);
    expect(find.text('tmp/x.txt'), findsOneWidget);
    expect(find.text('+'), findsOneWidget);
    expect(find.text('~'), findsOneWidget);
    expect(find.text('-'), findsOneWidget);
  });

  testWidgets('超过 20 个时折叠剩余数量', (tester) async {
    final many = ChangedSummary(
      added: List.generate(25, (i) => ChangedFile(path: 'f$i.txt')),
      total: 25,
    );
    await tester.pumpWidget(host(many));
    await tester.tap(find.textContaining('改动 25 个文件'));
    await tester.pump();
    expect(find.textContaining('还有 5 个'), findsOneWidget);
  });

  test('从消息 meta 里解析', () {
    final json = {
      'added': [
        {'path': 'a.txt', 'size': 3},
      ],
      'modified': <Map<String, dynamic>>[],
      'removed': <Map<String, dynamic>>[],
      'total': 1,
      'truncated': false,
    };
    final parsed = ChangedSummary.fromJson(json);
    expect(parsed.total, 1);
    expect(parsed.added.single.path, 'a.txt');
    expect(parsed.isEmpty, isFalse);
    expect(ChangedSummary.fromJson(const {}).isEmpty, isTrue);
  });
}
