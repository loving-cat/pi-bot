import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../pair_request.dart';
import '../theme.dart';

/// 弹在电脑上的"这台手机想连接，允许吗"。
///
/// 为什么一定要人点：手机通过附近发现找上来的那一刻，电脑这边**什么都不知道**。
/// 不弹窗就等于"同一个 Wi-Fi 里谁先点谁进来"，那和没有认证没区别。
/// 这一下点击就是授权本身（服务端据此发 token），所以：
///   · 不能点空白关掉（barrierDismissible: false）—— 误关等于"没发生过"，
///     而手机那边还在等，状态会对不上；
///   · 显示来源 IP 和名字，让人能判断这是不是自己的手机；
///   · 有倒计时：没人管的时候自己消失，不留一个挂着的授权入口。
class PairRequestDialog extends StatefulWidget {
  const PairRequestDialog({super.key, required this.request});

  final PairRequestHost request;

  @override
  State<PairRequestDialog> createState() => _PairRequestDialogState();
}

class _PairRequestDialogState extends State<PairRequestDialog> {
  Timer? _ticker;
  int _remaining = 0;

  @override
  void initState() {
    super.initState();
    // 剩余时间**自己数**，不复用 DateTime.now() 去算：
    //   ① 测试里推的是假时钟（Timer 会走，DateTime.now() 不动），按墙钟算永远不归零；
    //   ② 用户手动改系统时间也不该让这个弹窗赖着不走。
    final left = widget.request.expiresAt - DateTime.now().millisecondsSinceEpoch;
    final seconds = (left / 1000).ceil();
    _remaining = seconds <= 0 ? 0 : (seconds > 600 ? 600 : seconds);
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _remaining = _remaining - 1);
      if (_remaining <= 0) {
        _ticker?.cancel();
        if (mounted) Navigator.of(context).maybePop();
      }
    });
    if (_remaining <= 0) {
      // 已经过期（服务端那侧时间更早）：连一秒都不该等
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.of(context).maybePop();
      });
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    final accent = PB.colors(context).accentBright;
    return AlertDialog(
      backgroundColor: PB.bgPane,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(PB.r2xl)),
      icon: Icon(LucideIcons.smartphone, size: 26, color: accent),
      title: Text(
        s.t('pairRequest.title'),
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: PB.fsLg, fontWeight: FontWeight.w600),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            s.tf('pairRequest.body', {'device': widget.request.device}),
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: PB.fsSm, color: PB.textSecondary, height: 1.5),
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: PB.bgApp,
              borderRadius: BorderRadius.circular(PB.rLg),
              border: Border.all(color: PB.borderTertiary),
            ),
            child: Column(
              children: [
                if (widget.request.ip.isNotEmpty)
                  Text(
                    widget.request.ip,
                    style: TextStyle(
                      fontFamily: PB.monoFamily,
                      fontFamilyFallback: PB.monoFallback,
                      fontSize: PB.fsXs,
                      color: PB.textSecondary,
                    ),
                  ),
                if (widget.request.platform.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    widget.request.platform,
                    style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 10),
          Text(
            s.tf('pairRequest.countdown', {'n': '$_remaining'}),
            style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(
            s.t('pairRequest.deny'),
            style: TextStyle(fontSize: PB.fsSm, color: PB.danger),
          ),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: Text(s.t('pairRequest.allow')),
        ),
      ],
    );
  }
}
