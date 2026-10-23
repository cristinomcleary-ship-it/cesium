# 显示设置浏览器验收

2026-10-13，最终源码 `2eb7ba9`：真实 Chromium / WebGL 界面验收 **7/7 通过**，页面异常和控制台错误均为 0。此轮使用 SwiftShader，实际进入现有工作台并操作控件，未读取或修改生产数据。原始结构化结果见 [validation.json](validation.json)。

验收创建独立临时数据库和 100 × 100 m 的合成 3D Tiles 斜面，顶面高程为 `12 + 0.12 × east + 0.06 × north` 米。瓦片内容实际加载、选中并渲染，不以空场景的 `tilesLoaded` 作为通过条件。界面创建防护人员、责任区和限界，关联放大 3 倍的吊机。

| 检查 | 结果与证据 |
| --- | --- |
| 场景与业务记录创建 | 瓦片 ready=1、selected=1；支持贴地多边形与边线；产生预期的平面潜在侵限结果。 |
| 依附模型填充 | 相同相机与像素区域中，蓝色像素从原始高程的 34 增至 45,291，橙色从 10,675 增至 13,384；目视可见责任区和倾覆区沿斜面显示。填充透明度分别为 0.55、0.45，填充及边线均使用模型分类。 |
| 独立表面、填充与边线 | 分别切换贴地形、依附模型、原始高程，确认两个区域互不覆盖设置；仅边线状态 `polygon.fill=false`，蓝色和橙色边界清晰可见；分别调整线宽 7、5。 |
| 人员模型与圆点 | 实际加载本地 `guard.gltf`，可见安全帽、反光背心人物；比例 2、朝向 75° 生效；切换圆点后人物消失、圆点出现。 |
| 显示不改变业务 | 筛查结果和业务记录 JSON 前后完全相同；显示操作产生的 `railSafety.save` 请求为 0。 |
| 刷新记忆 | 刷新前后两个区域的表面、样式、透明度、线宽及人物表示、比例、朝向完全一致。 |
| 运行状态 | 单一 Cesium canvas，页面异常 0、控制台错误 0。 |

斜面模式的吊机显示轮廓为 50 个点，原始高程轮廓为 244 个点；这是显示用简化，验收同时确认筛查结果未改变。最终轮次于 `15:36:19Z` 开始，`15:39:37Z` 结束。主任务另已通过生产构建和 24 项相关单元测试。

## 可视限制

合成斜面的部分依附模型填充视角仍有极细橙色拖影，不能宣称完全无伪影。稳定帧诊断在一块天空区域记录到 83 个橙色近似像素；分别关闭所有填充或所有边线后消失，但逐项隔离未确认单一实体成因。尚无证据将其归咎于显卡驱动。当前保留经过验证的有界轮廓简化与纯色边线，没有加入推测性修补。

这轮验证使用合成瓦片，未验证现场实测模型、真实地形服务或所有 GPU；不属于测量精度或施工安全认证。

## 复现

安装项目依赖，并提供可用的 Playwright Chromium：

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
BROWSER_LAUNCH_OPTIONS=/path/to/launch_options.mjs \
node tools/verify-rail-safety-display.mjs
```

`BROWSER_LAUNCH_OPTIONS` 模块默认导出 Chromium launch options；也可省略并使用本机 Playwright 浏览器或 `BROWSER_EXECUTABLE`。脚本为每次运行创建新的 `tmp/rail-safety-display-*` 数据目录，默认输出 `output/rail-safety-display/report.json` 和 6 张截图；可通过 `RAIL_SAFETY_DISPLAY_VERIFY_OUT` 改输出目录。截图仅作本地证据，不提交、不包含在源码补丁中。

本轮关键截图：`01-absolute-surface-clipping.png`、`02-model-attached-fill.png`、`03-model-attached-outline.png`、`04-guard-person-model.png`；另有圆点与刷新后设置截图。截图保存前会等待数据源就绪和后续完整渲染帧。
