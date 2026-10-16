import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../models.dart';
import '../platform.dart';
import '../scope.dart';
import '../theme.dart';

/// 桌面端专用：本机服务端连不上时的兜底页。
///
/// PC 就是宿主，它永远不该看到手机那套「配对码 / 扫码」界面 ——
/// 那个界面只会让人困惑（"我去哪扫码？"）。这里只告诉他一件事：
/// 服务端起没起、怎么起。
class HostConnectScreen extends StatefulWidget {
  const HostConnectScreen({super.key});

  @override
  State<HostConnectScreen> createState() => _HostConnectScreenState();
}

class _HostConnectScreenState extends State<HostConnectScreen> {
  Timer? _ticker;
  bool _retrying = false;

  @override
  void initState() {
    super.initState();
    // 服务端起来后自动进主界面
    _ticker = Timer.periodic(const Duration(seconds: 3), (_) async {
      final state = AppScope.read(context);
      if (state.link == LinkState.online) return;
      if (_retrying) return;
      _retrying = true;
      try {
        await state.connectLocal();
      } finally {
        _retrying = false;
      }
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final url = state.serverUrl ?? localServerUrl;
    final online = state.link == LinkState.online;

    return Scaffold(
      backgroundColor: PB.bgApp,
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Align(
                  alignment: Alignment.center,
                  child: Container(
                    width: 64,
                    height: 64,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(18),
                      gradient: const LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: [Color(0xFF3D9BFF), Color(0xFF126FD4)],
                      ),
                      boxShadow: PB.glow(PB.accent, blur: 24, alpha: 0.4),
                    ),
                    child: const Text(
                      'π',
                      style: TextStyle(
                        fontSize: 30,
                        fontWeight: FontWeight.w600,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 22),
                Text(
                  online ? '连上了' : '正在连接本机服务端…',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: PB.fsXl,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 8),
                if (!online)
                  const SizedBox(
                    height: 30,
                    child: Center(
                      child: SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2.2),
                      ),
                    ),
                  ),
                const SizedBox(height: 6),
                SelectableText(
                  url,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontFamily: PB.monoFamily,
                    fontFamilyFallback: PB.monoFallback,
                    fontSize: PB.fsXs,
                    color: PB.textTertiary,
                  ),
                ),
                const SizedBox(height: 26),
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: PB.bgBubble,
                    borderRadius: BorderRadius.circular(PB.r2xl),
                    border: Border.all(color: PB.borderTertiary),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(
                            LucideIcons.terminal,
                            size: 15,
                            color: PB.textTertiary,
                          ),
                          const SizedBox(width: 8),
                          const Text(
                            '服务端没起？在终端跑：',
                            style: TextStyle(
                              fontSize: PB.fsXs,
                              color: PB.textTertiary,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 10,
                        ),
                        decoration: BoxDecoration(
                          color: PB.bgApp,
                          borderRadius: BorderRadius.circular(PB.rLg),
                          border: Border.all(color: PB.borderTertiary),
                        ),
                        child: const SelectableText(
                          'cd server\nnode src/index.js',
                          style: TextStyle(
                            fontFamily: PB.monoFamily,
                            fontFamilyFallback: PB.monoFallback,
                            fontSize: PB.fsXs,
                            color: PB.textSecondary,
                            height: 1.6,
                          ),
                        ),
                      ),
                      const SizedBox(height: 10),
                      const Text(
                        '起来之后这里会自动连上，不用点任何东西。',
                        style: TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                          height: 1.5,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),
                FilledButton.icon(
                  onPressed: () => state.connectLocal(),
                  icon: const Icon(LucideIcons.refreshCw, size: 17),
                  label: const Text('立即重试'),
                ),
                const SizedBox(height: 10),
                // ★ PC 端**不给**去手机配对表单的入口。
                //   PC 是宿主：服务端就跑在这台机器上，它没有"去连别人"这个需求。
                //   真正需要的是"把手机接进来" —— 那是「设置 → 远程连接」里的
                //   二维码 + 配对码，扫一下就行，不用在这填任何东西。
                const Text(
                  '要把手机接进来？去「设置 → 远程连接」，扫一下二维码就行，这里不用填。',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    color: PB.textQuaternary,
                    height: 1.5,
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
