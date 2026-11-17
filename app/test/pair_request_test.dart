// 连接请求：手机等电脑点"允许"这一段的规则。
//
// 这里最容易错的是"等不到怎么办"：
//   · 电脑上拒了 → 必须立刻停，不能继续轮询假装还有希望；
//   · 批准了但 token 已经被取走 → 不能静默成功（那会存一个空 token 进去）；
//   · 网络抖一下 → 不能当成失败让用户重新跑一趟电脑（继续等）；
//   · 超时 → 说清楚"过期/超时"，界面才好给"重新请求"。
import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/api.dart';
import 'package:pi_bot/pair_request.dart';

/// 按顺序吐出预设响应的假轮询器
({Future<Map<String, dynamic>> Function(String, String) statusOf, int Function() calls}) _sequence(
  List<Object> steps,
) {
  var index = 0;
  var calls = 0;
  Future<Map<String, dynamic>> fn(String baseUrl, String id) async {
    calls++;
    final step = steps[index < steps.length ? index : steps.length - 1];
    index++;
    if (step is ApiException) throw step;
    return (step as Map).cast<String, dynamic>();
  }

  return (statusOf: fn, calls: () => calls);
}

final _ticket = PairRequestTicket(id: 'a' * 32, baseUrl: 'http://192.168.1.7:8787', serverName: 'pi-bot');

Future<void> _noSleep(Duration _) async {}

void main() {
  test('电脑上点允许 → approved 且带回 token', () async {
    final seq = _sequence([
      {'status': 'pending'},
      {'status': 'approved', 'token': 't_abc', 'serverName': 'pi-bot', 'workspace': '/w'},
    ]);
    final result = await awaitApproval(ticket: _ticket, statusOf: seq.statusOf, sleep: _noSleep);
    expect(result.status, PairApprovalStatus.approved);
    expect(result.ok, isTrue);
    expect(result.token, 't_abc');
    expect(result.workspace, '/w');
    expect(seq.calls(), 2);
  });

  test('电脑上拒绝 → 立刻停，不再轮询', () async {
    final seq = _sequence([
      {'status': 'pending'},
      {'status': 'denied'},
      {'status': 'approved', 'token': 'never'},
    ]);
    final result = await awaitApproval(ticket: _ticket, statusOf: seq.statusOf, sleep: _noSleep);
    expect(result.status, PairApprovalStatus.denied);
    expect(result.ok, isFalse);
    expect(seq.calls(), 2, reason: '拒了就不该继续问');
  });

  test('过期 → expired', () async {
    final seq = _sequence([
      {'status': 'expired'},
    ]);
    final result = await awaitApproval(ticket: _ticket, statusOf: seq.statusOf, sleep: _noSleep);
    expect(result.status, PairApprovalStatus.expired);
  });

  test('服务端说 410（请求被清了）→ 当过期处理，不报网络错误', () async {
    final seq = _sequence([
      ApiException('gone', status: 410, code: 'PAIR_REQUEST_GONE'),
    ]);
    final result = await awaitApproval(ticket: _ticket, statusOf: seq.statusOf, sleep: _noSleep);
    expect(result.status, PairApprovalStatus.expired);
  });

  test('网络抖一下就继续等，不当失败', () async {
    final seq = _sequence([
      ApiException('connection reset', status: 500),
      {'status': 'pending'},
      {'status': 'approved', 'token': 't_ok'},
    ]);
    final result = await awaitApproval(ticket: _ticket, statusOf: seq.statusOf, sleep: _noSleep);
    expect(result.status, PairApprovalStatus.approved);
    expect(result.token, 't_ok');
  });

  test('批准了但 token 已被取走 → failed，并且给一句能照做的提示', () async {
    final seq = _sequence([
      {'status': 'approved'},
    ]);
    final result = await awaitApproval(ticket: _ticket, statusOf: seq.statusOf, sleep: _noSleep);
    expect(result.status, PairApprovalStatus.failed);
    expect(result.message, contains('重新发起'));
  });

  test('一直 pending → 到点返回 timeout', () async {
    final seq = _sequence([
      {'status': 'pending'},
    ]);
    final result = await awaitApproval(
      ticket: _ticket,
      statusOf: seq.statusOf,
      sleep: _noSleep,
      timeout: const Duration(milliseconds: 30),
    );
    expect(result.status, PairApprovalStatus.timeout);
  });

  group('PairRequestHost.fromJson', () {
    test('正常解析', () {
      final r = PairRequestHost.fromJson({
        'id': 'abc',
        'device': '我的手机',
        'platform': 'android',
        'ip': '192.168.1.30',
        'createdAt': 1,
        'expiresAt': 2,
      });
      expect(r, isNotNull);
      expect(r!.device, '我的手机');
      expect(r.ip, '192.168.1.30');
    });

    test('没有 id 的条目直接丢（点了也没法批）', () {
      expect(PairRequestHost.fromJson({'device': 'x'}), isNull);
    });

    test('设备名缺失时给个能读的占位，不是空标题', () {
      final r = PairRequestHost.fromJson({'id': 'abc'});
      expect(r!.device, '一台手机');
    });
  });
}
