# 视频融合中的 CAD 整体倾角与贴附高程

版本：`2026.10.22-R7-group-tilt-surface`。

本轮修复 R6 中的两个实际缺陷：整体模式明确禁用了倾角输入；贴地／贴模型 CAD 进入 AR 时被强制换回图纸原始 Z，使地图里已贴平的线在视频里重新产生坡度。另修复普通 GLB 贴附采样的 2000 顶点总量截断，避免长线漏采后混用原始高程。

## 使用

1. 进入视频 AR 的融合编辑，在“调整范围”选择“整体工程校正（CAD／模型）”。全部 CAD 和工程模型围绕同一个固定中心一起移动、旋转，保留彼此间距。显示勾选仅控制可见性，不改变整体校正范围；3D Tiles 倾斜摄影、空三坐标参照和地表遮挡参照不跟随整体校正。
2. 展开“整体／单个对象方向与倾角”，调整东西、南北倾角。两轴支持 −90° 至 90°，按钮默认每次 0.1°，可修改步长；整体平移、升高及水平旋转也在同一范围内生效。
3. 东西倾角正值抬高东侧，南北倾角正值抬高北侧，方向为固定中心处的场景东、北。整体中心在首次操作时确定并保存，不随后续输入漂移。选择一份 CAD 或模型时，可继续保留、修改它的独立修正；整体修正叠加在独立修正之后。
4. “倾角归零”只清除当前范围的两项倾角，保留平移、升高和水平旋转。“重置对象微调”在整体模式清除整体修正，保留各对象的独立修正；单对象模式仅重置该对象。支持撤销、重做。
5. 检查视频首、中、尾的对齐效果，保存并重新打开方案，确认整体中心、两轴倾角、位置和标绘锚点恢复。几何调整会使旧融合缓存失效，需重新生成；从缓存播放返回调整也使用同一规则。

倾角属于当前视频融合方案，对整段视频使用固定值。退出融合会恢复地图中的原对象姿态，重新打开方案恢复该方案的修正。整体微调适合一致的整体偏差；原图元方向、高程基准、镜头标定或相机轨迹错误仍需修正对应来源。

## 贴附 CAD 进入 AR 的处理

- 绝对高程 CAD 保留原世界坐标；已完成模型高程采样的 Entity CAD 保留已采样顶点。
- 贴地／贴模型 Primitive CAD 在地球和接收模型隐藏前，按原显示模式采样表面，生成可旋转的绝对高程临时副本。原 CAD 图层和保存文件不改写。
- 贴地模式使用当前地形服务高程并保留场景高程夸张设置；椭球地形采用椭球面。贴模型模式仅采样当前显示的模型或倾斜摄影，排除 CAD 自身、其他非接收对象和地球，避免把缺失模型覆盖误判为有效地表。
- 线和面的边界以最多 5 m 间距加密后分批采样。它是几何采样，陡坎、狭窄构件、洞口和面的内部形态仍应以原素材验收，不能把这个间距当成工程测量精度保证。
- 缺少表面覆盖、设备不支持采样、地形服务不提供必要覆盖信息或任一顶点采样失败时，该对象会给出具体不可用原因，不能偷偷用原始 Z 继续显示。检查模型可见性、覆盖范围和 CAD 定位后重试。
- 普通 GLB 的 Entity CAD 导入／恢复按批处理全部顶点，不再只有 2000 个顶点的总预算；所有采样成功后才写回高程和关闭贴附。失败时保留原顶点，避免同图高程分裂。

进入 AR 的表面冻结只作用于贴附显示模式，不会把按绝对高程导入的真实设计坡度自动压平。

## 保存与变换约定

`adjustments[targetId]` 保留每个对象的独立平移、航向和可选 `tiltEast`、`tiltNorth`。整体参数另外保存在：

```ts
groupAdjustment?: {
  anchor: [number, number, number]; // 固定 ECEF 共同中心
  values: { east, north, up, heading, tiltEast, tiltNorth };
}
```

旧方案缺少整体参数时为单位变换，缺少单对象倾角时为 0。平移单位为米，角度单位为度，`heading` 顺时针约定不变。围绕中心的固定 ENU 框架 `F`，单次变换为：

```text
F · Translation(east, north, up) · Ry(-tiltEast) · Rx(tiltNorth) · Rz(-heading) · inverse(F)
```

CAD／工程模型的最终变换为 `整体 G · 单对象 L_i · 原几何`。不是给每个对象增加相同角度后各绕自身中心转动。每次从会话开始时的矩阵或顶点重新计算，避免累积误差；Entity、Primitive、贴附临时副本及空间标绘使用同一组合变换。

整体参数和固定中心进入保存、撤销／重做、诊断与缓存依赖签名。缓存仍使用地图中的实时模型矩阵，进入 AR 后使用进入前快照，避免重复计算方案变换。贴模型 CAD 的缓存还依赖接收模型的位置，即使接收模型没有勾选为视频叠加对象。整体旋转后，单对象画面拖动通过整体旋转的逆变换保持请求的世界水平／竖直方向。视频源分辨率、源帧时间轴和加长进度条不因倾角调整而降低或缩短。

## 验证入口

```bash
npm run build
node --experimental-transform-types --import ./tools/test-module-loader.mjs --test src/cadImport.test.ts src/videoOverlayResources.test.ts src/videoOverlaySpatialBinding.test.ts src/videoOverlayOcclusion.test.ts src/videoOverlayDrapedCad.test.ts src/dxfLoader.test.ts
node --test tests/video-overlay-cache-signature.test.mjs tests/video-overlay-group-drag.test.mjs
node tests/scene-library-pos-regression.mjs
node tools/verify-video-overlay-cad-tilt.mjs
node tools/verify-video-overlay-surface.mjs
```

整体倾角浏览器用例检查多个 CAD／模型的共同中心刚体变换、GUI 按钮、归零／撤销、方案恢复、缓存画面变化和退出恢复。表面用例单独检查原始 Z 有坡度的贴附 CAD 进入 AR 后保持采样表面，避免用绝对高程合成 CAD 的测试代替真实贴附路径。上述为可重复的验证入口，实际执行结果以本轮交付报告为准；本机真实素材仍待现场验收。

## 倾斜问题检查与修复

已复现的导入缺陷：原解析器忽略 DWG 图元和 INSERT 块的 `extrusionDirection`，把局部对象坐标 OCS 直接当作世界坐标 WCS。按照 Autodesk 的任意轴算法，先还原图元所在平面，再依次应用块基点、比例、旋转、插入和父块变换，可恢复正确姿态。LINE、POINT、3DFACE、POLYLINE3D、SPLINE、MTEXT 等原本采用 WCS 的实体不会额外旋转。

此外修正椭圆（`ELLIPSE`）忽略法向的问题：使用 WCS 三维长轴和法向计算短轴，恢复竖向、倾斜平面和负法向椭圆；不再将椭圆短轴强制放在 XY 平面，竖向长轴也不会被丢弃。嵌套块仍按父 INSERT 变换。

同时修正 `POLYLINE2D` 的高程读取：二维顶点的有效 Z 应来自父多段线的 `elevation`，不能让解析器输出的顶点 `z: 0` 将它覆盖。三维多段线保留自身顶点高程。

回归案例：块内一条 100 m 线的末端坐标为 `(0, 70.7107, -70.7107)`，块参照法向为 `(0, -√0.5, √0.5)`。正确组合后末端应为 `(0, 100, 0)`，是水平线；旧解析遗漏块的局部坐标转换，仍保留 −45° 倾斜。回归用例覆盖该案例及非默认法向圆弧、二维多段线、文字、面和嵌套块。

参考：
- [Autodesk：对象坐标系 OCS 与图元类型](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-D99F1509-E4E4-47A3-8691-92EA07DC88F5.htm)
- [Autodesk：椭圆的 WCS 长轴及法向](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-DXF/files/GUID-107CB04F-AD4D-4D2F-8EC9-AC90888063AB.htm)
- [Autodesk：任意轴算法](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-DXF/files/GUID-E19E5B42-0CC7-4EBA-B29F-5E1D595149EE.htm)

现有 `.cadimport` 的顶点已经固化，且没有保留图元法向。以下旧资源需要从原 DWG 重新生成导入文件：包含非默认图元/INSERT 法向并已错误烘焙方向的资源；二维多段线父 elevation 被顶点 z=0 覆盖的资源；包含被错误处理的倾斜、竖向或负法向椭圆的资源。仅凭旧 `.cadimport` 不能完整识别这些条件，需对照原 DWG，当前未收到原图，无法列出具体文件名。本更新不猜测、更改旧顶点。整幅一致坡度偏差可用双轴倾角微调，混合图元各自的坐标方向错误应通过重导入解决。

截图无法唯一确定原因。原 DWG 导入方向、视频相机配准、实际模型表面和本机部署版本应分别核验；没有在用户电脑和原始素材上完成的项目均为待现场验收。
