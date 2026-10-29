# 机械参数模型模块

该模块加载经过确认的吊机、桩机和挖机源几何，在浏览器内重建尺寸并生成自包含 GLB。它不依赖 `window`、Cesium 或 Vite，因此参数求解和导出可直接在 Node 测试。

## 接入

```ts
import {
  loadMachineryAsset, defaultMachineryParameters,
  resolveMachineryParameters, createMachineryGlb,
} from './machinery';

const asset = await loadMachineryAsset('crane', {
  baseUrl: import.meta.env.BASE_URL + 'machinery/',
  signal: abortController.signal,
});
let parameters = defaultMachineryParameters(asset);
parameters = resolveMachineryParameters(asset, parameters,
  { boom_length_m: 8 }, { proportional: true });
const glb = createMachineryGlb(asset, parameters, { proportional: true });
```

`MACHINERY_CATALOG` 只包含三个模型的 `id/name/type`，不携带几何。`loadMachineryAsset` 只请求选中模型的 manifest 和二进制分块。Vite 的部署前缀由调用方显式传入；默认路径为 `/machinery/`。调用方可以按模型 ID 和资产版本缓存成功结果，失败或取消的请求不应缓存。返回资产使用 `asset.version` 字段；版本常量从 `src/machineryTypes.ts` 共享。

## 参数语义

- 默认值直接取已确认源模型的米制尺寸，整体倍率为 `1`；重置使用 `defaultMachineryParameters(asset)`。
- 内部几何/台账的吊机 `boom_rotation_deg` 为相对源模型姿态的水平回转角，俯视顺时针为正；输入范围 `0..360°`，`360°` 规范化为 `0°`。上车操作室、配重、基础臂、液压支撑、伸展段、吊钩和索具绕回转支承中心一起转动；底盘、车轮及支腿不动。旧记录缺少该字段时按 `0°` 恢复，默认源顶点仍逐字节不变。
- 吊机 `boom_elevation_deg` 为中心线相对水平面的仰角，范围 `0..90°` 仅表示几何配置范围；默认值由源吊臂轴向计算，为 `69.80598827502023°`。旧记录缺少该字段时按源仰角恢复。基础臂、伸展段和臂头绕实测臂根孔轴变幅；上车操作室、配重、底盘和支腿不俯仰。吊钩和下滑轮组仅平移，保持竖向姿态与源悬挂方向；吊索端点分别随臂头和下滑轮组连接点运动。
- 两种角度均为姿态参数，在两种编辑模式中独立于尺寸。改变角度保留当前整机倍率和独立尺寸；改变尺寸或整体倍率保留当前角度。总高度按实际姿态几何重新计算，编辑总高度时以当前角度下的外形求比例；`originalMachineryProportionsMaintained` 只判断尺寸比例，不以变幅后的派生总高度判定比例失真。角度不改变整机地理朝向，不提供独立吊钩升降。
- 默认 `proportional: true`：编辑任一尺寸时，按“目标尺寸 ÷ 该尺寸原始值”计算整机比例，所有尺寸同步。每次重建均从源几何开始，整体倍率仅应用一次。
- `proportional: false`：吊臂和吊钩索具联动伸缩；四个支脚按左右/前后中心整距平移，连接梁联动；桩机可调桅杆段高度，顶部刚性平移。挖机尚无已确认的独立关节控制。所有模型的整体倍率、机身参考高度、整机高度仍用于缩放当前完整外形。
- 切换模式本身不修改参数或外形。使用空补丁 `resolveMachineryParameters(asset, current, {}, options)` 保留当前形状；模式表示**下一次编辑规则**。独立编辑后的形状可能不符合源比例，即使随后已切换为联动模式。
- `changes` 是编辑补丁，通常仅含一个键。联动模式下多个尺寸键的最后一个字段作为驱动，角度单独应用。恢复保存记录时，把完整参数作为 `current` 并传空补丁，不能把保存快照当作一次编辑。
- 恢复和导出会校核机身参考高度及真实总高度；存档参数与几何不一致时明确拒绝，不静默改形。几何 API 接收已求解的完整参数。
- `body_height_m` 是从地面到源模型固定机身上沿的参考尺寸，不是额外局部拉伸参数。吊机支腿距离为支脚中心线之间的整距，不是单侧伸出量。
- `config.local_parameters` 中的最小值只是当前几何分件避免反转的约束；整体缩放后独立尺寸的可用最小值相应乘以倍率。没有假定厂家最大尺寸。尺寸输入须为大于零的有限数值，角度允许零；超出浮点渲染范围时拒绝生成。

GLB 元数据分别记录 `editMode` 和 `originalProportionsMaintained`，防止把编辑规则当作现有外形认证。参数几何没有厂家载荷曲线、重心或稳定性计算，不能据此判定机械报验状态或倾覆安全限界。

## 坐标、颜色和放置

紧凑资产保留原始世界坐标、顶点顺序、三角面顺序和部件编号。坐标已经是 Y-up、米制，禁止再次按 FBX 原单位换算。`computeMachinerySourcePositions` 返回世界坐标重建结果，主要用于验证。

`computeMachineryGeometry` 和 `createMachineryGlb` 将派生坐标减去固定原始地面 anchor，使落点为 `[0, 0, 0]`；默认姿态最低有效几何的 Y 为零。低仰角可能使吊钩低于原始地面基准，`bounds.min[1]` 将真实返回负值，平台显示提示；不能借此判断与真实地形的碰撞。模型不会为避开地面而抬升整机或缩短吊索。源数组不改变。Cesium 放置时只需地理位置和朝向变换，不再归中、缩放或额外落地平移；引擎本身不包含 Cesium 的 Y-up 到 Z-up 转换。

GLB 的 +X 为模型参考方向，物理机头方位未统一标定。平台将该参考轴的朝向记为从北顺时针的角度，不作为测量方位。“整机旋转”沿用 `placement.heading`，围绕固定地面锚点旋转整台设备；不进入几何参数或吊臂相对角度，纯朝向改变复用同一 GLB，保存格式不变。

源资产完整保留 FBX 原数值漫反射 RGB。`appearance.ts` 在 GLB 导出时匹配已核对的原颜色分区，生成 `construction-vivid/v1` 展示配色；新增色值明确按 sRGB 编写，再转为 glTF `COLOR_0` 要求的线性 RGB。吊机的原漆面中，仅对完整伸缩臂和支腿部件作深色/黄色区分；金属、玻璃、灯具和管线保持各自分区。源 palette、面颜色索引、顶点和尺寸均不修改。GLB 元数据记录配色方案、命中颜色数量和来源边界。

显示继续使用逐面法线、双面 PBR 材质和原场景光照，不使用全模型统一染色或无光照材质。未烘焙缺失贴图、品牌字样、透明材质或 V-Ray 材质。原始零面积面仅在生成可显示 GLB 时剔除，并记录数量。

## 资产与验证

三个模型的二进制总计 4,838,822 字节，分为 11 块，每块最多 512 KiB。manifest 包含分块 SHA-256、数组范围、源参数和部件几何常量。加载时检查版本、结构、有限数值、索引及颜色；支持 WebCrypto 的环境同时校验 SHA-256。

吊机的源 FBX 为无关节层级的平铺网格。`tools/crane_slew_mapping.json` 固化已检查的 259 个完整连通部件为 30 个顶点区间（19,873 个上车顶点）；旋转不拆三角面，保留其余 20,769 个底盘与支腿顶点。回转中心由源部件 440 的圆形支承测得，为 `[4.144531410217285, 0.14201061248779298, 1.5858951414752938] m`，支承半径约 `0.072 m`。这属于模型几何示意，未标定厂家回转机构、机械干涉或载荷能力。打包时核对原始顶点、索引、部件数组的 SHA-256；只增补配置，所有二进制块保持不变。运行时重新验证 manifest 缓存，拒绝缺少回转信息、包含支腿或拆分三角面的映射。

`tools/crane_elevation_mapping.json` 记录变幅部件、吊钩、柔性索具端点和两组液压缸的原始顶点区间。臂根铰点为 `[4.223078053388381, 0.2899679306921732, 1.4453555308941195] m`，由源部件 129 的 96 个圆孔边缘顶点拟合；孔半径约 `0.006300008 m`，最大拟合残差 `8.33e-8 m`。液压缸筒 108/111 绕固定下销轴转动，活塞杆 188/189 及杆端组件随上销轴运动，两部分均保持原始刚性尺寸，以重叠量变化表示伸缩。模型未验证厂家行程或内部干涉，几何可调范围不是作业许可范围。

重建顺序为独立尺寸、变幅及液压／索具跟随、上车回转、整机缩放。卷扬索具 467 的根部仍固定，位于基础臂导轮的中间端点在吊臂伸长时保持站位，臂头端点随伸展段移动；变幅时导轮端点和臂头端点随吊臂移动，卷扬根部保留在上车机构。默认源姿态直接返回未变形数组，保证原始几何精确一致。

从已审阅的 `model_data.json` 可重复打包，脚本只写目标目录，验证源顶点、索引、部件和颜色逐字节往返一致：

```sh
python src/machinery/tools/build_assets.py --source /path/to/model_data.json
node --experimental-transform-types --import ./tools/test-module-loader.mjs --test src/machinery/machinery.test.ts
```

测试覆盖原始默认值、地面 anchor、每个尺寸驱动的联动、反复修改与重置、独立变形及全局缩放组合、模式切换、无效参数、按模型加载、损坏资产拒绝、GLB 字节结构、颜色与有限单位法线。

## 实时场景显示

`runtimeGeometry.ts` 为同一源资产生成一次参数化 GLB，静态逐顶点属性编码原引擎伸缩权重和部件分组；CustomShader 按同样的独立尺寸、仰角、索具/液压、回转及整体缩放顺序变换。实时场景只更新参数与矩阵，不逐包重建 GLB。`runtimeGeometry.test.ts` 将全部源顶点的变形与原几何引擎逐一核对。原 `createMachineryGlb` 仍生成指定姿态的米制快照，用于倾覆演示与既有导出。

`machineryEditorParameters.ts` 在界面边界将吊臂角转换为背车头共线零位；内部存储不迁移。`MachineryScene.getRenderState(id)` 提供目标姿态和当前插值姿态用于验收，不能再用常驻 GLB 的源参数代替实际显示姿态。
