import 'connections_models.dart';

enum ConnectionFilter { all, remote, local, configured }

extension ConnectionFilterLabel on ConnectionFilter {
  String get label => switch (this) {
    ConnectionFilter.all => '全部',
    ConnectionFilter.remote => '远程服务',
    ConnectionFilter.local => '本地工具',
    ConnectionFilter.configured => '已配置',
  };
}

bool connectionMatches(
  AppConnection item,
  String query,
  ConnectionFilter filter,
) {
  if (filter == ConnectionFilter.remote && !item.server.isHttp) return false;
  if (filter == ConnectionFilter.local && item.server.isHttp) return false;
  final needle = query.trim().toLowerCase();
  return needle.isEmpty ||
      '${item.server.name} ${item.server.description}'.toLowerCase().contains(
        needle,
      );
}

bool catalogMatches(
  ConnectionCatalogItem item,
  String query,
  ConnectionFilter filter,
) {
  if (filter == ConnectionFilter.configured) return false;
  final isRemote = item.type == 'http' || item.id == 'remote_mcp';
  if (filter == ConnectionFilter.remote && !isRemote) return false;
  if (filter == ConnectionFilter.local && isRemote) return false;
  final needle = query.trim().toLowerCase();
  return needle.isEmpty ||
      '${item.name} ${item.description}'.toLowerCase().contains(needle);
}

/// 非空凭据只提交新增值；空白留给服务端保留，删除必须显式指定。
Map<String, String> connectionCredentialPatch(Iterable<(String, String)> rows) {
  final values = <String, String>{};
  for (final (name, value) in rows) {
    final key = name.trim();
    if (key.isEmpty && value.isEmpty) continue;
    if (key.isEmpty) throw const FormatException('请填写凭据名称');
    if (key.contains('=') || key.contains('\n') || key.contains('\r')) {
      throw const FormatException('凭据名称不能包含等号或换行');
    }
    if (value.trim().isEmpty) continue;
    if (value.contains('\n') || value.contains('\r')) {
      throw const FormatException('凭据值不能包含换行');
    }
    if (values.containsKey(key)) throw const FormatException('凭据名称不能重复');
    values[key] = value;
  }
  return values;
}

String connectionCheckedAt(int? value) {
  if (value == null || value <= 0) return '还没有验证记录';
  final dt = DateTime.fromMillisecondsSinceEpoch(value);
  String two(int n) => n.toString().padLeft(2, '0');
  return '${dt.month}/${dt.day} ${two(dt.hour)}:${two(dt.minute)} 验证';
}
