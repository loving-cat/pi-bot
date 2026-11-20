/// 读取服务端每次启动生成的本机 token。
///
/// ## 为什么需要
///
/// 服务端现在不再"来自回环地址就是主人" —— 本机任何进程都能往 127.0.0.1
/// 发请求，那个假设是个洞（见 server/src/local-token.js）。
///
/// 服务端启动时把 32 字节随机 token 写进数据目录下的 `local-token`（0600），
/// 桌面端（本机、单用户）直接读这个文件，把它带在每个请求的
/// `Authorization: Bearer` 上。攻击者要拿到它得能读用户的私有文件 ——
/// 那就已经越过"同机进程"这条线了。
///
/// ## 为什么读文件而不是走 IPC
///
/// 服务端由桌面端自己拉起（ServerLauncher），但两者是独立进程，
/// 现在没有现成的双向 IPC 通道。读一个 0600 文件是最小改动，
/// 而且服务端重启后 token 会变，每次连接前读一次天然跟上。
library;

import 'dart:io';

/// 数据目录下的 token 文件名（与 server/src/local-token.js 保持一致）。
const String localTokenFilename = 'local-token';

/// 从数据目录读本机 token。
///
/// [dataDir] 为空时返回 null —— 由调用方决定退回哪种提示。
/// 文件不存在 / 读失败 / 内容为空都返回 null，不抛异常：
/// 这是启动路径上的辅助逻辑，任何失败都不该让 App 起不来。
Future<String?> readLocalTokenFile(String? dataDir) async {
  final dir = (dataDir ?? '').trim();
  if (dir.isEmpty) return null;
  try {
    final file = File('$dir/$localTokenFilename');
    if (!await file.exists()) return null;
    final text = (await file.readAsString()).trim();
    return text.isEmpty ? null : text;
  } catch (_) {
    return null;
  }
}

/// 在若干候选数据目录里找到 token。
///
/// 为什么要有候选：用户可能没显式配 dataDir（走服务端默认值），
/// 这时桌面端不知道服务端最终用了哪个目录。按"显式配置 → 常见默认位置"
/// 依次尝试，找到就用。
Future<String?> readLocalTokenFromCandidates(List<String?> candidates) async {
  for (final dir in candidates) {
    final token = await readLocalTokenFile(dir);
    if (token != null) return token;
  }
  return null;
}

/// [readLocalTokenFile] 的同步版本 —— **重连路径**专用。
///
/// 服务端**每次启动**都会换一个 token（见 server/src/local-token.js），
/// 桌面端如果只在进程启动时读一次文件，服务端一重启（改配置、崩溃自愈、
/// 用户手动重启）手里的 token 就作废了：接下来每一次重连都是 401，
/// 界面表现是「离线 · 自动重连中」无限转圈，而服务端日志里连一条
/// 「已连接」都没有 —— 看起来就像服务端没开。
///
/// 放在 `connect()` 里同步读（不到 100 字节的本地文件），
/// 每次发起连接前都跟上最新的 token。
String? readLocalTokenFileSync(String? dataDir) {
  final dir = (dataDir ?? '').trim();
  if (dir.isEmpty) return null;
  try {
    final file = File('$dir/$localTokenFilename');
    if (!file.existsSync()) return null;
    final text = file.readAsStringSync().trim();
    return text.isEmpty ? null : text;
  } catch (_) {
    return null;
  }
}

/// [readLocalTokenFromCandidates] 的同步版本（重连路径用，见上）。
String? readLocalTokenFromCandidatesSync(List<String?> candidates) {
  for (final dir in candidates) {
    final token = readLocalTokenFileSync(dir);
    if (token != null) return token;
  }
  return null;
}
