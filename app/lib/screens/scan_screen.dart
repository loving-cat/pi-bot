import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:permission_handler/permission_handler.dart';

import '../theme.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

/// 扫出来的配对信息
class PairPayload {
  const PairPayload({this.url, this.code});

  final String? url;
  final String? code;

  bool get isEmpty =>
      (url == null || url!.isEmpty) && (code == null || code!.isEmpty);
}

/// 解析二维码内容，兼容三种写法：
///   1. 服务端打印的 JSON：{"v":1,"url":"http://192.168.1.100:8787","code":"482913"}
///   2. 网页地址：http://192.168.1.100:8787/#pair?code=482913
///   3. 光秃秃一个 6 位配对码
PairPayload parsePairPayload(String raw) {
  final text = raw.trim();
  if (text.isEmpty) return const PairPayload();

  if (text.startsWith('{')) {
    try {
      final json = jsonDecode(text) as Map<String, dynamic>;
      return PairPayload(
        url: json['url']?.toString(),
        code: json['code']?.toString(),
      );
    } catch (_) {
      /* 落到下面继续试 */
    }
  }

  final uri = Uri.tryParse(text);
  if (uri != null && uri.hasAuthority && uri.queryParameters['code'] != null) {
    return PairPayload(
      url: '${uri.scheme}://${uri.authority}',
      code: uri.queryParameters['code'],
    );
  }

  if (RegExp(r'^\d{4,8}$').hasMatch(text)) return PairPayload(code: text);
  return const PairPayload();
}

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final MobileScannerController _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
    // 预览分辨率别开太大，低端机上启动更快
    cameraResolution: const Size(1280, 720),
    // ★ 权限我们自己先去要（见 _askPermission），要到了再启动相机。
    //   以前交给插件自己启自己要 —— 真机上遇到过"压根不弹权限框"（
    //   拒过一次之后系统就不再弹了），用户看到的就是一片黑。
    autoStart: false,
  );
  bool _handled = false;
  bool _torch = false;
  bool _slow = false;
  Timer? _slowTimer;

  /// 相机权限当前是什么状态（用户要的：不给权限就不让扫）
  PermissionStatus? _perm;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onState);
    _slowTimer = Timer(const Duration(milliseconds: 1200), () {
      if (mounted && !_controller.value.isInitialized)
        setState(() => _slow = true);
    });
    // 进页面就问权限 —— 不给就不起相机（用户要的就是这个）
    WidgetsBinding.instance.addPostFrameCallback((_) => _askPermission());
  }

  /// 显式申请相机权限。
  ///
  /// 为什么不能指望插件自己弹：Android 一旦被拒过两次（或用户在系统里
  /// 关掉了），**再请求就不弹窗了** —— 直接回"拒绝"。用户看到的现象就是
  /// "压根没跟手机申请权限"。所以：
  ///   · 能弹就弹（系统对话框，用户点"允许"就完事）；
  ///   · 不能弹（永久拒绝）就直说，并给一个**去系统设置**的按钮；
  ///   · 就是不给 —— 那就手动填地址配对码，不堵死。
  Future<void> _askPermission() async {
    var status = await Permission.camera.status;
    if (status.isDenied) {
      status = await Permission.camera.request();
    }
    if (!mounted) return;
    setState(() => _perm = status);
    if (status.isGranted || status.isLimited) {
      try {
        await _controller.start();
      } catch (_) {}
    }
  }

  Future<void> _openSettings() async {
    await openAppSettings();
    // 从设置回来再看一眼（用户可能刚打开）
    if (!mounted) return;
    await _askPermission();
  }

  void _onState() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _slowTimer?.cancel();
    _controller.removeListener(_onState);
    _controller.dispose();
    super.dispose();
  }

  Future<void> _retry() async {
    setState(() => _slow = false);
    _slowTimer?.cancel();
    _slowTimer = Timer(const Duration(milliseconds: 1200), () {
      if (mounted && !_controller.value.isInitialized)
        setState(() => _slow = true);
    });
    // 先看权限 —— 没给就把系统对话框再叫一次，而不是盲启相机
    final status = await Permission.camera.status;
    if (mounted) setState(() => _perm = status);
    if (!status.isGranted && !status.isLimited) {
      await _askPermission();
      return;
    }
    try {
      await _controller.stop();
    } catch (_) {}
    try {
      await _controller.start();
    } catch (_) {}
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw == null || raw.isEmpty) continue;
      final payload = parsePairPayload(raw);
      if (payload.isEmpty) continue;
      _handled = true;
      Navigator.of(context).pop(payload);
      return;
    }
  }

  @override
  Widget build(BuildContext context) {
    final value = _controller.value;
    final error = value.error;
    final ready = value.isInitialized && value.isRunning;

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          Positioned.fill(
            child: MobileScanner(
              controller: _controller,
              onDetect: _onDetect,
              fit: BoxFit.cover,
              placeholderBuilder: (context, child) => const SizedBox.expand(),
              errorBuilder: (context, error, child) => const SizedBox.expand(),
            ),
          ),

          // 取景框（相机没就绪时先不画，免得挖个洞却什么都看不到）
          if (ready)
            Positioned.fill(child: CustomPaint(painter: _ScanOverlayPainter())),

          if (!ready)
            Positioned.fill(
              child: Container(
                color: Colors.black,
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        // ★ 没给相机权限 —— 把话说清楚，并给两个出口
                        if (_perm != null &&
                            !_perm!.isGranted &&
                            !_perm!.isLimited) ...[
                          const Icon(
                            LucideIcons.cameraOff,
                            size: 38,
                            color: PB.textTertiary,
                          ),
                          const SizedBox(height: 18),
                          Text(
                            _perm!.isPermanentlyDenied
                                ? '扫码要用相机。\n你之前拒绝过两次，系统不再弹窗了 ——\n去设置里把 pi-bot 的相机权限打开。'
                                : '扫码要用相机。\n不给权限就扫不了码（也可以直接手填地址+配对码）。',
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              color: PB.textSecondary,
                              fontSize: PB.fsSm,
                              height: 1.7,
                            ),
                          ),
                          const SizedBox(height: 20),
                          FilledButton.icon(
                            onPressed: _perm!.isPermanentlyDenied
                                ? _openSettings
                                : _askPermission,
                            icon: Icon(
                              _perm!.isPermanentlyDenied
                                  ? LucideIcons.settings
                                  : LucideIcons.camera,
                              size: 18,
                            ),
                            label: Text(
                              _perm!.isPermanentlyDenied ? '去系统设置' : '允许使用相机',
                            ),
                          ),
                          const SizedBox(height: 6),
                          TextButton(
                            onPressed: () => Navigator.pop(context),
                            child: const Text(
                              '不用扫码，手动填地址和配对码',
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: PB.fsSm,
                              ),
                            ),
                          ),
                        ] else if (error == null) ...[
                          const SizedBox(
                            width: 26,
                            height: 26,
                            child: CircularProgressIndicator(
                              strokeWidth: 2.4,
                              color: PB.accentBright,
                            ),
                          ),
                          const SizedBox(height: 20),
                          Text(
                            _slow ? '相机还没起来…' : '正在启动相机…',
                            style: const TextStyle(
                              color: PB.textSecondary,
                              fontSize: PB.fsBase,
                            ),
                          ),
                          const SizedBox(height: 8),
                          const Text(
                            '第一次用会弹一个相机权限，点「允许」',
                            style: TextStyle(
                              color: PB.textQuaternary,
                              fontSize: PB.fsXs,
                            ),
                          ),
                        ] else ...[
                          const Icon(
                            LucideIcons.cameraOff,
                            size: 38,
                            color: PB.textTertiary,
                          ),
                          const SizedBox(height: 18),
                          Text(
                            switch (error.errorCode) {
                              MobileScannerErrorCode.permissionDenied => '没拿到相机权限。\n去「系统设置 → 应用 → pi-bot → 权限」里打开相机，再回来点重试。',
                              MobileScannerErrorCode.unsupported =>
                                '这台设备不支持扫码。',
                              _ =>
                                '相机打不开：${error.errorDetails?.message ?? error.errorCode.name}',
                            },
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              color: PB.textSecondary,
                              fontSize: PB.fsSm,
                              height: 1.7,
                            ),
                          ),
                          const SizedBox(height: 22),
                          FilledButton.icon(
                            onPressed: _retry,
                            icon: const Icon(LucideIcons.refreshCw, size: 18),
                            label: const Text('重试'),
                          ),
                          const SizedBox(height: 10),
                          // ★ 相机起不来时别把人堵死在这页上。
                          //
                          //   真机上见过这种：权限没给/相机被占，这页就只剩一个
                          //   "重试"，点来点去还是黑屏；而手动填地址的入口写在
                          //   底部提示里（"回上一页手动填"）—— 那句在真机上还可能
                          //   被挤到屏幕顶部去。直接给一个按钮最实在。
                          TextButton(
                            onPressed: () => Navigator.pop(context),
                            child: const Text(
                              '不用扫码，手动填地址和配对码',
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: PB.fsSm,
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),

          // 顶部
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: Row(
                children: [
                  IconButton(
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(
                      LucideIcons.x,
                      color: Colors.white,
                      size: 22,
                    ),
                  ),
                  const Spacer(),
                  if (ready)
                    IconButton(
                      onPressed: () {
                        _controller.toggleTorch();
                        setState(() => _torch = !_torch);
                      },
                      icon: Icon(
                        _torch
                            ? LucideIcons.flashlight
                            : LucideIcons.flashlightOff,
                        color: _torch ? PB.accentBright : Colors.white,
                        size: 22,
                      ),
                    ),
                ],
              ),
            ),
          ),

          // 底部提示
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: SafeArea(
              top: false,
              // ★ 别用裸的 bottom:56 —— 真机上（手势条 / 不同长宽比）它会被
              //   挤到错位的地方去，用户看到的是"提示跑到屏幕顶上了"。
              //   包进 SafeArea 里让它自己老老实实待在底部。
              child: Padding(
                padding: const EdgeInsets.only(bottom: 28),
                child: Column(
                  children: [
                    const Text(
                      '对准电脑终端里那个二维码',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: PB.fsLg,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 24),
                      child: Text(
                        '扫不了？在电脑端「设置 → 远程连接」里有配对码，回上一页手动填',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: Colors.white.withValues(alpha: 0.6),
                          fontSize: PB.fsXs,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ScanOverlayPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final side = size.shortestSide * 0.66;
    final rect = Rect.fromCenter(
      center: size.center(Offset.zero),
      width: side,
      height: side,
    );
    final rrect = RRect.fromRectAndRadius(rect, const Radius.circular(20));

    // 挖洞
    final overlay = Path.combine(
      PathOperation.difference,
      Path()..addRect(Offset.zero & size),
      Path()..addRRect(rrect),
    );
    canvas.drawPath(
      overlay,
      Paint()..color = Colors.black.withValues(alpha: 0.62),
    );

    // 四个角
    const len = 26.0;
    final paint = Paint()
      ..color = PB.accentBright
      ..strokeWidth = 3.2
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;
    for (final (corner, dx, dy) in [
      (rect.topLeft, 1.0, 1.0),
      (rect.topRight, -1.0, 1.0),
      (rect.bottomLeft, 1.0, -1.0),
      (rect.bottomRight, -1.0, -1.0),
    ]) {
      canvas.drawLine(corner, corner + Offset(len * dx, 0), paint);
      canvas.drawLine(corner, corner + Offset(0, len * dy), paint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
