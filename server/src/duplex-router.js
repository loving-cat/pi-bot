/**
 * 忙时意图路由器（纯逻辑、零 IO、不读时钟）。
 *
 * 解决什么问题：
 *   当后台 Work 会话正在执行工具或长命令时，用户新发一条消息，
 *   系统需要瞬间判别这是：
 *     · side_reply    —— 问进度、追问原因、闲聊（旁路只读秒回，后台零中断）
 *     · amend         —— 补充约束、顺手微调（口头确认 + steer 注入后台）
 *     · abort_replace —— 明确叫停、作废重来（精确中断并按新需求重开）
 *
 * 设计约束（对齐 SPEC-FULL-DUPLEX-V1 §3.1 与 DECISION-ROUTER.md）：
 *   1. 两段式路由：确定性规则能直接拍板时同步返回，绝不 await 让出事件循环，
 *      以免“停下”指令慢半拍生效。
 *   2. 保守安全兜底：不确定、模型超时或低置信度时，fallback 永远不返回
 *      `abort_replace`，宁可旁路先答一句或温和追加，也绝不误掐长耗时任务。
 */

export const DUPLEX_KIND = Object.freeze({
  sideReply: 'side_reply',
  amend: 'amend',
  abortReplace: 'abort_replace',
});

const VALID_KINDS = new Set(Object.values(DUPLEX_KIND));

const NEGATED_STOP_RE =
  /(?:别|不要|先别|不用|不必|莫|没让你|不是让你)\s*(?:停|取消|中断|重来|放弃)|停不下来|不停/i;

const STOP_PHRASE_RE =
  /^(?:停|停下|停一下|停下来|停止|停止吧|快停|先停下|全停|全部停止|算了|算了吧|取消|全部取消|别跑了|别做了|别干了|不用做了|不用干了|重来|重写|全部重来|全停重来|停下重来|重新开始|换个方案|stop|stop all|stop now|cancel|cancel all|abort|abort all)[!！。.~～\s]*$/i;

const MODIFY_ACTION_RE =
  /(?:顺便|另外|再帮我|还要|记得|务必|改成|换成|加上|删掉|去掉|别动|不要动|别改|不要改|重写|重做|新建|修改)/;

const GREETING_OR_STATUS_EXACT_RE =
  /^(?:在吗|在不在|你好|嗨|hello|hi|hey|ping|status|progress)[?？!！。.~～\s]*$/i;

const PROGRESS_QUERY_RE =
  /(?:怎么样了|到哪一步|到哪了|到多少|多少了|什么进度|进度如何|进度到|进展如何|跑得怎么样|做好了吗|跑完了吗|跑完没|好了吗|还在跑吗|还在干吗|在干吗|在庙什么|在芙什么|卡住了吗|挂了吗|出什么错|报错是什么|为什么这么慢|还要多久|谁在干活|谁在跑)/;

const IMPERATIVE_MENTION_RE = /^@\S+\s+(?:把|帮我|去|改|写|跑|做|查|删)/;

/**
 * 同步预判忙时用户意图（不 await）。
 * 拿到明确结果时直接返回 `{ kind, decidedBy, confidence, reason }`；
 * 拿不准时返回 `kind: null`，交由外层决定是否询问 Jev 或走 `fallbackBusyInput`。
 */
export function classifyBusyInputSync({
  text = '',
  hasAttachments = false,
  explicitMode = 'auto',
  mode = 'steer',
  workSnapshot = null,
  roomKind = 'dm',
} = {}) {
  const modeClean = String(explicitMode ?? 'auto').trim();
  if (modeClean && modeClean !== 'auto' && VALID_KINDS.has(modeClean)) {
    return {
      kind: modeClean,
      decidedBy: 'explicit',
      confidence: 1,
      reason: 'explicit_mode',
    };
  }

  // 兼容既有显式 followUp 语义：明确排在当前轮次之后吸收，不走旁路只读
  if (mode === 'followUp') {
    return {
      kind: DUPLEX_KIND.amend,
      decidedBy: 'explicit',
      confidence: 1,
      reason: 'follow_up_mode',
    };
  }

  const clean = String(text ?? '').trim();
  if (hasAttachments) {
    return {
      kind: null,
      decidedBy: 'rules',
      confidence: 0,
      reason: 'has_attachments',
    };
  }

  if (!clean) {
    return {
      kind: DUPLEX_KIND.sideReply,
      decidedBy: 'rules',
      confidence: 0.85,
      reason: 'empty_text',
    };
  }

  // 先排除「别停」「不要取消」等否定句，再判明确短停止指令
  if (clean.length <= 40 && !NEGATED_STOP_RE.test(clean) && STOP_PHRASE_RE.test(clean)) {
    return {
      kind: DUPLEX_KIND.abortReplace,
      decidedBy: 'rules',
      confidence: 0.96,
      reason: 'stop_phrase',
    };
  }

  const hasModifyWord = MODIFY_ACTION_RE.test(clean);
  if (!hasModifyWord) {
    if (GREETING_OR_STATUS_EXACT_RE.test(clean) || PROGRESS_QUERY_RE.test(clean)) {
      return {
        kind: DUPLEX_KIND.sideReply,
        decidedBy: 'rules',
        confidence: 0.92,
        reason: 'status_or_question',
      };
    }

    const isGroupImperative = roomKind === 'group' && IMPERATIVE_MENTION_RE.test(clean);
    if (!isGroupImperative && /[?？]\s*$/.test(clean) && clean.length <= 80) {
      return {
        kind: DUPLEX_KIND.sideReply,
        decidedBy: 'rules',
        confidence: 0.88,
        reason: 'short_question',
      };
    }
  }

  // 若快照阶段无信息且仍无法确认，保留 null 交给 Jev / fallback
  void workSnapshot;
  return {
    kind: null,
    decidedBy: 'rules',
    confidence: 0,
    reason: 'undecided',
  };
}

/**
 * 保守安全兜底：永远不返回 `abort_replace`。
 */
/**
 * 这句话是「给正在干的活补一句」还是「又来一件新活」？
 *
 * 为什么要分：群聊里用户插话，补充约束（"范围收窄到 A 股"）应该
 * 直接送到负责人正在跑的一轮里，不打断其他成员；而"第二轮需求""改个需求"
 * 是新任务，必须走正常的轮次排队（原有的「插话 = 打断重来」契约）。
 *
 * 判据刻意保守：短句 + 出现约束类词才算补充；拿不准一律当新任务
 * （宁可多开一轮，也不能把真正的新需求当成小补充吃掉）。
 */
const SUPPLEMENT_HINT_RE =
  /(顺便|补一句|补充|再加|加上|记得|注意|只(?:看|要|算|保留|用)|收窄|限制|范围|口径|格式|先别|先按)/;

/**
 * 这条在途消息是否已经写出**用户看得见的正文**（只有思考/工具过程不算）。
 *
 * 为什么需要这个判定：忙时插话之后，针对插话的回复必须落在消息流最底部。
 * 但"怎么落"取决于旧气泡有没有内容：
 *
 * | 旧气泡状态 | 做法 | 理由 |
 * |---|---|---|
 * | 还没有一个字 | 直接把气泡挪到插话之后 | 用户看不到任何跳动 |
 * | 已经写出半截 | 原位封口 + 插话之后另起一条 | 挪走会让读过的文字从上方消失（FD-0） |
 *
 * 判据只看 `text`：`steps` 是工具过程，`status: 'streaming'` 只说明它还在跑。
 */
export function hasVisibleBody(msg) {
  return String(msg?.text ?? '').trim().length > 0;
}

export function looksLikeSupplement(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return false;
  if (clean.length > 60) return false;
  return SUPPLEMENT_HINT_RE.test(clean);
}

export function fallbackBusyInput({ text = '', hasAttachments = false } = {}) {
  const clean = String(text ?? '').trim();
  if (
    !hasAttachments &&
    !MODIFY_ACTION_RE.test(clean) &&
    /(?:[?？]\s*|(?:吗|呢|么)[。!！\s]*)$/.test(clean)
  ) {
    return {
      kind: DUPLEX_KIND.sideReply,
      decidedBy: 'fallback',
      confidence: 0.65,
      reason: 'question_fallback',
    };
  }
  return {
    kind: DUPLEX_KIND.amend,
    decidedBy: 'fallback',
    confidence: 0.6,
    reason: 'amend_fallback',
  };
}

/**
 * 忙时意图分流统一入口。
 *
 * 1. 先跑同步预判：确定则直接返回（零 await）；
 * 2. 未定且注入了 `askJev` 时，查询快速决策器并做合法性 + 置信度（>= 0.72）校验；
 * 3. 失败或低置信度时落回保守 `fallbackBusyInput`。
 *
 * @param {object} input
 * @param {{askJev?: ((input:object)=>Promise<{ok?:boolean,kind?:string,confidence?:number,reason?:string}|null>)|null, minConfidence?: number}} [opts]
 */
export async function routeBusyInput(input = {}, { askJev = null, minConfidence = 0.72 } = {}) {
  const sync = classifyBusyInputSync(input);
  if (sync.kind !== null) return sync;

  if (typeof askJev === 'function') {
    try {
      const jev = await askJev(input);
      const kind = jev?.kind ?? jev?.values?.intent ?? null;
      const confidence = Number(
        jev?.confidence ?? jev?.confidences?.intent ?? 0,
      );
      if (jev?.ok !== false && VALID_KINDS.has(kind) && confidence >= minConfidence) {
        return {
          kind,
          decidedBy: 'jev',
          confidence,
          reason: String(jev?.reason || 'jev_classified'),
        };
      }
    } catch {
      // 决策器异常一律安静落回保守 fallback，不阻断用户输入
    }
  }

  return fallbackBusyInput(input);
}
