const fs = require('fs');
const p = 'lib/screens/pair_screen.dart';
let s = fs.readFileSync(p, 'utf8');

s = s.replace(
  "import 'package:flutter/material.dart';",
  "import 'dart:io' show Platform;\n\nimport 'package:flutter/foundation.dart' show kIsWeb;\nimport 'package:flutter/material.dart';\n\nimport 'scan_screen.dart';",
);

s = s.replace(
  `  Future<void> _connect() async {`,
  `  bool get _canScan => !kIsWeb && (Platform.isAndroid || Platform.isIOS);

  /// 扫码 → 自动填地址和配对码 → 直接连
  Future<void> _scan() async {
    final result = await Navigator.of(context).push<PairPayload>(
      MaterialPageRoute(builder: (_) => const ScanScreen()),
    );
    if (result == null || !mounted) return;
    setState(() {
      if (result.url != null && result.url!.isNotEmpty) _urlController.text = result.url!;
      if (result.code != null && result.code!.isNotEmpty) {
        _secretController.text = result.code!;
        _useToken = false;
      }
    });
    if (_urlController.text.trim().isNotEmpty && _secretController.text.trim().isNotEmpty) {
      await _connect();
    }
  }

  Future<void> _connect() async {`,
);

s = s.replace(
  `                  const SizedBox(height: 32),
                  _Segmented(`,
  `                  const SizedBox(height: 28),
                  if (_canScan) ...[
                    _ScanButton(onTap: _scan),
                    const SizedBox(height: 18),
                    Row(
                      children: [
                        const Expanded(child: Divider(color: PB.borderTertiary)),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          child: Text(
                            '或者手动填',
                            style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                          ),
                        ),
                        const Expanded(child: Divider(color: PB.borderTertiary)),
                      ],
                    ),
                    const SizedBox(height: 18),
                  ],
                  _Segmented(`,
);

s = s.replace(
  `class _Segmented extends StatelessWidget {`,
  `/// 主按钮：扫码配对
class _ScanButton extends StatelessWidget {
  const _ScanButton({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(PB.r3xl),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(PB.r3xl),
        child: Ink(
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [PB.accentBright, PB.accentHover],
            ),
            borderRadius: BorderRadius.circular(PB.r3xl),
            boxShadow: PB.glow(PB.accent, blur: 22, alpha: 0.35),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 17),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.qr_code_scanner_rounded, size: 21, color: Colors.white),
                const SizedBox(width: 10),
                const Text(
                  '扫码配对',
                  style: TextStyle(
                    fontSize: PB.fsLg,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                    letterSpacing: 0.2,
                  ),
                ),
                const SizedBox(width: 10),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(PB.rFull),
                  ),
                  child: const Text(
                    '推荐',
                    style: TextStyle(fontSize: PB.fsXxs, color: Colors.white, fontWeight: FontWeight.w600),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Segmented extends StatelessWidget {`,
);

// 底部说明也更新一下：优先扫码
s = s.replace(
  `                        const _Step(index: '1', text: '电脑上启动服务端'),`,
  `                        const _Step(index: '1', text: '电脑上启动服务端（终端会直接打印一个二维码）'),`,
);
s = s.replace(
  `                        const _Step(index: '2', text: '终端会打印地址和配对码'),`,
  `                        const _Step(index: '2', text: '用上面的「扫码配对」扫它，地址和配对码会自动填好'),`,
);
s = s.replace(
  `                        const _Step(index: '3', text: '手机和电脑连同一个 WiFi，把上面两行填进来'),`,
  `                        const _Step(index: '3', text: '手机和电脑要在同一个 WiFi 下'),`,
);
s = s.replace(
  `                          '想在外面也能用，就把服务端放到云服务器上，这里填公网地址。',`,
  `                          '扫不了码？电脑浏览器打开 http://<你的IP>:8787/pair 也有二维码。\\n想在外面也能用，就把服务端放到云服务器上。',`,
);

fs.writeFileSync(p, s);
console.log('pair_screen 扫码入口已加');
