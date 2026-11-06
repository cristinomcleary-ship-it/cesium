# 设计便道、场地硬化与亮度调节：验证记录

日期：2026-11-06。开发基线 `19b150b3fa7c040a6ab4954ce7827efe4c25aec3`；分支 `feature/designed-roads-hardening-lighting`。本分支在独立工作树实现，原工作树、原方案和私有模型未被覆盖。

**代码验证已执行；真实场景验收尚未完成，本记录不构成正式部署通过。** 使用 Node.js `v24.22.1`，锁定 Cesium `1.144.0` / Engine `26.2.0`。实现、资源接入、部署整合和回退方法见 [设计与部署说明](designed-surfaces.md)。

## 检查命令与范围

下列路径可替换为本机独立的输出目录，不能指向业务存储或原模型目录。

|命令|结果|
|---|---|
|`node node_modules/typescript/bin/tsc --noEmit`|通过，exit 0|
|`npm run build`|通过，exit 0；执行 tsc 与 Vite，Vite 46.27 秒。保留既有大分包及 libredwg 浏览器外部化提示|
|`node tools/run-temporary-works-regression.mjs all --output output/designed-surfaces-verification`|通过，174 个测试文件、1420/1420 项；0 失败、取消、跳过；73.825 秒，exit 0|
|`node --test tools/temporary-works-assets/geometry-signs.test.mjs tools/inspect-video-ar-recovery.test.cjs tools/validate-platform-ar-checkpoints.test.mjs`|通过，43/43 项；0 失败、取消、跳过；3.944 秒，exit 0|
|`git diff --check`|通过|

同环境、未修改的 `19b150b3` 工作树主回归为 166 个文件、1309/1309 项通过，0 失败/跳过。新结果包含原主套件及新增回归，不能将两个测试数相加。执行时长受进程负载影响，不用测试套件耗时宣称浏览器变快。

集成首轮曾有 9 个失败：旧 fixture 缺少新增状态字段，以及设计便道替换原贴地入口后的断言差异。补齐 fixture，保留历史存储、删除失败、旧方案恢复等断言，增加新行为覆盖后，冻结应用源码重跑得到上表结果；没有跳过这些失败项。

## 新增覆盖

- 便道：明确起点顶高、平坡、正负分段坡、无效或不连续坡段、关闭时忽略但保留无效草稿、CAD 弧长因子、反向后空间高程保持、向下结构厚度、真实投影外环/孔洞、取消、预算和 Worker 传输。新生成路径返回 0 摄影采样。
- 硬化：凹边界、孔洞、多区域布尔差集、完全覆盖、同高及异高、道路内部坡折峰值、共享侧壁分段、高差授权依赖失效、未知地坪拒绝、源记录保留和稳定优先顺序。
- 占地与摄影遮挡：加载未完成、启停、显隐、删除、取消编辑、只关遮挡、替换预览、异步保存时邻居变化、局部重算失败、超复杂裁剪预算以及其他所有者/外部裁剪保护。
- 亮度：50%～200% 参数、统一与独立绝对值、本地偏好恢复、只更新材质参数、取消编辑恢复、独立保存亮度不重载模型、存储失败和资源释放。Shader 与模型生命周期测试不能证明 GPU 实际画面正确。
- 原主套件：机械管理、铁路安全、场景目录、CAD、项目资料、存储、视频等现有测试一并执行。

合成微弯路线例：200 个中心线点、1165.773124602 m，生成 606 顶点、804 三角面、400 点实际外轮廓、0 摄影取高。它不是用户现场路线，不能作为原现场报错已修复或地形已经接顺的证据。

## 附属脚本

主运行器枚举 `src/`、`server/`、`tests/` 中 `.test.ts` / `.test.mjs`；普通独立脚本及 Python 另行统计。本轮重新执行如下检查，未修改这些业务代码或为消除既有错误而改写测试。

|实际命令|结果及原因|
|---|---|
|`node tests/business-display-delete-regression.mjs`|exit 1；fixture 找不到 railSafety 记录，设置 `definition` 报错|
|`node tests/management-snapshot-access-regression.mjs`|exit 1；`records[0].id` 的记录为空|
|`node tests/scene-library-pos-regression.mjs`|exit 1；fixture 缺 `deleted`，调用 `.has` 报错|
|`node tests/video-overlay-access-regression.mjs`|exit 1；fixture 缺回调，并存在显隐恢复断言失败|
|`node tests/video-overlay-deferred-frame-regression.mjs`|exit 1；fixture 缺 `spatialAnnotations`，调用 `.some` 报错|
|`node tests/model-placement-regression.mjs`|exit 0|
|`node tests/video-overlay-autosave-regression.mjs`|exit 0|
|`node tests/video-overlay-cache-boundaries.mjs`|exit 0|
|`node tests/video-overlay-manifest-cancellation.mjs`|exit 0|
|`node tests/video-overlay-status-regression.mjs`|exit 0|
|`python3 -m unittest discover -s ar_v2/tests -v`|exit 1；11 通过、5 错误，缺 `cv2`|
|`PYTHONPATH=video_ar_backend python3 -m unittest discover -s video_ar_backend/tests -v`|exit 1；85 通过、3 错误、4 个 Windows 专用测试跳过，缺 `paho` / `cv2`|

10 个独立 Node 脚本共 5 个通过、5 个失败；上述错误类型与既有报告一致，本轮未另行重跑其 v1.2.0 基线。Python 采用 `3.12.14`；导入失败模块的内部用例未完整发现和执行，不把错误占位条目当成完整用例数。不能因此称全仓全部通过。

本轮代码内容指纹和完整主测试文件 SHA-256 清单见 [验证清单](designed-surfaces-verification.json)。该指纹包含 32 个本轮修改/新增的应用源码、测试及依赖文件，不包含文档、构建产物或私有资源。

## 未完成的验收

|项目|状态及原因|
|---|---|
|真实 GLB 的明亮程度、颜色和文字逐面检查|未完成 GPU 验收；保留私有 R2 资源，没有以合成样块替代真实模型结论|
|真实摄影中的便道、硬化及三重重叠|未完成；没有取得可执行的真实摄影联合验收环境|
|浏览器操作与截图|未完成；本地 Chromium 启动受 socket 权限限制，隔离验证页的浏览器访问也未能完成；本轮无有效场景截图|
|用户电脑固定基线的帧率、输入响应和显存/内存恢复|未测；Worker、局部更新及预算属于代码措施，不能冒称无卡顿已验收|
|用户 Windows 服务更新|未执行；其 `01bff9fb409d872d32e682bd2f8ed02be43ca9c3` 未在公开远端取得，必须先保留并核对本机增量|

正式整合时应在原基线和候选版本之间使用同机、同数据、同相机、同操作序列，测试全线便道、多个硬化重叠、反复预览/取消/删除、亮度拖动与重新加载。记录长任务、帧时间、内存与资源回收；仍出现明显退化则不更新正式服务。

私有 GLB、贴图、LOGO、资源映射、真实 CAD 派生几何和模型画面不包含在公开提交中。既有公共工具测试使用合成内容，不代表再次加工或公开真实资源。
