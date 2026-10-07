# 邻近营业线施工安全巡检大屏交付

交付日期：2026-10-07。原版基线：`6c8785850919cb0227d3f5416aeb6032f3c6f86a`。开发分支：`codex/railway-safety-dashboard`。

## 启动与使用

在项目根目录运行：

```powershell
pnpm install --store-dir .pnpm-store
pnpm dev --host 127.0.0.1
```

打开 <http://127.0.0.1:5173/?screen=safety>。已有依赖时直接运行第二条即可。Windows 可双击根目录的 `启动安全巡检大屏.cmd`，它复用已有本机服务，或在后台启动服务后打开浏览器。启动日志及 PID 位于 `output/safety-dashboard/`。

原工作台地址仍为 <http://127.0.0.1:5173/>，顶部新增“安全巡检大屏”入口。大屏右上“原有工作台”返回之前的功能页；右侧“视频 AR 设置”进入原有视频投影、标定和参数界面。

建议操作路线：项目总览 → 左侧区段 → 墩组 → 构件；也可点击右侧任一演示告警，自动定位对应 CAD 锚点、显示选中光圈、更新详情，并展示项目原视频及 CAD 资料。上方路径逐级返回。鼠标点击环图筛选风险等级，点击趋势点筛选时段；两者与列表和场景共用筛选状态。

底部支持历史回放、时间范围、两种显示模式、自动巡游及图层开关。默认关闭热力；在“图层”开启“隐患热力”并调整透明度。绿色实际航迹与展示连线分开控制。正式业务未接入时，可取消右侧“含演示”，查看真实资料范围。

## 实现范围

| 部分 | 本版实现 |
| --- | --- |
| 原平台 | 沿用 TypeScript / Vite，Cesium 1.144.0，一个 Viewer；原模型加载、CAD、GIS、影像、视频 AR、资料持久化保留 |
| 界面 | 深蓝主题、顶部导航、左右面板、中央可操作场景、底部工具与时间轴；1920×1080 和 1366×768 实测 |
| 图表 | ECharts 6.1.0 按需引入，趋势和环图；图表、列表、场景使用同一 Store |
| 场景 | 区域展示板、独立发光边界、设备光圈/光柱、扫描、流动示意线、热力、实际分段航迹、选中光圈 |
| 镜头 | 地球、项目、区段、墩组、构件导航及自动巡游；近景以已加载表面高度辅助取景，不改工程坐标 |
| 两种模式 | 汇报展示使用装饰效果及影像色调；现场巡检恢复原影像色调并降低装饰强度；数据、编号、坐标共用 |
| 媒体 | 复用原无人机 video 元素及解码源；匹配媒体记录后按原始媒体时间映射实录航迹；返回原 AR 时保持其既有同步策略 |
| 工程保护 | 大屏开启期间暂停原模型拖动、测量和标注拾取；退出时释放本次交互锁、恢复原页、影像样式和视频节点 |
| 生命周期 | 覆盖层集中管理；一个共享 Cesium 时钟监听；时间更新不重建图表/热力纹理；销毁移除覆盖层、监听器、Observer 与图表 |

新增核心文件为 `src/safetyTypes.ts`、`safetyData.ts`、`safetyStore.ts`、`safetyDashboard.ts/.css`、`safetySceneEffects.ts`、`safetyWorkspace.ts/.css`。原文件仅增加入口、生命周期桥接、资料库活跃视频的只读 getter，以及原播放器的只读来源与时间同步方法。大屏代码和图表按需加载。

## 真实样板与未接入数据

当前读入“兴善公路主线中心线.dwg”、已有 Production_2 倾斜摄影，以及活跃无人机原片和 3467 个轨迹采样。146 个点位是原图 TEXT 编号的插入点，4 个区段、19 个墩组为展示分组；它们尚未经过正式施工区段和桩中心测量核对。

完整验证链为：**真实 13-1 CAD 文字锚点 → 演示告警定位和选中光圈 → 详情/整改示例 → 项目级真实无人机视频与 CAD 原图**。当前没有正式 BIM 构件 feature-ID 映射，盖梁、墩柱、承台为逻辑节点。不能据此宣称已实现真实构件网格的业务绑定，也不能据此认定视频帧包含选中构件。

当前 6 条告警、6 个任务及整改内容均标明演示；无人机状态为历史回放。真实营业线中心线、限界、正式区段红线、在线设备和正式业务接口尚未提供，页面不会绘制猜测的营业线。

生产接入需要：

1. 正式营业线、施工区段、里程和安全限界，附坐标系及高程基准。
2. 构件唯一编号、CAD 与模型 feature-ID、业务台账的映射。
3. 实际设备状态、告警、巡检任务、整改验收接口与必要凭据。
4. 构件照片、对象专属视频、图纸和资料索引。
5. 坐标转换控制点，以及分别用于模型清晰度、视频配准的独立验收资料。

详细替换接口及数据语义见 [数据接入契约](safety-dashboard-data-contract.md)。展示性厚度不回写工程模型；CAD、3D Tiles 的原变换、尺寸及高度不被视觉效果修改。**模型清晰度与无人机视频配准仍独立待验，本次大屏改造不将它们记为已解决。** 云雾转场按任务约定留作后续增强。

## 验证与证据

所有会写入工程资料的浏览器测试均使用隔离数据目录，或在真实项目验证中拦截全部 `/__library/` 写请求。真实项目测试前后逐一校验 `view.json` 和所有 `record.json` 的 SHA-256，结果未改变。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 原版启动基线 | 一个 Viewer、原片可解码、页面错误 0 | `output/safety-dashboard/baseline.json` |
| 生产构建 | `pnpm build` 通过；仍有大型 bundle 的体积提示 | `output/safety-dashboard/build.log` |
| Node 回归 | 112 项通过，含 18 项数据适配/筛选测试 | `output/safety-dashboard/node-tests.log` |
| 真实大屏端到端 | 16 项通过，页面/控制台错误均 0，原资料哈希一致 | `output/safety-dashboard/integration-report.json` |
| 生命周期与原功能恢复 | 7 项通过：提前打开、总览/沙盘恢复、关闭媒体后的隔离、鼠标拖动/滚轮、模型矩阵不变 | `output/safety-dashboard/lifecycle-report.json` |
| 独立 UI | 16 项通过；200 次时间更新不重建图表/视频节点 | `output/safety-dashboard/ui-report.json` |
| 独立特效 GPU | 25 轮切换计数稳定；销毁后覆盖层与处理器清零 | `output/safety-dashboard/effects-smoke-report.json` |
| 原 CAD GPU | 30 项通过：POINT 隐藏、圆/编号保留、缩放与遮挡等，DPR 1/2 | `output/cad-display-regression/result.json` |
| 原资料持久化 | 12 项通过，模型/CAD/影像/视频恢复、重启与错误重试 | `tmp/persistence-browser-1791338793507/result.json` |
| 原完整视频 AR | 19 项通过，页面/WebGL/GPU 错误均无 | `tmp/video-ar-browser-1791338919667/result.json` |

真实整合测试覆盖层级导航和返回、告警定位/详情/媒体、风险和时间筛选、鼠标点击图表、热力和原工程图层、4K 原视频播放、回放末端停止、地球返回、巡游、原 AR 恢复、20 次工作台切换和小屏地图操作。

本机测试环境：Windows / Edge 149，NVIDIA RTX 4080，1920×1080、DPR 1；另验证 1366×768。性能数值以 `integration-report.json` 为准，包含大屏首次可用时间、四次层级飞行时间与 20 次切换的回收后 JS heap。本轮大屏首次可用 8.48 秒，四次层级飞行合计 7.86 秒；20 次切换期间实体保持 282、图表 2、共享时钟监听 1，GC 后 JS heap 从 146.99 MiB 到 149.04 MiB。上述循环未见实体或监听器累积，但不等同于长期无泄漏。首次基线与大屏测量口径和缓存状态不同，不能据此宣称加载加速。报告中的 rAF 间隔只是无头浏览器回调节奏，不能作为生产 FPS。后续应在实际值班终端、大屏分辨率和业务数据规模下继续压力测试。

截图：

- [项目总览](../output/safety-dashboard/dashboard-overview-1920.png)
- [区段视图](../output/safety-dashboard/dashboard-section-1920.png)
- [13-1 点位业务联动](../output/safety-dashboard/dashboard-alert-13-1.png)
- [现场巡检模式](../output/safety-dashboard/dashboard-inspection-1920.png)
- [1366×768 布局](../output/safety-dashboard/dashboard-1366.png)

复验命令：

```powershell
pnpm build
node --experimental-transform-types --test src/*.test.ts server/*.test.ts tools/*.test.cjs
# 启动普通 dev 服务后执行；需要已安装 Playwright 或设置 PLAYWRIGHT_MODULE。
node tools/verify-safety-dashboard.cjs
node tools/verify-safety-dashboard-lifecycle.cjs
node tools/verify-cad-display.cjs
node tools/verify-persistence.cjs
$env:VIDEO_AR_TEST_PORT = '5189'
node tools/verify-video-ar.cjs
```

真实大屏复验脚本包含本次资料快照的数量断言（227 节点、3467 航迹点），工程资料变更后应按新的经过核对的快照调整断言；不能通过删除断言掩盖缺失数据。
