import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import 'scan_screen.dart';

import '../api.dart';
import '../scope.dart';
import '../theme.dart';
import '../widgets/app_logo.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

class PairScreen extends StatefulWidget {
  const PairScreen({super.key});

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _urlController = TextEditingController();
  final _secretController = TextEditingController();
  final _deviceController = TextEditingController(text: '我的手机');
  bool _useToken = false;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final state = AppScope.read(context);
    _urlController.text = state.serverUrl ?? 'http://192.168.1.100:8787';
    _deviceController.text = state.deviceName;
  }

  @override
  void dispose() {
    _urlController.dispose();
    _secretController.dispose();
    _deviceController.dispose();
    super.dispose();
  }

  /// 扫码入口**暂时关掉**（用户：“这个扫码暂时取消掉 先用code连接”）。
  ///
  /// 原因：真机上相机起不来（权限给了也不弹预览），而扫码页的布局在真机上
  /// 也是错位的（内容堆在屏幕最上面）。先把主路改回“手填地址 + 配对码”——
  /// 这条路本来就能用（配对页是 Center + SingleChildScrollView，怎么都摆得下）。
  ///
  /// 想重新打开：把这里改成 true（代码都留着，没删）。
  static const _scanEnabled = false;

  /// PI_BOT_FAKE_SCAN 是给桌面端截图预览用的（桌面没有 mobile_scanner 实现）
  bool get _canScan =>
      _scanEnabled &&
      (const bool.fromEnvironment('PI_BOT_FAKE_SCAN') ||
          (!kIsWeb && (Platform.isAndroid || Platform.isIOS)));

  /// 扫码 → 自动填地址和配对码 → 直接连
  Future<void> _scan() async {
    final result = await Navigator.of(
      context,
    ).push<PairPayload>(MaterialPageRoute(builder: (_) => const ScanScreen()));
    if (result == null || !mounted) return;
    setState(() {
      if (result.url != null && result.url!.isNotEmpty)
        _urlController.text = result.url!;
      if (result.code != null && result.code!.isNotEmpty) {
        _secretController.text = result.code!;
        _useToken = false;
      }
    });
    if (_urlController.text.trim().isNotEmpty &&
        _secretController.text.trim().isNotEmpty) {
      await _connect();
    }
  }

  Future<void> _connect() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final state = AppScope.read(context);
    try {
      if (_useToken) {
        await state.useToken(
          _urlController.text,
          _secretController.text,
          device: _deviceController.text,
        );
      } else {
        await state.pairWithCode(
          _urlController.text,
          _secretController.text,
          device: _deviceController.text,
        );
      }
    } catch (err) {
      setState(() => _error = err is ApiException ? err.message : '$err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: PB.bgApp,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Align(
                    alignment: Alignment.center,
                    child: AppLogo(size: 64),
                  ),
                  const SizedBox(height: 20),
                  const Text(
                    'pi-bot',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: PB.fsXxl,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.3,
                    ),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    '连上你自己的 pi agent',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: PB.fsSm,
                      color: PB.textQuaternary,
                    ),
                  ),
                  const SizedBox(height: 28),
                  if (_canScan) ...[
                    _ScanButton(onTap: _scan),
                    const SizedBox(height: 18),
                    Row(
                      children: [
                        const Expanded(
                          child: Divider(color: PB.borderTertiary),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          child: Text(
                            '或者手动填',
                            style: TextStyle(
                              fontSize: PB.fsXxs,
                              color: PB.textQuaternary,
                            ),
                          ),
                        ),
                        const Expanded(
                          child: Divider(color: PB.borderTertiary),
                        ),
                      ],
                    ),
                    const SizedBox(height: 18),
                  ],
                  _Segmented(
                    useToken: _useToken,
                    onChanged: (v) => setState(() => _useToken = v),
                  ),
                  const SizedBox(height: 14),
                  TextField(
                    controller: _urlController,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: '服务器地址',
                      hintText: 'http://192.168.1.100:8787',
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _secretController,
                    keyboardType: _useToken
                        ? TextInputType.text
                        : TextInputType.number,
                    autocorrect: false,
                    decoration: InputDecoration(
                      labelText: _useToken ? 'token' : '6 位配对码',
                      hintText: _useToken ? 'test-token' : '123456',
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _deviceController,
                    decoration: const InputDecoration(labelText: '这台手机的名字'),
                  ),
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: _busy ? null : _connect,
                    child: _busy
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Text('连接'),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: PB.danger.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(PB.rXl),
                        border: Border.all(
                          color: PB.danger.withValues(alpha: 0.3),
                        ),
                      ),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(
                            LucideIcons.circleAlert,
                            size: 16,
                            color: PB.danger,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              _error!,
                              style: const TextStyle(
                                fontSize: PB.fsXs,
                                color: PB.danger,
                                height: 1.4,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                  const SizedBox(height: 30),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: PB.bgPane,
                      borderRadius: BorderRadius.circular(PB.r2xl),
                      border: Border.all(color: PB.borderTertiary),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Row(
                          children: [
                            Icon(
                              LucideIcons.zap,
                              size: 15,
                              color: PB.textTertiary,
                            ),
                            SizedBox(width: 7),
                            Text(
                              '三步搞定',
                              style: TextStyle(
                                fontSize: PB.fsSm,
                                fontWeight: FontWeight.w500,
                                color: PB.textSecondary,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        const _Step(index: '1', text: '电脑上启动服务端（终端会直接打印地址和配对码）'),
                        const _Code('cd D:\\pi-bot\\server\nnode src/index.js'),
                        const _Step(
                          index: '2',
                          text: '把它打印的地址和配对码填到上面（就在这一页）',
                        ),
                        const _Code(
                          'http://192.168.1.100:8787  (以太网)\n★ 配对码：482913',
                        ),
                        const _Step(
                          index: '3',
                          text: '手机和电脑连同一个 WiFi，把上面两行填进来',
                        ),
                        const SizedBox(height: 4),
                        const Text(
                          '地址和配对码都在电脑终端里；也可以在电脑浏览器打开\nhttp://<你的IP>:8787/pair 看。\n想在外面也能用，就把服务端放到云服务器上。',
                          style: TextStyle(
                            fontSize: PB.fsXs,
                            color: PB.textQuaternary,
                            height: 1.5,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 主按钮：扫码配对
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
                const Icon(LucideIcons.scanLine, size: 21, color: Colors.white),
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
                  padding: const EdgeInsets.symmetric(
                    horizontal: 7,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(PB.rFull),
                  ),
                  child: const Text(
                    '推荐',
                    style: TextStyle(
                      fontSize: PB.fsXxs,
                      color: Colors.white,
                      fontWeight: FontWeight.w600,
                    ),
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

class _Segmented extends StatelessWidget {
  const _Segmented({required this.useToken, required this.onChanged});

  final bool useToken;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    Widget item(String label, bool value) {
      final selected = useToken == value;
      return Expanded(
        child: GestureDetector(
          onTap: () => onChanged(value),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 140),
            padding: const EdgeInsets.symmetric(vertical: 10),
            decoration: BoxDecoration(
              color: selected ? PB.bgActive : Colors.transparent,
              borderRadius: BorderRadius.circular(PB.rLg),
            ),
            child: Text(
              label,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w500,
                color: selected ? PB.textPrimary : PB.textQuaternary,
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Row(children: [item('配对码', false), item('固定 token', true)]),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.index, required this.text});

  final String index;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 17,
            height: 17,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: PB.bgActive,
              borderRadius: BorderRadius.circular(PB.rSm),
            ),
            child: Text(
              index,
              style: const TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w600,
                color: PB.textTertiary,
              ),
            ),
          ),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                fontSize: PB.fsXs,
                color: PB.textTertiary,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Code extends StatelessWidget {
  const _Code(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(left: 26, bottom: 11),
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      decoration: BoxDecoration(
        color: PB.bgApp,
        borderRadius: BorderRadius.circular(PB.rLg),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Text(
        text,
        style: const TextStyle(
          fontFamily: PB.monoFamily,
          fontFamilyFallback: PB.monoFallback,
          fontSize: PB.fsXxs,
          color: PB.textSecondary,
          height: 1.6,
        ),
      ),
    );
  }
}
