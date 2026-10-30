// 点附件后，展示栏必须**真的出现在布局里**。
//
// 之前的测试只断言了 state.browser.open == true —— 那是"状态变了"，
// 不等于"用户看得见"。这里渲染真实的 HomeShell，点完检查 BrowserPane 在不在树里。
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/home_shell.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/browser_pane.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _State extends AppState {
  @override
  Future<void> refresh() async {}
  @override
  String? fileUrl(String id) =>
      'http://127.0.0.1:8787/api/files/$id?token=abc123';
}

Room _room() => Room(
  id: 'r1',
  name: '甲',
  kind: 'dm',
  botIds: const ['b1'],
  botNames: const ['小一'],
);

Attachment _pdf() => Attachment(
  id: 'f1',
  name: '论文.pdf',
  kind: 'file',
  mime: 'application/pdf',
  size: 1200000,
);

void main() {
  setUp(() {
    BlobAvatar.animationsEnabled = false;
    SharedPreferences.setMockInitialValues({});
  });
  tearDown(() => BlobAvatar.animationsEnabled = true);

  testWidgets('★ 打开 PDF 后，展示栏真的挂进了布局', (tester) async {
    addTearDown(tester.view.reset);
    tester.view.physicalSize = const Size(1600, 900);
    tester.view.devicePixelRatio = 1.0;

    final state = _State();
    addTearDown(state.dispose);
    state.rooms = [_room()];

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byType(BrowserPane), findsNothing, reason: '一开始不该有展示栏');

    state.showAttachmentInPane(_pdf());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(state.browser.open, isTrue);
    expect(
      find.byType(BrowserPane),
      findsOneWidget,
      reason: '★ 状态变了但栏没挂进布局，用户看到的就是"点了没反应"',
    );
  });

  testWidgets('★ PDF 的 URL 不能被 /html 拼坏（?token= 会被吃掉）', (tester) async {
    final state = _State();
    addTearDown(state.dispose);

    state.showAttachmentInPane(_pdf());
    expect(state.browser.url, 'http://127.0.0.1:8787/api/files/f1?token=abc123');
    expect(state.browser.url.contains('/html'), isFalse, reason: 'PDF 走原文件');
  });

  testWidgets('★ 表格的 /html 必须插在 query 前面，而不是拼在 token 后面',
      (tester) async {
    final state = _State();
    addTearDown(state.dispose);

    state.showAttachmentInPane(
      Attachment(id: 'f2', name: '预算.xlsx', kind: 'file'),
    );
    final url = state.browser.url;
    // 正确：/api/files/f2/html?token=abc123
    // 错误：/api/files/f2?token=abc123/html   ← 路径坏了，必然 404
    expect(url.contains('/html?'), isTrue, reason: '实际得到：$url');
    expect(url.contains('abc123/html'), isFalse, reason: '实际得到：$url');
  });

  testWidgets('★★ 点 X 能真的关掉展示栏（不能只改状态不重建布局）', (tester) async {
    addTearDown(tester.view.reset);
    tester.view.physicalSize = const Size(1600, 900);
    tester.view.devicePixelRatio = 1.0;

    final state = _State();
    addTearDown(state.dispose);
    state.rooms = [_room()];

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    state.showAttachmentInPane(_pdf());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(BrowserPane), findsOneWidget);

    // 点工具栏的 X
    await tester.tap(find.byKey(const ValueKey('browser-close')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(state.browser.open, isFalse, reason: '状态要关');
    expect(
      find.byType(BrowserPane),
      findsNothing,
      reason: '★ 栏必须真的从布局里消失 —— 只改状态不重建，用户看到的就是「点 X 没反应」',
    );
  });

  testWidgets('侧边栏（Bot 信息栏）开着时，再开展示栏两者都在', (tester) async {
    addTearDown(tester.view.reset);
    tester.view.physicalSize = const Size(1800, 900);
    tester.view.devicePixelRatio = 1.0;

    final state = _State();
    addTearDown(state.dispose);
    state.rooms = [_room()];
    state.panelOpen = true;

    await tester.pumpWidget(
      AppScope(state: state, child: const MaterialApp(home: HomeShell())),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    state.showAttachmentInPane(_pdf());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byType(BrowserPane), findsOneWidget);
  });
}
