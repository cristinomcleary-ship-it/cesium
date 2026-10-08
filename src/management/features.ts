export const MANAGEMENT_FEATURES = [
  {
    "id": "F01",
    "moduleId": "overview",
    "name": "项目关键指标",
    "userOperationAndResult": "选择项目和统计日期，查看经确认的完成情况、近期任务、待处理问题及资源缺口；点击数字进入对应业务清单",
    "suggestedTab": "project",
    "suggestedActions": [
      "metrics.query",
      "metric.drilldown"
    ]
  },
  {
    "id": "F02",
    "moduleId": "overview",
    "name": "我的工作与项目待办",
    "userOperationAndResult": "在“我的工作”处理个人任务，在有权限时切到项目全部待办；按逾期、今日和近期到期查看，点击事项直接执行当前动作",
    "suggestedTab": "mine",
    "suggestedActions": [
      "todos.query",
      "source.open"
    ]
  },
  {
    "id": "F03",
    "moduleId": "overview",
    "name": "近期作业与里程碑",
    "userOperationAndResult": "查看本周、下周作业和关键节点；选择任务查看负责人、前置条件和关联区域，调整计划须进入正式计划操作",
    "suggestedTab": "project",
    "suggestedActions": [
      "tasks.query",
      "task.open"
    ]
  },
  {
    "id": "F04",
    "moduleId": "overview",
    "name": "施工准备状态",
    "userOperationAndResult": "选择近期任务，查看人员、设备、材料、试验和资料准备情况；点击未满足项进入相应记录，明确协调人及完成期限",
    "suggestedTab": "project",
    "suggestedActions": [
      "readiness.query",
      "need.update"
    ]
  },
  {
    "id": "F05",
    "moduleId": "overview",
    "name": "统一搜索与对象详情",
    "userOperationAndResult": "输入任务名、区段名、问题编号、构件编号或资料标题；选中结果后打开同一详情，点击定位查看关联位置",
    "suggestedTab": "project",
    "suggestedActions": [
      "search.query",
      "selection.select",
      "camera.locate"
    ]
  },
  {
    "id": "F06",
    "moduleId": "overview",
    "name": "三维专题展示",
    "userOperationAndResult": "选择进度、质量、安全或资源主题，模型叠加用户定义对象的业务状态；点击对象查看依据，选择归位恢复总览",
    "suggestedTab": "project",
    "suggestedActions": [
      "scene.theme",
      "selection.select",
      "camera.home"
    ]
  },
  {
    "id": "F07",
    "moduleId": "overview",
    "name": "重点事项与趋势",
    "userOperationAndResult": "关注影响近期作业的事项，查看滞后原因、重复问题和临期审批；负责人可添加协调说明及后续动作",
    "suggestedTab": "project",
    "suggestedActions": [
      "trends.query",
      "action.create"
    ]
  },
  {
    "id": "F08",
    "moduleId": "overview",
    "name": "展示与汇报视图",
    "userOperationAndResult": "切换个人工作视图、项目统筹视图或全屏展示；保存常用筛选和视角，预览需要汇报的时间范围",
    "suggestedTab": "project",
    "suggestedActions": [
      "view.switch",
      "bookmark.create",
      "report.preview"
    ]
  },
  {
    "id": "F09",
    "moduleId": "plan",
    "name": "工作分解与空间关联",
    "userOperationAndResult": "建立或导入 WBS，按工作包组织工序；从已存在的手工空间区段中选择关联，不因新增工作包自动生成边界",
    "suggestedTab": "tasks",
    "suggestedActions": [
      "wbs.create",
      "wbs.update",
      "task.update"
    ]
  },
  {
    "id": "F10",
    "moduleId": "plan",
    "name": "计划基准与节点",
    "userOperationAndResult": "填写计划起止、数量、单位及节点，经项目确认后形成基准；后续调整保存理由和批准记录，原计划可回看",
    "suggestedTab": "baselines",
    "suggestedActions": [
      "baseline.create",
      "baseline.approve"
    ]
  },
  {
    "id": "F11",
    "moduleId": "plan",
    "name": "周计划与日作业",
    "userOperationAndResult": "从工作包选择近期作业，细化执行日期、责任人和预期完成量；同类作业可批量安排，避免重复填写基础信息",
    "suggestedTab": "week",
    "suggestedActions": [
      "commitment.create",
      "commitment.publish"
    ]
  },
  {
    "id": "F12",
    "moduleId": "plan",
    "name": "前置关系与开工条件",
    "userOperationAndResult": "配置必要前置任务以及需满足的资料、检查和资源条件；条件未满足时显示原因，人工确认保留依据",
    "suggestedTab": "tasks",
    "suggestedActions": [
      "task.update",
      "readiness.query"
    ]
  },
  {
    "id": "F13",
    "moduleId": "plan",
    "name": "任务指派与执行反馈",
    "userOperationAndResult": "有权人员选择负责人及期限，执行人接收后开始作业；可说明阻碍、申请调整或转交，实际责任变化留痕",
    "suggestedTab": "tasks",
    "suggestedActions": [
      "task.publish",
      "task.start",
      "task.request-completion",
      "task.confirm-completion"
    ]
  },
  {
    "id": "F14",
    "moduleId": "plan",
    "name": "实际完成量与审核",
    "userOperationAndResult": "执行人填报当日数量、日期和证据，审核确认后生效；同期录入提示已有记录，纠正采用替代旧值的修订",
    "suggestedTab": "tasks",
    "suggestedActions": [
      "progress.create",
      "progress.revise",
      "progress.submit",
      "progress.return",
      "progress.confirm"
    ]
  },
  {
    "id": "F15",
    "moduleId": "plan",
    "name": "预测与计划调整",
    "userOperationAndResult": "负责人根据剩余工作及已确认阻碍填写预测完成日；需改变计划时提交调整并说明受影响任务",
    "suggestedTab": "baselines",
    "suggestedActions": [
      "task.forecast",
      "task.update",
      "change.create"
    ]
  },
  {
    "id": "F16",
    "moduleId": "plan",
    "name": "偏差分析与进度报告",
    "userOperationAndResult": "选择时间范围，比较计划量与审核实绩，查看滞后任务、原因及纠偏措施；生成带依据的周报",
    "suggestedTab": "gantt",
    "suggestedActions": [
      "metrics.query",
      "metric.drilldown",
      "report.freeze"
    ]
  },
  {
    "id": "F17",
    "moduleId": "field",
    "name": "施工前核验",
    "userOperationAndResult": "打开当日任务，按项目配置核对交底、人员、设备、材料、资料及外部许可记录；填写依据后由指定人员确认",
    "suggestedTab": "today",
    "suggestedActions": [
      "check.create",
      "check.record",
      "check.confirm"
    ]
  },
  {
    "id": "F18",
    "moduleId": "field",
    "name": "施工日志与执行记录",
    "userOperationAndResult": "选择任务填写作业内容、投入和异常；完成量创建或引用同一实绩记录，可引用已有照片、检查及问题；提交后进入必要审核",
    "suggestedTab": "today",
    "suggestedActions": [
      "dailyLog.create",
      "progress.create",
      "progress.revise"
    ]
  },
  {
    "id": "F19",
    "moduleId": "field",
    "name": "质量检查与验收记录",
    "userOperationAndResult": "选择适用检查表，逐项填写通过、不通过或不适用，上传照片和结果；完成后形成检查记录",
    "suggestedTab": "checks",
    "suggestedActions": [
      "check.create",
      "check.record",
      "check.confirm"
    ]
  },
  {
    "id": "F20",
    "moduleId": "field",
    "name": "质量问题与整改",
    "userOperationAndResult": "对不合格条目创建质量问题，补充负责人及期限；整改提交后复核，通过关闭，未通过退回",
    "suggestedTab": "issues",
    "suggestedActions": [
      "issue.create",
      "issue.assign",
      "issue.submit",
      "issue.review"
    ]
  },
  {
    "id": "F21",
    "moduleId": "field",
    "name": "安全检查与风险事件",
    "userOperationAndResult": "从检查、现场发现或巡检证据登记事件，核查后指派整改；误报与重复单独记录处置结论",
    "suggestedTab": "issues",
    "suggestedActions": [
      "issue.create",
      "issue.assign",
      "issue.dismiss"
    ]
  },
  {
    "id": "F22",
    "moduleId": "field",
    "name": "手工空间对象管理",
    "userOperationAndResult": "用户在实际倾斜摄影中绘制施工区域、铁路范围闭合多边形，或点击建立风险点；命名保存，编辑可取消恢复",
    "suggestedTab": "spatial",
    "suggestedActions": [
      "geometry.new",
      "geometry.edit",
      "geometry.undo",
      "geometry.redo",
      "geometry.save"
    ]
  },
  {
    "id": "F23",
    "moduleId": "field",
    "name": "整改复核与过程追溯",
    "userOperationAndResult": "处理人提交措施和证据，复核人选择通过或退回并填写意见；查看每轮状态、操作人及历史位置",
    "suggestedTab": "issues",
    "suggestedActions": [
      "issue.start",
      "issue.submit",
      "issue.review",
      "issue.history"
    ]
  },
  {
    "id": "F24",
    "moduleId": "field",
    "name": "现场协调与工序衔接",
    "userOperationAndResult": "将待解决问题关联受影响任务，指派协调人和期限；确认解除后更新条件，后续任务仍按其流程启动",
    "suggestedTab": "coordination",
    "suggestedActions": [
      "action.create",
      "action.complete",
      "readiness.query"
    ]
  },
  {
    "id": "F25",
    "moduleId": "inspection",
    "name": "巡检任务与覆盖",
    "userOperationAndResult": "选择作业任务、已定义区段和检查目的，安排执行人及时间；完成后关联录像和结果",
    "suggestedTab": "tasks",
    "suggestedActions": [
      "inspection.create",
      "inspection.record",
      "inspection.confirm"
    ]
  },
  {
    "id": "F26",
    "moduleId": "inspection",
    "name": "录像照片管理",
    "userOperationAndResult": "导入文件或选择已接入记录，查看上传及处理进度，补充拍摄时间和关联任务；失败可重试",
    "suggestedTab": "media",
    "suggestedActions": [
      "media.upload",
      "media.retry",
      "media.open"
    ]
  },
  {
    "id": "F27",
    "moduleId": "inspection",
    "name": "航迹关联与校准",
    "userOperationAndResult": "为录像选择配对航迹，检查时间覆盖、坐标高程及姿态；预览后保存关联，缺失信息明确提示",
    "suggestedTab": "media",
    "suggestedActions": [
      "track.preview",
      "track.binding.save"
    ]
  },
  {
    "id": "F28",
    "moduleId": "inspection",
    "name": "同步播放与三维漫游",
    "userOperationAndResult": "播放、暂停、跳转和倍速共同驱动录像与三维时间；拖动场景转自由查看，点击继续跟随恢复",
    "suggestedTab": "media",
    "suggestedActions": [
      "media.play",
      "media.pause",
      "media.seek",
      "media.rate",
      "media.follow"
    ]
  },
  {
    "id": "F29",
    "moduleId": "inspection",
    "name": "现场取证与问题转交",
    "userOperationAndResult": "暂停录像截图并说明发现，确认后转待核查事件并关联任务；正式三维位置由用户在模型中手工指定",
    "suggestedTab": "media",
    "suggestedActions": [
      "media.capture",
      "evidence.register",
      "issue.create"
    ]
  },
  {
    "id": "F30",
    "moduleId": "inspection",
    "name": "监测点与阈值管理",
    "userOperationAndResult": "关联项目已有监测点和数据来源，选择指标、单位及经确认的阈值；查看异常后登记核查任务",
    "suggestedTab": "monitoring",
    "suggestedActions": [
      "monitoring.create",
      "monitoring.threshold",
      "monitoring.record"
    ]
  },
  {
    "id": "F31",
    "moduleId": "inspection",
    "name": "实时状态与断连提示",
    "userOperationAndResult": "查看已接入设备、直播与数据接收状态，断连或数据过期时显示原因及最后接收时间",
    "suggestedTab": "monitoring",
    "suggestedActions": [
      "monitoring.query",
      "device.status"
    ]
  },
  {
    "id": "F32",
    "moduleId": "inspection",
    "name": "成果对比与归档",
    "userOperationAndResult": "选择同一工点不同日期的记录查看变化，整理巡检结果、截图和关联事件，经确认后归档",
    "suggestedTab": "results",
    "suggestedActions": [
      "inspection.record",
      "inspection.confirm",
      "evidence.compare"
    ]
  },
  {
    "id": "F33",
    "moduleId": "resources",
    "name": "作业资源需求",
    "userOperationAndResult": "从任务选择需用人员班组、机械、材料、辅材和试验要求，填写需用时间及数量，可复用同类任务清单",
    "suggestedTab": "readiness",
    "suggestedActions": [
      "need.create",
      "need.update"
    ]
  },
  {
    "id": "F34",
    "moduleId": "resources",
    "name": "人员与班组安排",
    "userOperationAndResult": "登记班组、负责人、计划投入和实际到场，按项目要求关联培训或资格资料；明确作业安排",
    "suggestedTab": "crews",
    "suggestedActions": [
      "resource.create",
      "resource.update",
      "allocation.create",
      "allocation.cancel"
    ]
  },
  {
    "id": "F35",
    "moduleId": "resources",
    "name": "机械设备安排",
    "userOperationAndResult": "维护设备名称、状态、使用时间和责任人，关联检查及维护记录；为任务安排设备并确认实际到位",
    "suggestedTab": "equipment",
    "suggestedActions": [
      "resource.create",
      "resource.update",
      "allocation.create",
      "allocation.cancel"
    ]
  },
  {
    "id": "F36",
    "moduleId": "resources",
    "name": "物资到货与领用",
    "userOperationAndResult": "登记任务材料需求、到货批次、验收状态和领用去向；退回或数量纠正形成独立记录",
    "suggestedTab": "materials",
    "suggestedActions": [
      "batch.create",
      "batch.receive",
      "batch.accept",
      "material.issue",
      "material.return",
      "material.correct"
    ]
  },
  {
    "id": "F37",
    "moduleId": "resources",
    "name": "关键辅材管理",
    "userOperationAndResult": "按项目确定的范围登记辅材规格、数量、存放位置、使用部位和相关检查记录；办理领用及退还",
    "suggestedTab": "auxiliaries",
    "suggestedActions": [
      "resource.create",
      "resource.update",
      "material.issue",
      "material.return"
    ]
  },
  {
    "id": "F38",
    "moduleId": "resources",
    "name": "试验与检验关联",
    "userOperationAndResult": "将材料批次或工程部位关联取样、送检、结果和报告；结果未明确时保持待确认，有效状态按项目规则确定",
    "suggestedTab": "tests",
    "suggestedActions": [
      "test.create",
      "test.confirm"
    ]
  },
  {
    "id": "F39",
    "moduleId": "resources",
    "name": "短缺与协调处理",
    "userOperationAndResult": "在准备表发现缺项后指派协调人、预计到位和处理措施；到位后由相应人员确认，保留变更原因",
    "suggestedTab": "readiness",
    "suggestedActions": [
      "need.update",
      "action.create",
      "need.confirm"
    ]
  },
  {
    "id": "F40",
    "moduleId": "resources",
    "name": "台账汇总与使用追溯",
    "userOperationAndResult": "按时间、任务或资源类别查投入、到货、领用和退还；导出需要的简洁清单，核对异常数量",
    "suggestedTab": "readiness",
    "suggestedActions": [
      "resources.query",
      "resource.export",
      "material.history"
    ]
  },
  {
    "id": "F41",
    "moduleId": "documents",
    "name": "资料分类与检索",
    "userOperationAndResult": "在任务或资料中心上传文件，选择类别并关联对象；搜索标题、编号、标签和适用部位",
    "suggestedTab": "files",
    "suggestedActions": [
      "document.create",
      "link.create",
      "document.search"
    ]
  },
  {
    "id": "F42",
    "moduleId": "documents",
    "name": "版本与有效发布",
    "userOperationAndResult": "更新资料时新增版本，记录修订说明，经相应确认后发布有效版本；旧版保留并明确失效状态",
    "suggestedTab": "files",
    "suggestedActions": [
      "document.version",
      "document.publish",
      "document.void"
    ]
  },
  {
    "id": "F43",
    "moduleId": "documents",
    "name": "资料审核与报审",
    "userOperationAndResult": "选择需要确认的方案、图纸或材料资料，提交给指定人员审核；批准或退回均保留意见和附件",
    "suggestedTab": "submittals",
    "suggestedActions": [
      "document.submit",
      "document.return",
      "document.publish"
    ]
  },
  {
    "id": "F44",
    "moduleId": "documents",
    "name": "技术问题与正式答复",
    "userOperationAndResult": "选择任务、图纸或位置描述疑问，指派答复人并规定期限；正式答复经指定人员确认后发布",
    "suggestedTab": "technical",
    "suggestedActions": [
      "technical.create",
      "technical.comment",
      "technical.answer",
      "technical.publish"
    ]
  },
  {
    "id": "F45",
    "moduleId": "documents",
    "name": "变更影响与处理",
    "userOperationAndResult": "登记经确认的变更事项，关联受影响任务、数量、资料及资源；相关负责人逐项确认影响和调整措施",
    "suggestedTab": "changes",
    "suggestedActions": [
      "change.create",
      "change.confirm"
    ]
  },
  {
    "id": "F46",
    "moduleId": "documents",
    "name": "会议行动项",
    "userOperationAndResult": "记录会议结论，对需落实事项选择责任人和期限，关联既有任务或问题；后续会议直接查看上次未完成事项",
    "suggestedTab": "meetings",
    "suggestedActions": [
      "meeting.create",
      "action.create",
      "action.complete"
    ]
  },
  {
    "id": "F47",
    "moduleId": "documents",
    "name": "构件与空间资料关联",
    "userOperationAndResult": "有 BIM 时按稳定 GUID 关联构件；无 BIM 时用户在模型中建立独立资料锚点，再添加图纸或记录",
    "suggestedTab": "files",
    "suggestedActions": [
      "document.anchor",
      "link.create",
      "link.remove"
    ]
  },
  {
    "id": "F48",
    "moduleId": "documents",
    "name": "汇报与项目归档",
    "userOperationAndResult": "选择报告期间及范围，预览计划、实绩、检查、问题、资源和资料办理情况，审核后导出并归档",
    "suggestedTab": "reports",
    "suggestedActions": [
      "report.preview",
      "report.freeze",
      "report.publish",
      "report.export"
    ]
  }
] as const;
