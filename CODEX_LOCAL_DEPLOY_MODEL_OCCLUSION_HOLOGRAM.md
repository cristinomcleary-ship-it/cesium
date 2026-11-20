# 工程模型遮挡与结构全息投影本机验收

候选分支 `codex/model-occlusion-hologram-v1.2.2`。继承摄影位置交付 `4239fb7709017b530e818f7a88399a89c729a4eb`。按交付消息给出的候选完整 SHA 检出。先按 [摄影位置验收任务书](CODEX_LOCAL_DEPLOY_PHOTOGRAMMETRY.md) 核实 Windows 实际进程、目录、地址、源代码和 HTTP bundle，并完成未确认的摄影真实回归。

## 启动与资源

1. 在独立候选目录用 Node 24 安装锁文件依赖、执行 `npm test` 和 `npm run build`。继续使用原 Vite Node 服务启动方式。候选测试使用单独端口和合成或已授权的独立测试数据根。正式切换沿用原访问地址和数据根。
2. 只读核对现有 `CESIUM_TEMPORARY_WORKS_ASSETS_DIR` 的清单、三个 GLB 和 Logo，回归项目部、钢筋棚、宣传墙。沿用原转换 SDK、账号与权限。
3. 在候选 Node 进程的环境变量 `CESIUM_STRUCTURE_LIBRARY_DIR` 中填写本机结构库绝对路径。目录放在软件目录外，或软件目录内受保护的 `project-data`、`private-assets` 子目录。用读权限挂载，保持现场资源原位。

```text
structure-library/
  catalog.json
  bridge/
    A001/
      structure.json
      hologram.glb
      preview/
        index.html
        assets/
```

`catalog.json` 示例。工程模型记录 ID 可在「工程模型 → 工程模型遮挡」中选择对应模型后查看。覆盖整份 GLB 的单体绑定可省略 `nodeName`，同一 GLB 内多个构件使用各自唯一、可拾取的节点名。

```json
{
  "version": 1,
  "bindings": [
    { "modelId": "a2a69d82-baa2-4a2c-9ed8-552654c864e7", "nodeName": "A001_Pier", "category": "bridge", "structureId": "A001" }
  ]
}
```

`structure.json` 示例。`position` 采用工程模型轴转换后的局部三维坐标，在模型 `scale` 与 `modelMatrix` 应用之前给定。也可填写 `{ "kind": "wgs84", "longitude": 120.93, "latitude": 30.83, "height": 18 }`，高程采用米制椭球高。示例数字仅用于说明字段。

```json
{
  "version": 1,
  "title": "A001# 墩",
  "anchor": { "kind": "model-local", "position": [0, 0, 8] },
  "headingDegrees": 0,
  "scale": 1
}
```

`hologram.glb` 使用含全部贴图的自包含 GLB 2.0，单次投影上限为 64 MiB。`preview/` 放原交互网页和其离线依赖，保留相对链接与原始文件。浏览器对预览页采用独立沙箱，包内 CSS、JS、模块与数据按相对路径读取。依赖 CDN、父站存储或登录的网页需核实原离线包是否已随附完整依赖。预览访问在最多 30 分钟后或账号权限撤销后失效，从平台重新打开可刷新授权。

## 验收顺序

| 场景 | 验收操作 |
| --- | --- |
| 工程遮挡 | 在工程模型面板保存单个模型和分组的个人设定。导入 CC 视频和 XML，在当前方案中切换模型显示、工程遮挡与实景遮挡。用同一视角分别检查前后重叠、地下构件、路面和 CAD。 |
| 方案与缓存 | 保存后退出、刷新并重新打开，核对独立遮挡及现有标注。更改会影响成像的规则后重建缓存。打开历史方案并复核旧缓存路径。隐藏的工程遮挡源从已保存资料恢复。 |
| 原场景 | 退出、重开、切换权限和卸载模型后核验原模型矩阵、外观和显示状态。回归摄影位置、剖切、开挖、临建与便道、机械及旧视频 AR。 |
| 全息投影 | 选真实 A001# GLB 节点，检查投影落点、扫描效果、旋转、缩放和重复切换。打开原网页，验证其结构互动和资源请求。别名或权限错误要可辨认。 |
| 实际 GPU | 记录 GPU、驱动、浏览器和 ANGLE renderer。用同一模型、相机和视频比对帧时、视口像素、GPU/浏览器占用和长时启停趋势。遮挡开启时还要核对导出和缓存帧。 |

浏览器合成专项可运行 `node tests/structure-hologram-browser.mjs`。工程遮挡专项使用 `node tools/verify-cc-video-occlusion.mjs --engineering`，运行前配置 Playwright、Chromium、FFmpeg、`START_VITE=1` 与候选 `BASE_URL`。脚本自动创建独立的合成测试数据目录。

## 回退

回退到经本机核实的上一运行提交，沿用同一启动方式和当前业务数据。个人设置使用独立的浏览器存储键，方案规则储存在可选 `engineeringOcclusion` 字段。旧代码按原规则渲染方案。回退期间仅回放包含新遮挡规则的方案，等重新部署候选版本后再编辑并保存，以保留该规则。结构库和原网页留在各电脑原位置。遇到异常反馈完整候选 SHA、操作步骤、脱敏日志与实际 GPU 结果。
