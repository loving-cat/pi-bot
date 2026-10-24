/**
 * 数据目录迁移与会话路径修复（纯文件操作，不依赖 config / store，可单测）。
 *
 * 旧数据目录是 `<安装目录>/server/data`，现在是用户数据目录
 * （Windows 的 %LOCALAPPDATA%\pi-bot\data 等）。
 *
 * 两件事：
 *   · migrateLegacyData：新目录还没有数据时，从旧目录复制服务端自己的数据（ENTRIES）。
 *     不复制 `_` 开头的测试产物和其它文件；workspace 不复制，在标记文件里记下旧工作目录，
 *     启动时继续用它；复制完把 state.sessions 里指向旧目录的路径改写到新目录。
 *   · repairSessionRefs：每次启动把 state.sessions 里指向数据目录之外的会话文件改回
 *     `<数据目录>/sessions`。state.json 存的是绝对路径，只复制文件不改路径的话，
 *     服务端会继续写旧目录，删掉旧目录就丢了这些会话。两边都有同名文件时取更新的那份。
 *
 * 旧目录只读，不删任何东西。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 迁移时复制的顶层条目（服务端自己读写的全部数据）。其余一律不动。 */
export const ENTRIES = Object.freeze([
  'state.json',
  'rooms',
  'sessions',
  'uploads',
  'uploads.json',
  'model-groups.json',
  'model-health.json',
  'hooks.json',
  'secret.key',
]);

/** 迁移完成后写在新目录里的标记：来源目录、复制了哪些条目、沿用的工作目录 */
export const MIGRATION_MARKER = '.migrated-from.json';

/**
 * 进程内标记：这次是不是真的在起服务端。
 * config.js 只有看到它才会迁移 / 修复数据目录。放在 globalThis 上、不用环境变量：
 * 环境变量会被子进程继承，这个不会。
 */
export const SERVER_BOOT = Symbol.for('pi-bot.server-boot');

/** 入口在导入 server-main（也就是 config / store）之前调用 */
export function markServerBoot() {
  globalThis[SERVER_BOOT] = true;
}

/**
 * 上次迁移记下的「继续用旧工作目录」。
 *
 * workspace 里是 bot 做出来的东西，往往还带着几百 MB 的 .venv / node_modules。
 * 复制一份既慢又占双倍空间，而且虚拟环境里的绝对路径复制过去就坏了。
 * 所以不复制，只记一条指针，新目录继续用旧工作目录。
 *
 * @param {string} dataDir
 * @returns {string|null} 旧工作目录（仍然存在时），否则 null
 */
export function migratedWorkspace(dataDir) {
  const marker = readJson(path.join(dataDir, MIGRATION_MARKER));
  const ws = typeof marker?.workspace === 'string' ? marker.workspace : null;
  if (!ws) return null;
  try {
    return fs.statSync(ws).isDirectory() ? ws : null;
  } catch {
    return null;
  }
}

const lower = (p) => path.resolve(p).toLowerCase();

/** `child` 是否在 `parent` 目录之内（Windows 不区分大小写） */
export function isInside(child, parent) {
  const c = process.platform === 'win32' ? lower(child) : path.resolve(child);
  const p = process.platform === 'win32' ? lower(parent) : path.resolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 原子写：先写临时文件再改名，写一半崩了也不会留下半个 state.json */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * 把会话引用指向的文件放到新目录里（只在需要时复制）。
 * @returns {'copied'|'kept-target'|'missing'}
 */
function adoptSessionFile(from, to) {
  if (!fs.existsSync(from)) return fs.existsSync(to) ? 'kept-target' : 'missing';
  if (fs.existsSync(to)) {
    const a = fs.statSync(from);
    const b = fs.statSync(to);
    // 旧目录那份更新或更大 → 用它覆盖；否则保留新目录的
    if (a.mtimeMs <= b.mtimeMs && a.size <= b.size) return 'kept-target';
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  // 保留修改时间：之后再比较新旧时才有意义
  const st = fs.statSync(from);
  fs.utimesSync(to, st.atime, st.mtime);
  return 'copied';
}

/**
 * 把 state.sessions 里不在 `<dataDir>/sessions` 下的引用改到那里。
 *
 * 只处理文件名能在旧位置或新位置找到的引用；两边都找不到的保持原样
 * （下次开会话时 session-factory 发现文件不存在会新建）。
 *
 * @param {object} p
 * @param {string} p.dataDir 当前数据目录
 * @param {(msg:string)=>void} [p.log]
 * @returns {{scanned:number, rewritten:number, copied:number, missing:number}}
 */
export function repairSessionRefs({ dataDir, log = () => {} }) {
  const stateFile = path.join(dataDir, 'state.json');
  const result = { scanned: 0, rewritten: 0, copied: 0, missing: 0 };
  const state = readJson(stateFile);
  if (!state?.sessions || typeof state.sessions !== 'object') return result;

  const sessionsDir = path.join(dataDir, 'sessions');
  let changed = false;
  for (const [key, ref] of Object.entries(state.sessions)) {
    if (typeof ref !== 'string' || !ref) continue;
    result.scanned++;
    if (isInside(ref, sessionsDir)) continue;
    const target = path.join(sessionsDir, path.basename(ref));
    const outcome = adoptSessionFile(ref, target);
    if (outcome === 'missing') {
      result.missing++;
      continue;
    }
    if (outcome === 'copied') result.copied++;
    state.sessions[key] = target;
    result.rewritten++;
    changed = true;
  }
  if (changed) {
    writeJsonAtomic(stateFile, state);
    log(
      `[config] 修正了 ${result.rewritten} 个指向数据目录之外的会话文件引用` +
        `（其中 ${result.copied} 个用更新的那份覆盖了）`,
    );
  }
  return result;
}

/**
 * 一次性迁移：只在新目录还没有 state.json、而旧目录有时执行。
 *
 * @param {object} p
 * @param {string} p.legacy 旧数据目录
 * @param {string} p.target 新数据目录
 * @param {(msg:string)=>void} [p.log]
 * @returns {{migrated:boolean, entries:string[], skipped:string[]}}
 */
export function migrateLegacyData({ legacy, target, log = () => {} }) {
  const none = { migrated: false, entries: [], skipped: [] };
  if (fs.existsSync(path.join(target, 'state.json'))) return none;
  if (!fs.existsSync(path.join(legacy, 'state.json'))) return none;
  if (isInside(target, legacy) || isInside(legacy, target)) return none;

  fs.mkdirSync(target, { recursive: true });
  const entries = [];
  for (const name of ENTRIES) {
    const from = path.join(legacy, name);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(target, name), {
      recursive: true,
      // 上传分片的半成品不复制：它们只对当时那个进程有意义
      filter: (src) => !path.basename(src).startsWith('_'),
      preserveTimestamps: true,
    });
    entries.push(name);
  }
  // state.json 最后再写一遍会话路径：前面复制的是原样
  const repaired = repairSessionRefs({ dataDir: target, log });
  const skipped = fs
    .readdirSync(legacy)
    .filter((name) => !ENTRIES.includes(name))
    .map((name) => (name.startsWith('_') ? '_<测试残留>' : name));
  const legacyWorkspace = path.join(legacy, 'workspace');
  const keepWorkspace = fs.existsSync(legacyWorkspace) && fs.statSync(legacyWorkspace).isDirectory();
  writeJsonAtomic(path.join(target, MIGRATION_MARKER), {
    from: legacy,
    at: new Date().toISOString(),
    entries,
    sessionsRewritten: repaired.rewritten,
    // 工作目录不复制：新目录继续用它（见 migratedWorkspace）
    ...(keepWorkspace ? { workspace: legacyWorkspace } : {}),
  });
  log(
    `[config] 已把旧数据搬过来：${legacy} → ${target}\n` +
      `         搬了：${entries.join('、') || '（无）'}\n` +
      (keepWorkspace ? `         工作目录没搬，继续用：${legacyWorkspace}\n` : '') +
      `         没动：${[...new Set(skipped)].join('、') || '（无）'}（旧目录原样保留，没有删除任何东西）`,
  );
  return { migrated: true, entries, skipped, workspace: keepWorkspace ? legacyWorkspace : null };
}
