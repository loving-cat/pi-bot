/// 偏好端口被占用时，桌面端自己挑一个空闲端口。
///
/// ## 为什么要在客户端做
///
/// 服务端保持「端口被占就退出」的语义（EADDRINUSE / EACCES → exit 1），
/// 不自己顺延 —— 它顺延的话，客户端还按偏好端口去连，必然连错。
/// 所以选端口的责任在拉起它的这一侧：先探，探到合适的再告诉服务端监听哪个。
///
/// ## 三条规则
///
/// 1. 偏好端口上已经是**健康的本机 pi-bot** → 直接复用，不新起进程；
/// 2. 偏好端口被别的程序占着 / 连得上但不是 pi-bot / 没权限 → 从它的**下一个**
///    开始往后找，最多 20 个（如 8787–8806）；
/// 3. 只复用「偏好端口上的」那一个。邻口就算也是 pi-bot 也当占用跳过 ——
///    连到别人的实例比多开一个更糟（数据目录不同，用户会看到「消息丢了」）。
///
/// 不做「锁定端口」开关，也不用端口 0（系统随机分配）：配对地址必须是
/// 用户能看懂、能填进另一台设备的明确端口。
library;

import 'dart:io';

import 'launcher.dart';
import 'locate.dart';

/// 偏好端口之外最多再试几个。
///
/// 20 是经验值：家用/办公环境里连续 20 个端口都被占的概率极低，
/// 再多就说明机器上有别的问题，继续往后扫只会让用户等更久。
const int kMaxPortProbeAttempts = 20;

/// 一次端口选择的结果。
class PortChoice {
  const PortChoice({
    required this.port,
    required this.reused,
    this.notice,
    this.problem,
  });

  /// 最终要用的端口。复用已有服务端时它就是那个实例的端口。
  final int port;

  /// 该端口上已经有一个健康的本机 pi-bot，不需要新起进程。
  final bool reused;

  /// 给人看的一句话提示（换端口时才有），例如「8787 被占用，已改用 8788」。
  final String? notice;

  /// 全部候选都不可用时的问题描述；非空表示这次没戏。
  final String? problem;
}

/// 探测单个端口的状态。
enum PortProbeKind {
  /// 空着，可以起服务端。
  free,

  /// 已经是健康的本机 pi-bot，可以复用。
  piBot,

  /// 能连上，但不是 pi-bot（别的程序）。
  occupied,

  /// 连不上也没有权限（EACCES 之类的预兆）。
  blocked,
}

/// 判断一个端口当前的情况。
///
/// 「健康的本机 pi-bot」判定复用 /health（与整个应用一致）：
/// 必须 ok + serverName + version 齐全，避免把别的服务认成自己。
///
/// ★ 判定 free 必须**试绑一次**，不能只看「连不上」。
///   连不上有两种原因：真的空着，和**没有权限监听**（1024 以下的端口
///   在非 root 下就是 EACCES）。后者如果当成 free 选出来，spawn 出去
///   服务端会立刻 exit 1，用户看到的是「启动失败」而不是「换个端口」。
///
///   试绑用 0.0.0.0，和服务端实际监听的地址一致（config.host 默认就是
///   0.0.0.0）—— 只绑 127.0.0.1 的话，别的程序占着 0.0.0.0:port 时
///   可能仍然绑成功，判成 free 后服务端启动失败。
Future<PortProbeKind> probePort(
  int port, {
  Duration timeout = const Duration(milliseconds: 700),
}) async {
  final open = await portOpen('127.0.0.1', port, timeout: timeout);
  if (open) {
    // 有人听着：是不是我们自己的服务端？
    final alive = await serverAlive(
      'http://127.0.0.1:$port',
      timeout: timeout,
    );
    return alive ? PortProbeKind.piBot : PortProbeKind.occupied;
  }

  // 连不上：再确认一次是真的空着，还是没权限绑。
  try {
    final socket = await ServerSocket.bind(
      InternetAddress.anyIPv4,
      port,
      shared: false,
    );
    await socket.close();
    return PortProbeKind.free;
  } on SocketException catch (err) {
    final code = err.osError?.errorCode;
    // EACCES(13) / EPERM(1)：没权限。其余（EADDRINUSE 等）都当被占用。
    if (code == 13 || code == 1) return PortProbeKind.blocked;
    return PortProbeKind.occupied;
  } catch (_) {
    return PortProbeKind.occupied;
  }
}

/// 从 [preferred] 开始挑一个可用端口。
///
/// - 偏好端口上是健康 pi-bot → 复用（reused: true）；
/// - 否则从偏好端口的下一个起往后找最多 [kMaxPortProbeAttempts] 个空端口；
/// - 全都不可用 → 返回带 problem 的结果（调用方据此给出可读失败原因）。
///
/// 注意：**邻口上的 pi-bot 不复用**，继续往后找 —— 只信任偏好端口那一个实例。
Future<PortChoice> choosePort(
  int preferred, {
  int maxAttempts = kMaxPortProbeAttempts,
  Future<PortProbeKind> Function(int port)? probe,
}) async {
  final check = probe ?? probePort;

  final first = await check(preferred);
  if (first == PortProbeKind.piBot) {
    return PortChoice(port: preferred, reused: true);
  }
  // 偏好端口本来就空着 → 直接用它，没必要往后扫
  if (first == PortProbeKind.free) {
    return PortChoice(port: preferred, reused: false);
  }

  // 走到这里说明偏好端口不可用（被占 / 无权限），记下原因用于提示
  final tried = <String>[];
  final firstWhy = first == PortProbeKind.blocked ? '没有权限' : '被别的程序占用';
  tried.add('$preferred（$firstWhy）');

  for (var i = 1; i <= maxAttempts; i++) {
    final candidate = preferred + i;
    if (candidate > 65535) break; // 端口号上限，别越界
    final kind = await check(candidate);
    if (kind == PortProbeKind.free) {
      return PortChoice(
        port: candidate,
        reused: false,
        // 提示要说清**为什么**换：被别的程序占用 / 没权限，处理方式不同
        notice: '$preferred $firstWhy，已改用 $candidate',
      );
    }
    // 邻口上的 pi-bot 也不复用（见文件头第 3 条），当作占用记下
    if (kind == PortProbeKind.piBot) {
      tried.add('$candidate（也是另一个 pi-bot 实例）');
    } else if (kind == PortProbeKind.occupied) {
      tried.add('$candidate（被占用）');
    } else {
      tried.add('$candidate（没有权限）');
    }
  }

  final shown = tried.take(6).join('、');
  final more = tried.length > 6 ? ' 等 ${tried.length} 个' : '';
  return PortChoice(
    port: preferred,
    reused: false,
    problem:
        '端口 $preferred 不可用，往后试了 $maxAttempts 个也没找到空闲的'
        '（$shown$more）。请关掉占用这些端口的程序，'
        '或者在「设置 → 本机服务端」里换一个端口。',
  );
}