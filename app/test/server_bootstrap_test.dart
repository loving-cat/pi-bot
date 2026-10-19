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

      expect(findServerEntry(executable.path, environment: {}), bundled.path);
      expect(
        serverEntryCandidates(
          executable.path,
          environment: {'PI_BOT_SERVER': outside.path},
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
      final versions = candidates.where((path) => path.contains('/versions/'));
      expect(versions, [
        '${nvm.path}/versions/node/v24.1.0/bin/node',
        '${nvm.path}/versions/node/v22.10.0/bin/node',
        '${nvm.path}/versions/node/v22.9.0/bin/node',
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
      final explicit = File('${tmp.path}/chosen-node')..writeAsStringSync('');
      final pathNode = File('${tmp.path}/path with spaces/node');
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
        await findNode(tmp.path, environment: {'PATH': pathNode.parent.path}),
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
