# 临建接续测试报告

日期：2026-11-05（Asia/Shanghai）。Node.js `v24.22.1`。基准 `v1.2.0` / `2258754`；原远端 `a2665fe3`，接续的原本地提交 `ff1df93`。

**主套件与生产构建通过；完整测试范围仍有既有失败和环境阻断，不能宣称全部验收通过。** 主套件在接续源码上执行，发布整理工作区的 `src/`、`server/`、`tests/` 共 476 份源码与该测试快照逐字节一致。模型几何、私有清单、原始日志及完整哈希快照保存在私有交付中。

## 类型、构建和主回归

|实际执行命令|结果|
|---|---|
|`node node_modules/typescript/bin/tsc --noEmit`|exit 0|
|`npm run build`|exit 0；执行 tsc 和 Vite，构建 24.70 秒|
|`node tools/run-temporary-works-regression.mjs all --output <verification>`|exit 0；163 个测试文件，1270 项通过，0 失败/跳过/取消|
|`node --test tools/inspect-video-ar-recovery.test.cjs tools/validate-platform-ar-checkpoints.test.mjs`|exit 0；18 项通过，0 失败|
|`node tools/install-temporary-works-assets.mjs --from <private-bundle>`|真实运行资源安装成功；5 文件完整性通过|
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

最终生产构建实际执行：

```sh
PLAYWRIGHT_MODULE=/opt/codex/cua_node/lib/node_modules/playwright/index.mjs BROWSER_EXECUTABLE=/usr/bin/chromium TW_GLB_OUT=<browser-final> node tools/verify-temporary-works-glb.mjs
```

结果 exit 1；读取最终生产入口成功，Chromium 启动时报 `process_singleton_posix.cc: socket() failed: Operation not permitted`，场景检查 0 项，截图 0 张。另启动 `--serve-only`，可用浏览器访问隔离预览返回 `ERR_CONNECTION_REFUSED`。未修改系统权限或绕过隔离。

以下 4 个独立浏览器脚本未完成：`full-app-five-scope-smoke`、`scene-display-delete-regression`、`scene-display-performance-regression`、`video-overlay-render-targets-browser`。

临建脚本的摄影是合成测试面；真实工地摄影数据未取得，未进行真实 GLB 与现场摄影联合验收。尚需检查：模型逐面外观与品牌、文字朝向、实际启停/删除/刷新后的遮挡、其他剪裁与场景联动、便道现场贴合、控制坐标/高程和设备帧率。没有真实场景截图可交付。
