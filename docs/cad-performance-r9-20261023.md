# R9：CAD 交互性能与失效资源修复

构建标识：`2026.10.23-R9-cad-interaction`。基线为 `0d4e0f7408afd8246538dcb47306c7f3356d80bc`。本记录只包含通用代码行为与合成验证，不包含用户工程资料或其推导数据。

## 修改范围

- CAD 线和面改为按固定 256 m 世界坐标格分批，整实体保留。远处图元不再仅因文件顺序相邻就扩大本地批次的剔除范围；仍保留原每批数量上限，约束待提交缓冲的实体数、顶点数和格数。超过预算时，小尾批按兼容颜色合并，避免高度分散图纸退化成每条线一个批次。贴地面的颜色分组、所有坐标、线宽和拾取 ID 不变。
- 工程模型列表为空时，地图拖动不再触发该编辑器的 GPU 拾取。基坑中心提示全部不可见时，也跳过中心选择的 GPU 拾取；存在可选对象时保持原选择和拖动路径。
- 首次选择 CAD 整体转轴时消除逐顶点临时对象分配，保持同一个最近实际顶点和已保存转轴规则。该扫描仅是首次调整的开销，不能据此解释全部持续卡顿。
- 修复已销毁裁剪资源的恢复边界：只清空 tileset 的引用时，其已加载瓦片模型仍可能引用旧资源。异常恢复现在也清理这些已确认销毁的借用引用，并使旧绘制命令失效；保留存活裁剪、替换所有者及自定义着色器。普通模型同样重建失效命令。此扫描只在错误恢复时执行。

视频分辨率、源帧率、采样精度、播放进度条和相机姿态未作降低或简化。已保存的模型、坐标、标定及融合方案不做数据迁移；更新构建标识使旧融合画面缓存重新校验。

## 验证与限制

| 验证 | 结果 |
| --- | --- |
| CAD 导入、空间分批、倾角、资源恢复、保存／缓存与选择交互 | 最终代码 203 项自动测试全部通过，无跳过 |
| 工程模型放置与拖动 | 独立回归脚本通过；无模型时不拾取，有模型时仍可选择与拖动 |
| 生产构建 | `npm run build` 通过，包含 TypeScript 检查；保留既有依赖外部化及大分包警告 |
| 失效裁剪恢复 | 使用安装版本的 Cesium 更新方法复现残留引用，覆盖普通模型、复合瓦片、存活所有者保护和五轮重复恢复；这不是五轮完整 AR 浏览器验收 |

日志见 `cad-tilt-acceptance/r9/all-tests.txt`、`model-placement.txt`、`build.txt`。可复现命令：

```bash
node --experimental-transform-types --import ./tools/test-module-loader.mjs --test src/cad*.test.ts src/videoOverlay*.test.ts src/cameraNavigationPerformance.test.ts src/foundationPitDisplay.test.ts src/subsurfacePicking.test.ts tests/destroyed-clipping-recovery.test.mjs tests/video-overlay-group-drag.test.mjs tests/video-overlay-cache-signature.test.mjs
node tests/model-placement-regression.mjs
npm run build
```

空间分批测试的合成视锥提交量为 4096 → 128 个源顶点，全部实体保留。它只证明该分布下的剔除工作量变化；广视角下批次数可能增加，不能把它直接换算成现场 FPS。拾取测试只统计调用。另在 Node 24 的同进程 240 万合成点基准中，七次交替测量的中位数从单位矩阵扫描 336.81 ms 降到 71.00 ms，平移矩阵从 321.04 ms 降到 85.92 ms，最近顶点一致；这只衡量首次选择转轴的 CPU 开销，仍可能形成长任务，不代表整页帧率。

本轮环境没有可用浏览器执行文件，因此未完成本版 WebGL 像素验收、真实 GPU 性能对照或连续五次完整 AR 进出。用户电脑上的偶发渲染异常尚无对应堆栈，不能把代码审计中发现的问题直接认定为现场异常原因。上述项目及本机部署均待现场验收。

本机 Codex 按 `CODEX_LOCAL_DEPLOY_CAD_TILT.md` 完成备份、更新、原地址重启、同素材性能对照及异常记录收集。保留所有资料、模型、标定和配置；不要通过清空数据、强制覆盖工作区或降低视频质量通过验收。
