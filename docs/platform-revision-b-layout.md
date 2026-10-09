# B 批：管理与三维布局、可读性和响应式验收

本记录覆盖任务书 B1、B2、B5 的样式部分。业务联动、真实 Cesium 模型和视频的运行结果由 B 批总验收另行记录。本记录中的截图来自隔离 DOM 夹具，包含明确构造的任务和空间对象，不是实际工程网格或 GPU 渲染证据。

## 改动与接入

- `src/managementStudio.css`：把原有分散的 10 段管理样式作用域整理为一段，统一浅色管理、深色三维的字级、间距、状态颜色和按钮。正文 14 px、表格 13 px、辅助信息 12 px；浅色 `details/summary` 显式重置，避免继承原三维界面的黑底。
- `src/managementWorkspace.css`：使原模型优化、绘制编辑、Cesium 图例与新的顶栏、340 px 侧栏协调。保留原 Viewer、工程数据和坐标转换。
- 桌面三维左侧宽 260 px，右侧宽 340 px。尚未选中对象时隐藏右侧详情；两侧可各自折叠。由现有工作区上的 `.mg-scene-no-selection`、`.mg-scene-left-collapsed`、`.mg-scene-right-collapsed` 状态统一控制可用场景范围。
- 1366 px 保留业务日期；390 px 用 104 px 双行顶栏保留项目、账号和搜索。移动端主要按钮具有 44 px 操作高度；底部工具区保留安全区。
- 对象搜索、来源信息折叠、工点摘要及放弃编辑操作使用现有页面组件。搜索结果和业务选择的实现见 `src/managementStudio.ts`，没有增加独立交付页面。

## 可复现验证

在仓库根目录使用两个 PowerShell 窗口。第一个窗口运行已有的隔离 UI 配置：

```powershell
& 'F:\Node.js\node.exe' node_modules/vite/bin/vite.js --config tools/vite.management-ui.config.mjs --host 127.0.0.1 --port 5241 --strictPort
```

第二个窗口：

```powershell
$env:CESIUM_LAYOUT_BASE_URL = 'http://127.0.0.1:5241'
$env:CESIUM_LAYOUT_OUT = 'output/platform-revision-20261009/B/layout'
& 'F:\Node.js\node.exe' tools/verify-platform-layout-ui.cjs
```

`PLAYWRIGHT_MODULE` 与 `CHROMIUM_EXECUTABLE` 可分别指定本机 Playwright 模块和 Chromium/Edge 路径。测试只打开 `tools/fixtures/management-studio-ui.html`，拦截所有 `/__management/**` 请求，用 25 条合成任务和空间对象验证布局。它不读取或写入正式项目数据，不创建 Viewer，浏览器使用 `--disable-gpu`。生产应用启动方式不变。

## 本次结果

脚本实际运行通过 **18 项断言**；结果与样式源文件 SHA-256 存在 `output/platform-revision-20261009/B/layout/report.json`。无页面 JavaScript 异常。

| 检查 | 结果与证据 |
| --- | --- |
| 1920×1080、1366×768、1093×614、390×844 | 项目、账号、搜索可见且不越界，无页面水平溢出；桌面业务日期可见 |
| 1366 px、无选择的三维工作区 | 左侧 260 px、右侧隐藏，中央可用范围 1066 px，约为视口宽度 78% |
| 25 个对象的搜索与选择 | 能找到第 25 个对象；选中后打开 340 px 详情；右侧和左侧分别折叠后场景宽度超过 1300 px |
| 浅色任务表单的展开信息 | 背景透明、正文为浅色主题深色文字，未继承全局黑底 |
| 命名颜色变量的对比度 | 浅色正文 12.61、辅助文字 5.36、主按钮白字 5.63；深色正文 13.99、辅助文字 8.68、主按钮 5.87、链接 9.47 |

颜色结果仅针对报告中列出的前景/背景变量组合，不代表每个组件或全部 WCAG 条款均已通过。

截图文件：

- `management-1920.png`、`management-1366.png`、`management-1093.png`、`management-390.png`
- `scene-no-selection-1366.png`、`scene-selected-1366.png`
- `form-light-details-1366.png`

以上文件均位于 `output/platform-revision-20261009/B/layout/`。已实际查看 1366 px、390 px 以及三维工作区两种侧栏状态的截图。样式冻结时 TypeScript 类型检查和 `git -c core.whitespace=cr-at-eol diff --check` 通过。

## 边界与尚需结合总验收的项目

1. 1093×614 是 1366×768 在 125% 缩放下的近似 CSS 空间检查，并非原生浏览器缩放操作证据。
2. 此脚本的空间对象和任务是合成夹具，不能据此认定真实工程模型、摄影纹理、视频播放、鼠标拾取或工程精度已通过。
3. 折叠、布局和可读性已测；真实 GPU 模型下的视角、帧率、视频与业务操作录像由总验收单独给出。该脚本不测性能，也不改业务权限和持久化数据。
4. 回退只涉及上述两份 CSS；脚本和本文是验证工具与说明，无数据迁移。整批回退应使用 B 批独立提交的反向提交，保留之后的工程数据。
