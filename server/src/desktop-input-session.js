/**
 * 桌面输入的**装配层**：把租约、接管检测、规划、平台发送串成一次动作。
 *
 * 这一层有状态（一个进程一份桌面租约），所以它**不写判定**：
 *
 * | 判定 | 在哪 |
 * |---|---|
 * | 现在轮到谁动鼠标 | `desktop-lease.js` |
 * | 用户是不是刚动过手 | `desktop-takeover.js` |
 * | 这个动作该不该发、坐标合不合法 | `desktop-input.js` |
 * | 怎么发 | `desktop-input-win.js` |
 *
 * 这里只做"按顺序问一遍"，任何一步不通过就返回它的理由。
 * 平台探针和发送都是**注入**的（`probe` / `perform`），所以整条链路能在
 * 测试里用假平台跑通 —— 不需要真机，也不会在 CI 里乱动鼠标。
 *
 * ## ★ 顺序不能改
 *
 * ```
 * ① 有租约吗            （没有 → 明确告诉模型"先申请租约"）
 * ② 是你持有的吗 + epoch （被抢占过的旧请求一律拒）
 * ③ 探一次环境          （锁屏 / 无会话 → 交还用户）
 * ④ 用户接管检测        （用户在动 → 吊销租约并交还）
 * ⑤ 规划 + 坐标校验      （屏幕外 → 拒绝，不夹到边缘）
 * ⑥ 发送
 * ⑦ noteInjection       （★ 漏了这步，下一次检测会把自己的输入当成用户接管）
 * ```
 *
 * ③④ 在 ⑤ 之前：没有可信的坐标基准（DPI 感知失败/锁屏）就不该规划，
 * 否则规划出来的是一份"看起来合法"的计划，实际打不到对的地方。
 */
import {
  createLeaseState, acquire, release, renew, revoke, checkLease, assertHolder, sweep, describeLease, DENY,
} from './desktop-lease.js';
import * as winPlatform from './desktop-input-win.js';
import * as macPlatform from './desktop-input-mac.js';
import {
  createWatchState, watch, noteInjection, describeWatch, ACTION as WATCH_ACTION,
} from './desktop-takeover.js';
import { planInput, describePlan, INPUT_FAIL } from './desktop-input.js';
import { currentGrantOf } from './grant-context.js';
import { store } from './store.js';

/** 一次输入为什么没发出去。供工具层翻成人话。 */
export const REFUSE = Object.freeze({
  ...INPUT_FAIL,
  /** 没有租约（还没申请，或已经释放） */
  noLease: DENY.noLease,
  /** 租约在别人手里 */
  notHolder: DENY.notHolder,
  /** 世代号过期（被抢占过） */
  staleEpoch: DENY.staleEpoch,
  /** 租约到期 / 心跳超时 */
  expired: DENY.expired,
  /** 被吊销 */
  revoked: DENY.revoked,
  /** 用户在动，已交还 */
  yielded: 'yielded',
  /**
   * 用户在动，但还在抖动抑制阶段（只停这一次，不吊销租约）。
   *
   * 和 `yielded` 分开是因为上层行为不同：`yielded` 表示“已经交还，别再试了”；
   * `userActivePending` 只是“等一下”，提醒模型**重新观察再决定**，不是故障。
   * 两者都不该用 isError 返回，否则模型会把它当成工具坏了然后重试。
   */
  userActivePending: 'user_active_pending',
  /**
   * 探针给出的时间戳与本地记录对不上（时钟漂移 / 探针抖动）。
   *
   * 和 `userActivePending` 分开：那个是"用户在动"，这个是"我们看不清"。
   * 两者都只是停这一次、不吊销租约，但给模型的说法不一样 ——
   * 说成"用户在动"会让它以为是自己被接管了，实际可能只是探针抖了一下。
   */
  probeUncertain: 'probe_uncertain',
  /**
   * 目标窗口和我们商量的那个不是同一个（规格 §5.2「重新校验目标」）。
   *
   * 为什么会变：用户切了窗口、弹了对话框、或者上一次点击把界面推进到下一页。
   * 这时候还按旧坐标点，点中的是**别的东西** —— 而且不会报错。
   */
  targetChanged: 'target_changed',
});

/**
 * 建一份桌面输入的运行时状态。
 *
 * @param {object} [o]
 * @param {string} [o.desktopId]
 * @param {() => number} [o.now] 时钟注入（测试用）
 * @param {() => {ok:boolean, [k:string]:any}} [o.probeEnvironment] 平台环境探针
 * @param {() => {ok:boolean, lastInputAt?:number, [k:string]:any}} [o.probeLastInput] 最后输入时间探针
 * @param {(plan:object) => object} [o.perform] 平台发送
 * @param {(line:string) => void} [o.log]
 * @returns {object}
 */
export function createDesktopInputSession({
  desktopId = 'default',
  now = () => Date.now(),
  probeEnvironment = () => ({ ok: false, code: REFUSE.notPlatform, text: '没有平台环境探针' }),
  probeLastInput = () => ({ ok: false, code: REFUSE.probeUnavailable, text: '没有输入探针' }),
  perform = () => ({ ok: false, code: REFUSE.notPlatform, text: '没有平台发送实现' }),
  /** 光标位置探针（判"合成输入"要用：有输入信号但光标不动）。 */
  cursorPosition = () => ({ ok: false }),
  /** 输入噪声采样：一次采多次，区分「真人在动」和「有程序在合成输入」。 */
  sampleNoise = () => ({ ok: false }),
  /** 前台窗口标题（`重新校验目标` 要用）。 */
  foregroundTitle = () => ({ ok: false }),
  /**
   * 这台桌面是否"信任合成输入"（用户可以开的开关）。
   *
   * 开：识别出合成输入源就照常干活（远程控制软件常驻时只能这样）。
   * 关（默认）：识别出来也**让开**，但把话说清楚 —— 用户才知道有个开关可开。
   */
  trustPhantomInput = () => false,
  log = () => {},
} = {}) {
  const lease = createLeaseState({ desktopId });
  const watchState = createWatchState({ desktopId });
  /** 最近一次动作的审计摘要（不含输入内容） */
  const recent = [];

  /**
   * 这张桌面上有没有"一直在合成输入"的东西（远程控制软件心跳之类）。
   *
   * 申请租约时采一次样就够：这个属性由那台软件决定，不会中途变。
   * 采样的成本不低（要多采几次才分得清人和心跳），所以不能每次输入都采。
   */
  let syntheticSource = false;
  let noiseDetail = null;
  /** 上一次看到的光标位置（判"这期间光标动过没有"）。 */
  let lastCursor = null;

  const pushAudit = (row) => {
    recent.push({ at: now(), ...row });
    if (recent.length > 50) recent.shift();
  };

  return {
    lease,
    watchState,
    /** 审计用：最近 50 次动作摘要（不含输入原文） */
    recentAudit: () => [...recent],

    /**
     * 申请（或续期）桌面租约。
     *
     * 返回 epoch —— 之后每次输入都要带上它。这不是形式主义：被抢占过的
     * 旧任务如果不知道自己已经被抢，下一次输入照样能发出去（串打）。
     */
    acquireLease({ taskId, botId, generation = null, ttlMs } = {}) {
      const r = acquire(lease, { taskId, botId, generation, now: now(), ...(ttlMs ? { ttlMs } : {}) });
      if (r.ok) {
        // ★ 拿到租约时采一次样，判"这台桌面有没有合成输入源"。
        //   为什么在这里：这个属性由那台软件决定，租约期内不会变；
        //   而采样本身要采好几次（分得清心跳和真人），不能每次点击都采。
        try {
          const noise = sampleNoise();
          if (noise?.ok) {
            syntheticSource = noise.kind === 'phantom';
            noiseDetail = { kind: noise.kind, samples: noise.samples ?? null, cursorStill: noise.cursorStill === true };
          }
        } catch { /* 采样失败就当没有合成输入源：保守方向是让开，不是硬干 */ }
        const cur = cursorPosition();
        lastCursor = cur?.ok ? { x: Number(cur.x), y: Number(cur.y) } : null;
        pushAudit({
          kind: 'lease_acquire', taskId, botId, epoch: r.epoch, renewed: r.renewed === true,
          syntheticSource, noise: noiseDetail,
        });
      }
      return r;
    },

    /** 诊断用：租约申请时那次采样的结论。 */
    inputEnvironment() {
      return { syntheticSource, noise: noiseDetail, trustPhantomInput: trustPhantomInput() === true };
    },

    /** 心跳续期。必须带 epoch。 */
    renewLease({ taskId, botId, epoch } = {}) {
      return renew(lease, { taskId, botId, epoch, now: now() });
    },

    /** 释放租约（任务结束）。 */
    releaseLease({ taskId, reason = '' } = {}) {
      const r = release(lease, { taskId, reason, now: now() });
      pushAudit({ kind: 'lease_release', taskId, reason: r.releasedReason ?? '' });
      return r;
    },

    /** 用户接管 / 任务取消 → 吊销。 */
    revokeLease({ reason = '', by = 'user' } = {}) {
      const r = revoke(lease, { reason, by, now: now() });
      pushAudit({ kind: 'lease_revoke', reason, by, epoch: r.epoch });
      return r;
    },

    /** 当前租约的一句话描述（给界面/审计）。 */
    describe() {
      return `${describeLease(lease, { now: now() })}；${describeWatch(watchState, { now: now() })}`;
    },

    /**
     * 做一次输入。**这是唯一入口** —— 工具层不许绕过它直接调平台。
     *
     * @param {object} p
     * @param {object} p.identity `{taskId, botId, epoch}`
     * @param {object} p.input 见 `planInput` 的入参（action/point/...）
     * @returns {{ok:true, at:object|null, plan:object, screen:object, foreground:string}
     *   | {ok:false, code:string, text:string}}
     */
    act({ identity = {}, input = {} } = {}) {
      const taskId = String(identity.taskId ?? '');
      const botId = String(identity.botId ?? '');
      const epoch = Number(identity.epoch);
      const t = now();

      // ① 有租约吗 —— 没有就**明确说"先申请"**，不要含糊成"被拒绝"
      const live = checkLease(lease, { now: t });
      if (!live.ok) {
        pushAudit({ kind: 'refuse', code: live.code, taskId, botId });
        const friendly = live.code === DENY.noLease
          ? { ...live, code: REFUSE.noLease, text: '桌面没有租约，先申请一次（lease_acquire）再操作屏幕' }
          : { ...live, code: live.code };
        return { ok: false, ...friendly };
      }
      // ② 是你持有的吗 + epoch 对不对
      const holder = assertHolder(lease, { taskId, botId, epoch, now: t });
      if (!holder.ok) {
        pushAudit({ kind: 'refuse', code: holder.code, taskId, botId, epoch });
        return { ok: false, ...holder };
      }

      // ③ 探环境：DPI 感知 / 屏幕矩形 / 有没有可操作会话
      const env = probeEnvironment();
      if (!env.ok) {
        pushAudit({ kind: 'refuse', code: env.code, taskId, botId });
        return { ok: false, ...env };
      }
      if (env.session === false) {
        // 锁屏 / 断开会话：规格 §5.4「暂停输入并释放租约，恢复后重新观察」
        revoke(lease, { reason: '没有可操作会话（锁屏/断开）', by: 'system', now: t });
        pushAudit({ kind: 'revoke', code: REFUSE.noSession, taskId, botId });
        return {
          ok: false,
          code: REFUSE.noSession,
          text: '当前没有可操作会话（可能锁屏或已断开），已释放租约，恢复后重新观察',
        };
      }

      // ④ 用户接管检测：**探针不可用也当"用户在"**（fail-closed）
      //
      // ★ 这里多一步"光标动过没有"：远程控制软件会不停刷新"最后输入时间"
      //   但从不移动光标。只看时间会把它的心跳当成"用户一直在动"，
      //   于是这个 bot 永远动不了鼠标（实测就在这台机器上）。
      const probe = probeLastInput();
      const lastInputAt = probe.ok ? Number(probe.lastInputAt) : null;
      const cur = cursorPosition();
      const cursorStill = (cur?.ok && lastCursor)
        ? (Number(cur.x) === lastCursor.x && Number(cur.y) === lastCursor.y)
        : null;
      if (cur?.ok) lastCursor = { x: Number(cur.x), y: Number(cur.y) };

      const trust = trustPhantomInput() === true;
      const verdict = watch({
        state: watchState,
        lastInputAt,
        now: t,
        cursorStill,
        // 只有"租约申请时判定有合成输入源"且"用户开了信任"，才允许把
        // userActive 降级成 phantom 并继续干。
        syntheticSource: syntheticSource && trust,
      });
      if (verdict.verdict === 'phantom_input') {
        // 继续，但记一笔：审计里要能看出"这次是按信任配置硬干的"
        pushAudit({ kind: 'phantom', code: 'synthetic_input', taskId, botId, why: verdict.reason });
      }
      if (verdict.action === WATCH_ACTION.yieldToUser) {
        revoke(lease, { reason: verdict.reason, by: 'user', now: t });
        pushAudit({ kind: 'revoke', code: REFUSE.yielded, taskId, botId, why: verdict.verdict });
        return {
          ok: false,
          code: REFUSE.yielded,
          text: `用户在这台电脑上动过手，已把控制权交还：${verdict.reason}`,
        };
      }
      if (verdict.action === WATCH_ACTION.wait) {
        // 只停这一次，**不吊销租约**：抖动抑制阶段的 pause 不是接管。
        // 两种情况分开报：判断得出"用户在动"和"我们看不清"对模型是两件事。
        const code = verdict.verdict === 'user_active' ? REFUSE.userActivePending : REFUSE.probeUncertain;
        pushAudit({ kind: 'wait', code, taskId, botId, why: verdict.verdict });
        return { ok: false, code, text: verdict.reason };
      }

      // ④.5 重新校验目标窗口（规格 §5.2「重新校验目标—执行」）
      //
      // ★ 必须在"规划"之前：用户切了窗口/弹了对话框之后，旧坐标打中的是
      //   别的东西，而且不会报错。调用方用 expectWindow（标题片段）声明"我打算
      //   操作的是哪个窗口"，这里对不上就直接拒绝，不去猜。
      const expectWindow = String(input?.expectWindow ?? '').trim();
      let foregroundBefore = '';
      if (typeof foregroundTitle === 'function') {
        const fg = foregroundTitle();
        foregroundBefore = fg?.ok ? String(fg.title ?? '') : '';
        if (expectWindow && !foregroundBefore.toLowerCase().includes(expectWindow.toLowerCase())) {
          pushAudit({ kind: 'refuse', code: REFUSE.targetChanged, taskId, botId, expectWindow, foregroundBefore });
          return {
            ok: false,
            code: REFUSE.targetChanged,
            text: `前台窗口是「${foregroundBefore || '(空)'}」，不是你说的「${expectWindow}」—— 没发这次输入。先重新观察再决定。`,
          };
        }
      }

      // ⑤ 规划 + 坐标校验（纯函数，一个平台调用都没有）
      const planned = planInput({ ...input, screen: env.screen });
      if (!planned.ok) {
        pushAudit({ kind: 'refuse', code: planned.code, taskId, botId, action: input?.action });
        return { ok: false, ...planned };
      }

      // ⑥ 发送
      const sent = perform(planned.plan);
      if (!sent.ok) {
        pushAudit({ kind: 'refuse', code: sent.code, taskId, botId, action: planned.plan.action });
        return { ok: false, ...sent };
      }

      // ⑦ ★ 必须记一笔"我们刚注入过" —— 否则下一次检测会把自己的输入当成用户接管
      noteInjection(watchState, { now: now() });

      // ⑧ 发完之后再看一眼前台窗口：变了就明确告诉上层（消息已经发出去了，
      //    撤回不了，所以这条不是"拒绝"而是"结果存疑"）。
      let foregroundAfter = sent.foreground ?? '';
      let targetKept = true;
      if (expectWindow && typeof foregroundTitle === 'function') {
        const fg = foregroundTitle();
        foregroundAfter = fg?.ok ? String(fg.title ?? '') : foregroundAfter;
        targetKept = !foregroundAfter || foregroundAfter.toLowerCase().includes(expectWindow.toLowerCase());
      }

      pushAudit({
        kind: 'inject',
        taskId,
        botId,
        epoch,
        action: planned.plan.action,
        // 只记摘要，不记输入的文字原文（规格 §5.5：审计不带秘密）
        summary: describePlan(planned.plan),
        foreground: sent.foreground ?? '',
        // ★ 规格 §5.5 要求审计能回答"凭哪一条授权干的"。
        //   调用方给了就用给的；没给就从 `grant-context` 取"刚才放行的那条"
        //   （5 分钟过期，动作必须对得上）—— 它是判定的回音，**不是**授权来源。
        grantId: identity.grantId
          ?? currentGrantOf({ botId, action: 'desktop.input', now: t })?.grantId
          ?? null,
        expectWindow: expectWindow || null,
        targetKept,
        syntheticSource,
      });
      return {
        ok: true,
        at: sent.at ?? null,
        plan: planned.plan,
        screen: env.screen,
        foreground: foregroundAfter,
        expectWindow: expectWindow || null,
        targetKept,
      };
    },

    /** 回收过期/僵住的租约（上层定时调）。 */
    sweepLeases() {
      const r = sweep(lease, { now: now() });
      if (r.released) pushAudit({ kind: 'sweep', taskId: r.released.taskId, why: r.released.why });
      return r;
    },
  };
}

/**
 * 按运行平台选实现。**这是全仓库唯一一处"今天是什么平台"的判断** ——
 * 工具层、装配层都不知道自己在 Windows 还是 macOS 上。
 *
 * | 平台 | 实现 | 状态 |
 * |---|---|---|
 * | win32 | `desktop-input-win.js` | 已实机验证 |
 * | darwin | `desktop-input-mac.js` | **空壳**（每个入口返回 not_platform） |
 * | 其它 | 空槽位（同上） | 不支持 |
 *
 * macOS 的空壳不是"忘了写"，是刻意的：桌面输入点错了就是点了。
 * 一个"大部分情况能跑"的实现比没有更危险 —— 它会让上层以为这条路通了。
 * 要改哪里、怎么改、先验什么，全写在 `docs/MACOS-DESKTOP-INPUT.md`。
 */
function platformForCurrentOS() {
  const chosen = process.platform === 'win32' ? winPlatform : macPlatform;
  return {
    probeEnvironment: chosen.probeEnvironment,
    probeLastInput: chosen.lastInputAt,
    perform: chosen.perform,
    sampleNoise: chosen.sampleInputNoise,
    cursorPosition: chosen.cursorPosition,
    foregroundTitle: chosen.foregroundTitle,
  };
}

/** 当前平台实现。测试可以通过 `setDesktopInputPlatform()` 换掉。 */
let platform = platformForCurrentOS();

/** 当前平台实现的只读视图（工具层做诊断时用）。 */
export function desktopInputPlatform() {
  return platform;
}

/**
 * 换掉平台实现（**只给测试用**）。换掉会顺带清掉单例会话，
 * 免得旧会话还挂着旧探针。
 *
 * 不给生产代码留"运行时切平台"的口子：平台是进程的事实，
 * 运行中换实现只会让两次审计出自不同的坐标基准。
 */
export function setDesktopInputPlatform(over = {}) {
  platform = { ...platform, ...over };
  resetDesktopInputSession();
  return platform;
}

/** 进程级单例（一个桌面一份租约）。 */
let singleton = null;

/**
 * 拿进程级会话。
 *
 * @param {object} [deps] 首次调用时注入依赖（测试用）；之后忽略
 * @returns {object}
 */
export function desktopInputSession(deps) {
  if (!singleton) {
    singleton = createDesktopInputSession(deps ?? {
      probeEnvironment: (...a) => platform.probeEnvironment(...a),
      probeLastInput: (...a) => platform.probeLastInput(...a),
      perform: (...a) => platform.perform(...a),
      sampleNoise: (...a) => platform.sampleNoise(...a),
      cursorPosition: (...a) => platform.cursorPosition(...a),
      foregroundTitle: (...a) => platform.foregroundTitle(...a),
      // 用户在设置里显式打开"信任合成输入"之后，才允许无视远程控制软件的心跳
      trustPhantomInput: () => store.desktopSettings().trustPhantomInput === true,
    });
  }
  return singleton;
}

/** 测试用：把单例清掉。 */
export function resetDesktopInputSession() {
  singleton = null;
}
