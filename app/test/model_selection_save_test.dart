import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/model_selection_save.dart';

void main() {
  test('快速选择串行落库，只保留最新待发送值', () async {
    final calls = <String>[];
    final requests = <Completer<void>>[];
    final save = ModelSelectionSave(
      initialValue: 'a',
      save: (value) {
        calls.add(value);
        final request = Completer<void>();
        requests.add(request);
        return request.future.then((_) => value);
      },
    );
    final first = save.select('b');
    final second = save.select('c');
    final last = save.select('d');
    expect(calls, ['b']);
    requests[0].complete();
    await Future<void>.delayed(Duration.zero);
    expect(calls, ['b', 'd']);
    expect(save.selectedValue, 'd');
    requests[1].complete();
    await Future.wait([first, second, last]);
    expect(save.savedValue, 'd');
    expect(save.saving, false);
    save.dispose();
  });

  test('失败保留选择，重试不需再次选择模型', () async {
    var calls = 0;
    final save = ModelSelectionSave(
      initialValue: 'a',
      save: (value) async {
        if (++calls == 1) throw StateError('fixture failure');
        return value;
      },
    );
    await save.select('b');
    expect(save.failed, true);
    expect(save.savedValue, 'a');
    expect(save.selectedValue, 'b');
    await save.retry();
    expect(save.failed, false);
    expect(save.savedValue, 'b');
    expect(calls, 2);
    save.dispose();
  });

  test('旧请求失败不阻止最新选择保存', () async {
    final first = Completer<void>();
    final calls = <String>[];
    final save = ModelSelectionSave(
      initialValue: 'a',
      save: (value) {
        calls.add(value);
        return value == 'b'
            ? first.future.then((_) => value)
            : Future.value(value);
      },
    );
    final done = save.select('b');
    save.select('c');
    first.completeError(StateError('fixture failure'));
    await done;
    expect(calls, ['b', 'c']);
    expect(save.savedValue, 'c');
    expect(save.failed, false);
    save.dispose();
  });

  test('同步抛错仍可正常重试，默认模型用空字符串保存', () async {
    var fail = true;
    final calls = <String>[];
    final save = ModelSelectionSave(
      initialValue: 'a',
      save: (value) {
        calls.add(value);
        if (fail) throw StateError('fixture failure');
        return Future.value(value);
      },
    );
    await save.select('  ');
    expect(save.failed, true);
    fail = false;
    await save.retry();
    expect(save.savedValue, '');
    expect(calls, ['', '']);
    save.dispose();
  });

  test('等待期间选择回原值仍在旧请求完成后恢复原值', () async {
    final first = Completer<void>();
    final calls = <String>[];
    final save = ModelSelectionSave(
      initialValue: 'a',
      save: (value) {
        calls.add(value);
        return value == 'b'
            ? first.future.then((_) => value)
            : Future.value(value);
      },
    );
    final done = save.select('b');
    save.select('a');
    first.complete();
    await done;
    expect(calls, ['b', 'a']);
    expect(save.savedValue, 'a');
    save.dispose();
  });

  test('销毁只停止通知，已确认的最新选择仍保存', () async {
    final first = Completer<void>();
    final calls = <String>[];
    var notifications = 0;
    final save = ModelSelectionSave(
      initialValue: 'a',
      save: (value) {
        calls.add(value);
        return value == 'b'
            ? first.future.then((_) => value)
            : Future.value(value);
      },
    )..addListener(() => notifications++);
    final done = save.select('b');
    save.select('c');
    save.dispose();
    final before = notifications;
    first.complete();
    await done;
    expect(calls, ['b', 'c']);
    expect(notifications, before);
  });

  test('同API同Bot重开复用队列，不同Bot或API隔离', () async {
    final scopes = ModelSelectionSaves();
    final api = Object();
    final first = Completer<void>();
    final calls = <String>[];
    final one = scopes.forBot(
      scope: api,
      botId: 'b',
      initialValue: 'a',
      save: (value) {
        calls.add(value);
        return value == 'b'
            ? first.future.then((_) => value)
            : Future.value(value);
      },
    );
    final done = one.select('b');
    one.select('c');
    final reopened = scopes.forBot(
      scope: api,
      botId: 'b',
      initialValue: 'a',
      save: (_) => throw StateError('must reuse queue'),
    );
    expect(reopened, same(one));
    reopened.select('d');
    expect(
      scopes.forBot(
        scope: api,
        botId: 'other',
        initialValue: 'a',
        save: (value) async => value,
      ),
      isNot(same(one)),
    );
    expect(
      scopes.forBot(
        scope: Object(),
        botId: 'b',
        initialValue: 'a',
        save: (value) async => value,
      ),
      isNot(same(one)),
    );
    first.complete();
    await done;
    expect(calls, ['b', 'd']);
    one.dispose();
  });

  test('服务端已写入但响应失败，排队选回原值仍重写原值', () async {
    var remote = 'a';
    final first = Completer<void>();
    final calls = <String>[];
    final save = ModelSelectionSave(
      initialValue: 'a',
      save: (value) async {
        calls.add(value);
        remote = value;
        if (value == 'b') await first.future;
        return value;
      },
    );
    final done = save.select('b');
    expect(remote, 'b');
    save.select('a');
    first.completeError(StateError('fixture response failed after write'));
    await done;
    expect(calls, ['b', 'a']);
    expect(remote, 'a');
    expect(save.savedValue, 'a');
    expect(save.failed, false);
    save.dispose();
  });

  test('响应失败后缓存同步不能确认服务器状态，显式选旧值仍重写', () async {
    var remote = 'a';
    final calls = <String>[];
    final save = ModelSelectionSave(
      initialValue: 'a',
      save: (value) async {
        calls.add(value);
        remote = value;
        if (value == 'b')
          throw StateError('fixture response failed after write');
        return value;
      },
    );
    await save.select('b');
    expect(save.failed, true);
    expect(remote, 'b');
    save.synchronize('a');
    await save.select('a');
    expect(calls, ['b', 'a']);
    expect(remote, 'a');
    expect(save.failed, false);
    save.dispose();
  });

  test('成功响应使用服务端规范化模型标识', () async {
    final save = ModelSelectionSave(
      initialValue: 'grp/a',
      save: (_) async => 'grp/b',
    );
    await save.select('b');
    expect(save.savedValue, 'grp/b');
    expect(save.selectedValue, 'grp/b');
    expect(save.lastSavedInput, 'b');
    expect(save.failed, false);
    save.dispose();
  });
}
