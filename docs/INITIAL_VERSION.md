# 初始版本备份与恢复

- 保存日期：2026-09-30（Asia/Shanghai）。
- GitHub 私有仓库：`cristinomcleary-ship-it/cesium`。
- 初始分支：`codex/initial-version`。
- 固定标签：`v1.0.0-initial`。后续开发保留此标签，不移动或覆盖。
- 此版本保存备份时的现有应用代码；本次只补充 Git 忽略规则、备份说明、校验清单和精确依赖记录。

## 备份范围

Git 保存前端、服务器、视频 AR 后端、已有测试、转换器源码、启动脚本、配置模板、示例和 `pnpm-lock.yaml`。

同一版本的 GitHub Release 附件另外保存原始 FFmpeg、COLMAP 安装包、源码 ZIP、完整 Git bundle 与 SHA256 清单。工具包的来源、版本和许可证说明保留在 `video_ar_backend/tools/*-INSTALL.txt` 中；解压时同时保留包内许可证。

未上传：实际 `.env`/`.env.local`、`model-converters.json`、视频和工程数据、模型/影像缓存、`node_modules`、Python 虚拟环境、构建输出、临时文件和 Navisworks 商业运行库。它们不属于 Git 源码备份。真实配置已另存于本机 `.local-backups/v1.0.0-initial/local-config/`（如原文件存在），不会进入 GitHub。工程模型、视频、浏览器内保存的数据需要另行保留原始数据。

## 安全恢复：先恢复到新目录

使用有仓库访问权限的 GitHub 账号，在所需父目录执行：

```powershell
git clone --branch v1.0.0-initial --single-branch https://github.com/cristinomcleary-ship-it/cesium.git cesium-initial
cd cesium-initial
git switch -c codex/recovery
pnpm install --frozen-lockfile
pnpm dev
```

这样保留当前开发目录，恢复后的代码可独立验证。不要对仍需保留的工作目录执行强制重置。

离线恢复可从 Release 下载 `cesium-v1.0.0-initial.bundle`，或使用本机 `.local-backups/v1.0.0-initial/` 中的同名文件：

```powershell
git clone --branch codex/initial-version .\cesium-v1.0.0-initial.bundle cesium-initial
```

解压源码 ZIP 也可恢复源码，但 ZIP 不包含 Git 历史。`docs/initial-files.sha256.json` 记录初始文件原始字节的 SHA256（不包含清单自身）；Git 标签另行固定完整提交。

## 恢复运行环境

本次检查环境：Windows，Node.js `24.21.0`，pnpm `11.19.0`，Python `3.12.14`，CesiumJS `1.144.0`。前端依赖使用 `pnpm-lock.yaml` 恢复。

Python 后端：

```powershell
cd video_ar_backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.initial.txt
Copy-Item .env.example .env
```

填写实际配置后再启动。`requirements.initial.txt` 固定本次已安装的后端直接依赖与所需传递依赖；`requirements.txt` 保留原有兼容范围。提取器图形界面还需要 Python 的 Tk 支持。

从 Release 获取下列原始工具包，先对照 `docs/initial-runtime.sha256` 或附件 `SHA256SUMS.txt` 验证 SHA256，再分别解压并整理为以下结构（必要时去掉压缩包额外的最外层目录）：

| 原始压缩包 | 最终关键路径 |
| --- | --- |
| `ffmpeg-n9.0.1-11-ge47273f4d9-win64-lgpl-shared-9.0.zip` | `video_ar_backend/tools/FFmpeg/bin/ffmpeg.exe` 和 `ffprobe.exe` |
| `colmap-x64-windows-cuda-4.0.4.zip` | `video_ar_backend/tools/COLMAP/COLMAP.bat` 和 `COLMAP/bin/colmap.exe` |

COLMAP 压缩包名称为 4.0.4，其内置程序报告的版本为 `4.1.0.dev0`，来源说明已记录这一差异。工具包之外的 GPU 驱动及 Autodesk/SketchUp/Blender 等本机软件仍须按实际用途配置。Navisworks 转换桥源码和构建脚本已保存，运行库由本机已安装且有授权的软件提供；换电脑后需调整脚本及 `model-converters.json` 中的本机路径。

## 备份时验证

| 检查 | 结果 |
| --- | --- |
| `pnpm build` | 通过；存在 Vite 资源体积提示 |
| Node 前端测试 | 22 项通过，0 失败 |
| Python 后端测试 | 105 项通过，0 失败 |
| 待提交文件常见密钥格式检查 | 未发现匹配；实际配置文件已排除 |

复查命令：

```powershell
node --experimental-transform-types --test src/videoArProjection.test.ts src/videoArGeoreference.test.ts src/digitalTwinDataCenter.test.ts
cd video_ar_backend
.\.venv\Scripts\python.exe -m unittest discover -s tests
```

这些结果记录构建与自动测试状态，不代表重新验收了实际无人机数据、三维画面贴合或外部软件转换。本次未修改应用功能代码。
