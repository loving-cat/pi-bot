// 点附件卡片的落地行为
//
// 用户要的是「点文件直接在右边看」，而不是先弹个窗说"这类文件画不出来"。
// 这一组用真实 widget 点击验证，不靠鼠标模拟。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/browser_pane_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/attachment_view.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _State extends AppState {
  @override
  String? fileUrl(String id) => 'http://127.0.0.1:8787/api/files/$id';
}

Attachment _file(String name, {String kind = 'file'}) => Attachment(
  id: 'f1',
  name: name,
  kind: kind,
  mime: name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<_State> pumpChip(WidgetTester tester, Attachment file) async {
    final state = _State();
    addTearDown(state.dispose);
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(
          home: Scaffold(
            body: Center(
              child: FileChip(file: file, url: 'http://127.0.0.1:8787/api/files/f1'),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return state;
  }

  testWidgets('★ 点 PDF 卡片：直接开右侧展示栏，不弹旧窗', (tester) async {
    final state = await pumpChip(tester, _file('报告.pdf'));

    expect(state.browser.open, isFalse, reason: '点之前栏是关的');

    await tester.tap(find.text('报告.pdf'));
    await tester.pumpAndSettle();

    expect(state.browser.open, isTrue, reason: '点了应该打开右侧栏');
    expect(state.browser.kind, PaneContentKind.file);
    expect(state.browser.nativeViewer, isTrue, reason: 'PDF 交给内核渲染');
    expect(state.browser.fileName, '报告.pdf');
    // 旧弹窗的标志文案不该出现
    expect(find.textContaining('没法在窗口里画出来'), findsNothing);
  });

  testWidgets('★ 点表格卡片：走服务端渲染的 HTML', (tester) async {
    final state = await pumpChip(tester, _file('预算.xlsx'));

    await tester.tap(find.text('预算.xlsx'));
    await tester.pumpAndSettle();

    expect(state.browser.open, isTrue);
    expect(state.browser.nativeViewer, isFalse);
    expect(state.browser.url.endsWith('/html'), isTrue, reason: '表格走 /html');
  });

  testWidgets('CSV 也能进展示栏', (tester) async {
    final state = await pumpChip(tester, _file('数据.csv'));
    await tester.tap(find.text('数据.csv'));
    await tester.pumpAndSettle();
    expect(state.browser.open, isTrue);
  });

  testWidgets('★ 点 md 文本：仍走旧弹窗（不抢展示栏）', (tester) async {
    final state = await pumpChip(tester, _file('笔记.md'));
    await tester.tap(find.text('笔记.md'));
    await tester.pumpAndSettle();
    expect(
      state.browser.open,
      isFalse,
      reason: '纯文本有自己的预览窗，不该占展示栏',
    );
  });
}
