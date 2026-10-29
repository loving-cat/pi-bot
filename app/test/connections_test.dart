import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/api.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/connections_controller.dart';
import 'package:pi_bot/connections_draft.dart';
import 'package:pi_bot/connections_filters.dart';
import 'package:pi_bot/connections_models.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/screens/bots_screen.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/connections_detail.dart';
import 'package:pi_bot/widgets/connections_editor.dart';
import 'package:pi_bot/widgets/connections_section.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';

Map<String, dynamic> _entry({
  String id = 'one',
  String name = 'work_tools',
  String type = 'http',
  String state = 'unverified',
  int? count,
}) => {
  'id': id,
  'name': name,
  'type': type,
  'description': type == 'http' ? '查询工作资料' : '整理本地文件',
  'enabled': true,
  'url': 'https://example.com/mcp',
  'credentialKeys': ['Authorization'],
  'hasCredentials': true,
  'assignedBotIds': ['bot-a'],
  'verification': {
    'state': state,
    'toolCount': count,
    'checkedAt': DateTime.now().millisecondsSinceEpoch,
    'tools': [],
  },
};

Map<String, dynamic> _snapshot() => {
  'catalog': [
    {
      'id': 'remote_mcp',
      'name': '远程工具服务',
      'description': '连接一个远程工具服务',
      'category': 'remote',
      'type': 'http',
      'action': 'create',
    },
    {
      'id': 'local_mcp',
      'name': '本地工具服务',
      'description': '使用电脑上已安装的工具',
      'category': 'local',
      'type': 'stdio',
      'action': 'create',
    },
    {
      'id': 'import_local',
      'name': '从本机导入',
      'description': '导入已有工具配置',
      'category': 'local',
      'action': 'import',
    },
  ],
  'connections': [
    _entry(),
    _entry(
      id: 'two',
      name: 'local_files',
      type: 'stdio',
      state: 'ready',
      count: 0,
    ),
  ],
};

class _FakeApi extends Api {
  _FakeApi() : super('https://example.invalid', null);
  Map<String, dynamic> data = _snapshot();
  final calls = <(String, String, Map<String, dynamic>?)>[];
  Future<Map<String, dynamic>> Function()? getHandler;
  Future<Map<String, dynamic>> Function()? postHandler;
  String? failure;

  @override
  Future<Map<String, dynamic>> get(
    String path, {
    Map<String, String>? query,
  }) async {
    calls.add(('GET', path, null));
    if (getHandler != null) return getHandler!();
    if (failure != null) throw ApiException(failure!);
    return data;
  }

  @override
  Future<Map<String, dynamic>> post(
    String path, [
    Map<String, dynamic>? body,
  ]) async {
    calls.add(('POST', path, body));
    if (postHandler != null) return postHandler!();
    if (failure != null) throw ApiException(failure!);
    return {'ok': true};
  }

  @override
  Future<Map<String, dynamic>> patch(
    String path,
    Map<String, dynamic> body,
  ) async {
    calls.add(('PATCH', path, body));
    if (failure != null) throw ApiException(failure!);
    return {'ok': true};
  }

  @override
  Future<Map<String, dynamic>> put(
    String path,
    Map<String, dynamic> body,
  ) async {
    calls.add(('PUT', path, body));
    return {'ok': true};
  }

  @override
  Future<Map<String, dynamic>> delete(String path) async {
    calls.add(('DELETE', path, null));
    return {'ok': true};
  }
}

Future<AppState> _pumpCenter(
  WidgetTester tester, {
  double width = 960,
  _FakeApi? api,
}) async {
  tester.view.physicalSize = Size(width, 980);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final state = AppState()..api = api ?? _FakeApi();
  expect(state.mcpServers, isEmpty);
  state.bots = [Bot(id: 'bot-a', name: '资料助手'), Bot(id: 'bot-b', name: '文件助手')];
  addTearDown(state.dispose);
  await tester.pumpWidget(
    AppScope(
      state: state,
      child: MaterialApp(
        theme: PB.theme(),
        home: const Scaffold(
          body: SingleChildScrollView(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: ConnectionsSection(),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return state;
}

void main() {
  test('启用状态不代表验证成功，零工具有明确文案', () {
    const evidence = ConnectionVerification(state: 'ready', checkedAt: 1000);
    expect(evidence.stateAt(600999), 'ready');
    expect(evidence.stateAt(601000), 'stale');
    final unverified = AppConnection.fromJson(_entry());
    expect(unverified.server.enabled, isTrue);
    expect(unverified.verification.label, '尚未验证');
    expect(
      AppConnection.fromJson(_entry(state: 'ready', count: 0))
          .verification
          .label,
      '协议正常，未发现工具',
    );
    expect(
      AppConnection.fromJson(_entry(state: 'ready', count: 2))
          .verification
          .label,
      '已验证可用',
    );
    expect(
      AppConnection.fromJson(_entry(state: 'auth_required')).verification.label,
      '认证未通过',
    );
  });

  test('搜索与分类只匹配公开名称、用途与类型', () {
    final remote = AppConnection.fromJson(_entry());
    expect(connectionMatches(remote, ' WORK ', ConnectionFilter.all), isTrue);
    expect(connectionMatches(remote, '资料', ConnectionFilter.remote), isTrue);
    expect(connectionMatches(remote, '', ConnectionFilter.local), isFalse);
    expect(
      connectionMatches(remote, 'Authorization', ConnectionFilter.all),
      isFalse,
    );
    final item = ConnectionsSnapshot.fromJson(_snapshot()).catalog.first;
    expect(catalogMatches(item, '', ConnectionFilter.configured), isFalse);
  });

  test('凭据空白不提交，非法和重复键被拦', () {
    expect(connectionCredentialPatch([('Authorization', '   ')]), isEmpty);
    expect(connectionCredentialPatch([(' KEY ', 'fixture-secret-value')]), {
      'KEY': 'fixture-secret-value',
    });
    expect(
      () => connectionCredentialPatch([('', 'value')]),
      throwsFormatException,
    );
    expect(
      () => connectionCredentialPatch([('KEY', 'a'), ('KEY', 'b')]),
      throwsFormatException,
    );
    expect(
      () => connectionCredentialPatch([('KEY', 'a\nb')]),
      throwsFormatException,
    );
  });

  test('草稿按连接方式隔离字段并验证必填项', () {
    Map<String, dynamic> draft({
      String name = 'tools',
      String type = 'http',
      String url = 'https://example.com/mcp',
    }) => connectionDraftPatch(
      name: name,
      type: type,
      description: '  用途  ',
      enabled: false,
      url: url,
      command: 'node',
      args: ' first \n\n second ',
      cwd: '',
      credentials: [('Authorization', 'fixture-secret-value')],
      clearCredentials: false,
    );
    expect(draft()['description'], '用途');
    expect(draft().containsKey('command'), isFalse);
    expect(draft()['headers'], {'Authorization': 'fixture-secret-value'});
    expect(draft(type: 'stdio').containsKey('url'), isFalse);
    expect(draft(type: 'stdio')['args'], ['first', 'second']);
    expect(() => draft(name: 'bad name'), throwsFormatException);
    expect(() => draft(url: ''), throwsFormatException);
  });

  test('验证失败恢复忙碌状态，可以重试', () async {
    final api = _FakeApi();
    final controller = ConnectionsController(apiProvider: () => api);
    addTearDown(controller.dispose);
    await controller.load();
    api.failure = '服务暂时不可用';
    expect(await controller.verify('one'), '服务暂时不可用');
    expect(controller.isBusy('one'), isFalse);
    api.failure = null;
    expect(await controller.verify('one'), isNull);
    expect(controller.error, isNull);
  });

  test('同一连接操作去重，绑定使用PUT且去除重复Bot', () async {
    final api = _FakeApi();
    final controller = ConnectionsController(apiProvider: () => api);
    addTearDown(controller.dispose);
    await controller.load();
    final pending = Completer<Map<String, dynamic>>();
    api.postHandler = () => pending.future;
    final first = controller.verify('one');
    expect(await controller.verify('one'), '这项操作仍在进行');
    expect(api.calls.where((c) => c.$1 == 'POST').length, 1);
    pending.complete({'ok': true});
    await first;
    await controller.assign('one', ['bot-a', 'bot-a', 'bot-b']);
    final call = api.calls.where((c) => c.$1 == 'PUT').single;
    expect(call.$1, 'PUT');
    expect(call.$2, '/api/connections/one/bots');
    expect(call.$3, {
      'botIds': ['bot-a', 'bot-b'],
    });
  });

  test('切换服务端后旧请求不覆盖新列表或执行旧操作', () async {
    final oldApi = _FakeApi();
    final newApi = _FakeApi()..data = {'catalog': [], 'connections': []};
    Api current = oldApi;
    final controller = ConnectionsController(apiProvider: () => current);
    addTearDown(controller.dispose);
    await controller.load();
    final pending = Completer<Map<String, dynamic>>();
    oldApi.getHandler = () => pending.future;
    final oldLoad = controller.load();
    current = newApi;
    expect(await controller.remove('one'), '服务端已切换，请刷新连接列表');
    await controller.load();
    pending.complete(_snapshot());
    await oldLoad;
    expect(controller.snapshot.connections, isEmpty);
    expect(newApi.calls.where((c) => c.$1 == 'DELETE'), isEmpty);
  });

  test('销毁后晚到响应不再通知', () async {
    final api = _FakeApi();
    final pending = Completer<Map<String, dynamic>>();
    api.getHandler = () => pending.future;
    final controller = ConnectionsController(apiProvider: () => api);
    final load = controller.load();
    controller.dispose();
    pending.complete(_snapshot());
    await expectLater(load, completes);
  });

  test('本机扫描失败可重试，导入只提交名称且不传凭据', () async {
    final api = _FakeApi();
    final controller = ConnectionsController(apiProvider: () => api);
    addTearDown(controller.dispose);
    await controller.load();
    api.failure = '无法读取本机配置';
    await controller.scanLocal();
    expect(controller.scanning, isFalse);
    expect(controller.importError, '无法读取本机配置');
    api.failure = null;
    api.getHandler = () async => {
      'mcpServers': [
        {'name': 'local_tools', 'type': 'stdio', 'imported': false},
      ],
    };
    await controller.scanLocal();
    expect(controller.importError, isNull);
    expect(controller.localEntries.single.name, 'local_tools');
    await controller.importLocal(['local_tools']);
    expect(api.calls.where((c) => c.$2.endsWith('/import')).single.$3, {
      'kind': 'mcp',
      'names': ['local_tools'],
    });
  });

  test('旧扫描结果不能导入到新服务端', () async {
    final oldApi = _FakeApi();
    final nextApi = _FakeApi();
    Api current = oldApi;
    final controller = ConnectionsController(apiProvider: () => current);
    addTearDown(controller.dispose);
    await controller.load();
    await controller.scanLocal();
    current = nextApi;
    await controller.load();
    expect(await controller.importLocal(['old_tools']), '服务端已切换，请重新扫描本机配置');
    expect(nextApi.calls.where((c) => c.$1 == 'POST'), isEmpty);
  });

  test('草稿验证在途切服后不返回旧服务成功证据', () async {
    final oldApi = _FakeApi();
    final nextApi = _FakeApi();
    Api current = oldApi;
    final controller = ConnectionsController(apiProvider: () => current);
    addTearDown(controller.dispose);
    await controller.load();
    final response = Completer<Map<String, dynamic>>();
    oldApi.postHandler = () => response.future;
    final pending = controller.testDraft({'name': 'old_tools'});
    current = nextApi;
    await controller.load();
    current = oldApi;
    await controller.load();
    response.complete({'ok': true, 'toolCount': 1});
    final result = await pending;
    expect(result['ok'], isFalse);
    expect(result['errorCode'], 'cancelled');
    expect(result.containsKey('toolCount'), isFalse);
  });

  test('导入在途切服后不写成功状态也不扫描新服务', () async {
    final oldApi = _FakeApi();
    final nextApi = _FakeApi();
    Api current = oldApi;
    final controller = ConnectionsController(apiProvider: () => current);
    addTearDown(controller.dispose);
    await controller.load();
    await controller.scanLocal();
    final response = Completer<Map<String, dynamic>>();
    oldApi.postHandler = () => response.future;
    final pending = controller.importLocal(['old_tools']);
    current = nextApi;
    await controller.load();
    response.complete({
      'imported': ['old_tools'],
      'skipped': [],
    });
    expect(await pending, '服务端已切换，请重试');
    expect(controller.importResult, isNull);
    expect(
      nextApi.calls.where((call) => call.$2 == '/api/local-capabilities'),
      isEmpty,
    );
    expect(controller.isBusy('local-import'), isFalse);
  });

  test('扫描旧服务错误晚到不污染新服务状态', () async {
    final oldApi = _FakeApi();
    final nextApi = _FakeApi();
    Api current = oldApi;
    final controller = ConnectionsController(apiProvider: () => current);
    addTearDown(controller.dispose);
    await controller.load();
    final response = Completer<Map<String, dynamic>>();
    oldApi.getHandler = () => response.future;
    final pending = controller.scanLocal();
    current = nextApi;
    await controller.load();
    response.completeError(ApiException('旧服务扫描失败'));
    await pending;
    expect(controller.importError, isNull);
    expect(controller.scanning, isFalse);
  });

  test('销毁后草稿验证和导入结果不发布', () async {
    final api = _FakeApi();
    final controller = ConnectionsController(apiProvider: () => api);
    await controller.load();
    await controller.scanLocal();
    final response = Completer<Map<String, dynamic>>();
    api.postHandler = () => response.future;
    final verification = controller.testDraft({});
    final importing = controller.importLocal(['tools']);
    controller.dispose();
    response.complete({
      'ok': true,
      'imported': ['tools'],
    });
    expect((await verification)['ok'], isFalse);
    expect(await importing, '页面已关闭');
    expect(controller.importResult, isNull);
  });

  testWidgets('冷启动打开连接中心后旧Bot编辑器可选择服务且不会循环拉取', (tester) async {
    BlobAvatar.animationsEnabled = false;
    addTearDown(() => BlobAvatar.animationsEnabled = true);
    final api = _FakeApi();
    final state = await _pumpCenter(tester, api: api);
    expect(state.mcpLoaded, isTrue);
    expect(state.mcpServers.map((server) => server.name), [
      'work_tools',
      'local_files',
    ]);
    expect(state.connectionsRevision, 0);
    await tester.pumpAndSettle();
    expect(api.calls.where((call) => call.$2 == '/api/connections').length, 1);
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(theme: PB.theme(), home: const BotsScreen()),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('资料助手'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(ChoiceChip, 'work_tools'), findsOneWidget);
    expect(find.textContaining('还没有启用的 MCP 服务'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  for (final status in [
    'unverified',
    'error',
    'auth_required',
    'stale',
    'ready',
  ]) {
    testWidgets('零工具详情按 $status 展示证据', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: PB.theme(),
          home: Scaffold(
            body: ConnectionsDetail(
              connection: AppConnection.fromJson(
                _entry(state: status, count: 0),
              ),
              bots: const [],
              busy: false,
              onVerify: () async => null,
              onEnabled: (_) async => null,
              onAssign: (_) async => null,
              onEdit: () {},
              onDelete: () {},
            ),
          ),
        ),
      );
      final expected = switch (status) {
        'ready' => '服务响应正常，但没有提供可调用工具。',
        'auth_required' => '认证未通过，请检查凭据后重新验证。',
        'error' => '验证未通过，暂时无法确认可用工具。',
        'stale' => '验证记录已过期，请重新验证后查看可用工具。',
        _ => '验证后会在这里展示工具。',
      };
      expect(find.text(expected), findsOneWidget);
      if (status != 'ready')
        expect(find.text('服务响应正常，但没有提供可调用工具。'), findsNothing);
    });
  }

  testWidgets('应用中心宽窄布局均无溢出，可搜索和切换分类', (tester) async {
    await _pumpCenter(tester, width: 360);
    expect(
      tester
          .widget<ChoiceChip>(find.widgetWithText(ChoiceChip, '全部'))
          .labelStyle
          ?.color,
      PB.textPrimary,
    );
    expect(
      tester
          .widget<ChoiceChip>(find.widgetWithText(ChoiceChip, '远程服务'))
          .labelStyle
          ?.color,
      PB.textSecondary,
    );
    expect(find.text('2 个已配置'), findsOneWidget);
    expect(find.text('尚未验证'), findsOneWidget);
    expect(find.text('协议正常，未发现工具'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.enterText(
      find.byKey(const ValueKey('connections-search')),
      'work',
    );
    await tester.pumpAndSettle();
    expect(find.text('work_tools'), findsOneWidget);
    expect(find.text('local_files'), findsNothing);
    await tester.enterText(
      find.byKey(const ValueKey('connections-search')),
      '不存在',
    );
    await tester.pumpAndSettle();
    expect(find.text('没有找到匹配的连接'), findsOneWidget);
    await tester.tap(find.byTooltip('清空搜索'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(ChoiceChip, '远程服务'));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<ChoiceChip>(find.widgetWithText(ChoiceChip, '远程服务'))
          .labelStyle
          ?.color,
      PB.textPrimary,
    );
    expect(
      tester
          .widget<ChoiceChip>(find.widgetWithText(ChoiceChip, '全部'))
          .labelStyle
          ?.color,
      PB.textSecondary,
    );
    expect(find.text('work_tools'), findsOneWidget);
    expect(find.text('local_files'), findsNothing);
    tester.view.physicalSize = const Size(1100, 980);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('配置编辑留空保留密钥，明确清除才提交标记', (tester) async {
    final saved = <Map<String, dynamic>>[];
    Future<void> pump() async {
      await tester.pumpWidget(
        MaterialApp(
          theme: PB.theme(),
          home: Scaffold(
            body: ConnectionsEditor(
              key: UniqueKey(),
              server: McpServer.fromJson(_entry()),
              onSave: (patch) async {
                saved.add(patch);
                return '保留表单以继续检查';
              },
              onTest: (_) async => {'ok': true, 'toolCount': 0},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    await pump();
    expect(find.textContaining('留空保留原值'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();
    expect(saved.single.containsKey('headers'), isFalse);
    expect(saved.single.containsKey('clearCredentials'), isFalse);
    await tester.ensureVisible(find.text('保存时清除全部已存凭据'));
    await tester.tap(find.text('保存时清除全部已存凭据'));
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();
    expect(saved.last['clearCredentials'], isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('验证响应晚到且表单已关闭时不更新销毁状态', (tester) async {
    final pending = Completer<Map<String, dynamic>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ConnectionsEditor(
            server: McpServer.fromJson(_entry()),
            onSave: (_) async => null,
            onTest: (_) => pending.future,
          ),
        ),
      ),
    );
    await tester.tap(find.text('验证连接'));
    await tester.pump();
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    pending.complete({'ok': true, 'toolCount': 1});
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('详情取消Bot分配时只提交选择结果且呈现只读限制', (tester) async {
    List<String>? assigned;
    await tester.pumpWidget(
      MaterialApp(
        theme: PB.theme(),
        home: Scaffold(
          body: ConnectionsDetail(
            connection: AppConnection.fromJson(
              _entry(state: 'ready', count: 0),
            ),
            bots: [
              Bot(id: 'bot-a', name: '资料助手'),
              Bot(id: 'bot-b', name: '文件助手'),
            ],
            busy: false,
            policy: 'deny',
            onVerify: () async => null,
            onEnabled: (_) async => null,
            onAssign: (ids) async {
              assigned = ids;
              return null;
            },
            onEdit: () {},
            onDelete: () {},
          ),
        ),
      ),
    );
    expect(find.textContaining('当前为只读模式'), findsOneWidget);
    await tester.ensureVisible(
      find.byKey(const ValueKey('connection-bot-bot-a')),
    );
    await tester.tap(find.byKey(const ValueKey('connection-bot-bot-a')));
    await tester.pump();
    await tester.ensureVisible(
      find.byKey(const ValueKey('connection-bot-bot-b')),
    );
    await tester.tap(find.byKey(const ValueKey('connection-bot-bot-b')));
    await tester.pump();
    await tester.ensureVisible(find.text('保存分配'));
    await tester.tap(find.text('保存分配'));
    await tester.pumpAndSettle();
    expect(assigned, ['bot-b']);
    expect(tester.takeException(), isNull);
  });
}
