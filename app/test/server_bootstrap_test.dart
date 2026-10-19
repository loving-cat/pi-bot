import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/locate.dart';
import 'package:pi_bot/server/launcher.dart';

/// 启动层单元测试：服务端入口定位、node/npm 定位、端口探活。
void main() {
  late Directory tmp;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('pi-bot-locate-');
  });

  tearDown(() {
    try {
      tmp.deleteSync(recursive: true);
    } catch (_) {}
  });

  group('找服务端入口', () {
    test('macOS 应用优先使用 Contents/Resources/server', () {
      final contents = Directory('${tmp.path}/pi-bot.app/Contents');
      final executable = Directory('${contents.path}/MacOS')
        ..createSync(recursive: true);
      final bundled = File('${contents.path}/Resources/server/src/index.js');
      bundled.parent.createSync(recursive: true);
      bundled.writeAsStringSync('// bundled');
      final outside = File('${tmp.path}/server/src/index.js');
      outside.parent.createSync(recursive: true);
      outside.writeAsStringSync('// outside');

      // 显式按 macOS 语义生成候选路径：这样在 Windows 主机上跑同一份用例，
      // 分隔符也和真实 .app 包里的一致（否则断言比的是主机分隔符）。
      expect(
        findServerEntry(executable.path, environment: {}, operatingSystem: 'macos'),
        bundled.path,
      );
      expect(
        serverEntryCandidates(
          executable.path,
          environment: {'PI_BOT_SERVER': outside.path},
          operatingSystem: 'macos',
        ).first,
        outside.path,
      );
    });

    test('exe 旁边的 server 优先（发行包的摆法）', () {
      final entry = File(
        '${tmp.path}${Platform.pathSeparator}server${Platform.pathSeparator}src${Platform.pathSeparator}index.js',
      );
      entry.parent.createSync(recursive: true);
      entry.writeAsStringSync('// server');

      expect(findServerEntry(tmp.path), entry.absolute.path);
    });

    test('往上找（开发时 exe 在 build/.../Release 深层目录里）', () {
      final root = Directory('${tmp.path}${Platform.pathSeparator}repo');
      final entry = File(
        '${root.path}${Platform.pathSeparator}server${Platform.pathSeparator}src${Platform.pathSeparator}index.js',
      );
      entry.parent.createSync(recursive: true);
      entry.writeAsStringSync('// server');
      final release = Directory(
        [
          root.path,
          'app',
          'build',
          'windows',
          'x64',
          'runner',
          'Release',
        ].join(Platform.pathSeparator),
      )..createSync(recursive: true);

      expect(findServerEntry(release.path), entry.absolute.path);
    });

    test('找不到就返回 null（交给上层报出试过的路径）', () {
      expect(findServerEntry(tmp.path), isNull);
      expect(serverEntryCandidates(tmp.path), isNotEmpty);
    });
  });

  group('找 node / npm', () {
    test('macOS 候选包含 Resources 与标准安装路径，不含 Windows 名称', () {
      final candidates = nodeCandidates(
        '${tmp.path}/pi-bot.app/Contents/MacOS',
        environment: {},
        operatingSystem: 'macos',
      );
      expect(
        candidates,
        contains('${tmp.path}/pi-bot.app/Contents/Resources/node'),
      );
      expect(candidates, contains('/opt/homebrew/bin/node'));
      expect(candidates, contains('/usr/local/bin/node'));
      expect(candidates.any((path) => path.endsWith('.exe')), isFalse);
      final windows = nodeCandidates(
        r'C:\app',
        environment: {'ProgramFiles': r'C:\Programs'},
        operatingSystem: 'windows',
      );
      expect(windows, contains(r'C:\app\node.exe'));
      expect(windows, contains(r'C:\Programs\nodejs\node.exe'));
      expect(windows.any((path) => path.startsWith('/opt/')), isFalse);
    });

    test('nvm 版本按数值降序查找并支持用户目录和环境覆盖', () {
      final nvm = Directory('${tmp.path}/home/.nvm');
      for (final version in ['v22.9.0', 'v22.10.0', 'v24.1.0']) {
        Directory('${nvm.path}/versions/node/$version/bin')
            .createSync(recursive: true);
      }
      final candidates = nodeCandidates(
        tmp.path,
        environment: {
          'HOME': '${tmp.path}/home',
          'NVM_BIN': '${tmp.path}/active/bin',
        },
        operatingSystem: 'macos',
      );
      expect(candidates, contains('${tmp.path}/active/bin/node'));
      // listSync() 在 Windows 主机上返回的分隔符可能和写入时不同（`node\v24.1.0`），
      // 两边统一成正斜杠，只校验"顺序对不对"。
      String norm(String p) => p.replaceAll(r'\', '/');
      final versions = candidates
          .where((path) => path.contains('/versions/'))
          .map(norm);
      expect(versions, [
        norm('${nvm.path}/versions/node/v24.1.0/bin/node'),
        norm('${nvm.path}/versions/node/v22.10.0/bin/node'),
        norm('${nvm.path}/versions/node/v22.9.0/bin/node'),
      ]);
      expect(
        nodeCandidates(
          tmp.path,
          environment: {'NVM_DIR': '${tmp.path}/custom'},
          operatingSystem: 'macos',
        ),
        contains('${tmp.path}/custom/current/bin/node'),
      );
    });

    test('环境指定 node 优先，PATH 支持含空格目录', () async {
      final sep = Platform.pathSeparator;
      final explicit = File('${tmp.path}${sep}chosen-node')
        ..writeAsStringSync('');
      final pathNode = File('${tmp.path}${sep}path with spaces${sep}node');
      pathNode.parent.createSync(recursive: true);
      pathNode.writeAsStringSync('');
      expect(
        await findNode(
          tmp.path,
          environment: {
            'PI_BOT_NODE': explicit.path,
            'PATH': pathNode.parent.path,
          },
        ),
        explicit.path,
      );
      expect(
        await findNode(
          tmp.path,
          environment: {
            'PATH': pathNode.parent.path,
            // CI 机器上标准安装目录（Program Files 里的 nodejs）是存在的，
            // 不挡掉它会先命中标准安装，用例就变成了“测机器环境”。
            'ProgramFiles': '${tmp.path}${sep}nope',
            'APPDATA': '${tmp.path}${sep}no-appdata',
            'LOCALAPPDATA': '${tmp.path}${sep}no-local',
            'USERPROFILE': '${tmp.path}${sep}no-home',
          },
        ),
        pathNode.path,
      );
    });

    test('非 Windows 不选择同目录的 npm.cmd，并可查 PATH 上的 npm', () {
      if (Platform.isWindows) return;
      final node = File('${tmp.path}/runtime/node');
      node.parent.createSync(recursive: true);
      node.writeAsStringSync('');
      File('${node.parent.path}/npm.cmd').writeAsStringSync('');
      expect(npmCommand(node.path, environment: {}), isEmpty);
      final npm = File('${tmp.path}/path tools/npm');
      npm.parent.createSync(recursive: true);
      npm.writeAsStringSync('');
      expect(npmCommand(node.path, environment: {'PATH': npm.parent.path}), [
        npm.path,
      ]);
    });

    // 这两条要真的在 Windows 的版本目录上 listSync；非 Windows 主机上
    // 建不出同样的语义（反斜杠在 POSIX 上是文件名的一部分）。CI 在 windows-latest 上跑。
    test('Windows 版本管理器：nvm-windows / fnm / Volta / Scoop 都能找到，且版本降序', () {
      final appData = Directory('${tmp.path}${Platform.pathSeparator}AppData')
        ..createSync(recursive: true);
      final localAppData =
          Directory('${tmp.path}${Platform.pathSeparator}LocalAppData')
            ..createSync(recursive: true);
      final home = Directory('${tmp.path}${Platform.pathSeparator}home')
        ..createSync(recursive: true);
      final sep = Platform.pathSeparator;

      // nvm-windows：`%APPDATA%\nvm\vX.Y.Z\node.exe`
      for (final v in ['v18.20.0', 'v22.11.0', 'v24.1.0']) {
        Directory('${appData.path}${sep}nvm$sep$v').createSync(recursive: true);
      }
      // fnm：`%APPDATA%\fnm\node-versions\vX.Y.Z\installation`
      for (final v in ['v20.11.0', 'v22.12.0']) {
        Directory(
          '${appData.path}${sep}fnm${sep}node-versions$sep$v${sep}installation',
        ).createSync(recursive: true);
      }
      // Volta / Scoop
      Directory('${localAppData.path}${sep}Volta${sep}bin')
          .createSync(recursive: true);
      Directory('${home.path}${sep}scoop${sep}apps${sep}nodejs${sep}current')
          .createSync(recursive: true);

      final candidates = nodeCandidates(
        tmp.path,
        environment: {
          'APPDATA': appData.path,
          'LOCALAPPDATA': localAppData.path,
          'USERPROFILE': home.path,
          'ProgramFiles': r'C:\Programs',
        },
        operatingSystem: 'windows',
      );

      expect(
        candidates,
        contains('${localAppData.path}${sep}Volta${sep}bin${sep}node.exe'),
      );
      expect(
        candidates,
        contains('${home.path}${sep}scoop${sep}apps${sep}nodejs${sep}current${sep}node.exe'),
      );

      // 只比较可执行文件（同一目录还会生成无扩展名的 `node` 候选项）
      final nvmOrder = candidates
          .where(
            (p) =>
                p.contains('${sep}nvm$sep') &&
                p.endsWith('.exe') &&
                !p.contains('${sep}custom'),
          )
          .toList();
      expect(nvmOrder, [
        '${appData.path}${sep}nvm${sep}v24.1.0${sep}node.exe',
        '${appData.path}${sep}nvm${sep}v22.11.0${sep}node.exe',
        '${appData.path}${sep}nvm${sep}v18.20.0${sep}node.exe',
      ]);
      final fnmOrder = candidates
          .where(
            (p) =>
                p.contains('${sep}fnm${sep}node-versions$sep') &&
                p.endsWith('.exe'),
          )
          .toList();
      expect(fnmOrder, [
        '${appData.path}${sep}fnm${sep}node-versions${sep}v22.12.0${sep}installation${sep}node.exe',
        '${appData.path}${sep}fnm${sep}node-versions${sep}v20.11.0${sep}installation${sep}node.exe',
      ]);
    }, skip: Platform.isWindows ? false : 'Windows 文件系统语义（CI 在 windows-latest 上跑）');

    test('Windows 显式环境变量：NVM_HOME / NVM_SYMLINK / FNM_DIR', () {
      final sep = Platform.pathSeparator;
      final nvmHome = Directory('${tmp.path}${sep}custom-nvm')
        ..createSync(recursive: true);
      Directory('${nvmHome.path}${sep}v22.5.0').createSync(recursive: true);
      Directory('${nvmHome.path}${sep}v24.0.1').createSync(recursive: true);
      final symlink = Directory('${tmp.path}${sep}current-node')
        ..createSync(recursive: true);
      final fnmDir = Directory('${tmp.path}${sep}custom-fnm')
        ..createSync(recursive: true);

      final candidates = nodeCandidates(
        tmp.path,
        environment: {
          'NVM_HOME': nvmHome.path,
          'NVM_SYMLINK': symlink.path,
          'FNM_DIR': fnmDir.path,
        },
        operatingSystem: 'windows',
      );

      expect(
        candidates,
        contains('${nvmHome.path}${sep}v24.0.1${sep}node.exe'),
      );
      expect(
        candidates.indexOf('${nvmHome.path}${sep}v24.0.1${sep}node.exe'),
        lessThan(
          candidates.indexOf('${nvmHome.path}${sep}v22.5.0${sep}node.exe'),
        ),
      );
      expect(candidates, contains('${symlink.path}${sep}node.exe'));
      expect(
        candidates,
        contains('${fnmDir.path}${sep}aliases${sep}default${sep}installation${sep}node.exe'),
      );
    }, skip: Platform.isWindows ? false : 'Windows 文件系统语义（CI 在 windows-latest 上跑）');

    test('node 版本门槛：22 起步，24 也算新', () {
      expect(versionAtLeast('22.0.0', 22), isTrue);
      expect(versionAtLeast('24.18.0', 22), isTrue);
      expect(versionAtLeast('20.11.1', 22), isFalse);
      expect(versionAtLeast('', 22), isFalse);
    });

    test('npm 在旁边（普通安装）', () {
      final node = File(
        '${tmp.path}${Platform.pathSeparator}node${Platform.isWindows ? '.exe' : ''}',
      )..writeAsStringSync('');
      final npm = File(
        '${tmp.path}${Platform.pathSeparator}${Platform.isWindows ? 'npm.cmd' : 'npm'}',
      )..writeAsStringSync('');
      expect(npmCommand(node.path), [npm.path]);
    });

    test('★ 只带 node.exe 的发行包：用 node 执行 npm-cli.js', () {
      // 发行包只复制 node.exe，npm 实体位于 node_modules/npm/bin/npm-cli.js
      final node = File(
        '${tmp.path}${Platform.pathSeparator}node${Platform.isWindows ? '.exe' : ''}',
      )..writeAsStringSync('');
      final cli = File(
        [
          tmp.path,
          'node_modules',
          'npm',
          'bin',
          'npm-cli.js',
        ].join(Platform.pathSeparator),
      );
      cli.parent.createSync(recursive: true);
      cli.writeAsStringSync('// npm');

      final cmd = npmCommand(node.path);
      expect(cmd.length, 2);
      expect(cmd.first, node.path);
      expect(cmd.last, cli.absolute.path);
    });

    test('节点目录下找不到 npm 时：用 PATH 上的，或返回空', () {
      // 结果要么是真实存在的文件，要么是空（由上层报“没找到 npm”）
      final cmd = npmCommand(
        '${tmp.path}${Platform.pathSeparator}nope${Platform.pathSeparator}node',
      );
      if (cmd.isEmpty) return;
      expect(File(cmd.first).existsSync(), isTrue);
    });
  });

  group('探活', () {
    test('无监听的端口返回 false（不抛异常）', () async {
      // 先占一个随机端口再释放，避免与正在运行的服务冲突
      final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final port = socket.port;
      await socket.close();
      expect(await serverAlive('http://127.0.0.1:$port'), isFalse);
    });
  });
}
