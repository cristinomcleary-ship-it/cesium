# 铁路施工统筹改版验证记录

记录日期：2026-10-14。

最终统一回归：**72/72 通过**，0 失败、0 跳过、0 取消。当前没有本轮浏览器验收结论。旧版本的测试数量、浏览器截图及 Demo 演练不计入本轮验收。

## 最低验证矩阵

| 范围 | 需要确认的行为 | 现有验证入口 |
| --- | --- | --- |
| 今日管控与任务汇总 | 只统计可见数据；日期、状态及明细一致；机械按唯一编号去重；未配置或未知条件不显示通过 | `src/management/coordinationView.test.ts`、`src/management/metricsState.test.ts`、`server/management/dashboardMetrics.test.ts`、`src/railSafetyTaskView.test.ts` |
| 身份、权限和范围 | 真实登录、角色及任务范围生效；先授权再返回冲突细节；新字段和新命令不能绕过旧权限 | `server/management/reliabilityHttp.test.ts`、`server/managementStore.test.ts`、新增统筹 HTTP 测试 |
| 条件及业务状态 | 必需条件、证据和版本正确；内部确认不替代外部许可；暂停、恢复和收工按实际实现单独核验 | 新增统筹 HTTP 测试；`server/management/reliabilityHttp.test.ts` |
| 草稿与重复提交 | 表单草稿不意外提交；服务器保存失败不冒充成功；幂等重试及修订冲突不产生部分写入 | `src/management/workflows.test.ts`、`server/managementStore.test.ts`；浏览器待核验 |
| 资源与工点关联 | 关联只使用可见记录；共享对象去重；计划安排与实际投入、资格和就绪状态分别处理 | `src/management/workpointRelations.test.ts`、`server/management/resourceUsage.test.ts` |
| 既有机械风险处置 | 草稿几何不可登记；来源修订与历史快照保持；关闭问题单不改变当前筛查结果 | `server/management/railSafetyRisk.test.ts`、`src/railSafetyTaskView.test.ts` |
| 编译与打包 | TypeScript 与生产构建完成；没有引用缺失、类型错误或错误导出 | `npm run build` |
| 实际界面与三维 | 导航、抽屉、右侧显示控制、不同视口、键盘操作、保存失败提示及 Cesium 联动 | 待在获准的浏览器环境执行；非浏览器检查不能替代 |

## 可用命令

当前执行环境为 Node.js v24.19.0。项目未定义 `npm test`。TypeScript 测试使用 Node 测试运行器；加载器处理 Vite 源码的无扩展名及 JSON 导入。

```bash
node --experimental-transform-types --import ./tools/test-module-loader.mjs --test \
  src/management/coordinationView.test.ts \
  src/management/workflows.test.ts \
  src/management/workpointRelations.test.ts \
  src/management/metricsState.test.ts \
  src/railSafetyTaskView.test.ts \
  server/managementStore.test.ts \
  server/management/dashboardMetrics.test.ts \
  server/management/reliabilityHttp.test.ts \
  server/management/resourceUsage.test.ts \
  server/management/railSafetyRisk.test.ts \
  server/management/railwayTask.test.ts

npm run build
```

新增后端测试为 `server/management/railwayTask.test.ts`。HTTP 测试使用测试夹具、临时数据库和回环地址临时端口，不应使用真实用户数据或生产数据库。

## 交付脚本检查

- `tools/build-platform-v5-delivery.py` 绑定旧 V5 基线、十四项验收及旧画面素材，不能直接作为本轮打包或验收依据。
- `tools/build-management-delivery.py` 绑定旧管理平台报告、数据保留指纹和媒体清单，不能把旧报告当成本轮通过结果。
- `tools/verify-platform-v5-delivery.cjs` 包含浏览器启动及 Windows 专用路径，本轮不执行。
- 本轮更新包应依据实际改动生成文件清单及校验信息，排除数据库、真实上传、账号配置、浏览器状态、`node_modules` 和本地运行输出。

## 执行结果

使用上文命令一次运行全部十一个测试文件，**72/72 通过**，0 失败、0 跳过、0 取消，耗时 **2474.608038 ms**。这是不重复的统一运行总数，开发期间的分组运行不另行累计。

其中新增后端 `server/management/railwayTask.test.ts` 六项，覆盖：

- 北京时间分钟字段、跨日窗口、无效日期和格式拒绝、成对清空及重启持久化。
- 旧任务未填写铁路字段仍可使用，许可编号不补出缺失的准入规则。
- 暂停和恢复的状态限制、重复提交、修订冲突、本人负责任务权限、只读账号和跨任务访问限制。
- 恢复前重新核查条件，阻断问题整改待复核、复核退回时仍拒绝恢复；失败操作不追加状态或确认历史。
- 暂停期间历史实绩及现场记录的补录不自动恢复，恢复也不替代完工验收；历史统计仍保留截止时点状态。
- 历史上已实施但未配置条件规则的任务可以暂停，恢复时必须重新核查，不能自动放行。

新增 `src/management/coordinationView.test.ts` 十项纯函数测试，覆盖六入口与旧业务路径映射、跨日窗口在 UTC / 上海 / 洛杉矶时区下的一致性、00:00 结束时不计入次日、缺日期和缺铁路字段、条件响应缺失或来自其他任务及旧修订时保持未知、设备编号去重并保留未配置及停用设备、问题终态、暂停任务待办统计，以及 CSV 引号/逗号/换行往返、公式保护、未闭问题多任务关联计数和可见任务范围。原有工作流文件新增暂停任务批量安排的兼容检查。

最终源码的 `npm run build`（TypeScript + Vite）已执行通过，进程退出码为 0，Vite 构建耗时 18.77 秒，存在大于 500 kB 的既有模块体积提醒。最终构建已包含小屏六入口、三维顶部导航和暗色任务抽屉的样式修正。

静态核对已确认新增两个作业窗口字段独立处理：表单步长为分钟，显示与提交保留北京时间文本，不走已有日期时间字段的 UTC 转换，更新时允许成对提交空值。该静态核对不等同浏览器输入、点击及布局验收。

同时核对手机端使用相同六入口、任务收工检查入口预填 `purpose: acceptance`、新导航继续经过未提交草稿保护，以及条件缓存按项目、账号、快照修订和任务修订区分。

源码空白检查按仓库原有 CRLF 约定执行 `git -c core.whitespace=cr-at-eol diff --check`，通过；未为检查而重写既有文件的行尾格式。

本轮未启动浏览器或预览服务。实际界面尺寸、滚动、输入控件、键盘操作、三维场景联动及目标设备性能仍需在部署后的浏览器中核验；CPU、HTTP 和构建通过不替代这些检查。
