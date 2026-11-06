# v1.2.0 基线回归

2026-11-05，在独立的只读基线工作树中检查标签 `v1.2.0`，对应提交 `2258754ce810002fa4fd80db3df90c20f4299f2b`。该工作树不含本次功能改动，使用锁文件安装的依赖与 Node.js `v24.22.1`。没有访问正式生产环境。

| 检查 | 范围 | 结果 |
| --- | --- | --- |
| TypeScript | `node_modules/.bin/tsc --noEmit` | 通过，退出码 0 |
| 临建、CAD、场景目录 | 31 个测试文件 | 227 通过，0 失败、跳过、取消 |
| 全部 Node 自动测试 | `src`、`server`、`tests` 下 155 个测试文件 | 1200 通过，0 失败、跳过、取消 |

原发布说明记录了“211 项 CAD、临建规划及场景相关测试”，但仓库没有保存那次测试的精确文件列表。本次明确枚举了 31 文件、227 测试的相关集合，并执行全部 155 文件、1200 测试的全集，覆盖仓库中原有测试；不将 227 冒称为原 211 集合。精确文件列表与统计见 [regression-baseline.json](regression-baseline.json)。

实际执行的基线命令：

```sh
node_modules/.bin/tsc --noEmit
node --experimental-transform-types --import ./tools/test-module-loader.mjs --test --test-concurrency=4 src/temporaryWorks*.test.ts src/cad*.test.ts src/sceneDisplay*.test.ts src/dxfLoader.test.ts
node --experimental-transform-types --import ./tools/test-module-loader.mjs --test --test-concurrency=4 src/**/*.test.ts src/*.test.ts server/**/*.test.ts server/*.test.ts tests/*.test.mjs
```

相关集合耗时约 8.2 秒，全集约 35.3 秒。全集包含机械参数、传感器、场景显示、铁路安全、CAD、项目资料与存储生命周期回归。此处仅记录源码基线，不代表新增功能通过。

为避免不同终端通配符行为影响后续复验，新增了可重复入口：

```sh
node tools/run-temporary-works-regression.mjs related
node tools/run-temporary-works-regression.mjs all
```

它输出 TAP 原始日志和 JSON 清单，记录源提交、工作树状态、每个测试文件的 SHA-256、完整命令、退出码及统计。默认写入忽略的 `output/temporary-works-regression`。可用 `--root` 指定独立工作树，用 `--output` 指定报告目录。

浏览器验收工具已核查：`tools/verify-temporary-works-placement.mjs` 与 `tools/verify-temporary-works-bends.mjs` 使用 Vite preview 加载生产 `dist`，可分别设置 `TW_RELEASE_DIST` 与 `BEND_PREVIEW_DIST`。`tools/verify-temporary-works.mjs` 使用开发服务。工具支持 `PLAYWRIGHT_MODULE` 和 `BROWSER_EXECUTABLE`。当前阶段未运行浏览器验收，也未进行生产构建，不能由单元测试结论替代实际 GLB、裁剪和道路场景验收。
