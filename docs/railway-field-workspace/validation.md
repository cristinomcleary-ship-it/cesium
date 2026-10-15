# 现场工作台改造验证记录

日期：2026-10-14。验证对象为 `codex/machinery-integration-20261013` 分支中的真实 Cesium 应用改造。本文记录独立代码审查和实际执行的自动化检查，不将静态 Demo、代码审查或 Node 测试视为浏览器验收。

## 已执行的独立回归

统一命令前缀：

```bash
node --experimental-transform-types --import ./tools/test-module-loader.mjs --test
```

| 批次 | 测试文件 | 结果 |
| --- | --- | --- |
| 场景与显示 | `src/railSafetyScene.test.ts`、`src/railSafetyFallDemo.test.ts`、`src/railSafetyDisplay.test.ts`、`src/sceneDisplayStore.test.ts`、`src/railSafetyTaskView.test.ts`、`src/management/coordinationView.test.ts`、`src/management/workpointRelations.test.ts` | 65 通过，0 失败 |
| 服务端和权限 | `server/management/libraryPermissions.test.ts`、`server/management/machineryHttp.test.ts`、`server/management/railSafetyHttp.test.ts`、`server/management/railSafetyRisk.test.ts`、`server/management/railwayTask.test.ts` | 28 通过，0 失败 |
| 新工作台视图逻辑 | `src/management/fieldView.test.ts`、`src/management/fieldSceneState.test.ts` | 13 通过，0 失败 |

以上三批独立执行合计 **106 项通过，0 项失败**，与以下整合测试存在重叠，不重复相加。

最终整合执行 **19 个测试文件，146 项通过，0 项失败、0 项跳过**。包括上述文件及 `src/management/workflows.test.ts`、`server/management/taskResources.test.ts`、`server/management/reliabilityHttp.test.ts`、`server/management/libraryEvidence.test.ts`、`server/managementStore.test.ts`。作业机械引用新增校验覆盖跨项目、不可见设备、非法类别、去重、解除关联、受限账号和不修改原安全配置。完整结果见交付包 `validation/tests.log`。

`npm run build`（TypeScript + Vite 生产构建）通过。保留现有大 chunk 构建提示，本轮未进行打包拆分改造。最终构建日志见交付包 `validation/build.log`。

覆盖的关键行为：

- 机械目录按可见设备编号去重，包含未布置、隐藏及停用设备；已删除记录不进入现场汇总。
- 缺模型、缺配置、未选限界、待计算、未保存草稿及不完整结果保持待核实；不会生成代表安全的数值零。
- 已知交叉仍保留，即使另一个选中限界待核实；全部限界有效且均不相交时才显示本次筛查未发现交叉。
- 已有真实 GLB 倾覆演示、模型副本生命周期、投影失败处理、动态效果、透明立面和分组显示偏好不被替换。
- 机械保存、管控配置和筛查问题登记继续经过真实 HTTP、SQLite、版本校验、幂等及权限控制；冻结问题来源保持独立于当前机械修订。
- 任务暂停与恢复继续重新检查适用条件；界面入口简化不构成开工或收工条件豁免。
- 作业选项独立于此前进入的资料或管理页面；只依据当前可见任务和明确工点关系生成。

## 集成代码审查

已检查并在实现过程中修正以下接线问题：

1. 旧工作台点击限界、人员和倾覆范围仍使用原有选择和草稿确认流程；新回调只接管管理场景。
2. 无对象编号的“配置限界 / 布置防护人员”进入正确类别，并沿用原创建与权限流程。
3. 旧版或无效问题来源回退到原空间定位路径，避免递归调用。
4. 管控面板切换机械同步现场选中对象；面板关闭后不会返回旧机械概览。
5. 从现场打开具体作业或处置单保留当前三维场景，以原有业务抽屉继续办理。
6. 原生机械、管控编辑器和显示目录挂在稳定的宿主元素上；场景刷新不替换其 DOM。显示目录复用单个 `SceneDisplayPanel` 和原有账号/项目显示偏好存储。
7. 切换项目、账号和权限继续清理旧场景上下文；首次进入现场受模型权限及实际场景项目约束。

采用保留 CRLF 的空白检查：

```bash
git -c core.whitespace=cr-at-eol diff --check
```

该检查已通过。新样式同时经过静态审查，检查了旧场景规则覆盖、固定编辑器停靠、隐藏属性和窄屏布局；这不代表已在浏览器中验证像素布局。

## 真实环境验收待办

本轮未执行真实浏览器画面、鼠标交互和 GPU 渲染验收。交付后应在原项目数据、工程模型和同一登录账号下完成：

1. 有模型权限账号默认进入现场；无模型权限和未接入场景的项目进入可用业务页面，且不显示其他项目场景。
2. 核对三台或更多实际机械全部计入目录与汇总；选中、隐藏、停用及未配置状态与台账一致。
3. 点选机械，调整布置，切换右侧页签，再回到编辑器，确认草稿保留；保存和取消各验证一次。
4. 进入倾覆分析，播放、暂停和拖动角度；核对模型副本、姿态投影、已选限界和已保存筛查结果之间的关系。
5. 新建限界与防护工作区，调整立面、透明度、颜色及流动/呼吸效果；创建跨类别显示组并整组显隐，确认筛查结果不随隐藏而消失。
6. 在有已保存交叉来源时登记问题，打开处置单、办理与复核，再回到当前机械；确认历史来源和当前修订分别呈现。
7. 从选中机械快速建立可选作业卡，核对设备与工点预填、保存后关联、任务权限及原开工/收工条件。
8. 在桌面和窄屏分别核对目录、三维取点、右侧面板、滚动、底部汇总和视频播放器没有遮挡关键操作。

人员定位器接入不属于本次开发范围。
