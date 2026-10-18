# SKP 后台导入

更新后，平台不再调用 `SketchUp.exe`，也不会要求先打开 SketchUp。选择 SKP 文件后，平台先在后台完成转换；随后在场景中点选位置即可放置，之后可以平移、旋转或重新点选位置。

## 首次配置一次

SKP 不是浏览器能够直接读取的格式。后台转换使用 SketchUp 官方独立 C SDK；这里提供转换代码，不附带该专有 SDK。已有桌面版 SketchUp 并不等于已经安装独立 SDK。

1. 在平台项目目录执行 `pnpm install --frozen-lockfile`，安装锁定的依赖。使用 64 位 Node.js 24+；仓库已允许 esbuild 和 koffi 的必要构建脚本。
2. 从 [SketchUp 官方 SDK 下载页](https://extensions.sketchup.com/en/developer_center/sketchup_sdk) 获取 Windows 64 位 C SDK，按其页面要求获取。代码最低使用 2021 / API 9.0 的接口；建议使用能完整读取您模型版本的最新 SDK。
3. 将 SDK 中 `binaries\sketchup\x64` 文件夹里的**全部文件**复制到平台的 `tools\sketchup-sdk` 文件夹。该目录应直接包含 `SketchUpAPI.dll`，以及 SDK 自带的依赖文件。不要用桌面程序的 `SketchUp.exe` 或 `sketchup.dll` 代替。
4. 按 SDK 要求安装 Microsoft Visual C++ x64 运行库。运行以下命令检查组件能否加载：

   ```bat
   node tools\sketchup-headless.mjs --check
   ```

5. 重新启动平台，再导入 SKP。之后不需要重复配置或打开 SketchUp。

也可将系统环境变量 `CESIUM_SKETCHUP_SDK_DIR` 设置为 SDK 根目录或 `binaries\sketchup\x64` 目录。修改环境变量后需关闭并重新打开启动平台的终端。

无需创建 `model-converters.json` 即可使用默认 SDK 路径。已有 DWG/RVT 配置时，只修改其中的 `skp` 段：

```json
"skp": {
  "provider": "sketchup-sdk"
}
```

如要指定单独目录：

```json
"skp": {
  "provider": "sketchup-sdk",
  "sdkDirectory": "C:\\Tools\\SketchUpSDK"
}
```

已有配置如果指向**本项目**的 `tools\sketchup-to-glb.cmd`，更新后会自动使用新的后台实现。其他旧桌面启动脚本会显示“已停用”，不会悄悄打开 SketchUp。

## 日常操作

- 导入后点选模型放置位置；SKP 模型的底部中心与落点对齐。
- 模型中的群组、组件实例和缩放变换会展开；英寸转换为米，坐标转成 glTF 的 Y 向上坐标。原模型即使位于很远的建模坐标，也会先归中再导出，避免看不到模型和大坐标精度损失。
- 支持面、孔洞的三角化、正反面材质、颜色、透明度以及随 GLB 内嵌的面贴图；重复组件按各自变换分别导出。原始 SKP 不被修改或覆盖。
- 超时、取消、转换出错时清理任务；没有完整 GLB 不会发布为成功资源。
- 没安装后台组件时，界面会明确提示缺少组件。GLB 导入仍然可用。

## 当前支持边界

这是场景几何导入器，不是 SketchUp 编辑器。检测到独立图片、独立线条/曲线、文字尺寸或剖切面时，会显示对应转换提示；这些对象及 SketchUp 剖切状态不转换，按完整构件几何显示。相机动画、扩展插件行为以及高级 PBR 通道不转换。原文件里没有可见面的模型会提示无法转换。模型超过 500 万个三角面时提示拆分，以免拖垮现场工作台。

组件继承材质在转换时仅临时展开到内存中的面，再恢复；不会保存原 SKP。贴图读取器按转换任务及继承材质隔离复用，避免重复编码；SDK 为投影贴图分配的不同 ID 仍保持独立。其他复杂模型和 SDK 版本仍需用对应样例核验。

已有独立第三方转换器可继续使用；其配置需要明确 `headless: true` 且经过本机转换测试后设 `validated: true`，执行参数仍须包含 `{input}` 和 `{output}`。直接指定 `SketchUp.exe` 或 RubyStartup 的配置一律不使用。

## 验证记录

当前开发环境完成：后台接口测试、独立转换进程测试、GLB 完整性、坐标与单位换算、底部归中、非均匀缩放及镜像法向、正反面材质及贴图内嵌、重复实例、异常清理、循环引用和超量保护。

使用自行编译的 C ABI 测试库验证了真实原生调用的结构体、引用、输出指针、双精度数组和 `size_t` 索引传递。该测试库不读取 SKP，不能代替 Windows 官方 SDK 的真实模型测试。2026-10-18 已在 Windows 上使用 25.0.634 独立 C API 运行库和真实 SKP 完成验证，输出 112,770 个三角面、2 个材质批次、1 张内嵌 PNG，未启动 SketchUp 桌面。生产构建真实浏览器 7 项流程及 3 种鼠标调整全部通过。Linux 专用 C ABI 测试桩在 Windows 跳过，不与真实 SDK 验证混淆。匿名化结果见 `../验收记录/Windows本机验收_20261018.json`。

自动化测试：

```bat
node --test tests\sketchup-headless.test.mjs tests\model-middleware-headless.test.mjs tests\sketchup-texture-writer-pool.test.mjs
```

## 实现依据

- [官方独立 C API 与运行依赖](https://extensions.sketchup.com/developers/sketchup_c_api/sketchup/index.html)
- [模型文件读取与版本状态](https://extensions.sketchup.com/developers/sketchup_c_api/sketchup/struct_s_u_model_ref.html)
- [三角网格与 STQ 坐标](https://extensions.sketchup.com/developers/sketchup_c_api/sketchup/struct_s_u_mesh_helper_ref.html)
- [贴图导出及非仿射贴图处理](https://extensions.sketchup.com/developers/sketchup_c_api/sketchup/struct_s_u_texture_writer_ref.html)
- [Koffi 原生调用与输出参数](https://koffi.dev/output)
