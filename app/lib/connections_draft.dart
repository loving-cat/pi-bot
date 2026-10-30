import 'connections_filters.dart';

/// 验证表单草稿并生成增量配置；未填写的凭据不进入请求。
Map<String, dynamic> connectionDraftPatch({
  String? id,
  required String name,
  required String type,
  required String description,
  required bool enabled,
  required String url,
  required String command,
  required String args,
  required String cwd,
  required Iterable<(String, String)> credentials,
  required bool clearCredentials,
}) {
  final normalizedName = name.trim();
  if (!RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$').hasMatch(normalizedName)) {
    throw const FormatException('名称请用 1–40 位字母、数字、下划线或短横线');
  }
  if (type != 'http' && type != 'stdio') throw const FormatException('请选择连接方式');
  if (type == 'http' && url.trim().isEmpty)
    throw const FormatException('请填写服务地址');
  if (type == 'stdio' && command.trim().isEmpty)
    throw const FormatException('请填写启动命令');
  final values = connectionCredentialPatch(credentials);
  return {
    if (id != null) 'id': id,
    'name': normalizedName,
    'description': description.trim(),
    'type': type,
    'enabled': enabled,
    if (type == 'http') 'url': url.trim(),
    if (type == 'stdio') ...{
      'command': command.trim(),
      'args': args
          .split('\n')
          .map((a) => a.trim())
          .where((a) => a.isNotEmpty)
          .toList(),
      'cwd': cwd.trim(),
    },
    if (values.isNotEmpty) (type == 'http' ? 'headers' : 'env'): values,
    if (clearCredentials) 'clearCredentials': true,
  };
}
