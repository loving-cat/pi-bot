import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// 桌面回车由快捷键区分发送和换行；移动端软键盘显示发送动作。
TextInputAction chatInputActionFor(TargetPlatform platform) => switch (platform) {
  TargetPlatform.macOS || TargetPlatform.windows || TargetPlatform.linux =>
    TextInputAction.newline,
  TargetPlatform.android || TargetPlatform.iOS || TargetPlatform.fuchsia =>
    TextInputAction.send,
};

TextInputAction get chatInputAction => chatInputActionFor(defaultTargetPlatform);
