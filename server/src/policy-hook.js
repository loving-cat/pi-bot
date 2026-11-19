/**
 * 命令策略的执行点：拦截 shell 类工具调用，命中规则就阻止执行。
 *
 * 以 pi 扩展的形式注入会话（inline extension），只注册 `tool_call` 一个处理器：
 *   · 会执行命令的工具（bash / powershell / run_background / write_stdin）走同一套判定；
 *   · 规则从 store 实时读取 —— 改规矩后新建的会话立即生效；
 *   · 拒绝时写一条审计记录，并把原因回给模型（模型据此换做法，不会卡死）。
 */
import { noteGrant } from './grant-context.js';
import crypto from 'node:crypto';
import { config as defaultConfig } from './config.js';
import { ACTION } from './grants.js';
import { store as defaultStore } from './store.js';
import { verdictForTool } from './shell-policy.js';
import { log } from './util.js';
import { bus as defaultBus } from './bus.js';
import { loadHooks, applyHooks } from './hooks.js';
import { readonlyBlockReason, opaqueScriptBlockReason, MUTATING_TOOLS, isSecurityConfigCall, isJarvisApprovalCall, CHIEF_ONLY_TOOLS, needsSecondFactor } from './role-tools.js';
import { buildConfirmation, checkConfirmation, digestOf } from './confirm.js';
import { isExternalMcpTool, externalApprovalSummary, mcpAccessSignature } from './mcp-access.js';
import { mcpApprovalSummary } from './mcp-approval-summary.js';

// ★ 工具级“只给主控”的执行边界兜底（工具集之外的第二道）。
//   为什么执行边界还要再判一次：会话是按 roomId:botId 缓存复用的，能不能重建
//   取决于 roleConfigurationKey —— 升级代码、改角色、或者旧版本留下的会话，都可能
//   带着已经不该给它的工具句柄继续跑。工具集那道门在“造工具”时生效，这道在“真调用”时生效。
const CHIEF_ONLY_SET = new Set(CHIEF_ONLY_TOOLS);

/**
 * 二级强确认的“目标”：用来绑定“用户批的就是这件事”。
 *
 * 只取会影响结果的标识（哪个 bot / 哪个技能 / 哪条策略），**不含凭据**。
 * 摘要绑定的意义：用户批的是“删掉 X”，模型就不能拿这张票去删 Y。
 */
function secondFactorTargetOf(tool, input = {}) {
  const raw = input ?? {};
  const pick = (k) => String(raw[k] ?? '').trim().slice(0, 120);
  const list = (v) => (Array.isArray(v)
    ? v.map((x) => String(x).slice(0, 120)).sort().slice(0, 50)
    : null);

  switch (tool) {
    case 'delete_bot':
      return { tool, id: pick('id') || pick('botId'), name: pick('name') };
    case 'manage_department':
      // ★ 参数名是 groupId（见 jarvis-tools.js），不是 id。
      //   漏了它就等于不绑目标：批删测试部门 A，模型可以拿这张票去删生产部门 B。
      return { tool, op: 'delete', groupId: pick('groupId') || pick('id'), name: pick('name') };
    case 'manage_knowledge':
      // 带 op：删技能和删经验是两种动作，同 id 也不该撞摘要
      return { tool, op: pick('op'), id: pick('id'), name: pick('name') };
    case 'manage_model_group':
      return { tool, op: 'delete', id: pick('id'), name: pick('name') };
    case 'set_policy': {
      // ★ 改策略必须把**所有会一起生效的字段**都绑进来。
      //   用户批的是「requireProof: true」，模型重试时调包成
      //   dangerous:'allow' + allowLocalApproval:true 就是另一件事了 ——
      //   只绑 op 等于给了一个万能确认。
      const boolOrNull = (v) => (v === undefined ? null : v === true);
      // ★ 用 isFinite 而不是 `|| null`：`awayAfterMs: 0` 是**合法配置**
      //   （安静就动手），被折成 null 之后会和“根本没传”算出同一个摘要。
      const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
      return {
        tool,
        op: 'update',
        dangerous: pick('dangerous'),
        requireProof: boolOrNull(raw.requireProof),
        denyCommands: list(raw.denyCommands),
        allowCommands: list(raw.allowCommands),
        trustPhantomInput: boolOrNull(raw.trustPhantomInput),
        allowLocalApproval: boolOrNull(raw.allowLocalApproval),
        awayAfterMs: numOrNull(raw.awayAfterMs),
      };
    }
    case 'manage_mcp_server':
      return { tool, op: pick('op') || (raw.enabled === true ? 'enable' : ''), id: pick('id'), name: pick('name') };
    case 'import_local_capabilities':
      // ★ 这个工具没有 id/name，参数是 kind / names / all / enable。
      //   取错字段 = 不绑目标：names:['a'] 和 names:['b']、甚至 all:true
      //   会算出同一个摘要，一张票就能导入/启用别的批次。
      return {
        tool,
        kind: pick('kind'),
        all: raw.all === true,
        names: list(raw.names),
        enable: raw.enable === true,
      };
    default:
      return { tool, key: pick('id') || pick('name') || pick('target') };
  }
}

/** 执行命令的工具名 */
const SHELL_TOOLS = new Set(['bash', 'powershell']);

/**
 * 能"往 shell 里塞命令"的全部工具。
 *
 * ★ 必须包含 write_stdin，否则有个绕过：
 *   run_background 批准一次之后，模型可以反复用 write_stdin 往那个后台 shell
 *   里灌任意命令 —— 不弹卡、还吃 120 分钟授权窗口。等于批准的是一条无害命令，
 *   实际执行的是后面灌进去的一切。
 *
 * kill_shell 不在里面：它只能杀进程，不能执行东西。
 */
const SHELL_LIKE = new Set(['bash', 'powershell', 'run_background', 'write_stdin']);

/** ask 档要批准的工具，与 role-tools 的名单是同一份 */
const MUTATING = new Set(MUTATING_TOOLS);

/** 把一次调用压成一句人话，给审批卡片看 */
export function summarizeToolCall(tool, input = {}, mcpOpts = null) {
  if (isExternalMcpTool(tool)) {
    // ★ 审批卡要能看到"它要干什么"，但不能泄漏凭据。
    //   原来这里只回一句"调用外部工具 mcp__x__y"，用户等于盲批；
    //   直接把 input 贴上去又会让模型传进来的 key/token 落进审批记录。
    //   见 mcp-approval-summary.js：结构保留、值按凭据特征打码。
    const detail = mcpApprovalSummary(input, mcpOpts ?? {});
    return `${externalApprovalSummary(tool)}｜${detail}`;
  }
  const pick = (k) => (typeof input?.[k] === 'string' ? input[k] : '');
  if (SHELL_TOOLS.has(tool) || tool === 'run_background') {
    return pick('command') || pick('cmd') || '(命令)';
  }
  if (tool === 'write') {
    const body = pick('content');
    return `${pick('path') || '(文件)'}${body ? `（写 ${body.length} 字）` : ''}`;
  }
  if (tool === 'edit') return pick('path') || '(文件)';
  if (tool === 'write_stdin') return `${pick('shell_id')} ← ${pick('chars')}`;
  if (tool === 'kill_shell') return pick('shell_id') || '(进程)';
  return JSON.stringify(input ?? {}).slice(0, 200);
}

/** 同一次调用（工具 + 入参）的指纹：批准一次只放行同一个动作 */
export function approvalHash(tool, input, scope = null) {
  return crypto
    .createHash('sha1')
    .update(`${tool}
${JSON.stringify(input ?? {})}${scope ? `\n${JSON.stringify(scope)}` : ''}`)
    .digest('hex');
}

/**
 * @param {{roomId:string, bot:object}} ctx
 * @returns {{name:string, hidden:boolean, factory:Function}}
 */
/**
 * 命令策略的执行点：拦截 shell 类工具调用，命中规则就阻止执行。
 *
 * @param {object} p
 * @param {string} p.roomId
 * @param {object} p.bot
 * @param {(approval:object, info:{created:boolean})=>void} [p.onBlocked]
 *   真实的**策略阻塞观察**回调：一次调用被 pending 审批挡住时通知调用方。
 *   复用已有 pending 与新建 pending 两条路径都会触发。
 *   仅供观察（例如受管执行记录「我在等哪个真实审批」），不参与放行判定。
 */
/**
 * 这个 MCP 工具所属 server 已存的凭据键名（env + header 的 key）。
 *
 * 用途：审批卡脱敏。模型可能把 \`api_key\` 传成 \`FOO\`（用户 env 里的名字），
 * 只看键名 \`FOO\` 判断不出是凭据，但它确实是同一个值 —— 必须遮掉。
 */
/**
 * 这个 bot 是不是挂了任何外部 MCP 工具。
 *
 * 用途：挂了 MCP 的 bot，shell 类工具要逐次审批 —— 否则模型可以用 bash
 * 去起同一个 MCP（或任何别的程序），绕过 MCP 那一层的管控。
 */
function botHasMcp(bot, st = defaultStore) {
  try {
    if (!bot?.id) return false;
    // 解析出真正会连上的服务（enabled 且被这个 bot 选中）
    return st.mcpServersFor(bot.id).length > 0;
  } catch {
    return false;
  }
}

function mcpServerSecretKeys(tool, st = defaultStore) {
  try {
    const parts = /^mcp__([A-Za-z0-9_-]{1,80})__/.exec(String(tool ?? ''));
    if (!parts) return [];
    const name = parts[1].toLowerCase();
    const record = st.state.mcpServers?.find(
      (s) => String(s?.name ?? '').toLowerCase() === name,
    );
    return Array.isArray(record?.credentialKeys)
      ? record.credentialKeys.filter((k) => typeof k === 'string')
      : [];
  } catch {
    return [];
  }
}

export function createPolicyExtension({
  roomId, bot, onBlocked = () => {}, managedContextOf = null, grantGate = null,
  talkLane = false,
  config: scopedConfig = null,
  store: scopedStore = null,
  bus: scopedBus = null,
  /**
   * 这个会话的执行模式（规格 §8）。由 `session-factory` 算好传进来 ——
   * 那里才知道命令工具换没换成沙箱版。
   *
   * ★ 以前这里**不传**，于是 `grantGate.check()` 的 `mode` 参数永远是 undefined，
   *   `candidatesFor` 里那一道 `.filter((g) => !mode || g.mode === mode)` 直接短路掉了。
   *   后果：一条 `isolated` 授权在 `host` 会话里照样能用，反之亦然 ——
   *   规格 §8 整节在运行时不生效。
   *
   * 不给时（测试环境）传 null，与原来行为一致（不按模式过滤）。
   */
  mode = null,
}) {
  const config = scopedConfig ?? defaultConfig;
  const store = scopedStore ?? defaultStore;
  const bus = scopedBus ?? defaultBus;
  /** 通知观察者：这次调用被某条 pending 审批挡住了。 */
  function notifyBlocked(approval, created) {
    if (typeof onBlocked !== 'function') return;
    try {
      onBlocked(approval, { created: created === true });
    } catch {
      // 观察者出错不能影响策略判定
    }
  }

  return {
    name: 'policy',
    hidden: true,
    factory: (pi) => {
      pi.on('tool_call', (event) => {
        const tool = event?.toolName;
        const policy = store.policy();

        // 执行前读取当前角色：审批授权和缓存中的旧工具不能绕过只读模式。
        //
        // ★ 这里原来还有一道“负责人只能用 leadToolAllowed 里的工具”的门，
        //   实测后果是：哪怕用户把 bash 写进 PI_BOT_LEAD_TOOLS，负责人也永远
        //   拿不到 —— 而且拦下的理由写的是“请把这项操作交给成员执行”，
        //   用户完全看不出问题出在哪里。
        //
        //   现在改成只靠工具集本身（按配置 + 角色算出来的那一份）控制，
        //   不再在执行边界做第二次静默收窄。“先派后干”是提示词层面的行为规矩。
        const currentBot = store.getBot(bot?.id) ?? bot;

        // ★ 只读：默认拒绝。审批授权、命令白名单和会话里残留的工具都不能放行。
        const readonlyReason = readonlyBlockReason(policy, tool);
        if (readonlyReason) return { block: true, reason: readonlyReason };

        // ★ 只给主控的工具，执行边界再兜一次（CHIEF_ONLY_TOOLS）。
        //
        //   为什么非要有这一道：`desktop.observe` 这个**动作**的 migration 是 'all'
        //   （2026-11-16 起，因为 T1 独立桌面上的观察用的是同一个动作），于是成员
        //   在网关那层是拿得到这类授权的 —— 真正的 T2 边界在**工具级**：
        //   `desktop_observe` / `desktop_screenshot` / `desktop_input` / `desktop_lease`
        //   都标了 chiefOnly。工具集那道门只在“造工具”时生效；会话缓存复用、
        //   角色变更、旧版本残留的句柄都可能绕过它，所以真调用时必须再判一次。
        if (currentBot?.role !== 'main' && CHIEF_ONLY_SET.has(tool)) {
          return {
            block: true,
            reason: `「${tool}」只给主控用（它是 T2 用户桌面的工具）。`
              + '成员要看自己的桌面请用 desktop_island_*（T1 独立桌面）；'
              + '不要换成别的工具或让主控代做来绕开这条。',
          };
        }
        // 主控（贾维斯宿主模式）：非只读、非 Talk 旁路时享受宿主最高执行权限
        const isJarvisHost = !talkLane && currentBot?.role === 'main' && config.jarvisMode !== false && policy?.dangerous !== 'deny';
        const scriptReason = isJarvisHost ? null : opaqueScriptBlockReason(policy, tool);
        if (scriptReason) return { block: true, reason: scriptReason };

        // ★ 授权网关（P0-1）：**在执行边界逐次核**。
        //
        //   顺序刻意放在角色/只读/脚本判定**之后**：那些是"这个工具本身允许吗"，
        //   网关回答的是"这个人有没有资格做这次动作"，两者都要过。
        //   但它必须在命令黑名单与审批**之前** —— 没资格的动作不该先弹一张
        //   "要不要批准"的卡片给用户，那等于用麻烦换一个本该直接拒绝的请求。
        //
        //   网关不可用（没装 = 理论上只有测试环境）时**不拦截**：
        //   否则所有未接网关的单测一次性红掉。生产环境 server-main 一定装它。
        if (grantGate && typeof grantGate.check === 'function') {
          const mapped = grantGate.actionForTool(tool);
          if (mapped) {
            const subject = { botId: bot?.id ?? '', role: currentBot?.role ?? '', instanceId: '' };
            const taskCtx = typeof managedContextOf === 'function' ? managedContextOf() : null;
            const verdict = grantGate.check({
              subject,
              action: mapped.action,
              targets: grantGate.targetsForTool(tool, event?.input ?? {}),
              params: event?.input ?? {},
              taskId: taskCtx?.taskRunId ?? null,
              // ★ 把执行模式传进去。不传的话 `candidatesFor` 里那道
              //   `.filter((g) => !mode || ...)` 只是短路，等于没判 ——
              //   一条 isolated 授权在 host 会话里也能过。
              mode: mode || null,
            });
            if (verdict.ok) {
              // ★ 记下"这次是凭哪一条授权放行的"（规格 §5.5 的「授权引用」）。
              //   判定在这里、审计在下游，中间隔着一次工具调用 —— 没有参数能把
              //   grantId 传下去，所以用 grant-context 这一层极小的传递。
              //   它**不是授权**，只是刚才那次判定的结果（5 分钟过期）。
              noteGrant({
                botId: subject.botId,
                grantId: verdict.grant?.id ?? null,
                action: mapped.action,
              });
            }
            if (!verdict.ok) {
              if (isJarvisHost && mapped.action !== ACTION.gitDestructive && verdict.code !== 'revoked') {
                noteGrant({
                  botId: subject.botId,
                  grantId: 'jarvis-host',
                  action: mapped.action,
                });
                try {
                  store.addAdminAction({
                    action: mapped.action,
                    level: 'defense',
                    label: `主控宿主执行：${tool}`,
                    method: 'TOOL',
                    path: String(tool ?? ''),
                    deviceId: subject.botId || 'chief',
                    deviceName: currentBot?.name ?? '主控',
                  });
                } catch {}
              } else {
                log(
                  `⛔ ${currentBot?.name ?? bot?.id ?? 'bot'} 的动作被授权网关拒绝（${verdict.code}）` +
                    `${mode ? `〔${mode} 模式〕` : ''}：` +
                    `${tool} —— ${verdict.text}`,
                );
                return {
                  block: true,
                  reason: `这次操作没有被授权：${verdict.text}（${verdict.code}）。` +
                    '不要换工具或换编码重试；如果确实需要，向用户说明要新增什么权限。',
                };
              }
            }
          }
        }

        // ---- 钩子：可以先改入参（重写命令），也可以直接拦下 ----
        const hooked = applyHooks(loadHooks(), { tool, input: event?.input ?? {} });
        if (hooked.blocked) return { block: true, reason: hooked.reason };
        if (hooked.applied.length) {
          // 就地改写入参（SDK 约定：mutate event.input 即可生效）
          if (event?.input && typeof event.input === 'object') {
            Object.assign(event.input, hooked.input);
          }
        }

        // 命令规矩在审批之前：批准、临时放行都不能绕过黑名单/白名单（主控豁免成员白名单）。
        const commandPolicy = isJarvisHost ? { ...policy, allowCommands: [] } : policy;
        const commandVerdict = verdictForTool(tool, event?.input, commandPolicy);
        if (commandVerdict && !commandVerdict.allowed) {
          const command = tool === 'write_stdin'
            ? (event?.input?.chars ?? '')
            : (event?.input?.command ?? event?.input?.cmd ?? '');
          store.addDenial({
            roomId,
            botId: bot?.id ?? null,
            botName: bot?.name ?? '',
            command,
            rule: commandVerdict.rule ?? commandVerdict.deniedBy,
            reason: commandVerdict.reason,
          });
          log(
            `⛔ ${bot?.name ?? bot?.id ?? 'bot'} 的命令被拦（${commandVerdict.reason}）：` +
              String(command).replace(/\s+/g, ' ').slice(0, 120),
          );
          return { block: true, reason: commandVerdict.message };
        }

        // ---- 外部 MCP 工具：一律逐次审批 ----
        //
        // ★ 这段必须放在 `dangerous === 'ask'` 判断**外面**。
        //
        //   早先的写法把外部 MCP 工具整块包进了 ask 档，于是默认的 allow 档下
        //   任何外部 MCP 工具都直接放行 —— 模型只要能调用 mcp__dbg__run，
        //   就等于拿到一个免审批的任意执行入口。
        //
        //   后来试过给"只读工具"留免审批通道（按动词猜 / 按可执行名 /
        //   按配置精确形状），但每一版都只是"我们以为它安全"：
        //   MCP 是被调用方，它随时能在下一次更新里改变行为。
        //   所以现在**不存在 static 档**：所有外部 MCP 工具都要审批。
        const externalMcp = isExternalMcpTool(tool);

        // ★ 挂了 MCP 的 bot，shell 类工具也要逐次审批。
        //
        //   为什么：MCP 一旦挂上，它自己的工具是管控的，但模型完全可以用
        //   bash 去起同一个 MCP（或任何别的程序）绕过检查 —— 等于开了后门。
        //   所以"这个 bot 有外部能力"本身就是提高 shell 风险的因素。
        //
        //   没挂 MCP 的 bot 行为保持不变（allow 档不弹卡）。
        //   挂 MCP 时，**所有能执行/注入命令的工具**都逐次审批 ——
        //   包括 write_stdin（往已批准的后台 shell 里灌命令）。
        const shellWithMcp = !externalMcp && SHELL_LIKE.has(tool) && botHasMcp(currentBot, store);
        // 启用 MCP 时用来判断「这个 server 是不是本来就开着」（幂等调用不该弹卡）
        const mcpEnableOpts = {
          isMcpAlreadyEnabled: (inp) => {
            const target = String(inp?.id ?? inp?.name ?? '').trim().toLowerCase();
            if (!target) return false;
            return store.mcpLibrary().some((s) =>
              (s.id.toLowerCase() === target || s.name.toLowerCase() === target) && s.enabled === true);
          },
        };
        // 注：二级强确认那几类已经在上面的专门分支处理（git_destructive 由 git-tools 自己弹），
        // 这里用 !needsSecondFactor 把它们排除掉 —— 否则同一个动作会同时收到 approval 与 confirmation 两张卡。

        // ★ 改安全配置本身：有些工具**不论档位**都必须逐次审批。
        //
        //   模型能 add_mcp_server 一个带任意 command 的本地服务、
        //   再 update_bot 挂到任意 bot —— 挂上之后那些 MCP 工具就成了它的
        //   新执行入口。这条链上每一步都不该让模型自己走完：
        //   它不是"做活"，是**改防线**。
        const securityConfig = isSecurityConfigCall(tool, event?.input);
        const jarvisNeedsApproval = isJarvisHost && !needsSecondFactor(tool, event?.input) && isJarvisApprovalCall(tool, event?.input, {
          isMcpAlreadyEnabled: (inp) => {
            const target = String(inp?.id ?? inp?.name ?? '').trim().toLowerCase();
            if (!target) return false;
            return store.mcpLibrary().some((s) =>
              (s.id.toLowerCase() === target || s.name.toLowerCase() === target) && s.enabled === true);
          },
        });

        // ★ 二级强确认（2026-11-19 拍板）：高危、不可撤销的动作**本机批准不算**。
        //
        //   规格 §9 已经承认：主 Bot 拿到宿主 shell 之后能自己弹卡自己点。
        //   所以删 Bot / 解散部门 / 删技能与经验 / 改全局策略 / 删模型组 / 破坏性 git
        //   这几类必须走 /api/confirmations（minChannel=device，即已配对手机）。
        //
        //   git_destructive 刻意排除：它自己（git-tools.js）在动手前已经
        //   requestConfirmation 了，这里再弹一张就是双卡。
        // ★ 刻意不再要求 isJarvisHost：jarvisMode=false 只是关掉「宿主豁免」，
        //   不该顺手把高危动作的强确认也关掉 —— 那正好是最不该被跳过的场景。
        if (tool !== 'git_destructive' && needsSecondFactor(tool, event?.input, mcpEnableOpts)) {
          const target = secondFactorTargetOf(tool, event?.input);
          const digest = digestOf(target);
          const nowMs = Date.now();
          const live = (store.state.confirmations ?? []).find(
            (c) => c.action === tool && c.targetDigest === digest
              && c.decision === 'approved' && !c.consumedAt
              // ★ 必须判过期：过期批准还能用的话，「一次一用」就变成「一直能用」
              && nowMs < Number(c.expiresAt ?? 0),
          );
          if (live) {
            const chk = checkConfirmation({
              confirmation: live,
              target,
              policyRevision: store.policyVersion(),
              allowLocal: store.desktopSettings().allowLocalApproval === true,
            });
            if (chk.ok) {
              store.consumeConfirmation(live.id);
              log(`✅ 手机已确认过，放行一次：${tool}`);
              return undefined;
            }
          }
          const summary = summarizeToolCall(tool, event?.input);
          // ★ 过期卡片不能让同一目标死锁：它既不会被批准（checkConfirmation 会判
          //   expired），也不该继续挡住新卡片 —— 所以这里必须带过期判断。
          const pending = (store.state.confirmations ?? []).find(
            (c) => c.action === tool && c.targetDigest === digest && c.decision === null
              && nowMs < Number(c.expiresAt ?? 0),
          );
          const card = pending ?? store.requestConfirmation(buildConfirmation({
            // buildConfirmation 不会自己生成 id（它只是把字段冻结成一条记录），
            // 不给 id 的话 requestConfirmation 会直接返回 null —— 这里别省。
            id: `cf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
            action: tool,
            target,
            summary,
            minChannel: 'device',
            roomId,
            requestedBy: bot?.id ?? null,
            policyRevision: store.policyVersion(),
          }));
          if (pending) {
            return {
              block: true,
              reason: '这次高危操作还在等用户**在手机上**确认（卡片已经在会话里），先别重复调用。',
            };
          }
          if (card) {
            const msg = store.appendMessage({
              roomId,
              authorType: 'bot',
              authorId: bot?.id ?? null,
              authorName: bot?.name ?? '',
              authorEmoji: bot?.emoji ?? null,
              kind: 'confirmation',
              text: `${bot?.name ?? '它'} 想执行：${summary} —— 需要在手机上确认`
                + `${card.minChannel === 'device' ? '（本机批准不算）' : ''}`,
              status: 'done',
              meta: {
                confirmationId: card.id,
                tool,
                action: tool,
                summary,
                irreversible: true,
                minChannel: card.minChannel ?? null,
              },
            });
            bus.emit('event', { t: 'msg.new', msg });
          }
          log(`🛡 二级强确认：${bot?.name ?? 'bot'} 的 ${tool} 需要手机确认`);
          return {
            block: true,
            reason: '这次操作是不可撤销的高危动作，需要在**手机上**确认（本机桌面批准不算）。'
              + '确认卡已经发在会话里；用户在手机上点批准后，再调用一次就会执行（一次一用）。',
          };
        }

        // ---- 第三档：每一次"会动手"的调用都要用户点批准 ----
        if (
          isJarvisHost
            ? jarvisNeedsApproval
            : (securityConfig ||
               externalMcp ||
               shellWithMcp ||
               (policy.dangerous === 'ask' && (MUTATING.has(tool) || isExternalMcpTool(tool))))
        ) {
          const capabilityRevision = isExternalMcpTool(tool)
            ? mcpAccessSignature(currentBot, store.mcpLibrary()) : null;
          const managed = typeof managedContextOf === 'function' ? managedContextOf() : null;
          // 用户批准过"本次任务" → 这个 bot 在这个会话里有一段时间不用逐条点。
          //
          // ★ dynamic MCP 工具**不吃这个窗口**。
          //   任务级授权本来是给"这个活我已经批准过做法了"用的，
          //   但一个会驱动外部进程的工具，每一次调用的实际参数都可能完全不同
          //   （这次 attach 8743 端口、下次 attach 别的），窗口覆盖等于盲开。
          //   static / 内置工具仍按原逻辑享受窗口。
          // 能享受"本次任务授权"窗口（120 分钟）的只有**纯内置动手工具**，
          // 前提是这个 bot 没挂任何 MCP。
          //
          //   不吃窗口的三类：
          //     · securityConfig  改策略/挂 MCP —— 改的是防线本身
          //     · externalMcp     外部工具 —— 每次调用的实际效果都可能完全不同
          //     · shellWithMcp    bot 挂了 MCP 时的 shell —— 可以用它绕过 MCP 管控
          if (!securityConfig && !externalMcp && !shellWithMcp && !jarvisNeedsApproval && !managed &&
              store.hasApprovalGrant({ roomId, botId: bot?.id ?? null, capabilityRevision })) return undefined;
          const scope = capabilityRevision ? { roomId, botId: bot?.id ?? null, capabilityRevision } : null;
          const hash = approvalHash(tool, event?.input, scope);
          // 批准过的那一次直接放行（而且只用一次）；受管只消费本任务本版本的批准
          if (store.takeApproved(hash, {
            taskRunId: managed?.taskRunId ?? null,
            taskRevision: managed?.revision ?? null,
          })) return undefined;

          const existing = store.findPendingApproval({
            roomId,
            botId: bot?.id ?? null,
            hash,
            taskRunId: managed?.taskRunId ?? null,
            taskRevision: managed?.revision ?? null,
          });
          if (existing) {
            // ★ 真实阻塞观察：这次调用确实被这条既有审批挡住了
            notifyBlocked(existing, false);
            return {
              block: true,
              reason: '这一次操作还在等用户批准（卡片已经发在会话里了），先别重复调用。',
            };
          }

          // MCP：把那个 server 已存的 env/header 键名交给摘要器，
          // 这样"模型把凭据当普通参数传"的情况也能遮住（光看键名判断不出来）。
          const mcpOpts = isExternalMcpTool(tool)
            ? { secretKeys: mcpServerSecretKeys(tool, store) }
            : null;
          const summary = summarizeToolCall(tool, event?.input, mcpOpts);
          const approval = store.createApproval({
            roomId,
            botId: bot?.id ?? null,
            botName: bot?.name ?? '',
            tool,
            summary,
            taskRunId: managed?.taskRunId ?? null,
            taskRevision: managed?.revision ?? null,
            attemptId: managed?.attemptId ?? null,
            // MCP 也记一份**脱敏后**的入参：原来这里是 null，
            // 事后想查"当时到底批了什么"什么都看不到。
            input: isExternalMcpTool(tool)
              ? { __masked: summary }
              : event?.input ?? null,
            hash,
            capabilityRevision,
          });
          notifyBlocked(approval, true);
          const msg = store.appendMessage({
            roomId,
            authorType: 'bot',
            authorId: bot?.id ?? null,
            authorName: bot?.name ?? '',
            authorEmoji: bot?.emoji ?? null,
            kind: 'approval',
            text: `${bot?.name ?? '它'} 想执行：${summary}`,
            status: 'done',
            meta: {
              approvalId: approval.id,
              tool,
              summary,
            },
          });
          bus.emit('event', { t: 'msg.new', msg });
          log(`🛡 ${bot?.name ?? 'bot'} 的操作等待批准：${String(summary).slice(0, 80)}`);
          return {
            block: true,
            reason:
              '这一次操作需要用户批准，批准卡片已经发在会话里。' +
              '先不要重复调用；等用户点了批准会再来找你继续。',
          };
        }
      });
    },
  };
}
