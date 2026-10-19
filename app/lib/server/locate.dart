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
///
/// [operatingSystem] 只影响路径分隔符，默认取当前平台。测试里可以显式传
/// `macos` / `windows`，这样同一份用例在任何主机上跑的语义都一致。
List<String> serverEntryCandidates(
  String exeDir, {
  Map<String, String>? environment,
  String? operatingSystem,
}) {
  final os = operatingSystem ?? Platform.operatingSystem;
  final sep = os == 'windows' ? r'\' : '/';
  String at(String base, List<String> parts) => [base, ...parts].join(sep);
  const entry = ['server', 'src', 'index.js'];
  final out = <String>[];

  final env = (environment ?? Platform.environment)['PI_BOT_SERVER']?.trim();
  if (env != null && env.isNotEmpty) out.add(env);

  // .app 包的布局是 `X.app/Contents/MacOS/`，server 在 `Contents/Resources/`。
  // 判断时两种分隔符都认：用例里的临时目录在 Windows 主机上是反斜杠开头的绝对路径，
  // 但拼接出来的 bundle 路径可能带正斜杠 —— 只看主机分隔符会漏掉。
  final parentPath = Directory(exeDir).parent.path;
  if (parentPath.endsWith('${sep}Contents') ||
      parentPath.endsWith('/Contents') ||
      parentPath.endsWith(r'\Contents')) {
    out.add(at(parentPath, ['Resources', ...entry]));
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

String? findServerEntry(
  String exeDir, {
  Map<String, String>? environment,
  String? operatingSystem,
}) {
  for (final path in serverEntryCandidates(
    exeDir,
    environment: environment,
    operatingSystem: operatingSystem,
  )) {
    if (File(path).existsSync()) return File(path).absolute.path;
  }
  return null;
}

/// 从某个版本根目录里列出 `vX.Y.Z` 形态的子目录，按主、次、补丁**降序**。
///
/// 只解析目录名的最后一段，并同时认 `/` 与 `\`：
/// 测试里会喂进来 `C:\...\home/.nvm/versions/node\v22.10.0` 这种混合分隔符的路径，
/// 只按 `/` 切会把 `node\v22.10.0` 当成版本名，解析成 `[0,0,0]`，
/// 排序结果就变成随机的（线上表现为"明明装了新 node，却挑到旧版本")。
List<Directory> versionDirsDescending(String root) {
  Directory dir;
  try {
    dir = Directory(root);
    if (!dir.existsSync()) return const [];
    final dirs = dir.listSync().whereType<Directory>().toList();
    final versioned = <(List<int>, Directory)>[];
    for (final item in dirs) {
      final name = item.path.split(RegExp(r'[\\/]')).last;
      final m = RegExp(r'^v?(\d+)\.(\d+)\.(\d+)').firstMatch(name);
      if (m == null) continue;
      versioned.add((
        [
          int.tryParse(m.group(1)!) ?? 0,
          int.tryParse(m.group(2)!) ?? 0,
          int.tryParse(m.group(3)!) ?? 0,
        ],
        item,
      ));
    }
    versioned.sort((a, b) {
      final av = a.$1;
      final bv = b.$1;
      for (var i = 0; i < 3; i++) {
        final order = bv[i].compareTo(av[i]);
        if (order != 0) return order;
      }
      return b.$2.path.compareTo(a.$2.path);
    });
    return [for (final v in versioned) v.$2];
  } on FileSystemException {
    return const [];
  }
}

/// node 候选路径：环境覆盖、应用目录、PATH，再补各平台常见安装位置。
///
/// Windows 除了标准安装（`Program Files\nodejs`），还认这些发行方式 ——
/// 它们在 Windows 上很常见，但装完**不会**把 node 放进系统 PATH 的固定位置：
///   · nvm-windows（`NVM_HOME` / `%APPDATA%\nvm\vX.Y.Z\node.exe`、`NVM_SYMLINK`）
///   · fnm（`FNM_DIR` / `%APPDATA%\fnm\node-versions\vX.Y.Z\installation`）
///   · Volta（`%LOCALAPPDATA%\Volta\bin`）
///   · Scoop（`%USERPROFILE%\scoop\apps\nodejs\current`、`scoop\shims`）
///
/// 版本目录一律按数值降序，保证"装了 24 就用 24"，而不是拿到磁盘顺序里
/// 碰巧第一个的 18。
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
      out.add('${_trimSep(dir, windows)}$sep$name');
    }
  }

  /// Windows 子目录拼接：`win(['C:\\a', 'Volta', 'bin'])`。
  /// 不能直接写 `'$x\Volta'` —— Dart 里 `\V` 不是转义序列，反斜杠会丢。
  String win(List<String> parts) => parts.join(r'\');

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
    addDirectory(win([env['ProgramFiles'] ?? r'C:\Program Files', 'nodejs']));

    final localAppData = env['LOCALAPPDATA'];
    final appData = env['APPDATA'];
    final home = env['USERPROFILE'] ?? env['HOME'];

    // Volta：node.exe 是个 shim，在 bin 下
    if (localAppData != null) addDirectory(win([localAppData, 'Volta', 'bin']));

    // nvm-windows：每个版本一个目录，当前版本通过 NVM_SYMLINK 暴露
    final nvmHome = env['NVM_HOME'] ?? (appData == null ? null : win([appData, 'nvm']));
    if (nvmHome != null) {
      for (final dir in versionDirsDescending(nvmHome)) {
        addDirectory(dir.path);
      }
    }
    final nvmSymlink = env['NVM_SYMLINK'];
    if (nvmSymlink != null) addDirectory(nvmSymlink);

    // fnm：版本在 node-versions/<ver>/installation，别名是符号链接
    final fnmDir = env['FNM_DIR'] ?? (appData == null ? null : win([appData, 'fnm']));
    if (fnmDir != null) {
      addDirectory(win([fnmDir, 'aliases', 'default', 'installation']));
      for (final dir in versionDirsDescending(win([fnmDir, 'node-versions']))) {
        addDirectory(win([dir.path, 'installation']));
      }
    }

    // Scoop：current 是指向当前版本的链接，shims 里是转发脚本
    if (home != null) {
      addDirectory(win([home, 'scoop', 'apps', 'nodejs', 'current']));
      addDirectory(win([home, 'scoop', 'apps', 'nodejs-lts', 'current']));
      addDirectory(win([home, 'scoop', 'shims']));
    }
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
      for (final dir in versionDirsDescending('$nvmDir/versions/node')) {
        addDirectory('${dir.path}/bin');
      }
    }
  }
  return out.toSet().toList();
}

/// 去掉末尾多余的分隔符 —— PATH 里经常带 `C:\` 或 `C:\dir\`，
/// 直接拼会出 `C:\\node.exe` 这种双分隔符。
String _trimSep(String dir, bool windows) {
  var out = dir.trim();
  if (out.endsWith(r'\') || out.endsWith('/')) {
    // 根目录（`C:\`、`/`）要保留一个
    final isRoot = RegExp(r'^[A-Za-z]:[\\/]$').hasMatch(out) || out == '/';
    if (isRoot) return windows ? '${out[0]}:\\' : '/';
    out = out.substring(0, out.length - 1);
  }
  return out;
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
