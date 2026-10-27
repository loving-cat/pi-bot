import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/material.dart';

import '../theme.dart';
import 'avatar_life.dart';
import 'avatar_character.dart';
import 'avatar_character_painter.dart';

/// 角色头像宿主，协调交互、动画及独立绘制模块。
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

  /// 是否启用呼吸、眨眼和按压动画；静态头像仍支持视线跟随。
  final bool animate;
  final Widget? badge;

  final bool ring;

  final AvatarMood mood;

  final bool hovered;

  /// 是否订阅指针；群组合中的成员禁用指针跟随。
  final bool followPointer;

  final bool interactive;

  @visibleForTesting
  /// 测试开关，关闭所有动画与指针驱动。
  static bool animationsEnabled = true;

  @visibleForTesting
  static String shapeKindOf(String seed) =>
      AvatarCharacter.fromSeed(seed).kind.name;

  @override
  State<BlobAvatar> createState() => _BlobAvatarState();
}

/// 将区域悬停状态传给后代头像，不拦截区域自身的操作。
class AvatarHoverScope extends StatefulWidget {
  const AvatarHoverScope({
    super.key,
    required this.child,
    this.forceHovered = false,
  });

  final Widget child;

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

/// 由已持有悬停状态的容器直接广播，避免重复命中区域。
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
  late AvatarCharacter _character = AvatarCharacter.fromSeed(widget.seed);
  AnimationController? _wobble;
  AnimationController? _blink;
  AnimationController? _poke;
  math.Random? _rng;
  Timer? _blinkTimer;
  Timer? _settleTimer;

  bool _following = false;

  bool _followHovered = false;

  final ValueNotifier<Offset> _gaze = ValueNotifier(Offset.zero);

  Offset _gazeTarget = Offset.zero;

  Ticker? _gazeTicker;
  Duration _lastGazeTick = Duration.zero;

  Timer? _ambientTimer;

  bool _awake = false;

  bool get _alive => widget.animate && BlobAvatar.animationsEnabled;

  bool get _ambientAllowed =>
      BlobAvatar.animationsEnabled &&
      (widget.mood == AvatarMood.busy || (_alive && _awake));

  @override
  void initState() {
    super.initState();

    _rng = math.Random(widget.seed.hashCode);

    _syncAnimationMode();
  }

  /// 控制器按需创建并复用，模式切换时重排活动与休眠。
  void _syncAnimationMode() {
    if (!_alive) {
      _sleep();
      return;
    }
    _wobble ??= AnimationController(
      vsync: this,
      duration: const Duration(seconds: 11),
    );
    _blink ??= AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 190),
    );
    _poke ??= AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 380),
    );
    _wake();
  }

  void _wake() {
    if (!mounted || !_alive) return;
    if (!_awake) {
      _awake = true;
      _wobble?.repeat();
      _scheduleBlink();
    }
    _syncAmbient();
    _settleTimer?.cancel();
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

  void _followPointer() {
    final p = AvatarLife.pointer.value;
    if (!mounted || !BlobAvatar.animationsEnabled || p == null) return;
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

  void _aimGaze(Offset next) {
    if ((next - _gazeTarget).distance < 0.2) return;
    _gazeTarget = next;
    _startGazeTicker();
  }

  void _startGazeTicker() {
    if (_gazeTicker?.isActive ?? false) return;
    if (!mounted) return;
    _lastGazeTick = Duration.zero;
    (_gazeTicker ??= createTicker(_onGazeTick)).start();
  }

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
      _gazeTicker?.stop();
    }
  }

  void _onEnter(PointerEnterEvent _) {
    _selfHovered = true;
    _syncFollow();
  }

  void _onExit(PointerExitEvent _) {
    _selfHovered = false;
    _syncFollow();
  }

  void _startFollow() {
    if (_following) return;
    if (!BlobAvatar.animationsEnabled || !widget.followPointer) return;
    AvatarLife.pointer.addListener(_followPointer);
    _following = true;
    _followPointer();
    _wake();
    _syncAmbient();
  }

  void _stopFollow() {
    if (!_following) return;
    AvatarLife.pointer.removeListener(_followPointer);
    _following = false;
    _aimGaze(Offset.zero);
    _syncAmbient();
  }

  bool _scopeHovered = false;

  bool _selfHovered = false;

  bool _hoveredNow() => widget.hovered || _scopeHovered || _selfHovered;

  /// 自身、区域和显式悬停共同决定跟随；禁用后立即解绑。
  void _syncFollow() {
    final h =
        _hoveredNow() && widget.followPointer && BlobAvatar.animationsEnabled;
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
    _scopeHovered =
        context.dependOnInheritedWidgetOfExactType<_AvatarHover>()?.hovered ??
        false;
    _syncFollow();
  }

  @override
  void didUpdateWidget(BlobAvatar old) {
    super.didUpdateWidget(old);
    if (widget.seed != old.seed) {
      _character = AvatarCharacter.fromSeed(widget.seed);
      _rng = math.Random(widget.seed.hashCode);
    }
    if (widget.seed != old.seed ||
        widget.animate != old.animate ||
        widget.mood != old.mood) {
      _syncAnimationMode();
    }
    if (widget.hovered != old.hovered ||
        widget.followPointer != old.followPointer) {
      _syncFollow();
    }
    if (widget.size != old.size && _following) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _following) _followPointer();
      });
    }
  }

  void _onPoke() {
    if (!_alive || _poke == null) return;
    _wake();
    _poke!.forward(from: 0).then((_) => _poke!.reverse());
  }

  /// 忙碌或醒着的头像间歇变换视线；指针跟随时暂停自主动作。
  void _syncAmbient() {
    _ambientTimer?.cancel();
    _ambientTimer = null;
    if (!_ambientAllowed) return;
    _scheduleAmbient();
  }

  void _scheduleAmbient() {
    if (!mounted || !_ambientAllowed) return;
    if (_following) return;
    final rng = _rng;
    if (rng == null) return;
    final base = widget.mood == AvatarMood.busy ? 1400 : 2600;
    final jitter = rng.nextInt(widget.mood == AvatarMood.busy ? 1600 : 4200);
    _ambientTimer = Timer(Duration(milliseconds: base + jitter), _doAmbient);
  }

  void _doAmbient() {
    if (!mounted || !_ambientAllowed || _following) return;
    final rng = _rng;
    if (rng == null) return;

    final reach = widget.size * 0.16;
    final Offset target;
    if (widget.mood == AvatarMood.busy) {
      final dir = rng.nextBool() ? 1.0 : -1.0;
      target = Offset(dir * reach * 0.85, -reach * 0.35);
    } else {
      target = Offset(
        (rng.nextDouble() * 2 - 1) * reach * 0.55,
        (rng.nextDouble() * 2 - 1) * reach * 0.3,
      );
    }
    _aimGaze(target);
    final holdMs = widget.mood == AvatarMood.busy ? 900 : 1200;
    _ambientTimer = Timer(Duration(milliseconds: holdMs), () {
      if (!mounted || !_ambientAllowed || _following) return;
      _aimGaze(Offset.zero);
      _scheduleAmbient();
    });
  }

  @override
  void dispose() {
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

  /// 符号角标仅用于大尺寸主控头像，显式badge优先。
  Widget? _emojiBadge() {
    final e = widget.emoji;
    if (!widget.ring) return null;
    if (e == null || e.trim().isEmpty || widget.size < 40) return null;
    return Text(e, style: TextStyle(fontSize: widget.size * 0.27, height: 1.0));
  }

  @override
  Widget build(BuildContext context) {
    final cornerBadge = widget.badge ?? _emojiBadge();
    return MouseRegion(
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
    final busyLift = widget.mood == AvatarMood.busy
        ? Offset(0, -widget.size * 0.045)
        : Offset.zero;

    Widget paint(double phase, double blink, double poke, Offset gaze) =>
        CustomPaint(
          size: Size.square(widget.size),
          painter: AvatarCharacterPainter(
            character: _character,
            color: widget.color,
            phase: phase,
            blink: blink,
            poke: poke,
            gaze: gaze + busyLift,
            ring: widget.ring,
            mood: widget.mood,
          ),
        );

    if (!_alive || _wobble == null) {
      return RepaintBoundary(
        child: ValueListenableBuilder<Offset>(
          valueListenable: _gaze,
          builder: (context, gaze, _) => paint(0, 0, 0, gaze),
        ),
      );
    }

    return RepaintBoundary(
      child: AnimatedBuilder(
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

/// 按稳定成员身份组合头像；空组和单成员居中，最多展示四个。
class GroupBlobAvatar extends StatelessWidget {
  const GroupBlobAvatar({
    super.key,
    required this.seeds,
    required this.size,
    this.animate = true,
    this.mood = AvatarMood.idle,
  });

  final List<String> seeds;
  final double size;
  final bool animate;
  final AvatarMood mood;

  @override
  Widget build(BuildContext context) {
    final shown = seeds.toSet().take(4).toList();
    if (shown.isEmpty) shown.add('pi');
    final inner =
        size *
        (shown.length == 1
            ? 1.0
            : shown.length == 2
            ? 0.72
            : 0.64);
    final layout = switch (shown.length) {
      1 => const [Offset.zero],
      2 => const [Offset(-0.14, -0.12), Offset(0.14, 0.12)],
      3 => const [Offset(-0.17, -0.15), Offset(0.17, -0.15), Offset(0, 0.18)],
      _ => const [
        Offset(-0.17, -0.17),
        Offset(0.17, -0.17),
        Offset(-0.17, 0.17),
        Offset(0.17, 0.17),
      ],
    };
    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          for (var i = 0; i < shown.length; i++)
            Positioned(
              key: ValueKey(shown[i]),
              left: size / 2 + layout[i].dx * size - inner / 2,
              top: size / 2 + layout[i].dy * size - inner / 2,
              child: BlobAvatar(
                followPointer: false,
                seed: shown[i],
                color: PB.colorFor(shown[i]),
                size: inner,
                animate: animate,
                mood: mood,
              ),
            ),
        ],
      ),
    );
  }
}
