# 临建接续测试报告

## 2026-11-06 贴地便道采样容量修复

本轮以远端 `11e3e701b559b25a4c04d11247f91d013a474239` 建立独立工作区，保留原工作区和私有资源。修复内容见 [采样容量说明](draped-road-sampling.md)。源码冻结后执行以下检查，测试对象为包含本修复的工作区；没有重制或重新发布私有模型。

|实际命令|本轮结果|
|---|---|
|`node node_modules/typescript/bin/tsc --noEmit`|exit 0|
|`npm run build`|exit 0；执行 tsc 和 Vite，Vite 36.77 秒；保留既有大分包及 libredwg 浏览器外部化提示|
|`node tools/run-temporary-works-regression.mjs all --output output/road-sampling-verification`|exit 0；166 文件、1309 项通过，0 失败/取消/跳过；62.52 秒|
|`node --experimental-transform-types --import ./tools/test-module-loader.mjs --test src/temporaryWorksDrapedRoadBudget.test.ts`|exit 0；9 项新回归通过，10.73 秒|
|`node --experimental-transform-types --import ./tools/test-module-loader.mjs --test src/temporaryWorksDrapedRoadPanel.test.ts`|exit 0；3 项通过，包含旧记录兼容与新分区统计恢复|
|`node --test tools/temporary-works-assets/geometry-signs.test.mjs tools/inspect-video-ar-recovery.test.cjs tools/validate-platform-ar-checkpoints.test.mjs`|首次因新工作区缺少工具依赖 `@gltf-transform/core` 而 exit 1（18 项通过、1 文件加载失败）；接回现有工具依赖后完整重跑 exit 0，43 项通过|
|`git diff --check`|通过|

合成地形专项结果：

|用例|累计采样位置|自动分区|单区临时位置峰值|结果|
|---|---:|---:|---:|---|
|10 km、宽 4 m 斜平面|542075|91|7253|覆盖 40000 m²，完整长度保留；旧实现相同输入在 93975 次实际采样后分配探针时触发 50 万候选点错误|
|300 m、宽 4 m、2 mm 起伏|816459|3|339632|预算通过；仍保守排除未通过核验的 713.347169 m²，不计作完整覆盖|
|长发夹重叠区域|94899|1|94899|安全联合几何保持完整，不对重叠两臂重复计面积|

新回归另检查每个取样请求不超过 512 点、相邻分区细化不同仍无接缝裂缝/重复面、CAD 里程因子/断点与反向、缺测保留、第二分区取消、最终展示网格超限明确失败。独立复核还覆盖大坐标斜线接缝和不能安全拆分区域的局部预算错误；容量预留公式是估算，真正的上限由每个新增位置的检查保证。

已获取原便道 DWG，采用明确标注的测试单位假设与合成斜平面进行新旧算法对照：候选二维中心线的完整长度和面积保持一致，新实现完成 25 分区，临时位置峰值 7575。旧实现对此合成地面也成功，不能称该图纸已经复现用户现场报错。真实单位、坐标配准和现场高程仍未确认；原图及派生坐标保持私有。

**本轮没有完成用户电脑服务更新和真实倾斜摄影浏览器验收，没有新增现场截图。** 下文 R2 的模型、浏览器、独立脚本与 Python 结果保留为既有证据；除表中命令外本轮未重复执行，不能与 1309 项主套件混算成全仓全部通过。

---

日期：2026-11-05（Asia/Shanghai）。Node.js `v24.22.1`。基准 `v1.2.0` / `2258754`；原远端 `a2665fe3`，接续的原本地提交 `ff1df93`。

**R2 修正：类型检查、生产构建和主回归通过；浏览器现场验收仍未完成。** 针对模型暗淡、残留立体旧字和 CAD 只取中心问题，新增局部模型照明、带源码哈希校验的几何文字替换、按结构底面自动拟合与多点摄影取高。代码和真实私有资源分别验证，不能把离线图当成现场效果。

最终主回归在应用源码冻结后重跑；165 个文件、1299 项通过。完整日志与私有模型映射保存在交付包。下文独立旧脚本、Python 的结果来自本会话前一轮完整接续核查，相关附属源码本轮未改，未将旧失败或未运行范围算作通过。

## 类型、构建和主回归

|实际执行命令|结果|
|---|---|
|`node node_modules/typescript/bin/tsc --noEmit`|exit 0|
|`npm run build`|exit 0；执行 tsc 和 Vite，Vite 构建 23.29 秒|
|`node tools/run-temporary-works-regression.mjs all --output <verification>`|exit 0；165 个测试文件，1299 项通过，0 失败/跳过/取消|
|`node --test tools/temporary-works-assets/geometry-signs.test.mjs`|exit 0；25 项通过，0 失败；真实文档/网格/序列化 API 配合合成几何，验证批次保护及新字面朝向|
|`node --test tools/inspect-video-ar-recovery.test.cjs tools/validate-platform-ar-checkpoints.test.mjs`|前一轮 exit 0；18 项通过，0 失败；本轮未改相关源码|
|`node tools/install-temporary-works-assets.mjs --from <private-bundle>`|前一轮安装成功；本轮保留旧副本后重建运行资源并执行下列校验|
|`node tools/install-temporary-works-assets.mjs --check`|exit 0；3 类 GLB 和 LOGO、清单通过|
|`node tools/install-temporary-works-assets.mjs --check --to dist/models/temporary-works`|exit 0；构建后资源通过|
|`node tools/temporary-works-assets/verify.mjs`|3 份最终 GLB 均 Validator 0 errors；项目部 37 条切线生成 warnings|
|`git diff --check`|通过|

构建存在既有大分包警告和 libredwg 的 `node:module` 浏览器外部化提示，没有构建错误。私有模型另经实际解码、累计节点/实例矩阵、底部锚点、有效包络及品牌材质绑定复核。上述不证明 GPU 外观或现场施工尺寸已验收。

主运行器只收集 `src/`、`server/`、`tests/` 中 `.test.ts` / `.test.mjs`；其外范围如下，未混入通过数。

## 其他独立 Node 脚本

以下脚本分别执行 `node tests/<名称>.mjs`，共 5 个通过、5 个失败。失败脚本在同环境的 v1.2.0 基线分别执行，均出现相同错误类型和位置，保留失败结果。

|脚本|结果|基线比较或范围|
|---|---|---|
|business-display-delete-regression|exit 1|基线相同；模拟请求中 definition 对象缺失|
|management-snapshot-access-regression|exit 1|基线相同；records[0] 未定义|
|scene-library-pos-regression|exit 1|基线相同；fixture.deleted 缺失|
|video-overlay-access-regression|exit 1|基线相同；fixture 回调缺失及显隐断言|
|video-overlay-deferred-frame-regression|exit 1|基线相同；fixture.spatialAnnotations 缺失|
|model-placement-regression|exit 0|独立脚本完成|
|video-overlay-autosave-regression|exit 0|独立脚本完成|
|video-overlay-cache-boundaries|exit 0|独立脚本完成|
|video-overlay-manifest-cancellation|exit 0|独立脚本完成|
|video-overlay-status-regression|exit 0|独立脚本完成|

本次未改动无关业务或旧脚本消除既有失败。基线相同不等于这些业务已在浏览器验收。

## Python 附属模块

```sh
python3 -m unittest discover -s ar_v2/tests -v
PYTHONPATH=video_ar_backend python3 -m unittest discover -s video_ar_backend/tests -v
```

两条命令均 exit 1。AR V2：11 项通过，5 个错误（4 个模块导入失败及 1 项运行错误），均缺 `cv2`。视频后端：85 项通过，3 个错误（缺 `paho` 或 `cv2`），4 项 Windows 专用测试跳过。导入失败模块的内部用例未完整执行，没有将其记为通过。

## 浏览器及真实现场

R2 最终生产构建实际执行：

```sh
PLAYWRIGHT_MODULE=/opt/codex/cua_node/lib/node_modules/playwright/index.mjs BROWSER_EXECUTABLE=/usr/bin/chromium TW_GLB_OUT=<browser-r2> node tools/verify-temporary-works-glb.mjs
```

结果 exit 1；读取最终生产入口成功，Chromium 启动时报 `process_singleton_posix.cc: socket() failed: Operation not permitted`，场景检查 0 项，截图 0 张。前一轮另启动 `--serve-only`，可用浏览器访问隔离预览返回 `ERR_CONNECTION_REFUSED`；本轮未重复该路径。未修改系统权限或绕过隔离。

以下 4 个独立浏览器脚本未完成：`full-app-five-scope-smoke`、`scene-display-delete-regression`、`scene-display-performance-regression`、`video-overlay-render-targets-browser`。

临建脚本的摄影是合成测试面；真实工地摄影数据未取得，未进行真实 GLB 与现场摄影联合验收。尚需检查：模型逐面外观与品牌、文字朝向、实际启停/删除/刷新后的遮挡、其他剪裁与场景联动、便道现场贴合、控制坐标/高程和设备帧率。没有真实场景截图可交付。

## 图纸、品牌与照明专项

自动拟合覆盖 Y/Z 轴、偏心锚点、真实模型矩阵、独立长宽、原高度、完整凹边界、180° 正面反转、200 顶点搜索预算和保存恢复；摄影取高对每块独立底面分别检查有效率。额外覆盖退出编辑和清除 LOGO 后的延迟任务取消，以及模型专属照明和资源释放。

真实 DWG 已取得并解析，但未能唯一指定驻地和钢筋厂的完整闭合轮廓；图纸单位信息也存在冲突。未据此编造实际位置或把其他设施边界作为验收。详细图层/实体和图示仅保存在私有 CAD 核查记录。

新模型已按源节点核查并移除已确认的旧单位/旧项目立体字，使用精确字面替换。原件、旧运行副本均保留；离线整场图用于核对新字位置和朝向。真实浏览器中的亮度、文字渲染和摄影贴合仍未验收。
