# 第一阶段：本机基线、部署与工作区保护核查

核查日期：2026-11-09，时区Asia/Shanghai。此文件仅记录只读观测，不宣称完成线上功能验收。

## 1. 用户授权与隔离边界

最初核查在正式工作区发现6个已跟踪修改和1个未跟踪文件，按交接文件停止。用户随后明确授权：保留全部现存修改/未跟踪文件原样，从 `origin/codex/platform-management-v2` 建全新worktree继续第一阶段；只提交审计报告，不修改业务/部署/数据、不执行破坏性Git命令、不进入第二阶段。

该授权覆盖了交接文档“遇到未提交修改停止”的前置障碍；没有授权清理/暂存/提交正式工程修改或部署。执行过程中没有切换正式工作区分支。

## 2. Git基线与独立目录

| 项目 | 核验结果 |
|---|---|
| 远端 | `https://github.com/cristinomcleary-ship-it/cesium.git` |
| 正式工作区 | `F:\codex\cesium` |
| 正式分支 | `codex/local-auto-elevation-deployed-20261108` |
| 正式HEAD | `24f79e0c2a62613417c61f61077949aee147c97e` |
| 指定稳定基线 | 同上；与正式HEAD一致 |
| fetch目标 | `origin/codex/platform-management-v2` |
| 审计源提交 | `4a5d7c7cdecc31846201d0cf2e0ba7b8d9fc3acc` |
| 新独立worktree | `F:\codex\cesium-platform-management-v2-audit-20261109` |
| 独立开发分支 | `codex/platform-management-v2`，跟踪上述origin分支 |
| Git隔离 | 新目录有自己的 `.git` 指针与worktree索引；只共享Git对象库，未复用原4个worktree |
| 祖先验证 | `git merge-base --is-ancestor 24f79e0... origin/codex/platform-management-v2` 返回0 |
| 源码差异 | 基线→审计源提交仅新增根HANDOFF和architecture-v2的7份设计文档，业务源码无差异 |

建立新worktree前存在的4个目录与HEAD：

| 原worktree | 分支 | HEAD |
|---|---|---|
| `F:/codex/cesium` | codex/local-auto-elevation-deployed-20261108 | 24f79e0c2a62613417c61f61077949aee147c97e |
| `F:/codex/cesium/output/auto-elevation-20261108/candidate` | codex/temporary-facilities-auto-elevation | 24f79e0c2a62613417c61f61077949aee147c97e |
| `F:/codex/cesium/output/position-hardening-20261108/integration` | codex/local-position-hardening-20261108 | ad74683468bc4dec26008ac2ad3ab2c783d00068 |
| `F:/codex/cesium/output/publish-temporary-facilities-v1.1.0` | codex/release-temporary-facilities-v1.1.0 | 79d24eb63967ac547a725ead7f11ed5300213353 |

没有对上述任何目录执行checkout/switch/reset/clean/stash/add/commit，也没有改写其业务或运行文件。fetch和worktree add只更新共享Git引用/元数据及新目录；这些允许的Git元数据变更不意味着正式工作区文件被暂存。

## 3. 正式工作区修改保护证据

| 文件（相对正式工作区） | 原始Git状态 | 保护方式/结果 |
|---|---|---|
| tools/start-cesium.ps1 | 工作区修改，未暂存 | SHA256、字节数、UTC修改时间前后相同 |
| tools/start-safety-dashboard.ps1 | 工作区修改，未暂存 | 同上 |
| tools/stop-cesium.ps1 | 工作区修改，未暂存 | 同上 |
| 停止Cesium.cmd | 工作区修改，未暂存 | 同上 |
| 启动Cesium.cmd | 工作区修改，未暂存 | 同上 |
| 启动安全巡检大屏.cmd | 工作区修改，未暂存 | 同上 |
| 本机当前版本.txt | 未跟踪 | 同上，仍未跟踪 |

机器证据：[workspace-preservation-proof.json](workspace-preservation-proof.json)。该文件记录核查时刻、原分支/HEAD、完整porcelain状态、空暂存区，以及7个文件前后SHA256/长度/修改时间。工作区保护脚本只读取原文件；报告仅保存哈希与状态，不上传这些定制文件的内容。提交/推送后还会再检查相同保护项，结果随任务交付说明。

## 4. 本机实际部署与运行观察

**确认了磁盘部署身份，未观察到相关服务在线监听。** 2026-11-09 09:12（+08:00）读取进程及TCP监听，5289、5173、4173、3000、3001、8000、8001、8080、8090、8765均无监听。进程清单未看到与当前启动器要求的 `F:\Node.js\node.exe` + 当前工程server.mjs匹配的Cesium进程。历史service.json内PID不作为在线证据；未启动或停止任何服务。

本机 `本机当前版本.txt`、`output/current-version/start.ps1`、`server.mjs`、`service.json`、`server-identity.json`交叉核对：

| 项目 | 实际记录/观察 |
|---|---|
| 功能版本称谓 | 临建设施1.1.0基线 + 自动初始高度 |
| package版本 | 1.2.0；依赖声明Cesium1.144.0。它们不替代用户功能版本称谓 |
| 声明运行提交 | 24f79e0c2a62613417c61f61077949aee147c97e |
| 源码/构建 | `F:\codex\cesium` / `F:\codex\cesium\dist` |
| 桌面入口链 | 原cmd → 本机定制tools/start-cesium.ps1 → output/current-version/start.ps1 |
| 地址 | `http://127.0.0.1:5289/`，并非目标分支标准启动器的5173 |
| 数据根 | `F:\codex\cesium\output\current-version\workspace\project-data` |
| 运行包装 | server.mjs设置三类CESIUM_*_DATA_DIR到上述数据根；固定candidate/acceptanceOnly身份；本机配置版本和index指纹校验 |
| 模型导入差异 | 包装主动拒绝POST /__models/import，ACCEPTANCE_CONVERSION_DISABLED；仓库功能≠当前部署可用能力 |
| 静态页面指纹 | 实测dist/index.html SHA256与启动器/历史identity锁定值一致（见下） |

指纹（SHA256）：

| 文件 | 实测哈希 |
|---|---|
| dist/index.html | 3ff739328144e8ec71e5ffbe4d4a6d646a3994262a7a35bd29f41f13d7290a76 |
| dist/assets/main-DzTpIq9g.js | 702d7772454e6a54dbe76a60c543f3a5cf96d6bf879a8dd21a7918324666ba91 |
| dist/assets/main-Csoraa0F.css | 743d90c0950e907586ec53d85a762fcfae796170474230bdc1e7ad4005ee7987 |
| output/current-version/server.mjs | b3c6fff04e63398160c3e00297a98f79cc40ebc4c8ac71676c2ba5b0a2b57e06 |

页面哈希与部署记录匹配是静态证据；JS/CSS哈希仅本次留痕，未重新构建比较、未证明全部产物来源，也不能替代在线浏览器验收。

## 5. 真实数据目录保护

仅检查上述数据根的目录项/文件元信息，未打开SQLite连接、未运行schema迁移/完整性检查、未读取业务记录正文：

| 实测存在的项 | 类型/大小 | 含义 |
|---|---|---|
| management.sqlite | 380,928字节 | 管理主库，WAL模式，不可单独只拷主文件当一致性备份 |
| management.sqlite-wal | 259,592字节 | 同一数据库现有WAL，原样保留 |
| management.sqlite-shm | 32,768字节 | 共享内存辅助文件，原样保留 |
| management-files/ | 目录 | 管理原件附件 |
| records/、deleted/ | 目录 | 项目资料库与删除意图/墓碑 |
| safety-spatial.json | 7,218字节 | 旧安全空间数据 |
| view.json | 385字节 | 资料库场景视图 |

此列表不等于数据总量统计或完整备份清单。外部倾斜摄影原目录、私有GLB/SDK、浏览器profile内IndexedDB/localStorage/OPFS、其他输出目录均未迁移、复制、清理或改写。临建方案、标绘、基坑、汇报、隐蔽档案及视频缓存的真正存储边界见04；正式备份只复制Git或SQLite都不完整。

## 6. 检查方法与局限

执行了只读Git状态/祖先/差异、文件元信息与SHA256、受控文件全文机器索引、关键调用链/测试断言阅读、进程/监听快照。运行的Node内联脚本仅用fs读取源码并写审计索引，未导入任何业务模块。

未执行依赖安装、build、业务测试、浏览器/设备验证、HTTP业务请求、数据库初始化、运行脚本、部署或任何破坏性Git操作。环境执行器最初沙箱初始化失败后，使用已授权的提升执行方式完成上述限定操作；没有自动审批拒绝，也没有借此扩大业务修改范围。
