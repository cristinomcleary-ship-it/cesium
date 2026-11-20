# Cesium 工程构件管理与独立遮挡 V2.0：第一阶段架构审查

审查日期：2026-11-20。状态：**只读审查完成；产品开发、Cesium 样板验收及部署尚未开始。**

本文件与 [技术设计](technical-design.md)、[修改文件与验收清单](change-and-validation-plan.md) 一起交付。用户本轮消息是已取得的要求；用户随后再次提供同一完整任务消息，因此按该消息作为本轮任务书执行。结合其中“单构件、分组和全选”，本轮将三级实现为单构件、分组/单元、全工程三个控制范围，分别控制显示与参与独立遮挡。

## 1. 仓库、远端与运行身份

| 对象 | 本轮核实结果 |
| --- | --- |
| 仓库 | https://github.com/cristinomcleary-ship-it/cesium |
| 当前工作目录分支 | codex/local-function-centers-deployed-20261109 |
| 当前工作目录 HEAD | `c697c0d0443af779329275a898383f68c4ab96a8` |
| 工作目录状态 | 15 个已跟踪文件修改，另有未跟踪文件/目录；未清理、覆盖或暂存 |
| 用户指定开发分支 | codex/engineering-components-occlusion-v2.0 |
| GitHub 实时解析的开发分支 HEAD（报告提交前） | `1ab7cc2a86fde718ff8393f9ece50f3e476a0eff` |
| 参考基线 | `1ab7cc2a86fde718ff8393f9ece50f3e476a0eff`，本机 Git 对象和 GitHub 均存在 |
| 本机当前源码 HEAD | `4239fb7709017b530e818f7a88399a89c729a4eb`，独立检出目录干净 |
| 实时 HTTP 身份 | `http://127.0.0.1:5289/__acceptance/identity`，返回相同运行 SHA、PID 39968 |
| 运行首页 SHA256 | `a799388118fea840f4f2dcb52640c5e5518007fa8243fc71b03e67910c383c37` |
| 已记录固定回退点 | `codex/rollback-20261120-4239fb7`，完整 SHA 同上；发布前还须再次实时核实远端 |
| 曾撤回的候选 | `a4bb9452ade7654f26032e5e7c97d6662a5ba161`，不作为可用成果或通过依据 |

运行版本相对参考基线增加/修改 86 个文件，7,844 行增加、337 行删除，包含摄影位置编辑、场景效果协调、裁剪挂起恢复、异步资料恢复和安全边界修复。直接把旧参考基线加上新功能部署，会丢失现有能力。

因此本轮保留参考基线用于追溯，实施候选必须累积保留当前实际运行版本。报告本身只在指定开发分支增加文档；后续代码集成应明确纳入已运行的 4239fb7 历史，不能强推回退点或复制失败候选。本轮对视频 AR 的零修改约束以实际运行版本为比较对象，不能通过改用旧版本间接撤销已运行修复。

## 2. 模型包与离线网页：已实际读取、运行核验

输入为 `Jiashan_Rebuilt_v2.0` 和 `Jiashan_Offline_v2.0.html`。原件留在本机原位置，不上传现场素材。

| 项目 | 本轮实测 |
| --- | --- |
| 台账 schema | `jiashan/component-library/2.0` |
| 物理实体 / 参考几何 / 组 | 25,258 / 69 / 2,121 |
| 全线 GLB | 33,238,408 字节；27,449 nodes，25,327 meshes |
| ID 映射 | mesh 节点的 node.name、extras.componentId、mesh.name 与台账对应，0 错配 |
| A001# 墩 | 6 件：4 根桩、1 座承台、1 根墩柱 |
| TN021 | 199 件：5 件主体与 194 件轨道 |
| 独立包 | 108 份，逐包 SHA256 和 structure.json 成员对应通过；合计 3,551 件 |
| 全量几何核验 | 实际执行包内 verify_geometry.py，805,322 三角面，所有源面恰好使用一次 |
| 最大单轴误差 | `3.814695318737904e-6 m`，满足包内核验断言；不是本轮重新制定的工程容差 |
| SHA256SUMS | 260 项中 259 通过，1 项不一致，详见下文 |
| 指定离线页与包内 index.html | SHA256 均为 `3e825c95f265fc856f041933a7ac28cb06a815275b4452d38999363d0462af71` |

**输入差异：** `models/Jiashan.skp` 当前 SHA256 为 `6c184181e7b0f19575ffdcef36bf7849841b18db1cd594001341891acd0afbb4`，清单期望 `964e89f456576eff337fa9f1315e2866b03c1e6d74f7a1e72e8cdd452ef9d360`；现有 `Jiashan.skb` 恰好匹配期望值。仅据此不能判断修改原因、实际几何是否变化或应恢复哪个文件。本轮没有替换、重存或修复原件。接入候选以已通过核验的交付 GLB 和构件台账为依据，不宣称整个模型包哈希一致，也不从变更后的 SKP 再导出几何。

**全线接入不能只遍历 108 个独立包。** 它们不覆盖大量上部结构实体；全线须以完整台账和全线 GLB 为覆盖基准。全线与单元副本还须按资产版本、实例和 componentId 防止重复绘制。

### 2.1 映射与结构语义

`components.json → components[].id` 是实体 ID；`groups[].parentId` 定义唯一树父级；`unitId` 定义独立单元范围。附属分类与单元成员集合不是同一概念：TN021 的轨道位于附属分类，但必须随 TN021 的独立单元操作。

GLB mesh node 通过 `node.mesh` 指向 mesh，再指向 primitives。同一 componentId 可以对应多个 primitive；不能以 primitive 序号当 componentId。桥墩独立包与其相关梁、支座的关系清单也不能混为包内成员。

几何采用米制、工程 Z 向上，含交付的刚性轴向变换；高程仍是原工程高程。源包明确未增加地理配准。接入应复用核实后的既有模型定位，保留原始顶点、面序、节点局部矩阵与实例关系，不能自动居中或再次错误旋转。样板部署前必须核对所关联场景实例与真实地理位置；正确 ID 映射不等于正确地理配准。

### 2.2 离线实现的真实范围

离线页分别保存 `vis` 与 `occ`。构件拾取用第三个 pass 把实体索引编码为颜色，反查同一 ID 表；树祖先与单元范围分别计算。

遮挡流程是：先绘制颜色场景，再清空深度，仅将 occ 构件写入深度，最后绘制橙色检测面。隐藏实体因此能遮挡检测面。它没有证明 Cesium 摄影、便道、临建或 AR 的相同功能已经成立。不得把离线页的历史验证或本轮源码审读记作本轮浏览器/GPU 功能验收。

## 3. Cesium 现有架构与缺口

以下行号以明确版本为准。

| 现有职责 | 实现证据 | 本轮缺口/约束 |
| --- | --- | --- |
| 新模型加载 | 参考基线 src/main.ts:2714；运行版 src/main.ts:2823 | Model.fromGltfAsync 加整 GLB，id 为 engineeringModelId，没有导入构件索引 |
| 资料库恢复 | 基线 src/sceneLibrary.ts:375；运行版 :515 | 恢复整模型矩阵/外观/显隐，无构件台账挂载生命周期 |
| 整模型编辑 | src/modelEditor.ts:83、:337 | 选中 engineeringModelId；构件点击不能自动进入平移/旋转 |
| 场景显示 | src/sceneDisplayPanel.ts:118、:363 | 单资源、分类、个人分组批量显隐，属于资源级管理 |
| 显示状态容量 | src/sceneDisplayStore.ts:12、:63 | MAX_ITEMS=5000，不适合直接塞入 25,258 个构件；不能靠放宽原限制解决 |
| GLB 节点拾取 | engine/Source/Scene/Model/PickingPipelineStage.js:109–134 | detail 含 runtime node/primitive，可经受约束适配器反查；属于版本敏感结构 |
| 节点名字映射 | ModelSceneGraph.js:435–439 | getNode(name) 的内部名字表会覆盖重名；需验证唯一性及所属实例 |
| 节点隐藏 | ModelNode、ModelSceneGraph | 隐藏停止提交 draw command，子节点也受父节点显隐影响 |
| 普通模型颜色透明 | Model.js | alpha=0 不能代替独立深度绘制 |
| 便道/临建/硬化裁剪 | src/temporaryWorksClipping.ts:190、:355 | 现有摄影 clippingPolygons 的所有权和合并语义，不是构件深度系统 |
| 地表编辑 | src/surfaceEditScene.ts:310、:353 | 补面、摄影及地形裁剪、有事务和挂起恢复；必须保留 |
| 场景接管 | 运行版 src/sceneEffectsCoordinator.ts:22、:49；main.ts:1402、:1716 | 现有 AR 获取/释放场景效果租约，新模块须在已有协调点登记，无需改视频模块 |

依赖锁定为 Cesium 1.144.0、@cesium/engine 26.2.0。必须读取实际嵌套依赖，而不是假设顶层目录。实现若依赖内部命令，需集中适配、校验依赖与目标模块指纹，升级不匹配时拒绝启用新增能力。

## 4. 遮挡的主要技术障碍

1. `Model.show=false`、`ModelNode.show=false` 和零透明度不能同时实现“颜色隐藏、仍参与独立深度”。
2. 仅设置 `colorMask=false, depthMask=true` 不是完整方案。Cesium 的 GLOBE、CESIUM_3D_TILE、OPAQUE、TRANSLUCENT 有既定顺序；工程 opaque 命令晚写深度，不能撤销已写的摄影颜色。还须处理倒序加载与分视锥。
3. 把隐形深度注入主场景会改变 pickPosition、地表采样、模型放置与外部裁剪的观测，必须隔离。
4. 可见但不参与“独立遮挡”的构件仍需正确的自身表面遮蔽；不能简单对全部颜色命令关闭深度。
5. 全线原始模型有数万个节点。每个构件新建一份 Model 或每帧重建深度代理会带来明显资源风险，需先测样板再定全线资源预算。
6. 被撤回候选的工程遮挡在视频专属管线内，涉及视频模块，不能复制成地图方案，也不能当作本轮验收证据。

## 5. 审查结论

现有分解 GLB/索引具备构件管理接入基础，A001 和 TN021 样板数据完整。现有 Cesium 平台还没有这套构件级管理与独立遮挡；需要独立的台账、状态、树和渲染适配。

三级按用户消息中的单构件、分组、全选落实。独立遮挡继承指定离线页的独立深度语义，并在 Cesium 中明确验证目标和效果；既有摄影、便道、临建仍保留正常深度与裁剪。样板需证明隐藏源对其后的实际受挡几何有效，不能仅凭UI状态通过。

本阶段未修改产品源码、视频 AR、模型原件、业务库或运行启动链；未执行新增功能浏览器验收、未构建候选、未切换部署。

参考资料：包内 README_CN.md、docs/Model_Web_Mapping.md、实际 GLB/JSON/离线页与锁定引擎源码；官方 [ModelNode](https://cesium.com/learn/cesiumjs/ref-doc/ModelNode.html)、[Model](https://cesium.com/learn/cesiumjs/ref-doc/Model.html)、[CustomShader](https://cesium.com/learn/cesiumjs/ref-doc/CustomShader.html)。官方在线文档只作接口参考，版本敏感结论以本机锁定源码和后续真实 GPU 验证为准。
