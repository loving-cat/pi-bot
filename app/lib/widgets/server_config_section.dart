import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../l10n/l10n.dart';
import '../platform.dart';
import '../scope.dart';
import '../theme.dart';
import 'toast.dart';

/// 设置里的「本机服务端」：查看并修改启动配置。
///
/// 默认全自动（定位 node、定位服务端、数据放在用户目录），
/// 每一项也可以手动指定；保存后自动重启服务端生效。
class ServerConfigSection extends StatelessWidget {
  const ServerConfigSection({super.key});

  @override
  Widget build(BuildContext context) {
    if (!isHostPlatform) return const SizedBox.shrink();
    final strings = L10n.s(context);
    final state = AppScope.of(context);

    final dataDir = state.serverDataDir.isEmpty
        ? strings.t('servercfg.autoDataDir')
        : state.serverDataDir;
    final entry = state.serverEntryPath.isEmpty
        ? strings.t('servercfg.autoEntry')
        : state.serverEntryPath;
    final node = state.serverNodePath.isEmpty
        ? strings.t('servercfg.autoNode')
        : state.serverNodePath;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(LucideIcons.serverCog, size: 15, color: PB.textTertiary),
            const SizedBox(width: 8),
            Text(
              strings.t('servercfg.title'),
              style: TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            TextButton.icon(
              onPressed: () => showServerConfigDialog(context),
              icon: const Icon(LucideIcons.slidersHorizontal, size: 15),
              label: Text(strings.t('servercfg.edit')),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Container(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
          decoration: BoxDecoration(
            color: PB.bgPane,
            borderRadius: BorderRadius.circular(PB.rXl),
            border: Border.all(color: PB.borderTertiary),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                strings.t('servercfg.intro'),
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 10),
              _Row(strings.t('servercfg.port'), '${state.serverPort}'),
              _Row(strings.t('servercfg.dataDir'), dataDir),
              _Row(strings.t('servercfg.entry'), entry),
              _Row('node', node),
              const SizedBox(height: 6),
              Text(
                strings.t('servercfg.dataDirNote'),
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

}

/// 打开本机服务端启动配置，保存后重启服务端并显示实际结果。
Future<void> showServerConfigDialog(BuildContext context) async {
  final state = AppScope.read(context);
  final result = await showDialog<_ServerConfig>(
    context: context,
    builder: (_) => _ServerConfigDialog(
      port: state.serverPort,
      dataDir: state.serverDataDir,
      entryPath: state.serverEntryPath,
      nodePath: state.serverNodePath,
    ),
  );
  if (result == null || !context.mounted) return;
  await state.applyServerSettings(
    dataDir: result.dataDir,
    port: result.port,
    entryPath: result.entryPath,
    nodePath: result.nodePath,
  );
  if (!context.mounted) return;
  final problem = state.serverProblem;
  toast(
    context,
    problem ?? L10n.s(context).t('servercfg.savedRestarted'),
  );
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 76,
            child: Text(
              label,
              style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
            ),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: TextStyle(
                fontFamily: PB.monoFamily,
                fontFamilyFallback: PB.monoFallback,
                fontSize: PB.fsXs,
                color: PB.textSecondary,
                height: 1.5,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ServerConfig {
  const _ServerConfig({
    required this.port,
    required this.dataDir,
    required this.entryPath,
    required this.nodePath,
  });
  final int port;
  final String dataDir;
  final String entryPath;
  final String nodePath;
}

class _ServerConfigDialog extends StatefulWidget {
  const _ServerConfigDialog({
    required this.port,
    required this.dataDir,
    required this.entryPath,
    required this.nodePath,
  });

  final int port;
  final String dataDir;
  final String entryPath;
  final String nodePath;

  @override
  State<_ServerConfigDialog> createState() => _ServerConfigDialogState();
}

class _ServerConfigDialogState extends State<_ServerConfigDialog> {
  late final TextEditingController _port = TextEditingController(text: '${widget.port}');
  late final TextEditingController _dataDir = TextEditingController(text: widget.dataDir);
  late final TextEditingController _entry = TextEditingController(text: widget.entryPath);
  late final TextEditingController _node = TextEditingController(text: widget.nodePath);
  String? _error;

  @override
  void dispose() {
    _port.dispose();
    _dataDir.dispose();
    _entry.dispose();
    _node.dispose();
    super.dispose();
  }

  void _submit() {
    final port = int.tryParse(_port.text.trim());
    if (port == null || port < 1 || port > 65535) {
      setState(() => _error = L10n.s(context).t('servercfg.portInvalid'));
      return;
    }
    Navigator.of(context).pop(
      _ServerConfig(
        port: port,
        dataDir: _dataDir.text.trim(),
        entryPath: _entry.text.trim(),
        nodePath: _node.text.trim(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final strings = L10n.s(context);
    return AlertDialog(
      backgroundColor: PB.bgPane,
      title: Text(
        strings.t('servercfg.dialogTitle'),
        style: const TextStyle(fontSize: PB.fsLg),
      ),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                strings.t('servercfg.dialogIntro'),
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 14),
              _field(_port, strings.t('servercfg.port'), '8787'),
              _field(
                _entry,
                strings.t('servercfg.entryLabel'),
                strings.t('servercfg.autoFind'),
              ),
              _field(
                _node,
                strings.t('servercfg.nodePath'),
                strings.t('servercfg.autoFind'),
              ),
              _field(
                _dataDir,
                strings.t('servercfg.dataDir'),
                strings.t('servercfg.dataDirHint'),
              ),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(
                  _error!,
                  style: const TextStyle(fontSize: PB.fsXs, color: PB.danger),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(strings.t('common.cancel')),
        ),
        FilledButton(
          onPressed: _submit,
          child: Text(strings.t('servercfg.saveRestart')),
        ),
      ],
    );
  }

  Widget _field(TextEditingController c, String label, String hint) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
          const SizedBox(height: 6),
          TextField(
            controller: c,
            style: const TextStyle(
              fontFamily: PB.monoFamily,
              fontFamilyFallback: PB.monoFallback,
              fontSize: PB.fsXs,
            ),
            decoration: InputDecoration(
              hintText: hint,
              hintStyle: TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
              isDense: true,
              filled: true,
              fillColor: PB.bgApp,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(PB.rLg),
                borderSide: BorderSide(color: PB.borderTertiary),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
