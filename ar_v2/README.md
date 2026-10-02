# 无人机视频 AR V2

独立代码与离线产物位于 `ar_v2/` 和 `output/ar-v2/`。旧版 AR 的相机、投影与深度模块不被导入。阶段实测状态见根目录 `AR_V2_STATUS.md`。

## 启动与操作

安装环境完成后双击根目录 **启动 AR V2.cmd**，或运行：

```powershell
ar_v2/.venv/Scripts/python.exe -m ar_v2 serve
```

浏览器入口 `http://127.0.0.1:5173/ar-v2.html`。计算服务默认 5199，批量参考图使用独立临时服务器 5198。每项任务写入 `output/ar-v2/jobs/<job-id>/status.json`，包含实际阶段、进度和失败原因。启动器日志位于 `output/ar-v2/launcher/`。

```powershell
ar_v2/.venv/Scripts/python.exe -m ar_v2 doctor
ar_v2/.venv/Scripts/python.exe -m ar_v2 prepare-scene
ar_v2/.venv/Scripts/python.exe -m ar_v2 extract-frames
ar_v2/.venv/Scripts/python.exe -m ar_v2 build-references
ar_v2/.venv/Scripts/python.exe -m ar_v2 localize --time 10.01
ar_v2/.venv/Scripts/python.exe -m ar_v2 localize --time 10.01 --matcher sift
ar_v2/.venv/Scripts/python.exe -m ar_v2 refine
ar_v2/.venv/Scripts/python.exe -m ar_v2 track
ar_v2/.venv/Scripts/python.exe -m ar_v2 validate
```

`--config` 指定项目 YAML。默认从当前工程资料库选中的视频解析输入，存在多个模型时需要指定 `inputs.model_record_id` 或 `inputs.tileset`。输出目录不得位于原始数据目录。SIFT 必须显式选择；ALIKED/LightGlue 缺依赖或权重时报告错误。

## 依赖

Python 3.12，Node.js，pnpm，FFmpeg/ffprobe，以及 WebGL2 + `EXT_color_buffer_float`。本机完整锁定清单见 `requirements-win-py312.lock.txt`，核心依赖版本见 `requirements.txt`、根目录 `pnpm-lock.yaml`；实际安装清单由 doctor 写入 `environment/python-freeze.txt`。PyTorch CUDA wheel 来自官方索引，当前固定 2.8.0 / torchvision 0.23.0 / CUDA 12.8。LightGlue 固定 Git 提交；权重须在首次使用前下载到配置的 torch hub 缓存并记录哈希。

```powershell
python -m venv ar_v2/.venv
ar_v2/.venv/Scripts/python.exe -m pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
ar_v2/.venv/Scripts/python.exe -m pip install -r ar_v2/requirements.txt
pnpm install --frozen-lockfile
ar_v2/.venv/Scripts/python.exe -m ar_v2.bootstrap_weights
```

批量参考渲染需要 Playwright 模块和 Edge/Chromium。支持本机 Codex 运行时中的 Playwright；其他环境安装 Playwright 或配置 `runtime.playwright_module`、`runtime.browser`，不把机器路径写入定位算法。

## 坐标与缓存契约

- 世界坐标为 ENU 米制；ECEF→ENU 使用双精度。GLB 的 POSITION 已烘焙为 ENU，加载器不得再做 Y-up 修正。相同 `geometry_version` 同时绑定 CPU 网格、参考图与视频融合。
- 相机采用 CV：x 右、y 下、z 前；`X_camera = R * X_scene + t`。矩阵写为行主序，乘列向量；Three.js 视图矩阵为 `diag(1,-1,-1) * T_camera_from_scene`。
- 像素中心从 `(0,0)` 开始；缩放主点公式为 `c' = s(c+0.5)-0.5`。参考深度是顶部行优先、小端 Float32 的相机 Z 米；三角面编号是顶部行优先、小端 Uint32，0 开始，背景 `4294967295`。
- 初始相机内参及零畸变均为 **estimated**。遥测仅生成候选参考相机，不能替代视觉解。多帧首版只优化固定三维点的各帧外参；共享 K/D 优化未实现时显式拒绝。
- `LOCALIZED` / `TRACKED` 才能提交冻结的帧图像、原 PTS、视频哈希、相机版本和几何版本。其余状态恢复模型原纹理。独立检查点缺失时报告 null/未验证，训练内点残差不等于定位验收。
- RGB 与 sourceDepth 用同一场景、K 和外参；R32F、最近采样、硬件深度、无 MSAA/对数深度/深度偏移。比较时把三角面平面移到深度 texel 中心，容差由 Float32 精度与 GPU 亚像素光栅精度给出。不同面编号本身不作为遮挡拒绝依据。

## 验证

```powershell
ar_v2/.venv/Scripts/python.exe -m unittest discover -s ar_v2/tests -v
pnpm build
```

doctor 实际启动 GPU 深度探针和渲染回归，结果与设备名写入 `environment/`。这些合成检查用于发现代码错误，实际视频的独立检查精度需要真实留出点另行验证。

依据：[OpenCV PnP](https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html)、[LightGlue 官方实现](https://github.com/cvg/LightGlue)、[3D Tiles 1.0](https://docs.ogc.org/cs/18-053r2/18-053r2.html)、[Three.js RenderTarget](https://threejs.org/docs/pages/RenderTarget.html)。
