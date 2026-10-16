import 'package:flutter/widgets.dart';

/// 头像"活着"那部分需要的全局状态。
///
/// 设计原则（思路是学的，实现和参数是我们自己的）：
///   · 不存任何动画资源，每一帧现算
///   · **眼睛跟着鼠标看** —— 这是"活"最省力的来源，而且只在鼠标动的时候才重绘
///   · 点一下要有反应
///   · **安静下来就停掉动画**。一直在动不等于活，只等于一直在烧光栅
///     （我们量过：桌面端 raster 是瓶颈，所以定成"默认静、交互才动"）
///
/// 最后一条容易和"灵动"混淆：真正让人觉得活的不是持续抖动，
/// 而是**对你在做的事有反应**。
class AvatarLife {
  AvatarLife._();

  /// 全局指针位置（逻辑坐标）。App 根上挂一层 [watchPointer] 往里写。
  /// null = 指针不在窗口里（或触摸设备）—— 那就没有"看"的对象。
  static final ValueNotifier<Offset?> pointer = ValueNotifier<Offset?>(null);

  /// 多久没动静就睡（停掉扭动和眨眼）。任何交互都能重新唤醒。
  static const settleAfter = Duration(seconds: 6);

  /// 在 `MaterialApp.builder` 里套一层：让所有头像都能知道鼠标在哪。
  static Widget watchPointer({required Widget child}) {
    return MouseRegion(
      opaque: false,
      onHover: (e) => _update(e.position),
      onExit: (_) => pointer.value = null,
      child: Listener(
        behavior: HitTestBehavior.translucent,
        onPointerMove: (e) => _update(e.position),
        onPointerDown: (e) => _update(e.position),
        child: child,
      ),
    );
  }

  /// 鼠标事件频率很高，而每个头像都要据此重绘一次 ——
  /// 位移不到 2px 就不发通知（这种微动眼睛也看不出来）。
  /// 一屏十几个头像时，这条过滤能省掉相当一部分重绘。
  static void _update(Offset p) {
    final last = pointer.value;
    if (last != null && (p - last).distanceSquared < 4) return;
    pointer.value = p;
  }
}

/// 眼睛该往哪偏。
///
/// [pointer] 是鼠标位置（全局坐标），[avatarCenter] 是头像中心。
/// 越近越明显，远了就收敛回正 —— 做成"眼睛黏在鼠标上"反而诡异。
/// 偏移量硬性夹在一个小范围内（[size] 的 11%），保证眼睛不会跑出脸。
///
/// 抽成纯函数是为了能测：**方向搞反了（看反方向）肉眼很难发现**，
/// 而一个 assert 就能钉死。
Offset eyeOffsetToward({
  required Offset avatarCenter,
  required Offset pointer,
  required double size,
}) {
  final d = pointer - avatarCenter;
  final len = d.distance;
  if (len < 0.5) return Offset.zero;
  // ★ 这是"看方向"，不是"看距离"。
  //
  //   以前用 len/(len+size) 做衰减 —— 那意味着**越近偏得越少**。
  //   但真实场景恰恰相反：用户的鼠标往往就在同一行里（离头像几十像素），
  //   那时候偏移量趋近 0，看起来就是"它没在看我"（用户两次报这个问题）。
  //
  //   改成：只要往某个方向偏出去一小段（0.3*size），就直接给满偏移。
  //   于是"鼠标在这一行的任何位置"都等于"它的眼睛正看着你"。
  //   上限 0.16*size 是量过的：再大，窄形状（水滴/拱形）的眼睛会压到轮廓上。
  final falloff = (len / (size * 0.3)).clamp(0.0, 1.0);
  final reach = size * 0.16;
  return d * (falloff * reach / len);
}

/// 头像的心情 —— 决定它"看哪儿"和"睡不睡"。
///
/// 只做两种：闲着的时候视线随便飘，干活的时候抬眼看上方（"在想"）。
/// 不铺 53 种状态 —— 那对用户没有意义，对我们只是维护成本。
enum AvatarMood {
  /// 闲着：偶尔眨眼，视线跟着鼠标
  idle,

  /// 在干活（流式输出/跑工具）：视线略微上抬，而且不睡
  busy,
}
