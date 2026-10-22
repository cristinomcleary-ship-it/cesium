# 视频融合中的 CAD 水平倾角

版本：`2026.10.22-R6-cad-tilt`。在结构空间标绘版本上增加，旧融合方案的倾角默认为 0。

## 使用

1. 进入视频 AR 的融合编辑，在“调整范围”中选中一份 CAD。整体平移模式不提供倾角调整，防止多个对象各绕各的中心转动。
2. 展开“单个对象方向与倾角”。先调整水平旋转，再分别微调东西、南北倾角。两个角度均支持 −90° 至 90°；按钮默认每次 0.1°，可修改步长。
3. 东西倾角正值抬高东侧，南北倾角正值抬高北侧。方向以对象中心处的场景东、北为准，不是视频画面的左右、上下。调整绕对象的固定定位中心进行，保留 CAD 原有几何高差。
4. “倾角归零”只清除本方案的两项倾角修正；平移、升高和水平旋转保留。它恢复导入姿态，不会自动把有高差的 CAD 压成平面。支持撤销、重做。
5. 检查视频首、中、尾的对齐效果，然后保存方案并重新生成融合缓存。已有结构引线标签、走向线和区域面使用同一变换，随 CAD 调整。

倾角属于当前视频融合方案，对整段视频使用固定值。退出融合会恢复地图中的原对象姿态；重新打开方案恢复该方案的修正。模型也可使用这两项调整。作为实景遮挡参照的倾斜摄影仍必须保留原地图定位。

若整幅 CAD 有一致的坡度偏差，可使用本功能校正。镜头标定、相机轨迹或局部几何错误不能仅靠一组固定倾角解决，需检查多个时刻确认。

## 实现约定

`adjustments[targetId]` 新增可选 `tiltEast`、`tiltNorth`，单位为度，旧数据缺省为 0。平移以米为单位，原 `heading` 顺时针约定不变。

围绕对象中心的固定 ENU 坐标框架 `F`，变换为：

```text
F · Translation(east, north, up) · Ry(-tiltEast) · Rx(tiltNorth) · Rz(-heading) · inverse(F)
```

每次从会话开始时的原矩阵或原顶点计算，不累积旋转误差。Entity CAD、Primitive CAD、贴地 CAD 的融合副本以及空间标绘共用此变换。原 CAD 文件不改写。缓存依赖以地图中实时模型矩阵为准，进入 AR 后使用进入前的矩阵快照，避免异步保存尚未完成时误复用旧画面，也避免将方案变换重复计入。两项倾角进入方案保存、诊断与缓存依赖签名；静止帧不会重复更新未变化的矩阵，完成缓存后的播放流程不变。

## 验证

```bash
npm run build
node --experimental-transform-types --test src/cadImport.test.ts src/videoOverlayResources.test.ts src/videoOverlaySpatialBinding.test.ts src/videoOverlayOcclusion.test.ts
node --test tests/video-overlay-cache-signature.test.mjs
node tests/scene-library-pos-regression.mjs
node tools/verify-video-overlay-cad-tilt.mjs
```

浏览器脚本使用合成 CAD 和视频检查交互、几何、标绘、方案恢复、缓存和退出清理；用户原视频的实际配准效果仍应在本机检查。

## 倾斜问题检查与修复

已复现的导入缺陷：原解析器忽略 DWG 图元和 INSERT 块的 `extrusionDirection`，把局部对象坐标 OCS 直接当作世界坐标 WCS。按照 Autodesk 的任意轴算法，先还原图元所在平面，再依次应用块基点、比例、旋转、插入和父块变换，可恢复正确姿态。LINE、POINT、3DFACE、POLYLINE3D、SPLINE、MTEXT 等原本采用 WCS 的实体不会额外旋转。

此外修正椭圆（`ELLIPSE`）忽略法向的问题：使用 WCS 三维长轴和法向计算短轴，恢复竖向、倾斜平面和负法向椭圆；不再将椭圆短轴强制放在 XY 平面，竖向长轴也不会被丢弃。嵌套块仍按父 INSERT 变换。

同时修正 `POLYLINE2D` 的高程读取：二维顶点的有效 Z 应来自父多段线的 `elevation`，不能让解析器输出的顶点 `z: 0` 将它覆盖。三维多段线保留自身顶点高程。

回归案例：块内一条 100 m 线的末端坐标为 `(0, 70.7107, -70.7107)`，块参照法向为 `(0, -√0.5, √0.5)`。正确组合后末端应为 `(0, 100, 0)`，是水平线；旧解析遗漏块的局部坐标转换，仍保留 −45° 倾斜。修复后该案例及非默认法向圆弧、二维多段线、文字、面和嵌套块测试通过。

参考：
- [Autodesk：对象坐标系 OCS 与图元类型](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-D99F1509-E4E4-47A3-8691-92EA07DC88F5.htm)
- [Autodesk：椭圆的 WCS 长轴及法向](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-DXF/files/GUID-107CB04F-AD4D-4D2F-8EC9-AC90888063AB.htm)
- [Autodesk：任意轴算法](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-DXF/files/GUID-E19E5B42-0CC7-4EBA-B29F-5E1D595149EE.htm)

现有 `.cadimport` 的顶点已经固化，且没有保留图元法向。以下旧资源需要从原 DWG 重新生成导入文件：包含非默认图元/INSERT 法向并已错误烘焙方向的资源；二维多段线父 elevation 被顶点 z=0 覆盖的资源；包含被错误处理的倾斜、竖向或负法向椭圆的资源。仅凭旧 `.cadimport` 不能完整识别这些条件，需对照原 DWG，当前未收到原图，无法列出具体文件名。本更新不猜测、更改旧顶点。整幅一致坡度偏差可用双轴倾角微调，混合图元各自的坐标方向错误应通过重导入解决。

另一个需要区分的现象是高程显示方式：地图中的贴地/依附模型 CAD 在融合中会生成按图纸标高显示的临时副本，而已采样高程的非贴地 Entity 保留其顶点高程。两者显示不同并不必然代表 CAD 本身倾斜。本次没有自动压平 CAD，以免丢失真实设计高差。

截图无法唯一确定原因；本次已修复可复现的坐标方向缺陷，用户截图对应的实际效果仍需以原 DWG、视频和融合方案在原部署环境核验。
