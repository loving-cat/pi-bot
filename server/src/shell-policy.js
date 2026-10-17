/**
 * 命令级策略：把「部门规矩」从"给不给 bash"细化到"哪些命令不许跑"。
 *
 * 纯函数，不碰进程与网络。分三步：
 *   1. 归一化：去掉不可见字符，还原 shell 的引号与转义，得到命令真正会执行的形态；
 *   2. 解析：按 `&& || ; | &` 切段，每段取可执行体、参数与子命令；
 *   3. 判定：deny 规则优先 → 无法静态判定则拒绝（fail-closed）→ allow 清单。
 *
 * 归一化是必要的一步：`r''m -rf /`、`\rm -rf /`、`"rm" -rf /`、`$'\x72m' -rf /`
 * 在 shell 里都是同一个命令，只按原始字符串比较会被绕过。
 */

/** 零宽字符与控制字符（含方向控制符），只用于干扰匹配 */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** 规则上限：单条长度、单边数量 */
export const RULE_MAX_LEN = 512;
const RULE_MAX_COUNT = 200;

/** 去掉不可见字符并合并空白 */
export function normalizeCommand(raw) {
  return String(raw ?? '')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 还原 shell 的引号与转义。
 *
 * 支持：`'…'`（字面）、`"…"`（只识别 `\" \$ \` \\ \换行`）、
 * `$'…'`（ANSI-C：`\n \t \xNN \uNNNN`）、裸反斜杠转义。
 */
export function unescapeShellQuotes(raw) {
  const s = String(raw ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];

    // $'…' —— ANSI-C 引用
    if (c === '$' && s[i + 1] === "'") {
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] !== '\\') {
          out += s[i++];
          continue;
        }
        const n = s[i + 1];
        i += 2;
        if (n === 'x') {
          const hex = s.slice(i, i + 2);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 2;
          } else out += 'x';
        } else if (n === 'u') {
          const hex = s.slice(i, i + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else out += 'u';
        } else {
          out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        }
      }
      i++; // 跳过收尾的单引号
      continue;
    }

    if (c === "'") {
      i++;
      while (i < s.length && s[i] !== "'") out += s[i++];
      i++;
      continue;
    }

    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          if (n === '"' || n === '$' || n === '`' || n === '\\') {
            out += n;
            i += 2;
            continue;
          }
          if (n === '\n') {
            i += 2;
            continue;
          }
        }
        out += s[i++];
      }
      i++;
      continue;
    }

    if (c === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/** 在引号外切分命令段；同时标记"无法静态判定"的构造 */
function splitSegments(raw) {
  const segments = [];
  let buf = '';
  let i = 0;
  let quote = null; // null | "'" | '"' | 'ansi'
  let opaque = null;

  const push = () => {
    const text = buf.trim();
    if (text) segments.push(text);
    buf = '';
  };

  while (i < raw.length) {
    const c = raw[i];
    const next = raw[i + 1];

    if (quote === 'ansi') {
      if (c === '\\') {
        buf += c + (next ?? '');
        i += 2;
        continue;
      }
      if (c === "'") quote = null;
      buf += c;
      i++;
      continue;
    }
    if (quote) {
      if (c === '\\' && quote === '"') {
        buf += c + (next ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      buf += c;
      i++;
      continue;
    }

    if (c === '$' && next === "'") {
      quote = 'ansi';
      buf += c + next;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      i++;
      continue;
    }

    // 命令替换 / 进程替换 / heredoc：内容在运行期才确定，静态判定不了
    if (c === '$' && next === '(') opaque ??= '命令替换 $(...)';
    if (c === '`') opaque ??= '反引号命令替换';
    if (c === '<' && next === '<') opaque ??= 'heredoc <<';
    if ((c === '<' || c === '>') && next === '(') opaque ??= '进程替换 <(...)';

    // 分隔符
    if (c === ';' || c === '\n') {
      push();
      i++;
      continue;
    }
    if (c === '&' || c === '|') {
      push();
      i += next === c || next === '&' ? 2 : 1;
      continue;
    }

    buf += c;
    i++;
  }
  push();
  return { segments, opaque };
}

/**
 * 解析一条命令。
 *
 * @returns {{
 *   ok: boolean,
 *   opaque: boolean,
 *   reason: string|null,
 *   normalized: string,
 *   commands: Array<{text:string, executable:string, args:string[], subcommands:string[]}>
 * }}
 */
export function parseCommand(raw) {
  const normalized = normalizeCommand(raw);
  if (!normalized) {
    return { ok: false, opaque: false, reason: '空命令', normalized, commands: [] };
  }
  const { segments, opaque } = splitSegments(normalized);
  const commands = [];
  for (const text of segments) {
    const flat = unescapeShellQuotes(text).replace(/\s+/g, ' ').trim();
    const words = flat.split(' ').filter(Boolean);
    if (!words.length) continue;
    const [executable, ...args] = words;
    // 子命令：非选项参数（`git reset --hard` → reset）
    const subcommands = args.filter((a) => !a.startsWith('-')).slice(0, 3);
    commands.push({ text: flat, executable, args, subcommands });
  }
  return {
    ok: commands.length > 0,
    opaque: Boolean(opaque),
    reason: opaque,
    normalized,
    commands,
  };
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

/** 规则里是不是"全是通配符"（这类规则会匹配所有命令） */
function onlyWildcards(text) {
  return text.length > 0 && [...text].every((c) => c === '*');
}

/**
 * 校验一条规则。返回 null 表示合法，否则返回原因。
 *
 * 支持两种写法：
 *   `rm -rf *`        整条命令的通配匹配
 *   `aws:*s3 rm*`     可执行体:参数模式
 */
export function validateRule(rule) {
  const text = String(rule ?? '').trim();
  if (!text) return '规则不能为空';
  if (text.length > RULE_MAX_LEN) return `规则不能超过 ${RULE_MAX_LEN} 字符`;
  if (text.startsWith(':')) return '冒号写法需要先写可执行体（例如 aws:*s3 rm*）';
  const colon = text.indexOf(':');
  if (colon > 0) {
    const exe = text.slice(0, colon).trim();
    const args = text.slice(colon + 1).trim();
    if (!exe) return '冒号写法需要先写可执行体';
    if (onlyWildcards(exe) && (args === '' || onlyWildcards(args))) {
      return '规则不能匹配所有命令，请写得更具体';
    }
    return null;
  }
  if (onlyWildcards(text)) return '规则不能匹配所有命令，请写得更具体';
  return null;
}

/** 一条命令段是否命中规则 */
export function matchRule(rule, command) {
  const text = String(rule ?? '').trim();
  if (!text || !command) return false;

  const colon = text.indexOf(':');
  if (colon > 0) {
    const exePattern = text.slice(0, colon).trim();
    const argsPattern = text.slice(colon + 1).trim();
    if (!globToRegExp(exePattern).test(command.executable)) return false;
    if (!argsPattern) return true;
    return globToRegExp(argsPattern).test(command.args.join(' '));
  }

  if (globToRegExp(text).test(command.text)) return true;
  // 不带通配符时，规则也可以只写可执行体；或作为前缀（`rm -rf` 拦 `rm -rf /`）
  if (!text.includes('*')) {
    if (text === command.executable) return true;
    if (command.text.startsWith(`${text} `)) return true;
  }
  return false;
}

/** 过滤出合法且去重的规则 */
export function normalizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  const out = [];
  for (const raw of rules.slice(0, RULE_MAX_COUNT)) {
    const text = String(raw ?? '').trim();
    if (!text || validateRule(text)) continue;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * 判定一条命令。
 *
 * 顺序：deny 命中 → 拒绝；命令无法静态判定且配置了 deny → 拒绝（fail-closed）；
 * 配置了 allow → 每一段都必须在 allow 里。
 *
 * @returns {{allowed:boolean, deniedBy:string|null, rule:string|null, reason:string|null, message:string|null}}
 */
export function decideCommand(raw, { denyCommands = [], allowCommands = [] } = {}) {
  const deny = normalizeRules(denyCommands);
  const allow = normalizeRules(allowCommands);
  const parsed = parseCommand(raw);

  const reject = (deniedBy, reason, rule = null) => ({
    allowed: false,
    deniedBy,
    rule,
    reason,
    message:
      `已被部门规矩拦下（${reason}）。这条命令不会执行，也不能在这里批准；` +
      '请改用别的做法，或让用户在终端里手动执行。你可以继续处理任务的其余部分。',
  });

  if (!parsed.ok) return reject('empty', '命令为空');

  if (deny.length) {
    for (const rule of deny) {
      const hit = parsed.commands.find((cmd) => matchRule(rule, cmd));
      if (hit) return reject('deny-rule', `命中禁用规则 ${rule}`, rule);
    }
    if (parsed.opaque) return reject('unparseable', parsed.reason);
  }

  if (allow.length) {
    const outside = parsed.commands.find(
      (cmd) => !allow.some((rule) => matchRule(rule, cmd)),
    );
    if (outside) return reject('not-allowlisted', '不在允许清单内');
  }

  return { allowed: true, deniedBy: null, rule: null, reason: null, message: null };
}
