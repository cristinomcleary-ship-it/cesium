# 设计便道、场地硬化与亮度调节：验证记录

## 2026-11-07 接续核查（北京时间）

接续时远端 PR #9 仍为 Draft，功能提交 `a9618b757c1e788d784bafccda48f4a8d4be7e27`。会话恢复出的原工作树是较早的未提交快照，已原样保留，另建独立工作树复核远端源码。验证清单中的 32 个源码/依赖文件及 174 个测试文件 SHA-256 全部匹配；旧快照未发现独有未发布的实质修改。

发现并修复本机部署阻断：`package.json` / npm 锁已包含 `polygon-clipping`，但 pnpm 锁遗漏它。使用与本机记录一致的 pnpm `11.25.0` 在隔离副本复现、生成及检查：

|命令/核查|结果|
|---|---|
|原锁：`pnpm install --frozen-lockfile --lockfile-only --ignore-scripts`|exit 1，`ERR_PNPM_OUTDATED_LOCKFILE`，缺少新增依赖|
|隔离副本补齐 pnpm 锁|exit 0；仅增加 `polygon-clipping@0.15.7`、`robust-predicates@3.0.3`、`splaytree@3.2.3`，165 个既有包及旧解析版本不变|
|新锁：`pnpm install --frozen-lockfile --lockfile-only --ignore-scripts`|exit 0，锁哈希不变，未创建或改写共享 node_modules|
|完整性与 Cesium 版本|新增三项 integrity 与 npm 锁逐字一致；engine `26.2.0` / widgets `16.1.1` 解析保持不变|

新 pnpm 锁 SHA-256：`d2934c4af0636ef2dd785b81f2db5a51c751d6d5fae053326edf7bf09223eada`。上述是冻结锁文件检查，不冒称用户电脑完整安装成功。本次没有修改产品 `src`；下文 1420 项主套件及构建为功能提交已有记录，不改写为本次重新执行。

新增可移植的隔离验证入口 `tools/designed-surfaces-preview/server.mjs`，以真实临建面板、合成 3D Tiles 和用户显式提供的本地私有资源进行检查，方案仅在内存中，不连接生产业务接口。

|新入口专项检查|结果|
|---|---|
|`node tools/designed-surfaces-preview/server.mjs --help`|exit 0；不启动服务、不读取私有资源|
|`node --test tools/designed-surfaces-preview/preview.test.mjs`|exit 0；8/8，0 跳过；覆盖回环地址、端口、只读资源白名单、链接越界、业务接口拒绝、真实换行 DXF 与合成 GLTF 夹具|
|验证页 TypeScript 严格检查（命令如下）|exit 0；显式使用严格编译选项，未改主配置|
|验证页 Vite 生产构建|exit 0；13.18 秒，输出到独立临时目录，未覆盖正式 dist|
|同进程 HTTP 探针及关闭|最终 exit 0；首页、app.ts、3 个合成夹具、Cesium 依赖 JS 和 Widgets CSS 均 200；业务接口 404、POST 405；正常完成关闭并自然退出|

首次 HTTP 探针完成响应检查后，旧顺序的关闭流程停住，已终止该探针自身进程（exit 130），没有把它记为通过。修复仅属于验证服务：并行关闭自己的 HTTP/Vite 资源，关闭自身剩余连接；最终探针消费完整响应并自然退出。HTTP 可加载和构建成功不代表浏览器已执行代码、shader 已实际绘制或帧率通过。本轮不包含私有模型 GPU 验收，不新增真实场景截图。

验证页严格类型检查命令：

```sh
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --types node --skipLibCheck --allowImportingTsExtensions --strict --noUnusedLocals --noUnusedParameters tools/designed-surfaces-preview/app.ts src/vite-env.d.ts
```

验证页构建由 `node --input-type=module` 调用 Vite `build`，配置来自 `previewViteConfig`，目标为 `esnext`，产物输出到独立验证目录。同进程 HTTP 检查由 `node --input-type=module` 调用 `startPreview` 后发起 GET/POST、消费响应体并在 finally 关闭，未使用浏览器自动化；这些附加检查没有并入主套件数量。

按实际 Cesium Engine `26.2.0` 源码核对 shader 接口、材质与光照阶段、SpecGloss 分支、uniform 注入和资源销毁，未找到确定编译接口错误；这不是 GPU 验收。`Model.ready` 先于首次实际绘制，且局部照明后仍可能叠加全局雾、大气和 HDR，不能承诺不同环境的最终像素完全相同。

浏览器访问隔离验证页本次明确返回 `net::ERR_CONNECTION_REFUSED`，未进入有效场景，截图和 GPU/流畅度验收仍未完成；本次临时验证进程已结束。用户 Windows 的 `01bff9fb` 仍未在远端取得，未更新正式服务。下一步由本机执行 [接续任务](../../CODEX_LOCAL_DEPLOY_DESIGNED_SURFACES.md)，保留其本机修复并完成实际场景与固定基线性能对比。

## 功能提交已有执行记录

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
