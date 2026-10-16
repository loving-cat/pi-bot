const fs = require('fs');
const p = 'lib/screens/scan_screen.dart';
let s = fs.readFileSync(p, 'utf8');

// 相机状态：加载中 / 没权限 / 出错，都给明确提示，不要一片黑
s = s.replace(
  `class _ScanScreenState extends State<ScanScreen> {
  final MobileScannerController _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
  );
  bool _handled = false;
  bool _torch = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }`,
  `class _ScanScreenState extends State<ScanScreen> {
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
  }`,
);

s = s.replace(
  "import 'dart:convert';\n\nimport 'package:flutter/material.dart';",
  "import 'dart:async';\nimport 'dart:convert';\n\nimport 'package:flutter/material.dart';",
);

// 把相机 + 各种状态层重写
s = s.replace(
  `  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          Positioned.fill(
            child: MobileScanner(
              controller: _controller,
              onDetect: _onDetect,
              errorBuilder: (context, error, child) {
                _error ??= switch (error.errorCode) {
                  MobileScannerErrorCode.permissionDenied => '没给相机权限。去系统设置里允许 pi-bot 使用相机。',
                  MobileScannerErrorCode.unsupported => '这台设备不支持扫码。',
                  _ => '相机打不开：\${error.errorDetails?.message ?? error.errorCode.name}',
                };
                return Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.no_photography_outlined, size: 40, color: PB.textTertiary),
                        const SizedBox(height: 16),
                        Text(
                          _error!,
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: PB.textSecondary, fontSize: PB.fsSm, height: 1.6),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),

          // 取景框
          Positioned.fill(child: CustomPaint(painter: _ScanOverlayPainter())),`,
  `  @override
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
              placeholderBuilder: (context) => const SizedBox.expand(),
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
                                '没拿到相机权限。\\n去「系统设置 → 应用 → pi-bot → 权限」里打开相机，再回来点重试。',
                              MobileScannerErrorCode.unsupported => '这台设备不支持扫码。',
                              _ => '相机打不开：\${error.errorDetails?.message ?? error.errorCode.name}',
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
            ),`,
);

// 顶部按钮：相机没好时隐藏手电筒
s = s.replace(
  `                  const Spacer(),
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
                  ),`,
  `                  const Spacer(),
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
                    ),`,
);

// 底部加"手动输入"兜底
s = s.replace(
  `                Text(
                  '没有二维码？在电脑浏览器打开  http://<你的IP>:8787/pair',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white.withValues(alpha: 0.6), fontSize: PB.fsXs),
                ),`,
  `                Text(
                  '扫不了？在电脑端「设置 → 远程连接」里有配对码，回上一页手动填',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white.withValues(alpha: 0.6), fontSize: PB.fsXs),
                ),`,
);

fs.writeFileSync(p, s);
console.log('scan_screen 补丁完成');
