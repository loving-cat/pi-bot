/** 创建不含生成缓存的 Flutter 应用源码副本，供中性临时目录构建。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATED_NAMES = new Set([
  '.git', '.dart_tool', 'build', 'Pods', 'ephemeral', '.symlinks', 'xcuserdata',
  '.flutter-plugins', '.flutter-plugins-dependencies', '.packages', '.swiftpm',
  '.idea', '.vscode', '.fvm', '.DS_Store', 'coverage', 'node_modules',
  'flutter_export_environment.sh', 'Generated.xcconfig',
]);

/** 以路径段识别缓存目录，不误排除名称相近的业务源码。 */
export function includeBuildSource(relative) {
  return !relative.split(/[\\/]/).some((part) => GENERATED_NAMES.has(part));
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function stageMacosBuild(sourcePath, targetPath) {
  const source = fs.realpathSync(sourcePath);
  const requestedTarget = path.resolve(targetPath);
  const target = path.join(fs.realpathSync(path.dirname(requestedTarget)), path.basename(requestedTarget));
  if (within(source, target)) throw new Error('构建副本不能位于源码目录内');
  if (fs.existsSync(target)) throw new Error('构建副本目标已存在');
  for (const file of ['pubspec.yaml', 'lib/main.dart', 'macos/Runner.xcodeproj/project.pbxproj']) {
    if (!fs.statSync(path.join(source, file), { throwIfNoEntry: false })?.isFile()) throw new Error('应用源码缺少必要文件');
  }
  let files = 0;
  fs.cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter(file) {
      if (!includeBuildSource(path.relative(source, file))) return false;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        let resolved;
        try { resolved = fs.realpathSync(file); } catch { throw new Error('应用源码包含失效链接'); }
        if (path.isAbsolute(link) || !within(source, resolved) || !includeBuildSource(path.relative(source, resolved))) {
          throw new Error('应用源码包含无法安全复制的链接');
        }
      } else if (stat.isFile()) files++;
      else if (!stat.isDirectory()) throw new Error('应用源码包含不支持的文件类型');
      return true;
    },
  });
  return { files };
}

const entryPath = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('用法：node stage-macos-build.mjs <应用源码目录> <临时副本目录>');
    console.log(JSON.stringify(stageMacosBuild(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(`构建副本准备失败：${error.code ? '无法读取或复制源码' : error.message}`);
    process.exitCode = 1;
  }
}
