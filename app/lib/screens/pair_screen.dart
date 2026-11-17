import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import 'scan_screen.dart';

import '../api.dart';
import '../discovery.dart';
import '../pair_request.dart';
import '../pinned_http.dart';
import '../widgets/pair_nearby.dart';
import '../l10n/l10n.dart';
import '../platform.dart';
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
  final _deviceController = TextEditingController();
  bool _useToken = false;
  bool _busy = false;
  String? _error;

  /// 手机端：广播发现的附近主机
  List<DiscoveredHost> _hosts = const [];
  bool _scanning = false;
  DiscoveredHost? _picked;

  /// 手机端默认不展开"手动填地址"：先给"附近有哪些电脑"，找不到再放开手填。
  bool _showManual = false;

  /// "请求连接"的进度：发出去 → 等电脑上点允许 → 拿到 token
  _PairPhase _phase = _PairPhase.idle;

  /// 选中的电脑如果不支持"请求连接"（老版本），就直接落到填配对码
  bool _useCode = false;

  /// 手机端：点了"请求连接"之后，电脑上会不会弹窗，全看这个请求
  PairApprovalStatus? _lastApproval;

  /// 手机上一上来就该是"选设备"，而不是"抄 IP + 抄配对码"（那套是桌面端的形态）。
  bool get _phone => isMobilePlatform;

  @override
  void initState() {
    super.initState();
    final state = AppScope.read(context);
    _urlController.text = state.serverUrl ?? 'http://192.168.1.100:8787';
    _deviceController.text = state.deviceName;
    if (_phone) {
      // 首帧之后再搜：让页面先画出来，搜索期间不会白屏
      WidgetsBinding.instance.addPostFrameCallback((_) => _discover());
    }
  }

  /// 广播搜索附近的电脑。找不到就把手填区打开，免得用户卡在空列表上。
  Future<void> _discover() async {
    if (!_phone || _scanning) return;
    setState(() {
      _scanning = true;
      _error = null;
    });
    final hosts = await discoverHosts();
    if (!mounted) return;
    setState(() {
      _hosts = hosts;
      _scanning = false;
      if (hosts.isEmpty && _picked == null) _showManual = true;
    });
  }

  void _pick(DiscoveredHost host) {
    setState(() {
      _picked = host;
      _urlController.text = host.url;
      // 固定 token 的主机没有配对码可填，直接切到 token 模式
      _useToken = !host.pairing;
      // 电脑端支持"弹窗允许"就用它；老版本服务端返回不了 approve，退回配对码
      _useCode = !host.approve;
      _showManual = false;
      _phase = _PairPhase.idle;
      _lastApproval = null;
      _error = null;
    });
  }

  /// 手机点"请求连接"：电脑会弹窗，等人点允许之后才发 token。
  Future<void> _askToConnect() async {
    final host = _picked;
    if (host == null || _busy) return;
    final state = AppScope.read(context);
    setState(() {
      _busy = true;
      _phase = _PairPhase.sending;
      _lastApproval = null;
      _error = null;
    });
    try {
      // 先固定证书再发请求：这台电脑的 https 是自签的，不装指纹第一条请求就握手失败
      installPinnedFingerprint(host.fingerprint);
      final ticket = await requestPairing(
        host.url,
        device: _deviceController.text.trim(),
        platform: Platform.operatingSystem,
      );
      if (!mounted) return;
      setState(() => _phase = _PairPhase.waiting);
      final result = await awaitApproval(ticket: ticket);
      if (!mounted) return;
      if (result.ok) {
        // 拿到 token 之后和填配对码成功走同一条路
        await state.useToken(
          host.url,
          result.token!,
          device: _deviceController.text.trim(),
          fingerprint: host.fingerprint,
        );
        if (mounted) Navigator.of(context).maybePop();
        return;
      }
      setState(() {
        _phase = _PairPhase.idle;
        _lastApproval = result.status;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _phase = _PairPhase.idle;
        _error = err is ApiException ? err.message : '$err';
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
      // 选中了某台电脑就带上它公告的证书指纹；手动填地址时没有指纹（明文）
      final fingerprint = _picked?.fingerprint ?? '';
      installPinnedFingerprint(fingerprint);
      if (_useToken) {
        await state.useToken(
          _urlController.text,
          _secretController.text,
          device: _deviceController.text,
          fingerprint: fingerprint,
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
    final s = L10n.s(context);
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
                  Text(
                    s.t('pair.tagline'),
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
                    _OrDivider(label: s.t('pair.orManual')),
                    const SizedBox(height: 18),
                  ],
                  if (_phone)
                    ..._phoneBody(s)
                  else
                    ..._desktopBody(s),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 手填区的表单（桌面与手机的"手动"分支共用）。
  List<Widget> _formFields(AppStrings s, {required bool withAddress}) => [
    if (withAddress) ...[
      TextField(
        controller: _urlController,
        keyboardType: TextInputType.url,
        autocorrect: false,
        decoration: InputDecoration(
          labelText: s.t('pair.serverUrl'),
          hintText: 'http://192.168.1.100:8787',
        ),
      ),
      const SizedBox(height: 10),
    ],
    TextField(
      controller: _secretController,
      keyboardType: _useToken ? TextInputType.text : TextInputType.number,
      autocorrect: false,
      decoration: InputDecoration(
        labelText: _useToken ? 'token' : s.t('pair.codeLabel'),
        hintText: _useToken ? 'test-token' : '123456',
      ),
    ),
  ];

  /// 手机端：附近有哪些电脑 → 选一台 → 填它屏幕上的 6 位码。
  List<Widget> _phoneBody(AppStrings s) => [
    NearbyHostsCard(
      hosts: _hosts,
      scanning: _scanning,
      picked: _picked,
      onPick: _pick,
      onRescan: _discover,
    ),
    const SizedBox(height: 14),
    // 选了某台电脑之后：默认请它弹窗问一句；不想等（或老服务端）就填它屏幕上的码
    if (_picked != null && !_showManual) ...[
      if (_phase == _PairPhase.waiting)
        PairWaitingCard(
          host: _picked!.label,
          title: s.t('pair.waitingApproval'),
          hint: s.t('pair.waitingHint'),
          onCancel: () => setState(() => _phase = _PairPhase.idle),
        )
      else if (!_useCode) ...[
        Text(
          s.tf('pair.codeHintForHost', {'host': _picked!.label}),
          style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary, height: 1.5),
        ),
        const SizedBox(height: 10),
        FilledButton(
          onPressed: _busy ? null : _askToConnect,
          child: _phase == _PairPhase.sending
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : Text(s.t('pair.requestTitle')),
        ),
        if (_lastApproval != null) ...[
          const SizedBox(height: 8),
          Text(
            switch (_lastApproval!) {
              PairApprovalStatus.denied => s.t('pair.denied'),
              PairApprovalStatus.expired => s.t('pair.expired'),
              PairApprovalStatus.timeout => s.t('pair.timeout'),
              PairApprovalStatus.failed => s.t('pair.failed'),
              _ => '',
            },
            style: TextStyle(fontSize: PB.fsXs, color: PB.danger, height: 1.4),
          ),
        ],
        const SizedBox(height: 6),
        TextButton(
          onPressed: () => setState(() => _useCode = true),
          child: Text(
            s.t('pair.codeFallback'),
            style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
          ),
        ),
      ] else ...[
        Text(
          s.tf('pair.codeHintForHost', {'host': _picked!.label}),
          style: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary, height: 1.5),
        ),
        const SizedBox(height: 10),
        ..._formFields(s, withAddress: false),
        const SizedBox(height: 12),
        _ConnectButton(busy: _busy, onTap: _connect, label: s.t('pair.connect')),
      ],
    ],
    if (_showManual) ...[
      const SizedBox(height: 4),
      _Segmented(useToken: _useToken, onChanged: (v) => setState(() => _useToken = v)),
      const SizedBox(height: 14),
      ..._formFields(s, withAddress: true),
    ],
    const SizedBox(height: 10),
    TextField(
      controller: _deviceController,
      decoration: InputDecoration(labelText: s.t('pair.deviceName')),
    ),
    // 手动填地址那条路自带按钮；选电脑那条路的按钮在上面各支里
    if (_showManual) ...[
      const SizedBox(height: 18),
      _ConnectButton(busy: _busy, onTap: _connect, label: s.t('pair.connect')),
    ],
    if (_error != null) ..._errorBox(),
    const SizedBox(height: 16),
    _ManualToggle(
      expanded: _showManual,
      onTap: () => setState(() => _showManual = !_showManual),
    ),
    const SizedBox(height: 18),
    _StepsCard(s: s),
  ];

  /// 桌面端：还是原来的"地址 + 码"表单（桌面是宿主机，手边就有终端）。
  List<Widget> _desktopBody(AppStrings s) => [
    _Segmented(useToken: _useToken, onChanged: (v) => setState(() => _useToken = v)),
    const SizedBox(height: 14),
    ..._formFields(s, withAddress: true),
    const SizedBox(height: 10),
    TextField(
      controller: _deviceController,
      decoration: InputDecoration(labelText: s.t('pair.deviceName')),
    ),
    const SizedBox(height: 20),
    _ConnectButton(busy: _busy, onTap: _connect, label: s.t('pair.connect')),
    if (_error != null) ..._errorBox(),
    const SizedBox(height: 30),
    _StepsCard(s: s),
  ];

  List<Widget> _errorBox() => [
    const SizedBox(height: 14),
    Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: PB.danger.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.danger.withValues(alpha: 0.3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(LucideIcons.circleAlert, size: 16, color: PB.danger),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              _error!,
              style: TextStyle(fontSize: PB.fsXs, color: PB.danger, height: 1.4),
            ),
          ),
        ],
      ),
    ),
  ];
}

/// "或者手动填"的分隔线
class _OrDivider extends StatelessWidget {
  const _OrDivider({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(child: Divider(color: PB.borderTertiary)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(
            label,
            style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary),
          ),
        ),
        Expanded(child: Divider(color: PB.borderTertiary)),
      ],
    );
  }
}

/// 主按钮（连接）
class _ConnectButton extends StatelessWidget {
  const _ConnectButton({
    required this.busy,
    required this.onTap,
    required this.label,
  });

  final bool busy;
  final VoidCallback onTap;
  final String label;

  @override
  Widget build(BuildContext context) {
    return FilledButton(
      onPressed: busy ? null : onTap,
      child: busy
          ? const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: Colors.white,
              ),
            )
          : Text(label),
    );
  }
}

/// "手动填地址"开关：平时收起，找不到附近电脑才用得上。
class _ManualToggle extends StatelessWidget {
  const _ManualToggle({required this.expanded, required this.onTap});

  final bool expanded;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = L10n.s(context);
    return TextButton.icon(
      onPressed: onTap,
      icon: Icon(
        expanded ? LucideIcons.chevronUp : LucideIcons.chevronDown,
        size: 16,
        color: PB.textTertiary,
      ),
      label: Text(
        expanded ? s.t('pair.manualHide') : s.t('pair.manualToggle'),
        style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
      ),
    );
  }
}

/// "三步搞定"教程块
class _StepsCard extends StatelessWidget {
  const _StepsCard({required this.s});

  final AppStrings s;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(PB.r2xl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(LucideIcons.zap, size: 15, color: PB.textTertiary),
              const SizedBox(width: 7),
              Text(
                s.t('pair.stepsTitle'),
                style: TextStyle(
                  fontSize: PB.fsSm,
                  fontWeight: FontWeight.w500,
                  color: PB.textSecondary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          _Step(index: '1', text: s.t('pair.step1')),
          // ★ 示例用中性路径，不要写开发机的绝对路径：
          //   这个字符串会被编进 app.so，等于把本机目录随发行包发出去，
          //   打包扫描会拦（真实拦截过一次）。
          _Code(s.t('pair.step1Command')),
          _Step(index: '2', text: s.t('pair.step2')),
          _Code(s.t('pair.step2Sample')),
          _Step(index: '3', text: s.t('pair.step3')),
          const SizedBox(height: 4),
          Text(
            s.t('pair.hint'),
            style: TextStyle(
              fontSize: PB.fsXs,
              color: PB.textQuaternary,
              height: 1.5,
            ),
          ),
        ],
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
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                PB.colors(context).accentBright,
                PB.colors(context).accentHover,
              ],
            ),
            borderRadius: BorderRadius.circular(PB.r3xl),
            boxShadow: PB.glow(
              PB.colors(context).accent,
              blur: 22,
              alpha: 0.35,
            ),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 17),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(LucideIcons.link, size: 21, color: Colors.white),
                const SizedBox(width: 10),
                Text(
                  L10n.s(context).t('pair.scanTitle'),
                  style: const TextStyle(
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
                  child: Text(
                    L10n.s(context).t('pair.recommended'),
                    style: const TextStyle(
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

    final s = L10n.s(context);
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(PB.rXl),
        border: Border.all(color: PB.borderTertiary),
      ),
      child: Row(
        children: [
          item(s.t('pair.modeCode'), false),
          item(s.t('pair.modeToken'), true),
        ],
      ),
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
              style: TextStyle(
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
              style: TextStyle(
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
        style: TextStyle(
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

/// "请求连接"走到哪一步了
enum _PairPhase { idle, sending, waiting }
