# B 批工点工作台实际路由验收

2026-10-09，在既有 `/?screen=safety` 主路由完成一次全新隔离数据库的完整浏览器验收。最终 `report.json` 为 `passed`，28 项断言全部通过，52 张过程截图，2 段实际操作录像。未捕获未处理页面异常。浏览器的 503、409 和账号退出期间 401 日志分别对应失败注入、真实版本冲突和主动退出，不等同于持续页面异常。

## 数据与运行范围

- 服务：`127.0.0.1:5231`，`tools/vite.platform-acceptance.config.mjs`；实际页面、现有唯一 Viewer、原始项目倾斜摄影模型。
- 隔离管理库：`tmp/platform-workpoint-b-20261009/management-r4`；隔离空间台账：同目录下 `spatial`。正式资料库仅供只读加载，浏览器拦截与验收专用服务端守卫共同阻止资料库写入。
- 工点来自先前在真实模型表面绘制、含模型版本与取点来源的验收副本，ID `5b2f6e68-8a1f-434f-8853-71bf00f59bb5`、修订 7；没有自动生成正式工程对象。另 23 个对象只用于布局和搜索压力，名称明确标注“布局检索夹具”。
- 图纸为包内 SVG 渲染的明确标注 PNG 示意夹具；试验报告为隔离业务记录。整改附件是本次真实项目画面截图，并非现场照片。此次业务闭环验证不构成工程验收结论。
- 真实模型资产 `8bc58629-cf26-45de-986e-086479db11a0`，浏览器确认使用 NVIDIA RTX 4080 / ANGLE D3D11；不是 SwiftShader 替代渲染。此次未据录像帧率声称 Cesium 帧率或性能改善。

## 验收矩阵

| 项目 | 实际结果 | 证据 |
| --- | --- | --- |
| 未选择对象时释放右侧空间 | 1920 宽占用中央可用宽度 85.42%；1366 为 80.09%，右空栏隐藏 | `scene-empty-1920.png`、`scene-empty-1366.png` |
| 对象搜索与选择 | 26 个对象检索、显示全部；普通选择保持相机 | `search-object-23.png`、报告断言 |
| 键盘与草稿 | 抽屉 Tab 循环；未保存确认焦点正确；503 后保留输入；刷新同账号恢复文字草稿 | `unsaved-confirmation.png`、`task-save-503.png`、`draft-restored.png` |
| 并发版本冲突 | 第二会话实际修改任务后返回 409；差异面板保留输入并核对后重试 | `revision-409.png` |
| 工点至任务、图纸、材料检验 | 创建任务；资料自动关联该任务；发布固定图纸版本并打开原件；搜索式关联无需输入 UUID；试验报告在同工点可见 | `drawing-published.png`、`drawing-original-fixture.png`、`workpoint-test-report.png` |
| 发现位置留存 | 问题冻结工点 ID、修订、几何 SHA256 和原空间快照 | `report.json` 中“发现时工点及空间修订冻结” |
| 问题完整闭环 | owner 指派；受限执行人登录、上传整改；owner 退回；执行人再次提交；owner 通过；刷新保留两轮和 closed | `worker-submitted.png`、`workpoint-closed-issue.png`、第一段录像 |
| 权限与单一状态 | 执行人复核按钮禁用；其任务图纸原件 HTTP 200；地图事件与管理问题同 ID、同 closed | 报告断言与 HTTP 请求记录 |
| 工点巡检证据 | 同工点可看到已保存项目截图 | `workpoint-inspection-evidence.png` |
| 390 移动端反馈 | 项目、账号、搜索可用；受限账号上传反馈，注入 503 后仍有草稿及附件；重试真实保存，不伪造模型来源 | `mobile-feedback-503.png`、`mobile-feedback-saved.png`、第二段录像 |
| 管理页面响应式 | 6 模块分别核对 1920、1366、390，无文档横向溢出 | `populated-*.png` |
| 125% 等效空间 | 1366×768 的 125% 等效 CSS 视口 1093×614，新增入口可用 | `plan-125-percent-equivalent.png`；不是原生浏览器缩放或 OS DPI 实测 |
| 六轮模块与三维切换 | 仍是同一 Viewer，2 个既有 video 节点数量稳定，引用保持；监听数不增长 | `scene-after-six-rounds.png`、报告 |
| 数据保全 | 3822 个正式 JSON 的前后 SHA256 全部一致，无新增或改变 | `formal-data-preservation.json`；不是全部二进制文件重新哈希 |

监听计数前后均为：`preRender=0, postRender=5, clock=4, cameraChanged=13`。瓦片数随视角变化，不作为泄漏结论；没有通过本轮观测宣称长期内存零增长。

## 实际操作录像与主要截图

全部证据目录：`output/platform-revision-20261009/B/workpoint-ui/`。

- `01-workpoint-business-chain.mp4`：约 100.6 秒，工点、草稿失败与恢复、并发冲突、图纸、材料检验、问题指派、退回、再次整改及复核。
- `02-responsive-and-lifecycle.mp4`：约 31.6 秒，多分辨率管理页面、移动端账号与反馈、三维面板、六轮模块切换。
- 录像由真实浏览器 CDP 帧及采集时间生成；不同视口等比缩放留黑边，编码目标 24 fps 不是场景测量值。转换没有合成业务状态。
- 总览截图：`scene-empty-1366.png`、`scene-empty-1920.png`、`populated-overview-1366.png`；选中工点资料：`scene-selected-1366.png`。

## 工具与重跑

工具为 `tools/verify-platform-workpoint-ui.cjs`；专用资料库只读守卫位于 `tools/vite.platform-acceptance.config.mjs`；图纸夹具位于 `tools/fixtures/platform-ui-drawing.svg`。仅这些工具和本说明属于本验收子任务交付；产品代码改动由 B 批主说明列出。

重跑需要新的隔离管理目录、复制的空间台账以及本机真实模型。设置 `CESIUM_MANAGEMENT_DATA_DIR`、`CESIUM_SAFETY_DATA_DIR` 到隔离目录，设置 `CESIUM_ACCEPTANCE_READONLY_LIBRARY=1`，清除 `CESIUM_DATA_DIR`，以专用配置启动 Vite 5231，再执行 `node tools/verify-platform-workpoint-ui.cjs`。脚本要求管理库为空，不会覆盖现有业务库；账号和业务对象只在该隔离库中创建。不要把隔离目录改为正式业务目录。

## 具体限制

本轮确认的是实际应用路径和完整业务流；没有将示意图纸、隔离试验报告、布局重复对象认作真实工程资料。尚需项目有效图纸与试验报告接入后进行业务内容核对。没有用此轮证明无人机视频配准精度、源网格修复、原生浏览器 125% 缩放或长期性能。这些结论由对应独立验收负责。

首轮发现的提交完成后详情抽屉异步重开竞态已修复并在最终全新库完整复跑通过；早期脚本的等待变量问题、合法禁用按钮被误判隐藏要求已更正，未记作产品缺陷。
