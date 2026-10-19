/// 路径与运行时查找：服务端入口、node、npm、端口探活。
///
/// 全部无状态，只依赖传入目录，便于单独测试各种安装形态。
library;

import 'dart:io';

/// 从 `exeDir` 起向父目录查找 `server/src/index.js` 的所有候选路径。
///
/// 顺序：`PI_BOT_SERVER` → App Resources → exe 同级 → 逐层向上（最多 8 层）→ 当前目录。
/// 开发时 exe 位于 `app/build/windows/x64/runner/Release/`；
/// 发行包则把 `server/` 与 exe 放在同一目录。
List<String> serverEntryCandidates(
  String exeDir, {
  Map<String, String>? environment,
}) {
  final sep = Platform.pathSeparator;
  String at(String base, List<String> parts) => [base, ...parts].join(sep);
  const entry = ['server', 'src', 'index.js'];
  final out = <String>[];

  final env = (environment ?? Platform.environment)['PI_BOT_SERVER']?.trim();
  if (env != null && env.isNotEmpty) out.add(env);

  if (Directory(exeDir).parent.path.endsWith('${sep}Contents')) {
    out.add(at(Directory(exeDir).parent.path, ['Resources', ...entry]));
  }
  out.add(at(exeDir, entry));
  out.add(at(at(exeDir, const ['..']), entry));

  var dir = Directory(exeDir);
  for (var i = 0; i < 8; i++) {
    out.add(at(dir.path, entry));
    final parent = dir.parent;
    if (parent.path == dir.path) break;
    dir = parent;
  }
  out.add(at(Directory.current.path, entry));
  return out;
}

String? findServerEntry(String exeDir, {Map<String, String>? environment}) {
  for (final path in serverEntryCandidates(exeDir, environment: environment)) {
    if (File(path).existsSync()) return File(path).absolute.path;
  }
  return null;
}

/// node 候选路径：环境覆盖、应用目录、PATH，再补 macOS 的常见安装目录。
/// nvm 版本目录按主、次、补丁版本降序，不执行用户的 shell 配置。
List<String> nodeCandidates(
  String exeDir, {
  Map<String, String>? environment,
  String? operatingSystem,
}) {
  final env = environment ?? Platform.environment;
  final os = operatingSystem ?? Platform.operatingSystem;
  final windows = os == 'windows';
  final sep = windows ? r'\' : '/';
  final names = windows ? ['node.exe', 'node'] : ['node'];
  final out = <String>[];
  void addDirectory(String dir) {
    if (dir.trim().isEmpty) return;
    for (final name in names) {
      out.add('$dir$sep$name');
    }
  }

  final explicit = env['PI_BOT_NODE']?.trim();
  if (explicit != null && explicit.isNotEmpty) out.add(explicit);
  addDirectory(exeDir);
  addDirectory('$exeDir${sep}node');
  if (os == 'macos' && Directory(exeDir).parent.path.endsWith('/Contents')) {
    final resources = '${Directory(exeDir).parent.path}/Resources';
    addDirectory(resources);
    addDirectory('$resources/node');
  }
  if (windows) {
    addDirectory('${env['ProgramFiles'] ?? r'C:\Program Files'}\\nodejs');
  }
  for (final directory in (env['PATH'] ?? '').split(windows ? ';' : ':')) {
    addDirectory(directory.trim());
  }
  if (os == 'macos') {
    addDirectory('/opt/homebrew/bin');
    addDirectory('/usr/local/bin');
    addDirectory('/usr/bin');
    addDirectory(env['NVM_BIN'] ?? '');
    final home = env['HOME'];
    final nvmDir = env['NVM_DIR'] ?? (home == null ? null : '$home/.nvm');
    if (nvmDir != null && nvmDir.isNotEmpty) {
      addDirectory('$nvmDir/current/bin');
      try {
        final versions = Directory('$nvmDir/versions/node')
            .listSync()
            .whereType<Directory>()
            .toList();
        List<int> version(Directory dir) => dir.path
            .split('/')
            .last
            .replaceFirst(RegExp(r'^v'), '')
            .split('.')
            .map((part) => int.tryParse(part) ?? 0)
            .toList();
        versions.sort((a, b) {
          final av = version(a);
          final bv = version(b);
          for (var i = 0; i < 3; i++) {
            final order = (i < bv.length ? bv[i] : 0).compareTo(
              i < av.length ? av[i] : 0,
            );
            if (order != 0) return order;
          }
          return b.path.compareTo(a.path);
        });
        for (final dir in versions) {
          addDirectory('${dir.path}/bin');
        }
      } on FileSystemException {
        // 没有安装 nvm 时继续使用其它候选。
      }
    }
  }
  return out.toSet().toList();
}

/// 定位 node；非 Windows 平台不会选择 Windows 可执行文件。
Future<String?> findNode(
  String exeDir, {
  Map<String, String>? environment,
  String? operatingSystem,
}) async {
  for (final path in nodeCandidates(
    exeDir,
    environment: environment,
    operatingSystem: operatingSystem,
  )) {
    if (File(path).existsSync()) return path;
  }
  return null;
}

/// npm 的调用参数（空列表 = 未找到）。
///
/// 支持的安装形态：
///   · 标准安装：`<node 目录>/npm.cmd`；
///   · 仅含 node.exe 的发行包：以 `node npm-cli.js` 方式调用；
///   · node 不在标准位置时：使用 PATH 上的 npm。
List<String> npmCommand(String nodePath, {Map<String, String>? environment}) {
  final sep = Platform.pathSeparator;
  final dir = File(nodePath).parent.path;

  final names = Platform.isWindows ? ['npm.cmd', 'npm'] : ['npm'];
  for (final name in names) {
    final p = '$dir$sep$name';
    if (File(p).existsSync()) return [p];
  }

  final cli = [
    [dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'].join(sep),
    [dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'].join(sep),
  ].firstWhere((p) => File(p).existsSync(), orElse: () => '');
  if (cli.isNotEmpty) return [nodePath, File(cli).absolute.path];

  // PATH 上的 npm（node 不是标准安装时常见）
  final path = (environment ?? Platform.environment)['PATH'] ?? '';
  for (final dirEntry in path.split(Platform.isWindows ? ';' : ':')) {
    if (dirEntry.trim().isEmpty) continue;
    for (final name in names) {
      final p = '${dirEntry.trim()}$sep$name';
      if (File(p).existsSync()) return [p];
    }
  }
  return const [];
}

/// 读取 node 版本号（去掉前缀 v）；无法执行时返回 null。
Future<String?> nodeVersion(String nodePath) async {
  try {
    final r = await Process.run(nodePath, ['-v']);
    if (r.exitCode != 0) return null;
    return '${r.stdout}'.trim().replaceAll(RegExp(r'^v'), '');
  } catch (_) {
    return null;
  }
}

bool versionAtLeast(String version, int major) {
  final parts = version.split('.');
  final first = int.tryParse(parts.isNotEmpty ? parts.first : '') ?? 0;
  return first >= major;
}

/// 检查端口是否可建立 TCP 连接（用于区分"服务未启动"与"端口被占用"）。
Future<bool> portOpen(
  String host,
  int port, {
  Duration timeout = const Duration(milliseconds: 600),
}) async {
  try {
    final socket = await Socket.connect(host, port, timeout: timeout);
    socket.destroy();
    return true;
  } catch (_) {
    return false;
  }
}
