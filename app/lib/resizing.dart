import 'package:flutter/foundation.dart';

/// 窗口正在被拖动缩放。
///
/// 用来做"拖动期间降级渲染"：Windows 的尺寸变化没有增量路径，每次都整窗重来，
/// 三个栏（侧边栏 + 聊天 + 右侧面板）一起重光栅，窗口一大就拖不动。
/// 拖动期间把内容冻成色块，帧成本能从 ~8-10ms 掉到 ~2-3ms。
///
/// 这个开关也是**判断"卡的是我们内容还是平台"的决定性试验**：
/// 冻住之后还卡，那就是 Flutter 在 Windows 上拖窗口本身的问题，不是我们的。
final appResizing = ValueNotifier<bool>(false);
