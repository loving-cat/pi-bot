/**
 * 命令级策略：把「部门规矩」从"给不给 bash"细化到"哪些命令不许跑"。
 *
 * 纯函数，不碰进程与网络。分三步：
 *   1. 归一化：去掉不可见字符，还原 shell 的引号与转义，得到命令真正会执行的形态；
 *   2. 解析：按 `&& || ; | &` 和换行切段，剥掉赋值/重定向/分组，再拆开包装命令；
 *   3. 判定：deny 规则优先 → 无法静态判定则拒绝（判不了就拒绝）→ allow 清单。
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
      // 双引号拦不住命令替换和反引号
      if (quote === '"') {
        if (c === '`') opaque ??= '双引号内的反引号';
        if (c === '$' && next === '(') opaque ??= '双引号内的命令替换';
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

    // 反斜杠续行不是分隔符（bash 会把 \ 和换行吃掉）
    if (c === '\\' && (next === '\n' || next === '\r')) {
      i += 2;
      if (next === '\r' && raw[i] === '\n') i++;
      continue;
    }

    // 命令替换 / 进程替换 / heredoc：内容在运行期才确定，静态判定不了
    if (c === '$' && next === '(') opaque ??= '命令替换 $(...)';
    if (c === '`') opaque ??= '反引号命令替换';
    if (c === '<' && next === '<') opaque ??= 'heredoc <<';
    if ((c === '<' || c === '>') && next === '(') opaque ??= '进程替换 <(...)';

    // 分隔符。换行 / CR 不能先被压成空格，否则 `echo ok\\nrm` 会被看成一条 echo。
    if (c === ';' || c === '\n' || c === '\r') {
      push();
      i++;
      if (c === '\r' && raw[i] === '\n') i++;
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

const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'rbash']);
const INTERPRETER = /^(?:python\d*(?:\.\d+)?|node|nodejs|perl\d*|ruby\d*|php\d*|lua\d*)$/;

/** 尚未换行的半截 stdin。write_stdin 分多次写入时要拼起来再检查。 */
const stdinTail = new Map();

function stdinKey(shellId) {
  return String(shellId ?? '');
}

/** 已写入但还没换行的内容和这次写入拼在一起。不修改记录。 */
export function previewStdin(shellId, chars) {
  return (stdinTail.get(stdinKey(shellId)) ?? '') + String(chars ?? '');
}

/** 写入成功后只保留最后一行没写完的部分。 */
export function commitStdin(shellId, chars) {
  const lines = previewStdin(shellId, chars).split(/\r?\n/);
  const rest = (lines.pop() ?? '').slice(-8192);
  const key = stdinKey(shellId);
  if (!rest) stdinTail.delete(key);
  else stdinTail.set(key, rest);
  while (stdinTail.size > 200) stdinTail.delete(stdinTail.keys().next().value);
}

/** 进程结束或测试隔离时丢掉半截输入。shellId 省略则全清。 */
export function resetStdin(shellId) {
  if (shellId == null) stdinTail.clear();
  else stdinTail.delete(stdinKey(shellId));
}

function wordsOf(segment) {
  const saved = [];
  // Windows 路径里的反斜杠是分隔符，不能按 bash 转义吃掉
  const protectedSeg = segment.replace(/[A-Za-z]:\\[^\s'"]+|\\\\[^\s'"]+/g, (m) => {
    saved.push(m);
    return `\uE000${saved.length - 1}\uE000`;
  });
  const flat = unescapeShellQuotes(protectedSeg).replace(/[ \t\f\v]+/g, ' ').trim();
  if (!flat) return [];
  return flat.split(' ').filter(Boolean).map((word) =>
    word.replace(/\uE000(\d+)\uE000/g, (_, n) => saved[Number(n)] ?? ''),
  );
}

function flattenGrouping(words) {
  const out = [];
  for (const word of words) {
    if (/\$[{('`]/.test(word) || word.includes('`')) {
      out.push(word);
      continue;
    }
    const parts = word.split(/(\(\)|[{}()!;])/).filter((part) => part !== '');
    out.push(...(parts.length ? parts : [word]));
  }
  return out;
}

function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isRedirect(word) {
  return /^(?:[0-9]*|&)?[<>]{1,2}/.test(word) || /^&>/.test(word) || /^<&/.test(word);
}

function redirectTakesNext(word) {
  return /^(?:[0-9]*|&)?[<>]{1,2}$/.test(word)
    || /^[<>]&$/.test(word)
    || /^[0-9]+[<>]&$/.test(word)
    || /^&>$/.test(word)
    || /^<&$/.test(word);
}

/** 跳过赋值、重定向、子 shell / 函数分组，留下真正的命令词。 */
function peelPrefixes(words) {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (word === '(' || word === ')' || word === '{' || word === '}' || word === '()' || word === '!' || word === ';' || word === '') {
      i++;
      continue;
    }
    if (word === 'function') {
      i++;
      if (words[i] && /^[A-Za-z_][A-Za-z0-9_]*$/.test(words[i])) i++;
      if (words[i] === '()') i++;
      if (words[i] === '{') i++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word) && words[i + 1] === '()') {
      i += 2;
      if (words[i] === '{') i++;
      continue;
    }
    if (isAssignment(word)) {
      i++;
      continue;
    }
    if (isRedirect(word)) {
      const takes = redirectTakesNext(word);
      i++;
      if (takes && i < words.length) i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

function makeCommand(exe, args) {
  return {
    text: [exe, ...args].join(' '),
    executable: exe,
    args,
    // 子命令：非选项参数（`git reset --hard` → reset）
    subcommands: args.filter((arg) => !arg.startsWith('-')).slice(0, 3),
  };
}

function skipFlags(args, withArg) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    if (arg.includes('=')) {
      i++;
      continue;
    }
    if (withArg.has(arg)) {
      i += 2;
      continue;
    }
    if (withArg.has(arg.slice(0, 2))) {
      i++;
      continue;
    }
    i++;
  }
  return args.slice(i);
}

function wordsOrNull(words) {
  return words?.length ? { words } : null;
}

function unwrapEnv(args) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (arg === '-i' || arg === '-0' || arg === '-v' || arg === '--ignore-environment') {
      i++;
      continue;
    }
    if (arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir') {
      i += 2;
      continue;
    }
    if (arg === '-S' || arg === '--split-string') return { script: args.slice(i + 1).join(' ') };
    if (arg.startsWith('-')) return { opaque: true, reason: 'env 参数无法静态判定' };
    if (isAssignment(arg)) {
      i++;
      continue;
    }
    break;
  }
  return wordsOrNull(args.slice(i));
}

function unwrapXargs(args) {
  const withArg = new Set([
    '-a', '-d', '-E', '-e', '-I', '-i', '-L', '-l', '-n', '-P', '-s', '-J',
    '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args',
    '--max-procs', '--max-chars', '--process-slot-var',
  ]);
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (!arg.startsWith('-') || arg === '-') break;
    if (/^-I./.test(arg) || /^-i./.test(arg)) {
      i++;
      continue;
    }
    if (arg.includes('=')) {
      i++;
      continue;
    }
    if (withArg.has(arg)) {
      i += 2;
      continue;
    }
    if (withArg.has(arg.slice(0, 2))) {
      i++;
      continue;
    }
    if (arg.startsWith('--') || !/^-[0ptrx]+$/.test(arg)) {
      return { opaque: true, reason: 'xargs 参数无法静态判定' };
    }
    i++;
  }
  const rest = args.slice(i);
  if (!rest.length) return null;
  if (rest.some((arg) => arg.includes('{}'))) {
    return { opaque: true, reason: 'xargs 替换符命令无法静态判定' };
  }
  // xargs 还会把标准输入接到参数后面：`echo / | xargs rm -rf` 实际是 `rm -rf /`
  return { words: rest, alsoOpaque: 'xargs 会把标准输入拼进参数，整行参数无法静态判定' };
}

function unwrapShell(args) {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      i++;
      break;
    }
    if (arg === '-c') return { script: args.slice(i + 1).join(' ') };
    // bash -lc 'script'：c 在选项簇末尾，后面整段都是脚本
    if (/^-[^-]*c$/.test(arg)) return { script: args.slice(i + 1).join(' ') };
    if (arg.startsWith('-')) {
      i++;
      continue;
    }
    return { opaque: true, reason: 'shell 脚本文件无法静态检查' };
  }
  return { opaque: true, reason: 'shell 从标准输入读命令，无法静态检查' };
}

function unwrapCmd(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^[/\\][cCkK]$/.test(arg) || /^-[cCkK]$/.test(arg)) {
      return { script: args.slice(i + 1).join(' ') };
    }
    const glued = arg.match(/^[/\\][cCkK]:(.*)$/);
    if (glued) {
      const tail = args.slice(i + 1);
      return { script: glued[1] + (tail.length ? ` ${tail.join(' ')}` : '') };
    }
  }
  return { opaque: true, reason: 'cmd 没有可检查的 /c 脚本' };
}

function decodePowerShell(b64) {
  try {
    const buf = Buffer.from(String(b64 ?? ''), 'base64');
    if (!buf.length || buf.length % 2) return null;
    const text = buf.toString('utf16le').replace(/\u0000/g, '').trim();
    return text || null;
  } catch {
    return null;
  }
}

function unwrapPowershell(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].toLowerCase();
    const next = args[i + 1];
    if (arg === '-command' || arg === '-c' || arg === '/command' || arg === '/c') {
      return { script: args.slice(i + 1).join(' ') };
    }
    if (['-encodedcommand', '-enc', '-ec', '/encodedcommand', '/enc', '/ec'].includes(arg)) {
      if (!next || next.startsWith('-')) return { opaque: true, reason: 'powershell 编码命令解不出来' };
      const script = decodePowerShell(next);
      if (!script) return { opaque: true, reason: 'powershell 编码命令解不出来' };
      return { script };
    }
  }
  return { opaque: true, reason: 'powershell 命令无法静态检查' };
}

function unwrapFind(args) {
  const flags = new Set(['-exec', '-execdir', '-ok', '-okdir']);
  const commands = [];
  for (let i = 0; i < args.length; i++) {
    if (!flags.has(args[i].toLowerCase())) continue;
    const cmd = [];
    for (let j = i + 1; j < args.length; j++) {
      if (args[j] === ';' || args[j] === '+' || args[j] === '\\;') break;
      cmd.push(args[j]);
    }
    if (!cmd.length) return { opaque: true, reason: 'find -exec 没有命令' };
    commands.push(cmd);
  }
  return commands.length ? { many: commands } : null;
}

function unwrapDashC(args, emptyReason) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c' || arg === '--command') return { script: args.slice(i + 1).join(' ') };
    if (/^-[^-]*c$/.test(arg)) return { script: args.slice(i + 1).join(' ') };
    if (arg.startsWith('--command=')) {
      const glued = arg.slice('--command='.length);
      const tail = args.slice(i + 1);
      return { script: glued + (tail.length ? ` ${tail.join(' ')}` : '') };
    }
  }
  return { opaque: true, reason: emptyReason };
}

function unwrapFlock(args) {
  const withArg = new Set(['-w', '--timeout', '-E', '--conflict-exit-code']);
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c' || arg === '--command' || /^-[^-]*c$/.test(arg)) {
      if (i + 1 >= args.length) return { opaque: true, reason: 'flock 没有可检查的命令' };
      return { script: args.slice(i + 1).join(' ') };
    }
    if (arg === '--') {
      words.push(...args.slice(i + 1));
      break;
    }
    if (!words.length && arg.startsWith('-') && arg !== '-') {
      if (!arg.includes('=') && withArg.has(arg)) i++;
      continue;
    }
    words.push(arg);
  }
  if (words.length >= 2 && (words[1] === '-c' || words[1] === '--command')) {
    if (words.length < 3) return { opaque: true, reason: 'flock 没有可检查的命令' };
    return { script: words.slice(2).join(' ') };
  }
  if (words.length < 2) return { opaque: true, reason: 'flock 没有可检查的命令' };
  return { words: words.slice(1) };
}

function unwrapChroot(args) {
  const rest = skipFlags(args, new Set(['--userspec', '--groups']));
  if (rest.length < 2) return { opaque: true, reason: 'chroot 没有可检查的命令' };
  return { words: rest.slice(1) };
}

function unwrapUnshare(args) {
  const rest = skipFlags(args, new Set([
    '--propagation', '--setgroups',
    '--map-user', '--map-group', '--map-users', '--map-groups',
    '--root', '--wd', '-R', '-w', '-S', '-G', '--setuid', '--setgid',
    '--monotonic', '--boottime',
  ]));
  if (!rest.length) return { opaque: true, reason: 'unshare 没有可检查的命令' };
  return { words: rest };
}

function unwrapNsenter(args) {
  const rest = skipFlags(args, new Set(['-t', '--target', '-S', '--setuid', '-G', '--setgid']));
  if (!rest.length) return { opaque: true, reason: 'nsenter 没有可检查的命令' };
  return { words: rest };
}

/** 配了规则时，解释器只有版本/帮助能放行；`-i`、`--interactive` 都会进交互执行。`-v` 不算，python 的 `-v` 不是版本。 */
function unwrapInterpreter(args) {
  const safe = (arg) => arg === '-V' || arg === '-h' || fold(arg) === '--version' || fold(arg) === '--help';
  if (args.length > 0 && args.every(safe)) return null;
  return { opaque: true, reason: '解释器执行的代码无法按命令规则静态检查' };
}

function unwrap(base, exe, args) {
  if (base === 'env') return unwrapEnv(args);
  if (base === 'xargs') return unwrapXargs(args);
  if (base === 'command' || base === 'builtin') return wordsOrNull(skipFlags(args, new Set()));
  if (base === 'exec') return wordsOrNull(skipFlags(args, new Set(['-a'])));
  if (base === 'eval') return { script: args.join(' ') };
  if (base === 'timeout') {
    const rest = skipFlags(args, new Set(['-k', '--kill-after', '-s', '--signal']));
    if (rest.length < 2) return { opaque: true, reason: 'timeout 没有可检查的命令' };
    return { words: rest.slice(1) };
  }
  if (base === 'nice') return wordsOrNull(skipFlags(args, new Set(['-n', '--adjustment'])));
  if (base === 'nohup' || base === 'setsid') return wordsOrNull(skipFlags(args, new Set()));
  if (base === 'time') return wordsOrNull(skipFlags(args, new Set(['-f', '-o', '--format', '--output'])));
  if (base === 'stdbuf') {
    return wordsOrNull(skipFlags(args, new Set(['-i', '-o', '-e', '--input', '--output', '--error'])));
  }
  if (base === 'ionice') {
    return wordsOrNull(skipFlags(args, new Set(['-c', '-n', '-p', '-t', '--class', '--classdata', '--pid'])));
  }
  if (base === 'sudo' || base === 'doas') {
    return wordsOrNull(skipFlags(args, new Set([
      '-u', '-g', '-h', '-p', '-U', '-C', '-D', '-R', '-T',
      '--user', '--group', '--host', '--prompt', '--other-user', '--close-from', '--chdir', '--role',
    ])));
  }
  if (base === 'watch') {
    return wordsOrNull(skipFlags(args, new Set(['-n', '--interval', '-d', '--differences'])));
  }
  if (base === 'find') return unwrapFind(args);
  if (base === 'su') return unwrapDashC(args, 'su 会进入 shell，无法静态检查');
  if (base === 'script') return unwrapDashC(args, 'script 会进入 shell，无法静态检查');
  if (base === 'flock') return unwrapFlock(args);
  if (base === 'chroot') return unwrapChroot(args);
  if (base === 'unshare') return unwrapUnshare(args);
  if (base === 'nsenter') return unwrapNsenter(args);
  if (base === 'ssh') return { opaque: true, reason: 'ssh 远端命令无法静态检查' };
  if (base === 'busybox' || base === 'toybox') return wordsOrNull(skipFlags(args, new Set()));
  if (base === 'cmd') return unwrapCmd(args);
  if (base === 'powershell' || base === 'pwsh') return unwrapPowershell(args);
  if (SHELLS.has(base)) return unwrapShell(args);
  if (INTERPRETER.test(base)) return unwrapInterpreter(args);
  if (base === 'source' || exe === '.') return { opaque: true, reason: 'source 读入的脚本无法静态检查' };
  return null;
}

function absorb(words, acc, box, depth) {
  if (depth > 6) {
    box.reason ??= '命令嵌套过深';
    return;
  }
  const peeled = peelPrefixes(flattenGrouping(words));
  if (!peeled.length) return;
  const [exe, ...args] = peeled;
  if (/[\$`]/.test(exe)) {
    box.reason ??= '命令名由变量展开，无法静态判定';
    return;
  }
  acc.push(makeCommand(exe, args));
  const base = canonicalBase(exe);
  const inner = unwrap(base, exe, args);
  if (!inner) return;
  if (inner.opaque) {
    box.reason ??= inner.reason || '无法静态判定';
    return;
  }
  if (inner.script != null) {
    const nested = parseCommand(inner.script, depth + 1);
    if (nested.opaque) box.reason ??= nested.reason || '无法静态判定';
    acc.push(...nested.commands);
    return;
  }
  if (inner.many) {
    for (const cmd of inner.many) absorb(cmd, acc, box, depth + 1);
    return;
  }
  if (inner.words) {
    absorb(inner.words, acc, box, depth + 1);
    if (inner.alsoOpaque) box.reason ??= inner.alsoOpaque;
  }
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
export function parseCommand(raw, depth = 0) {
  const stripped = String(raw ?? '').replace(INVISIBLE, '');
  const normalized = stripped.replace(/[ \t\f\v]+/g, ' ').trim();
  if (depth > 6) {
    return { ok: false, opaque: true, reason: '命令嵌套过深', normalized, commands: [] };
  }
  if (!stripped.trim()) {
    return { ok: false, opaque: false, reason: '空命令', normalized, commands: [] };
  }
  const { segments, opaque } = splitSegments(stripped);
  const commands = [];
  const box = { reason: opaque };
  for (const text of segments) absorb(wordsOf(text), commands, box, depth);
  // 只有赋值/重定向、没有可执行体时也算一条命令，避免被当成空命令拒绝
  const ok = commands.length > 0 || (!box.reason && Boolean(stripped.trim()));
  return {
    ok,
    opaque: Boolean(box.reason),
    reason: box.reason,
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

function fold(text) {
  return String(text ?? '').toLowerCase();
}

/** 路径只看最后一段，并去掉 Windows 自动补上的 .exe。大小写不敏感。 */
function canonicalBase(executable) {
  return fold(String(executable ?? '').split(/[/\\]/).pop()).replace(/\.exe$/i, '');
}

function exeKeys(executable) {
  const base = fold(String(executable ?? '').split(/[/\\]/).pop());
  const stripped = base.replace(/\.exe$/i, '');
  return stripped === base ? [base] : [base, stripped];
}

function commandTexts(command) {
  const args = fold((command?.args ?? []).join(' '));
  return exeKeys(command?.executable).map((exe) => (args ? `${exe} ${args}` : exe));
}

/** rm 的常见长选项折成短选项，好和 `-rf` 对齐。 */
const RM_LONG = {
  recursive: 'r',
  force: 'f',
  dir: 'd',
  directory: 'd',
  verbose: 'v',
  interactive: 'i',
};

function classifyArgs(executable, args) {
  const longMap = canonicalBase(executable) === 'rm' ? RM_LONG : null;
  const flags = new Set();
  const positionals = [];
  let optionsDone = false;
  for (const raw of args ?? []) {
    const arg = fold(raw);
    if (optionsDone || arg === '-' || /^-\d+$/.test(arg)) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      optionsDone = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      flags.add(longMap?.[name] || name);
      continue;
    }
    if (arg.startsWith('-')) {
      for (const ch of arg.slice(1)) flags.add(ch);
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

/** 规则里的选项是命令选项的子集，位置参数按词前缀（不是字符前缀）。 */
function ruleArgsCovered(ruleExe, ruleArgs, command) {
  const want = classifyArgs(ruleExe, ruleArgs);
  const got = classifyArgs(command?.executable, command?.args);
  for (const flag of want.flags) {
    if (!got.flags.has(flag)) return false;
  }
  if (want.positionals.length > got.positionals.length) return false;
  for (let i = 0; i < want.positionals.length; i++) {
    if (want.positionals[i] !== got.positionals[i]) return false;
  }
  return true;
}

/** 一条命令段是否命中规则 */
export function matchRule(rule, command) {
  const text = fold(String(rule ?? '').trim());
  if (!text || !command) return false;
  const exes = exeKeys(command.executable);
  const texts = commandTexts(command);

  const colon = text.indexOf(':');
  if (colon > 0) {
    const exePattern = text.slice(0, colon).trim();
    const argsPattern = text.slice(colon + 1).trim();
    if (!exes.some((exe) => globToRegExp(exePattern).test(exe))) return false;
    if (!argsPattern) return true;
    return globToRegExp(argsPattern).test(fold((command.args ?? []).join(' ')));
  }

  if (texts.some((body) => globToRegExp(text).test(body))) return true;
  // 不带通配符：短选项拆开，rm 的长选项折成短选项，规则选项 ⊆ 命令选项；位置参数仍按词前缀
  if (!text.includes('*')) {
    const parts = text.split(/\s+/).filter(Boolean);
    const ruleExe = canonicalBase(parts[0]);
    if (exes.includes(ruleExe) && ruleArgsCovered(ruleExe, parts.slice(1), command)) return true;
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

const ALLOW = { allowed: true, deniedBy: null, rule: null, reason: null, message: null };

/**
 * 判定一条命令。
 *
 * 顺序：deny 命中 → 拒绝；命令无法静态判定且配置了 deny 或 allow → 拒绝（判不了就拒绝）；
 * 配置了 allow → 每一段都必须在 allow 里。没配规则时不拦。
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

  if (!deny.length && !allow.length) {
    if (!parsed.ok && !parsed.opaque) return reject('empty', '命令为空');
    return ALLOW;
  }

  if (!parsed.ok && !parsed.opaque) return reject('empty', '命令为空');

  if (deny.length) {
    for (const rule of deny) {
      const hit = parsed.commands.find((cmd) => matchRule(rule, cmd));
      if (hit) return reject('deny-rule', `命中禁用规则 ${rule}`, rule);
    }
  }

  if (parsed.opaque) return reject('unparseable', parsed.reason);

  if (!parsed.ok) return reject('empty', '命令为空');

  if (allow.length) {
    const outside = parsed.commands.find(
      (cmd) => !allow.some((rule) => matchRule(rule, cmd)),
    );
    if (outside) return reject('not-allowlisted', '不在允许清单内');
  }

  return ALLOW;
}

const COMMAND_TOOLS = new Set(['bash', 'powershell', 'run_background', 'write_stdin']);

/**
 * bash / powershell / run_background / write_stdin 共用这一处。
 * 不是这四类工具时返回 null。write_stdin 会带上该 shell 还没换行的半截输入。
 */
export function verdictForTool(tool, input, policy = {}) {
  if (!COMMAND_TOOLS.has(tool)) return null;
  const denyCommands = policy.denyCommands ?? [];
  const allowCommands = policy.allowCommands ?? [];
  if (tool === 'write_stdin') {
    const text = previewStdin(input?.shell_id, input?.chars ?? '');
    if (!String(text).trim()) return ALLOW;
    if (!denyCommands.length && !allowCommands.length) return ALLOW;
    return decideCommand(text, { denyCommands, allowCommands });
  }
  const text = input?.command ?? input?.cmd ?? '';
  // 后台命令即使没配规则，空字符串也要拒绝；bash 没配规则时保持原样放行
  if (tool !== 'run_background' && !denyCommands.length && !allowCommands.length) return ALLOW;
  return decideCommand(text, { denyCommands, allowCommands });
}
