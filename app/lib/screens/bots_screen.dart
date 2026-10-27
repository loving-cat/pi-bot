import 'package:flutter/material.dart';

import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import '../widgets/model_picker_field.dart';
import '../widgets/blob_avatar.dart';
import 'chat_screen.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

const _thinkingLevels = ['off', 'low', 'medium', 'high', 'max'];

/// 解析 bot 当前选的模型属于哪个模型组里的哪个模型。
///
/// bot.model 的写法有两种：`<组id>/<模型id>`（正规）、或者裸 `<模型id>`（只给了后半截）。
/// 解不出来就返回 null —— 宁可不展示思考档位，也不要瞎猜一个。
ModelSpec? _modelSpecFor(List<ModelGroup> groups, String? slug) {
  final raw = (slug ?? '').trim();
  if (raw.isEmpty) return null;
  final slash = raw.indexOf('/');
  if (slash > 0) {
    final groupId = raw.substring(0, slash);
    final modelId = raw.substring(slash + 1);
    for (final g in groups) {
      if (g.id != groupId) continue;
      for (final m in g.models) {
        if (m.id == modelId) return m;
      }
    }
    return null;
  }
  // 裸模型名：只有唯一匹配才认
  final hits = [
    for (final g in groups)
      for (final m in g.models)
        if (m.id == raw) m,
  ];
  return hits.length == 1 ? hits.single : null;
}

/// 前台要展示的思考档位。
///
/// 后台关掉思考 → 返回空 → 整个思考等级区域不展示。
/// 模型配置里没声明过（旧配置/默认模型）→ 退回内置五档，保持兼容。
List<String> _levelsFor(ModelSpec? spec) {
  if (spec == null) return _thinkingLevels;
  if (!spec.reasoning) return const [];
  final levels = spec.thinkingLevels;
  if (levels.isEmpty) return _thinkingLevels;
  // 只保留前台认识的那几档，顺序跟着前台走
  return [
    for (final level in _thinkingLevels)
      if (levels.contains(level)) level,
  ];
}

class BotsScreen extends StatelessWidget {
  const BotsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    return Scaffold(
      backgroundColor: PB.bgApp,
      appBar: AppBar(
        toolbarHeight: 58,
        title: const Text('花名册'),
        actions: [
          IconButton(
            tooltip: '新建 bot',
            onPressed: () => _createBot(context),
            icon: const Icon(LucideIcons.plus, size: 20),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 680),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(8, 4, 8, 40),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 6, 12, 14),
                child: Text(
                  '${state.bots.length} 个 bot。总经理负责造人派活；点任意一个可以改人设、模型和思考等级。',
                  style: const TextStyle(
                    fontSize: PB.fsXs,
                    color: PB.textQuaternary,
                    height: 1.5,
                  ),
                ),
              ),
              for (final bot in state.bots) _BotRow(bot: bot),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _createBot(BuildContext context) async {
    final nameController = TextEditingController();
    final personaController = TextEditingController();
    final emojiController = TextEditingController(text: '🤖');
    final state = AppScope.read(context);

    final created = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('新建 bot'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: emojiController,
                decoration: const InputDecoration(labelText: '符号标记'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: nameController,
                autofocus: true,
                decoration: const InputDecoration(labelText: '名字'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: personaController,
                maxLines: 4,
                decoration: const InputDecoration(
                  labelText: '人设 / 职责',
                  alignLabelWithHint: true,
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('创建'),
          ),
        ],
      ),
    );

    if (created != true || nameController.text.trim().isEmpty) return;
    await state.createBot(
      name: nameController.text.trim(),
      persona: personaController.text.trim(),
      emoji: emojiController.text.trim(),
    );
  }
}

class _BotRow extends StatelessWidget {
  const _BotRow({required this.bot});

  final Bot bot;

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => _openBotSheet(context, bot),
          child: AvatarHoverScope(child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            child: Row(
              children: [
                BlobAvatar(
                  seed: bot.id,
                  color: PB.colorFor(bot.id),
                  emoji: bot.emoji,
                  size: 44,
                  animate: false,
                  badge: bot.isMain
                      ? const Icon(
                          LucideIcons.shieldCheck,
                          size: 12,
                          color: PB.accent,
                        )
                      : null,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            bot.name,
                            style: const TextStyle(
                              fontSize: PB.fsBase,
                              fontWeight: FontWeight.w500,
                              color: PB.textPrimary,
                            ),
                          ),
                          if (bot.isMain) ...[
                            const SizedBox(width: 7),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 1.5,
                              ),
                              decoration: BoxDecoration(
                                color: PB.accentSoft,
                                borderRadius: BorderRadius.circular(PB.rSm),
                              ),
                              child: const Text(
                                '总经理',
                                style: TextStyle(
                                  fontSize: 9.5,
                                  color: PB.accent,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        shortText(bot.persona.replaceAll('\n', ' '), 52),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: PB.fsXs,
                          color: PB.textTertiary,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${bot.model ?? '默认模型'} · thinking ${bot.thinking ?? '-'}',
                        style: const TextStyle(
                          fontSize: PB.fsXxs,
                          color: PB.textQuaternary,
                          fontFamily: PB.monoFamily,
                          fontFamilyFallback: PB.monoFallback,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: '私聊',
                  onPressed: () async {
                    final room = await state.ensureDm(bot.id);
                    if (room != null && context.mounted) {
                      Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => ChatScreen(room: room),
                        ),
                      );
                    }
                  },
                  icon: const Icon(LucideIcons.messageSquare, size: 18),
                ),
              ],
            ),
          )),
        ),
      ),
    );
  }

  Future<void> _openBotSheet(BuildContext context, Bot bot) async {
    final state = AppScope.read(context);
    final nameController = TextEditingController(text: bot.name);
    final personaController = TextEditingController(text: bot.persona);
    final emojiController = TextEditingController(text: bot.emoji ?? '');
    final modelController = TextEditingController(text: bot.model ?? '');
    var thinking = bot.thinking ?? 'medium';
    // 这个 bot 选中的 MCP 服务（名字）。默认空 = 一个都不挂。
    var pickedMcp = [...bot.mcpServers];

    final saved = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: PB.bgElevated,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(PB.r3xl)),
      ),
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => Padding(
          padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
          child: SafeArea(
            child: SingleChildScrollView(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        BlobAvatar(
                          seed: bot.id,
                          color: PB.colorFor(bot.id),
                          emoji: emojiController.text,
                          size: 46,
                          animate: true,
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                bot.name,
                                style: const TextStyle(
                                  fontSize: PB.fsLg,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              const SizedBox(height: 3),
                              Text(
                                bot.isMain ? '总经理' : bot.id,
                                style: const TextStyle(
                                  fontSize: PB.fsXxs,
                                  color: PB.textQuaternary,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 20),
                    TextField(
                      controller: nameController,
                      decoration: const InputDecoration(labelText: '名字'),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: emojiController,
                      decoration: const InputDecoration(labelText: '符号标记'),
                      onChanged: (_) => setLocal(() {}),
                    ),
                    const SizedBox(height: 10),
                    ModelPickerField(
                      controller: modelController,
                      onPicked: (_) => setLocal(() {}),
                    ),
                    // ★ 思考等级只在当前模型开了思考时才展示。
                    //   后台模型组里关掉思考 → 这里整块不出现，
                    //   避免用户选了一个根本不生效的档位。
                    ...(() {
                      final spec = _modelSpecFor(
                        state.modelGroups,
                        modelController.text,
                      );
                      final levels = _levelsFor(spec);
                      if (levels.isEmpty) {
                        return const <Widget>[
                          SizedBox(height: 12),
                          Text(
                            '当前模型没有开启思考（在「设置 → 模型组」里打开思考强度后，'
                            '这里才能选思考等级）',
                            style: TextStyle(
                              fontSize: PB.fsXxs,
                              color: PB.textQuaternary,
                              height: 1.5,
                            ),
                          ),
                        ];
                      }
                      // 切了模型/档位被关掉时，别让残留的档位带去后端
                      if (!levels.contains(thinking)) {
                        thinking = levels.first;
                      }
                      return <Widget>[
                        const SizedBox(height: 14),
                        Text(
                          '思考等级',
                          style: const TextStyle(
                            fontSize: PB.fsXs,
                            color: PB.textTertiary,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Wrap(
                          spacing: 6,
                          children: [
                            for (final level in levels)
                              ChoiceChip(
                                label: Text(
                                  level,
                                  style: const TextStyle(fontSize: PB.fsXs),
                                ),
                                selected: thinking == level,
                                onSelected: (_) =>
                                    setLocal(() => thinking = level),
                                backgroundColor: PB.bgPane,
                                selectedColor: PB.accentSoft,
                                side: const BorderSide(
                                  color: PB.borderTertiary,
                                ),
                                labelStyle: TextStyle(
                                  color: thinking == level
                                      ? PB.accent
                                      : PB.textTertiary,
                                  fontSize: PB.fsXs,
                                ),
                              ),
                          ],
                        ),
                      ];
                    })(),
                    const SizedBox(height: 14),
                    // ★ MCP 能力：只列**已启用**的服务。
                    //   没启用的连都连不上，摆出来只会让人选了却没反应。
                    ...(() {
                      final available =
                          state.mcpServers.where((s) => s.enabled).toList();
                      if (available.isEmpty) {
                        return const <Widget>[
                          Text(
                            'MCP 能力',
                            style: TextStyle(fontSize: PB.fsXs, color: PB.textTertiary),
                          ),
                          SizedBox(height: 6),
                          Text(
                            '还没有启用的 MCP 服务。去「设置 → MCP」加一个并打开开关，'
                            '这里就能给这个人挂上额外能力。',
                            style: TextStyle(
                              fontSize: PB.fsXxs,
                              color: PB.textQuaternary,
                              height: 1.5,
                            ),
                          ),
                        ];
                      }
                      return <Widget>[
                        Row(
                          children: [
                            const Text(
                              'MCP 能力',
                              style: TextStyle(
                                fontSize: PB.fsXs,
                                color: PB.textTertiary,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Text(
                              pickedMcp.isEmpty ? '（没挂）' : '已挂 ${pickedMcp.length} 个',
                              style: const TextStyle(
                                fontSize: PB.fsXxs,
                                color: PB.textQuaternary,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            for (final server in available)
                              ChoiceChip(
                                label: Text(
                                  server.name,
                                  style: const TextStyle(fontSize: PB.fsXs),
                                ),
                                selected: pickedMcp.contains(server.name),
                                onSelected: (on) => setLocal(() {
                                  if (on) {
                                    if (!pickedMcp.contains(server.name)) {
                                      pickedMcp.add(server.name);
                                    }
                                  } else {
                                    pickedMcp.remove(server.name);
                                  }
                                }),
                                backgroundColor: PB.bgPane,
                                selectedColor: PB.accentSoft,
                                side: const BorderSide(color: PB.borderTertiary),
                                labelStyle: TextStyle(
                                  color: pickedMcp.contains(server.name)
                                      ? PB.accent
                                      : PB.textTertiary,
                                  fontSize: PB.fsXs,
                                ),
                              ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        const Text(
                          '每个 MCP 都会起进程吃内存，只挂这个人真正需要的。',
                          style: TextStyle(
                            fontSize: PB.fsXxs,
                            color: PB.textQuaternary,
                            height: 1.5,
                          ),
                        ),
                      ];
                    })(),
                    const SizedBox(height: 14),
                    TextField(
                      controller: personaController,
                      maxLines: 8,
                      decoration: const InputDecoration(
                        labelText: '人设 / 职责',
                        alignLabelWithHint: true,
                      ),
                    ),
                    const SizedBox(height: 18),
                    Row(
                      children: [
                        if (!bot.isMain)
                          Expanded(
                            child: TextButton(
                              onPressed: () async {
                                Navigator.pop(ctx, false);
                                await state.deleteBot(bot.id);
                              },
                              child: const Text(
                                '删除',
                                style: TextStyle(color: PB.danger),
                              ),
                            ),
                          ),
                        const SizedBox(width: 10),
                        Expanded(
                          flex: 2,
                          child: FilledButton(
                            onPressed: () async {
                              Navigator.pop(ctx, true);
                              await state.updateBot(bot.id, {
                                'name': nameController.text.trim(),
                                'emoji': emojiController.text.trim(),
                                'persona': personaController.text,
                                'model': modelController.text.trim(),
                                'thinking': thinking,
                                'mcpServers': pickedMcp,
                              });
                            },
                            child: const Text('保存'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      '改模型或思考等级会自动重开这个 bot 的会话（旧记录文件保留）。',
                      style: TextStyle(
                        fontSize: PB.fsXxs,
                        color: PB.textQuaternary,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    if (saved == true) await state.refresh();
  }
}
