import 'package:flutter/material.dart';

import '../l10n/l10n.dart';
import '../models.dart';
import '../scope.dart';
import '../theme.dart';
import '../window_chrome.dart';
import '../widgets/model_picker_field.dart';
import '../widgets/thinking_slider.dart';
import '../widgets/blob_avatar.dart';
import '../widgets/bot_appearance_section.dart';
import 'chat_screen.dart';

import 'package:lucide_icons_flutter/lucide_icons.dart';

const _thinkingLevels = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

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
/// 模型配置未声明档位时使用内置七档。
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
      appBar: chromeAppBar(
        context,
        AppBar(
          flexibleSpace: const WindowDragArea(),
          toolbarHeight: 58,
          title: Text(L10n.s(context).t('bots.title')),
          actions: [
            IconButton(
              tooltip: L10n.s(context).t('bots.newBot'),
              onPressed: () => _createBot(context),
              icon: const Icon(LucideIcons.plus, size: 20),
            ),
            const SizedBox(width: 8),
          ],
        ),
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
                  L10n.s(context).tf('bots.intro', {'n': state.bots.length}),
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
        title: Text(L10n.s(ctx).t('bots.newBot')),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: emojiController,
                decoration: InputDecoration(
                  labelText: L10n.s(ctx).t('bots.emojiLabel'),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: nameController,
                autofocus: true,
                decoration: InputDecoration(
                  labelText: L10n.s(ctx).t('bots.nameLabel'),
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: personaController,
                maxLines: 4,
                decoration: InputDecoration(
                  labelText: L10n.s(ctx).t('bots.personaLabel'),
                  alignLabelWithHint: true,
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text(L10n.s(ctx).t('common.cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(L10n.s(ctx).t('bots.create')),
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
    final colors = PB.colors(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: () => _openBotSheet(context, bot),
          child: AvatarHoverScope(
            child: Padding(
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
                        ? Icon(
                            LucideIcons.shieldCheck,
                            size: 12,
                            color: colors.accentBright,
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
                                  color: colors.accentSoft,
                                  borderRadius: BorderRadius.circular(PB.rSm),
                                ),
                                child: Text(
                                  L10n.s(context).t('bots.manager'),
                                  style: TextStyle(
                                    fontSize: 9.5,
                                    color: colors.link,
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
                          L10n.s(context).tf('bots.modelSummary', {
                            'model':
                                bot.model ??
                                L10n.s(context).t('bots.defaultModel'),
                            'thinking': bot.thinking ?? '-',
                          }),
                          style: const TextStyle(
                            fontSize: PB.fsXxs,
                            color: PB.textQuaternary,
                            fontFamily: PB.monoFamily,
                            fontFamilyFallback: PB.monoFallback,
                          ),
                        ),
                        const SizedBox(height: 8),
                        BotAppearanceSection(key: ValueKey(bot.id), bot: bot),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: L10n.s(context).t('bots.dm'),
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
            ),
          ),
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
    var saving = false;
    String? saveError;
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
                                bot.isMain
                                    ? L10n.s(ctx).t('bots.manager')
                                    : bot.id,
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
                    BotAppearanceSection(key: ValueKey(bot.id), bot: bot),
                    const SizedBox(height: 20),
                    TextField(
                      controller: nameController,
                      decoration: InputDecoration(
                        labelText: L10n.s(ctx).t('bots.nameLabel'),
                      ),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: emojiController,
                      decoration: InputDecoration(
                        labelText: L10n.s(ctx).t('bots.emojiLabel'),
                      ),
                      onChanged: (_) => setLocal(() {}),
                    ),
                    const SizedBox(height: 10),
                    ModelPickerField(
                      controller: modelController,
                      onPicked: (_) => setLocal(() {
                        final levels = _levelsFor(
                          _modelSpecFor(
                            state.modelGroups,
                            modelController.text,
                          ),
                        );
                        if (levels.isNotEmpty && !levels.contains(thinking)) {
                          thinking = levels.first;
                        }
                      }),
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
                        return <Widget>[
                          const SizedBox(height: 12),
                          Text(
                            L10n.s(ctx).t('bots.thinkingOff'),
                            style: const TextStyle(
                              fontSize: PB.fsXxs,
                              color: PB.textQuaternary,
                              height: 1.5,
                            ),
                          ),
                        ];
                      }
                      return <Widget>[
                        const SizedBox(height: 14),
                        // 思考等级：滑条（和右侧面板同一套控件）
                        ThinkingLevelField(
                          levels: levels,
                          value: thinking,
                          onChanged: (level) =>
                              setLocal(() => thinking = level),
                        ),
                      ];
                    })(),
                    const SizedBox(height: 14),
                    // ★ MCP 能力：只列**已启用**的服务。
                    //   没启用的连都连不上，摆出来只会让人选了却没反应。
                    ...(() {
                      final available = state.mcpServers
                          .where((s) => s.enabled)
                          .toList();
                      if (available.isEmpty) {
                        return <Widget>[
                          Text(
                            L10n.s(ctx).t('bots.mcpSkills'),
                            style: const TextStyle(
                              fontSize: PB.fsXs,
                              color: PB.textTertiary,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            L10n.s(ctx).t('bots.mcpNone'),
                            style: const TextStyle(
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
                            Text(
                              L10n.s(ctx).t('bots.mcpSkills'),
                              style: const TextStyle(
                                fontSize: PB.fsXs,
                                color: PB.textTertiary,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Text(
                              pickedMcp.isEmpty
                                  ? L10n.s(ctx).t('bots.mcpNonePicked')
                                  : L10n.s(ctx).tf('bots.mcpPickedCount', {
                                      'n': pickedMcp.length,
                                    }),
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
                                selectedColor: PB.colors(ctx).accentSoft,
                                side: const BorderSide(
                                  color: PB.borderTertiary,
                                ),
                                labelStyle: TextStyle(
                                  color: pickedMcp.contains(server.name)
                                      ? PB.colors(ctx).link
                                      : PB.textTertiary,
                                  fontSize: PB.fsXs,
                                ),
                              ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        Text(
                          L10n.s(ctx).t('bots.mcpMemoryHint'),
                          style: const TextStyle(
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
                      decoration: InputDecoration(
                        labelText: L10n.s(ctx).t('bots.personaLabel'),
                        alignLabelWithHint: true,
                      ),
                    ),
                    const SizedBox(height: 18),
                    if (saveError != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: Text(
                          saveError!,
                          style: const TextStyle(color: PB.danger),
                        ),
                      ),
                    Row(
                      children: [
                        if (!bot.isMain)
                          Expanded(
                            child: TextButton(
                              onPressed: saving
                                  ? null
                                  : () async {
                                      Navigator.pop(ctx, false);
                                      await state.deleteBot(bot.id);
                                    },
                              child: Text(
                                L10n.s(ctx).t('common.delete'),
                                style: const TextStyle(color: PB.danger),
                              ),
                            ),
                          ),
                        const SizedBox(width: 10),
                        Expanded(
                          flex: 2,
                          child: FilledButton(
                            onPressed: saving
                                ? null
                                : () async {
                                    setLocal(() {
                                      saving = true;
                                      saveError = null;
                                    });
                                    try {
                                      final saved = await state.tryUpdateBot(
                                        bot.id,
                                        {
                                          'name': nameController.text.trim(),
                                          'emoji': emojiController.text.trim(),
                                          'persona': personaController.text,
                                          'model': modelController.text.trim(),
                                          'thinking': thinking,
                                          'mcpServers': pickedMcp,
                                        },
                                      );
                                      if (!saved) {
                                        if (ctx.mounted) {
                                          setLocal(() {
                                            saving = false;
                                            saveError = L10n.s(ctx)
                                                .t('bots.saveFailed');
                                          });
                                        }
                                        return;
                                      }
                                      if (ctx.mounted) Navigator.pop(ctx, true);
                                    } catch (_) {
                                      if (ctx.mounted)
                                        setLocal(() {
                                          saving = false;
                                          saveError = L10n.s(ctx)
                                              .t('bots.saveFailed');
                                        });
                                    }
                                  },
                            child: Text(
                              saving
                                  ? L10n.s(ctx).t('common.saving')
                                  : L10n.s(ctx).t('common.save'),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      L10n.s(ctx).t('bots.modelChangeHint'),
                      style: const TextStyle(
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
