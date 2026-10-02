# AR V2 开发状态

日期：2026-10-02。开发分支 `codex/ar-v2-visual-localization`；旧版冻结基线 `6e70865`。

用户已明确授权“按 V2 开始开发”。本轮新增独立实现，原始视频、轨迹、模型只读。旧 AR 核心无改动；平台只增加独立入口。

## 阶段实测

| 阶段 | 当前结果 | 证据与边界 |
| --- | --- | --- |
| A0 环境和骨架 | 已实测通过 | 独立 Python 3.12、OpenCV 4.12、Three.js 0.180；torch 2.8.0+cu128 / torchvision 0.23.0+cu128。CLI、任务进度、取消和本地服务已实现。 |
| A1 固定场景 | 实际模型转换通过 | ROI 半径 350m、固定 geometricError 0.5；412 块、199146 顶点、186057 三角面。CPU/GPU 顶点相同，抽样回 ECEF 最大误差 0.00001661m。8 项转换回归通过。 |
| A2 参考图 | 75 张实际参考图自洽校验通过 | 960×540 RGB、R32F camera-Z、uint32 三角面与mask；4800 个独立 CPU 射线样本全部通过，P95深度差0.000574m、最大0.002838m（固定绝对+相对阈值内）。 |
| A3 单帧定位 | 首轮真实 SIFT 基线 LOST | 10.01s = 原帧300 / PTS300300 / time_base1/30000；修复ID后50组唯一对应，PnP未通过。不得把命令COMPLETED当定位通过。ALIKED+LightGlue/CUDA实测10.7s，419组对应、10内点、5网格，DEGRADED；逐参考图最大62内点但仅2网格，未通过原门槛。 |
| A4 共享标定 | 未完成 | 已实现并合成测试固定K的pose-only多帧优化；原始K/D共享优化明确不支持，不冒充标定完成。 |
| A5 独立融合 | 合成与界面检查通过，真实定位融合未验收 | RTX4080 R32F FBO/7.25m已知平面通过；19项GPU行为检查包含颜色、方向、观察视角、斜面、遮挡、mask及错帧拒绝。 |
| A6 全片跟踪 | 未实测全片 | 已实现真实LK前后向+三维锚点PnP+模型重定位，失败LOST；全片3467帧尚未求解/验收。 |
| A7 平台 | 独立入口和本地任务链可运行 | `ar-v2.html` / 启动 AR V2.cmd；实际浏览器加载固定场景及LOST回退通过。连续视频播放尚未集成验收。 |

## 已执行命令

```powershell
ar_v2/.venv/Scripts/python.exe -m unittest discover -s ar_v2/tests -v
ar_v2/.venv/Scripts/python.exe -m ar_v2 prepare-scene
ar_v2/.venv/Scripts/python.exe -m ar_v2 extract-frames
ar_v2/.venv/Scripts/python.exe -m ar_v2 build-references
ar_v2/.venv/Scripts/python.exe -m ar_v2 localize --time 10.01 --matcher sift
node tools/ar-v2-smoke.mjs
```

实际输入：HEVC 3840×2160，3467帧，30000/1001fps，时基1/30000，duration_ts3470467。6个验证时刻均映射至实际整数PTS，原图与1920×1080去畸变图分别保存。相机初始估算配置 `rectified-0dfb35a602d74d3b / estimated-v1`，并非已标定内参。

几何版本：`98edb8de16ebcfdc66a38ad60758fb598d09f5ffca47217c0e3d83cbb2797123`。
外观版本：`d368774c5104ed6f604bedd92b9b3df2d3d10a8a8784f2d7968a316e2e191891`。
视频SHA256：`23a7b793b9fcb0d947c5016c886942f2e130470fbd615e1dff161c559e6f7aa7`。

## 已发现并修复

三角面编号通过浮点varying传递后直接转uint发生截断，独立射线检查发现约半数样本错一面。保留失败报告，606个失败案例全部由ID+1精确恢复，修复输出取整后4800样本通过。该实测阻止了无效2D–3D对应进入后续定位。

CUDA官方3.46GB wheel首次下载超时，已以分段续传和官方SHA256验证完成；不使用隐式SIFT替代学习匹配器。

## 证据位置及未决条件

- `output/ar-v2/jobs/`：实际任务状态和错误。
- `output/ar-v2/scene/scene_manifest.json`：原始资源哈希、LOD、变换和几何误差。
- `output/ar-v2/media/`：全部原始PTS索引、标定档案、抽帧及有效mask。
- `output/ar-v2/references/validation.json`：独立参考渲染自洽检查。
- `output/ar-v2/references/validation-before-id-rounding.json`、`id_diagnostics.json`：错误保留及根因证据。
- `output/ar-v2/localization/00010.010000/`：真实匹配、去重、PnP和叠图结果。
- `output/ar-v2/environment/`：GPU、浏览器检查及依赖记录。

未提供独立检查点，真实定位精度与绝对地理精度均未验收。遥测只用于候选相机，无固定高度差或时间偏移回退。以真实数据质量门槛决定后续阶段，不以合成测试替代实际验收。
软件回归：36项Python检查通过；独立参考验证4项自检通过；前端完整构建通过（仅既有大包/浏览器外部模块提示）。

高细节实验位于output/ar-v2-quality：固定error0.125、470块、840285面，1280×720参考75张独立校验通过。主匹配仍DEGRADED，正在分析逐参考图支持与跨图合并，未降低门槛。
