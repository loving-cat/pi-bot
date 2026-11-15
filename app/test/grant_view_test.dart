import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/grant_view.dart';

/// 授权面板的展示口径（纯逻辑）。
///
/// 守的是两件“用户会直接误会”的事：
///   1. 空范围必须说成“不限范围”，不能整行空白 —— 空范围是**最宽**的一档，
///      界面把它画得像“没有范围”等于把最危险的授权藏起来。
///   2. 按旧规矩批的授权要能被识别出来。规矩一改，服务端会按
///      policyChanged 拒掉这些授权（grants.js）。界面上还画成正常授权，
///      用户会以为“我明明授权了，它怎么还报没权限”。
void main() {
  group('GrantView', () {
    test('空范围说成“不限范围”，不是空串', () {
      final g = GrantView.fromJson({
        'id': 'gr_1',
        'subject': {'botId': 'chief'},
        'actions': ['file.read', 'file.write'],
        'resources': [],
        'mode': 'host',
      });
      expect(g.scopeSummary, '不限范围');
      expect(g.actionSummary, '读文件、写文件');
    });

    test('动作名翻成人话，不认识的保留原名（不能让新动作整行消失）', () {
      final g = GrantView.fromJson({
        'id': 'gr_2',
        'subject': {'botId': 'b'},
        'actions': ['desktop.observe', 'future.action'],
        'resources': [{'kind': 'path', 'ref': '/proj/alpha'}],
        'mode': 'host',
      });
      expect(g.actionSummary, '看屏幕、future.action');
      expect(g.scopeSummary, 'path:/proj/alpha');
    });

    test('动作多时折叠，不把一张卡片撑满', () {
      final g = GrantView.fromJson({
        'id': 'gr_3',
        'subject': {'botId': 'b'},
        'actions': ['file.read', 'file.write', 'cmd.exec', 'git.read', 'net.fetch'],
        'mode': 'host',
      });
      expect(g.actionSummary, contains('等 5 项'));
    });

    test('次数用到上限时说得清用了多少', () {
      final g = GrantView.fromJson({
        'id': 'gr_4',
        'subject': {'botId': 'b'},
        'actions': ['file.read'],
        'maxUses': 3,
        'usedUses': 2,
      });
      expect(g.limitSummary, '已用 2/3 次');
    });

    test('规矩版本不一致 → 标为旧规矩批的', () {
      final g = GrantView.fromJson({
        'id': 'gr_5',
        'subject': {'botId': 'b'},
        'actions': ['file.read'],
        'policyRevision': 'aaaa1111',
      });
      expect(g.staleForPolicy('bbbb2222'), isTrue);
      expect(g.staleForPolicy('aaaa1111'), isFalse);
    });

    test('任一方没有版本号时不标旧（迁移来的老数据不该被误伤）', () {
      final g = GrantView.fromJson({
        'id': 'gr_6',
        'subject': {'botId': 'b'},
        'actions': ['file.read'],
      });
      expect(g.staleForPolicy('bbbb2222'), isFalse, reason: '没有版本号 = 老数据，不猜');
      expect(g.staleForPolicy(null), isFalse);
    });

    test('坏数据整条跳过，不让界面崩', () {
      final list = grantsFromResponse({
        'grants': [
          {'id': 'gr_ok', 'subject': {'botId': 'b'}, 'actions': ['file.read']},
          {'id': '', 'subject': {'botId': 'b'}},
          {'id': 'gr_no_bot'},
          'not-a-map',
        ],
      });
      expect(list.map((g) => g.id), ['gr_ok']);
    });

    test('整个响应缺失时给空列表', () {
      expect(grantsFromResponse(null), isEmpty);
    });
  });

  group('GrantAuditEntry', () {
    test('放行与拒绝的摘要分得清', () {
      final ok = GrantAuditEntry.fromJson({
        'at': 1, 'action': 'file.write', 'result': 'allow',
        'targets': ['path:/proj/alpha/a.js'], 'risk': 'low',
      });
      expect(ok.allowed, isTrue);
      expect(ok.summary, contains('写文件'));
      expect(ok.summary, contains('放行'));
      expect(ok.summary, contains('/proj/alpha/a.js'));

      final denied = GrantAuditEntry.fromJson({
        'at': 2, 'action': 'git.push', 'result': 'deny',
        'code': 'no_grant', 'detail': '没有覆盖它的授权', 'risk': 'high',
      });
      expect(denied.allowed, isFalse);
      expect(denied.summary, contains('拒绝'));
      expect(denied.code, 'no_grant');
    });

    test('不认识的动作保留原名，不能让新动作整行消失', () {
      final e = GrantAuditEntry.fromJson({
        'at': 1, 'action': 'future.action', 'result': 'deny',
      });
      expect(e.summary, contains('future.action'));
    });

    test('没有目标时不画空括号', () {
      final e = GrantAuditEntry.fromJson({
        'at': 1, 'action': 'net.send', 'result': 'allow', 'targets': [],
      });
      expect(e.summary.contains('（）'), isFalse, reason: e.summary);
    });

    test('坏数据整条跳过', () {
      final list = grantAuditFromResponse({
        'audit': [
          {'at': 1, 'action': 'file.read', 'result': 'allow'},
          {'at': 2},
          'not-a-map',
        ],
      });
      expect(list.map((e) => e.action), ['file.read']);
    });

    test('整个响应缺失时给空列表', () {
      expect(grantAuditFromResponse(null), isEmpty);
    });
  });
}
