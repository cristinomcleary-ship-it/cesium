# V5 视频漫游接入与数据边界

本模块使用当前页面的 HTMLVideoElement 和同一个 Cesium Viewer。相机只按视频媒体时间采样，不启动独立播放时钟，不改变模型矩阵、用户几何或原始遥测。

## 当前真实资料结论

`output/platform-v5/video-roam-data-audit.json` 由只读脚本使用本机 ffprobe 核对四条已保存录像。四条都是原工程同源录像的保存记录，每条包含 3,467 个实际位置样本：原片 630,987,789 字节、3840×2160、115.682233 秒。资料记录、文件大小、解码元数据与 SRT PTS 均匹配。源时间使用逐点 `video_time_ms` 与 `source_timestamp_ms`，不是从文件名推断。

**当前真实录像的相机漫游仍禁用。** 原数据仅标 `altitude_reference: absolute`，这不等于 WGS84 椭球高；保存设置为 `videoArHeightMode: estimated`，无已核验的起飞点椭球高、源高程转换依据或有效标定记录。`ground_altitude_m: 29.116` 是源资料给出的高度关系，不能擅自当作测量确认的椭球基准。页面应显示“未关联同录像航迹”，并说明“高程基准未知”。原片播放、暂停、进度和现有资料查看继续可用。

源数据虽然包含云台角，但机体姿态缺失，内参由等效焦距估计，镜头畸变与姿态安装关系尚未标定。当前真实资料适配器不输出相机姿态或“视频视角”；将来高程条件满足时只启用 **“航迹跟随 · 无相机姿态”**，保持开启时的世界视向。

## 接入位置

- `src/presentationV5/video-roam.js`：从 V5 包接入的实际运行模块。适配增加帧回调延迟诊断、结束/异常保留最后有效标记，以及独立轨迹/标记显隐；沿用公开 `Camera.setView`，不逐帧排队 `flyTo`。
- `src/safetyVideoRoamData.ts`：只读资料库加载、录像对应关系、时间与高程核验、转换到 ECEF 和媒体秒。失败时不产出可用相机航迹。
- `src/safetyVideoRoam.ts`：用户偏好、减少动态、自动开启、手动退出/重跟、相机控制权、换源及卸载清理。
- `src/safetyVideoRoam.test.ts`：22 项 CPU 测试；合成测试输入只在测试内存中存在，不写工程。

宿主创建一次控制器，并复用已加载播放器：

```ts
const roam = new SafetyVideoRoam({
  viewer: existingViewer,
  video: existingVideo,
  onState: status => dashboard.setVideoRoamState(status),
  canTakeCamera: () => inspectionActive && !drawing && !otherCameraOwner,
  beforeTakeCamera: () => {
    effects.cancelPendingHome();
    stopOverviewCruise();
  },
});

await roam.bind({
  mediaId: selectedMedia.id,
  sourceRecordId: playbackSource.recordId,
  sourceUrl: playbackSource.url,
  generation: playbackSource.generation,
  mediaName: selectedMedia.name,
  reducedMotion: settings.reducedMotion,
});
```

这里的名称表示宿主真实对象，不是新增全局变量或假服务。`sourceUrl` 必须与当前 `video.currentSrc`（尚未选定时为 `video.src`）一致。重复传入同一绑定不重复加载或注册。只在当前巡检上下文绑定；离开先调用 `beforeManualNavigation()`、`unbind()`，换源先解绑旧来源再按新记录绑定，页面销毁调用 `dispose()`。

轨迹、当前位置标记和相机都由这个运行模块使用同一组核验后的 ECEF 坐标、媒体秒和高程转换结果驱动。宿主开启 `showTrack/showMarker`，调用 `setLayerVisibility(track, markers)` 对应原有航迹/标记图层；状态回调中重复传入相同值不会再次发布，避免递归。Workspace 将旧 `SafetySceneEffects.setInspectionContext` 保持为 `undefined`，原始 `device.track` 仅作为来源资料保留，不再重复绘制。缺高程的现有四条录像不会创建这些图元。连续航迹按同一采样缺口/空间跳变阈值分段，绝不跨缺失区间连线；隐藏、重新显示或暂停不改变相机，也不修改原始遥测。

按钮通过 `setEnabled(true/false)` 控制，显示偏好用 `setReducedMotion()` 更新。绘制、对象聚焦、回总览或其他相机功能启动前必须调用 `beforeManualNavigation()`。它不暂停视频、不飞回总览，并记住已有漫游上下文的退出偏好；初次进入尚无绑定的总览不会被当成用户主动关闭。

`getState()` 返回 `available/enabled/active/state/label/message/missing/mode/userWantsFollow/mediaTime/telemetryTimeMs`。按钮选中态使用真实 `enabled`；暂停视频仍可处于开启的漫游模式。`active` 只表示正在前进。状态中的媒体时刻可节流显示，但不节流相机取样。

## 可接受的高度与时间输入

源数据明确声明 WGS84 椭球高（例如 `altitude_reference: ellipsoidal`），或由实际已有测量/坐标转换服务提供下列有来源的资料元数据，才允许归一化。

```ts
record.settings.video.roamVerticalReference = {
  status: "verified",
  recordId: record.id,
  sourceReference: "实际源高程基准名称",
  targetReference: "EPSG:4979",
  evidence: "真实核验记录编号或来源",
  method: "source-offset",
  sourceToEllipsoidOffsetMeters: verifiedOffset,
};
```

另一方法为 `method: takeoff-relative` 与经核验的 `takeoffEllipsoidHeightMeters`，使用真实 `relative_altitude`。这是数据适配合同，不是让日常巡检人员在短表单中填技术参数，也没有为现有记录补造该元数据。只有数值而没有核验来源的旧 AR 偏移、首帧地面估计、固定高度或 0 都不解锁漫游。

时间映射为 `mediaSeconds = video_time_ms / 1000 - configuredOffsetSeconds`；相应 `telemetryTimeMs = telemetryEpochAtMediaZeroMs + mediaSeconds * 1000`。偏移来自该录像已有 `videoArTimeOffset`，原 SRT PTS 已处于视频时轴时未配置偏移为 0。逐点 UTC/PTS 差必须一致，严格递增并覆盖源录像，坐标必须有限。来源不完整或异常样本不被静默删掉后串线。

相邻样本间隙超过 250 ms 时不插值，沿用现有 DJI 回放策略；空间跳变超过 250 m 时也停止，该数值是拒绝异常插值的上限，不代表安全距离。记录范围外不外推。完全缺失的区间或尾部无样本区间显示停止原因，由用户选择有效时间后明确重跟。

## 生命周期与时钟

优先使用 `requestVideoFrameCallback` 的 `metadata.mediaTime`；浏览器不支持时使用 `currentTime` 和媒体事件。倍速只交给视频播放器，不再次乘到遥测时间。暂停/缓冲取消待处理帧回调，暂停时的 seek 仍直接采样一次。旧回调通过代次失效，换源后不能更新新录像的相机。

用户在画布按下或滚轮缩放即退出跟随，视频继续播放；偏好保存在 `cesium-safety-video-roam-v5`，再次播放不重新抢镜头。减少动态阻止默认自动相机运动，用户明确点击后仍可直接同步跟随，未加入平滑滞后或装饰过渡。

同一 Viewer 同时只有一个漫游所有者。已存在 `trackedEntity`、参考变换改变或宿主占用相机会拒绝/停止；退出不修改相机参考系或恢复到旧镜头。`unbind/dispose` 清除本模块的媒体监听、用户输入监听、RVFC/RAF 回调及标记，不销毁 Viewer、播放器或原业务图层。

## 验证及 G13 边界

```powershell
& 'F:\Node.js\node.exe' --experimental-strip-types --experimental-transform-types --import ./tools/test-module-loader.mjs --test src/safetyVideoRoam.test.ts
& 'F:\Node.js\node.exe' --experimental-strip-types --experimental-transform-types --import ./tools/test-module-loader.mjs tools/audit-platform-v5-video-roam.mjs
```

22 项 CPU 检查覆盖 25%/50%/75% 时刻、RVFC 优先和 currentTime 回退、暂停/缓冲/双向 seek、倍速、缺口/越界、姿态短弧插值、退出记忆、减少动态、相机冲突、换源及异步旧结果清理；新增高程偏移与媒体偏移下相机/轨迹/标记一致、原始资料不变、轨迹分段、图层控制及状态回调闭环检查。`video-roam-cpu-tests.log` 仅证明这些控制逻辑；stub 时间推进不等同真实录像暂停 3 秒的 GPU 验收。

`lastFrameTiming` 可在实际有可靠数据时记录媒体帧时间、回调时间、预期显示时刻及 `currentTime` 差。它反映浏览器回调时序，不单独证明摄影配准误差或端到端完全同步。**现有资料缺高程，G13 的真实飞行跟随、三个时刻相机位置和实际同步延迟仍是受阻项，不能写为已通过。** 当前可在实际工程验收禁用说明、原片独立播放及无相机抢占；可靠高程接入后再补实际跟随录像和残差记录。
