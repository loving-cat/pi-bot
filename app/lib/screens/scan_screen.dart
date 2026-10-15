import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../theme.dart';
/// 扫出来的配对信息
class PairPayload {
  const PairPayload({this.url, this.code});

  final String? url;
  final String? code;

  bool get isEmpty => (url == null || url!.isEmpty) && (code == null || code!.isEmpty);
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
    return PairPayload(url: '${uri.scheme}://${uri.authority}', code: uri.queryParameters['code']);
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
  );
  bool _handled = false;
  bool _torch = false;
  bool _slow = false;
  Timer? _slowTimer;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onState);
    // 相机起得慢的时候给个"正在启动"，别让人对着一片黑猜
    _slowTimer = Timer(const Duration(milliseconds: 1200), () {
      if (mounted && !_controller.value.isInitialized) setState(() => _slow = true);
    });
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
      if (mounted && !_controller.value.isInitialized) setState(() => _slow = true);
    });
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
          if (ready) Positioned.fill(child: CustomPaint(painter: _ScanOverlayPainter())),

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
                        if (error == null) ...[
                          const SizedBox(
                            width: 26,
                            height: 26,
                            child: CircularProgressIndicator(strokeWidth: 2.4, color: PB.accentBright),
                          ),
                          const SizedBox(height: 20),
                          Text(
                            _slow ? '相机还没起来…' : '正在启动相机…',
                            style: const TextStyle(color: PB.textSecondary, fontSize: PB.fsBase),
                          ),
                          const SizedBox(height: 8),
                          const Text(
                            '第一次用会弹一个相机权限，点「允许」',
                            style: TextStyle(color: PB.textQuaternary, fontSize: PB.fsXs),
                          ),
                        ] else ...[
                          const Icon(Icons.no_photography_outlined, size: 38, color: PB.textTertiary),
                          const SizedBox(height: 18),
                          Text(
                            switch (error.errorCode) {
                              MobileScannerErrorCode.permissionDenied =>
                                '没拿到相机权限。\n去「系统设置 → 应用 → pi-bot → 权限」里打开相机，再回来点重试。',
                              MobileScannerErrorCode.unsupported => '这台设备不支持扫码。',
                              _ => '相机打不开：${error.errorDetails?.message ?? error.errorCode.name}',
                            },
                            textAlign: TextAlign.center,
                            style: const TextStyle(color: PB.textSecondary, fontSize: PB.fsSm, height: 1.7),
                          ),
                          const SizedBox(height: 22),
                          FilledButton.icon(
                            onPressed: _retry,
                            icon: const Icon(Icons.refresh, size: 18),
                            label: const Text('重试'),
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
                    icon: const Icon(Icons.close, color: Colors.white, size: 22),
                  ),
                  const Spacer(),
                  if (ready)
                    IconButton(
                      onPressed: () {
                        _controller.toggleTorch();
                        setState(() => _torch = !_torch);
                      },
                      icon: Icon(
                        _torch ? Icons.flashlight_on : Icons.flashlight_off,
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
            bottom: 56,
            child: Column(
              children: [
                const Text(
                  '对准电脑终端里那个二维码',
                  style: TextStyle(color: Colors.white, fontSize: PB.fsLg, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 8),
                Text(
                  '扫不了？在电脑端「设置 → 远程连接」里有配对码，回上一页手动填',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white.withValues(alpha: 0.6), fontSize: PB.fsXs),
                ),
              ],
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
    final rect = Rect.fromCenter(center: size.center(Offset.zero), width: side, height: side);
    final rrect = RRect.fromRectAndRadius(rect, const Radius.circular(20));

    // 挖洞
    final overlay = Path.combine(
      PathOperation.difference,
      Path()..addRect(Offset.zero & size),
      Path()..addRRect(rrect),
    );
    canvas.drawPath(overlay, Paint()..color = Colors.black.withValues(alpha: 0.62));

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
