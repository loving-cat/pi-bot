import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../theme.dart';
import 'avatar_life.dart';

/// 会呼吸的彩色 blob 头像。
///
/// 每个 bot 由 id 决定：颜色、blob 轮廓（三阶谐波）、眼睛位置。
/// 动画分两层：轮廓缓慢扭动（像水母），眼睛偶尔眨一下。
class BlobAvatar extends StatefulWidget {
  const BlobAvatar({
    super.key,
    required this.seed,
    required this.color,
    this.emoji,
    this.size = 44,
    this.animate = true,
    this.badge,
    this.ring = false,
    this.mood = AvatarMood.idle,
    this.interactive = false,
    this.followPointer = true,
    this.hovered = false,
  });

  final String seed;
  final Color color;
  final String? emoji;
  final double size;
  final bool animate;
  final Widget? badge;

  /// 主控那种"高一级"的身份环
  final bool ring;

  /// 心情：闲 / 干活中（干活中视线略抬，而且不会"睡着"）
  final AvatarMood mood;

  /// 外面告诉我们"鼠标停在**这一行**上"（不只是头像那 46px 的框）。
  ///
  /// 为什么要这个：用户的心智是"我进到这条会话上，它就该看着我"——
  /// 而头像本身只有 46px，鼠标停在名字/预览文字上时它还是呆的，看着像坏了。
  /// 所以由行来驱动（见 RoomsScreen 的 _RoomRow）。
  final bool hovered;

  /// 眼睛要不要跟着鼠标看。
  /// 群头像（几个 blob 叠在一起）关掉 —— 一堆眼睛同时转过去很怪。
  final bool followPointer;

  /// 可点：戳一下会挤一下。
  /// 默认 false —— 列表里的头像外面本来就有整行的点击，套一层手势会把行点击吃掉。
  /// 只有"孤零零挂着"的大头像（会话头部那种）才该开。
  final bool interactive;

  /// 单测里关掉动画。
  ///
  /// 眨眼是 `Future.delayed` 排的定时器、轮廓是无限循环的 AnimationController ——
  /// 测试结束时还挂着定时器，`testWidgets` 会直接判失败（pending timers），
  /// 而且 pumpAndSettle 永远等不到"静止"。生产代码不动它（默认 true）。
  @visibleForTesting
  static bool animationsEnabled = true;

  @override
  State<BlobAvatar> createState() => _BlobAvatarState();
}

class _BlobAvatarState extends State<BlobAvatar> with TickerProviderStateMixin {
  late final _BlobShape _shape = _BlobShape.fromSeed(widget.seed);
  AnimationController? _wobble;
  AnimationController? _blink;
  AnimationController? _poke;
  math.Random? _rng;
  Timer? _blinkTimer;
  Timer? _settleTimer;

  /// 鼠标是不是停在它身上（只有这时候才订阅全局指针）
  bool _following = false;

  /// 视线偏移（像素，已经收敛过）。
  /// 用 ValueNotifier 而不是 setState：鼠标一动就重建整个 widget 太浪费，
  /// 这里只让 CustomPaint 重绘。
  final ValueNotifier<Offset> _gaze = ValueNotifier(Offset.zero);

  bool _awake = false;

  bool get _alive => widget.animate && BlobAvatar.animationsEnabled;

  @override
  void initState() {
    super.initState();
    // ★ 眼神跟随改成了**悬停才订阅**（见 _onEnter/_onExit）。
    //   以前是每个头像都订阅全局指针 —— 侧边栏一列十几个，鼠标一动它们全部
    //   重绘，快速划过时会明显发卡（用户报的）。
    //   现在同一时刻最多只有一个头像在跟随，成本几乎为零。
    if (!_alive) return;

    _rng = math.Random(widget.seed.hashCode);
    _wobble = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 11),
    );
    _blink = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 190),
    );
    _poke = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 380),
    );
    _wake();
  }

  /// 醒过来：开始扭动 + 重新排眨眼，并定个"再没动静就睡"的闹钟。
  ///
  /// 睡着的头像不动也不重绘 —— 一屏十几个头像全在动的话，光栅线程是一直满载的。
  void _wake() {
    if (!mounted || !_alive) return;
    if (!_awake) {
      _awake = true;
      _wobble?.repeat();
      _scheduleBlink();
    }
    _settleTimer?.cancel();
    // 干活中的不睡：它本来就该显得"在动"
    if (widget.mood == AvatarMood.busy) return;
    _settleTimer = Timer(AvatarLife.settleAfter, _sleep);
  }

  void _sleep() {
    if (!mounted) return;
    _wobble?.stop();
    _blinkTimer?.cancel();
    _blink?.value = 0;
    _awake = false;
  }

  void _scheduleBlink() {
    _blinkTimer?.cancel();
    if (!mounted || _blink == null) return;
    final delay = Duration(milliseconds: 2600 + (_rng?.nextInt(4200) ?? 2000));
    _blinkTimer = Timer(delay, () async {
      if (!mounted || _blink == null) return;
      await _blink!.forward(from: 0);
      if (!mounted) return;
      await _blink!.reverse();
      if (mounted) _scheduleBlink();
    });
  }

  /// 眼睛跟着鼠标：越近越明显，远了就基本回正 ——
  /// 做成"眼睛黏在鼠标上"反而诡异。
  void _followPointer() {
    final p = AvatarLife.pointer.value;
    if (!mounted || !BlobAvatar.animationsEnabled || p == null) return;
    final box = context.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return;
    final next = eyeOffsetToward(
      avatarCenter: box.localToGlobal(box.size.center(Offset.zero)),
      pointer: p,
      size: widget.size,
    );
    if ((next - _gaze.value).distance < 0.2) return;
    _gaze.value = next;
    _wake();
  }

  /// 鼠标进来（或外面说"这一行被悬停了"）才开始跟随
  void _onEnter(PointerEnterEvent _) => _startFollow();

  /// 鼠标离开：停掉跟随，视线回正（否则它会一直斜着眼看别处）
  void _onExit(PointerExitEvent _) => _stopFollow();

  void _startFollow() {
    if (_following) return;
    if (!BlobAvatar.animationsEnabled || !widget.followPointer) return;
    AvatarLife.pointer.addListener(_followPointer);
    _following = true;
    // ★ 挂上监听之后**立刻按当前位置算一次**。
    //   不这么做的话：眼睛的偏移只在"鼠标移动"时才更新，而"鼠标进到这一行"
    //   那一下不会触发移动事件 → 必须再动一下才跟随。用户鼠标停在行上不动时
    //   眼睛就是呆的（这是他三次报"只在头像内部跟随"的真正原因：
    //   鼠标在头像里时本来就在动，所以看着反而像"只有头像内部才跟随"）。
    _followPointer();
    _wake(); // 顺便眨个眼/动一下，像注意到你了
  }

  void _stopFollow() {
    if (!_following) return;
    AvatarLife.pointer.removeListener(_followPointer);
    _following = false;
    if (_gaze.value != Offset.zero) _gaze.value = Offset.zero;
  }

  @override
  void didUpdateWidget(BlobAvatar old) {
    super.didUpdateWidget(old);
    // 行悬停的变化 —— 比头像自己那 46px 大得多（用户要的"进到这一行就跟随"）
    if (widget.hovered != old.hovered) {
      widget.hovered ? _startFollow() : _stopFollow();
    }
  }

  void _onPoke() {
    if (!_alive || _poke == null) return;
    _wake();
    _poke!.forward(from: 0).then((_) => _poke!.reverse());
  }

  @override
  void dispose() {
    // 没注册过也安全（removeListener 对未注册的是 no-op）
    AvatarLife.pointer.removeListener(_followPointer);
    _blinkTimer?.cancel();
    _settleTimer?.cancel();
    _gaze.dispose();
    _wobble?.dispose();
    _blink?.dispose();
    _poke?.dispose();
    super.dispose();
  }

  /// emoji 降级成右上角的小角标。
  ///
  /// 只在够大的头像上画：22~32px（消息行、会话列表）放角标就是一团糊，
  /// 那时候名字就在旁边，不需要它。
  Widget? _emojiBadge() {
    final e = widget.emoji;
    // ★ 只有主控（ring=true，也就是总经理）才挂角标。
    //   以前每个 bot 都挂一个（📄⚙️💻🧪…），一列看下去全是小图标碎片，
    //   反而把"谁是主控"这个真正重要的信息淹了。
    if (!widget.ring) return null;
    if (e == null || e.trim().isEmpty || widget.size < 40) return null;
    return Text(e, style: TextStyle(fontSize: widget.size * 0.27, height: 1.0));
  }

  @override
  Widget build(BuildContext context) {
    // 调用方自己给的 badge 优先（比如主控的星标）
    final cornerBadge = widget.badge ?? _emojiBadge();
    return MouseRegion(
      // 头像自己的悬停照旧算（鼠标正好压在头像上但外面没报时也不至于失效）
      onEnter: _onEnter,
      onExit: _onExit,
      child: SizedBox(
        width: widget.size,
        height: widget.size,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            if (widget.interactive && _alive)
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapDown: (_) => _onPoke(),
                child: _content(),
              )
            else
              _content(),
            if (cornerBadge != null)
              Positioned(
                right: -3,
                bottom: -3,
                child: Container(
                  padding: const EdgeInsets.all(2),
                  decoration: BoxDecoration(
                    color: Theme.of(context).scaffoldBackgroundColor,
                    shape: BoxShape.circle,
                  ),
                  child: cornerBadge,
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _content() {
    // 干活中的视线略微上抬（"在想"）；其余时间跟着鼠标
    final busyLift = widget.mood == AvatarMood.busy
        ? Offset(0, -widget.size * 0.045)
        : Offset.zero;

    Widget paint(double phase, double blink, double poke, Offset gaze) =>
        CustomPaint(
          size: Size.square(widget.size),
          painter: _BlobPainter(
            shape: _shape,
            color: widget.color,
            phase: phase,
            blink: blink,
            poke: poke,
            gaze: gaze + busyLift,
            ring: widget.ring,
          ),
        );

    if (!_alive || _wobble == null) {
      // 不呼吸的头像也要跟着鼠标看 —— 所以这里得订阅 _gaze，
      // 否则 _gaze 变了也不会重绘（侧边栏那种就是这条路）。
      return RepaintBoundary(
        child: ValueListenableBuilder<Offset>(
          valueListenable: _gaze,
          builder: (context, gaze, _) => paint(0, 0, 0, gaze),
        ),
      );
    }

    return RepaintBoundary(
      child: AnimatedBuilder(
        // 视线也并进来：鼠标一动只有这里重绘，不重建 widget
        animation: Listenable.merge([_wobble!, _blink!, _poke!, _gaze]),
        builder: (context, _) => paint(
          _wobble!.value * 2 * math.pi,
          _blink!.value,
          _poke!.value,
          _gaze.value,
        ),
      ),
    );
  }
}

class _Harmonic {
  const _Harmonic(this.freq, this.amp, this.phase, this.speed);
  final int freq;
  final double amp;
  final double phase;
  final double speed;
}

/// 头像轮廓的四种形状。
///
/// **每只 bot 的形状不一样**（有的圆胖、有的圆角方、有的六边形、
/// 有的胶囊）。以前全项目只有一种"有机 blob"，一屏十几个头像看过去像同一块橡皮泥
/// 捏出来的 —— 只靠换颜色区分，越看越廉价。
enum _ShapeKind {
  /// 正圆 —— 最中性，但单独用会显得偷懒，所以权重给得低
  circle,

  /// 超椭圆（iOS 图标那种圆角方）
  squircle,

  /// 圆角方再圆一档（介于圆和 squircle 之间）
  cushion,

  /// 正六边形（圆角）
  hexagon,

  /// 胶囊（横向）
  pill,

  /// 蛋形（下宽上窄，左右对称）
  egg,

  /// 菱形（圆角）
  diamond,

  /// 拱形（上圆下平）
  arch,

  /// 水滴（上尖下圆）
  drop,

  /// 有机 blob —— 留着这一个"活的"（会缓慢扭动），但幅度收得很小，
  /// 只是"没那么死板"，不是歪瓜裂枣
  blob,
}

/// 由 id 决定的形状参数：形状种类 + 三阶谐波 + 眼睛位置 + 倾角
class _BlobShape {
  _BlobShape(
    this.kind,
    this.harmonics,
    this.eyeY,
    this.eyeGap,
    this.eyeTilt,
    this.tilt,
  );

  final _ShapeKind kind;
  final List<_Harmonic> harmonics;
  final double eyeY;
  final double eyeGap;
  final double eyeTilt;

  /// 非 blob 形状整体转一点角度，免得看着像对齐的网格
  final double tilt;

  factory _BlobShape.fromSeed(String seed) {
    final rng = math.Random(seed.hashCode & 0x7fffffff);
    double range(double a, double b) => a + rng.nextDouble() * (b - a);
    // ★ 形状从固定集合里挑，**不再用随机谐波生成轮廓**。
    //   以前每个 bot 的轮廓是三阶正弦叠加算出来的 —— 每个都不一样，但每个
    //   都"歪七扭八"：看不出是什么形状，也就没有辨识度（用户报的）。
    //   现在十种规整对称的形状按权重分：圆的权重最低（太普通），
    //   有性格的（蛋形/菱形/拱形/水滴/胶囊）权重高一些。
    const weighted = <_ShapeKind>[
      _ShapeKind.circle,
      _ShapeKind.squircle,
      _ShapeKind.squircle,
      _ShapeKind.cushion,
      _ShapeKind.cushion,
      _ShapeKind.hexagon,
      _ShapeKind.hexagon,
      _ShapeKind.pill,
      _ShapeKind.pill,
      _ShapeKind.egg,
      _ShapeKind.egg,
      _ShapeKind.diamond,
      _ShapeKind.arch,
      _ShapeKind.drop,
      _ShapeKind.blob,
    ];
    final kind = weighted[rng.nextInt(weighted.length)];
    return _BlobShape(
      kind,
      // 只有 blob 用这几个谐波（幅度都收小了：最多 ±4%，只是"不那么死板"）
      [
        _Harmonic(
          2,
          range(0.015, 0.035),
          rng.nextDouble() * 6.28,
          range(0.5, 1.0),
        ),
        _Harmonic(
          3,
          range(0.01, 0.025),
          rng.nextDouble() * 6.28,
          range(-0.9, -0.4),
        ),
      ],
      range(0.41, 0.48),
      // ★ 眼睛间距比之前收一点（0.19~0.235 → 0.175~0.21）：
      //   形状改成规整的之后，水滴/拱形这类在眼睛那一行比较窄，
      //   原来的间距会让眼睛压到边缘。
      range(0.175, 0.21),
      range(-0.16, 0.16),
      range(-0.22, 0.22),
    );
  }
}

class _BlobPainter extends CustomPainter {
  _BlobPainter({
    required this.shape,
    required this.color,
    required this.phase,
    required this.blink,
    required this.poke,
    required this.gaze,
    this.ring = false,
  });

  final _BlobShape shape;
  final Color color;
  final double phase;
  final double blink;

  /// 0→1→0：被戳一下的挤压量
  final double poke;

  /// 眼睛的偏移（像素）
  final Offset gaze;
  final bool ring;

  /// 按形状种类采样轮廓点（绕中心一圈，角度递增）。
  ///
  /// 全部**几何定义、左右对称**，没有随机扭曲 —— 随机谐波出来的轮廓
  /// 每个都"不一样但都不像什么"，看着乱、也没有辨识度。
  /// 只有 blob 那一种用 phase（唯一会动的），其余都是静态的：静止才像"印章"。
  List<Offset> _outline(Offset center, double baseRadius) {
    final r = baseRadius;
    switch (shape.kind) {
      case _ShapeKind.circle:
        return _superellipse(center, r, r, 2.0);

      case _ShapeKind.squircle:
        return _superellipse(center, r, r, 4.2);

      case _ShapeKind.cushion:
        return _superellipse(center, r, r, 3.0);

      case _ShapeKind.pill:
        // 宽一点、扁一点 + 比 squircle 圆得多 → 一眼就是颗胶囊
        return _superellipse(center, r * 1.12, r * 0.84, 2.8);

      case _ShapeKind.hexagon:
        // 平顶正六边形（旋转 90°，视觉上比尖顶更稳）；平滑那步会把角磨圆
        return _rotate([
          for (var i = 0; i < 6; i++)
            () {
              final t = i / 6 * 2 * math.pi;
              return Offset(math.sin(t) * r, -math.cos(t) * r);
            }(),
        ], center);

      case _ShapeKind.diamond:
        // 四点朝上下左右；平滑之后是个圆角菱形
        return [
          for (var i = 0; i < 4; i++)
            () {
              final t = i / 4 * 2 * math.pi;
              return center + Offset(math.cos(t) * r, math.sin(t) * r);
            }(),
        ];

      case _ShapeKind.egg:
        // 蛋形：左右对称，下半比上半宽 —— 靠"同一个 y 上 x 的缩放"做出来，
        // 不用谐波（谐波会带来上下左右都不对称的抖动）
        const steps = 48;
        return [
          for (var i = 0; i < steps; i++)
            () {
              final t = i / steps * 2 * math.pi;
              final x = math.cos(t);
              final y = math.sin(t);
              // y > 0（下半）横向放大，y < 0（上半）横向收窄
              final wide = 1 + 0.10 * y;
              return center + Offset(x * r * wide, y * r);
            }(),
        ];

      case _ShapeKind.arch:
        // 拱形：上半圆 + 下半直边 + 平底
        const steps = 48;
        return [
          for (var i = 0; i < steps; i++)
            () {
              final t = i / steps * 2 * math.pi;
              final x = math.cos(t);
              final y = math.sin(t);
              if (y <= 0) return center + Offset(x * r, y * r);
              // 下半：竖直下来，底部保持平的（稍微收一点角）
              final k = y / 0.60;
              return center +
                  Offset(x * r * math.max(0.0, 1 - k * 0.06), r * 0.72);
            }(),
        ];

      case _ShapeKind.drop:
        // 水滴：下半圆 + 上半收成尖（顶点在上）
        const steps = 48;
        return [
          for (var i = 0; i < steps; i++)
            () {
              final t = i / steps * 2 * math.pi;
              final x = math.cos(t);
              final y = math.sin(t);
              // 上尖下圆：y<0 时横向收窄得越来越厉害
              // 上尖下圆。收得太狠眼睛会跑到形状外面，0.55 是试出来的上限
              final taper = y < 0 ? (1 + y * 0.55) : 1.0;
              return center + Offset(x * r * taper, y * r * 1.06);
            }(),
        ];

      case _ShapeKind.blob:
        // 唯一保留的一点"有机感"：谐波幅度已经收得很小（±4%），
        // 看着是"没那么死板的圆"，不是歪瓜裂枣
        const steps = 40;
        return [
          for (var i = 0; i < steps; i++)
            () {
              final theta = i / steps * 2 * math.pi;
              var rr = 1.0;
              for (final h in shape.harmonics) {
                rr +=
                    h.amp *
                    math.sin(h.freq * theta + h.phase + phase * h.speed);
              }
              return center +
                  Offset(math.cos(theta) * r * rr, math.sin(theta) * r * rr);
            }(),
        ];
    }
  }

  /// 超椭圆 |x/a|^n + |y/b|^n = 1 —— n=2 是椭圆，n=4 出头就是 iOS 那种圆角方
  List<Offset> _superellipse(Offset center, double a, double b, double n) {
    const steps = 44;
    final pts = <Offset>[];
    for (var i = 0; i < steps; i++) {
      final t = i / steps * 2 * math.pi;
      final ct = math.cos(t);
      final st = math.sin(t);
      pts.add(
        Offset(
          ct.sign * math.pow(ct.abs(), 2 / n) * a,
          st.sign * math.pow(st.abs(), 2 / n) * b,
        ),
      );
    }
    return _rotate(pts, center);
  }

  /// 按 shape.tilt 转一点角度再平移到中心
  List<Offset> _rotate(List<Offset> pts, Offset center) {
    final c = math.cos(shape.tilt);
    final s = math.sin(shape.tilt);
    return [
      for (final p in pts)
        center + Offset(p.dx * c - p.dy * s, p.dx * s + p.dy * c),
    ];
  }

  /// 采样轮廓点，再用二次贝塞尔穿过中点 —— 比直接 lineTo 顺得多
  /// ★ steps 从 48 降到 32：动画时每帧都要重算整条路径，48 段在列表里是纯浪费，
  ///   32 段在 44px 的尺寸下肉眼看不出区别。
  Path _blobPath(Offset center, double baseRadius) {
    final points = _outline(center, baseRadius);
    final steps = points.length;

    final path = Path();
    Offset mid(Offset a, Offset b) =>
        Offset((a.dx + b.dx) / 2, (a.dy + b.dy) / 2);
    path.moveTo(
      mid(points[steps - 1], points[0]).dx,
      mid(points[steps - 1], points[0]).dy,
    );
    for (var i = 0; i < steps; i++) {
      final p = points[i];
      final next = points[(i + 1) % steps];
      final m = mid(p, next);
      path.quadraticBezierTo(p.dx, p.dy, m.dx, m.dy);
    }
    path.close();
    return path;
  }

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final baseRadius = size.shortestSide / 2 * 0.9;

    // 被戳的那一下：横向撑开、纵向压扁，然后弹回去。
    // 整块一起变形（身体 + 眼睛），否则眼睛会"浮"在压扁的身体外面。
    canvas.save();
    if (poke > 0.01) {
      final s = 1 + poke * 0.10;
      canvas.translate(center.dx, center.dy);
      canvas.scale(s, 1 / s);
      canvas.translate(-center.dx, -center.dy);
    }

    final path = _blobPath(center, baseRadius);

    // 1) 主体：左上到右下的渐变
    //
    // ★ 这里以前还叠了「径向渐变落影 + 径向高光 + 渐变描边」，加上主体一共
    //   4 个 shader —— 每个头像每帧 4 次 createShader + 4 层抗锯齿填充。
    //   一屏十几个头像（群头像还是 2~4 个叠一起）全在吃光栅时间，而实测帧采样里
    //   raster 一直是瓶颈。这类头像本来就该是**接近平涂**的饱和色块，
    //   没有落影也没有高光 —— 砍掉之后既更像它，也更省。
    canvas.drawPath(
      path,
      Paint()
        ..shader =
            LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              // ★ 以前是 white 0.30 → 黑 0.26，再叠一层 white 0.26 高光 +
              //   white 0.30 描边 —— 四层白下来，调色板里的饱和色全被洗成粉彩，
              //   一屏头像看着发灰。这里只留一点体积感。
              // 立体感就靠这一条渐变（**只开这一个 shader**）：
              // 左上提亮一点点、右下压深一点点 —— 看着有体积，但整体仍然是
              // "一块纯色"。四层 shader 那版是 2 倍光栅开销，这个只有 1/4。
              colors: [
                Color.lerp(color, Colors.white, 0.18)!,
                color,
                Color.lerp(color, Colors.black, 0.22)!,
              ],
              stops: const [0.0, 0.52, 1.0],
            ).createShader(
              Rect.fromCircle(center: center, radius: baseRadius * 1.2),
            ),
    );

    // 2) 边缘反光（很细的一圈，出立体感）—— 纯色描边，不再开渐变 shader
    canvas.drawPath(
      path,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = math.max(1, size.shortestSide * 0.022)
        ..color = Colors.white.withValues(alpha: 0.22),
    );

    if (ring) {
      canvas.drawPath(
        path,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = math.max(1.2, size.shortestSide * 0.035)
          ..color = Colors.white.withValues(alpha: 0.85),
      );
    }

    // ★ 这里以前是「有 emoji 就画 emoji，不画眼睛」。
    //   结果是每个 bot 都是「一块饱和色 + 一张全彩 emoji 贴纸」——
    //   emoji 自带的白/橙/紫和 blob 的颜色互相打架，像贴歪了的贴纸。
    //   纯色块 + 两只眼睛干净得多；emoji 降级成小角标。
    //
    // 眼睛：两个圆角竖条，眨眼时压扁。
    // 侧看的时候再横向压扁一点（真实的脸转过去时眼白就是变窄的）——
    // 这一下比单纯平移更能让人感觉到"它在看着你"。
    final side = (gaze.dx / (size.shortestSide * 0.16)).clamp(-1.0, 1.0);
    final eyeW = size.shortestSide * 0.112 * (1 - 0.22 * side.abs());
    final eyeH = size.shortestSide * 0.195 * (1 - blink * 0.84);
    final eyePaint = Paint()
      ..color = Color.lerp(color, Colors.black, 0.84)!.withValues(alpha: 0.95);
    for (final side in [-1.0, 1.0]) {
      final cx = center.dx + side * size.shortestSide * shape.eyeGap + gaze.dx;
      final cy = center.dy + size.shortestSide * (shape.eyeY - 0.5) + gaze.dy;
      canvas.save();
      canvas.translate(cx, cy);
      canvas.rotate(side * shape.eyeTilt);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromCenter(center: Offset.zero, width: eyeW, height: eyeH),
          Radius.circular(eyeW / 2),
        ),
        eyePaint,
      );
      canvas.restore();
    }

    canvas.restore();
  }

  @override
  bool shouldRepaint(_BlobPainter old) =>
      old.phase != phase ||
      old.blink != blink ||
      old.color != color ||
      old.shape != shape ||
      old.poke != poke ||
      old.gaze != gaze;
}

/// 群头像：2-4 个小 blob 叠在一起
class GroupBlobAvatar extends StatelessWidget {
  const GroupBlobAvatar({
    super.key,
    required this.seeds,
    required this.size,
    this.animate = true,
  });

  final List<String> seeds;
  final double size;
  final bool animate;

  @override
  Widget build(BuildContext context) {
    final shown = seeds.take(4).toList();
    if (shown.isEmpty) shown.add('pi');
    final inner = size * (shown.length == 1 ? 1.0 : 0.64);
    const layout = <Offset>[
      Offset(-0.17, -0.17),
      Offset(0.18, -0.13),
      Offset(-0.13, 0.19),
      Offset(0.20, 0.20),
    ];
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          for (var i = 0; i < shown.length; i++)
            Positioned(
              left: size / 2 + layout[i].dx * size - inner / 2,
              top: size / 2 + layout[i].dy * size - inner / 2,
              child: BlobAvatar(
                followPointer: false,
                seed: shown[i],
                color: PB.colorFor(shown[i]),
                size: inner,
                animate: animate,
              ),
            ),
        ],
      ),
    );
  }
}
