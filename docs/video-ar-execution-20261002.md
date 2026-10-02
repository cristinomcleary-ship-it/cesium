# 无人机视频 AR 执行与接手记录 · 2026-10-02

## 当前结论

已完成具备输入条件的 P0、P1 工具、P2 深度修复和 P3 解码/运行参数采集。**真实定位与建筑贴合精度仍未验收**：当前没有人工确认的拟合点及独立检查点，不能给出 RMS≤3px 的结论。此前粗选 14 点未作为正式配准输入，没有自动写入 +29.116m、其他位姿补偿或替换视频。

保持 Cesium 1.144.0，保留原视频、轨迹与 CC 模型。没有引入 Mars3D、全量重建或 P4 视觉定位。新代码在本机分支，未推送 GitHub。

证据入口：[本轮证据](../output/video-ar-execution-20261002/index.html)。输出和正式用户数据均遵循既有 .gitignore 留在本机；源码提交不包含原视频或模型。

## 分支及独立提交

基线 `2ce8fc4`，分支 `codex/video-ar-execution-p0-p3`。

| 阶段 | 提交 | 内容 |
| --- | --- | --- |
| P0 | `1c74078` | 不可变 ResolvedCameraFrame、实际参数和同 PTS 提交 |
| P1 | `77f566a` | 稳健固定 K 位姿求解、独立 CPU 检查图 |
| P0 补充 | `2fc4394` | 暂停恢复、无 RVFC 和位图纹理身份；原始墙钟另存 |
| P2 | `2528dce` | 一致导数、轮廓外推约束、深度掩膜与真实同帧对照 |
| P3 / 最终验证 | `7a6d56c` | 原始 HEVC、真实完整应用诊断、完整应用回归 |

回退按依赖关系逆序使用 `git revert <提交号>`；不要强制 reset 分支或删除 project-data。正式资料始终独立保存，回退代码不删除上传内容。

## 代码变化

| 文件 / 入口 | 实际变化和原因 |
| --- | --- |
| `src/videoArCameraFrame.ts/resolveCameraFrame` | 无 DOM/地形采样的纯解析，复制并深冻结来源、配置标识、PTS、K/畸变、高程、ECEF 位姿、有效修正及质量；显式高程只应用一次。K 优先 DJI 值或已启用手动值，未知基准保持 estimated。 |
| `src/videoArTextureFrame.ts` | 来源会话、帧键和媒体时间共同识别纹理；不能仅凭相同时间配对不同来源/位图。 |
| `src/videoArFusion.ts/updateSceneGeometry/commitModelCamera/drawTexture` | 模型、射线、标记、选点与实际参数读取统一相机。视频/位图上传成功后才能提交匹配相机；取消选点保留已提交身份，无 RVFC 使用 video.currentTime；来源切换清理旧配对。 |
| `src/videoArFusion.ts` 诊断和界面 | 显示未生效校正；导出 resolved/committed 相机、active/uploaded/committed/pending 纹理和实际 GPU 状态。rawRecordedAt 独立保留，未修改 PTS 或猜测传感器时延。深度检查颜色不持久保存为校准。 |
| `src/videoArControlPoints.ts/refineCameraPose` | 固定 K 的有界六自由度求解，确定性异常点筛选；仅拟合点参与，至少保留 5 点且不少于总拟合点三分之二。全部原点及误差保留，内点统计单列；不识别自洽的错误多数，仍需独立检查。 |
| `src/videoArCpuReprojection.ts`、`videoArControlPointSession.ts` | 独立 NED 旋转矩阵、光学坐标及 Brown–Conrady 实现，未复用求解器/GPU 投影函数；逐点重算全部拟合点及检查点，无效点保留并使相应统计无效。 |
| `src/videoArControlPointPicker.ts`、`videoArCalibrationReview.ts` | 保存原始二维/三维配对、角色、帧及来源/模型上下文；导出原帧、CPU 前后叠加图、异常点和检查点、1920 宽等比误差及 JSON。只有匹配的已提交 GPU 相机/纹理/源深度才附 Cesium 截图。 |
| `src/videoArModelProjector.ts` | 导数在一致控制流中计算；无效深度用有限占位值后统一拒绝。中心及源/观察邻域连续性均通过才允许外推；保留双向 0.35m 首表面阈值和 2m 外推上限。新增五种深度诊断。 |

文件元数据/加载会话标识及 FNV 配置标识不是媒体内容哈希。独立源资料 SHA256 见 `acceptance/source-bindings.json`；模型哈希只绑定入口 JSON 与记录，未逐文件哈希全套瓦片。用户声明的高程转换不冒充独立测量认证。

## 深度证据及边界

[同帧前后图、深度差与拒绝掩膜](../output/video-ar-execution-20261002/depth/run-1790921629720/preview.html)使用原视频 10.010s 抽帧与实际 CC 模型。旧版临时读取 `git show 2ce8fc4:src/videoArModelProjector.ts`，没有回退工作区。固定相机/K/观察视角/画幅；99.117m **仅为未核定试验输入**，不是当前项目实际高度。

旧新 SSE 均 1、源 cast 均 700、请求均 0；没有形式冻结每个三角网，仍有 LOD 差异风险。1440000 个屏幕像素中：接受 172556，无观察表面 238244，源视锥外 909454，无源深度 229，首表面拒绝 105354，UV 越界 14163。没有独立可见表面真值，**这些计数不是真实有效覆盖率或遮挡准确率**。红色可能包括正确遮挡、几何误差及 LOD 差异。

两幅深度图统一使用源相机光轴米，差值为纹素中心修正后的观察深度减首表面深度；请求归零只代表加载状态。

**已纠正的归因：**normalOffset 和 polygonOffset 是不同机制，但当前 Edge 在 Cesium 引擎中已因 UA 分支关闭 polygonOffset；合成 SwiftShader 和真实默认 Edge 的原状态均为 enabled=false。factor1.1/units4 只是未生效的默认数值，不能把本机画面变化归因于“关闭偏移”。本次显式禁用、重建实际状态及兼容性断言用于跨浏览器一致性保护；不兼容会报中文错误并停止模型投影，不回退到平面。

## 真实输入与 P3

当前活动视频记录 `111f64c7-062e-4ac5-bc8c-26c27f4374ed`，模型记录 `8bc58629-cf26-45de-986e-086479db11a0`。当前模型可见，估算高程模式、用户现存试算基准 0m，手动校准开启且修正为零，正式 calibrationSessions 为 0。

[真实运行诊断](../output/video-ar-execution-20261002/frame_10.01/runtime-camera.json)通过完整应用原有按钮导出。实际 10.01s 相机采用约 **70.001m**，rawAbsAltitude=99.117m、rawRelativeAltitude=70.001m，K=2560/2560/1920/1080，参考画幅3840×2160。原始 recorded_at 为2026-08-19T16:20:26.572，独立于媒体时间。相机、轨迹及提交纹理对应10010ms；原保存设置逐项一致。高程差29.116m不能直接认定为已知椭球基准。

真实运行等待20.162秒后，model.ready、currentFrameDepth、shaderSourceDepthAccepted均为true，535条source/cast命令，请求队列清零；纹理和相机仍为10.01s。早期未就绪的记录以preload-runtime-*独立保留。实际画面仍有破碎/差异，未分离模型本身与配准/遮挡原因，运行就绪不等于定位达标。

运行图及模型深度就绪的实测范围以 [runtime-README](../output/video-ar-execution-20261002/frame_10.01/runtime-README.md) 和 `runtime-checks.json` 为准。六个正式文件（MP4、轨迹、入口模型、两条record、view）SHA256前后一致；测试只复制小JSON并用隔离浏览器只读映射读取原始媒体/瓦片，没有修改正式数据。

原始 HEVC 在本机 Edge149.0.4022.98 默认 GPU 模式通过 0、10.01、30、60、90、114s 的seek、暂停、RVFC和实际4K图像读取，并通过10.01s后约1.5秒/45帧短段播放。未验证整段115.68秒连续性能，不证明曝光与SRT传感器同步。强制SwiftShader的完整app试验曾出现HEVC解码配置不支持，默认GPU重跑通过；没有换代理视频或改源身份。

| 请求秒 | 原片解码 PTS 秒 | 正式检查点 | RMS/P95/max（1920×1080尺度） | 真实覆盖率 |
| --- | --- | --- | --- | --- |
| 10.01 | 10.01 | 0 | 未测量 | 未测量 |
| 30 | 29.996633 | 0 | 未测量 | 未测量 |
| 60 | 59.993267 | 0 | 未测量 | 未测量 |
| 90 | 89.9899 | 0 | 未测量 | 未测量 |
| 114 | 113.980533 | 0 | 未测量 | 未测量 |

`frame_10.01` 提供原帧、基准及运行相机、空的正式 fit/check 点集、明确缺项的 result。CPU真实叠加图及误差需真实点集；重建工具可立即导出，不能用合成点补齐。0秒天空已解码，但此航次天空区域的真实融合未独立验收；合成GPU验证了无模型/无深度不生成投影平面。

## 验证结果

| 范围 | 结果 | 证据与限制 |
| --- | --- | --- |
| 视频 AR 单元测试 | 71项通过 | `tests/unit-tests.txt`，含相机/K/姿态、高程、稳健求解、独立CPU及纹理身份 |
| 实际 Fusion 方法 CPU 状态 | 5项通过 | `tools/verify-video-ar-frame-state.cjs`，惰性渲染替身验证提交顺序，不是GPU像素 |
| 选点与报告浏览器 | 10项通过 | `tests/controls-result.json`，实际合成模型拾取、确定性配对、错误检查点和保存失败；CPU检查图已视觉核对 |
| 合成模型 GPU | 17项通过 | `tests/model-gpu-result.json`；普通视角285/285可见样本、74遮挡样本无误投；掠射246/248可见样本、38遮挡样本无误投；1824/1275轮廓像素无跨背景外推；402次cast无偏移 |
| 完整应用浏览器 | 17项通过 | `tests/application-result.json`，合成H.264/轨迹；暂停恢复、诊断切换、保存重启、来源隔离、同PTS seek/播放；页面和WebGL错误为空 |
| 原片解码 / 真实相机 | 通过限定项目 | `media/result.json`、`frame_10.01/runtime-checks.json`；不等于地理配准验收 |
| 类型与正式构建 | 通过 | `tests/build.txt`；保留现有bundle大小提示 |

表中 tests 路径位于 `output/video-ar-execution-20261002/`。不得把不同类别测试数量相加后当成真实精度证明。

## 使用与复现

正常运行继续使用 `npm run dev`；已有 localhost:5173 服务无需重复启动。视频AR → 投影配准校正 → 三维投影深度检查，可切换诊断图；“导出当前帧诊断与选点记录”导出实际状态。无模型覆盖或隐藏时不生成楼体摊平的fallback，启用模型使用原有明确按钮。

本机验证命令（项目根目录；脚本隔离资料目录和浏览器，完成后关闭自身服务）：

```powershell
$env:PLAYWRIGHT_MODULE='C:\Users\胡航\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
& 'F:\Node.js\node.exe' --experimental-strip-types tools/verify-video-ar-frame-state.cjs
& 'F:\Node.js\node.exe' tools/verify-video-ar-controls.cjs
& 'F:\Node.js\node.exe' tools/verify-video-ar-model.cjs
& 'F:\Node.js\node.exe' tools/verify-video-ar.cjs
& 'F:\Node.js\node.exe' tools/verify-video-ar-original-media.cjs
& 'F:\Node.js\node.exe' tools/verify-video-ar-real-camera.cjs
& 'F:\Node.js\node.exe' tools/verify-video-ar-real-depth.cjs
npm run build
```

GPU脚本顺序执行，避免显存竞争；原媒体脚本读取localhost:5173原文件。真实深度脚本生成新run目录。各脚本的原始材料路径/记录ID在脚本顶部，没有自动修改源记录。

## 最短补齐步骤

1. 冻结10.01s，确认显示当前模型；选8～12对稳定拟合点，另留至少6对独立检查点，覆盖地面/桥面/楼顶，另以立面点复核。对应同一物理角点，避开水面、车辆、树冠及发生变化的施工部位。
2. 使用“保存当前记录”保存完整配对，固定现有K先求外参，再导出CPU检查图与诊断；检查点不得参与异常点筛选。如果用检查点继续调参，最终另留新检查点。
3. 同一校准原样应用30/60/90/114s，再各取独立检查点。建议目标RMS≤3px、P95≤6px、max≤10px；达不到则报告实值和原因，不逐帧手调冒充全段有效。
4. CPU和Cesium都错，核查配对/相机/模型基准；CPU准而Cesium错，查渲染；多帧同K均出现中心准边缘偏，才进入多帧镜头标定。P0～P3证据足够后才决定P4，不在本轮启动。
