import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/server/options.dart';

void main() {
  test('端口始终传给服务端，空数据目录保留服务端的平台默认值', () {
    expect(const ServerLaunchOptions().env, {'PI_BOT_PORT': '8787'});
    expect(
      const ServerLaunchOptions(port: 9876, dataDir: '  data folder  ').env,
      {'PI_BOT_PORT': '9876', 'PI_BOT_HOME': 'data folder'},
    );
  });

  test('★ 加密监听端口单独传给服务端（手机走的那条腿）', () {
    // 桌面端会先给加密端口挑一个空闲的，再传给服务端 ——
    // 不传的话服务端用默认 8443，被占时只打警告、手机就退回明文了。
    expect(
      const ServerLaunchOptions(port: 8787).envForPort(8787, tlsPort: 8443),
      {'PI_BOT_PORT': '8787', 'PI_BOT_TLS_PORT': '8443'},
    );
    // 换了端口也要如实传
    expect(
      const ServerLaunchOptions(port: 8787, dataDir: 'd')
          .envForPort(8787, tlsPort: 8445),
      {'PI_BOT_PORT': '8787', 'PI_BOT_TLS_PORT': '8445', 'PI_BOT_HOME': 'd'},
    );
    // 挑不到空闲口（或调用方没给）时不传 —— 服务端用默认值并按自己的降级逻辑走
    expect(
      const ServerLaunchOptions(port: 8787).envForPort(8787),
      {'PI_BOT_PORT': '8787'},
    );
    expect(
      const ServerLaunchOptions(port: 8787).envForPort(8787, tlsPort: 0),
      {'PI_BOT_PORT': '8787'},
    );
  });

  test('启动参数比较使用规范化的路径和端口', () {
    const a = ServerLaunchOptions(entryPath: ' app.js ', nodePath: ' node ');
    const b = ServerLaunchOptions(entryPath: 'app.js', nodePath: 'node');
    expect(a, b);
    expect(a.hashCode, b.hashCode);
    expect(a, isNot(const ServerLaunchOptions(port: 9876)));
    expect(
      const ServerLaunchOptions(),
      const ServerLaunchOptions(dataDir: ' '),
    );
  });
}
