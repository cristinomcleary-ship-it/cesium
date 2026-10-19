# AR 播放与退出资源修复（2026.10.19-R3）

目标分支：`codex/machinery-integration-20261013`。AR 面板显示 `版本 2026.10.19-R3`，配准诊断包含 `runtimeBuild`，用于核对实际加载的版本。本机部署任务见根目录 `CODEX_LOCAL_DEPLOY_AR.md`。

## 播放

视频原生帧直接上传 GPU，与同一 PTS 的 Cesium 图像及标注合成；播放和离线导出不再逐帧创建整幅 Canvas2D 视频副本。只有有标注的时段才建立独立标注纹理。背压只保留一个待完成的视频/相机帧，不再因每次模型或遮挡等待调用 `pause()/play()` 重启解码。未完成时保留上一幅完整融合图，完成后捕获最新的视频帧。

零畸变镜头使用解析映射。有畸变镜头把固定内参对应的 UV 预计算到 float32 纹理，多帧复用；不降低视频分辨率或模型细节，禁用/退出时释放缓存。原生 4K 输出与 CSS 整数尺寸之间的额外像素只用于轻微超采样，不能接受低于目标分辨率的模型图像。

## 退出

Cesium 移除最后一个后处理阶段只会标记纹理池需要更新。普通地图没有后处理时，后续帧可能不再更新该池，AR 的大尺寸纹理和场景 framebuffer 会一直保留。

退出在恢复地图状态和普通画布尺寸后，显式兑现阶段移除、释放闲置场景 framebuffer；地图原有 FXAA/HDR/自定义效果启用时保留效果并恢复其原生尺寸。使用当前锁定的 Cesium 1.144 / engine 26.2 的可重用 FramebufferManager，不销毁用户模型、Scene、Context 或拾取对象。视频 GPU 合成器、镜头映射、临时 CAD、回调、观察器和沿途瓦片缓存分别释放，单项宿主异常不会阻断媒体解绑。

## 验证

- 115 项相关单元测试通过，生产构建通过，账号资源访问回归通过。
- 播放工作流 9 项：同 PTS 配对、遮挡等待、交替就绪状态、解码不被自动暂停、显式 Canvas2D 视频拷贝为 0、反复进入退出。
- 1080p 呈现 6 项：原尺寸与原材质颜色、标注和模型效果、保存恢复、30 帧连续预览、GPU 释放。
- 生产导出 5 项：60 个唯一源帧、固定 30 fps、音轨、延迟回调、取消恢复，以及同目标暂停帧的 6 帧导出边界。
- GPU 合成器 8 项：原尺寸末端单像素细节、透明度、方向、PTS、WebCodecs、WebGL1、CSS/4K 尺寸取整和释放。
- 4K 镜头映射：42 个独立 CPU 反畸变样本的最大几何误差 0.000535 像素；与原 shader 全图比较最大差 1/255 色阶，缓存仅建立一次，销毁后占用为 0。
- 4K GPU 生命周期：测试禁用清理时，退出后仍有 5 张 4K 纹理；清理后大尺寸目标和后处理缓存归零，实际模型拾取、重复退出和原有 FXAA 均通过。
- 本机部署脚本经 PowerShell 解析及 8 项模拟 Git/构建/服务保护测试通过。

在同一 4K 诊断场景中，退出后纹理/渲染缓冲约 208.1/292.6 MB，清理后约 42.0/27.1 MB，释放约 431.7 MB 闲置 GPU 附件。这是 API 分配追踪的诊断值，不是浏览器或显卡驱动的总显存读数。CPU 测量没有复现持续退化，不能据此承诺用户显卡的固定帧率。

浏览器验证使用合成几何与视频，真实现场模型、网络加载和用户 Windows 显卡仍须由本机 Codex 按部署任务验收。用户录屏未提交到仓库。

## 可复现入口

- `tools/verify-video-overlay-workflow.mjs`
- `tools/verify-video-overlay-presentation.mjs`
- `tools/verify-cc-video-export.mjs`
- `tools/verify-video-overlay-gpu-compositor.mjs`
- `tools/verify-video-overlay-playback-lens.mjs`
- `tools/verify-ar-exit-performance.mjs`

这些脚本支持 `PLAYWRIGHT_MODULE`、`BROWSER_EXECUTABLE`、`BASE_URL`、`START_VITE=1`、`OUTPUT_DIR` 等环境变量。退出资源测试默认验证修复，只有显式 `BASELINE=1` 才在测试浏览器中禁用清理模块，复现旧的 GPU 附件残留。性能采样期间不进行整幅像素回读；图像断言在暂停或编码完成后进行。
