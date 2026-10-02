# 无人机视频 AR · 压缩恢复基准

记录日期：2026-10-02。这是后续接续入口；详细证据见末尾链接。恢复时先检查 Git/当前资料是否变化，不重做已完成修复，不把本文件快照当作永远不变的状态。

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

## 已核实的真实运行快照

- 活动视频记录：`111f64c7-062e-4ac5-bc8c-26c27f4374ed`；模型：`8bc58629-cf26-45de-986e-086479db11a0`，模型可见。原视频名 `DJI_20260819162016_0001_V_航点1.mp4`，轨迹同名前缀的 `_Cesium轨迹_请选择此文件.json`。文件位于 `project-data/records/<id>/video/`、`source/`；模型入口位于模型记录的 `tiles/Production_2.json`。
- 当前保存配置：模型投影、estimated高程、用户现存试算基准0m、手动校准开启且修正为零；calibrationSessions=0。
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

## 验证已完成，勿无故重跑

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
