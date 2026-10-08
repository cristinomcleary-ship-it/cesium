# 项目统筹平台：启动、数据与恢复

适用版本：当前工作区新增六模块项目统筹界面及管理后端，继续使用现有 Cesium 工程。本文记录实际入口和存储方式，不代表 48 项功能已通过验收；逐项结果、实际画面、操作录像及条件限制见 [platform-management-acceptance.md](platform-management-acceptance.md)。

## 1. 启动现有工程

在 `F:\codex\cesium` 运行。当前环境已安装依赖，使用 Node.js **24**；本轮实测版本为 `24.21.0`，管理后端使用该版本内置的 `node:sqlite`。`sql.js` 仍是原项目依赖，不能代替服务端 `node:sqlite`。启动时若出现 SQLite experimental 提示，不等于启动失败；若报找不到 `node:sqlite`，先核对实际使用的 Node。

```powershell
Set-Location -LiteralPath 'F:\codex\cesium'
node --version
npm run dev -- --port 5173 --strictPort
```

现有 `npm run dev` 脚本为 Vite；省略端口参数时默认 5173。上例增加 `--strictPort`，端口占用会明确失败，不会悄悄转到另一端口。已有本项目服务时直接打开页面，不再启动第二个进程。必要时使用已确认的 Node 路径直接启动同一 Vite：

```powershell
& 'F:\Node.js\node.exe' '.\node_modules\vite\bin\vite.js' --host 127.0.0.1 --port 5173 --strictPort
```

新机器首次准备依赖时，按仓库 `pnpm-lock.yaml` 安装；无需在已经可用的工作区重装或更新依赖：

```powershell
pnpm install --frozen-lockfile --store-dir .pnpm-store
```

| 页面 | 地址 | 行为 |
|---|---|---|
| 新项目统筹界面 | `http://127.0.0.1:5173/?screen=safety` | 原安全平台入口接入六模块新界面 |
| 新界面别名 | `http://127.0.0.1:5173/?screen=management` | 与上一地址进入同一平台 |
| 原四模块安全大屏 | `http://127.0.0.1:5173/?screen=safety&interface=legacy` | 通过原 SafetyWorkspace 进入；使用相同模型、数据和权限 |
| 原 Cesium 工作台 | `http://127.0.0.1:5173/` | 保留原模型、资料、CAD、视频 AR 等操作入口 |
| 独立 AR V2 页面 | `http://127.0.0.1:5173/ar-v2.html` | 原 AR V2 页面；计算服务和运行条件仍按 `AR_V2_STATUS.md`、`ar_v2/README.md` 执行 |

原 `启动安全巡检大屏.cmd` 入口及 `tools/start-safety-dashboard.ps1` 继续保留。启动器检查 `/__management/session` 的真实会话结构；200 或带 `AUTH_REQUIRED` / `SESSION_EXPIRED` 的 401 表示同一管理服务已就绪，会直接复用，不再因已启用登录而启动第二个服务。启动新服务前按 PATH、Codex 捆绑运行时顺序查找 Node，并实际创建一个内存 SQLite 表核验能力。无兼容运行时会明确停止，不打开空页面。

需要构建时执行 `npm run build`；构建后可用 `npm run preview -- --port 5173 --strictPort`。开发和预览不能同时占用同一端口。开发及预览服务都注册本机业务插件；**只把 `dist/` 放到普通静态服务器不会提供资料保存、鉴权、SQLite、模型挂载和视频文件接口**。

## 2. 原数据保持原位置，SQLite 为增量新增

`vite.config.ts` 将 `managementPlugin()` 放在插件列表首位，前置权限检查先于旧空间、事件、资料库和模型服务。新管理数据由 `server/managementStore.ts` 与 `server/management/` 处理，共享类型在 `src/managementTypes.ts`。

默认所有持久数据根为 `F:\codex\cesium\project-data`：

| 数据 | 默认位置 | 本轮处理方式 |
|---|---|---|
| 原资料及导入附件 | `project-data/records/` | 原格式继续使用，不迁移、不重新编号 |
| 原删除记录标识 | `project-data/deleted/` | 继续保留，避免旧页面重新写回已删除资料 |
| 原相机、图层与媒体偏好 | `project-data/view.json` | 原保存机制继续使用；正常操作可更新偏好，不等于业务几何变化 |
| 人工施工区域、铁路范围、风险点 | `project-data/safety-spatial.json` | 原 ID、几何、来源、模型与变换版本保留；新操作按原空间接口保存 |
| 原风险处置事件 | `project-data/safety-events.json` | 继续使用原事件接口；操作身份接入服务端可信会话 |
| 新项目统筹台账 | `project-data/management.sqlite` | 新增 SQLite；任务、实绩修订、资源、资料版本、会话、审计和幂等回执同库持久化 |
| 新管理上传附件 | `project-data/management-files/` | 与 SQLite 一起备份；文件实际落盘后才登记可用证据 |

首次启动只执行新增表/索引迁移，`PRAGMA user_version=1`。原 JSON、原媒体及模型不进入这次迁移。数据库启用 WAL、外键与事务；记录、历史修订、审计、幂等回执一起提交。重启后不依赖浏览器内存恢复业务。发现数据库版本大于当前支持版本时拒绝启动管理库，保留原文件，不尝试降级覆盖。

人工空间对象新增可选的服务器修订号：新对象从 1 开始，保存、删除、恢复各增一次；已有无编号对象读取时原样保留，显示“历史未编号”，下次变更才从 1 编号。管理关系另冻结台账版本与几何哈希，不用补号重写原台账。

默认仅建立真实工程项目的配置记录 `safety:project`；新业务集合为空。新任务、周承诺、实绩、事件、资源和资料不会由参考设计包自动填充。已有有效人工几何继续读取，不根据名称删除，也不根据展示沙盘边界生成施工范围。

## 3. 环境变量及隔离验收

这些是 **Node 服务进程的环境变量**，应在启动该进程的 PowerShell 中设置。不要仅在浏览器或前端 `.env` 变量中配置。

| 变量 | 影响范围 | 未设置时 |
|---|---|---|
| `CESIUM_DATA_DIR` | 原资料库、模型注册与原文件来源；也是管理目录的备用值 | 当前工作目录下 `project-data` |
| `CESIUM_MANAGEMENT_DATA_DIR` | 新 SQLite 与 `management-files` | `CESIUM_DATA_DIR`，再回退 `project-data` |
| `CESIUM_SAFETY_DATA_DIR` | 原人工空间与事件 JSON；管理模块的空间关联读取来源 | 原空间/事件接口使用 `project-data`；管理关联读取使用自身管理根，因此隔离时应显式设置 |
| `CESIUM_SAFETY_PHOTOGRAMMETRY_IDS` | 原空间取点可用倾斜摄影资产白名单 | 代码内已有真实资产配置；不要用任意示例资产替代 |

**完全隔离的新项目验收**可在单独 PowerShell 窗口使用新的空目录；以下示例只影响该窗口及其启动的服务，正式 5173 可继续运行：

```powershell
Set-Location -LiteralPath 'F:\codex\cesium'
$managementTestRoot = Join-Path (Get-Location) ('tmp\management-manual-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $managementTestRoot | Out-Null
$env:CESIUM_DATA_DIR = $managementTestRoot
$env:CESIUM_MANAGEMENT_DATA_DIR = $managementTestRoot
$env:CESIUM_SAFETY_DATA_DIR = $managementTestRoot
npm run dev -- --host 127.0.0.1 --port 5198 --strictPort
```

此方式的新资料库为空，不能声称已显示正式工程。需验收真实模型时，使用经过核查的原资产引用或独立数据副本，并保持模型源文件不变。仅把管理和空间目录指向隔离目录、而将 `CESIUM_DATA_DIR` 指向正式库，**不会自动让正式资料库只读**：原图层、视角保存及导入接口仍可能写入它。实际自动验收应继续采用测试脚本的写请求隔离/拦截和原文件哈希保护，不把两个隔离变量当作完整保护。

退出验收服务并关闭此 PowerShell 窗口即可丢弃进程环境设置；不要把测试目录或账号合并回正式项目。切回正式启动时先确认使用的三个目录，不把“空库”误认为原台账丢失。

## 4. 首次账号与权限

1. 尚无任何账号时，仅服务器本机 loopback 连接配合 `localhost`、`127.0.0.1` 或 `[::1]` 允许“本机所有者（未启用账号）”初始化。远程地址不会获得匿名所有者身份。
2. 在新界面的“项目设置”打开“添加项目成员”，建立第一个账号。角色必须包含“本机项目所有者”，用户名使用英文、数字或 `._@-`，密码至少 10 个字符。该成功操作同时建立登录会话。
3. 一旦账号存在，后续受保护请求必须登录；删除 cookie、更换主机名或过期会话都不会重新获得初始化身份。固定使用同一地址访问。会话 cookie 为 HttpOnly、SameSite=Strict，有效期 8 小时。
4. 后续成员的职责、项目、任务范围及模型/文件/视频权限由服务器从数据库核验。客户端角色字段或请求头不能赋权。任务范围受限且没有精确资产范围时，旧全项目模型/原件/视频接口整体拒绝访问，界面应显示受限状态。

本轮提供的是**本机账号系统**，未接入企业统一身份、SSO 或企业身份目录。旧版界面仅是操作界面回退，不是绕过权限的方法。原件、预览、3D Tiles 子瓦片、媒体文件及原空间/事件写入共享服务端检查；底层文件路径不能通过 `/project-data` 或 `@fs` 直接绕过权限。模型子资源使用同源 URL，避免跨 `localhost`/`127.0.0.1` 丢失会话。

账号信息与会话在 SQLite 内；没有忘记密码绕过入口，也不要通过删除数据库“重置登录”。项目所有者可管理本项目成员，不能借成员维护重置另一个既有全局账号密码。保留可用所有者账号，并将管理库纳入备份。

API 详细字段、修订号、幂等重试与错误码见 [management-api.md](management-api.md)。接口写入失败或 409 冲突时，应保留草稿、重新读取当前修订再确认处理，不用刷新或重复生成计量条目绕过冲突。

## 5. 备份与恢复

源码提交或源码 ZIP **不包含完整运行数据备份**：`project-data/`、`output/`、`tmp/`、`.local-backups/` 和本地配置被 Git 忽略。倾斜摄影、录像等资产还可能引用工程目录之外的原文件，备份资料元数据不能代替备份这些源资产。

备份时先退出会自动保存的浏览器页面，再停止使用该目录的开发/预览服务、相关写入进程。确认 SQLite 无写入后，将下列内容作为同一批备份保存：

- 实际配置的资料库根完整目录，含 `records`、`deleted`、原附件与 `view.json`。
- 实际配置的空间/事件根，含两个 JSON 文件及原始来源字段。
- 实际配置的管理根，含 `management.sqlite`、`management-files`；若还有 `management.sqlite-wal` 或 `management.sqlite-shm`，同批保留。不能单独复制运行中的主库而漏掉 WAL。
- 资料记录指向的外部真实模型、原录像、CAD 源文件，以及必要的本地坐标/挂载配置。对外移交时凭据应独立安全保存。
- 对应代码版本、环境变量所指绝对目录、备份时间与文件哈希清单。

默认三个根相同，只需完整复制一次 `project-data`；目录分离时逐一备份。示例命令仅用于停服后创建一个**新备份目录**，不删除原库：

```powershell
Set-Location -LiteralPath 'F:\codex\cesium'
$backupBatch = Join-Path (Get-Location) ('.local-backups\management-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupBatch | Out-Null
Copy-Item -LiteralPath '.\project-data' -Destination $backupBatch -Recurse
```

恢复采用整批一致副本：先停服并保留当前目录，再将已核查备份复制到**新的恢复目录**，检查文件哈希/数量、外部源资产路径与代码兼容性，最后把三个环境变量切换到对应恢复目录启动。避免将旧 `management.sqlite` 直接覆盖到带有新 WAL/附件的运行目录。恢复后核对账号、任务修订、冻结报告、原人工几何及真实文件可读性，再决定是否替换原目录；保留恢复前副本。

需要暂时回到原操作界面时，优先使用 `?screen=safety&interface=legacy` 或根地址，数据无须转换。不要删除新 SQLite，也不要把新版库降级交给不支持其 schema 的旧程序写入。

## 6. 真实模型、视频、CAD 和精度边界

新界面通过 `src/managementWorkspace.ts` 接入原 `SafetyWorkspace`，继续使用同一个 Cesium Viewer、原资料库和原视频元素。管理与三维视图切换不另建 Viewer。正式场景仍加载资料库中的真实 `Production_2.json` 倾斜摄影资产、原桥梁模型及已有 CAD；设计包的概念背景、合成瓦片和示例航迹不作为正式工程输入。

原 CAD 导入、投影、图层与 POINT 显示规则由既有模块继续负责；新业务对象引用已有人工空间 ID，任务关联或 WBS 调整不改变原几何。视频继续通过原资料记录和受控文件接口播放，原轨迹、源身份与媒体秒保持独立核验。缺少有效高程、时间绑定或姿态时，不因新界面出现而启用真实三维跟随。

模型清晰度/网格修复、无人机视频配准、真实空间漫游能力分别验收；本轮界面、SQLite 或 CPU 测试通过不代表这些工程精度问题已解决。A01—A20、48 功能的最终实际通过/未通过、条件项与证据统一记录在 [platform-management-acceptance.md](platform-management-acceptance.md)。

## 7. 可复现 CPU 检查

当前原功能兼容验证已保存到 `output/platform-management/cpu-regression-report.json`；它只证明记录中的 CPU / 隔离 HTTP 检查，不替代实际模型画面和交互验收。源码测试可用以下命令运行：

```powershell
$sourceTests = @(rg --files src server tools -g '*.test.ts' -g '*.test.cjs' -g '*.test.mjs' | Sort-Object)
node --experimental-strip-types --experimental-transform-types --import ./tools/test-module-loader.mjs --test $sourceTests
node --experimental-transform-types --import ./tools/test-module-loader.mjs tools/verify-management-legacy-cpu.mjs
node --experimental-transform-types --import ./tools/test-module-loader.mjs tools/verify-management-launcher.mjs
node --experimental-transform-types --import ./tools/test-module-loader.mjs tools/verify-management-spatial-revisions.mjs
node --experimental-transform-types --import ./tools/test-module-loader.mjs tools/verify-management-api.mjs
```

上述管理接口脚本使用新建隔离目录；不要把正式目录传作测试目录。原 AR V2 与视频 AR 后端 CPU 测试继续使用各自虚拟环境：

```powershell
& '.\ar_v2\.venv\Scripts\python.exe' -m unittest discover -s ar_v2/tests -v
Push-Location -LiteralPath '.\video_ar_backend'
try { & '.\.venv\Scripts\python.exe' -m unittest discover -s tests -v }
finally { Pop-Location }
```
