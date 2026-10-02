# AR V2 开发状态

更新日期：2026-10-03。分支 `codex/ar-v2-visual-localization`；旧版冻结基线 `6e70865`；独立工程首个阶段提交 `7459680`。后续恢复先读本文、检查 Git 状态及实际输入，不回滚用户资料。

用户已明确授权“按 V2 开始开发”。原任务书已逐字归档至 `docs/video-ar-v2-task-spec.md`（SHA256 `ba4bc6b77a6c9bdf348bf0d801203e177af81067f573795acd5ef96519a935b6`）。本轮已建立并运行独立实现，原始视频、轨迹、模型只读；旧 AR 核心保持冻结。当前是可复现的开发验证版本，V2 全部阶段尚未完成，真实精度没有通过验收。

## 当前真实结果

正式默认配置使用 350m ROI、固定 geometricError 0.125、1280×720 的75张参考图。10.01s（原帧300，PTS300300，time_base1/30000）由 ALIKED + LightGlue / CUDA、逐参考视角 PnP、多视角一致性选择与 LM 求解，耗时22.95秒：

| 指标 | 实测 |
| --- | --- |
| 唯一有效视频观测 | 1517 |
| 最终用于求解的唯一对应 / 内点 | 142 / 139 |
| 全部观测的内点比例 | 9.1628% |
| 图像覆盖 | 9 / 12 网格 |
| 内点拟合 RMS / P95 / 最大误差，1080p口径 | 1.6879 / 2.6102 / 2.8609 px |
| 状态 / 独立验收 | **DEGRADED / false** |
| 独立检查点误差 / 地理绝对精度 | **未提供 / 未验证** |

退化原因是 `low_inlier_ratio`：当前实现额外采用 `min_inlier_ratio=0.20` 的保守门槛（V2任务书未指定这个数值）。完整分母包括被几何选择排除的唯一观测；不能把139/142的97.89%当作全部观测的内点比例。上述1.69px是拟合内点残差，不是独立精度。未因本次结果调低门槛；后续应结合独立点、重复纹理歧义和多帧稳定性评估这项策略。

查看此帧时显示模型原纹理及重投影证据，禁止将退化位姿用于正式融合。CLI `COMPLETED`只代表命令完成；界面同时显示定位、优化或验收结果。

## 阶段情况

| 阶段 | 结果 | 已验证范围与剩余工作 |
| --- | --- | --- |
| A0 环境与任务骨架 | 已运行 | Python3.12 / OpenCV4.12 / torch2.8.0+cu128 / Three0.180；RTX4080。CLI、进度、取消、本地服务、依赖锁与权重哈希齐全。 |
| A1 固定场景 | 真实模型转换通过 | 470块、795245顶点、840285三角面。7502个回ECEF抽样最大误差0.00001645m；全顶点float32最大误差0.00001701m。保留材质、UV、alphaTest、轴向与RTC，固定CPU/GPU几何版本。 |
| A2 参考渲染 | 75张自洽检查通过 | RGB、R32F camera-Z、uint32三角面、有效mask；4800个独立CPU射线抽样通过，P95深度差0.000421m、最大0.002295m。该检查不等于真实位姿验收，也不是全场景穷举遮挡验证。 |
| A3 单帧定位 | 真实结果DEGRADED | 学习匹配器、几何候选竞争、唯一锚点、PnP/LM和证据保存均已接入。仍须解决低整体支持率与重复纹理歧义，扩大真实关键帧验证。 |
| A4 多帧共享标定 | 未完成 | 固定K的pose-only优化通过合成回归；真实报告NOT_OBSERVABLE（0个合格关键帧）。原始K/D共享优化尚未实现，调用该模式明确报错。 |
| A5 独立融合 | GPU与界面验证通过；实景未验收 | 19项GPU回归通过；已知7.25m平面R32F误差0；涵盖颜色、方向、斜面、遮挡、mask、ID、冻结图像和错帧拒绝。 |
| A6 连续跟踪 | 核心实现，未完成全片处理 | LK前后向校验、三维锚点PnP、模型重定位与失败停止已实现并合成测试。3467帧尚未离线求解及连续验收。 |
| A7 平台接入 | 独立页面可运行 | 启动器、真实场景、处理帧查看、进度/取消及退化回退已实测。连续视频同步回放尚未实现。 |

## 复现入口

双击根目录 `启动 AR V2.cmd`，页面为 `http://127.0.0.1:5173/ar-v2.html`，计算服务为5199；参考批渲染临时使用5198。详情见 `ar_v2/README.md`。不要同时从CLI和页面启动修改相同产物的计算任务。

本轮实际执行并记录：

```powershell
ar_v2/.venv/Scripts/python.exe -m ar_v2 doctor
ar_v2/.venv/Scripts/python.exe -m ar_v2 prepare-scene
ar_v2/.venv/Scripts/python.exe -m ar_v2 extract-frames
ar_v2/.venv/Scripts/python.exe -m ar_v2 build-references
ar_v2/.venv/Scripts/python.exe -m ar_v2 localize --time 10.01
ar_v2/.venv/Scripts/python.exe -m ar_v2 validate
ar_v2/.venv/Scripts/python.exe -m ar_v2 refine
ar_v2/.venv/Scripts/python.exe -m unittest discover -s ar_v2/tests -q
ar_v2/.venv/Scripts/python.exe -m ar_v2.reference_validation
ar_v2/.venv/Scripts/python.exe -m pip check
node tools/ar-v2-service-smoke.mjs
node tools/ar-v2-smoke.mjs
pnpm build
```

65项Python回归、4项独立参考校验自检、19项GPU回归、8项API检查及实际页面加载均通过。生产构建通过；仍有既有CAD浏览器外部模块及大包提示。API检查会启动并取消一个由测试创建的任务，日志CANCELLED为预期结果。依赖检查无冲突。

## 身份与证据

- 输入：原片HEVC 3840×2160，3467帧，30000/1001fps，时基1/30000，duration_ts3470467。6个验证时刻按原始整数PTS抽帧。
- 视频SHA256：`23a7b793b9fcb0d947c5016c886942f2e130470fbd615e1dff161c559e6f7aa7`。
- 当前几何：`d33ead924779c95c8b7511eb7b97469b924ec50b40be45d117299834291b35a6`。
- 当前外观：`7d2ece5be4123790c01bfe5b3f29e5e9017e91e057b6d30845b1c3166955b089`。
- 去畸变相机：`rectified-0dfb35a602d74d3b / estimated-v1`，1920×1080；初始内参和零畸变仍为估算，未经标定。
- `output/ar-v2/jobs/`：每次任务的状态、结果与错误。
- `output/ar-v2/scene/scene_manifest.json`：源文件哈希、转换链、LOD和坐标检查。
- `output/ar-v2/references/validation.json`：本次4800个独立几何抽样。
- `output/ar-v2/localization/00010.010000/`：pose、原始匹配、最终对应、几何候选、共识报告与overlay。
- `output/ar-v2/validation/report.json`：`NOT_EVALUATED`；`refinement/report.json`：`NOT_OBSERVABLE`。
- `output/ar-v2/environment/`：依赖、GPU、API与页面检查及截图；`source-preservation.json`复核本次使用的883个模型源文件与原片hash，均无变化。
- `output/ar-v2/experiments/`、`output/ar-v2-quality/`：保留较粗LOD/SIFT/旧合并方法与高细节对照。

位姿JSON在写产物前校验：身份字段、原PTS对应秒数、有限内参、刚体矩阵和独立验收依据。独立检查点需绑定视频hash、帧ID、PTS、时基、几何版本、相机档案与标定版本，仅时刻相同不予复用。检查点不参与求解或候选选择；精修仍保留完整观测分母。

## 关键修复与下一步

浮点varying传递三角面编号后直接转uint曾造成截断，独立射线检查发现606个失败案例均能通过ID+1恢复。修复GPU输出取整及CPU读取后，旧LOD和当前高细节LOD检查均通过；失败报告仍保留。参考采样使用像素中心射线与实际三角面交点，不用整数深度值冒充亚像素位置。

跨参考图直接合并曾产生大量同像素异三维点冲突。新方法先独立建立视觉几何候选，再按候选重投影和一致性选择唯一锚点；不采用遥测相机替代视觉失败，也未添加固定高差/时间偏移。

后续优先：验证多个稳定关键帧与重复纹理歧义，补充至少6个留出的真实检查点，建立原始像素观测用于共享K/D优化；达到定位门槛后再推进全片离线解算与按媒体PTS同步回放。底图与模型的地理基准误差另行测量，不能通过移动模型掩盖视频错位。
