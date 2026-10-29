import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/api.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/widgets/blob_avatar.dart';
import 'package:pi_bot/widgets/model_picker_field.dart';
import 'package:pi_bot/widgets/room_panel.dart';

class _Api extends Api {
  _Api() : super('https://fixture.invalid', null);
  final calls = <(String, String)>[];
  Future<void> Function(String)? wait;
  bool fail = false;
  final remote = <String, String>{};
  String Function(String)? canonicalize;

  @override
  Future<Map<String, dynamic>> patch(
    String path,
    Map<String, dynamic> body,
  ) async {
    final model = body['model'] as String;
    calls.add((path, model));
    final confirmed = canonicalize?.call(model) ?? model;
    remote[path] = confirmed;
    await wait?.call(model);
    if (fail) throw ApiException('fixture failure');
    return {
      'bot': {
        'id': path.split('/').last,
        'name': 'fixture bot',
        'model': confirmed.isEmpty ? null : confirmed,
        'thinking': 'medium',
      },
    };
  }
}

AppState _state(_Api api, {bool group = false}) => AppState()
  ..api = api
  ..modelGroups = [
    ModelGroup(
      id: 'grp',
      name: 'fixture models',
      baseUrl: 'https://fixture.invalid',
      models: [
        for (final id in ['a', 'b', 'c', 'd']) ModelSpec(id: id),
      ],
    ),
  ]
  ..bots = [
    Bot(id: 'b1', name: 'fixture bot', model: 'grp/a', thinking: 'medium'),
    Bot(id: 'b2', name: 'fixture member', model: 'grp/a'),
  ]
  ..rooms = [
    Room(
      id: 'r1',
      name: 'fixture room',
      kind: group ? 'group' : 'dm',
      botIds: group ? ['b2', 'b1'] : ['b1'],
      leadBotId: group ? 'b1' : null,
    ),
  ];

Future<void> _pump(WidgetTester tester, AppState state) async {
  tester.view.physicalSize = const Size(900, 900);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  addTearDown(state.dispose);
  await tester.pumpWidget(
    AppScope(
      state: state,
      child: MaterialApp(
        home: Scaffold(body: RoomPanel(room: state.rooms.first)),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Finder get _field => find.descendant(
  of: find.byType(ModelPickerField),
  matching: find.byType(TextField),
);

Future<void> _pick(WidgetTester tester, String id) async {
  await tester.tap(find.byTooltip('从列表里选'));
  await tester.pumpAndSettle();
  await tester.tap(find.text(id).last);
  await tester.pump();
}

void main() {
  setUp(() => BlobAvatar.animationsEnabled = false);
  tearDown(() => BlobAvatar.animationsEnabled = true);

  for (final group in [false, true]) {
    testWidgets('${group ? '群聊负责人' : '私聊'}选择模型立即保存，无保存按钮', (tester) async {
      final api = _Api(), state = _state(api, group: group);
      await _pump(tester, state);
      expect(find.text('保存模型'), findsNothing);
      await _pick(tester, 'b');
      await tester.pumpAndSettle();
      expect(api.calls, [('/api/bots/b1', 'grp/b')]);
      expect(state.botById('b1')!.model, 'grp/b');
      expect(state.botById('b2')!.model, 'grp/a');
      expect(find.text('模型已切换，下一轮使用'), findsOneWidget);
    });
  }

  testWidgets('手动输入不逐键保存，提交后保存且空值恢复默认', (tester) async {
    final api = _Api(), state = _state(api);
    await _pump(tester, state);
    await tester.enterText(_field, 'grp/c');
    await tester.pump();
    expect(api.calls, isEmpty);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(api.calls.last.$2, 'grp/c');
    await tester.enterText(_field, '');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(api.calls.last.$2, '');
    expect(state.botById('b1')!.model, null);
  });

  testWidgets('失败展示未确认状态并能直接重试', (tester) async {
    final api = _Api()..fail = true, state = _state(api);
    await _pump(tester, state);
    await _pick(tester, 'b');
    await tester.pumpAndSettle();
    expect(find.text('未能确认模型切换，请重试。'), findsOneWidget);
    expect(tester.widget<TextField>(_field).controller!.text, 'grp/b');
    expect(state.botById('b1')!.model, 'grp/a');
    api.fail = false;
    await tester.tap(find.text('重试'));
    await tester.pumpAndSettle();
    expect(api.calls, hasLength(2));
    expect(state.botById('b1')!.model, 'grp/b');
    expect(find.text('重试'), findsNothing);
  });

  testWidgets('快速确认按顺序保存，旧响应不覆盖最新文本', (tester) async {
    final first = Completer<void>(), second = Completer<void>();
    final api = _Api()
      ..wait = (value) => value == 'grp/b' ? first.future : second.future;
    final state = _state(api);
    await _pump(tester, state);
    await tester.enterText(_field, 'grp/b');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    await tester.enterText(_field, 'grp/c');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(api.calls, [('/api/bots/b1', 'grp/b')]);
    first.complete();
    await tester.pump();
    expect(api.calls.last.$2, 'grp/c');
    expect(tester.widget<TextField>(_field).controller!.text, 'grp/c');
    second.complete();
    await tester.pumpAndSettle();
    expect(state.botById('b1')!.model, 'grp/c');
    expect(find.text('正在切换模型…'), findsNothing);
  });

  testWidgets('切换服务端不回写新服务，旧确认仍写向原API', (tester) async {
    final pending = Completer<void>();
    final api = _Api()..wait = (_) => pending.future;
    final state = _state(api);
    await _pump(tester, state);
    await tester.enterText(_field, 'grp/b');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    final nextApi = _Api();
    state.api = nextApi;
    state.applyBotUpdate(
      Bot(id: 'b1', name: 'other server bot', model: 'grp/d'),
    );
    await tester.pump();
    pending.complete();
    await tester.pumpAndSettle();
    expect(nextApi.calls, isEmpty);
    expect(state.botById('b1')!.model, 'grp/d');
    expect(tester.widget<TextField>(_field).controller!.text, 'grp/d');
  });

  testWidgets('关闭并重开面板复用写入队列，最后一次选择最终生效', (tester) async {
    final first = Completer<void>(), last = Completer<void>();
    final api = _Api()
      ..wait = (value) => value == 'grp/b' ? first.future : last.future;
    final state = _state(api);
    await _pump(tester, state);
    await tester.enterText(_field, 'grp/b');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    await tester.enterText(_field, 'grp/c');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: const MaterialApp(home: SizedBox()),
      ),
    );
    await tester.pump();
    await tester.pumpWidget(
      AppScope(
        state: state,
        child: MaterialApp(
          home: Scaffold(body: RoomPanel(room: state.rooms.first)),
        ),
      ),
    );
    await tester.pump();
    expect(tester.widget<TextField>(_field).controller!.text, 'grp/c');
    await tester.enterText(_field, 'grp/d');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    first.complete();
    await tester.pump();
    expect(api.calls.map((call) => call.$2).toList(), ['grp/b', 'grp/d']);
    last.complete();
    await tester.pumpAndSettle();
    expect(state.botById('b1')!.model, 'grp/d');
    expect(tester.widget<TextField>(_field).controller!.text, 'grp/d');
  });

  testWidgets('选择对话框打开期间换服务端，旧选择不改新服务文本或配置', (tester) async {
    final api = _Api(), state = _state(api);
    await _pump(tester, state);
    await tester.tap(find.byTooltip('从列表里选'));
    await tester.pumpAndSettle();
    final nextApi = _Api();
    state.api = nextApi;
    state.applyBotUpdate(
      Bot(id: 'b1', name: 'new service bot', model: 'grp/d'),
    );
    await tester.pump();
    await tester.tap(find.text('b').last);
    await tester.pumpAndSettle();
    expect(api.calls, isEmpty);
    expect(nextApi.calls, isEmpty);
    expect(tester.widget<TextField>(_field).controller!.text, 'grp/d');
  });

  testWidgets('换会话后旧响应只更新原Bot，不覆盖新Bot输入', (tester) async {
    final pending = Completer<void>();
    final api = _Api()
      ..wait = (value) => value == 'grp/b' ? pending.future : Future.value();
    final state = _state(api);
    await _pump(tester, state);
    await tester.enterText(_field, 'grp/b');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    state.rooms = [
      Room(id: 'r1', name: 'another room', kind: 'dm', botIds: ['b2']),
    ];
    state.applyBotUpdate(Bot(id: 'b2', name: 'another bot', model: 'grp/a'));
    await tester.pump();
    await tester.enterText(_field, 'grp/c');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    pending.complete();
    await tester.pumpAndSettle();
    expect(api.calls, [('/api/bots/b1', 'grp/b'), ('/api/bots/b2', 'grp/c')]);
    expect(state.botById('b1')!.model, 'grp/b');
    expect(state.botById('b2')!.model, 'grp/c');
    expect(tester.widget<TextField>(_field).controller!.text, 'grp/c');
  });

  testWidgets('已写入但未获响应时排队选回原值，远端最终恢复原值', (tester) async {
    final response = Completer<void>();
    final api = _Api()
      ..wait = (value) => value == 'grp/b' ? response.future : Future.value();
    final state = _state(api);
    await _pump(tester, state);
    await tester.enterText(_field, 'grp/b');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(api.remote['/api/bots/b1'], 'grp/b');
    await tester.enterText(_field, 'grp/a');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    response.completeError(StateError('fixture timeout after write'));
    await tester.pumpAndSettle();
    expect(api.calls.map((call) => call.$2).toList(), ['grp/b', 'grp/a']);
    expect(api.remote['/api/bots/b1'], 'grp/a');
    expect(tester.widget<TextField>(_field).controller!.text, 'grp/a');
  });

  testWidgets('响应失败后明确选回原模型仍重新写入', (tester) async {
    final api = _Api()..fail = true;
    final state = _state(api);
    await _pump(tester, state);
    await _pick(tester, 'b');
    await tester.pumpAndSettle();
    expect(api.remote['/api/bots/b1'], 'grp/b');
    expect(find.text('未能确认模型切换，请重试。'), findsOneWidget);
    api.fail = false;
    await _pick(tester, 'a');
    await tester.pumpAndSettle();
    expect(api.calls.map((call) => call.$2).toList(), ['grp/b', 'grp/a']);
    expect(api.remote['/api/bots/b1'], 'grp/a');
    expect(find.text('未能确认模型切换，请重试。'), findsNothing);
  });

  testWidgets('手动别名成功后显示服务端确认的完整模型标识', (tester) async {
    final api = _Api()
      ..canonicalize = (value) => value == 'b' ? 'grp/b' : value;
    final state = _state(api);
    await _pump(tester, state);
    await tester.enterText(_field, 'b');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(api.calls.single.$2, 'b');
    expect(state.botById('b1')!.model, 'grp/b');
    expect(tester.widget<TextField>(_field).controller!.text, 'grp/b');
    expect(find.text('未能确认模型切换，请重试。'), findsNothing);
  });

  testWidgets('模型列表不显示停用组', (tester) async {
    final api = _Api(), state = _state(api);
    state.modelGroups.add(
      ModelGroup(
        id: 'disabled',
        name: 'disabled fixture group',
        baseUrl: 'https://fixture.invalid',
        enabled: false,
        models: [ModelSpec(id: 'disabled-model')],
      ),
    );
    await _pump(tester, state);
    await tester.tap(find.byTooltip('从列表里选'));
    await tester.pumpAndSettle();
    expect(find.text('disabled fixture group'), findsNothing);
    expect(find.text('disabled-model'), findsNothing);
    expect(find.text('fixture models'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(api.calls, isEmpty);
  });
}
