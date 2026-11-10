# 模型编辑、外观与 AR 分层缓存验证记录

基准：`v1.2.1 / e62ef4aa2c0c515cb681d546a43f90e8c3de5dd1`。范围为模型编辑、模型外观、AR 标注缓存；施工工序仅提供实施方案。

| 检查 | 结果 |
| --- | --- |
| `node tools/run-temporary-works-regression.mjs all --output output/model-edit-ar-final` | 1570 项：1569 通过、0 失败、1 跳过 |
| `node tests/model-placement-regression.mjs` | 通过：模型锚定、编辑锁定、偏心枢轴、旋转辅助轴、Shift 微调、嵌套暂停、拖动相机锁和释放 |
| `node tests/video-overlay-cache-boundaries.mjs` | 4 条场景通过：异步取消、音频尾部时间区间、退出后诊断及新旧会话隔离 |
| `npm run build` | TypeScript 与 Vite 生产构建通过 |
| `git diff --check` | 通过 |
| 浏览器验收脚本语法 | `node --check` 通过 |
| 模型编辑/外观浏览器验收 | 未执行到用例：Chromium 启动受环境 Unix socket 权限限制 |
| AR 视频空间标注/编码浏览器验收 | 未执行到用例：同上；备用受控浏览器也无法连接隔离 localhost |

跳过项是现有 Windows x64 专属“转换器源码与可写缓存目录分离”用例；当前为 Linux 环境。生产构建仍有既有 libredwg 浏览器兼容提示和大 chunk 提示，构建成功。

新回归覆盖原材质恢复与透明度不累乘、真实 Cesium 照明参数边界、资料外观恢复、场景操作入口、标注修改不使基础缓存失效、基础帧不烘焙标注、导出使用原绝对时间、空间坐标含模型比例与畸变、旧缓存隔离、分层缓存保留，以及异步选点取消与异常清理。

自动回归覆盖代码逻辑与已有功能用例，不能代替本机真实 SKP/CAD/视频在 GPU、解码器和 SketchUp SDK 环境中的验收。两份浏览器脚本已随源码提供：

- `tests/model-edit-appearance-browser.mjs`
- `tools/verify-video-overlay-spatial.mjs`

未连接、部署或修改用户本机运行服务及项目数据。部署与本机验收步骤见 `CODEX_LOCAL_DEPLOY_MODEL_AR.md`。
