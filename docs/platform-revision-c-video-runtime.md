# C2/C3 主平台视频运行时改造

本说明记录当前实现及 CPU 契约验证。实际项目 GPU 截图、全片统计和独立检查点结论由本批主路由验收报告单独给出。本文件不将 CPU 通过计为配准或 GPU 性能达标。

## 实际入口及文件

保留 `main.ts → VideoArFusion → VideoArModelProjector` 及唯一 Viewer。核查发现原主工作区默认只播放原片，融合面板未启用；本批由主页面提供显式“模型融合试算（未完成标定）”入口，临时启用同一实际 Fusion 实例。主工作区和旧视频面板共享同一个原生视频元素，没有另建播放器或 Viewer。未选择试算时仍为原片播放。

- `src/videoArTextureQuality.ts`：画质档、GPU 边长限制、纹理替换内存预算及同像素约定的 K 缩放。
- `src/videoArPerformance.ts`：独立指标、活动媒体时间统计、有限样本和调度相位。
- `src/videoArFusion.ts`：实际纹理上传、媒体 PTS 调度、公共诊断接口与生命周期。
- `src/videoArModelProjector.ts`：相机/源深度修订及媒体身份可追溯；原首表面算法保持。
- 对应两个新增 `.test.ts`，并扩展 `tools/verify-video-ar-frame-state.cjs` 执行真实方法。

## 公共接口

```ts
fusion.getTextureQuality();
fusion.setTextureQuality('clear'); // 可选 economy / clear / inspection
fusion.setModelPreviewActive(true); // false 恢复试算前设置
fusion.getProjectionFps();
fusion.setProjectionFps(24); // 可选 8 / 12 / 18 / 24
fusion.resetPerformanceMetrics();
fusion.invalidateProjection(reason: string);
fusion.getDiagnostics();
```

主页面临时试算保存原投影表面、启用状态和目标帧率。退出或切换素材时恢复；运行诊断与可保存的回放参数分开，临时 model/FPS 不写回原录像。质量档是用户设置，可以持久化。试算不提供可靠高程或实测标定缺项，不绕过现有校验，也不自动显示隐藏模型。

`getTextureQuality()` 明确分开：

- `source`：实际解码画幅；`planned`：按档位、设备及预算计算的目标。
- `canvas`：当前 CPU 上传画布；`gpuAllocated`：仅从已就绪的实际 Material 纹理读取，未分配时为 null。
- `currentFrameUploaded`：当前媒体身份与已上传身份一致，并且 GPU 和当前画布尺寸一致。
- `uploadedToPlannedDimensions`：实际 GPU 尺寸是否已达到目标尺寸；不以目标值假充上传结果。
- `uploadedFrame`、分配/复用计数、`lastReplacement.previousDestroyed`：查看实际像素身份和 Material 替换时的旧纹理释放状态。
- `estimatedGpuBytes` 仅为 RGBA 纹理字节估算；无法从浏览器直接量到的 `measuredGpuBytes` 固定 null，不声称整机显存占用。

清晰档长边 1920，节能档 1024，暂停精查使用原画幅。精查播放时按清晰档上传。均不放大低分辨率来源。默认 64 MiB 预算为替换过程中原/新两份 RGBA 纹理之和，不是整场景显存预算。GPU 最大边长不可读时保守使用 1024，并给出原因。

模型投影 K 随实际纹理宽、高分别缩放；原 `ResolvedCameraFrame` 保留原始像素 K。两者均沿用 `UV=(fx*x+cx)/width` 的图像边界坐标约定，不引入新的半像素偏置。畸变系数和工程坐标保持。

## 同帧及调度

- `requestVideoFrameCallback` 采用其媒体 PTS，并以原生 `video.paused` 判断主工作区播放状态。
- 模型深度路径按所选 8/12/18/24 FPS 目标处理媒体、姿态和纹理；相位调度避免 30 FPS 源在简单 41.7 ms 节流下退化为 15 FPS。
- CPU 地形射线和控制网格仍使用 4 FPS 几何预算；原实时流解析/几何节流未修改，缺真实直播输入时未进行直播性能验收。
- 相机提交仍要求 `sourceSession/kind/frameKey/PTS` 一致及相机媒体时间校验。源深度同时要求当前 Cesium 帧、非空投射命令、完整请求状态及相机修订相同。
- 暂停、seek、倍速及外部模型/项目失效会撤销未提交候选；源文件切换保留原来的 generation 校验。缺可靠配对或深度时不启用错误投影。
- 源深度 0.35 m 首表面阈值、观察表面连续性、无模型不回退成建筑表面的规则未放宽。
- 可见但无关模型的请求是否阻断投影尚未独立复现，因此本次没有缩小原保守加载判定范围。

## 指标解释

`getDiagnostics().performance` 分别记录：

1. `decodedFrameCallbacks`：RVFC 可用帧计数，不宣称硬件内部解码器吞吐。
2. `pairedCommits`：通过身份校验的相机/纹理配对，不宣称已绘制像素。
3. `renderedProjectionFrames`：postRender 时模型深度通道已就绪的唯一媒体帧；仍不代表独立量测的有效表面覆盖率或配准精度。
4. `cesiumRenders`：Cesium 渲染频率。

每项提供累计/活动计数、活动期间平均 FPS、P95 间隔、最长间隔。暂停和 seek 的非播放时间不计入活动时长。间隔每流最多保留 20,000 个，超出后明确标记截断。浏览器原生丢帧计数、RVFC 回调缺口、同帧守卫拒绝和失效原因分别展示。配对组装过程中等待新纹理也可能触发守卫拒绝，不能将这类计数直接称为“画面已出现错帧”。

正式整段测试应在隔离会话原片 0 秒开始前调用 `resetPerformanceMetrics()`。已有保存设置中的 12 FPS 会被保留；24 FPS 是目标，测试时须显式选择并报告实际值。零有效投影必须记录为零；未量测精度保持 null。

## 验证与限制

已执行：

```powershell
$videoTests = Get-ChildItem src/videoAr*.test.ts | ForEach-Object { $_.FullName }
node --experimental-strip-types --test @videoTests
node --experimental-strip-types tools/verify-video-ar-frame-state.cjs
node node_modules/typescript/bin/tsc --noEmit
```

2026-10-09：86 个视频相关 CPU 测试通过，9 组真实方法状态回归通过，类型检查通过。日志为 `output/platform-revision-20261009/C/video-runtime-cpu-tests.log` 与 `video-frame-state.log`。包括本次 9 个画质/计数/调度契约，以及旧上传失败、跨源同 PTS、暂停恢复、实际 K/高度/控制点回归和主工作区临时试算参数不污染持久档案。测试均不改变正式模型、原片、业务台账或校准值。

源轨迹声明只按原值导出至 `sourceMetadata`，缺失为 null；身份/时间线匹配使用现有实际校验结果。声明来源不等于可靠高程或相机实测标定。当前 CPU 结果不能解决独立检查点、可靠高程、实测 K/D 或安装关系缺项。

只读 `captureTextureEvidence()` 仅在暂停、无寻址/待刷新/上传事务且当前源会话与 PTS 已实际上传时，导出实际上传使用的 CPU canvas PNG、完整画质诊断及帧身份。播放中、像素待上传或身份不一致返回 null；不会暂停/寻址或写入工程数据。这是 CPU 上传输入证据，并非 GPU 帧缓冲回读，也不单独证明模型表面配准或深度覆盖。
