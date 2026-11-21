/**
 * 打 Android 安装包（apk）。
 *
 *   node scripts/pack-android.mjs                # dist/orbis-android-v<版本>.apk
 *   node scripts/pack-android.mjs --no-build     # 复用已有构建，只重新打包
 *   node scripts/pack-android.mjs --abi arm64    # 只打 arm64（体积约减半）
 *   node scripts/pack-android.mjs --out <文件>   # 指定输出
 *   node scripts/pack-android.mjs --help
 *
 * 为什么要一个脚本，而不是一句 `flutter build apk`：
 *
 * 1. **版本号只有一处真源**（`server/package.json`），`app/pubspec.yaml` 必须跟它一致。
 *    这里构建**前后各查一次**：前后不一致说明构建过程中有人 bump 了版本，
 *    打出来的包和名字对不上 —— 宁可失败，也不要发出一个版本号撒谎的 apk。
 * 2. **JDK 版本**：`JAVA_HOME` 停在 1.8 时 Gradle 只丢一句
 *    "JAVA_HOME is set to an invalid directory"（见 docs/PITFALLS.md），
 *    看不出是版本问题。这里先自己判，直接说清楚要 JDK 17+ 和怎么改。
 * 3. **锁文件不许带镜像地址**：本机 `PUB_HOSTED_URL` 经常指向 pub 镜像，
 *    一次 `flutter pub get` 就把 `pubspec.lock` 里 200 行 URL 改成镜像地址，
 *    CI 用官方源 `--enforce-lockfile` 直接红（踩过两次）。这里强制官方源。
 * 4. **产物先落盘再替换**：构建/校验任何一步失败，`dist/` 里上一版的包必须原样还在。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** pub 镜像 host：进了锁文件 CI 就红。 */
const MIRROR_HOSTS = ['pub.flutter-io.cn', 'pub.dartlang.org', 'pub-dev.flutter-io.cn'];

/** 官方源。构建期间强制用它，避免本机镜像环境变量污染锁文件。 */
const OFFICIAL_PUB = 'https://pub.dev';

/** Flutter 产出的 apk 固定落在这里（`flutter build apk` 的约定路径）。 */
const APK_RELATIVE = path.join('build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');

/** Gradle 顺手写的元数据：能读到 versionName / versionCode，用来校验包名副其实。 */
const METADATA_RELATIVE = path.join('build', 'app', 'outputs', 'apk', 'release', 'output-metadata.json');

/** Android 侧的应用 ID（applicationId），换它等于换一个应用，老用户升不上来。 */
export const APP_ID = 'com.pibot.pi_bot';

/**
 * 已发布的 apk 都是这个证书签的（`~/.android/debug.keystore`，CN=Android Debug）。
 *
 * v1.0.3 / v1.0.5 / v1.0.6 三版实测同一个 SHA-256，所以老用户能原地升级。
 * **换机器构建、或换 keystore，指纹就会变** —— 已装用户的 android 包只会报
 * INSTALL_FAILED_UPDATE_INCOMPATIBLE，装在手机上的 pi-bot 永远升不上来。
 * 真要换签名（正式分发到应用市场那种），改这里，并在 docs/ANDROID.md 写清楚"
 * 老用户要先卸载"。
 */
export const EXPECTED_SIGNER_SHA256 = '03cddcf5c4deea5f1abfe9327b6f552452d707532a66a8e77153af5f031445d6';

/** Gradle / AGP 要求的最低 JDK 大版本。 */
export const MIN_JDK = 17;

/**
 * 从 pubspec 的 `version: 1.4.1+19` 里取出应用版本与构建号。
 *
 * 允许 semver 预发布（`2.0.0-alpha.1+24`）：Android 的 `versionName` 是自由字符串，
 * 预发布段会原样进 APK 元数据，`verifyMetadata()` 也是逐字比对的，不能在这里截掉。
 */
export function parsePubspecVersion(text) {
  const match = /^version:\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+(\d+))?\s*$/m.exec(
    String(text ?? ''),
  );
  if (!match) throw new Error('pubspec.yaml 里没有 `version: x.y.z[-pre]+N` 这一行');
  return { version: match[1], build: match[2] ? Number(match[2]) : 0 };
}

/** 版本号唯一真源是 server/package.json，pubspec 必须与它一致。 */
export function assertVersionsAgree({ serverVersion, pubspec }) {
  if (!serverVersion) throw new Error('server/package.json 里没有 version');
  if (serverVersion !== pubspec.version) {
    throw new Error(
      `版本号不一致：server/package.json 是 ${serverVersion}，app/pubspec.yaml 是 ${pubspec.version}（应改成 version: ${serverVersion}+${pubspec.build}）`,
    );
  }
  return serverVersion;
}

/** 锁文件里出现镜像 host 就返回它，否则返回 null。 */
export function findMirrorHost(text) {
  const body = String(text ?? '');
  for (const host of MIRROR_HOSTS) {
    if (body.includes(host)) return host;
  }
  return null;
}

/** 从 `java -version` 的输出里读大版本号（1.8.0_401 → 8，21.0.12 → 21）。 */
export function parseJavaMajor(output) {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(String(output ?? ''));
  if (!match) return null;
  const first = Number(match[1]);
  if (first === 1 && match[2]) return Number(match[2]);
  return first;
}

/** 产物名：带平台词、纯 semver。CI 的更新检查靠 `.apk` 和 `-android-` 认它。 */
export function apkFileName(version) {
  return `orbis-android-v${version}.apk`;
}

/** 校验 Gradle 的元数据：包名、版本名、构建号三样都要对得上。 */export function verifyMetadata(metadata, { version, build }) {
  const element = metadata?.elements?.[0];
  if (!element) throw new Error('构建元数据里没有产物记录');
  if (metadata.applicationId !== APP_ID) {
    throw new Error(`applicationId 是 ${metadata.applicationId}，应为 ${APP_ID}`);
  }
  if (String(element.versionName) !== version) {
    throw new Error(`打出来的是 ${element.versionName}，期望 ${version}（构建没跑或版本号改了没重编）`);
  }
  if (Number(element.versionCode) !== build) {
    throw new Error(`构建号是 ${element.versionCode}，期望 ${build}（pubspec 的 +N 与产物不一致）`);
  }
  return true;
}

function capture(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

/** 带空格的参数自己加引号，整条命令交给 shell（Windows 上 flutter 是 flutter.bat）。 */
export function commandLine(command, args) {
  return [command, ...args].map((part) => (/[\s"]/.test(part) ? `"${part}"` : part)).join(' ');
}

function runShell(line, options = {}) {
  const result = spawnSync(line, { stdio: 'inherit', shell: true, ...options });
  if (result.error) throw new Error(`执行 ${line} 失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${line} 退出码 ${result.status}`);
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 找 flutter：PATH 里没有就报明确错误，不去猜用户机器上的路径。
 *  Windows 上是 `flutter.bat`，直接 spawn 会 ENOENT，所以取真实路径后走 shell。 */
function requireFlutter() {
  const probe = capture(process.platform === 'win32' ? 'where' : 'which', ['flutter']);
  const first = String(probe.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0];
  if (probe.status !== 0 || !first) {
    throw new Error('PATH 里找不到 flutter，先装 Flutter SDK 或把它的 bin 加进 PATH');
  }
  return first;
}

/** JDK 必须 17+。先看 JAVA_HOME，没设就看 PATH 上的 java。 */
export function checkJdk({ javaHome, runJavaVersion }) {
  const target = javaHome ? 'java -version（JAVA_HOME）' : 'java -version（PATH）';
  const output = runJavaVersion();
  const major = parseJavaMajor(output);
  if (major === null) {
    throw new Error(`读不到 Java 版本（${target}）：${String(output).trim().split('\n')[0] || '无输出'}`);
  }
  if (major < MIN_JDK) {
    throw new Error(
      `JDK ${major} 太老，Gradle 需要 ${MIN_JDK}+（常见症状：JAVA_HOME is set to an invalid directory）。把 JAVA_HOME 指向 JDK ${MIN_JDK}+ 再跑`,
    );
  }
  return major;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 从 `apksigner verify --print-certs` 的输出里取签名证书指纹。 */
export function parseSignerDigest(output) {
  const match = /certificate SHA-256 digest:\s*([0-9a-f]{64})/i.exec(String(output ?? ''));
  return match ? match[1].toLowerCase() : null;
}

/** 找 apksigner：优先 ANDROID_HOME，其次 app/android/local.properties 里的 sdk.dir。 */
function findApksigner(appDir) {
  const roots = [];
  if (process.env.ANDROID_HOME) roots.push(process.env.ANDROID_HOME);
  if (process.env.ANDROID_SDK_ROOT) roots.push(process.env.ANDROID_SDK_ROOT);
  try {
    const local = fs.readFileSync(path.join(appDir, 'android', 'local.properties'), 'utf8');
    const match = /^sdk\.dir\s*=\s*(.+)$/m.exec(local);
    if (match) roots.push(match[1].replace(/\\/g, path.sep).trim());
  } catch {
    /* 没有 local.properties 就算了 */
  }
  const exe = process.platform === 'win32' ? 'apksigner.bat' : 'apksigner';
  for (const root of roots) {
    const buildTools = path.join(root, 'build-tools');
    if (!fs.existsSync(buildTools)) continue;
    const versions = fs
      .readdirSync(buildTools)
      .sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]));
    for (const version of versions) {
      const candidate = path.join(buildTools, version, exe);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** 签名证书必须跟已发布的那些版本一致，否则已装用户升不上来。
 *
 * 找不到 apksigner 时**也失败**：能 `flutter build apk` 成功就说明这台机器有 Android SDK，
 * 那 apksigner 一定在某个 build-tools 里。"查不到就跳过"等于把最贵的那道检查静默关掉。 */
export function assertSigner(apkPath, { apksignerPath }) {
  if (!apksignerPath) {
    throw new Error(
      '找不到 apksigner，无法校验签名证书（构建能过就说明 SDK 在，只是没在 ANDROID_HOME / app/android/local.properties 里找到 build-tools）。把 sdk.dir 写进 app/android/local.properties 后重跑',
    );
  }
  // .bat/.cmd 不能直接 spawn（Windows 上 EINVAL）。走 shell 让它自己处理引号：
  // 整条命令作为字符串传（不是 args 数组），否则新版 Node 会报 DEP0190
  // （数组 + shell=true 不等于转义）。SDK 装在 "C:\Program Files\..." 时也依旧能跑。
  const lower = apksignerPath.toLowerCase();
  const isBatch = lower.endsWith('.bat') || lower.endsWith('.cmd');
  const probe = isBatch
    ? spawnSync(`"${apksignerPath}" verify --print-certs "${apkPath}"`, {
        encoding: 'utf8',
        shell: true,
      })
    : capture(apksignerPath, ['verify', '--print-certs', apkPath]);
  const digest = parseSignerDigest(`${probe.stdout ?? ''}${probe.stderr ?? ''}`);
  if (!digest) throw new Error('读不出 apk 的签名证书，包可能没签或 apksigner 报错');
  if (digest !== EXPECTED_SIGNER_SHA256) {
    throw new Error(
      `签名证书是 ${digest}，已发布版本是 ${EXPECTED_SIGNER_SHA256}。用它发出去，已装用户的升级会报 INSTALL_FAILED_UPDATE_INCOMPATIBLE（详见 docs/ANDROID.md）`,
    );
  }
  return digest;
}

const HELP = `打 Android 安装包（apk）。

  node scripts/pack-android.mjs [选项]

  --no-build          不跑 flutter build，复用已有产物（只重新校验 + 改名）
  --abi <值>          universal（默认，三 ABI 合一）| arm64 | arm | x64
  --out <文件>        输出路径（默认 dist/orbis-android-v<版本>.apk）
  --help              这段文字

前置：JDK 17+（JAVA_HOME 或 PATH）、Android SDK、PATH 里的 flutter。
产物名里的版本取自 server/package.json，必须与 app/pubspec.yaml 一致。`;

function parseArgs(argv) {
  const options = { build: true, abi: 'universal', out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--abi') options.abi = argv[++i] ?? '';
    else if (arg === '--out') options.out = argv[++i] ?? '';
    else throw new Error(`未知参数 ${arg}（--help 看用法）`);
  }
  if (!['universal', 'arm64', 'arm', 'x64'].includes(options.abi)) {
    throw new Error(`--abi 只能是 universal / arm64 / arm / x64，收到 ${options.abi}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const appDir = path.join(repoRoot, 'app');
  const serverDir = path.join(repoRoot, 'server');

  const serverVersion = String(readJson(path.join(serverDir, 'package.json')).version ?? '');
  const pubspec = parsePubspecVersion(fs.readFileSync(path.join(appDir, 'pubspec.yaml'), 'utf8'));
  const version = assertVersionsAgree({ serverVersion, pubspec });

  const mirror = findMirrorHost(fs.readFileSync(path.join(appDir, 'pubspec.lock'), 'utf8'));
  if (mirror) {
    throw new Error(
      `app/pubspec.lock 里带镜像地址（${mirror}），CI 会用官方源 --enforce-lockfile 判红。修法：git checkout HEAD -- app/pubspec.lock 后重跑`,
    );
  }

  const javaHome = process.env.JAVA_HOME ?? '';
  const javaBin = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const jdk = checkJdk({
    javaHome,
    runJavaVersion: () => {
      const probe = capture(javaBin, ['-version']);
      return `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
    },
  });
  console.log(`JDK ${jdk}，版本 ${version}（构建号 ${pubspec.build}）`);

  // 镜像环境变量会改写锁文件里的 URL，构建期间一律压回官方源。
  const env = { ...process.env, PUB_HOSTED_URL: OFFICIAL_PUB };
  delete env.FLUTTER_STORAGE_BASE_URL;

  if (options.build) {
    const flutter = requireFlutter();
    console.log('解析依赖（--enforce-lockfile，官方源）…');
    runShell(commandLine(flutter, ['pub', 'get', '--enforce-lockfile']), { cwd: appDir, env });
    const targets = {
      universal: [],
      arm64: ['--target-platform', 'android-arm64'],
      arm: ['--target-platform', 'android-arm'],
      x64: ['--target-platform', 'android-x64'],
    }[options.abi];
    console.log(`构建 apk（${options.abi}）…`);
    runShell(commandLine(flutter, ['build', 'apk', '--release', '--no-pub', ...targets]), { cwd: appDir, env });
  } else {
    console.log('跳过构建（--no-build）');
  }

  const apkPath = path.join(appDir, APK_RELATIVE);
  if (!fs.existsSync(apkPath)) {
    throw new Error(`找不到 ${APK_RELATIVE}，构建没成功或没跑（去掉 --no-build 试试）`);
  }
  verifyMetadata(readJson(path.join(appDir, METADATA_RELATIVE)), { version, build: pubspec.build });
  const signer = assertSigner(apkPath, { apksignerPath: findApksigner(appDir) });

  // 构建过程中版本被改了：包已经出来，但名字按新版本叫 —— 这种包不能发。
  const after = parsePubspecVersion(fs.readFileSync(path.join(appDir, 'pubspec.yaml'), 'utf8'));
  assertVersionsAgree({ serverVersion, pubspec: after });

  const out = path.resolve(repoRoot, options.out ?? path.join('dist', apkFileName(version)));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temp = `${out}.tmp-${process.pid}`;
  try {
    fs.copyFileSync(apkPath, temp);
    fs.renameSync(temp, out); // 同目录 rename：要么换成新包，要么上一版原样在
  } finally {
    // 复制/改名中途挂了：把临时文件抹掉，不留一个 82MB 的半成品
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }

  const size = fs.statSync(out).size;
  console.log(`\n${path.relative(repoRoot, out)}`);
  console.log(`  ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  签名 ${signer.slice(0, 16)}…（与已发布版本一致）`);
  console.log(`  sha256 ${sha256(out)}`);
  console.log('\n上传到 release：gh release upload v<版本> <文件> --clobber');
  return 0;
}

const entryPath = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`\n打包失败：${error.message}`);
    process.exitCode = 1;
  }
}
