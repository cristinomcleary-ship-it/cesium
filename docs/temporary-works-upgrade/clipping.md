# 临建摄影遮挡管理器

实现：`src/temporaryWorksClipping.ts`。每个 Viewer 创建一个 `TemporaryWorksClippingManager`，将每个可见临建经过平移、旋转、缩放、底面基准点修正后的真实底面传入 `upsert`。同一摄影模型上的方案在同一个集合中取并集，`inverse: false`，仅删除任一底面内部的摄影片元。建筑本身作为独立 Model，不加入目标摄影的裁剪集合。

```ts
const clipping = new TemporaryWorksClippingManager(viewer);
const result = clipping.upsert({
  id: plan.id,
  tileset: selectedPhotogrammetry,
  footprints: [{ outer: worldOutline, holes: worldCourtyards }],
  visible: plan.visible,
  enabled: plan.photogrammetryOcclusion,
});
// result.state: active / hidden / disabled / blocked / unsupported
// result.message 用于界面状态提示；blocked/unsupported 不能报告遮挡成功。
clipping.setVisible(plan.id, false);
clipping.setPlanEnabled(plan.id, false);
clipping.remove(plan.id);
clipping.setEnabled(false); // 撤销本模块全部遮挡，保留记录供恢复。
clipping.dispose(); // 释放自身集合和 postUpdate 监听。
```

## 坐标、孔洞和尺寸

- 输入为 WGS84 世界经纬度。`Cartesian3.fromDegrees` 生成世界 ECEF 坐标；不得再乘摄影模型的 `modelMatrix` 或根变换。建筑自身的变换应在传入底面之前完成。
- 高度不用于裁剪边界：Cesium 多边形裁剪沿地心方向贯穿摄影瓦片。建筑是否覆盖摄影由平面底面决定，不能用抬高建筑代替裁剪。
- Cesium `ClippingPolygon` 只有单个外环接口，没有 polygon hierarchy/holes 接口。带孔建筑通过 `ShapeUtils.triangulateShape` 将“外环减孔洞”分解成多个三角形，再使用多个 ClippingPolygon 求并集。剖分结果必须通过面积守恒复核。
- 支持正反绕向、凹外环、多个互不接触的孔洞。拒绝自相交、重复顶点、退化面、孔洞越界、孔洞交叠或相互包含。无效更新不会替换已生效的上一版方案。
- 局部拓扑检验限制为相对首点经纬度跨度不超过 1°，不支持极区（纬度余弦小于 0.01）。该限制防止错误单位或异常坐标扩展为大面积错误裁剪；这些情况明确报错，不能静默改用包围盒。

## 所有权与回退

只使用选定摄影对象的 `clippingPolygons`，不写 globe、样式、customShader、modelMatrix、clippingPlanes 或其他摄影图层。若目标已有外部 `clippingPolygons` 或 `clippingPlanes`，返回 blocked，不替换、不禁用、不销毁外部集合。外部功能撤销后可自动恢复。

集合更新一次性替换整个本模块集合，不将空集合提交到 GPU。隐藏、删除、切换目标仅重建受影响目标的剩余底面；最后一个方案隐藏或删除后通过 Cesium setter 撤销本模块集合。setter 本身会销毁旧集合，因此不再重复 destroy。

`postUpdate` 检查所有权丢失和摄影卸载。外部功能替换集合后，本模块保持 blocked；销毁管理器时仅处理仍由自己持有的集合，不能销毁外部替换结果。没有变化的帧不重建集合、不重复请求渲染。

刷新后应先加载原方案数据与摄影，再逐条 `upsert`。不持久化 Cesium 对象，仅保存底面所需的资产/定位/尺寸参数以及显隐、遮挡开关；每次恢复重新计算世界底面。

## 版本核验与自动测试

依据仓库锁定的 Cesium `1.144.0` / `@cesium/engine 26.2.0` 实际安装源码：

| 核查位置 | 核查结论 |
| --- | --- |
| `ClippingPolygonCollection.js` constructor / inverse | `inverse:false` 裁去任一多边形内侧；多个多边形按并集工作 |
| `ClippingPolygonCollection.setOwner` / `Cesium3DTileset.clippingPolygons` setter | 替换或赋 undefined 会销毁旧集合；同一集合不允许多个 owner |
| `ClippingPolygonCollection.isSupported` | 运行时检查 WebGL 2；不支持时不安装裁剪 |
| `ClippingPolygon.js` options | 仅 positions 外环；孔洞需在应用侧分解 |

命令：

```bash
node --import ./tools/test-module-loader.mjs --experimental-strip-types --test src/temporaryWorksClipping.test.ts
```

14 项 CPU 测试使用真实 Cesium3DTileset、ClippingPolygon、ClippingPolygonCollection 和真实 setter/destroy 行为，仅 Viewer/WebGL 场景接口由测试替代。覆盖重叠临建并集、逐项显隐删除、全局回退、外部两类裁剪保护、外部替换、跨摄影迁移、世界坐标、凹环与多个孔洞、无效拓扑、WebGL 1、刷新恢复、无变化帧和摄影卸载。

这些测试不能证明 GPU 裁剪的实际视觉效果。生产构建的浏览器验收还必须检查：真实 GLB 和真实/明确标注的测试摄影网格，遮挡前后同视角截图，建筑内无摄影穿透，孔洞摄影保留，多个重叠/不重叠建筑，隐藏/删除后恢复，旋转缩放后跟随，以及与外部裁剪的占用提示。高频细碎底面和孔洞的三角化边缘需检查 Cesium 距离纹理精度；当前 quality=2，未以 CPU 测试代替 GPU 质量验收。
