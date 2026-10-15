import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;

/// 运行环境判断。
///
/// 桌面端 = 宿主（服务端就跑在这台机器上），本机直连，不需要配对。
/// 手机端 = 远程客户端，必须配对拿 token。
bool get isHostPlatform => !kIsWeb && (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

bool get isMobilePlatform => !kIsWeb && (Platform.isAndroid || Platform.isIOS);

/// 桌面端默认连的本机地址
const localServerUrl = 'http://127.0.0.1:8787';
