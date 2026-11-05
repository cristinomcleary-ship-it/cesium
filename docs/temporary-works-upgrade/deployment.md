# 临建升级私有资源部署与回退

代码基准为 `v1.2.0` / `2258754ce810002fa4fd80db3df90c20f4299f2b`，开发分支为 `feature/temporary-works-glb-integration`，Draft PR 目标为 `codex/release-v1.2.0`。本阶段不合并、不替换正式环境。真实工地摄影和浏览器验收尚未完成。

## 独立测试部署

使用 Node.js 24 和 npm。公开仓库只提供代码；三类 GLB、LOGO、包含实际底面坐标的 manifest、模型审计及预览证据均通过私有资源包提供。品牌整理原件不能直接改名代替运行模型。

将私有包解压到本机目录，找到其 `temporary-works` 子目录。以下 PowerShell 路径按本机实际位置修改：

```powershell
git clone --branch feature/temporary-works-glb-integration https://github.com/cristinomcleary-ship-it/cesium.git D:\cesium-temporary-works-test
cd D:\cesium-temporary-works-test
node tools/install-temporary-works-assets.mjs --from "D:\cesium-private-assets\temporary-works"
node tools/install-temporary-works-assets.mjs --check
npm ci
npx tsc --noEmit
npm run build
node tools/install-temporary-works-assets.mjs --check --to "$PWD\dist\models\temporary-works"
$env:CESIUM_DATA_DIR = "$PWD\test-data\project"
$env:CESIUM_MANAGEMENT_DATA_DIR = "$PWD\test-data\management"
$env:CESIUM_SAFETY_DATA_DIR = "$PWD\test-data\safety"
npm run preview -- --host 127.0.0.1 --port 4174
```

打开 `http://127.0.0.1:4174/`。保留 `dist/cesiumStatic/` 中的 Worker 和解码器。应用依赖 Vite preview 的本地服务接口；只复制 dist 到普通静态服务器不能提供原有资料管理接口。

`public/models/temporary-works/` 为本机运行资源目录，已被 Git 忽略。安装后的 dist 也包含私有模型，不得推送公开仓库或部署到公开站点。原本地历史中含模型的提交链必须保留为私有；不能靠末尾删除模型后再推送整条历史。

## 安装校验与文件保护

私有目录应包含 `manifest.json`、其引用的三个 GLB 和 `cr24-logo.png`。清单声明米制 Y-up、三类资源的尺寸/底部锚点/轮廓、文件字节数与 SHA-256，以及 LOGO 的 `url`、`bytes`、`sha256`。

安装器无第三方依赖，安装前检查完整包、GLB 2.0 结构、嵌入资源及路径合法性；不复制清单外文件，不允许符号链接和路径穿越。同版重复安装不改文件；发现异版目标文件则拒绝，旧文件保持不变。更新异版资源时使用新的独立部署目录，或先停服务、备份并移走旧资源目录。安装器不会删除原模型或业务资料。

## 使用与兼容

1. 项目部、钢筋棚支持按 CAD 闭合轮廓自动定位、旋转及平面长宽缩放，高度保持原值；选定摄影后进行底面多点取高。另保留手动坐标、等比/XYZ 尺寸和编辑保存。独立宣传墙沿用手动精确布置。
2. 先核对 CAD 单位与坐标，选择该设施的轮廓。非矩形场界显示可行拟合的覆盖率并检查完整边线，不能保证任意轮廓完全贴合。旋转以东向北逆时针为正；高程为椭球高，须结合控制资料转换。具体行为和取高限制见 [自动布置](auto-placement.md)。
3. 独立宣传墙支持文字、上传 LOGO、显隐、定位和删除。文件读取完成后应重新生成预览再保存。
4. 摄影遮挡仅处理关联图层及建筑底面，其他裁剪功能占用时保留其数据并显示阻断。需在实际浏览器检查启用、关闭、隐藏、删除、重载与总开关行为。
5. 新便道处理层底面来自摄影采样，处理层及硬化层向上叠加；无新土方计算。缺测和陡坎区域留空，有限采样不证明未采样细小地物不存在干涉。
6. 原 IndexedDB `cesium-temporary-works-v1` 版本 1 保持不变；旧方案网格、历史土方与旧便道仍读取/显示/删除，不迁移重写。新模型配置和贴地方式以可选字段标记。

## 回退

正式部署前先备份项目资料目录、模型包及对应端口浏览器的方案数据。在独立目录验证全部现场流程后再另行决定正式更新。

运行中关闭“启用真实模型、摄影遮挡与贴地便道”或逐方案关闭遮挡可撤销新场景效果。停止测试服务、回到原正式服务端口即可恢复原版本使用。若已替换测试代码，应恢复对应旧代码和配套私有资源、重新构建；不要删除或覆盖用户工程数据。新字段在旧版本中没有完整编辑能力，旧浏览器应使用备份的资料与方案。

## 复测入口

```sh
node tools/run-temporary-works-regression.mjs all
node --test tools/inspect-video-ar-recovery.test.cjs tools/validate-platform-ar-checkpoints.test.mjs
npx tsc --noEmit
npm run build
node tools/install-temporary-works-assets.mjs --check --to dist/models/temporary-works
node tools/verify-temporary-works-glb.mjs
```

浏览器脚本使用指定真实 GLB 与合成摄影测试面，不是用户真实现场。配置 `PLAYWRIGHT_MODULE` 和 `BROWSER_EXECUTABLE` 可指定已安装浏览器；`--serve-only` 提供同一隔离页面。当前环境启动浏览器失败，相关实际场景验收未完成。详细测试范围和未通过事项见测试报告。
