/// 连接请求（"附近的电脑"那条路）。
///
/// 手机点一台电脑 → 电脑上弹窗问"这台手机想连接，允许吗" → 允许之后才发 token。
/// 和输配对码的区别：**配对码是谁知道谁能连，连接请求是电脑前的人当场点一下**。
/// 配对码那条路保留（服务器/无界面部署只能靠它）。
library;

import 'dart:async';

import 'api.dart';

/// 服务端的请求有效期（`server/src/pair-requests.js` 的 REQUEST_TTL_MS）。
///
/// 复制一份常量的原因：手机要在**服务端说"过期"之后**才决定放弃，
/// 而不是先自己超时、让用户看到一句笼统的"等太久了"。
const Duration kPairRequestTtl = Duration(seconds: 30);

/// 手机端最多等多久。比 TTL 长 5 秒：多等一轮轮询，好让"已过期"这个明确状态先到。
const Duration kPairApprovalTimeout = Duration(seconds: 35);

/// 轮询间隔。900ms 够快（人点完允许，手机上几乎立刻有反应），又不至于打满网络。
const Duration kPairApprovalInterval = Duration(milliseconds: 900);

/// 电脑上"待批"的一条请求（手机端不用管，桌面 App 用它弹窗）。
class PairRequestHost {
  const PairRequestHost({
    required this.id,
    required this.device,
    required this.platform,
    required this.ip,
    required this.createdAt,
    required this.expiresAt,
  });

  final String id;

  /// 手机自己填的名字，例如"我的手机"
  final String device;
  final String platform;
  final String ip;
  final int createdAt;
  final int expiresAt;

  static PairRequestHost? fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    if (id is! String || id.isEmpty) return null;
    int asInt(Object? v) => v is num ? v.toInt() : 0;
    String asText(Object? v) => v is String ? v : '';
    return PairRequestHost(
      id: id,
      device: asText(json['device']).isEmpty ? '一台手机' : asText(json['device']),
      platform: asText(json['platform']),
      ip: asText(json['ip']),
      createdAt: asInt(json['createdAt']),
      expiresAt: asInt(json['expiresAt']),
    );
  }
}

/// 手机等电脑批准的结果。
enum PairApprovalStatus { approved, denied, expired, timeout, failed }

class PairApprovalResult {
  const PairApprovalResult(this.status, {this.token, this.serverName, this.workspace, this.message});

  final PairApprovalStatus status;
  final String? token;
  final String? serverName;
  final String? workspace;
  final String? message;

  bool get ok => status == PairApprovalStatus.approved && (token?.isNotEmpty ?? false);
}

/// 发起一个连接请求，拿到请求 id（电脑那边同时会弹窗）。
Future<PairRequestTicket> requestPairing(
  String baseUrl, {
  required String device,
  String? platform,
}) async {
  final body = await Api.requestPair(baseUrl, device: device, platform: platform);
  final id = body['id'];
  if (id is! String || id.isEmpty) {
    throw ApiException('服务端没给请求编号，连接失败');
  }
  return PairRequestTicket(
    id: id,
    baseUrl: baseUrl,
    serverName: body['serverName'] is String ? body['serverName'] as String : '',
  );
}

/// 刚发出的连接请求。
class PairRequestTicket {
  const PairRequestTicket({required this.id, required this.baseUrl, required this.serverName});

  final String id;
  final String baseUrl;
  final String serverName;
}

/// 轮询等电脑点"允许"。
///
/// 注入 [statusOf] 是为了能测：真实现走 HTTP，测试里给一个假的状态序列。
/// 不抛异常：等不到（拒绝/过期/超时/网络断）都由 status 说明，界面照它渲染。
Future<PairApprovalResult> awaitApproval({
  required PairRequestTicket ticket,
  Duration interval = kPairApprovalInterval,
  Duration timeout = kPairApprovalTimeout,
  Future<Map<String, dynamic>> Function(String baseUrl, String id)? statusOf,
  Future<void> Function(Duration)? sleep,
}) async {
  final poll = statusOf ?? Api.pairRequestStatus;
  final wait = sleep ?? Future<void>.delayed;
  final deadline = DateTime.now().add(timeout);

  while (DateTime.now().isBefore(deadline)) {
    try {
      final body = await poll(ticket.baseUrl, ticket.id);
      final status = body['status'];
      if (status == 'approved') {
        final token = body['token'];
        if (token is String && token.isNotEmpty) {
          return PairApprovalResult(
            PairApprovalStatus.approved,
            token: token,
            serverName: body['serverName'] is String ? body['serverName'] as String : ticket.serverName,
            workspace: body['workspace'] is String ? body['workspace'] as String : null,
          );
        }
        // 批准了但 token 已经被别人取走（同一个 id 只能取一次）—— 重新发起
        return const PairApprovalResult(
          PairApprovalStatus.failed,
          message: '授权已经被取走了，重新发起一次连接请求',
        );
      }
      if (status == 'denied') {
        return const PairApprovalResult(PairApprovalStatus.denied);
      }
      if (status == 'expired') {
        return const PairApprovalResult(PairApprovalStatus.expired);
      }
    } on ApiException catch (err) {
      // 410 = 这条请求没了（过期太久被清理），别再轮询
      if (err.status == 410) {
        return const PairApprovalResult(PairApprovalStatus.expired);
      }
      // 其它错误（网络抖动）忽略，继续等：用户正在电脑上点按钮，别因为他没回一下就放弃
    } catch (_) {
      // 同上
    }
    await wait(interval);
  }
  return const PairApprovalResult(PairApprovalStatus.timeout);
}
