import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../platform.dart';
import '../scope.dart';
import '../theme.dart';

/// 设置里的「本机服务端」：查看并修改启动配置。
///
/// 默认全自动（定位 node、定位服务端、数据放在用户目录），
/// 每一项也可以手动指定；保存后自动重启服务端生效。
class ServerConfigSection extends StatelessWidget {
  const ServerConfigSection({super.key});

  @override
  Widget build(BuildContext context) {
    if (!isHostPlatform) return const SizedBox.shrink();
    final state = AppScope.of(context);

    final dataDir = state.serverDataDir.isEmpty ? '（自动）用户数据目录' : state.serverDataDir;
    final entry = state.serverEntryPath.isEmpty ? '（自动）程序旁边的 server' : state.serverEntryPath;
    final node = state.serverNodePath.isEmpty ? '（自动）查找 node 22+' : state.serverNodePath;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(LucideIcons.serverCog, size: 15, color: PB.textTertiary),
            const SizedBox(width: 8),
            const Text(
              '本机服务端',
              style: TextStyle(
                fontSize: PB.fsSm,
                fontWeight: FontWeight.w600,
                color: PB.textSecondary,
              ),
            ),
            const Spacer(),
            TextButton.icon(
              onPressed: () => _edit(context, state),
              icon: const Icon(LucideIcons.slidersHorizontal, size: 15),
              label: const Text('修改启动配置'),
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
              const Text(
                '桌面端会自己把服务端跑起来。默认什么都不用填 —— 它自己找 node、'
                '自己找服务端程序；第一次会装依赖。下面这几项只在你的机器'
                '跟默认不一样时才需要改。',
                style: TextStyle(
                  fontSize: PB.fsXxs,
                  color: PB.textQuaternary,
                  height: 1.6,
                ),
              ),
              const SizedBox(height: 10),
              _Row('端口', '${state.serverPort}'),
              _Row('数据目录', dataDir),
              _Row('服务端', entry),
              _Row('node', node),
              const SizedBox(height: 6),
              const Text(
                '数据目录里有房间、会话、上传的附件和 bot 的工作目录 —— '
                '换目录等于换一整套数据（旧目录不会被删）。',
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

  Future<void> _edit(BuildContext context, state) async {
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
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(content: Text('已保存，正在重启本机服务端…')),
    );
  }
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
              style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
            ),
          ),
          Expanded(
            child: SelectableText(
              value,
              style: const TextStyle(
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
      setState(() => _error = '端口要是 1–65535 之间的数字');
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
    return AlertDialog(
      backgroundColor: PB.bgPane,
      title: const Text('本机服务端启动配置', style: TextStyle(fontSize: PB.fsLg)),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '留空 = 自动。改完会重启服务端（换数据目录不会搬旧数据，只换位置）。',
                style: TextStyle(fontSize: PB.fsXxs, color: PB.textQuaternary, height: 1.6),
              ),
              const SizedBox(height: 14),
              _field(_port, '端口', '8787'),
              _field(_entry, '服务端入口（server/src/index.js）', '留空自动查找'),
              _field(_node, 'node 路径（node.exe）', '留空自动查找'),
              _field(_dataDir, '数据目录', '留空 = 用户数据目录'),
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
          child: const Text('取消'),
        ),
        FilledButton(onPressed: _submit, child: const Text('保存并重启')),
      ],
    );
  }

  Widget _field(TextEditingController c, String label, String hint) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: PB.fsXs, color: PB.textTertiary)),
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
              hintStyle: const TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary),
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
