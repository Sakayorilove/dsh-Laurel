// Public field metadata only. No preference values or runtime defaults.
export const settingsCatalog = [
 {id:'scene',module:'粒子场景',group:'展示台纸色',key:'paperEnabled',label:'纸色展示台',en:'Paper background',condition:'祀日间'},
 {id:'scene',module:'粒子场景',group:'展示台纸色',key:'paperBrightness',label:'纸色明暗',en:'Paper brightness',condition:'祀日间 · 纸色展示台开启'},
  {
    "id": "auto-continue",
    "key": "graceMs",
    "label": "中断后等待（秒）",
    "en": "Wait after interruption (seconds)",
    "module": "自动继续",
    "group": "基本设置",
    "tab": "basic",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "cooldownMs",
    "label": "同一会话最小间隔（秒）",
    "en": "Per-session cooldown (seconds)",
    "module": "自动继续",
    "group": "基本设置",
    "tab": "basic",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "maxConsecutive",
    "label": "连续失败上限",
    "en": "Consecutive failure cap",
    "module": "自动继续",
    "group": "基本设置",
    "tab": "basic",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "resumedKinds",
    "label": "允许续跑的结束原因",
    "en": "Resumable end reasons",
    "module": "自动继续",
    "group": "恢复规则与协作",
    "tab": "recovery",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "classify",
    "label": "区分临时与永久错误",
    "en": "Classify transient vs permanent errors",
    "module": "自动继续",
    "group": "恢复规则与协作",
    "tab": "recovery",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "loopAfterCompleted",
    "label": "正常结束后继续（自主循环）",
    "en": "Continue after a completed turn (unattended loop)",
    "module": "自动继续",
    "group": "正常结束后的自主循环",
    "tab": "loop",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "loopMaxRounds",
    "label": "循环最多轮数",
    "en": "Max loop rounds",
    "module": "自动继续",
    "group": "正常结束后的自主循环",
    "tab": "loop",
    "condition": "正常结束后继续（自主循环）：开启"
  },
  {
    "id": "auto-continue",
    "key": "loopMaxDurationMs",
    "label": "循环总时长上限（秒）",
    "en": "Loop wall-clock cap (seconds)",
    "module": "自动继续",
    "group": "正常结束后的自主循环",
    "tab": "loop",
    "condition": "正常结束后继续（自主循环）：开启"
  },
  {
    "id": "auto-continue",
    "key": "loopBudgetNotice",
    "label": "额度用尽时通知",
    "en": "Notify when the budget runs out",
    "module": "自动继续",
    "group": "正常结束后的自主循环",
    "tab": "loop",
    "condition": "正常结束后继续（自主循环）：开启"
  },
  {
    "id": "auto-continue",
    "key": "scheduleMode",
    "label": "生效时段模式",
    "en": "Active-window mode",
    "module": "自动继续",
    "group": "基本设置",
    "tab": "basic",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "dayStart",
    "label": "日间窗口开始",
    "en": "Day window start",
    "module": "自动继续",
    "group": "基本设置",
    "tab": "basic",
    "condition": "生效时段模式：日间 / 夜间"
  },
  {
    "id": "auto-continue",
    "key": "dayEnd",
    "label": "日间窗口结束",
    "en": "Day window end",
    "module": "自动继续",
    "group": "基本设置",
    "tab": "basic",
    "condition": "生效时段模式：日间 / 夜间"
  },
  {
    "id": "auto-continue",
    "key": "customStart",
    "label": "自定义窗口开始",
    "en": "Custom window start",
    "module": "自动继续",
    "group": "基本设置",
    "tab": "basic",
    "condition": "生效时段模式：自定义"
  },
  {
    "id": "auto-continue",
    "key": "customEnd",
    "label": "自定义窗口结束",
    "en": "Custom window end",
    "module": "自动继续",
    "group": "基本设置",
    "tab": "basic",
    "condition": "生效时段模式：自定义"
  },
  {
    "id": "auto-continue",
    "key": "activeFrom",
    "label": "指定窗口开始时间",
    "en": "Fixed window start (epoch ms)",
    "module": "自动继续",
    "group": "基本设置",
    "tab": "basic",
    "condition": "生效时段模式：指定窗口"
  },
  {
    "id": "auto-continue",
    "key": "activeUntil",
    "label": "指定窗口结束时间",
    "en": "Fixed window end (epoch ms)",
    "module": "自动继续",
    "group": "基本设置",
    "tab": "basic",
    "condition": "生效时段模式：指定窗口"
  },
  {
    "id": "auto-continue",
    "key": "autoAnswer",
    "label": "自动回答带推荐项的提问",
    "en": "Auto-answer prompts with a recommended option",
    "module": "自动继续",
    "group": "自动应答",
    "tab": "answer",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "suppressNotifyOnAutoAnswer",
    "label": "自动回答后抑制通知",
    "en": "Suppress notifications after an auto answer",
    "module": "自动继续",
    "group": "自动应答",
    "tab": "answer",
    "condition": "自动回答带推荐项的提问：开启"
  },
  {
    "id": "auto-continue",
    "key": "yieldToCompaction",
    "label": "让位上下文压缩",
    "en": "Yield to context compaction",
    "module": "自动继续",
    "group": "恢复规则与协作",
    "tab": "recovery",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "yieldToWaitCap",
    "label": "让位等待截断",
    "en": "Yield to wait-cap truncation",
    "module": "自动继续",
    "group": "恢复规则与协作",
    "tab": "recovery",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "waitGraceMs",
    "label": "等待截断后的静默期（秒）",
    "en": "Silence after a truncated wait (ms)",
    "module": "自动继续",
    "group": "恢复规则与协作",
    "tab": "recovery",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "continueText",
    "label": "「继续」文本",
    "en": "Resume text",
    "module": "自动继续",
    "group": "消息与通知",
    "tab": "message",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "guardTools",
    "label": "附加工具护栏提示",
    "en": "Attach the tool guard notice",
    "module": "自动继续",
    "group": "消息与通知",
    "tab": "message",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "guardPendingText",
    "label": "工具未完成时的提示文本",
    "en": "Tool-pending notice text",
    "module": "自动继续",
    "group": "消息与通知",
    "tab": "message",
    "condition": "附加工具护栏提示：开启"
  },
  {
    "id": "auto-continue",
    "key": "guardDoneText",
    "label": "工具已完成时的提示文本",
    "en": "Tool-complete notice text",
    "module": "自动继续",
    "group": "消息与通知",
    "tab": "message",
    "condition": "附加工具护栏提示：开启"
  },
  {
    "id": "auto-continue",
    "key": "enabled",
    "label": "总开关",
    "en": "Master switch",
    "module": "自动继续",
    "group": "基本设置",
    "tab": "basic",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "notify",
    "label": "发送系统通知",
    "en": "Send notifications",
    "module": "自动继续",
    "group": "消息与通知",
    "tab": "message",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "locale",
    "label": "通知语言",
    "en": "Notification language",
    "module": "自动继续",
    "group": "消息与通知",
    "tab": "diagnostics",
    "condition": ""
  },
  {
    "id": "auto-continue",
    "key": "logLevel",
    "label": "日志级别",
    "en": "Log level",
    "module": "自动继续",
    "group": "诊断",
    "tab": "diagnostics",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "waitCapMs",
    "label": "子代理等待上限（秒）",
    "en": "",
    "module": "内耗护栏",
    "group": "常用策略",
    "tab": "tier",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "archiveToolResults",
    "label": "工具结果归档",
    "en": "",
    "module": "内耗护栏",
    "group": "常用策略",
    "tab": "tier",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "progressWatch",
    "label": "无进展提醒",
    "en": "",
    "module": "内耗护栏",
    "group": "常用策略",
    "tab": "tier",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "lockGuard",
    "label": "共享目录保护",
    "en": "",
    "module": "内耗护栏",
    "group": "常用策略",
    "tab": "tier",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "enabled",
    "label": "启用护栏行为",
    "en": "",
    "module": "内耗护栏",
    "group": "档位 / 高级参数与完整策略",
    "tab": "tier",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "starTopology",
    "label": "子代理只对主控汇报（星型拓扑）",
    "en": "",
    "module": "内耗护栏",
    "group": "子代理 / 子代理纪律",
    "tab": "subagent",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "resultsToFile",
    "label": "子代理结论写文件",
    "en": "",
    "module": "内耗护栏",
    "group": "子代理 / 子代理纪律",
    "tab": "subagent",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "lockTtlMs",
    "label": "锁自动过期（秒）",
    "en": "",
    "module": "内耗护栏",
    "group": "子代理 / 共享资源锁",
    "tab": "subagent",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "waterLevelNudge",
    "label": "增长式提醒",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 上下文水位提醒（默认关）",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "waterLevelStep",
    "label": "每长大多少 token 提醒一次",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 上下文水位提醒（默认关）",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "archiveThresholdChars",
    "label": "超过多少字符就归档",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 可选：工具结果归档",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "archiveKeepChars",
    "label": "摘要里保留首尾共多少字符",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 可选：工具结果归档",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "costNudge",
    "label": "统计本会话花费",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 花费与预算",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "budgetGate",
    "label": "到预算线时提醒一次",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 花费与预算",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "costBudgetUsd",
    "label": "本会话预算（美元，0 = 不设）",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 花费与预算",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "nudgeOnceOnly",
    "label": "同一原因只提醒一次",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 提醒方式与报表（0.3.0）",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "compactionFallbackRatio",
    "label": "压缩兜底：压力到窗口的百分之多少提醒",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 提醒方式与报表（0.3.0）",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "reportEnabled",
    "label": "收益自报表",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 提醒方式与报表（0.3.0）",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "progressMode",
    "label": "模式",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 无进展识别",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "progressFailureThreshold",
    "label": "同一失败重复几次算无进展",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 无进展识别",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "taskBudgetMs",
    "label": "阶段预算（秒）—— 到点触发复盘",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 阶段预算与无活动时限",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "taskBudgetReplies",
    "label": "阶段预算（模型回复次数）",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 阶段预算与无活动时限",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "idleLimitMs",
    "label": "多久没有新活动算\"疑似无响应\"（秒）",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 阶段预算与无活动时限",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "idleAction",
    "label": "到点怎么做",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 阶段预算与无活动时限",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "stageContract",
    "label": "最小阶段合同（warden_stage）",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 阶段预算与无活动时限",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "capabilityPrecheck",
    "label": "工具失败分型",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 阶段预算与无活动时限",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "reworkNudge",
    "label": "返工提醒",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 返工与重复读",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "reworkThreshold",
    "label": "同一文件改到第几次提醒",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 返工与重复读",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "rereadNudge",
    "label": "重复读提醒",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 返工与重复读",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "rereadThreshold",
    "label": "同一文件读到第几次提醒",
    "en": "",
    "module": "内耗护栏",
    "group": "执行与预算 / 返工与重复读",
    "tab": "context",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "editMissHint",
    "label": "改文件没匹配上时提示\"先重读\"",
    "en": "",
    "module": "内耗护栏",
    "group": "诊断 / 失败时的提示",
    "tab": "diag",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "unknownToolHint",
    "label": "未知工具时附上真实工具清单",
    "en": "",
    "module": "内耗护栏",
    "group": "诊断 / 失败时的提示",
    "tab": "diag",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "evidenceLedger",
    "label": "启用台账",
    "en": "",
    "module": "内耗护栏",
    "group": "诊断 / 读数指纹台账",
    "tab": "diag",
    "condition": ""
  },
  {
    "id": "warden",
    "key": "pathIgnore",
    "label": "忽略路径",
    "en": "",
    "module": "内耗护栏",
    "group": "诊断 / 忽略名单",
    "tab": "diag",
    "condition": ""
  },
  {
    "id": "reasoning-scroll",
    "key": "enabled",
    "label": "总开关",
    "en": "",
    "module": "思考滚动窗",
    "group": "思考过程滚动窗",
    "tab": "",
    "condition": ""
  },
  {
    "id": "reasoning-scroll",
    "key": "maxHeight",
    "label": "滚动窗高度（px）",
    "en": "",
    "module": "思考滚动窗",
    "group": "思考过程滚动窗",
    "tab": "",
    "condition": ""
  },
  {
    "id": "reasoning-scroll",
    "key": "gradientText",
    "label": "渐变文字",
    "en": "",
    "module": "思考滚动窗",
    "group": "思考过程滚动窗",
    "tab": "",
    "condition": ""
  },
  {
    "id": "reasoning-scroll",
    "key": "autoFollow",
    "label": "流式时自动贴底",
    "en": "",
    "module": "思考滚动窗",
    "group": "思考过程滚动窗",
    "tab": "",
    "condition": ""
  },
  {
    "id": "reasoning-scroll",
    "key": "showJumpButton",
    "label": "「跳到最新」按钮",
    "en": "",
    "module": "思考滚动窗",
    "group": "思考过程滚动窗",
    "tab": "",
    "condition": ""
  },
  {
    "id": "reasoning-scroll",
    "key": "expandOnStream",
    "label": "开始思考时自动展开",
    "en": "",
    "module": "思考滚动窗",
    "group": "思考过程滚动窗",
    "tab": "",
    "condition": ""
  },
  {
    "id": "reasoning-scroll",
    "key": "collapseOnDone",
    "label": "思考结束自动收起",
    "en": "",
    "module": "思考滚动窗",
    "group": "思考过程滚动窗",
    "tab": "",
    "condition": ""
  },
  {
    "id": "reasoning-scroll",
    "key": "includeToolCalls",
    "label": "工具过程也并入同一个高度上限",
    "en": "",
    "module": "思考滚动窗",
    "group": "思考过程滚动窗",
    "tab": "",
    "condition": ""
  },
  {
    "id": "memory-core",
    "key": "tier",
    "label": "档位",
    "en": "",
    "module": "记忆核心",
    "group": "全局设置（档位 / 模型来源 / 核心仓信息）",
    "tab": "",
    "condition": ""
  },
  {
    "id": "memory-core",
    "key": "modelSource",
    "label": "模型来源",
    "en": "",
    "module": "记忆核心",
    "group": "全局设置（档位 / 模型来源 / 核心仓信息）",
    "tab": "",
    "condition": ""
  },
  {
    "id": "memory-core",
    "key": "baseUrl",
    "label": "端点地址",
    "en": "",
    "module": "记忆核心",
    "group": "全局设置（档位 / 模型来源 / 核心仓信息）",
    "tab": "",
    "condition": "模型来源：local"
  },
  {
    "id": "memory-core",
    "key": "provider",
    "label": "供应商",
    "en": "",
    "module": "记忆核心",
    "group": "全局设置（档位 / 模型来源 / 核心仓信息）",
    "tab": "",
    "condition": "模型来源：api"
  },
  {
    "id": "memory-core",
    "key": "model",
    "label": "模型",
    "en": "",
    "module": "记忆核心",
    "group": "全局设置（档位 / 模型来源 / 核心仓信息）",
    "tab": "",
    "condition": "模型来源：api"
  },
  {
    "id": "laurel",
    "key": "timing",
    "label": "通知时机",
    "en": "",
    "module": "Laurel 通知",
    "group": "提醒规则",
    "tab": "rules",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "notifyOnQuestion",
    "label": "需要你回答 / 系统通知",
    "en": "",
    "module": "Laurel 通知",
    "group": "提醒规则",
    "tab": "rules",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "toastOnQuestion",
    "label": "需要你回答 / 页内卡片",
    "en": "",
    "module": "Laurel 通知",
    "group": "提醒规则",
    "tab": "rules",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "notifyOnPlanReview",
    "label": "计划待确认 / 系统通知",
    "en": "",
    "module": "Laurel 通知",
    "group": "提醒规则",
    "tab": "rules",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "toastOnPlanReview",
    "label": "计划待确认 / 页内卡片",
    "en": "",
    "module": "Laurel 通知",
    "group": "提醒规则",
    "tab": "rules",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "notifyOnApproval",
    "label": "需要你审批 / 系统通知",
    "en": "",
    "module": "Laurel 通知",
    "group": "提醒规则",
    "tab": "rules",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "toastOnApproval",
    "label": "需要你审批 / 页内卡片",
    "en": "",
    "module": "Laurel 通知",
    "group": "提醒规则",
    "tab": "rules",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "notifyOnCompletion",
    "label": "回合结束 / 系统通知",
    "en": "",
    "module": "Laurel 通知",
    "group": "提醒规则",
    "tab": "rules",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "toastOnCompletion",
    "label": "回合结束 / 页内卡片",
    "en": "",
    "module": "Laurel 通知",
    "group": "提醒规则",
    "tab": "rules",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "sound",
    "label": "提示音",
    "en": "",
    "module": "Laurel 通知",
    "group": "声音与卡片",
    "tab": "appearance",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "sticky",
    "label": "留在通知中心",
    "en": "",
    "module": "Laurel 通知",
    "group": "声音与卡片",
    "tab": "appearance",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "soundFile",
    "label": "自定义提示音",
    "en": "",
    "module": "Laurel 通知",
    "group": "声音与卡片",
    "tab": "appearance",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "toastMs",
    "label": "停留（秒，0 = 不自动关）",
    "en": "",
    "module": "Laurel 通知",
    "group": "声音与卡片",
    "tab": "appearance",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "toastCorner",
    "label": "角落",
    "en": "",
    "module": "Laurel 通知",
    "group": "声音与卡片",
    "tab": "appearance",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "throttleSeconds",
    "label": "同一会话最小间隔（秒）",
    "en": "",
    "module": "Laurel 通知",
    "group": "其他",
    "tab": "rules",
    "condition": ""
  },
  {
    "id": "laurel",
    "key": "title",
    "label": "标题前缀（留空 = 用会话标题）",
    "en": "",
    "module": "Laurel 通知",
    "group": "其他",
    "tab": "rules",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "model",
    "label": "场景主体",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "场景主体",
    "tab": "",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "zoom",
    "label": "展示缩放",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "场景主体",
    "tab": "",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "colorMode",
    "label": "跟随主题配色",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "点缀颜色",
    "tab": "",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "accent",
    "label": "自定点缀颜色",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "点缀颜色",
    "tab": "",
    "condition": "跟随主题配色：自定义"
  },
  {
    "id": "scene",
    "key": "ratio",
    "label": "点缀占比",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "点缀颜色",
    "tab": "",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "glow",
    "label": "发光方式",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "发光方式",
    "tab": "",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "strength",
    "label": "光晕强度",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "发光方式",
    "tab": "",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "haloRadius",
    "label": "光晕扩散",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "发光方式",
    "tab": "",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "rotation",
    "label": "旋转速度",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "粒子运动",
    "tab": "",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "inkSpeed",
    "label": "流墨速度",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "流墨切换",
    "tab": "",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "inkFPS",
    "label": "流墨帧率",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "流墨切换",
    "tab": "",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "inkPaused",
    "label": "暂停流墨",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "流墨切换",
    "tab": "",
    "condition": ""
  },
  {
    "id": "scene",
    "key": "reduced",
    "label": "减少动态效果",
    "en": "",
    "module": "控制中心场景与动效",
    "group": "动态偏好",
    "tab": "",
    "condition": ""
  },
  {
    "id": "harness",
    "key": "theme",
    "label": "界面主题",
    "en": "",
    "module": "Harness 界面主题",
    "group": "主题与明暗",
    "tab": "",
    "condition": ""
  },
  {
    "id": "harness",
    "key": "paperTone",
    "label": "纸色",
    "en": "",
    "module": "Harness 界面主题",
    "group": "画纸材质",
    "tab": "",
    "condition": "界面主题：si-paper-v01"
  },
  {
    "id": "harness",
    "key": "paperGrain",
    "label": "纸纹",
    "en": "",
    "module": "Harness 界面主题",
    "group": "画纸材质",
    "tab": "",
    "condition": "界面主题：si-paper-v01"
  },
  {
    "id": "harness",
    "key": "colorMode",
    "label": "跟随 Harness 明暗",
    "en": "",
    "module": "Harness 界面主题",
    "group": "主题与明暗",
    "tab": "",
    "condition": ""
  },
  {
    "id": "harness",
    "key": "paused",
    "label": "暂停流动",
    "en": "",
    "module": "Harness 界面主题",
    "group": "流墨动效",
    "tab": "",
    "condition": ""
  },
  {
    "id": "harness",
    "key": "speed",
    "label": "流动速度",
    "en": "",
    "module": "Harness 界面主题",
    "group": "流墨动效",
    "tab": "",
    "condition": ""
  },
  {
    "id": "harness",
    "key": "fps",
    "label": "流动帧率",
    "en": "",
    "module": "Harness 界面主题",
    "group": "流墨动效",
    "tab": "",
    "condition": ""
  },
  {
    "id": "harness",
    "key": "motion",
    "label": "减少动态效果",
    "en": "",
    "module": "Harness 界面主题",
    "group": "流墨动效",
    "tab": "",
    "condition": ""
  }
,{id:"experience",key:'sound',label:'总声音',en:"",module:"Laurel 设置",group:"声音与提醒",tab:'audio'},
{id:"experience",key:'soundEffects',label:'界面音效',en:"",module:"Laurel 设置",group:"声音与提醒",tab:'audio'},
{id:"experience",key:'music',label:'背景音乐',en:"",module:"Laurel 设置",group:"声音与提醒",tab:'audio'},
{id:"experience",key:'volume',label:'界面音量',en:"",module:"Laurel 设置",group:"声音与提醒",tab:'audio'},
{id:"experience",key:'musicVolume',label:'音乐音量',en:"",module:"Laurel 设置",group:"声音与提醒",tab:'audio'},
{id:"experience",key:'areaVolume',label:'AIC 区域语音',en:"",module:"Laurel 设置",group:"声音与提醒",tab:'audio'},
{id:"experience",key:'mode',label:'日夜模式',en:"",module:"Laurel 设置",group:"外观与动效",tab:'appearance'},
];
