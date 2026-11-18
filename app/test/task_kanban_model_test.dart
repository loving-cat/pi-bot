import 'package:flutter_test/flutter_test.dart';
import 'package:pi_bot/task_kanban_model.dart';
import 'package:pi_bot/task_run_models.dart';

/// 造一条 TaskRun 的最小夹具：只填看板用得到的字段。
TaskRun run({
  String id = 't1',
  String state = 'running',
  String title = '搭好看板',
  String scope = '把任务列成四列',
  String stateText = '',
  String blockedReason = '',
  TaskRunWaiting? waiting,
  List<String> deliverables = const [],
  String leadBotName = '架构师',
  String leadBotId = 'b1',
  int updatedAt = 1000,
  int sequence = 1,
}) {
  return TaskRun(
    id: id,
    roomId: 'r1',
    rootTaskId: id,
    parentTaskId: null,
    revision: 1,
    sequence: sequence,
    storeVersion: 1,
    state: state,
    stateText: stateText,
    title: title,
    scope: scope,
    deliverables: deliverables,
    verificationCount: 0,
    unmet: const [],
    waiting: waiting,
    blockedReason: blockedReason,
    phase: 'active',
    budget: const TaskRunBudget(),
    result: const TaskRunResult(),
    admissionStatus: null,
    updatedAt: updatedAt,
    leadBotId: leadBotId,
    leadBotName: leadBotName,
  );
}

void main() {
  group('状态 → 四列', () {
    test('11 个状态全覆盖，且与服务端 phase 投影口径一致', () {
      const expected = {
        'queued': KanbanColumn.todo,
        'paused_user': KanbanColumn.todo,
        'running': KanbanColumn.doing,
        'verifying': KanbanColumn.doing,
        'waiting_dependency': KanbanColumn.doing,
        'waiting_approval': KanbanColumn.needsYou,
        'waiting_input': KanbanColumn.needsYou,
        'blocked': KanbanColumn.needsYou,
        'paused_budget': KanbanColumn.needsYou,
        'completed': KanbanColumn.done,
        'cancelled': KanbanColumn.done,
      };
      expect(expected.length, 11);
      expected.forEach((state, column) {
        expect(kanbanColumnOf(state), column, reason: '$state 应该落 ${column.name}');
      });
    });

    test('未知状态落到「进行中」，不抛错也不丢卡', () {
      expect(kanbanColumnOf('some_future_state'), KanbanColumn.doing);
      final cards = buildKanbanCards([run(state: 'some_future_state')]);
      expect(cards.length, 1);
      expect(cards.single.column, KanbanColumn.doing);
    });

    test('列权重：等你处理 → 进行中 → 待办 → 已完成', () {
      expect(kanbanRankOf(KanbanColumn.needsYou), 0);
      expect(kanbanRankOf(KanbanColumn.doing), 1);
      expect(kanbanRankOf(KanbanColumn.todo), 2);
      expect(kanbanRankOf(KanbanColumn.done), 3);
    });
  });

  group('归类不丢信息', () {
    test('进来多少条就出多少张卡，id 集合一致', () {
      final runs = [
        run(id: 'a', state: 'queued'),
        run(id: 'b', state: 'running'),
        run(id: 'c', state: 'waiting_approval'),
        run(id: 'd', state: 'completed'),
        run(id: 'e', state: 'weird'),
      ];
      final cards = buildKanbanCards(runs);
      expect(cards.length, runs.length);
      expect(cards.map((c) => c.id).toSet(), runs.map((r) => r.id).toSet());
    });

    test('分桶后四列都在，空列是空列表而不是 null', () {
      final cards = buildKanbanCards([run(state: 'running')]);
      final columns = groupKanbanCards(cards);
      expect(columns.length, 4);
      for (final c in KanbanColumn.values) {
        expect(columns[c], isNotNull, reason: '${c.name} 必须存在');
      }
      expect(columns[KanbanColumn.done], isEmpty);
    });

    test('统计与分桶一致，总数等于卡片数', () {
      final cards = buildKanbanCards([
        run(id: 'a', state: 'queued'),
        run(id: 'b', state: 'running'),
        run(id: 'c', state: 'waiting_input'),
        run(id: 'd', state: 'completed'),
      ]);
      final stats = KanbanStats.of(groupKanbanCards(cards));
      expect(stats.todo, 1);
      expect(stats.doing, 1);
      expect(stats.needsYou, 1);
      expect(stats.done, 1);
      expect(stats.total, cards.length);
    });

    test('空看板：零卡片、零统计', () {
      final cards = buildKanbanCards(const []);
      expect(cards, isEmpty);
      expect(KanbanStats.of(groupKanbanCards(cards)).total, 0);
    });
  });

  group('排序', () {
    test('「等你处理」整体排在前面，已完成永远在最后', () {
      final cards = buildKanbanCards([
        run(id: 'done', state: 'completed', updatedAt: 9000),
        run(id: 'todo', state: 'queued', updatedAt: 8000),
        run(id: 'doing', state: 'running', updatedAt: 7000),
        run(id: 'need', state: 'waiting_input', updatedAt: 1000),
      ]);
      expect(cards.map((c) => c.id).toList(), ['need', 'doing', 'todo', 'done']);
    });

    test('「等你处理」内部：要确认的比要回话的急，比卡住的更急', () {
      final cards = buildKanbanCards([
        run(id: 'budget', state: 'paused_budget'),
        run(id: 'blocked', state: 'blocked'),
        run(id: 'input', state: 'waiting_input'),
        run(id: 'approval', state: 'waiting_approval'),
      ]);
      expect(cards.map((c) => c.id).toList(), ['approval', 'input', 'blocked', 'budget']);
    });

    test('同列内按更新时间倒序，时间相同用 id 兜底保证稳定', () {
      final cards = buildKanbanCards([
        run(id: 'b', state: 'running', updatedAt: 100),
        run(id: 'a', state: 'running', updatedAt: 100),
        run(id: 'c', state: 'running', updatedAt: 300),
      ]);
      expect(cards.map((c) => c.id).toList(), ['c', 'a', 'b']);
    });

    test('「只看等我的」只留 needsYou 列', () {
      final cards = buildKanbanCards(
        [
          run(id: 'a', state: 'running'),
          run(id: 'b', state: 'waiting_approval'),
          run(id: 'c', state: 'completed'),
        ],
        onlyNeedsYou: true,
      );
      expect(cards.length, 1);
      expect(cards.single.id, 'b');
      expect(cards.single.needsYou, isTrue);
    });
  });

  group('截断', () {
    test('超长标题按字符截断并带省略号', () {
      final long = '把' * 100;
      final card = buildKanbanCards([run(title: long)]).single;
      expect(card.title.runes.length, kKanbanTitleMaxChars + 1);
      expect(card.title.endsWith('…'), isTrue);
    });

    test('正好等于上限时不加省略号（边界不能被截）', () {
      final exact = 'a' * kKanbanTitleMaxChars;
      final card = buildKanbanCards([run(title: exact)]).single;
      expect(card.title, exact);
    });

    test('emoji 按 rune 截断，不会切出半个代理对', () {
      final emoji = '🚀' * 60;
      final card = buildKanbanCards([run(title: emoji)]).single;
      expect(card.title.runes.length, kKanbanTitleMaxChars + 1);
      // 截断后仍是合法 UTF-16：解码回来不应出现替换字符
      expect(card.title.contains('\uFFFD'), isFalse);
      expect(card.title.endsWith('…'), isTrue);
    });

    test('标题为空退到 scope，再空退到「未命名任务」', () {
      expect(buildKanbanCards([run(title: '', scope: '把任务列成四列')]).single.title,
          '把任务列成四列');
      expect(buildKanbanCards([run(title: '', scope: '')]).single.title, '未命名任务');
    });
  });

  group('卡片字段', () {
    test('没有负责人时 leadName 是空串，界面自己决定显示「未指派」', () {
      final card = buildKanbanCards([
        run(leadBotName: '', leadBotId: ''),
      ]).single;
      expect(card.leadName, '');
    });

    test('只有 id 没有名字时退回 id，避免卡片上什么都不显示', () {
      final card = buildKanbanCards([
        run(leadBotName: '', leadBotId: 'b9'),
      ]).single;
      expect(card.leadName, 'b9');
    });

    test('摘要取材：受阻原因 > 等待说明 > 状态文案 > 目标', () {
      final blocked = buildKanbanCards([
        run(state: 'blocked', blockedReason: '缺生产库凭据', stateText: '受阻', scope: '上线'),
      ]).single;
      expect(blocked.summary, '缺生产库凭据');

      final waiting = buildKanbanCards([
        run(
          state: 'waiting_input',
          waiting: const TaskRunWaiting(kind: 'input', ref: 'r', describe: '等你选模型'),
          stateText: '等你回复',
          scope: '选模型',
        ),
      ]).single;
      expect(waiting.summary, '等你选模型');

      final stateOnly = buildKanbanCards([
        run(stateText: '正在验收', scope: '验收看板'),
      ]).single;
      expect(stateOnly.summary, '正在验收');

      final scopeOnly = buildKanbanCards([run(stateText: '', scope: '验收看板')]).single;
      expect(scopeOnly.summary, '验收看板');
    });

    test('暂停态被标出来（暂停不该画成「正在跑」）', () {
      expect(buildKanbanCards([run(state: 'paused_user')]).single.paused, isTrue);
      expect(buildKanbanCards([run(state: 'paused_budget')]).single.paused, isTrue);
      expect(buildKanbanCards([run(state: 'running')]).single.paused, isFalse);
    });
  });

  group('旧对话片段启发式（W5c 兜底）', () {
    test('已完成 + 无交付物 + 像一句话 → 折叠', () {
      expect(looksLikeConversationFragment(run(state: 'completed', title: '收到。先看基线和色板…')), isTrue);
      expect(looksLikeConversationFragment(run(state: 'completed', title: '好的，我先跑一遍测试')), isTrue);
      expect(looksLikeConversationFragment(run(state: 'completed', title: '')), isTrue);
    });

    test('有交付物、未终态或标题像任务 → 不折叠', () {
      expect(
        looksLikeConversationFragment(
          run(state: 'completed', title: '收到。先看基线…', deliverables: ['docs/x.md']),
        ),
        isFalse,
      );
      expect(looksLikeConversationFragment(run(state: 'running', title: '收到。先看基线…')), isFalse);
      expect(looksLikeConversationFragment(run(state: 'completed', title: '重构看板数据源')), isFalse);
    });
  });
}
