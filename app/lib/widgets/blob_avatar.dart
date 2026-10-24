import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/scheduler.dart';
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

  /// 外面告诉本组件"鼠标停在**这一行**上"（不只是头像那 46px 的框）。
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

  /// 给测试用：某个 seed 分到的形状种类名。
  ///
  /// 形状"一眼能认出"这件事没法靠肉眼评审，但可以钉住**多样性**：
  /// 一屏十几个头像如果全是圆，就退回成"只靠颜色区分"了。
  /// 这个入口让测试能断言"形状种类足够杂"，而不必去截图比像素。
  @visibleForTesting
  static String shapeKindOf(String seed) => _BlobShape.fromSeed(seed).kind.name;

  @override
  State<BlobAvatar> createState() => _BlobAvatarState();
}

/// 让**一整片区域**里的头像都跟着鼠标看。
///
/// 每个头像负责的是"**自己所在的那块区域**"，而不是自己那 46 像素：
///   · 会话行   → 整个会话行（含名字、预览文字、时间）
///   · 聊天头部 → 整个胶囊
///   · 成员列表 → 整个成员行
///   · 消息     → 整条消息（含气泡）
///
/// 头像在自己负责的范围内跟随鼠标：例如胶囊内的 bot 头像，
/// 当鼠标挪动到胶囊内时跟随。
///
/// 用法：把这块区域包起来就行，里面的 BlobAvatar 不用各自声明 hovered。
/// forceHovered 是给"按下也算"这类外部状态用的（会话行按住要持续跟随）。
class AvatarHoverScope extends StatefulWidget {
  const AvatarHoverScope({
    super.key,
    required this.child,
    this.forceHovered = false,
  });

  final Widget child;

  /// 外部强制的悬停（比如"按住了"）—— 和鼠标悬停取或
  final bool forceHovered;

  @override
  State<AvatarHoverScope> createState() => _AvatarHoverScopeState();
}

class _AvatarHoverScopeState extends State<AvatarHoverScope> {
  bool _hovered = false;

  void _set(bool v) {
    if (v == _hovered || !mounted) return;
    setState(() => _hovered = v);
  }

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      // opaque:false —— 只关心"鼠标在不在这片区域里"，不挡下面的命中测试
      opaque: false,
      onEnter: (_) => _set(true),
      onExit: (_) => _set(false),
      child: _AvatarHover(
        hovered: _hovered || widget.forceHovered,
        child: widget.child,
      ),
    );
  }
}

/// 容器**自己已经在跟踪悬停**时用它广播给里面的头像（省一层 MouseRegion）。
/// 例：胶囊 (_HoverLift) 本来就有 _hover 状态。
class AvatarHoverBroadcast extends StatelessWidget {
  const AvatarHoverBroadcast({
    super.key,
    required this.hovered,
    required this.child,
  });

  final bool hovered;
  final Widget child;

  @override
  Widget build(BuildContext context) =>
      _AvatarHover(hovered: hovered, child: child);
}

class _AvatarHover extends InheritedWidget {
  const _AvatarHover({required this.hovered, required super.child});

  final bool hovered;

  @override
  bool updateShouldNotify(_AvatarHover old) => hovered != old.hovered;
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

  /// 上一次"被悬停"的状态（显式 或 区域）—— 用来判断要不要开/停跟随
  bool _followHovered = false;

  /// 视线偏移（像素，已经收敛过）。
  /// 用 ValueNotifier 而不是 setState：鼠标一动就重建整个 widget 太浪费，
  /// 这里只让 CustomPaint 重绘。
  final ValueNotifier<Offset> _gaze = ValueNotifier(Offset.zero);

  /// 视线**要去的**位置。和 _gaze（当前显示的位置）分开：
  /// 两者之间靠 [_gazeTicker] 逐帧插值，眼睛才是“看过去”而不是“瞬移”。
  Offset _gazeTarget = Offset.zero;

  /// 驱动视线缓动的 ticker。只在“还没到站”的时候转 ——
  /// 静止时停掉，不烧光栅。
  Ticker? _gazeTicker;
  Duration _lastGazeTick = Duration.zero;

  /// 没被盯着的时候，自己在动的小动作。
  Timer? _ambientTimer;

  bool _awake = false;

  bool get _alive => widget.animate && BlobAvatar.animationsEnabled;

  /// 要不要能发出“自发小动作”：
  ///   · 干活中的头像**总是**要 —— 它就该显得在做事，与 animate 无关
  ///     （侧边栏的房间行是 animate:false，但那里恰恰最需要露出工作状态）
  ///   · 其它的只在“醒着”时才有（聊天头部那颗）；侧边栏那些静止的
  ///     就保持静止 —— 一屏几十个一起动，光栅线程直接满载
  bool get _ambientAllowed =>
      BlobAvatar.animationsEnabled &&
      (widget.mood == AvatarMood.busy || (_alive && _awake));

  @override
  void initState() {
    super.initState();
    // ★ 眼神跟随是**悬停才订阅**（见 _onEnter/_onExit）。
    //   不能每个头像都订阅全局指针：侧边栏一列十几个，鼠标一动它们全部
    //   重绘，快速划过时会明显发卡。
    //   同一时刻最多只有一个头像在跟随，成本几乎为零。

    // ★ _rng 不能放在下面的 _alive 判断之后。
    //   animate:false 的头像（侧边栏那一列）不需要呼吸/眨眼，但**仍需**
    //   自己有随机源：干活中的头像靠它做自发小动作（见 _doAmbient）。
    //   以前这两件事被同一个 return 绑在一起，结果就是
    //   “侧边栏里的头像永远看不出谁在干活”。
    _rng = math.Random(widget.seed.hashCode);

    if (!_alive) {
      // 不呼吸的头像：直接排一下自发小动作（干活中的才有，见 _ambientAllowed）
      _syncAmbient();
      return;
    }

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
    _syncAmbient();
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
    _syncAmbient();
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
    // ★ pointer 是 null 时**不能就return 了事**：
    //   指针位置是由全局 watchPointer 写的，而“鼠标移进来停住”只有
    //   进入那一瞬间的 onEnter（见 AvatarLife.watchPointer）。
    //   _startFollow 里已经挂上了 pointer 监听，所以下一次指针变动
    //   会再调到这里 —— 但前提是 hover 本身不能因为拿不到坐标就失效。
    //   所以下面每次都按**当前**坐标重算，不做“已跟过就不再算”。
    final box = context.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return;
    _aimGaze(
      eyeOffsetToward(
        avatarCenter: box.localToGlobal(box.size.center(Offset.zero)),
        pointer: p,
        size: widget.size,
      ),
    );
    _wake();
  }

  /// 定下视线目标，交给缓动去追。
  ///
  /// ★ 以前是直接把新值塞给 _gaze —— 鼠标一动眼睛就"瞬移"一帧，
  ///   离开跟随区时又是硬回 Offset.zero。看起来就是"啪"地跳一下。
  ///   真实的眼睛有个转动过程，哪怕只有 100ms，感觉也完全不同。
  void _aimGaze(Offset next) {
    // TEMP-DEBUG
    if ((next - _gazeTarget).distance < 0.2) return;
    _gazeTarget = next;
    _startGazeTicker();
  }

  void _startGazeTicker() {
    if (_gazeTicker?.isActive ?? false) return;
    if (!mounted) return;
    _lastGazeTick = Duration.zero;
    // 用单例 ticker，反复起停（每次鼠标移动都跑一遍）—— 不新建对象。
    // vsync 来自 TickerProviderStateMixin；不能用 SingleTickerProviderStateMixin，
    // 那个只能 createTicker 一次，而 wobble/blink/poke 已经占着这个混入的可复用处。
    (_gazeTicker ??= createTicker(_onGazeTick)).start();
  }

  /// 逐帧把当前视线往目标推。
  void _onGazeTick(Duration elapsed) {
    final dt = _lastGazeTick == Duration.zero
        ? 1 / 60
        : (elapsed - _lastGazeTick).inMicroseconds / 1e6;
    _lastGazeTick = elapsed;
    if (!mounted) return;
    final step = advanceGaze(
      current: _gaze.value,
      target: _gazeTarget,
      dtSeconds: dt,
      rate: AvatarLife.gazeFollowRate,
    );
    _gaze.value = step.value;

    if (step.arrived) {
      // 到站：停 ticker。不停的话每帧都在重绘一个静止的头像。
      _gazeTicker?.stop();
      _gazeTicker = null;
    }
  }

  /// 鼠标进到头像自己这几十像素里
  void _onEnter(PointerEnterEvent _) {
    _selfHovered = true;
    _syncFollow();
  }

  /// 鼠标离开头像自己这块
  ///
  /// ★ 这里**不能**直接 `_stopFollow()`，否则：
  ///   "鼠标从头像上移到同一行的文字上"时，头像自己发的 onExit 把跟随停掉，
  ///   而外层区域（会话行 / 胶囊）的悬停状态**没变**、不会再通知一次
  ///   → 跟随就死了，用户看到的就是"只有鼠标在头像里面时才跟随"。
  ///   交给 _syncFollow 统一判断：只要还在自己负责的区域里就继续跟随。
  void _onExit(PointerExitEvent _) {
    _selfHovered = false;
    _syncFollow();
  }

  void _startFollow() {
    if (_following) return;
    if (!BlobAvatar.animationsEnabled || !widget.followPointer) return;
    AvatarLife.pointer.addListener(_followPointer);
    _following = true;
    // ★ 挂上监听之后**立刻按当前位置算一次**。
    //   不这么做的话：眼睛的偏移只在"鼠标移动"时才更新，而"鼠标进到这一行"
    //   那一下不会触发移动事件 → 必须再动一下才跟随。鼠标停在行上不动时
    //   眼睛就是呆的；而且鼠标在头像里时本来就在动，问题会表现成
    //   "只有头像内部才跟随"。
    _followPointer();
    _wake(); // 顺便眨个眼/动一下，像注意到你了
    // ★ 用户开始盯它了，就把“自发小动作”停掉 ——
    //   两边都在写视线目标会互相抢，表现为眼睛抽搽。
    _syncAmbient();
  }

  void _stopFollow() {
    if (!_following) return;
    AvatarLife.pointer.removeListener(_followPointer);
    _following = false;
    // ★ 视线回正也走缓动（_aimGaze(Offset.zero)），不直接置零。
    //   鼠标离开时眼睛"慢慢看回正前方"，而不是啪一下弹回去。
    _aimGaze(Offset.zero);
    // 回到自己的小动作（鼠标在时小动作会暂停，避免和跟随抢眼睛）
    _syncAmbient();
  }

  /// 本头像所在的这块区域（会话行 / 胶囊 / 成员行…）有没有被悬停。
  /// 缓存在字段里：didUpdateWidget 里不能调 dependOnInheritedWidgetOfExactType。
  bool _scopeHovered = false;

  /// 鼠标在不在头像自己这几十像素里（头像自己的 MouseRegion 报的）
  bool _selfHovered = false;

  /// 本头像"被悬停"了吗 —— **三个来源取或**：
  ///   ① 外面显式传的（会话行：整行 hover / 按住）
  ///   ② 本头像所在的这块区域（AvatarHoverScope：胶囊、消息、成员行…）
  ///   ③ 头像自己这几十像素
  bool _hoveredNow() => widget.hovered || _scopeHovered || _selfHovered;

  /// 悬停状态变了就开/停跟随（显式参数变化和区域变化都走这里）
  void _syncFollow() {
    final h = _hoveredNow();
    if (h == _followHovered) return;
    _followHovered = h;
    if (h) {
      _startFollow();
    } else {
      _stopFollow();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // 依赖的 AvatarHoverScope 变化会走到这里
    _scopeHovered =
        context.dependOnInheritedWidgetOfExactType<_AvatarHover>()?.hovered ??
        false;
    _syncFollow();
  }

  @override
  void didUpdateWidget(BlobAvatar old) {
    super.didUpdateWidget(old);
    // 显式 hovered 的变化（区域悬停的变化走 didChangeDependencies）
    if (widget.hovered != old.hovered) _syncFollow();
    // ★ 忙/闲切换要重排小动作：干活中动得秘，而且侧边栏那行是 animate:false，
    //   开工/停工发生时不会走 _wake，不在这里接一下，状态就永远变不了。
    if (widget.mood != old.mood) {
      _syncAmbient();
      if (widget.mood == AvatarMood.busy) _wake();
    }
  }

  void _onPoke() {
    if (!_alive || _poke == null) return;
    _wake();
    _poke!.forward(from: 0).then((_) => _poke!.reverse());
  }

  // ---- 自发小动作（鼠标没盯着它的时候）

  /// 排下一次小动作。
  ///
  /// "活"不等于一直在动：真正让人觉得活的是**偶尔**有点小动作，
  /// 而且这个动作要能表达它的状态。所以这里按 mood 分两套：
  ///   · 干活中 → 视线往侧面扫一下又回来（像在看另一块面板 / 在查资料）
  ///   · 闲着   → 眼睛歪一下又回来（东张西望）
  /// 不引入新的绘制状态，只改视线的目标 —— 代价最低，效果已够。
  void _syncAmbient() {
    _ambientTimer?.cancel();
    _ambientTimer = null;
    if (!_ambientAllowed) return;
    _scheduleAmbient();
  }

  void _scheduleAmbient() {
    if (!mounted || !_ambientAllowed) return;
    // 现在正被盯着看 —— 不要抢眼睛（用户要看的是"它在看我"）
    if (_following) return;
    final rng = _rng;
    if (rng == null) return;
    // 干活中的动得秘一些（它正在忙），闲着的懒一些
    final base = widget.mood == AvatarMood.busy ? 1400 : 2600;
    final jitter = rng.nextInt(widget.mood == AvatarMood.busy ? 1600 : 4200);
    _ambientTimer = Timer(Duration(milliseconds: base + jitter), _doAmbient);
  }

  void _doAmbient() {
    if (!mounted || !_ambientAllowed || _following) return;
    final rng = _rng;
    if (rng == null) return;

    // 上限和 eyeOffsetToward 一致（0.16*size）：再大窄形状会把眼睛顶到轮廓上
    final reach = widget.size * 0.16;
    final Offset target;
    if (widget.mood == AvatarMood.busy) {
      // 干活中：往两侧扫（“在看别的面板”），幅度大一点
      final dir = rng.nextBool() ? 1.0 : -1.0;
      target = Offset(dir * reach * 0.85, -reach * 0.35);
    } else {
      // 闲着：小幅度东张西望 + 一点点上下
      target = Offset(
        (rng.nextDouble() * 2 - 1) * reach * 0.55,
        (rng.nextDouble() * 2 - 1) * reach * 0.3,
      );
    }
    _aimGaze(target);
    // 看一眼再回来，然后排下一次
    final holdMs = widget.mood == AvatarMood.busy ? 900 : 1200;
    _ambientTimer = Timer(Duration(milliseconds: holdMs), () {
      if (!mounted || !_ambientAllowed || _following) return;
      _aimGaze(Offset.zero);
      _scheduleAmbient();
    });
  }

  @override
  void dispose() {
    // 没注册过也安全（removeListener 对未注册的是 no-op）
    AvatarLife.pointer.removeListener(_followPointer);
    _blinkTimer?.cancel();
    _settleTimer?.cancel();
    _ambientTimer?.cancel();
    _gazeTicker?.dispose();
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
    //   不能每个 bot 都挂一个（📄⚙️💻🧪…）：一列看下去全是小图标碎片，
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
/// 有的胶囊）。不能全项目只用一种"有机 blob"：一屏十几个头像会像同一块橡皮泥
/// 捏出来的，只靠换颜色区分，越看越廉价。
enum _ShapeKind {
  /// 豆形：一头圆一头略收，横放 —— 最"活物"的一个
  bean,

  /// 卵石：接近圆但四边都不规则，下沉一点（坐着的石头）
  pebble,

  /// 超椭圆（iOS 图标那种圆角方），偶尔用
  squircle,

  /// 圆角六边形
  hexagon,

  /// 胶囊（横向）
  pill,

  /// 蛋形（下宽上窄）
  egg,

  /// 三角（圆角、歪一点）—— 最有"角色感"的形状
  tri,

  /// 水滴（上尖下圆）
  tear,

  /// 有机 blob —— 会缓慢扭动
  blob,
}

/// 由 id 决定的形状参数：形状种类 + 谐波 + 眼睛位置 + 倾角 + 歪斜量
class _BlobShape {
  _BlobShape(
    this.kind,
    this.harmonics,
    this.eyeY,
    this.eyeGap,
    this.eyeTilt,
    this.tilt, {
    this.skew = 0,
    this.flatten = 0,
    this.cornerPull = 0,
  });

  final _ShapeKind kind;
  final List<_Harmonic> harmonics;
  final double eyeY;
  final double eyeGap;
  final double eyeTilt;

  /// 非 blob 形状整体转一点角度，免得看着像对齐的网格
  final double tilt;

  /// 横向歪斜：下半往一边偏、上半往另一边偏。
  ///
  /// ★ 这一项是"手绘感"和"图章感"的分水岭。纯数学的圆/超椭圆左右完全
  ///   镜像，一屏十几个排下来就是一枚枚印章；而人画出来的豆子、石头、
  ///   云朵，四边都是不对称的。加一点歪斜（3~8%），它立刻"不是几何图"了。
  final double skew;

  /// 竖向压扁：让某些形状更"趴"一点（坐下、靠着的姿态）
  final double flatten;

  /// 角部拉扯：把 3~4 个角往不同方向拉，做出不等边的轮廓
  final double cornerPull;

  factory _BlobShape.fromSeed(String seed) {
    final rng = math.Random(seed.hashCode & 0x7fffffff);
    double range(double a, double b) => a + rng.nextDouble() * (b - a);
    const weighted = <_ShapeKind>[
      _ShapeKind.bean,
      _ShapeKind.bean,
      _ShapeKind.pebble,
      _ShapeKind.pebble,
      _ShapeKind.egg,
      _ShapeKind.egg,
      _ShapeKind.pill,
      _ShapeKind.pill,
      _ShapeKind.hexagon,
      _ShapeKind.tri,
      _ShapeKind.tri,
      _ShapeKind.tear,
      _ShapeKind.squircle,
      _ShapeKind.blob,
      _ShapeKind.blob,
    ];
    final kind = weighted[rng.nextInt(weighted.length)];
    return _BlobShape(
      kind,
      [
        _Harmonic(
          2,
          range(0.02, 0.05),
          rng.nextDouble() * 6.28,
          range(0.5, 1.0),
        ),
        _Harmonic(
          3,
          range(0.015, 0.035),
          rng.nextDouble() * 6.28,
          range(-0.9, -0.4),
        ),
      ],
      // 眼睛位置：尖头形状（三角/水滴）靠上会顶到轮廓，所以整体略降
      // 三角最麻烦：上窄下宽，眼睛既不能太高（顶到尖）也不能太靠两侧
      // （侧边是斜的）。0.56~0.60 是量出来的：再高眼睛出轮廓，
      // 再低就贴到底边。
      kind == _ShapeKind.tri
          ? range(0.56, 0.60)
          : (kind == _ShapeKind.tear ? range(0.52, 0.57) : range(0.41, 0.48)),
      // 眼睛间距收窄（0.16~0.19）：窄形状上间距过大会压到边缘。
      kind == _ShapeKind.tri
          ? range(0.115, 0.135)
          : (kind == _ShapeKind.tear
                ? range(0.145, 0.17)
                : range(0.175, 0.205)),
      range(-0.16, 0.16),
      range(-0.20, 0.20),
      skew: range(-0.035, 0.035),
      flatten: range(-0.02, 0.03),
      cornerPull: range(-0.05, 0.05),
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
    // 歪斜 / 压扁 / 角部拉扯在这里统一施加 —— 每个形状都会带一点不对称。
    List<Offset> shapePoints(List<Offset> local) {
      // 先整体倾斜（让形状不都朝着正上方），再剪切出歪斜，最后压扁。
      final tc = math.cos(shape.tilt);
      final ts = math.sin(shape.tilt);
      return [
        for (final p in local)
          () {
            final rx = p.dx * tc - p.dy * ts;
            final ry = p.dx * ts + p.dy * tc;
            // 横向歪斜：靠上的部分往一侧偏，靠下的往另一侧偏。
            // 这是一层**剪切**，所以轮廓不会被拉长，只是"歪了"。
            final shear = shape.skew * (ry / r);
            return center + Offset(rx + shear * r, ry * (1 - shape.flatten));
          }(),
      ];
    }

    switch (shape.kind) {
      case _ShapeKind.bean:
        // 豆形：**明显**一头大一头小。之前只用 1+0.14*ct 去鼓，
        // 小尺寸下根本看不出来，还是一颗蛋。这里改成两极不对称：
        // 右半整体放大、左半整体收窄，横竖比也拉开。
        const steps = 56;
        return shapePoints([
          for (var i = 0; i < steps; i++)
            () {
              final t = i / steps * 2 * math.pi;
              final ct = math.cos(t);
              final st = math.sin(t);
              // ct>0 一侧放大到 1.24，ct<0 收到 0.80 —— 视觉上就是
              // "一颗豆子的圆头和尖端"。这比加谐波可靠得多。
              // 右端鼓到 1.34、左端收到 0.72：横竖比接近 1.6，
              // 这才是"豆"，不是"蛋"。
              final side = ct >= 0 ? (1.0 + 0.34 * ct) : (1.0 + 0.28 * ct);
              return Offset(
                ct * r * 1.02 * side,
                st * r * 0.80 * (st < 0 ? 0.94 : 1.0),
              );
            }(),
        ]);

      case _ShapeKind.pebble:
        // 卵石：接近圆，四边略不规则（谐波幅度小 —— 它只负责"不是完美圆"）
        const steps = 48;
        return shapePoints([
          for (var i = 0; i < steps; i++)
            () {
              final theta = i / steps * 2 * math.pi;
              var rr = 1.0;
              for (final h in shape.harmonics) {
                rr += (h.amp * 0.6) * math.sin(h.freq * theta + h.phase);
              }
              return Offset(
                math.cos(theta) * r * rr,
                math.sin(theta) * r * rr * 0.95,
              );
            }(),
        ]);

      case _ShapeKind.squircle:
        return shapePoints(_superellipse(Offset.zero, r * 0.98, r * 0.98, 3.6));

      case _ShapeKind.pill:
        // 宽扁胶囊：横竖比拉开，一眼是"躺着的胶囊"
        return shapePoints(_superellipse(Offset.zero, r * 1.18, r * 0.74, 2.4));

      case _ShapeKind.hexagon:
        // 六边形：∠ 必须看得出来。用 6 个顶点 + 小圆角，
        // 顶边水平（比尖顶更稳）。
        return shapePoints([
          for (var i = 0; i < 6; i++)
            () {
              final t = i / 6 * 2 * math.pi;
              return Offset(math.sin(t) * r * 1.02, -math.cos(t) * r * 0.96);
            }(),
        ]);

      case _ShapeKind.egg:
        // 蛋形：竖向拉长、上窄下宽
        const steps = 48;
        return shapePoints([
          for (var i = 0; i < steps; i++)
            () {
              final t = i / steps * 2 * math.pi;
              final ct = math.cos(t);
              final st = math.sin(t);
              // y>0（下）更宽，y<0（上）更窄 → 蛋
              final wide = 1 + 0.16 * st;
              return Offset(ct * r * 0.90 * wide, st * r * 1.06);
            }(),
        ]);

      case _ShapeKind.tri:
        // 三角：**必须明显是三角**。三个角半径一致、边略外鼓（视觉更饱满，
        // 不是硬邦邦的等边三角形），整体倒过来放（尖朝上）。
        return shapePoints([
          for (var i = 0; i < 3; i++)
            () {
              final t = i / 3 * 2 * math.pi - math.pi / 2;
              // 角上稍微往外顶一点，让边看起来是"鼓"的。
              // 横向拉宽到 1.10、纵向压到 0.86：窄高的三角没有地方放眼睛，
              // 而且尖头太锐会像警告图标；宽矮的更像个角色。
              final rr = r * (1.0 + 0.10 * math.cos(3 * t));
              return Offset(math.cos(t) * rr * 1.10, math.sin(t) * rr * 0.86);
            }(),
        ]);

      case _ShapeKind.tear:
        // 水滴：上尖下圆。尖头是关键，taper 让小 y 处横向收到很窄
        const steps = 56;
        return shapePoints([
          for (var i = 0; i < steps; i++)
            () {
              final t = i / steps * 2 * math.pi;
              final ct = math.cos(t);
              final st = math.sin(t);
              final taper = st < 0 ? (1 + st * 0.62) : 1.0;
              return Offset(ct * r * taper, st * r * 1.04);
            }(),
        ]);

      case _ShapeKind.blob:
        // 有机 blob：谐波幅度压到 60%（之前太大会长出奇怪的凹口，
        // 小尺寸下看着像被咬了一口）
        const steps = 44;
        return shapePoints([
          for (var i = 0; i < steps; i++)
            () {
              final theta = i / steps * 2 * math.pi;
              var rr = 1.0;
              for (final h in shape.harmonics) {
                rr +=
                    (h.amp * 0.6) *
                    math.sin(h.freq * theta + h.phase + phase * h.speed);
              }
              return Offset(
                math.cos(theta) * r * rr,
                math.sin(theta) * r * rr * 0.98,
              );
            }(),
        ]);
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

    // ★ 两种走法，按顶点数分：
    //
    //   · 顶点很多（>= 12）：采样足够密，用"穿过中点的二次贝塞尔"把它们
    //     顺成一条光滑曲线 —— 这是圆、蛋、豆、水滴、blob 那种有机形状。
    //
    //   · 顶点很少（< 12，比如三角 3 个点、六边形 6 个点）：
    //     千万**不能**套上面那套平滑！它会把每个角都削圆，
    //     三个点的三角直接变成一个圆 —— 形状辨识度就是这么丢的。
    //     这种情况用直线连 + 在角上补一个小圆弧（圆角但不失棱）。
    if (steps >= 12) {
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

    // 多边形：每个角切掉一小段、用二次贝塞尔补上圆角。
    // 圆角半径按边长算（而不是写死像素），3 个点和 6 个点看起来才一致。
    final corners = <(Offset, Offset, Offset, double)>[];
    for (var i = 0; i < steps; i++) {
      final prev = points[(i - 1 + steps) % steps];
      final cur = points[i];
      final next = points[(i + 1) % steps];
      final lenPrev = (cur - prev).distance;
      final lenNext = (next - cur).distance;
      // 圆角最多吃掉 16% 的边长 —— 再多棱角就圆回去了，
      // 而"认得出是六边形/三角"正是靠这些棱。
      final cut = math.min(
        math.min(lenPrev, lenNext) * 0.16,
        baseRadius * 0.16,
      );
      final a = cur + (prev - cur) * (cut / lenPrev);
      final b = cur + (next - cur) * (cut / lenNext);
      corners.add((a, cur, b, cut));
    }
    path.moveTo(corners.first.$1.dx, corners.first.$1.dy);
    for (var i = 0; i < corners.length; i++) {
      final (a, cur, b, _) = corners[i];
      // 直线走到这个角的起点 → 二次贝塞尔绕角 → 继续
      path.lineTo(a.dx, a.dy);
      path.quadraticBezierTo(cur.dx, cur.dy, b.dx, b.dy);
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

    // ======== 2.5D 受光 ========
    //
    // 立体感不是"叠几层渐变"叠出来的：那样光泽方向和形体对不上，看着像
    // 贴了一张渐变贴纸。这里先把这颗 blob 当成一个**球**（球面上每一点的
    // 法线都能算），然后用同一套法线推三件事：
    //   · 漫反射：主体明暗（光从左上打下来）
    //   · 镜面：左上那块高光
    //   · 环境光遨蔽：贴底部的边缘压暗（球和桌面挨着的地方）
    // 三者共用同一个光向，所以"亮的一侧"永远一致 —— 这才是真立体。
    //
    // ★ 性能：两个 shader（主体 + 高光），和以前一样是两个，不是四个。
    //   以前那版是一个线性渐变 + 一圈描边；现在把描边换成真正的 rim light，
    //   同样的开销换来了体积。实测 raster 见本次提交说明。

    // 1) 主体：一层非常克制的体积渐变
    //
    // ★ 这里刻意**不做高光**。
    //   加过一版：径向主体 + 左上镜面光斑 + rim light + 眼窝阴影。
    //   立体是立体了，但小尺寸下那团白斑读起来是"反光的塑料球"，
    //   而且把饱和色洗淡了 —— 关键是它抢了形状的戏。
    //   参考的做法恰恰相反：**靠形状和纯色认人**，表面几乎是平的，
    //   只在底部压一点点暗，让它看着有厚度、不是一张纸。
    //
    //   所以只留两件事：上浅下深的体积感 + 贴着下缘的环境光遮蔽。
    canvas.drawPath(
      path,
      Paint()
        ..shader =
            LinearGradient(
              // 竖直方向：上亮下暗（其余方向的明暗交给形状本身）
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [
                Color.lerp(color, Colors.white, 0.10)!,
                color,
                Color.lerp(color, Colors.black, 0.20)!,
              ],
              stops: const [0.0, 0.55, 1.0],
            ).createShader(
              Rect.fromCircle(center: center, radius: baseRadius * 1.1),
            ),
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

    // ★ 不在头像主体上画 emoji：直接画的话，每个 bot 都是「一块饱和色 +
    //   一张全彩 emoji 贴纸」—— emoji 自带的白/橙/紫和 blob 的颜色互相打架，
    //   像贴歪了的贴纸。纯色块 + 两只眼睛干净得多；emoji 降级成小角标。
    //
    // 眼睛：两个圆角竖条，眨眼时压扁。
    // 侧看的时候再横向压扁一点（真实的脸转过去时眼白就是变窄的）——
    // 这一下比单纯平移更能让人感觉到"它在看着你"。
    final side = (gaze.dx / (size.shortestSide * 0.16)).clamp(-1.0, 1.0);
    final eyeW = size.shortestSide * 0.128 * (1 - 0.22 * side.abs());
    final eyeH = size.shortestSide * 0.225 * (1 - blink * 0.84);

    // 眼睛的立体感：
    //   · 眼窝：在眼睛上方先压一道很软的阴影，让眼睛看着是"陷在脸里"
    //     而不是浮在上面（这是 2.5D 和平面最关键的差别之一）
    //   · 眼睛本体的渐变按光照方向走，受光侧略淡
    //   · 受光侧的边缘一道极细的高光，像湿润的眼球反射
    // 三者都很淡 —— 小到 22px 的头像上过度就成了脏点。
    // 眼睛：两个圆角竖条，纯深色，**不加高光**。
    // 侧看时横向压扁（真实的脸转过去时眼白就是变窄的），眨眼时压成一条。
    // 参考里的眼睛就是这样两颗干净的深色胶囊 —— 加反光反而假。
    final eyePaint = Paint()
      ..color = Color.lerp(color, Colors.black, 0.86)!.withValues(alpha: 0.96);

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
