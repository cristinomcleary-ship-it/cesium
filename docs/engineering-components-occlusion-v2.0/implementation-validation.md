# 工程构件与独立遮挡：实现及验证记录

日期：2026-11-20。此记录对应本轮实现提交；发布完整 SHA、实际进程、构建哈希和数据完整性由本机部署记录及最终交付消息提供。测试素材、截图和本机路径仅留在本机，不上传公开仓库。

## 依据与版本关系

- 用户参考基线：`1ab7cc2a86fde718ff8393f9ece50f3e476a0eff`。
- 开发前架构、设计和修改计划提交：`41378e058f590cdbc6d71488cb434af32a96a329`；当时只读审查，未声称功能已完成。
- 实际运行、兼容对照及固定回退：`4239fb7709017b530e818f7a88399a89c729a4eb`。实现同时继承该运行版本，未用较早参考基线覆盖已交付功能。
- 发布分支：`codex/engineering-components-occlusion-v2.0`；固定回退分支 `codex/rollback-20261120-4239fb7` 不推进。
- 根工作树原有未提交改动保留；本轮使用独立候选检出。没有复制生产数据库、浏览器资料、模型或现场素材作备份。

## 最终实现

接入已经定位、加载的原 GLB 实例。先核验服务端交付身份、实际 GLB 字节哈希及节点映射，再原子挂接；任何身份不符、取消、权限撤销或迟到请求都不得修改场景。

节点名称、`extras.componentId` 与 mesh 名称对应唯一实体 ID。完整模型覆盖 25,258 个实体与 69 个参考对象；108 个独立单元合计仅 3,551 个实体，全线采用完整 GLB。先验收 A001# 的 6 件与 TN021 的 199 件，再对全线实际模型运行同类像素、拾取及独立深度验证。

“三级”实现为单构件、分组／单元、当前范围全选。显示与遮挡各自保存，组合成四态；参考对象默认隐藏且不能参与实体遮挡。树采用虚拟行；树选中、高亮、相机定位和实际 `scene.pick` 双向对应。全线、A001、TN021 范围切换暂时隔离显示，不覆盖其他范围的保存状态。

使用单独 FBO 和后处理检测面，在 Cesium 1.144 / engine 26.2 中派生原生绘制命令，只改变独立目标的颜色与深度写入。隐藏节点仍可向该目标写深度；正常场景、自深度、拾取及原融合路径保留。独立遮挡语义与交付离线页的颜色／独立深度／橙色检测面一致，没有新增视频 AR 遮挡规则。

独立命令保留节点矩阵、原网格、材质裁剪及 MASK；静态场景复用深度结果，相机、投影、模型矩阵、尺寸、命令资源及动态效果变化时失效。真实 shader 编译失败会清空独立目标，主画面继续渲染，控制器在下一帧关闭检测；用户修复原因后可以明确重试，不会自动反复重启。

状态采用本机浏览器 sidecar，按项目、账号、资料库实例和资产指纹隔离，可导出／导入，不向原模型资料记录或数据库加入字段。关闭拾取、切换编辑工具、AR 挂起、模型删除、权限变化与页面销毁均有资源释放和原节点状态恢复。

## 修改文件与保护边界

| 范围 | 最终文件 |
| --- | --- |
| 目录与独立状态 | `src/engineeringComponents/catalog.ts`、`state.ts` 及对应测试 |
| 控制、树、拾取和生命周期 | `controller.ts`、`controller.lifecycle.test.ts`、`panel.ts`、`panel.css` |
| Cesium 适配与独立深度 | `renderAdapter.ts`、`occlusion.ts` |
| 只读资源服务 | `server/engineeringComponentsAssets.ts`、`engineeringComponentsAssets.test.ts`、`engineeringAssetsAccess.test.ts` |
| 局部工作台接入 | `src/main.ts`、`server/managementStore.ts`、`vite.config.ts` |
| 专项实际运行测试 | `tests/engineering-components-{gpu,browser,workbench}.mjs` 与 `tools/fixtures/engineering-components*.{html,ts}` |
| 既有功能回归与测试环境适配 | `tools/engineering-compatibility-regression.mjs`、`tests/engineering-components-legacy-navigation.mjs`、`tests/engineering-components-road-compatibility.mjs` |
| 说明 | `AGENTS.md` 与本目录文档 |

最终未新增设计阶段的可选 persistence/selection 文件、服务端状态接口或 Cesium 构建替换器：相应逻辑已经在独立模块内完成，无需新增这些接口。视频 AR 产品文件、原回归脚本、依赖声明和锁文件相对实际运行基线均为零差异。

## 真实验证

环境：Windows、Node 24.21、Edge 149、RTX 4080 / ANGLE D3D11 / WebGL2。AR 保留原脚本 SwiftShader 参数，单独记录，不冒充硬件 GPU 验收。旧临建验收改用实际 RTX 4080，保留原纹理尺寸与业务断言。

| 验证 | 实测结果 | 本机证据（相对候选目录） |
| --- | --- | --- |
| 全量 Node 回归 | 1,908 项：1,902 通过、0 失败、6 跳过 | `output/engineering-final-regression/all.json`、`all.tap` |
| 目录／状态 | 14 通过，包含全线映射与批量状态；已纳入全量 | `src/engineeringComponents/*.test.ts` |
| 控制器生命周期 | 13 通过，包含挂起时拒绝变更、失败停用、显式重试；已纳入全量 | `output/engineering-catalog/controller-lifecycle-latest.log` |
| GPU、样板与全线 | 15 项通过：四态、前后检测面、顺序、缩放、剖切、透明外观、缓存失效、真实 shader 失败恢复、A001／TN021／完整 GLB | `output/engineering-components-gpu/report.json`、`summary.json` |
| 构件 UI | 12 项通过，0 页面／控制台／请求错误；真实树、拾取、高亮、隐藏深度、分组、全线、导入导出、刷新、撤销权限和迟到取消 | `output/engineering-components-browser/report.json` |
| 原工作台接入 | 4 项通过，0 页面／控制台／请求错误；原模型绑定、显隐、Esc、刷新恢复、TN021 切换和旧工具退出 | `output/engineering-workbench/report.json` |
| 既有模型／AR／开挖剖切／摄影 | 原放置脚本通过；浏览器 7 + 8 + 7 + 9 = 31 项通过 | `output/engineering-compatibility/compatibility-summary.json` |
| 便道／临建原生产构建脚本 | 10 项通过、1 项旧便道前提失败、2 项未运行；不声称原 13 项全部通过 | `output/engineering-legacy-temporary-works-hardware-final/browser-report.json` |
| 当前设计便道生产构建补充回归 | 6 项通过：转弯／摄影孔洞／陡坎三层实际 GPU 几何、纵坡、独立取高、显隐、保存刷新及摄影矩阵；0 页面／渲染／请求错误 | `output/engineering-road-compatibility/browser-report.json` |
| 严格类型检查 | 通过 | `tsc --noEmit` |
| 最终生产构建 | 通过，Vite 55.35 秒；保留既有大 chunk 与 node:module 外置警告 | `output/engineering-final-build.log` |

6 项跳过为 5 项 Windows 文件符号链接权限限制和 1 项仅 Linux 适用的原生 FFI 检查；目录 junction 安全检查实际通过。未将跳过项计入通过。旧 surface fixture 有一次 favicon 404，全部页面、渲染及原业务断言通过。

旧便道／临建脚本首先遇到原 UI 已存在的折叠菜单；独立测试适配器实际点击 `<details>` 的 summary，不修改产品或原断言。之后摄影孔洞断言在 4239 基线同样失败：采样落到了约 0m 的地球椭球面，两个摄影面点正常。这是合成摄影 fixture 的采样来源污染；测试隔离原地关闭该 fixture 的 globe，保留孔洞必须无高程、4cm 精度及全部业务断言，并用相同条件对照基线与候选。

同一适配器通过原界面选择旧脚本要求的手动高程模式，并以 `Cartesian3.pack` 提供旧测试引用的 `toArray` 等值接口。SwiftShader 的纹理上限 8,192 无法加载原钢筋棚 10,197 像素宽纹理；改用本机硬件上限 16,384 后原资源成功加载，未缩小纹理。刷新像素检查保持同一合成仿真时刻，避免天空随时间移动；原摄影裁剪、像素差小于 8、保存恢复及道路几何断言全部保留。这些测试环境适配没有进入产品代码，也没有改写原验收脚本。

最后三条旧便道用例依赖逐点贴地 `draped` 道路和 `tw-grid` 参数，但实际运行基线已经采用初始高程加设计纵坡的 `designed` 道路，该旧参数永久隐藏；便道表单和实现相对运行基线零改动。因此保留 1 项前提失败和 2 项未运行，不强制填写隐藏字段或删改旧断言。新增独立测试针对当前已经交付的语义，使用相同转弯、孔洞、陡坎输入，完整长度为 50／35／14m，坡度为 2%／0／-1%，路宽 4m，面积为 200／140／56m²。独立复采初始摄影高程、核验实际索引引用的三层外边界 ECEF 顶点，最大坐标差约 `1.05e-9 m`；显隐和刷新像素逐字节恢复，摄影矩阵始终不变。这些补充结果不替代旧脚本的未通过记录。

## 结构、性能与限制

原交付几何工具复算 25,258 个实体、805,322 个三角面，源面恰好出现一次，最大单轴误差约 `3.814695e-6 m`。真实 GLB 前后 SHA、节点矩阵、模型矩阵保持一致。全线不截断构件，不删上部结构，不降低几何精度。

最终独占 GPU 性能数据见本机 `summary.json`，测量对象为相同完整 GLB、相同视角、800×600、预热后各 3 轮 10 帧强制渲染。原生释放后中位 154.15ms／帧，接入但默认关闭 152.06ms／帧（区间重叠，未观察到默认关闭退化），全线显示并启用独立遮挡 333.96ms／帧，约为原生 2.17 倍、约 3 帧／秒。独立深度有明显成本，不将它声称为高帧率全线检测；缓存核查 CPU 24–26.5ms 也不等同 GPU 耗时。这是独立验收场景的测量，不能代替任意生产场景的性能结论。

原包 SHA256SUMS 中 259 项匹配、`Jiashan.skp` 一项不匹配；该期望哈希对应已有 SKB。本轮不改写、恢复或重新导出 SKP；接入依据是已经核验的重构 GLB、构件台账和逐面验证结果。

本机部署沿用原地址、账号及业务数据根，只读挂接原模型包；没有数据库迁移。切换前后核对代码完整 SHA、首页及主 bundle 哈希、运行进程、数据表与资料库摘要、固定回退记录。具体运行身份以实际启动后本机记录为准，构建通过不等于已经部署。

操作入口及四态说明见 [操作指南](operator-guide.md)。
