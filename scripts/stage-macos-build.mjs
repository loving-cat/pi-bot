/** macOS 入口：要求 macOS 工程文件，其余过滤与复制与 stage-app-build 相同。 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { includeBuildSource, stageAppBuild } from './stage-app-build.mjs';

export { includeBuildSource };

const MACOS_REQUIRED = ['pubspec.yaml', 'lib/main.dart', 'macos/Runner.xcodeproj/project.pbxproj'];

export function stageMacosBuild(sourcePath, targetPath) {
  return stageAppBuild(sourcePath, targetPath, { requiredFiles: MACOS_REQUIRED });
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
