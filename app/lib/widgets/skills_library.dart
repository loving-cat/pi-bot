import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../app_state.dart';
import '../models.dart';
import '../motion.dart';
import '../scope.dart';
import '../theme.dart';
import 'local_capabilities_section.dart';

/// 技能库面板（设置在「技能」标签页里）。
///
/// 一条技能就是一套做法（SOP）：库是全局的、所有 bot 共享，
/// 主控按任务挑相关的几条注入，而不是把整个库塞进每个 bot 的提示词。
///
/// 支持两种录入方式：
///   · 手填（标题 + 一句话说明 + 做法）
///   · 导入 `SKILL.md`（带 frontmatter 的 markdown，解析在服务端做，
///     保证导入和手填走同一套规范化）
class SkillsLibrarySection extends StatefulWidget {
  const SkillsLibrarySection({super.key});

  @override
  State<SkillsLibrarySection> createState() => _SkillsLibrarySectionState();
}

class _SkillsLibrarySectionState extends State<SkillsLibrarySection> {
  final _search = TextEditingController();
  String _query = '';

  @override
  void initState() {
    super.initState();
    // 打开就拉一次（幂等，已有数据也会刷新）
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AppScope.of(context).loadSkills();
    });
    _search.addListener(() {
      if (_search.text == _query) return;
      setState(() => _query = _search.text);
    });
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final all = state.skills;
    final list = _query.trim().isEmpty
        ? all
        : all.where((s) => s.matches(_query)).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 用户在终端里装过的 skill，一键导进来（只读扫描，不改他的配置）
        const LocalCapabilitiesSection(kind: 'skill', title: '技能'),
        _Toolbar(
          total: all.length,
          shown: list.length,
          search: _search,
          onAdd: () => _editSkill(context, state, null),
          onImport: () => _importFiles(context, state),
        ),
        const SizedBox(height: 12),
        if (!state.skillsLoaded)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 30),
            child: Center(
              child: SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          )
        else if (all.isEmpty)
          _EmptyHint(onAdd: () => _editSkill(context, state, null))
        else if (list.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Text(
              '没有匹配「$_query」的技能',
              style: const TextStyle(fontSize: PB.fsSm, color: PB.textTertiary),
            ),
          )
        else
          ...list.map(
            (skill) => _SkillCard(
              key: ValueKey(skill.id),
              skill: skill,
              onEdit: () => _editSkill(context, state, skill),
              onToggle: (v) async {
                final err = await state.updateSkill(skill.id, enabled: v);
                if (err != null && context.mounted) _toast(context, err);
              },
              onDelete: () => _confirmDelete(context, state, skill),
            ),
          ),
      ],
    );
  }

  void _toast(BuildContext context, String text) {
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _confirmDelete(
    BuildContext context,
    AppState state,
    LibrarySkill skill,
  ) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: PB.bgElevated,
        title: const Text('删掉这条技能？', style: TextStyle(fontSize: PB.fsLg)),
        content: Text(
          '「${skill.title}」会从库里移除。已经分给 bot 的那份不受影响。',
          style: const TextStyle(
            fontSize: PB.fsSm,
            color: PB.textSecondary,
            height: 1.6,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(backgroundColor: PB.danger),
            child: const Text('删掉'),
          ),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    final err = await state.removeSkill(skill.id);
    if (err != null && context.mounted) _toast(context, err);
  }

  /// 新增 / 编辑：手填表单
  Future<void> _editSkill(
    BuildContext context,
    AppState state,
    LibrarySkill? skill,
  ) async {
    final title = TextEditingController(text: skill?.title ?? '');
    final summary = TextEditingController(text: skill?.summary ?? '');
    final howto = TextEditingController(text: skill?.howto ?? '');
    final tags = TextEditingController(text: (skill?.tags ?? []).join('、'));
    String? error;

    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setLocal) => AlertDialog(
          backgroundColor: PB.bgElevated,
          title: Text(
            skill == null ? '新建技能' : '编辑技能',
            style: const TextStyle(fontSize: PB.fsLg),
          ),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    '技能是给 bot 看的「做法」：什么时候用、具体怎么做。\n'
                    '存进库之后，主控会按任务挑相关的几条交给干活的 bot。',
                    style: TextStyle(
                      fontSize: PB.fsXs,
                      color: PB.textTertiary,
                      height: 1.6,
                    ),
                  ),
                  const SizedBox(height: 14),
                  TextField(
                    controller: title,
                    autofocus: true,
                    decoration: const InputDecoration(
                      labelText: '标题',
                      hintText: '如：线上排查三步',
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: summary,
                    decoration: const InputDecoration(
                      labelText: '一句话说明（选填）',
                      hintText: '如：线上出问题先走这个',
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: tags,
                    decoration: const InputDecoration(
                      labelText: '标签（选填）',
                      hintText: '用顿号或逗号分隔，如：运维、发版',
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: howto,
                    minLines: 6,
                    maxLines: 12,
                    decoration: const InputDecoration(
                      labelText: '具体怎么做',
                      hintText: '1. 先看 server.log\n2. 再看 pid\n3. 看端口有没有被占',
                      alignLabelWithHint: true,
                    ),
                  ),
                  if (error != null) ...[
                    const SizedBox(height: 10),
                    Text(
                      error!,
                      style: const TextStyle(
                        fontSize: PB.fsXs,
                        color: PB.danger,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () async {
                final t = title.text.trim();
                if (t.isEmpty) {
                  setLocal(() => error = '标题不能为空');
                  return;
                }
                final tagList = tags.text
                    .split(RegExp(r'[、,，]'))
                    .map((x) => x.trim())
                    .where((x) => x.isNotEmpty)
                    .toList();
                final err = skill == null
                    ? await state.addSkill(
                        title: t,
                        summary: summary.text.trim(),
                        howto: howto.text.trim(),
                        tags: tagList,
                      )
                    : await state.updateSkill(
                        skill.id,
                        title: t,
                        summary: summary.text.trim(),
                        howto: howto.text.trim(),
                        tags: tagList,
                      );
                if (err != null) {
                  setLocal(() => error = err);
                  return;
                }
                if (ctx.mounted) Navigator.pop(ctx, true);
              },
              child: const Text('保存'),
            ),
          ],
        ),
      ),
    );

    title.dispose();
    summary.dispose();
    howto.dispose();
    tags.dispose();
    if (saved == true && context.mounted) _toast(context, '已保存');
  }

  /// 导入 SKILL.md：读文本 → 交给服务端解析（规则只有一份）
  Future<void> _importFiles(BuildContext context, AppState state) async {
    final picked = await _pickMarkdownFiles();
    if (picked == null || picked.isEmpty) return;
    if (!context.mounted) return;

    final res = await state.importSkillFiles(picked);
    if (!context.mounted) return;
    final lines = <String>[];
    if (res.imported > 0) lines.add('导入成功 ${res.imported} 条');
    if (res.skipped.isNotEmpty) {
      lines.add('跳过 ${res.skipped.length} 条：');
      lines.addAll(res.skipped.take(6));
    }
    _toast(context, lines.isEmpty ? '没有可导入的内容' : lines.join('\n'));
  }
}

/// 让用户选 markdown 文件并读出内容。
///
/// 之所以在这里落地而不是放 app_state：读文件是界面动作，
/// 状态层只该关心"拿到内容之后怎么存"。
Future<List<({String name, String text})>?> _pickMarkdownFiles() async {
  try {
    final result = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      type: FileType.custom,
      allowedExtensions: const ['md', 'markdown', 'txt'],
      withData: true,
    );
    if (result == null || result.files.isEmpty) return null;
    final out = <({String name, String text})>[];
    for (final f in result.files) {
      final bytes = f.bytes;
      if (bytes == null) continue;
      // 统一按 UTF-8 读；带 BOM 的会在服务端解析时去掉
      out.add((name: f.name, text: utf8.decode(bytes, allowMalformed: true)));
    }
    return out;
  } catch (_) {
    return null;
  }
}

/// 顶部工具条：搜索 + 新建 + 导入
class _Toolbar extends StatelessWidget {
  const _Toolbar({
    required this.total,
    required this.shown,
    required this.search,
    required this.onAdd,
    required this.onImport,
  });

  final int total;
  final int shown;
  final TextEditingController search;
  final VoidCallback onAdd;
  final VoidCallback onImport;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: SizedBox(
            height: 34,
            child: TextField(
              controller: search,
              style: const TextStyle(fontSize: PB.fsSm),
              decoration: InputDecoration(
                isDense: true,
                prefixIcon: const Icon(LucideIcons.search, size: 15),
                prefixIconConstraints: const BoxConstraints(minWidth: 32),
                hintText: total == 0 ? '技能库是空的' : '搜标题 / 标签 / 内容（共 $total 条）',
                hintStyle: const TextStyle(
                  fontSize: PB.fsXs,
                  color: PB.textQuaternary,
                ),
                contentPadding: const EdgeInsets.symmetric(vertical: 8),
              ),
            ),
          ),
        ),
        const SizedBox(width: 8),
        _SmallButton(
          icon: LucideIcons.upload,
          label: '导入',
          onTap: onImport,
          tooltip: '导入 SKILL.md（可多选）',
        ),
        const SizedBox(width: 6),
        _SmallButton(
          icon: LucideIcons.plus,
          label: '新建',
          onTap: onAdd,
          filled: true,
        ),
      ],
    );
  }
}

class _SmallButton extends StatelessWidget {
  const _SmallButton({
    required this.icon,
    required this.label,
    required this.onTap,
    this.filled = false,
    this.tooltip,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool filled;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final btn = filled
        ? FilledButton.icon(
            onPressed: onTap,
            icon: Icon(icon, size: 14),
            label: Text(label, style: const TextStyle(fontSize: PB.fsXs)),
            style: FilledButton.styleFrom(
              minimumSize: const Size(0, 34),
              padding: const EdgeInsets.symmetric(horizontal: 12),
            ),
          )
        : OutlinedButton.icon(
            onPressed: onTap,
            icon: Icon(icon, size: 14),
            label: Text(label, style: const TextStyle(fontSize: PB.fsXs)),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(0, 34),
              padding: const EdgeInsets.symmetric(horizontal: 12),
              foregroundColor: PB.textSecondary,
              side: const BorderSide(color: PB.borderSecondary),
            ),
          );
    return tooltip == null ? btn : Tooltip(message: tooltip!, child: btn);
  }
}

/// 库是空的时给个明确的下一步
class _EmptyHint extends StatelessWidget {
  const _EmptyHint({required this.onAdd});

  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 34, horizontal: 20),
      decoration: BoxDecoration(
        color: PB.bgPane,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: PB.borderSecondary),
      ),
      child: Column(
        children: [
          const Icon(LucideIcons.sparkles, size: 26, color: PB.textQuaternary),
          const SizedBox(height: 12),
          const Text(
            '还没有技能',
            style: TextStyle(fontSize: PB.fsSm, color: PB.textSecondary),
          ),
          const SizedBox(height: 6),
          const Text(
            '技能是一套做法：什么时候用、具体怎么做。\n'
            '存进来之后，主控会按任务挑相关的交给干活的 bot。\n'
            '也可以直接导入现成的 SKILL.md 文件。',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: PB.fsXs,
              color: PB.textTertiary,
              height: 1.7,
            ),
          ),
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: onAdd,
            icon: const Icon(LucideIcons.plus, size: 15),
            label: const Text('建第一条', style: TextStyle(fontSize: PB.fsXs)),
            style: FilledButton.styleFrom(minimumSize: const Size(0, 34)),
          ),
        ],
      ),
    );
  }
}

/// 一条技能：折叠显示摘要，展开看做法
class _SkillCard extends StatefulWidget {
  const _SkillCard({
    super.key,
    required this.skill,
    required this.onEdit,
    required this.onToggle,
    required this.onDelete,
  });

  final LibrarySkill skill;
  final VoidCallback onEdit;
  final ValueChanged<bool> onToggle;
  final VoidCallback onDelete;

  @override
  State<_SkillCard> createState() => _SkillCardState();
}

class _SkillCardState extends State<_SkillCard> {
  bool _open = false;
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = widget.skill;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedContainer(
        duration: Motion.fast,
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(
          color: _hover ? PB.bgHover : PB.bgPane,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: PB.borderSecondary),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            InkWell(
              borderRadius: BorderRadius.circular(10),
              onTap: () => setState(() => _open = !_open),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
                child: Row(
                  children: [
                    AnimatedRotation(
                      turns: _open ? 0.25 : 0,
                      duration: Motion.fast,
                      curve: Motion.inC,
                      child: const Icon(
                        LucideIcons.chevronRight,
                        size: 15,
                        color: PB.textQuaternary,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Flexible(
                                child: Text(
                                  s.title,
                                  style: TextStyle(
                                    fontSize: PB.fsSm,
                                    color: s.enabled
                                        ? PB.textPrimary
                                        : PB.textQuaternary,
                                    decoration: s.enabled
                                        ? null
                                        : TextDecoration.lineThrough,
                                  ),
                                ),
                              ),
                              if (s.tags.isNotEmpty) ...[
                                const SizedBox(width: 8),
                                ...s.tags
                                    .take(3)
                                    .map(
                                      (t) => Padding(
                                        padding: const EdgeInsets.only(
                                          right: 4,
                                        ),
                                        child: _Tag(text: t),
                                      ),
                                    ),
                              ],
                            ],
                          ),
                          if (s.summary.isNotEmpty) ...[
                            const SizedBox(height: 2),
                            Text(
                              s.summary,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: PB.fsXxs,
                                color: PB.textTertiary,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (_hover || _open) ...[
                      _IconBtn(
                        icon: LucideIcons.pencil,
                        tooltip: '编辑',
                        onTap: widget.onEdit,
                      ),
                      _IconBtn(
                        icon: LucideIcons.trash2,
                        tooltip: '删除',
                        onTap: widget.onDelete,
                        danger: true,
                      ),
                      Transform.scale(
                        scale: 0.8,
                        child: Switch(
                          value: s.enabled,
                          onChanged: widget.onToggle,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            AnimatedCrossFade(
              firstChild: const SizedBox(width: double.infinity),
              secondChild: Container(
                width: double.infinity,
                padding: const EdgeInsets.fromLTRB(35, 0, 12, 12),
                child: SelectableText(
                  s.howto.isEmpty ? '（还没写做法）' : s.howto,
                  style: TextStyle(
                    fontSize: PB.fsXs,
                    color: s.howto.isEmpty
                        ? PB.textQuaternary
                        : PB.textSecondary,
                    height: 1.7,
                  ),
                ),
              ),
              crossFadeState: _open
                  ? CrossFadeState.showSecond
                  : CrossFadeState.showFirst,
              duration: Motion.base,
              sizeCurve: Motion.move,
            ),
          ],
        ),
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(
        color: PB.bgActive,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        text,
        style: const TextStyle(fontSize: 10, color: PB.textTertiary),
      ),
    );
  }
}

class _IconBtn extends StatelessWidget {
  const _IconBtn({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.danger = false,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: Icon(
            icon,
            size: 14,
            color: danger ? PB.danger : PB.textTertiary,
          ),
        ),
      ),
    );
  }
}
