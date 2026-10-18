import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

// Only the standalone SDK is supported. sketchup.exe and sketchup.dll belong to
// the desktop application and must never be used as an unattended converter.
export function findSketchupSdk(projectRoot, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'win32' || arch !== 'x64') return {
    available: false,
    reason: '内置 SKP 后台转换需要 Windows 64 位环境；当前环境可导入 GLB，或配置独立后台转换器',
    details: [],
  };
  const configured = options.sdkDirectory ?? process.env.CESIUM_SKETCHUP_SDK_DIR;
  const roots = [...(configured ? [resolve(configured)] : []), resolve(projectRoot, 'tools/sketchup-sdk')];
  const folders = roots.flatMap((root) => [root, join(root, 'binaries/sketchup/x64'), join(root, 'SketchUpSDK/binaries/sketchup/x64')]);
  const directory = folders.find((folder) => isFile(join(folder, 'SketchUpAPI.dll')));
  if (!directory) return {
    available: false,
    reason: '尚未安装 SKP 后台转换组件（SketchUp C SDK），不会打开 SketchUp 窗口',
    details: ['将官方 C SDK 的 binaries/sketchup/x64 内容放入 tools/sketchup-sdk，或设置 CESIUM_SKETCHUP_SDK_DIR 后重启平台', '首次配置完成后，日常导入只需选择文件并在地图上点选放置位置'],
  };
  return {
    available: true,
    directory,
    library: join(directory, 'SketchUpAPI.dll'),
    reason: '已找到 SKP 后台转换组件；导入时在独立进程中读取文件，不启动 SketchUp',
    details: ['使用官方独立 C SDK 读取 SKP；组件版本、依赖及具体模型的转换结果将在导入时校验'],
  };
}
