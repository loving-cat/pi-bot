import 'package:flutter/material.dart';

import 'connections_section.dart';

/// 兼容已有 MCP 面板入口，统一展示应用连接中心。
class McpSection extends StatelessWidget {
  const McpSection({super.key});

  @override
  Widget build(BuildContext context) => const ConnectionsSection();
}
