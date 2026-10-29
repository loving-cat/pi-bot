import 'package:flutter/material.dart';

import 'package:pi_bot/api.dart';
import 'package:pi_bot/app_state.dart';
import 'package:pi_bot/models.dart';
import 'package:pi_bot/scope.dart';
import 'package:pi_bot/theme.dart';
import 'package:pi_bot/widgets/connections_section.dart';

/// 使用内存数据预览连接中心，不初始化宿主或访问外部服务。
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final state = AppState()
    ..api = _PreviewApi()
    ..policy = {'dangerous': 'ask'}
    ..bots = [
      Bot(id: 'preview-research', name: '资料助手'),
      Bot(id: 'preview-files', name: '文件助手'),
      Bot(id: 'preview-planning', name: '计划助手'),
    ];
  runApp(
    AppScope(
      state: state,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: PB.theme(),
        home: Scaffold(
          appBar: AppBar(
            title: const Text('连接中心预览'),
            actions: const [
              Padding(
                padding: EdgeInsets.all(16),
                child: Text(
                  '合成数据 · 不连接外部服务',
                  style: TextStyle(fontSize: PB.fsSm, color: PB.textTertiary),
                ),
              ),
            ],
          ),
          body: const Center(
            child: SizedBox(
              width: 980,
              child: SingleChildScrollView(
                padding: EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                child: ConnectionsSection(),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class _PreviewApi extends Api {
  _PreviewApi() : super('https://example.invalid', null);

  final _entries = <Map<String, dynamic>>[
    {
      'id': 'preview-library',
      'name': 'team_library',
      'type': 'http',
      'description': '搜索团队知识与项目资料',
      'url': 'https://example.com/library/mcp',
      'enabled': true,
      'credentialKeys': ['Authorization'],
      'hasCredentials': true,
      'assignedBotIds': ['preview-research'],
      'verification': {
        'state': 'ready',
        'checkedAt': DateTime.now().millisecondsSinceEpoch,
        'toolCount': 2,
        'tools': [
          {
            'name': 'search',
            'title': '搜索资料',
            'description': '按关键词查找团队共享的文档与笔记。',
          },
          {
            'name': 'read_document',
            'title': '阅读文档',
            'description': '读取指定资料的内容。',
          },
        ],
      },
    },
    {
      'id': 'preview-files',
      'name': 'local_files',
      'type': 'stdio',
      'description': '整理文件、读取内容和生成工作产物',
      'command': 'node',
      'args': ['file-tools.mjs'],
      'enabled': false,
      'assignedBotIds': [],
      'verification': {'state': 'unverified', 'tools': []},
    },
    {
      'id': 'preview-calendar',
      'name': 'project_calendar',
      'type': 'http',
      'description': '查看项目日程与关键节点',
      'url': 'https://example.com/calendar/mcp',
      'enabled': true,
      'assignedBotIds': ['preview-planning'],
      'hasCredentials': true,
      'credentialKeys': ['Authorization'],
      'verification': {
        'state': 'auth_required',
        'checkedAt': DateTime.now().millisecondsSinceEpoch,
        'tools': [],
        'error': '认证未通过，请检查已保存的凭据。',
      },
    },
  ];

  int _serial = 0;
  bool _imported = false;

  Map<String, dynamic> _find(String id) =>
      _entries.firstWhere((entry) => entry['id'] == id);
  String _id(String path) => Uri.decodeComponent(path.split('/')[3]);

  @override
  Future<Map<String, dynamic>> get(
    String path, {
    Map<String, String>? query,
  }) async {
    if (path == '/api/connections')
      return {
        'catalog': [
          {
            'id': 'remote_mcp',
            'name': '远程工具服务',
            'description': '使用服务地址与密钥连接工作应用',
            'category': 'remote',
            'type': 'http',
            'action': 'create',
          },
          {
            'id': 'local_mcp',
            'name': '本地工具服务',
            'description': '连接已安装在电脑上的工具',
            'category': 'local',
            'type': 'stdio',
            'action': 'create',
          },
          {
            'id': 'import_local',
            'name': '从本机导入',
            'description': '选择已有配置，无需重复填写',
            'category': 'local',
            'action': 'import',
          },
        ],
        'connections': _entries,
      };
    if (path == '/api/local-capabilities')
      return {
        'mcpServers': [
          {
            'name': 'document_tools',
            'type': 'stdio',
            'description': '文档读取与格式转换',
            'imported': _imported,
          },
        ],
      };
    if (path == '/api/mcp') return {'servers': _entries};
    throw ApiException('预览未提供此操作');
  }

  Map<String, dynamic> _verified() => {
    'ok': true,
    'state': 'ready',
    'checkedAt': DateTime.now().millisecondsSinceEpoch,
    'toolCount': 2,
    'tools': [
      {'name': 'search', 'title': '搜索内容', 'description': '按关键词查询此应用的内容。'},
      {'name': 'read', 'title': '读取内容', 'description': '读取选择的文档或记录。'},
    ],
  };

  @override
  Future<Map<String, dynamic>> post(
    String path, [
    Map<String, dynamic>? body,
  ]) async {
    if (path.endsWith('/verify') || path == '/api/mcp/test') {
      await Future<void>.delayed(const Duration(milliseconds: 650));
      final result = _verified();
      if (path.endsWith('/verify')) _find(_id(path))['verification'] = result;
      return result;
    }
    if (path == '/api/mcp') {
      final entry = <String, dynamic>{
        'id': 'preview-new-${++_serial}',
        'assignedBotIds': [],
      };
      _update(entry, body ?? {});
      _entries.add(entry);
      return {'server': entry};
    }
    if (path == '/api/local-capabilities/import') {
      if (_imported) return {'imported': [], 'skipped': []};
      _imported = true;
      _entries.add({
        'id': 'preview-imported',
        'name': 'document_tools',
        'type': 'stdio',
        'description': '文档读取与格式转换',
        'command': 'node',
        'args': ['document-tools.mjs'],
        'enabled': false,
        'assignedBotIds': [],
        'verification': {'state': 'unverified', 'tools': []},
      });
      return {
        'imported': ['document_tools'],
        'skipped': [],
      };
    }
    throw ApiException('预览未提供此操作');
  }

  void _update(Map<String, dynamic> entry, Map<String, dynamic> body) {
    for (final key in [
      'name',
      'type',
      'description',
      'enabled',
      'url',
      'command',
      'args',
      'cwd',
    ]) {
      if (body.containsKey(key)) entry[key] = body[key];
    }
    if (body['clearCredentials'] == true) {
      entry['hasCredentials'] = false;
      entry['credentialKeys'] = <String>[];
    }
    final values = body['headers'] ?? body['env'];
    if (values is Map && values.isNotEmpty) {
      entry['credentialKeys'] = values.keys.map((key) => '$key').toList();
      entry['hasCredentials'] = true;
    }
    entry['verification'] = {'state': 'unverified', 'tools': []};
  }

  @override
  Future<Map<String, dynamic>> patch(
    String path,
    Map<String, dynamic> body,
  ) async {
    final entry = _find(_id(path));
    _update(entry, body);
    return {'server': entry};
  }

  @override
  Future<Map<String, dynamic>> put(
    String path,
    Map<String, dynamic> body,
  ) async {
    final entry = _find(_id(path));
    entry['assignedBotIds'] = body['botIds'];
    return {'connection': entry};
  }

  @override
  Future<Map<String, dynamic>> delete(String path) async {
    _entries.removeWhere((entry) => entry['id'] == _id(path));
    return {'ok': true};
  }
}
