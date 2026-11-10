// 任务、模型、思考等级与各类小组件文案。key 用 <区域>.<语义>。

import 'area.dart';

const areaPanel2 = StringArea(
  zh: {
    // ---- 通用小词 ----
    'misc.mainBot': '助手',
    'misc.default': '默认',
    'misc.enable': '启用',
    'misc.disable': '停用',
    'misc.listSeparator': '、',
    'misc.quoted': '「{name}」',
    'misc.restore': '恢复',
    'misc.expand': '放大',

    // ---- 模型卡片与容量 ----
    'model.cardsTitle': '模型',
    'model.addModel': '添加模型',
    'model.cardsHint': '每个模型独立设置，单位 tokens。留空则保留原值或使用默认值。',
    'model.cardNumber': '模型 {n}',
    'model.nameOptional': '显示名（可选）',
    'model.nameHint': '留空使用模型 ID',
    'model.contextTokensLabel': '上下文窗口（tokens）',
    'model.outputTokensLabel': '最大输出（tokens）',
    'model.serverDefault': '服务端默认',
    'model.keepValue': '保留原值',
    'model.thinkingOn': '思考已开启',
    'model.thinkingOff': '思考已关闭',
    'model.thinkingOnHint': '前台会给这个模型的 bot 展示思考档位；关掉后前台不再展示。',
    'model.thinkingOffHint': '这个模型不思考，前台也不会展示思考档位。',
    'model.upstreamFormat': '上游格式',
    'model.formatDefault': '用默认（不指定）',
    'model.noLevelMapped': '当前没有任何档位映射，前台不会展示思考档位。',
    'model.levelsMapped': '前台只会展示映射过的 {n} 个档位；要增减就展开微调。',
    'model.levelMapping': '档位映射',
    'model.resetSameName': '恢复同名',
    'model.collapseTuner': '收起微调',
    'model.expandTuner': '微调单个档位',
    'model.levelSkip': '不传（这一档不生效）',
    'model.noReasoning': '不思考',
    'model.defaultFormatLabel': '默认格式',
    'model.levelSummary': '{format} · {n} 档',
    'model.summary': '上下文：{context} · 最大输出：{output} · 思考：{thinking}',
    'model.nameWithId': '{name}（{id}）',

    // ---- 模型组 ----
    'model.groupTitle': '模型组',
    'model.groupEmpty': '还没配。\n填一个 baseUrl + key + 模型名，就能在给 bot 选模型时用上。',
    'model.inUse': '正在用',
    'model.keyMasked': 'key {key}',
    'model.noKey': '没配 key',
    'model.groupDisabled': '已停用',
    'model.deleteTitle': '删掉「{name}」？',
    'model.deleteBody': '用它跑着的 bot 会退回默认模型。',
    'model.fieldName': '名字',
    'model.fieldNameHint': '比如：我的中转站',
    'model.apiKeyUnchanged': 'API key（留空 = 不改）',
    'model.connectionOk': '通了',
    'model.connectionVia': '经 {via}',
    'model.foundCount': '发现 {n} 个模型',
    'model.connectionFailed': '没通',
    'model.openaiCompatible': 'OpenAI 兼容（绝大多数都用这个）',

    // ---- 模型选择器 ----
    'model.pickerLabel': '模型（留空用默认）',
    'model.pickFromList': '从列表里选',
    'model.pickTitle': '选一个模型',
    'model.emptyGroups': '还没有可用的模型组。\n请到「设置 → 模型组」添加或启用模型组。',
    'model.contextShort': '{n}k 上下文',
    'model.maxOutputShort': '最多出 {n}',

    // ---- 群聊轮次与部门规矩 ----
    'limits.savedRunning': '已生效（正在跑的会话下次跑就用新规矩）',
    'limits.saved': '已生效（不用重启）',
    // ---- 快速决策（Jev） ----
    // 默认关闭，也不拦着干活：没配它产品照常能用，只是少一点"聪明"。
    'decision.title': '快速决策',
    'decision.intro': '把"该用哪个模型""要不要接话"这类小判断交给专用决策模型，几百毫秒就能出结果。',
    'decision.enable': '启用快速决策',
    'decision.enabledHint': '部分判断现在走决策模型',
    'decision.disabledHint': '关着时一切走原来的逻辑',
    'decision.mode': '接入方式',
    'decision.modeTypesafe': 'TypeSafe 官方',
    'decision.modeCustom': '自定义',
    'decision.modeTypesafeHint': '官方地址固定，只要填 key。',
    'decision.modeCustomHint': '兼容 /v1/systemone 的服务。填完点「测一下」，可用模型会列出来让你选。',
    'decision.url': '服务地址',
    'decision.key': 'API Key',
    'decision.keySaved': '已保存（留空表示不改）',
    'decision.model': '模型名',
    'decision.modelHint': '点「测一下」从列表里选',
    'decision.probe': '测一下',
    'decision.probing': '测试中…',
    'decision.probeNote': '只读模型列表，不产生推理费用。',
    'decision.probeNoteCustom': '读出对方支持的模型，点一个就填进去。',
    'decision.probeOk': '连通正常，可用模型：{models}',
    'decision.probeOkNoModels': '连通了，但对方没返回模型列表，可能要手填。',
    'decision.probeFail': '连不上',
    'decision.pickModel': '选择模型',
    'decision.saved': '已保存',
    'limits.title': '群聊轮次',
    // 这五个数原来叫「老大最多几轮 / 成员最多几轮 / 一条消息最多跑几次 /
    // 单次最多来回几轮 / 单轮最长几分钟」—— 名字抽象、彼此重叠，
    // 开发者自己都要想一下才对得上实际场景，用户更看不懂。
    // 现在按「谁会做什么、超了会怎样」来说。
    'limits.intro': '防止 bot 之间聊起来停不下来。这几个数决定它们最多能耗多久。',
    'limits.groupPerBot': '单个 bot 能跑多久',
    'limits.groupPerTask': '整个任务的兜底上限',
    'limits.turnMinutes': '一次最多跑几分钟',
    'limits.turnMinutesDesc': '超时强制停下，把机会让给别人。写代码可调大。',
    'limits.leadTurns': '负责人一次发言跑几步',
    'limits.leadTurnsDesc': '负责人是收口的人，步子可以多些。',
    'limits.memberTurns': '成员一次发言跑几步',
    'limits.memberTurnsDesc': '完成自己那部分所需的步骤数。',
    'limits.runsPerMessage': '一条消息最多触发几次运行',
    'limits.runsPerMessageDesc': '防止 bot 之间无限接话，通常不用改。',
    'limits.stepsPerRun': '一次任务最多来回几轮',
    'limits.stepsPerRunDesc': '整个任务的天花板，到顶就收尾。',
    'limits.turnHint': '这几个数是保险丝，正常任务碰不到。拿不准就保持默认。',
    'limits.rulesTitle': '部门规矩',
    'limits.rulesHint': '预算管的是"能跑多久"；规矩管的是"能不能拆家"。',
    'limits.fileAndCommand': '改文件 / 跑命令',
    'limits.allow': '允许',
    'limits.ask': '需批准',
    'limits.deny': '只读',
    'limits.policyHint': '需批准 = 每次改文件/跑命令都要你确认。只读 = 不给这些工具。',
    'limits.requireProof': '交付要附证据',
    'limits.requireProofHint': '交活时必须带上命令输出 / 文件路径 / 测试结果，不许只说"改好了"',

    // ---- 思考等级 ----
    'think.level': '思考等级',
    'think.levelWith': '思考等级：{level}',
    'think.off': '关',
    'think.minimal': '极低',
    'think.low': '低',
    'think.medium': '中',
    'think.high': '高',
    'think.xhigh': '很高',
    'think.max': '最高',
    'think.capped': '{level} · 顶格',

    // ---- 运行参数 ----
    'think.reserveMustBeNumber': '预留值要填数字（或者留空用默认）',
    'think.keepMustBeNumber': '保留最近要填数字（或者留空用默认）',
    'think.budgetSaved': '上下文预算已保存，下一轮生效',
    'think.runSettings': '运行参数',
    'think.modelHelper': '选择即应用；手动输入后按回车应用',
    'think.switchingModel': '正在切换模型…',
    'think.switchUnconfirmed': '未能确认模型切换，请重试。',
    'think.switchApplied': '模型已切换，下一轮使用',
    'think.contextBudget': '上下文预算',
    'think.budgetHint': '留空就用全局默认。改大 = 记得更多但更贵；改小 = 便宜但更容易忘事。',
    'think.reserveLabel': '预留（给回复）',
    'think.keepRecentLabel': '保留最近',
    'think.saveBudget': '保存预算',

    // ---- 任务板 ----
    'task.title': '任务 · {room}',
    'task.openCount': '{n} 个未完成',
    'task.newHint': '加一条任务（回车添加）',
    'task.empty': '还没有任务。分配给团队成员的活会自动出现在这里。',
    'task.doing': '进行中',
    'task.todo': '待办',
    'task.doneCount': '已完成 {n}',
    'task.markDoneAll': '把这 {n} 条都标为完成',
    'task.markOpenAll': '把这 {n} 条都标为未完成',
    'task.owners': '{n} 人：{names}',
    'task.deleteAll': '删除这 {n} 条',
    'task.markOpen': '标为未完成',
    'task.markDone': '标为完成',
    'task.unpin': '取消置顶',
    'task.pin': '置顶',

    // ---- 定时任务 ----
    'auto.title': '定时任务 · {room}',
    'auto.runningCount': '{n} 个在跑',
    'auto.nameHint': '任务名（例如 盘前简报）',
    'auto.promptHint': '到点要它做什么（发给它的话）',
    'auto.every': '每隔',
    'auto.daily': '每天',
    'auto.minutes': '分钟',
    'auto.empty': '还没有定时任务。适合：盘前简报、每天巡检、每小时看一次进度。',
    'auto.nextRun': ' · 下次 {time}',
    'auto.runNow': '立刻跑一次',
    'auto.pause': '暂停',

    // ---- 版本更新 ----
    'update.found': '发现新版本 {version}',
    'update.current': '当前版本 {version}',
    'update.size': '下载大小约 {size}',
    'update.noDirectLinkPromo': '这个版本没有提供直链安装包，可以在发布页里手动下载。',
    'update.later': '以后再说',
    'update.openPage': '打开发布页',
    'update.noDirectLink': '这个版本没有提供直链安装包',
    'update.insecureUrl': '下载地址不是 https，已拒绝',
    'update.downloading': '正在下载更新',
    'update.connecting': '连接中…',
    'update.emptyFile': '下载到的文件是空的',
    'update.cancelled': '已取消',
    'update.downloadFailed': '下载失败：HTTP {status}',
    'update.done': '下载完成',
    'update.savedTo': '更新包已保存到：',
    'update.macInstructions':
        '关闭 pi-bot，打开 DMG 并将 App 拖入 Applications；\n重新打开后，在设置中重启本机服务端。',
    'update.installInstructions': '关闭 pi-bot 后运行这个安装包完成更新。',
    'update.winSetupInstructions':
        '关闭 pi-bot 后双击安装包，按下一步装完即可；\n数据目录和已配对的设备不会被改动。',
    'update.gotIt': '知道了',
    'update.openFolder': '打开所在目录',

    // ---- 经验 ----
    'lesson.title': '经验',
    'lesson.intro': '只有启用的会被助手参考，一次最多 3 条 / 600 字',
    'lesson.candidateCount': '待确认 {n}',
    'lesson.activeCount': '已启用 {n}',
    'lesson.all': '全部',
    'lesson.emptyCandidates': '还没有候选经验。群聊结束后会自动复盘出候选。',
    'lesson.noCandidates': '没有待确认的经验',
    'lesson.emptyActive': '还没有启用的经验。候选条目点「启用」后，助手安排任务时才会参考它。',
    'lesson.noActive': '没有启用的经验',
    'lesson.emptyAll': '还没有经验。群聊收尾后会自动复盘出候选。',
    'lesson.deleteTitle': '删掉这条经验？',
    'lesson.deleteBody': '「{cue}」会从库里移除，之后不会再被注入。',
    'lesson.delete': '删掉',
    'lesson.gone': '这条经验已经不在了（可能被删了），列表已刷新',
    'lesson.enabled': '已启用',
    'lesson.evidence': '证据',
    'lesson.hits': '已命中 {n} 次',

    // ---- 教学对话框 ----
    'teach.title': '教 {bot} 做一项任务',
    'teach.intro': '写一遍"以后遇到这类事就照这么做"，它就记住了。',
    'teach.whatLabel': '这是一件什么事',
    'teach.whatHint': '例：每周五收盘后汇总本周数据',
    'teach.howLabel': '具体怎么做',
    'teach.howHint': '例：先读 data/ 下本周的 csv，算涨跌幅和成交额，生成一张对比表，再发一条带表格的消息到群里。',
    'teach.submit': '教给它',

    // ---- 审批卡 ----
    'approval.approved': '已批准',
    'approval.rejected': '已拒绝',
    'approval.needsApproval': '{name} 需要你批准',
    'approval.reject': '拒绝',
    'approval.approveOnce': '批准这一次',
    'approval.approvedHint': '已经放行这一次，它会接着做完。',
    'approval.rejectedHint': '已拒绝，它不会执行这次操作。',

    // ---- 询问卡 ----
    'ask.asksYou': '{name} 问你',
    'ask.answered': '已回答：{answer}',
    'ask.customHint': '或者我自己说一句…',
    'ask.send': '发出去',

    // ---- 上下文指示器 ----
    'ctx.compacting': '压缩中',
    'ctx.clickHint': '点了看细节',
    'ctx.title': '上下文',
    'ctx.used': '已占用',
    'ctx.autoCompact': '自动压缩',
    'ctx.autoCompactOn': '开 —— 接近上限时自动总结之前的对话，历史消息仍保留。',
    'ctx.compactNote': '占用到 60% 会自动把之前的长对话收成摘要，头部显示「压缩中」。'
        '历史消息仍保留，只是喂给模型的上下文换成摘要 + 最近 6 万 token 原文。'
        '想让它装得更多，可以给这个 bot 单独调预算。',
    'ctx.compacted': '上下文压缩了（前面的对话已总结）',
    'ctx.compactedFrom': '上下文压缩了：{before}k（前面的对话已总结）',
    'ctx.compactedSaved': '上下文压缩了：{before}k → 省下 {saved}k（前面的对话已总结）',

    // ---- 部门进度 ----
    'dept.received': '收到',
    // 私聊里没有「收到谁的消息」这回事 —— 回执的作者就是会话对象本身。
    // 这些消息的实质是「它在部门里干了什么」，所以要换个说法。
    'dept.dmProgress': '在部门里干了 {n} 件事',
    // 必须带部门名：bot 可能同时挂好几个部门，只说「在部门里」用户不知道是哪个。
    'dept.dmProgressIn': '在「{dept}」那边 {n} 件事',
    'dept.dmProgressMore': '「{dept}」那边的进展',
    'dept.messageSuffix': '消息 · {n} 条',
    'dept.unknown': '部门',
    'dept.fromRoom': '「{room}」的消息',
    'dept.fromPeople': '收到 {names} 的消息',

    // ---- 消息引用 ----
    'ref.sentTo': '已发消息给',
    'ref.totals': '{n} 条往来',
    'ref.closeChat': '关闭聊天',
    'ref.sentToBots': '已发消息给 {n} 个 Bot',
    'ref.openChat': '打开这个对话',
    'ref.empty': '（还没有内容）',
    'ref.me': '我',

    // ---- 改动文件 ----
    'files.added': '新增 {n}',
    'files.modified': '修改 {n}',
    'files.removed': '删除 {n}',
    'files.total': '改动 {n} 个文件',
    'files.openHint': '{summary} · 点开看',
    'files.more': '还有 {n} 个',
    'files.truncated': '（本次改动过多，只统计了一部分）',

    // ---- 附件操作 ----
    'attach.opening': '正在打开 {name}…',
    'attach.openedSystem': '已交给系统程序',
    'attach.downloading': '正在下载 {name}…',
    'attach.savedTo': '已保存到 {path}',
    'attach.downloadError': '下载失败，请检查连接或保存位置后重试。',
    'attach.openWithSystem': '用系统应用打开',
    'attach.openWithSystemAlt': '用系统程序打开',
    'attach.count': '附件 {n} 个文件',
    'attach.preview': '预览文件',
    'attach.openingShort': '正在打开…',
    'attach.imageFailed': '图片加载失败',

    // ---- 用户名 ----
    'user.title': '我是谁',
    'user.saved': '已保存，bot 下一轮起会这么称呼你',
    'user.explain':
        'bot 会用这个名字称呼你。',
    'user.hint': '比如：小陈 / Boss / 老板',

    // ---- 工具步骤 ----
    'tools.working': '正在干活…',
    'tools.calling': '正在调用工具…',
    'tools.callsCount': '工具调用 · {n} 步',
    'tools.openHint': '点开看明细',
    'tools.failedMore': '还有 {n} 步失败（点开看）',

    // ---- 外观反馈 ----
    'appearance.waiting': '等待保存…',
    'appearance.saveFailed': '保存失败：{error}',

    // ---- 复制反馈 ----
    'copy.link': '链接已复制',
    'copy.email': '邮箱已复制',
    'copy.code': '代码已复制',
    'copy.quote': '引用已复制',
    'copy.copyQuote': '复制引用',
    'copy.quoteCopied': '已复制引用',
    'copy.failed': '复制失败，请重试',

    // ---- 日志 ----
    'log.title': '日志',
    'log.openFolder': '打开目录',
    'log.note': '服务端日志 server.log 与界面日志 app.log。排查问题时请提供这些文件。',

    // ---- 预览 ----
    'preview.readFailed': '暂时无法读取附件，请重新打开或下载后查看。',
    'preview.truncated': '…（内容太长，只显示了前 512KB，要看全部请下载）',
    'preview.imageFailed': '图片暂时无法显示，请下载后查看。',
    'preview.unsupported': '当前格式暂不能直接预览，请使用上方的下载或系统打开按钮。',

    // ---- HTML 附件预览 ----
    'html.readFailed': '无法读取这个附件，请重试或下载文件。',
    'html.renderTimeout': '网页未能完成加载，可以查看源码或下载文件。',
    'html.externalLinksTitle': '报告中的外部链接',
    'html.openInBrowser': '在浏览器中打开？',
    'html.openLink': '打开链接',
    'html.browserFailed': '无法打开浏览器，请复制链接后手动打开。',
    'html.previewTab': '预览',
    'html.sourceTab': '源码',
    'html.externalLinks': '外部链接',
    'html.offlineNote': '离线预览，外部资源不会加载',
    'html.truncated': '…（源码较长，仅展示前 512K 字符，请下载查看完整源码）',
    'html.viewSource': '查看源码',

    // ---- 内置浏览器 ----
    'browser.loadFailed': '页面暂时无法加载，请重试或使用系统浏览器打开。',
    'browser.notConvertible': '这个文件不能转成网页查看。\n用工具栏的「用系统浏览器打开」，或先下载再打开。',
    'browser.httpStatus': '服务端返回 HTTP {status}',
    'browser.pdfFailed': '这个 PDF 暂时无法打开。\n可以用工具栏的「用系统浏览器打开」，或先下载。',
    'browser.loadFailedRefresh': '页面暂时无法加载，请刷新或换一个地址。',
    'browser.processStopped': '网页进程已停止，点击刷新可以重新打开。',
    'browser.back': '后退',
    'browser.forward': '前进',
    'browser.addressHint': '输入网址或搜索词',
    'browser.openExternal': '用系统浏览器打开',
    'browser.desktopOnly': '内置浏览器只在桌面端提供（Windows / macOS）。',
    'browser.emptyHint': '在上面的地址栏输入网址，或点聊天里的链接。',
    'browser.backToFile': '回到刚才的文件',
    'browser.loading': '正在加载…',

    // ---- 网页预览失败 ----
    'offline.timeout': '网页加载超时，可以切换源码或下载文件。',
    'offline.unsupported': '当前平台暂不支持网页预览，请查看源码或下载文件。',
    'offline.tooLarge': '文档超出网页预览上限，请下载后查看。',
    'offline.missingRuntime': '缺少网页预览运行环境，请安装 WebView2 或查看源码。',
    'offline.initFailed': '网页预览无法初始化，可以切换源码或下载文件。',
    'offline.isolationFailed': '网页隔离检查未通过，已停止预览，请查看源码。',
    'offline.loadFailed': '网页未能加载，可以切换源码或下载文件。',
    'offline.processStopped': '网页进程已停止，可以切换源码或重新打开文件。',
    'offline.processCrashed': '网页进程未能继续运行，可以切换源码或重新打开文件。',

    // ---- 头像外观补充 ----
    'avatar.restoreDefaultShape': '恢复默认形象',
    'avatar.saveNote': '保存后，它的颜色会同步用于你的消息气泡、按钮和重点信息。',

    // ---- 消息操作 ----
    'msg.copyContent': '复制内容',
    'msg.copyId': '复制消息 id',
  },
  en: {
    // ---- common small words ----
    'misc.mainBot': 'Assistant',
    'misc.default': 'Default',
    'misc.enable': 'Enable',
    'misc.disable': 'Disable',
    'misc.listSeparator': ', ',
    'misc.quoted': '"{name}"',
    'misc.restore': 'Restore',
    'misc.expand': 'Expand',

    // ---- model cards & capacity ----
    'model.cardsTitle': 'Models',
    'model.addModel': 'Add model',
    'model.cardsHint': 'Each model is configured separately, in tokens. Blank keeps the current or default value.',
    'model.cardNumber': 'Model {n}',
    'model.nameOptional': 'Display name (optional)',
    'model.nameHint': 'Blank uses the model ID',
    'model.contextTokensLabel': 'Context window (tokens)',
    'model.outputTokensLabel': 'Max output (tokens)',
    'model.serverDefault': 'Server default',
    'model.keepValue': 'Keep current',
    'model.thinkingOn': 'Reasoning on',
    'model.thinkingOff': 'Reasoning off',
    'model.thinkingOnHint': 'Bots on this model get a reasoning slider. Turn this off and the slider disappears.',
    'model.thinkingOffHint':
        'This model does not reason, so no reasoning slider is shown.',
    'model.upstreamFormat': 'Upstream format',
    'model.formatDefault': 'Default (unspecified)',
    'model.noLevelMapped':
        'No level is mapped yet, so no reasoning slider is shown.',
    'model.levelsMapped': 'Only the {n} mapped levels appear in the app; expand the tuner to change them.',
    'model.levelMapping': 'Level mapping',
    'model.resetSameName': 'Reset to same name',
    'model.collapseTuner': 'Hide tuner',
    'model.expandTuner': 'Tune levels',
    'model.levelSkip': 'Omit (level off)',
    'model.noReasoning': 'No reasoning',
    'model.defaultFormatLabel': 'Default format',
    'model.levelSummary': '{format} · {n} levels',
    'model.summary':
        'Context: {context} · Max output: {output} · Reasoning: {thinking}',
    'model.nameWithId': '{name} ({id})',

    // ---- model groups ----
    'model.groupTitle': 'Model groups',
    'model.groupEmpty': 'Nothing configured yet.\nAdd a base URL, a key and a model name, and you can pick that model for any bot.',
    'model.inUse': 'In use',
    'model.keyMasked': 'key {key}',
    'model.noKey': 'No key set',
    'model.groupDisabled': 'Disabled',
    'model.deleteTitle': 'Delete "{name}"?',
    'model.deleteBody': 'Bots running on it fall back to the default model.',
    'model.fieldName': 'Name',
    'model.fieldNameHint': 'e.g. My proxy',
    'model.apiKeyUnchanged': 'API key (blank = unchanged)',
    'model.connectionOk': 'Connected',
    'model.connectionVia': 'via {via}',
    'model.foundCount': '{n} models found',
    'model.connectionFailed': 'Failed',
    'model.openaiCompatible': 'OpenAI-compatible (what most providers use)',

    // ---- model picker ----
    'model.pickerLabel': 'Model (blank = default)',
    'model.pickFromList': 'Pick from list',
    'model.pickTitle': 'Pick a model',
    'model.emptyGroups': 'No model groups available.\nAdd or enable one in Settings → Model groups.',
    'model.contextShort': '{n}k context',
    'model.maxOutputShort': 'up to {n} out',

    // ---- group turns & workspace rules ----
    'limits.savedRunning':
        'Applied — running sessions pick up the new limits on their next run',
    'limits.saved': 'Applied (no restart needed)',
    'decision.title': 'Fast decisions',
    'decision.intro': 'Hands small calls ("which model for this job", "should I reply") to a decision model: a few hundred ms instead of a full inference.',
    'decision.enable': 'Enable fast decisions',
    'decision.enabledHint': 'Some calls now use the decision model',
    'decision.disabledHint': 'Everything uses the original logic',
    'decision.mode': 'Connection',
    'decision.modeTypesafe': 'TypeSafe official',
    'decision.modeCustom': 'Custom',
    'decision.modeTypesafeHint': 'Fixed endpoint — just paste your key.',
    'decision.modeCustomHint': 'Any /v1/systemone-compatible service. Hit Test and pick from the model list.',
    'decision.url': 'Endpoint',
    'decision.key': 'API key',
    'decision.keySaved': 'Saved (leave blank to keep)',
    'decision.model': 'Model name',
    'decision.modelHint': 'Hit Test and pick one',
    'decision.probe': 'Test',
    'decision.probing': 'Testing…',
    'decision.probeNote': 'Reads the model list only; no inference cost.',
    'decision.probeNoteCustom': 'Lists the models it supports; tap one to fill it in.',
    'decision.probeOk': 'Connected. Models: {models}',
    'decision.probeOkNoModels': 'Connected, but no model list returned. Enter the name manually.',
    'decision.probeFail': 'Cannot connect',
    'decision.pickModel': 'Pick a model',
    'decision.saved': 'Saved',
    'limits.title': 'Group turns',
    'limits.intro': 'Keeps bots from chatting forever. These numbers cap how much they can spend.',
    'limits.groupPerBot': 'How long one bot can run',
    'limits.groupPerTask': 'Ceiling for the whole task',
    'limits.turnMinutes': 'Max minutes per turn',
    'limits.turnMinutesDesc': 'Stops and hands off when exceeded. Raise for coding.',
    'limits.leadTurns': 'Steps per message from the lead',
    'limits.leadTurnsDesc': 'The lead wraps things up, so it gets more steps.',
    'limits.memberTurns': 'Steps per message from a member',
    'limits.memberTurnsDesc': 'Steps needed to finish its share.',
    'limits.runsPerMessage': 'Max runs per message',
    'limits.runsPerMessageDesc': 'Prevents endless bot back-and-forth. Rarely needs changing.',
    'limits.stepsPerRun': 'Max turns per task',
    'limits.stepsPerRunDesc': 'Ceiling for the whole task; it wraps up at the limit.',
    'limits.turnHint': 'These are safety fuses; normal tasks never reach them. Keep the defaults if unsure.',
    'limits.rulesTitle': 'Workspace rules',
    'limits.rulesHint':
        'Budgets cap how long work runs; rules cap how much damage it can do.',
    'limits.fileAndCommand': 'File edits / commands',
    'limits.allow': 'Allow',
    'limits.ask': 'Ask first',
    'limits.deny': 'Read-only',
    'limits.policyHint': 'Ask first = confirm every file edit and command. Read-only = these tools are withheld.',
    'limits.requireProof': 'Deliver with evidence',
    'limits.requireProofHint': 'Finished work must include command output, file paths or test results — "it works now" is not enough',

    // ---- reasoning levels ----
    'think.level': 'Reasoning level',
    'think.levelWith': 'Reasoning level: {level}',
    'think.off': 'Off',
    'think.minimal': 'Minimal',
    'think.low': 'Low',
    'think.medium': 'Medium',
    'think.high': 'High',
    'think.xhigh': 'Very high',
    'think.max': 'Max',
    'think.capped': '{level} · Maxed',

    // ---- run settings ----
    'think.reserveMustBeNumber':
        'Reserve must be a number, or leave it blank to use the default',
    'think.keepMustBeNumber':
        'Keep-recent must be a number, or leave it blank to use the default',
    'think.budgetSaved': 'Context budget saved. It takes effect next turn.',
    'think.runSettings': 'Run settings',
    'think.modelHelper':
        'Picking applies it; when typing, press Enter to apply',
    'think.switchingModel': 'Switching model…',
    'think.switchUnconfirmed':
        'Could not confirm the model switch. Please try again.',
    'think.switchApplied': 'Model switched. It will be used next turn.',
    'think.contextBudget': 'Context budget',
    'think.budgetHint': 'Leave blank to use the global default. Larger means better recall at a higher cost; smaller is cheaper but forgets sooner.',
    'think.reserveLabel': 'Reserve (for replies)',
    'think.keepRecentLabel': 'Keep recent',
    'think.saveBudget': 'Save budget',

    // ---- task board ----
    'task.title': 'Tasks · {room}',
    'task.openCount': '{n} open',
    'task.newHint': 'Add a task, press Enter',
    'task.empty':
        'No tasks yet. Work dispatched in this group shows up here by itself.',
    'task.doing': 'In progress',
    'task.todo': 'To do',
    'task.doneCount': 'Done ({n})',
    'task.markDoneAll': 'Mark all {n} as done',
    'task.markOpenAll': 'Mark all {n} as not done',
    'task.owners': '{n} people: {names}',
    'task.deleteAll': 'Delete all {n}',
    'task.markOpen': 'Mark as not done',
    'task.markDone': 'Mark as done',
    'task.unpin': 'Unpin',
    'task.pin': 'Pin',

    // ---- scheduled tasks ----
    'auto.title': 'Scheduled tasks · {room}',
    'auto.runningCount': '{n} running',
    'auto.nameHint': 'Task name (e.g. Pre-market brief)',
    'auto.promptHint':
        'What should it do when it fires? This text is sent as a message',
    'auto.every': 'Every',
    'auto.daily': 'Daily',
    'auto.minutes': 'min',
    'auto.empty': 'No scheduled tasks yet. Good fits: a pre-market brief, a daily check, an hourly look at progress.',
    'auto.nextRun': ' · next {time}',
    'auto.runNow': 'Run now',
    'auto.pause': 'Pause',

    // ---- updates ----
    'update.found': 'Version {version} is available',
    'update.current': 'You are on {version}',
    'update.size': 'Download size: {size}',
    'update.noDirectLinkPromo': 'This release has no direct download, but you can get it from the release page.',
    'update.later': 'Not now',
    'update.openPage': 'Open release page',
    'update.noDirectLink': 'This release has no direct download',
    'update.insecureUrl': 'Refused: the download URL is not https',
    'update.downloading': 'Downloading update',
    'update.connecting': 'Connecting…',
    'update.emptyFile': 'The downloaded file is empty',
    'update.cancelled': 'Cancelled',
    'update.downloadFailed': 'Download failed: HTTP {status}',
    'update.done': 'Download complete',
    'update.savedTo': 'Installer saved to:',
    'update.macInstructions': 'Quit pi-bot, open the DMG and drag the app into Applications.\nThen reopen it and restart the local server in Settings.',
    'update.installInstructions':
        'Quit pi-bot, then run this installer to finish updating.',
    'update.winSetupInstructions':
        'Quit pi-bot, then run the installer and click through the wizard.\nYour data directory and paired devices are left untouched.',
    'update.gotIt': 'Got it',
    'update.openFolder': 'Show in folder',

    // ---- lessons ----
    'lesson.title': 'Lessons',
    'lesson.intro': 'Only enabled lessons reach the lead bot, at most 3 per prompt / 600 characters',
    'lesson.candidateCount': 'Pending {n}',
    'lesson.activeCount': 'Enabled {n}',
    'lesson.all': 'All',
    'lesson.emptyCandidates': 'No lessons awaiting review. When a group chat wraps up, candidates are drafted automatically and you decide whether to keep them.',
    'lesson.noCandidates': 'No pending lessons',
    'lesson.emptyActive': 'No enabled lessons yet. Enable a candidate and the lead bot will consult it when dispatching work.',
    'lesson.noActive': 'No enabled lessons',
    'lesson.emptyAll':
        'No lessons yet. Candidates are drafted when a group chat wraps up.',
    'lesson.deleteTitle': 'Delete this lesson?',
    'lesson.deleteBody': '"{cue}" will be removed and never injected again.',
    'lesson.delete': 'Delete',
    'lesson.gone':
        'That lesson is gone (probably deleted). The list has been refreshed.',
    'lesson.enabled': 'Enabled',
    'lesson.evidence': 'Evidence',
    'lesson.hits': 'Used {n} times',

    // ---- teach dialog ----
    'teach.title': 'Teach {bot} a task',
    'teach.intro': 'Describe how to handle this kind of work from now on, and it will remember.',
    'teach.whatLabel': 'What is this task',
    'teach.whatHint': "e.g. Summarize this week's data after Friday close",
    'teach.howLabel': 'How to do it',
    'teach.howHint': "e.g. Read this week's CSVs under data/, compute price changes and turnover, build a comparison table, then post a message with that table to the group.",
    'teach.submit': 'Teach it',

    // ---- approval card ----
    'approval.approved': 'Approved',
    'approval.rejected': 'Rejected',
    'approval.needsApproval': '{name} needs your approval',
    'approval.reject': 'Reject',
    'approval.approveOnce': 'Approve once',
    'approval.approvedHint': 'Approved for this run. It will finish the job.',
    'approval.rejectedHint': 'Rejected. It will not run this action.',

    // ---- ask card ----
    'ask.asksYou': '{name} asks you',
    'ask.answered': 'Answered: {answer}',
    'ask.customHint': 'Or type your own answer…',
    'ask.send': 'Send',

    // ---- context chip ----
    'ctx.compacting': 'Compacting',
    'ctx.clickHint': 'Click for details',
    'ctx.title': 'Context',
    'ctx.used': 'Used',
    'ctx.autoCompact': 'Auto-compact',
    'ctx.autoCompactOn': 'On — summarizes earlier turns when nearing the limit. History is kept.',
    'ctx.compactNote': 'Auto-summarizes at 60% used; the header shows "Compacting" while it runs. '
        'History is kept — the model gets a summary plus the last 60k tokens verbatim. '
        'To give it more room, raise this bot\'s budget.',
    'ctx.compacted': 'Context compacted (earlier turns summarized)',
    'ctx.compactedFrom':
        'Context compacted from {before}k (earlier turns summarized)',
    'ctx.compactedSaved': 'Context compacted from {before}k, {saved}k saved (earlier turns summarized)',

    // ---- group progress ----
    'dept.received': 'From',
    'dept.dmProgress': '{n} updates from the department',
    'dept.dmProgressIn': '{n} updates from {dept}',
    'dept.dmProgressMore': 'Updates from {dept}',
    'dept.messageSuffix': '· {n} messages',
    'dept.unknown': 'Group',
    'dept.fromRoom': 'Messages in {room}',
    'dept.fromPeople': 'Messages from {names}',

    // ---- message references ----
    'ref.sentTo': 'Messaged',
    'ref.totals': '{n} messages',
    'ref.closeChat': 'Close chat',
    'ref.sentToBots': 'Messaged {n} bots',
    'ref.openChat': 'Open this chat',
    'ref.empty': '(Nothing here yet)',
    'ref.me': 'Me',

    // ---- changed files ----
    'files.added': '{n} added',
    'files.modified': '{n} changed',
    'files.removed': '{n} deleted',
    'files.total': '{n} files changed',
    'files.openHint': '{summary} · click to open',
    'files.more': '{n} more',
    'files.truncated': '(many files changed; this is a partial count)',

    // ---- attachment actions ----
    'attach.opening': 'Opening {name}…',
    'attach.openedSystem': 'Handed to the system app',
    'attach.downloading': 'Downloading {name}…',
    'attach.savedTo': 'Saved to {path}',
    'attach.downloadError': 'Download failed. Check your connection or the save location and try again.',
    'attach.openWithSystem': 'Open with system app',
    'attach.openWithSystemAlt': 'Open with system app',
    'attach.count': '{n} attachments',
    'attach.preview': 'Preview file',
    'attach.openingShort': 'Opening…',
    'attach.imageFailed': 'Image failed to load',

    // ---- user name ----
    'user.title': 'Who am I',
    'user.saved': 'Saved. Bots will call you this from the next turn on.',
    'user.explain': 'Bots use this name for you. Set it once instead of writing "the user is called XX" into every persona. In groups they also know which messages are yours.',
    'user.hint': 'e.g. Alex / Boss / Chief',

    // ---- tool steps ----
    'tools.working': 'Working…',
    'tools.calling': 'Calling tools…',
    'tools.callsCount': 'Tool calls · {n} steps',
    'tools.openHint': 'click for details',
    'tools.failedMore': '{n} more steps failed (expand to see)',

    // ---- appearance feedback ----
    'appearance.waiting': 'Waiting to save…',
    'appearance.saveFailed': 'Save failed: {error}',

    // ---- copy feedback ----
    'copy.link': 'Link copied',
    'copy.email': 'Email copied',
    'copy.code': 'Code copied',
    'copy.quote': 'Quote copied',
    'copy.copyQuote': 'Copy quote',
    'copy.quoteCopied': 'Quote copied',
    'copy.failed': 'Copy failed, try again',

    // ---- logs ----
    'log.title': 'Logs',
    'log.openFolder': 'Open folder',
    'log.note': 'Server log (server.log) and app log (app.log). These help when troubleshooting.',

    // ---- preview ----
    'preview.readFailed':
        'Could not read the attachment. Reopen it or download it to view.',
    'preview.truncated': '… (content is long; only the first 512KB is shown — download it to see everything)',
    'preview.imageFailed': 'The image cannot be shown. Download it to view.',
    'preview.unsupported': 'This format cannot be previewed here. Use the download or open-with-system buttons above.',

    // ---- HTML attachment preview ----
    'html.readFailed':
        'Could not read this attachment. Try again or download the file.',
    'html.renderTimeout': 'The page did not finish loading. You can view the source or download the file.',
    'html.externalLinksTitle': 'External links in this report',
    'html.openInBrowser': 'Open in browser?',
    'html.openLink': 'Open link',
    'html.browserFailed':
        'Could not open a browser. Copy the link and open it yourself.',
    'html.previewTab': 'Preview',
    'html.sourceTab': 'Source',
    'html.externalLinks': 'External links',
    'html.offlineNote': 'Offline preview — external resources are not loaded',
    'html.truncated': '… (source is long; showing the first 512K characters — download the file to see the rest)',
    'html.viewSource': 'View source',

    // ---- built-in browser ----
    'browser.loadFailed':
        'The page could not load. Try again or open it in your system browser.',
    'browser.notConvertible': 'This file cannot be shown as a web page.\nUse "Open in system browser" in the toolbar, or download it first.',
    'browser.httpStatus': 'The server returned HTTP {status}',
    'browser.pdfFailed': 'This PDF cannot be opened right now.\nUse "Open in system browser" in the toolbar, or download it first.',
    'browser.loadFailedRefresh':
        'The page could not load. Refresh or try another address.',
    'browser.processStopped':
        'The page process stopped. Click refresh to reopen it.',
    'browser.back': 'Back',
    'browser.forward': 'Forward',
    'browser.addressHint': 'Enter a URL or search term',
    'browser.openExternal': 'Open in system browser',
    'browser.desktopOnly':
        'The built-in browser is desktop only (Windows / macOS).',
    'browser.emptyHint': 'Type a URL above, or click any link in a chat.',
    'browser.backToFile': 'Back to the file',
    'browser.loading': 'Loading…',

    // ---- offline preview failures ----
    'offline.timeout':
        'The page timed out. Switch to the source or download the file.',
    'offline.unsupported': 'Web preview is not supported on this platform. View the source or download the file.',
    'offline.tooLarge':
        'This document is too large to preview. Download it to view.',
    'offline.missingRuntime': 'The web preview runtime is missing. Install WebView2 or view the source.',
    'offline.initFailed': 'Web preview could not start. Switch to the source or download the file.',
    'offline.isolationFailed': 'The web isolation check failed, so the preview was stopped. View the source instead.',
    'offline.loadFailed':
        'The page failed to load. Switch to the source or download the file.',
    'offline.processStopped':
        'The page process stopped. Switch to the source or reopen the file.',
    'offline.processCrashed': 'The page process could not continue. Switch to the source or reopen the file.',

    // ---- avatar appearance additions ----
    'avatar.restoreDefaultShape': 'Restore default shape',
    'avatar.saveNote': 'Once saved, its color also drives your message bubbles, buttons and highlights.',

    // ---- message actions ----
    'msg.copyContent': 'Copy text',
    'msg.copyId': 'Copy message ID',
  },
);