import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme.dart';
import 'blob_avatar.dart';

/// 会话系统行的人员摘要；最多显示两人，其余以数量表示，完整名单可悬停查看。
class ConversationPeople extends StatelessWidget {
  const ConversationPeople({
    super.key,
    required this.prefix,
    required this.people,
    required this.suffix,
    this.fallback = '',
  });

  final String prefix;
  final List<({String id, String name})> people;
  final String suffix;
  final String fallback;

  @override
  Widget build(BuildContext context) {
    const style = TextStyle(fontSize: PB.fsXs, color: PB.textQuaternary);
    return LayoutBuilder(
      builder: (context, constraints) {
        final maxNameWidth = math.min(160.0, constraints.maxWidth);
        return Tooltip(
          message: people.isEmpty
              ? fallback
              : people.map((person) => person.name).join('、'),
          child: Wrap(
            alignment: WrapAlignment.center,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 6,
            runSpacing: 4,
            children: [
              Text(prefix, style: style),
              if (people.isEmpty)
                ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: maxNameWidth),
                  child: Text(
                    fallback,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: style.copyWith(color: PB.textSecondary),
                  ),
                ),
              for (final person in people.take(2))
                ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: maxNameWidth),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      BlobAvatar(
                        seed: person.id,
                        color: PB.colorFor(person.id),
                        size: 16,
                        animate: false,
                      ),
                      const SizedBox(width: 4),
                      Flexible(
                        child: Text(
                          person.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: style.copyWith(color: PB.textSecondary),
                        ),
                      ),
                    ],
                  ),
                ),
              if (people.length > 2)
                Text('+${people.length - 2}', style: style),
              if (suffix.isNotEmpty) Text(suffix, style: style),
            ],
          ),
        );
      },
    );
  }
}
