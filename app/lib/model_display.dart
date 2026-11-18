import '../models.dart';

/// 精简且可区分模型组的模型展示信息。
class CompactModelInfo {
  const CompactModelInfo({
    required this.groupId,
    required this.groupName,
    required this.groupTag,
    required this.modelId,
    required this.modelLabel,
    required this.fullSlug,
  });

  final String groupId;
  final String groupName;
  final String groupTag;
  final String modelId;
  final String modelLabel;
  final String fullSlug;

  bool get isEmpty => fullSlug.isEmpty;
  bool get hasGroup => groupTag.isNotEmpty;

  /// 形如 `硅基 · DeepSeek-V3`；无所属组时仅返回精简模型名。
  String get combined {
    if (groupTag.isEmpty) return modelLabel;
    if (modelLabel.isEmpty) return groupTag;
    return '$groupTag · $modelLabel';
  }
}

const _vendorNamespaces = <String>{
  'accounts',
  'publishers',
  'models',
  'deepseek-ai',
  'anthropic',
  'openai',
  'qwen',
  'meta-llama',
  'google',
  'mistralai',
  'x-ai',
  'thudm',
  'zhipuai',
  'moonshot',
  'volces',
  'baichuan-inc',
};

final _routePrefixRe = RegExp(
  r'^(?:accounts/[^/]+/models/|publishers/[^/]+/models/|models/)',
  caseSensitive: false,
);
final _dateSuffixRe = RegExp(r'(?:@|-|_)?20\d{2}(?:-?\d{2}){2}$');
final _instructSuffixRe = RegExp(r'(?:-|_)?instruct$', caseSensitive: false);
final _cjkRe = RegExp(r'[\u4e00-\u9fff]');
final _groupGenericSuffixRe = RegExp(
  r'(?:\s|-|_)*(?:模型组|分组|渠道|供应商|服务商|接口|账号|provider|group|models|api)$',
  caseSensitive: false,
);

/// 将冗长的模型 ID/路由裁剪为简短可读的核心模型名（保留 `:free` 等变体后缀）。
String shortenModelName(String rawModel, {String specName = ''}) {
  var body = rawModel.trim();
  if (body.isEmpty) return '';

  // 先剥出 `:variant` 后缀（例如 OpenRouter 的 `:free` / `:thinking`）
  var variant = '';
  final lastSlash = body.lastIndexOf('/');
  final colonIdx = body.lastIndexOf(':');
  if (colonIdx > lastSlash && colonIdx > 0) {
    variant = body.substring(colonIdx);
    body = body.substring(0, colonIdx);
  }

  body = body.replaceFirst(_routePrefixRe, '');
  if (body.contains('/')) {
    final segments = body.split('/').where((s) => s.isNotEmpty).toList();
    if (segments.length >= 2) {
      final first = segments.first.toLowerCase();
      if (_vendorNamespaces.contains(first) || segments.length > 2) {
        body = segments.last;
      }
    }
  }

  body = body.replaceFirst(_dateSuffixRe, '').trim();
  if (body.length > 22) {
    body = body.replaceFirst(_instructSuffixRe, '').trim();
  }

  final cleanedId = '$body$variant'.trim();
  final cleanSpec = specName.trim();
  if (cleanSpec.isNotEmpty &&
      !cleanSpec.contains('/') &&
      cleanSpec.length <= cleanedId.length) {
    return cleanSpec;
  }
  return cleanedId.isEmpty ? rawModel.trim() : cleanedId;
}

String _compactText(String text, int maxRunes) {
  final runes = text.runes.toList();
  if (runes.length <= maxRunes) return text;
  return String.fromCharCodes(runes.take(maxRunes));
}

String _shortenGroupStem(String rawName) {
  var stem = rawName.trim();
  while (stem.isNotEmpty) {
    final next = stem.replaceFirst(_groupGenericSuffixRe, '').trim();
    if (next.isEmpty || next == stem) break;
    stem = next;
  }
  if (stem.isEmpty) stem = rawName.trim();
  final limit = _cjkRe.hasMatch(stem) ? 6 : 10;
  return _compactText(stem, limit);
}

String _fallbackGroupTag(String groupId) {
  final id = groupId.trim();
  if (id.isEmpty) return '';
  if ((id.startsWith('mg_') || id.startsWith('grp_')) && id.length > 8) {
    return '#${id.substring(id.length - 4)}';
  }
  return _compactText(id, 10);
}

/// 为当前模型组列表生成短小且彼此不重名的简称映射（`groupId -> groupTag`）。
Map<String, String> buildDistinctGroupTags(List<ModelGroup> groups) {
  final base = <String, String>{
    for (final g in groups) g.id: _shortenGroupStem(g.name),
  };
  final byTag = <String, List<ModelGroup>>{};
  for (final g in groups) {
    byTag.putIfAbsent(base[g.id]!, () => []).add(g);
  }

  final resolved = <String, String>{};
  for (final entry in byTag.entries) {
    final bucket = entry.value;
    if (bucket.length == 1) {
      resolved[bucket.single.id] = entry.key;
      continue;
    }

    // 多组冲突：先算原始组名的公共前缀，保留各自差异尾部以区分
    final names = [for (final g in bucket) g.name.trim()];
    var prefix = names.first;
    for (final name in names.skip(1)) {
      var k = 0;
      final n = prefix.length < name.length ? prefix.length : name.length;
      while (k < n && prefix.codeUnitAt(k) == name.codeUnitAt(k)) {
        k++;
      }
      prefix = prefix.substring(0, k);
    }

    final seen = <String>{};
    for (var i = 0; i < bucket.length; i++) {
      final g = bucket[i];
      final full = g.name.trim();
      final tail = full.length > prefix.length
          ? full.substring(prefix.length).replaceFirst(RegExp(r'^[\s\-_·]+'), '')
          : '';
      String candidate;
      if (tail.isNotEmpty && entry.key.isNotEmpty) {
        final stemHead = _compactText(entry.key, _cjkRe.hasMatch(entry.key) ? 4 : 7);
        final diffPart = _compactText(tail, _cjkRe.hasMatch(tail) ? 3 : 4);
        candidate = '$stemHead·$diffPart';
      } else {
        final idTail = g.id.length > 3 ? g.id.substring(g.id.length - 3) : '${i + 1}';
        candidate = '${entry.key}#$idTail';
      }
      if (!seen.add(candidate)) {
        candidate = '${entry.key}#${i + 1}';
        seen.add(candidate);
      }
      resolved[g.id] = candidate;
    }
  }
  return resolved;
}

/// 将 `groupId/modelId` 或裸 `modelId` 整理为「组简称 + 精简模型名」。
CompactModelInfo compactModelDisplay(String? slug, List<ModelGroup> groups) {
  final raw = (slug ?? '').trim();
  if (raw.isEmpty) {
    return const CompactModelInfo(
      groupId: '',
      groupName: '',
      groupTag: '',
      modelId: '',
      modelLabel: '',
      fullSlug: '',
    );
  }

  final tags = buildDistinctGroupTags(groups);
  ModelGroup? matchedGroup;
  ModelSpec? matchedSpec;
  var groupId = '';
  var rawModelId = raw;

  final slash = raw.indexOf('/');
  if (slash > 0) {
    final candGid = raw.substring(0, slash).trim();
    final candMid = raw.substring(slash + 1).trim();
    for (final g in groups) {
      if (g.id == candGid) {
        matchedGroup = g;
        groupId = g.id;
        rawModelId = candMid;
        for (final m in g.models) {
          if (m.id == candMid) {
            matchedSpec = m;
            break;
          }
        }
        break;
      }
    }
    if (matchedGroup == null) {
      // 检查是否恰好某个组内完整存了含 `/` 的 model.id
      final hits = <(ModelGroup, ModelSpec)>[
        for (final g in groups)
          for (final m in g.models)
            if (m.id == raw) (g, m),
      ];
      if (hits.length == 1) {
        matchedGroup = hits.single.$1;
        matchedSpec = hits.single.$2;
        groupId = matchedGroup.id;
      } else if (!_vendorNamespaces.contains(candGid.toLowerCase())) {
        // 离线或尚未拉到 modelGroups 时，保留前缀作为未命名组标识
        groupId = candGid;
        rawModelId = candMid;
      }
    }
  } else {
    final hits = <(ModelGroup, ModelSpec)>[
      for (final g in groups)
        for (final m in g.models)
          if (m.id == raw) (g, m),
    ];
    if (hits.length == 1) {
      matchedGroup = hits.single.$1;
      matchedSpec = hits.single.$2;
      groupId = matchedGroup.id;
    }
  }

  final groupName = matchedGroup?.name ?? groupId;
  final groupTag = matchedGroup != null
      ? (tags[matchedGroup.id] ?? _shortenGroupStem(matchedGroup.name))
      : _fallbackGroupTag(groupId);
  final modelLabel = shortenModelName(
    rawModelId,
    specName: matchedSpec?.name ?? '',
  );

  return CompactModelInfo(
    groupId: groupId,
    groupName: groupName,
    groupTag: groupTag,
    modelId: rawModelId,
    modelLabel: modelLabel,
    fullSlug: raw,
  );
}
