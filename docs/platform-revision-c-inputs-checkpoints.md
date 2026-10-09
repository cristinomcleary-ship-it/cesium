# C5 实际输入盘点与独立检查点门槛

本次只读检查日期为 2026-10-09。真实原片、轨迹和生产 3D Tiles 已找到并绑定当前文件身份；正式录像记录没有保存拟合点或独立检查点，可靠垂直基准和独立相机标定也未提供。因此配准精度、绝对位置/高程误差、真实可见覆盖率、最长失定位时间均为 `null`，不能据画面能显示、Shader 就绪或性能数值称为精度通过。

## 本次实际输入

证据位于 `output/platform-revision-20261009/C/input-audit/`。该目录由本次读取创建，未复用旧验收结论。

| 输入 | 实际核查结果 |
| --- | --- |
| 当前录像 | 正式 `view.json` 指向 `34e037f1-a0cd-4388-9904-0ff9dc0a9a9b`；原 MP4 在其 `video` 目录，630,987,789 字节 |
| 原片规格 | 本次 ffprobe：3840×2160，HEVC，30000/1001 fps，115.682233 秒，time base 1/30000 |
| 原片 SHA256 | `23a7b793b9fcb0d947c5016c886942f2e130470fbd615e1dff161c559e6f7aa7` |
| 轨迹 | 同记录 `source` 原 JSON，3467 个点，EPSG:4326；遥测时间从 0 到 115649 ms |
| 轨迹 SHA256 | `62bf1166d69bcb34d6f99934668c6c277c91ee8821628b9e928ab908b4ccd604` |
| 当前模型 | 资产 `8bc58629-cf26-45de-986e-086479db11a0` 的真实 Production_2；保存变换为单位矩阵 |
| 模型完整树 | 正式库 `tiles` 下 18,193 文件、1,105,851,552 字节，逐文件 SHA256；不是只哈希根 tileset JSON |
| 模型清单身份 | `b5707287f862571f08aeacddd8518df0820ee614a80141d769044683998d0147`；算法为排序后的相对路径、字节数、文件 SHA 数组的紧凑 UTF-8 JSON 哈希，不含尾换行 |
| 模型变换身份 | `0f36cca62777641607fd679703c055e82783f96f03c682cafbc7404d49a5ba08` |
| 相机档案 | 历史 V2 派生档 `output/ar-v2-quality/media/camera_profiles.json` 仍为 `estimated-v1`；本次重新哈希 `609c1618f33d987d3eef82d4dea570706acc2dc6e9ac2f893ca36a31cd16b08c` |
| K / D | 原轨迹 K 为 35mm 等效焦距估算，fx=fy=2560、cx=1920、cy=1080；SRT 没有独立镜头畸变数据。派生档中的 D=0 不能当作实测无畸变 |
| 姿态与安装关系 | 有云台姿态；原轨迹明确机身姿态不在 SRT 中，没有独立核验的相机安装外参档案 |
| 拟合与检查点 | 4 条正式 Drone Video 记录 `calibrationSessions` 均为空；当前 `output/ar-v2-quality/resolved-config.json` 没有 `validation.checkpoints_path` |

轨迹中的 `altitude_reference=absolute` 只描述源字段；不能据此认定为椭球高。`ground_altitude_m=29.116` 是现有派生数值，没有可靠垂直基准证明，本次没有把它作为已知高差写入任何模型或业务记录。

当前记录 `localPath` 指向 `F:/cc/XS2026.9.4/Productions/Production_2/Scene`。对本项目 `F:/cc/XS2026.9.4` 递归读取，只确认 Production_1/2 的生产结果和 `metadata.xml`；未找到 `.ccm/.ccmx/.3mx/.3mxb/.obj/.fbx/.ply/.las/.laz` 源项目或可核验源网格候选。两个 metadata 仅含可见光纹理来源，没有坐标/高程标定证明。其他工程目录的模型不能替代本项目源工程。应明确写成“生产模型存在，尚缺可验证的编辑/重建源工程及源网格修复服务”，不能写成“原片或全部模型缺失”。

## 固定检查时刻

本次直接读取原 MP4 的视频流包 PTS，没有用四舍五入的请求秒充当真实帧时间：

| 请求秒 | 实际包 PTS | 精确时间秒 |
| --- | ---: | ---: |
| 10.01 | 300300 | 10.010000 |
| 30 | 899899 | 29.996633333333 |
| 60 | 1799798 | 59.993266666667 |
| 90 | 2699697 | 89.989900 |
| 114 | 3420417 | 114.013900 |

所有 time base 为 `1/30000`。输入锁以 `pts:<数值>` 标识原片时刻；`packetOrder` 只表示解复用顺序，**不声称是解码后的图像帧索引**。采集人员须冻结并核对解码后的对应原图与 PTS，补充原图 SHA256。此次盘点没有测像素误差。

## 新增工具及真实运行结果

- `tools/inspect-platform-ar-inputs.mjs`：读正式资料记录、原片、轨迹、完整模型树和现有档案；只写新的 `output` 子目录。输出 `persisted-inspection.json`、`input-inventory.json`、`input-lock.json`、`model-files.sha256.json`、`original-video-probe.json` 和 `checkpoint-validation.json`。
- `tools/validate-platform-ar-checkpoints.mjs`：独立离线证据门槛，不求解、不调参，不修改 UI、Viewer 或业务库。读取固定输入锁和人工观测包，核对五种输入身份、精确 PTS、坐标/基准、校准版本、拟合及调参点清单、每时刻检查点数量和表面覆盖。无效点保留在分母；不足条件时保留空值。
- `tools/validate-platform-ar-checkpoints.test.mjs`：14 项合成逻辑测试通过。覆盖错源、错 PTS、重复点、更名后复用拟合坐标、调参污染、不足 6 点、缺地面/桥面/屋顶/立面、未知高程、旧投影、同帧不同相机、无效投影、差点不剔除、录像时刻覆盖不足。合成测试不代表真实配准通过。
- 实际输入锁运行结果为 `NOT_EVALUATED`，CLI 退出码 2；`actualProjectPixelTargetPassed=false`。具体阻塞是未知垂直基准、未核验相机校准和未提供独立观测。

复现命令（新目录名避免覆盖已有证据）：

```powershell
node tools/inspect-platform-ar-inputs.mjs output/platform-revision-20261009/C/input-audit-new
node --test tools/validate-platform-ar-checkpoints.test.mjs
node tools/validate-platform-ar-checkpoints.mjs output/platform-revision-20261009/C/input-audit/input-lock.json
```

校验 CLI：0 表示该包的像素门槛计算通过，1 表示已测但未达像素目标或输入解析失败，2 表示条件不足未测。还必须阅读 `classification`、`actualProjectPixelTargetPassed`、`problems`，不能用退出码 0 将合成夹具转成实际工程结论。

## 独立观测包合同与补采步骤

观测包 `schema=platform-ar-checkpoints/v1`，实际人工资料分类为 `actual-human-observations`；输入锁和观测包均保存原片、轨迹、完整几何树、模型变换和相机档案 SHA。校准另有 `calibrationSha256`、冻结时刻、实际用于求解的 `calibrationUsedPointIds` 与用于任何人工调参的 `tuningUsedPointIds`。

每项观测保存：稳定 `physicalPointId`、`role=fit/check`、`surface=ground/bridge/roof/facade`、原像素 `observedPixels`、ECEF 米坐标 `worldEcef`、精确 `frame={frameId,pts,timeBase,timeSeconds}`。人工来源保留采集人、采集时刻、原图/选点证据 SHA 和 `usedForFitting/usedForTuning`。CPU 预测另有 `predictedPixels` 与 `projection`，绑定相同原片/模型/校准、同帧相机 SHA、正向深度及有效标记。

1. 保留当前完整输入锁。取得相机 K/D 的原始标定文件和拍摄分辨率/裁切/变焦信息；核验云台姿态轴定义、机身与相机安装关系。确认起飞点或源高程的测量基准与转换依据。不要从 `abs_alt-rel_alt` 推定已知椭球高。
2. 在原片 10.01 秒冻结同一实际解码帧，保存原图及 PTS；使用已有同名点工具采 8–12 个稳定拟合点，分布四周并有高度差。避开车辆、水面、树冠和模型拍摄后发生变化的施工表面。
3. 固定一次相机校准和求解参数并记录 SHA、冻结时刻、所有拟合/调参点稳定编号。最终检查点不能参与拟合、异常点筛选或人为调整；改名也不能让同一物理点成为独立点。
4. 在上述五个固定时刻各取得至少 6 个独立检查点，覆盖地面、桥面、屋顶并复核立面；保存人工对应关系与证据。用同一个校准计算对应相机，不逐帧手工改变全局偏移。若依据检查结果调参，本批点即失去最终检查资格，需要另留新点。
5. 从现有独立 CPU 重投影导出预测和误差，绑定当前解码帧、相机、原图及模型身份，整理为观测包。工具没有独立重新计算光学投影，也不能自动证明人工声明属实；人工来源和预测证据仍需复核，不能只手填小误差。
6. 执行 `node tools/validate-platform-ar-checkpoints.mjs INPUT_LOCK.json OBSERVATIONS.json`。像素门槛按原图宽等比换算 1920：RMS≤3、P95≤6、max≤10；P95 使用最近秩法。不同时间的结果分列，无效点不丢弃，不把拟合内点 RMS 当独立精度。
7. 绝对地理位置/高程误差需另有测量控制点与基准；真实可见覆盖和遮挡需人工标注可见面；失定位与恢复需整片运行记录。这些没有测量时继续留 `null`，不能由图像误差或投影提交 FPS 推定。

当前可补采入口和校验工具已具备；实际精度验收仍受以上真实输入缺项限制。原始视频、模型坐标、正式业务对象及历史报告均未改写。
