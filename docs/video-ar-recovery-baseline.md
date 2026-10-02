# 无人机视频 AR · 压缩恢复基准

记录日期：2026-10-02。这是后续接续入口；详细证据见末尾链接。恢复时先检查 Git/当前资料是否变化，不重做已完成修复，不把本文件快照当作永远不变的状态。

## 2026-10-02 接续核对（以此节覆盖下方历史状态）

- 接续起点 HEAD=`699f624`，分支仍为 `codex/video-ar-execution-p0-p3`；起点工作区干净。localhost:5173 已有服务。
- 当前 `view.json` 活动视频已改为 `b1c98446-dc39-4531-b624-0dbc937eeb0a`。其保存设置为 **terrain / estimated / 校准关闭 / 起飞高程空**，`calibrationSessions=[]`；模型 `8bc58629-cf26-45de-986e-086479db11a0` 的保存状态为 **visible=false**。旧视频记录目录已不在当前资料库中。
- 新活动记录的视频、轨迹及模型入口 SHA256 与历史证据相同；这只确认这些文件内容，**不表示当前配置、运行相机或几何精度相同**。完整模型瓦片仍未逐文件哈希。
- 当前检查报告：`output/video-ar-recovery/run-rF3jXa/state.json`，仅检查持久化数据，未启动真实原片/GPU验收。所有关键帧真实误差与覆盖率仍为 null。
- 可运行 `node tools/inspect-video-ar-recovery.cjs --baseline output/video-ar-execution-20261002/acceptance/source-bindings.json` 重新检查。工具读取当前 view/records，向新的 output 子目录写报告，不切换投影、开启模型、应用校准或覆盖历史报告。
- 当前下一步仍需要人工点对：用户通过界面选择模型投影、显示模型，在10.01s保存8～12对拟合点及至少6对独立检查点。不要自动恢复旧的模型可见性/试算高程，不把旧 runtime-camera 当作新记录实测。

## 本次接续交付

- `6105ae3`：新增 `tools/inspect-video-ar-recovery.cjs`，动态读取当前活动视频、保存设置和点记录，对视频/轨迹/模型入口/元数据做SHA256绑定；历史资料仅用于比较。配置内容和哈希取自同一次读取，读取末尾复核保存变化。只向新 output 目录写报告，缺失的真实精度与覆盖率保持null。
- `84a12a9`：修复 `videoArFusion.restoreReplay` 恢复最近选点记录到导出入口；换源、清空、加载失败和直播切换清除旧的导出记录及图像。`VideoArControlPointPicker.restoreLastSession` 克隆保存记录、清空旧图片；恢复记录中的旧sourceKey不能为当前视频/Cesium图片提供身份依据。恢复后CPU报告可重算坐标误差，并明确缺失原帧。此增量不提供继续编辑旧点或自动应用旧解。
- 本轮验证：恢复检查 **4项CPU测试**、选点 **12项浏览器检查**、完整应用 **19项回归**、TypeScript及正式构建通过。新增断言覆盖持久化恢复、完整JSON不变、缺原帧标识、禁止借用当前图像，以及选新素材后立即清除旧导出。GPU脚本顺序运行；使用合成隔离资料，不代表真实配准精度。构建仍有既有CAD模块浏览器兼容与大包提示。
- 本轮证据目录：`output/video-ar-recovery/run-rF3jXa/`，包含 `state.json`、`controls-result.json`、`application-result.json`、两个 `*-restored-cpu-review.html`、`application-restored-control-record.json`、`source-preservation.json` 和 `manifest.json`。HTML/JSON中的测试点全部属于合成测试，不是本航次人工配对。
- 前后实测：原片、轨迹、模型入口、视频record和模型record五个文件哈希一致；`view.json` 的观察相机发生变化，活动视频ID仍相同。因此 `allBoundFilesUnchanged=false` 被如实保留，未回写旧视角；不可声称六个文件全部未变。
- 本轮提交只在本地，未推送。需要回退时可分别 `git revert 84a12a9`、`git revert 6105ae3`；保留项目数据和output证据。

## 目标与当前结论

- 项目：`F:\codex\cesium`，Windows / PowerShell，Cesium **1.144.0**。既有软件需保留用户上传资料；当前任务是 DJI 视频 + SRT 轨迹 JSON 与倾斜摄影模型融合，修正错位、楼体拉伸及空洞。用户明确要求保留楼体、贴合真实三维模型。
- 用户多次反馈先前修复无效。当前按 `C:\Users\胡航\Downloads\Codex_无人机视频AR_执行任务书.md` 推进，已完成具备条件的代码工作，**真实地理配准和整段视频精度尚未验收**，不能宣称定位/畸变已解决。
- 当前缺口：没有正式人工确认的拟合点和独立检查点。10.01/30/60/90/114s 的真实 RMS/P95/max/有效覆盖率均未测量（JSON为null），并非零误差。

## 代码与版本

分支 `codex/video-ar-execution-p0-p3`。本恢复文件创建前 HEAD=`29ecd79`，工作区干净；本轮提交仅在本地，**未推送 GitHub**。旧基线=`2ce8fc4`。

| 提交 | 已完成内容 |
| --- | --- |
| `1c74078` | P0：纯、不可变 ResolvedCameraFrame，统一实际相机/K/高程/PTS/来源与质量 |
| `77f566a` | P1工具：固定K稳健六自由度求解；保留异常点；独立CPU重投影和HTML检查图 |
| `2fc4394` | P0补充：相机/纹理来源+帧身份配对；暂停取消选点恢复；无RVFC媒体时间；原始recorded_at另存 |
| `2528dce` | P2：一致控制流导数、深度断裂处禁止跨表面外推、诊断掩膜、同帧前后对照 |
| `7a6d56c` | P3验证：原始HEVC、真实完整应用相机/纹理/深度证据与回归脚本 |
| `29ecd79` | 完整执行与接手说明 |

主要入口：`src/videoArFusion.ts`、`videoArCameraFrame.ts`、`videoArTextureFrame.ts`、`videoArModelProjector.ts`、`videoArControlPoints.ts`、`videoArControlPointPicker.ts`、`videoArControlPointSession.ts`、`videoArCpuReprojection.ts`、`videoArCalibrationReview.ts`。

如需回退，按依赖逆序使用对应提交的git revert，不强制reset，不删除正式资料。

## 历史真实运行快照（不是本次当前状态）

- 活动视频记录：`111f64c7-062e-4ac5-bc8c-26c27f4374ed`；模型：`8bc58629-cf26-45de-986e-086479db11a0`，模型可见。原视频名 `DJI_20260819162016_0001_V_航点1.mp4`，轨迹同名前缀的 `_Cesium轨迹_请选择此文件.json`。文件位于 `project-data/records/<id>/video/`、`source/`；模型入口位于模型记录的 `tiles/Production_2.json`。
- 当时保存配置：模型投影、estimated高程、用户现存试算基准0m、手动校准开启且修正为零；calibrationSessions=0。
- **10.01s**：rawAbsAltitude=99.117m，relative=70.001m；实际采用高度约**70.001m**。K参考3840×2160，fx=fy=2560、cx=1920、cy=1080；云台yaw/pitch/roll=-30/-30/0°。这些K是等效焦距估计，未完成镜头标定。
- resolved/committed相机及uploaded/committed纹理均对应10010ms。墙钟 `2026-08-19T16:20:26.572` 独立保留，不能当PTS或曝光同步证明。
- 真实完整应用等待20.162s后，模型和当前源深度均就绪，535条source/cast命令、请求队列清零；仍不能证明地理位置准确。早期未就绪资料另存preload-runtime-*。
- 六个正式源文件（原视频/轨迹/模型入口/两record/view）SHA256前后一致。模型入口哈希不是全套瓦片内容哈希。

## 不得丢失的边界

1. **不要硬编码+29.116m。** 99.117−70.001只是本素材候选差值，高程基准未核定；深度前后实验固定99.117m也只是受控试验输入，并非当前项目已验证高度。
2. 之前代理粗选的14点及 `output/video-ar-real-registration-20261002` 仅为排查实验，不能当正式拟合/独立验收，也不自动应用其位姿或焦距。
3. 保留首表面双向0.35m深度阈值和2m外推上限，不靠放宽容差补洞。掩膜屏幕计数、加载ready或请求归零都不等于真实覆盖率/几何精度。
4. **纠正过的归因：Edge原本已关闭polygonOffset**，SwiftShader及默认Edge证据中初始enabled均false。显式禁用/断言用于跨浏览器一致性，不能说它修好了本机画面。
5. 不改变原片/轨迹/模型身份，不自动开隐藏模型或生成摊平楼体的fallback；不切换Mars3D或开展全量重建。P4视觉定位尚未启动，须先依据P0～P3证据决定。
6. 检查点不进入求解/异常点筛选；一旦据其调参，须另留新的最终检查点。单帧外参拟合不等于镜头标定，也不等于全段有效。

## 历史基线验证（本次增量见上方，勿无故重跑）

71项视频AR单元测试、5项Fusion CPU状态断言、10项选点浏览器检查、17项合成模型GPU检查、17项完整应用回归、TypeScript及正式构建通过。测试分别验证软件行为/已知几何，不能替代真实精度。

原始4K HEVC在Edge149.0.4022.98默认GPU模式通过0/10.01/30/60/90/114s seek、暂停、实际帧读取及短段播放；未测完整115.68s连续性能。强制SwiftShader的完整app测试曾出现HEVC不支持，默认GPU成功；目前未制作代理视频。GPU验证脚本顺序执行。

## 下一步从这里继续

1. 先读已有 `project-data/view.json` 及当前活动记录，检查是否新增人工配对；不要只读取最早导入的旧记录。
2. 无真实配对时，请用户在10.01s冻结帧中保存**8～12对稳定拟合点、另至少6对独立检查点**，覆盖地面/桥面/楼顶，另用立面复核。选同一物理角点，避开水纹、车辆、树冠及已变化施工部位。
3. 界面“保存当前记录”保留原始点；固定K先“求解并应用校准”，导出CPU检查图与当前帧诊断。CPU及Cesium都错则查相机/配对/基准；CPU准而Cesium错则查渲染。
4. 同一校准原样复核30/60/90/114s，不逐帧手调冒充全段有效。1920×1080建议目标RMS≤3px、P95≤6px、max≤10px，未达到就报告实值。
5. 只有多帧证据支持时，再考虑内参/畸变标定、传感器时延或P4视觉定位。继续自主推进已授权工作，必要输入之外不重复索取许可。

## 恢复入口与运行环境

- 详细文档：`F:\codex\cesium\docs\video-ar-execution-20261002.md`
- 统一证据页：`F:\codex\cesium\output\video-ar-execution-20261002\index.html`
- 实际状态：上述output目录的 `frame_10.01/runtime-camera.json`、`runtime-checks.json`、`runtime-README.md`；同帧深度对照：`depth/run-1790921629720/preview.html`；真实精度缺项：`acceptance/keyframes.json`。
- `project-data/`、`output/`、`tmp/`被Git忽略，源码提交不会备份这些文件。证据manifest绑定本轮代码及报告哈希。
- 开发服务曾运行于localhost:5173，恢复时先查状态，不重复启动。Node：`F:\Node.js\node.exe`；Playwright模块：`C:\Users\胡航\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright`；Python/OpenCV：`video_ar_backend/.venv/Scripts/python.exe`。
- 验证入口：`tools/verify-video-ar*.cjs`，命令和测试范围见详细文档。此前普通exec因sandbox setup失败，必要时按实际错误请求require_escalated；不要绕过权限。Windows后台进程保持隐藏，编辑中文文件显式UTF-8。
