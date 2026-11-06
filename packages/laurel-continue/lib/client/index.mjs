/**
 * laurel-continue · 客户端半边：设置页、会话区开关、状态与时段面板
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 *
 * ── 这个文件只做四件事（对应 CONTRACT §7）──────────────────────────────
 *   1. 设置页：按 CONTRACT §2 的键分组渲染（时机 / 时段 / 自动应答 / 让位 /
 *      消息 / 其它），写回宿主 /laurel/continue/config；
 *   2. 会话区开关：注册 conversation.input.left，改的是**当前会话**的暂停态
 *      （POST /laurel/continue/action 带 sessionId 与 action 'pause' / 'unpause'）；
 *   3. 状态面板：读 /laurel/continue/status，显示 sent / recovered / failed /
 *      gaveUp / skipped / looped 与最近尝试；
 *   4. 时段可视化：显示当前是否在生效时段内、距离窗口开启还有多久。
 *
 * ── 客户端四条硬约束（CONTRACT §7.1）──────────────────────────────────
 *   · 产物是 classic script 里的 CJS factory：不许顶层 import、不许默认导出、
 *     不许动态 import()。本文件只写命名导出，打包器会剥掉 export 关键字。
 *   · require() 只认 platform seed 表。共享代码由打包器内联 —— kit 就在同一个
 *     作用域里，requestJSON / toMap / registerSettingsSection / pickText 直接可用。
 *   · 必须导出 apply(ctx)。
 *   · 顶层不许有依赖执行顺序的副作用：所有状态、store、组件都建在 apply 里面。
 *
 * ── 跨 realm 纪律（CONTRACT §7.4）──────────────────────────────────────
 *   判容器一律用跨 realm 仍然可靠的方式：Map 走 kit 的 toMap()，数组走
 *   Array.isArray()。**不用**「左值 instanceof 右值」这种判容器写法 ——
 *   bundle 与宿主分属不同 realm 时它恒为 false，会把有内容的容器判成空，
 *   而且不报错。
 *
 * ── 写这个文件时踩过的两个打包器坑（别改回去）──────────────────────────
 *   · 打包器的剥注释状态机不处理「模板串里嵌套模板串」，那种写法会让它错判
 *     字符串边界并产出坏代码。所以本文件**一个模板串都不用**，全部用 + 拼接。
 *   · 注释里也不要连着写「instanceof 加容器类型名」：默认构建保留注释，而
 *     验收脚本是按整份产物做文本匹配的，写进注释等于写进产物。
 */

/** 宿主半边注册的端点前缀（CONTRACT §5.2）。 */
const API = '/laurel/continue'

/**
 * 需要的客户端服务（CONTRACT §8）。
 * 只能写真实服务名：slots / uiSession / locale / configForms / connection。
 * uiSettings / uiSlots / uiLocale 是包名尾巴，写了会让整行停在 pending。
 */
const inject = ['slots', 'uiSession', 'locale']

/** 设置页条目 id —— 必须同时等于 registry.js 的 settingsId 与 CONTRACT §0 的值。 */
const SETTINGS_ID = 'auto-continue'
const SETTINGS_ORDER = 60

/** 会话区开关的插槽与 id（CONTRACT §7.3）。 */
const TOGGLE_SLOT = 'conversation.input.left'
const TOGGLE_ID = 'auto-continue'

/**
 * 首屏兜底。宿主端点还没通时界面必须画得出来；与 CONTRACT §2 的默认值同值。
 * （权威在宿主侧 lib/core/config.js，这里只是「读不到配置时」的显示底稿。）
 */
const FALLBACK = {
  enabled: true,
  graceMs: 10000,
  cooldownMs: 20000,
  maxConsecutive: 3,
  resumedKinds: ['error', 'max-tokens'],
  classify: true,
  loopAfterCompleted: false,
  loopMaxRounds: 20,
  loopMaxDurationMs: 3600000,
  loopBudgetNotice: true,
  scheduleMode: 'always',
  dayStart: '08:00',
  dayEnd: '22:00',
  customStart: '09:00',
  customEnd: '18:00',
  activeFrom: 0,
  activeUntil: 0,
  autoAnswer: true,
  suppressNotifyOnAutoAnswer: true,
  yieldToCompaction: true,
  yieldToWaitCap: true,
  waitGraceMs: 45000,
  continueText: '',
  guardTools: true,
  guardPendingText: '',
  guardDoneText: '',
  notify: true,
  locale: 'auto',
  logLevel: 'info',
}

/** CONTRACT §3 的 7 个 turn/end kind。resumedKinds 只能是它的子集。 */
const TURN_END_KINDS = [
  'completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked',
]

/** 界面文案（中英双语，语言跟 ctx.locale 走）。 */
const TEXT = {
  zh: {
    label: '自动继续',
    heading: '自动继续',
    desc: '会话被中断或撞到输出上限时自动发一条「继续」；可限定生效时段；提问带推荐项时自动选中。遇到上下文压缩或等待截断会主动让位。',
    runtime: '运行状态',
    stats: '今日统计',
    date: '统计日期',
    sent: '发出继续',
    recovered: '确认恢复',
    failed: '仍然失败',
    gaveUp: '达到上限放弃',
    skipped: '永久失败跳过',
    looped: '自主循环',
    byCode: '按原因码',
    attempts: '最近尝试',
    empty: '还没有记录。',
    pausedList: '会话级暂停',
    noPaused: '当前没有暂停的会话',
    pausedForever: '手动暂停',
    globalOff: '总开关已关闭，不会自动继续。',
    scheduleNow: '当前时段',
    scheduleState: '窗口状态',
    scheduleInside: '在生效时段内',
    scheduleOutside: '不在生效时段内',
    scheduleAlways: '全天生效',
    scheduleNext: '距离窗口开启',
    scheduleNoNext: '窗口已过期，不会再开启',
    scheduleModeUntil: '指定窗口',
    scheduleDayWindow: '日间窗口之外（夜间）',
    loadFailed: '读取失败：',
    loading: '正在读取宿主状态…',
    connecting: '正在连接宿主…',
    connected: '已连接宿主',
    refresh: '刷新',
    saved: '已保存并立即生效。',
    saving: '正在保存…',
    actions: '操作',
    resumeNow: '立即继续当前会话',
    pauseSession: '暂停当前会话',
    unpauseSession: '恢复当前会话',
    resetStats: '清零今日统计',
    loopReset: '清零循环额度',
    noSession: '当前没有选中的会话',
    resetConfirm: '已请求清零。',
    sessionPaused: '当前会话已暂停',
    sessionActive: '当前会话正常',
    loopBudget: '循环额度',
    loopRounds: '已用轮数',
    loopStarted: '开始时间',
    loopAllowed: '还能再开一轮',
    yes: '可以',
    no: '已停：',
    fieldHintEmpty: '留空则使用内置本地化文本',
    toggleOn: '自动继续：开',
    toggleOff: '自动继续：已暂停',
    toggleTitleOn: '本会话正常：中断后会自动继续。点击可只暂停这个会话。',
    toggleTitleOff: '本会话已暂停自动继续。点击恢复（不影响其它会话）。',
    groupTiming: '时机',
    groupSchedule: '时段',
    groupAnswer: '自动应答',
    groupYield: '让位',
    groupMessage: '消息',
    groupOther: '其它',
    groupHintTiming: '决定「什么时候续跑」以及自主循环的额度闸门。',
    groupHintSchedule: '不在生效时段内时，本模块完全不动作。',
    groupHintAnswer: '只对带推荐项的提问生效；计划审批永不自动答。',
    groupHintYield: '这两条是本模块与别人共存的核心：先让位，再决定要不要续跑。',
    groupHintMessage: '续跑时发出去的文本与工具护栏提示。',
    groupHintOther: '总开关、通知与日志。',
    optionsAlways: '全天',
    optionsDay: '日间',
    optionsNight: '夜间',
    optionsCustom: '自定义',
    optionsUntil: '指定窗口',
    optionsLocaleAuto: '跟随界面',
  },
  en: {
    label: 'Auto continue',
    heading: 'Auto continue',
    desc: 'Sends "continue" after an interrupted turn or a max-tokens stop; can be limited to a time window; answers prompts that carry a recommended option. Yields to context compaction and wait-cap truncation.',
    runtime: 'Runtime',
    stats: 'Today',
    date: 'Date',
    sent: 'Sent',
    recovered: 'Recovered',
    failed: 'Still failed',
    gaveUp: 'Gave up',
    skipped: 'Skipped (permanent)',
    looped: 'Loop rounds',
    byCode: 'By reason code',
    attempts: 'Recent attempts',
    empty: 'Nothing recorded yet.',
    pausedList: 'Session pauses',
    noPaused: 'No session is paused',
    pausedForever: 'manual pause',
    globalOff: 'The master switch is off; nothing will be resumed.',
    scheduleNow: 'Active window',
    scheduleState: 'Window state',
    scheduleInside: 'inside the active window',
    scheduleOutside: 'outside the active window',
    scheduleAlways: 'always active',
    scheduleNext: 'Opens in',
    scheduleNoNext: 'the window has expired and will not reopen',
    scheduleModeUntil: 'fixed window',
    scheduleDayWindow: 'night (outside the day window)',
    loadFailed: 'Read failed: ',
    loading: 'Reading host status…',
    connecting: 'Connecting to the host…',
    connected: 'Connected',
    refresh: 'Refresh',
    saved: 'Saved and applied.',
    saving: 'Saving…',
    actions: 'Actions',
    resumeNow: 'Resume the current session now',
    pauseSession: 'Pause the current session',
    unpauseSession: 'Unpause the current session',
    resetStats: 'Reset today stats',
    loopReset: 'Reset loop budget',
    noSession: 'No session selected',
    resetConfirm: 'Reset requested.',
    sessionPaused: 'This session is paused',
    sessionActive: 'This session is active',
    loopBudget: 'Loop budget',
    loopRounds: 'Rounds used',
    loopStarted: 'Started',
    loopAllowed: 'Another round allowed',
    yes: 'yes',
    no: 'stopped: ',
    fieldHintEmpty: 'Empty means the built-in localized text',
    toggleOn: 'Auto: on',
    toggleOff: 'Auto: paused',
    toggleTitleOn: 'This session auto-resumes after an interruption. Click to pause only this session.',
    toggleTitleOff: 'Auto continue is paused for this session only. Click to resume.',
    groupTiming: 'Timing',
    groupSchedule: 'Time window',
    groupAnswer: 'Auto answers',
    groupYield: 'Yielding',
    groupMessage: 'Message',
    groupOther: 'Other',
    groupHintTiming: 'Decides when to resume and caps the unattended loop.',
    groupHintSchedule: 'Outside the active window this module does nothing at all.',
    groupHintAnswer: 'Only prompts carrying a recommended option; plan review is never auto-answered.',
    groupHintYield: 'Coexistence happens here: yield first, then decide whether to resume.',
    groupHintMessage: 'The text sent on resume plus the tool guard notice.',
    groupHintOther: 'Master switch, notifications and logging.',
    optionsAlways: 'Always',
    optionsDay: 'Day',
    optionsNight: 'Night',
    optionsCustom: 'Custom',
    optionsUntil: 'Fixed window',
    optionsLocaleAuto: 'Follow the UI',
  },
}

/** 每个配置键的双语标签与说明。键集合必须覆盖 CONTRACT §2 的全部键。 */
const FIELD_TEXT = {
  graceMs: {
    zh: '中断后等待（秒）', en: 'Wait after interruption (seconds)',
    hintZh: '给宿主自己恢复留出时间；0 表示立刻继续。', hintEn: 'Give the host a moment to recover by itself; 0 resumes immediately.',
  },
  cooldownMs: {
    zh: '同一会话最小间隔（秒）', en: 'Per-session cooldown (seconds)',
    hintZh: '两次自动继续之间的最小间隔，避免对故障上游狂轰滥炸。', hintEn: 'Minimum gap between two automatic resumes.',
  },
  maxConsecutive: {
    zh: '连续失败上限', en: 'Consecutive failure cap',
    hintZh: '同一个会话连续失败这么多次就停手并通知。', hintEn: 'Stop and notify after this many consecutive failures in one session.',
  },
  resumedKinds: {
    zh: '允许续跑的结束原因', en: 'Resumable end reasons',
    hintZh: '只对选中的结束原因尝试恢复，其余情况保持停止。下方保留技术名称，便于排查。', hintEn: 'Resume only selected end reasons; all others remain stopped. Technical names are retained for diagnostics.',
  },
  classify: {
    zh: '区分临时与永久错误', en: 'Classify transient vs permanent errors',
    hintZh: '5xx / 429 / 超时 / 网络算临时；401 / 403 / 余额 / 模型不存在 / 上下文超限算永久。',
    hintEn: '5xx, 429, timeouts and network errors are transient; 401, 403, balance, unknown model and context overflow are permanent.',
  },
  loopAfterCompleted: {
    zh: '正常结束后继续（自主循环）', en: 'Continue after a completed turn (unattended loop)',
    hintZh: '打开等于按轮计费；默认关闭。', hintEn: 'Billed per round; off by default.',
  },
  loopMaxRounds: {
    zh: '循环最多轮数', en: 'Max loop rounds',
    hintZh: '自主循环的独立额度闸门。', hintEn: 'A separate budget for the unattended loop.',
  },
  loopMaxDurationMs: {
    zh: '循环总时长上限（秒）', en: 'Loop wall-clock cap (seconds)',
    hintZh: '到点即停并通知，不会自己续命。', hintEn: 'Stops and notifies at the deadline.',
  },
  loopBudgetNotice: {
    zh: '额度用尽时通知', en: 'Notify when the budget runs out',
    hintZh: '关掉也能停，只是不告诉你为什么停。', hintEn: 'The loop still stops; you just are not told why.',
  },
  scheduleMode: {
    zh: '生效时段模式', en: 'Active-window mode',
    hintZh: '按本机时区判断；指定日期窗口到期后自动关闭。', hintEn: 'Uses the local time zone. A fixed date window closes when it expires.',
  },
  dayStart: { zh: '日间窗口开始', en: 'Day window start', hintZh: 'HH:MM，含开始。', hintEn: 'HH:MM, start inclusive.' },
  dayEnd: {
    zh: '日间窗口结束', en: 'Day window end',
    hintZh: 'HH:MM，不含结束；开始晚于结束时跨午夜。', hintEn: 'HH:MM, end exclusive; a start later than the end crosses midnight.',
  },
  customStart: { zh: '自定义窗口开始', en: 'Custom window start', hintZh: 'HH:MM。', hintEn: 'HH:MM.' },
  customEnd: { zh: '自定义窗口结束', en: 'Custom window end', hintZh: 'HH:MM；开始等于结束表示全天。', hintEn: 'HH:MM; equal start and end mean all day.' },
  activeFrom: {
    zh: '指定日期窗口开始', en: 'Fixed window start',
    hintZh: '0 表示未设置。', hintEn: '0 means unset.',
  },
  activeUntil: {
    zh: '指定日期窗口结束', en: 'Fixed window end',
    hintZh: '0 或已过期即关闭。', hintEn: '0 or already past means closed.',
  },
  autoAnswer: {
    zh: '自动回答带推荐项的提问', en: 'Auto-answer prompts with a recommended option',
    hintZh: '没有推荐项时让模型自行决定；计划审批永不自动答。', hintEn: 'Without a recommended option the model decides; plan review is never auto-answered.',
  },
  suppressNotifyOnAutoAnswer: {
    zh: '自动回答后抑制通知', en: 'Suppress notifications after an auto answer',
    hintZh: '避免「都替你答了还提醒你」。', hintEn: 'Avoids reminding you about something already answered.',
  },
  yieldToCompaction: {
    zh: '让位上下文压缩', en: 'Yield to context compaction',
    hintZh: '上下文超限只通知、不续跑，因为压缩会在同一轮里重试。',
    hintEn: 'On context overflow only notify; compaction retries within the same turn.',
  },
  yieldToWaitCap: {
    zh: '让位等待截断', en: 'Yield to wait-cap truncation',
    hintZh: '识别被截断的主动等待，避免「每 30 秒一压一续」。', hintEn: 'Detects truncated waits so the loop cannot ping-pong every 30 seconds.',
  },
  waitGraceMs: {
    zh: '等待截断后的静默期（秒）', en: 'Silence after a truncated wait (seconds)',
    hintZh: '这段时间内的正常结束不触发自主循环。', hintEn: 'A normal completion inside this window does not start the loop.',
  },
  continueText: {
    zh: '「继续」文本', en: 'Resume text',
    hintZh: '支持 {code} {message} {status} {tool} {turn} 占位符；留空用内置文本。',
    hintEn: 'Supports the code / message / status / tool / turn placeholders; empty means the built-in text.',
  },
  guardTools: {
    zh: '附加工具护栏提示', en: 'Attach the tool guard notice',
    hintZh: '上一步工具可能没完成时提醒模型不要重放副作用。',
    hintEn: 'Reminds the model not to replay side effects when the previous tool may not have finished.',
  },
  guardPendingText: {
    zh: '工具未完成时的提示文本', en: 'Tool-pending notice text',
    hintZh: '留空用内置文本。', hintEn: 'Empty means the built-in text.',
  },
  guardDoneText: {
    zh: '工具已完成时的提示文本', en: 'Tool-complete notice text',
    hintZh: '留空用内置文本。', hintEn: 'Empty means the built-in text.',
  },
  enabled: {
    zh: '总开关', en: 'Master switch',
    hintZh: '关掉后不监听回合事件、不发任何消息。', hintEn: 'When off, turn events are ignored and nothing is sent.',
  },
  notify: {
    zh: '发送系统通知', en: 'Send notifications',
    hintZh: '放弃、跳过、额度用尽时会告诉你。', hintEn: 'Tells you when it gives up, skips or runs out of budget.',
  },
  locale: {
    zh: '通知语言', en: 'Notification language',
    hintZh: '只影响宿主发出的通知文案；这个页面的语言跟界面走。',
    hintEn: 'Only affects host notifications; this page follows the UI language.',
  },
  logLevel: {
    zh: '日志级别', en: 'Log level',
    hintZh: 'debug 会把每次判定的原因写进日志。', hintEn: 'debug logs the reason of every decision.',
  },
}

/* ------------------------------------------------------------------ *
 * 1. 小工具（全部纯函数，跨 realm 安全）
 * ------------------------------------------------------------------ */

/** 取数组：Array.isArray 跨 realm 仍然可靠，按原型判类型不可靠。 */
function asList(value) {
  return Array.isArray(value) ? value.slice() : []
}

/** 取普通对象；认不出来就给空对象。 */
function asObject(value) {
  return value !== null && typeof value === 'object' ? value : {}
}

/** 取错误文本，永不抛。 */
function errorText(error) {
  if (!error) return 'unknown error'
  if (typeof error.message === 'string' && error.message) return error.message
  return String(error)
}

/** 取有限数字，否则退回兜底值。 */
function asNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 数字夹在区间内。 */
function clampNumber(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  if (n < min) return min
  if (n > max) return max
  return n
}

/** 两位数。 */
function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/** 把时钟文本解析成「当天第几分钟」，认不出来返回 null。 */
function clockMinutes(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  const parts = value.split(':')
  if (parts.length !== 2) return null
  const h = Number(parts[0])
  const m = Number(parts[1])
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  if (Math.floor(h) !== h || Math.floor(m) !== m) return null
  return h * 60 + m
}

/** 规整成 HH:MM；认不出来退回兜底值。 */
function clockText(value, fallback) {
  const minutes = clockMinutes(value)
  if (minutes === null) return fallback
  return pad2(Math.floor(minutes / 60)) + ':' + pad2(minutes % 60)
}

/** 当期时刻在「当天第几分钟」（带秒的小数，用于算距离窗口开启）。 */
function minuteOfDay(nowMs) {
  const date = new Date(nowMs)
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
}

/** 半开区间判定（CONTRACT §4）：开始等于结束表示全天；开始晚于结束表示跨午夜。 */
function inClockWindow(startMin, endMin, currentMin) {
  if (startMin === endMin) return true
  if (startMin < endMin) return currentMin >= startMin && currentMin < endMin
  return currentMin >= startMin || currentMin < endMin
}

/** 距离下一次进入窗口还有多少毫秒；已在窗口内返回 0。 */
function msUntilClockWindow(startMin, endMin, nowMs) {
  const current = minuteOfDay(nowMs)
  if (inClockWindow(startMin, endMin, current)) return 0
  let delta = startMin - current
  if (delta <= 0) delta += 1440
  return Math.max(0, Math.round(delta * 60000))
}

/** 毫秒的人话。 */
function humanMs(ms, lang) {
  const total = Math.max(0, Math.round(asNumber(ms, 0) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (lang === 'zh') {
    if (hours > 0) return hours + ' 小时 ' + minutes + ' 分钟'
    if (minutes > 0) return minutes + ' 分钟 ' + seconds + ' 秒'
    return seconds + ' 秒'
  }
  if (hours > 0) return hours + 'h ' + minutes + 'm'
  if (minutes > 0) return minutes + 'm ' + seconds + 's'
  return seconds + 's'
}

/** 时间戳的人话（本地时区）。 */
function stampText(value) {
  const ms = asNumber(value, 0)
  if (ms <= 0) return '—'
  try {
    return new Date(ms).toLocaleString()
  } catch (error) {
    return String(ms)
  }
}

/** 从表里挑文案；缺键就原样显示键名（比显示 undefined 好查）。 */
function textOf(table, lang, key) {
  const bag = table && typeof table === 'object' ? table : {}
  const dict = bag[lang] || bag.en || {}
  const value = dict[key]
  return typeof value === 'string' ? value : key
}

/**
 * 判断当前界面语言。
 *
 * 优先级：ctx.locale 的活动语言 → 浏览器语言 → 英文。
 * 模块自己的 locale 配置**不参与**（CONTRACT §2 那个键是给宿主通知文案用的），
 * 界面语言一律跟 ctx.locale —— 这是本泳道拿到的明确要求。
 */
function resolveLanguage(ctx, navigatorObject) {
  try {
    const runtime = ctx && ctx.locale ? ctx.locale : null
    if (runtime && typeof runtime.getSnapshot === 'function') {
      const snapshot = runtime.getSnapshot()
      const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
      if (active) return active.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
    }
  } catch (error) {
    /* 拿不到 locale 服务就退回浏览器语言，不抛 */
  }
  const nav = navigatorObject || null
  const tags = []
  if (nav && typeof nav.language === 'string') tags.push(nav.language)
  if (nav && Array.isArray(nav.languages)) {
    for (let i = 0; i < nav.languages.length; i += 1) {
      if (typeof nav.languages[i] === 'string') tags.push(nav.languages[i])
    }
  }
  for (let i = 0; i < tags.length; i += 1) {
    if (tags[i].toLowerCase().indexOf('zh') === 0) return 'zh'
  }
  return 'en'
}

/* ------------------------------------------------------------------ *
 * 2. 时段可视化（CONTRACT §4 的语义，纯函数）
 * ------------------------------------------------------------------ */

/**
 * 由配置算出时段状态。**先看宿主给没给结论**由调用方决定（见 scheduleBlock）；
 * 这里只按 §4 的语义在本地推一份，供宿主没给 schedule 字段时使用。
 *
 * @returns {{ mode: string, active: boolean, msUntilOpen: number, hasNext: boolean }}
 *          msUntilOpen 为 0 表示已经在窗口内；hasNext 为 false 表示不会再开启。
 */
function scheduleState(configInput, nowMs) {
  const config = asObject(configInput)
  const mode = typeof config.scheduleMode === 'string' ? config.scheduleMode : 'always'
  const now = asNumber(nowMs, Date.now())
  if (mode === 'always') return { mode: mode, active: true, msUntilOpen: 0, hasNext: true }
  if (mode === 'until') {
    const from = asNumber(config.activeFrom, 0)
    const until = asNumber(config.activeUntil, 0)
    const active = until > now && now >= from
    if (active) return { mode: mode, active: true, msUntilOpen: 0, hasNext: true }
    if (from > now) return { mode: mode, active: false, msUntilOpen: from - now, hasNext: true }
    return { mode: mode, active: false, msUntilOpen: -1, hasNext: false }
  }
  if (mode === 'day') {
    const start = clockMinutes(clockText(config.dayStart, FALLBACK.dayStart))
    const end = clockMinutes(clockText(config.dayEnd, FALLBACK.dayEnd))
    const active = inClockWindow(start, end, minuteOfDay(now))
    return {
      mode: mode,
      active: active,
      msUntilOpen: active ? 0 : msUntilClockWindow(start, end, now),
      hasNext: true,
    }
  }
  if (mode === 'night') {
    const dayStart = clockMinutes(clockText(config.dayStart, FALLBACK.dayStart))
    const dayEnd = clockMinutes(clockText(config.dayEnd, FALLBACK.dayEnd))
    if (dayStart === dayEnd) {
      // 日间窗口是全天，那么「夜间」没有可进入的时刻 —— 明确说不会再开，
      // 而不是把它当成整天生效。
      return { mode: mode, active: false, msUntilOpen: -1, hasNext: false }
    }
    const active = !inClockWindow(dayStart, dayEnd, minuteOfDay(now))
    return {
      mode: mode,
      active: active,
      msUntilOpen: active ? 0 : msUntilClockWindow(dayEnd, dayStart, now),
      hasNext: true,
    }
  }
  const start = clockMinutes(clockText(config.customStart, FALLBACK.customStart))
  const end = clockMinutes(clockText(config.customEnd, FALLBACK.customEnd))
  const active = inClockWindow(start, end, minuteOfDay(now))
  return {
    mode: 'custom',
    active: active,
    msUntilOpen: active ? 0 : msUntilClockWindow(start, end, now),
    hasNext: true,
  }
}

/** 时段的短描述，给「当前时段」那一行用。 */
function windowLabel(configInput, lang) {
  const config = asObject(configInput)
  const mode = typeof config.scheduleMode === 'string' ? config.scheduleMode : 'always'
  if (mode === 'always') return textOf(TEXT, lang, 'scheduleAlways')
  if (mode === 'until') {
    const from = asNumber(config.activeFrom, 0)
    const until = asNumber(config.activeUntil, 0)
    if (from <= 0 && until <= 0) return textOf(TEXT, lang, 'scheduleModeUntil') + ' —'
    return textOf(TEXT, lang, 'scheduleModeUntil') + ' ' + stampText(from) + ' → ' + stampText(until)
  }
  if (mode === 'night') {
    return textOf(TEXT, lang, 'scheduleDayWindow') + ' '
      + clockText(config.dayEnd, FALLBACK.dayEnd) + ' → ' + clockText(config.dayStart, FALLBACK.dayStart)
  }
  if (mode === 'day') {
    return clockText(config.dayStart, FALLBACK.dayStart) + ' → ' + clockText(config.dayEnd, FALLBACK.dayEnd)
  }
  return clockText(config.customStart, FALLBACK.customStart) + ' → ' + clockText(config.customEnd, FALLBACK.customEnd)
}

/* ------------------------------------------------------------------ *
 * 3. 宿主数据面（CONTRACT §5.2）
 * ------------------------------------------------------------------ */

/** 读生效配置（读不到会让 requestJSON 抛，由调用方兜住）。 */
async function fetchConfig() {
  const data = await requestJSON(API, '/config')
  const body = asObject(data)
  return {
    config: Object.assign({}, FALLBACK, asObject(body.config)),
    defaults: Object.assign({}, FALLBACK, asObject(body.defaults)),
  }
}

/** 读运行状态。 */
async function fetchStatus() {
  return asObject(await requestJSON(API, '/status'))
}

/** 写配置：只发 patch，宿主负责归一化（CONTRACT §2）。 */
async function pushConfig(patch) {
  const data = await requestJSON(API, '/config', { method: 'POST', body: { config: patch } })
  try { window.dispatchEvent(new CustomEvent('laurel:configuration-saved', { detail: { id: 'auto-continue', persisted: true } })) } catch {}
  return Object.assign({}, FALLBACK, asObject(asObject(data).config))
}

/** 发一个动作（CONTRACT §5.2 的合法值）。 */
async function pushAction(action, sessionId) {
  const body = { action: action }
  if (typeof sessionId === 'string' && sessionId) body.sessionId = sessionId
  return asObject(await requestJSON(API, '/action', { method: 'POST', body: body }))
}

/* ------------------------------------------------------------------ *
 * 4. 极简外部 store（设置页与会话区开关共用一份数据）
 * ------------------------------------------------------------------ */

/**
 * 造一个 get/subscribe/set 的小 store。
 * 监听器用数组存，不用容器类型 —— 少一个跨 realm 话题。
 */
function createStore() {
  let state = {
    ready: false,
    loading: false,
    error: '',
    config: Object.assign({}, FALLBACK),
    defaults: Object.assign({}, FALLBACK),
    status: null,
  }
  const listeners = []
  const emit = () => {
    for (let i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i]()
      } catch (error) {
        /* 一个订阅者出错不连累其它订阅者 */
      }
    }
  }
  const set = (patch) => {
    state = Object.assign({}, state, patch)
    emit()
  }
  const load = async () => {
    set({ loading: true })
    try {
      const pair = await fetchConfig()
      let status = null
      try {
        status = await fetchStatus()
      } catch (error) {
        // 状态端点坏了不能连累设置页：配置还是要能改。
        status = null
      }
      set({
        ready: true,
        loading: false,
        error: '',
        config: pair.config,
        defaults: pair.defaults,
        status: status,
      })
    } catch (error) {
      set({ loading: false, error: errorText(error) })
    }
  }
  const save = async (patch) => {
    const config = await pushConfig(patch)
    set({ config: config, error: '' })
    return config
  }
  const act = async (action, sessionId) => {
    await pushAction(action, sessionId)
    await load()
  }
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    load: load,
    save: save,
    act: act,
  }
}

/* ------------------------------------------------------------------ *
 * 5. React 侧的小工具
 * ------------------------------------------------------------------ */

/**
 * 造一个「订阅外部 store」的 Hook。
 *
 * 优先用 React.useSyncExternalStore（React 18+ 的官方答案）；老版本没有它时
 * 退回 useState + useEffect。两种实现里 Hook 的调用顺序都是直线，不分支。
 */
function createExternalHook(React) {
  if (typeof React.useSyncExternalStore === 'function') {
    return function useExternal(getSnapshot, subscribe) {
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }
  }
  return function useExternal(getSnapshot, subscribe) {
    const pair = React.useState(getSnapshot())
    const setValue = pair[1]
    React.useEffect(() => subscribe(() => setValue(getSnapshot())), [])
    return pair[0]
  }
}

/* ------------------------------------------------------------------ *
 * 6. 入口
 * ------------------------------------------------------------------ */

/**
 * 插件入口。DSH 客户端 boot 时会调用它。
 * @param {object} ctx cordis 客户端上下文
 */
export function apply(ctx) {
  const React = require('react')
  const h = React.createElement
  const useExternal = createExternalHook(React)

  const navigatorObject = typeof navigator !== 'undefined' ? navigator : null
  const store = createStore()

  /** 当前界面语言（每次渲染现算，语言切换后下一次渲染就跟上）。 */
  const language = () => resolveLanguage(ctx, navigatorObject)
  const tr = (key) => textOf(TEXT, language(), key)

  /** 配置项的标签/说明。 */
  const fieldText = (name, part) => {
    const row = FIELD_TEXT[name] || {}
    const lang = language()
    const key = part === 'hint' ? (lang === 'zh' ? 'hintZh' : 'hintEn') : lang
    const value = row[key]
    return typeof value === 'string' ? value : name
  }

  /** 「当前窗口」的会话绑定（CONTRACT §7.3 要的是当前会话，不是全局）。 */
  const bindingSource = (() => {
    try {
      const session = ctx && ctx.uiSession ? ctx.uiSession : null
      const adapter = session && session.adapter ? session.adapter : null
      return adapter && adapter.current ? adapter.current : null
    } catch (error) {
      return null
    }
  })()
  const getBinding = bindingSource && typeof bindingSource.getSnapshot === 'function'
    ? () => {
      try {
        return bindingSource.getSnapshot()
      } catch (error) {
        return null
      }
    }
    : () => null
  const subscribeBinding = bindingSource && typeof bindingSource.subscribe === 'function'
    ? (listener) => bindingSource.subscribe(listener)
    : () => () => {}

  /* ---------------- 样式（与同套件其它模块同一套视觉） ---------------- */
  const hintStyle = { fontSize: 12, lineHeight: 1.6, marginTop: 5, opacity: 0.78 }
  const rowStyle = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }
  const inputStyle = { font: 'inherit', padding: '6px 8px', boxSizing: 'border-box', minWidth: 0, maxWidth: '100%' }
  const border = '1px solid rgba(128,128,128,.3)'
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }

  /* ---------------- 基础控件 ---------------- */
  const Note = (text) => h('p', { style: hintStyle }, text)

  const Section = (title, children, hint) => h('section', { style: { marginTop: 18 } },
    h('h3', { style: { fontSize: 14, margin: '0 0 8px' } }, title),
    hint ? h('p', { style: hintStyle }, hint) : null,
    children)

  const Row = (label, value) => h('div', {
    style: Object.assign({}, rowStyle, { justifyContent: 'space-between', borderTop: border, padding: '7px 0' }),
  },
  h('span', null, label),
  h('span', { style: { opacity: 0.85 } }, String(value)))

  const Button = (label, onClick, disabled, extra) => h('button', Object.assign({
    type: 'button',
    onClick: onClick,
    disabled: disabled === true,
    style: Object.assign({}, inputStyle, { cursor: 'pointer', marginRight: 6, marginTop: 4 }),
  }, extra || {}), label)

  const Toggle = (label, value, onChange, hint, disabled) => h('div', {
    className: 'lc-setting-row', style: { margin: '8px 0' },
  },
  h('label', { style: Object.assign({}, rowStyle, { cursor: 'pointer' }) },
    h('input', {
      type: 'checkbox',
      role: 'switch',
      className: 'lc-toggle-input',
      'aria-label': label,
      checked: value === true,
      disabled: disabled === true,
      onChange: (event) => onChange(event.target.checked),
    }),
    h('span', null, label)),
  hint ? h('div', { className: 'lc-setting-hint', style: Object.assign({}, hintStyle, { paddingLeft: 24 }) }, hint) : null)

  const NumberField = (label, hint, value, min, max, step, disabled, commit, integer = true) => h('div', {
    style: { margin: '10px 0' },
  },
  h('label', { style: rowStyle },
    h('span', { style: { flex: '1 1 240px' } }, label),
    h('input', {
      type: 'number',
      'aria-label': label,
      defaultValue: String(asNumber(value, 0)),
      key: 'n:' + label + ':' + String(value),
      min: min,
      max: max,
      step: step,
      disabled: disabled === true,
      style: Object.assign({}, inputStyle, { width: 130 }),
      onBlur: (event) => {
        if (event.target.value === '') return
        const next = clampNumber(event.target.value, min, max)
        if (next !== asNumber(value, NaN)) commit(integer ? Math.round(next) : next)
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter') event.target.blur()
      },
    })),
  hint ? h('div', { className: 'lc-setting-hint', style: hintStyle }, hint) : null)

  const localDateValue = (epoch) => {
    if (!epoch) return ''
    const date = new Date(epoch), pad = (n, width = 2) => String(n).padStart(width, '0')
    if (!Number.isFinite(date.getTime())) return ''
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) + '.' + pad(date.getMilliseconds(), 3)
  }
  const DateField = (label, hint, value, disabled, commit) => h('div', { style: { margin: '10px 0' } },
    h('label', { style: rowStyle }, h('span', { style: { flex: '1 1 240px' } }, label),
      h('input', { type: 'datetime-local', 'aria-label': label, defaultValue: localDateValue(value), key: 'date:' + value,
        step: '0.001', min: localDateValue(1), max: localDateValue(4102444800000), disabled, style: Object.assign({}, inputStyle, { maxWidth: '100%' }),
        onBlur: event => {
          if (event.target.value === localDateValue(value)) return
          if (!event.target.validity.valid) { event.target.reportValidity(); return }
          const next = event.target.value === '' ? 0 : new Date(event.target.value).getTime()
          if (Number.isFinite(next) && next !== value) commit(next)
        }, onKeyDown: event => { if (event.key === 'Enter') event.target.blur() } })),
    h('div', { style: hintStyle }, hint + ' · ' + Intl.DateTimeFormat().resolvedOptions().timeZone))

  const TextField = (label, hint, value, placeholder, disabled, commit, multiline) => h('div', {
    style: { margin: '10px 0' },
  },
  h('label', { style: { display: 'block' } },
    h('div', { style: { marginBottom: 4 } }, label),
    multiline === true
      ? h('textarea', {
        'aria-label': label,
        defaultValue: typeof value === 'string' ? value : '',
        key: 't:' + label + ':' + String(value),
        rows: 3,
        placeholder: placeholder,
        disabled: disabled === true,
        style: Object.assign({}, inputStyle, { width: '100%', resize: 'vertical' }),
        onBlur: (event) => {
          if (event.target.value !== (typeof value === 'string' ? value : '')) commit(event.target.value)
        },
      })
      : h('input', {
        type: 'text',
        'aria-label': label,
        defaultValue: typeof value === 'string' ? value : '',
        key: 't:' + label + ':' + String(value),
        placeholder: placeholder,
        disabled: disabled === true,
        style: Object.assign({}, inputStyle, { width: '100%' }),
        onBlur: (event) => {
          if (event.target.value !== (typeof value === 'string' ? value : '')) commit(event.target.value)
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter') event.target.blur()
        },
      })),
  hint ? h('div', { className: 'lc-setting-hint', style: hintStyle }, hint) : null)

  const ClockField = (label, hint, value, fallback, disabled, commit) => h('div', {
    style: { margin: '10px 0' },
  },
  h('label', { style: rowStyle },
    h('span', { style: { flex: '1 1 240px' } }, label),
    h('input', {
      type: 'text',
      inputMode: 'numeric',
      'aria-label': label,
      defaultValue: clockText(value, fallback),
      key: 'c:' + label + ':' + String(value),
      placeholder: 'HH:MM',
      disabled: disabled === true,
      style: Object.assign({}, inputStyle, { width: 96 }),
      onBlur: (event) => {
        const next = clockText(event.target.value, fallback)
        event.target.value = next
        if (next !== clockText(value, fallback)) commit(next)
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter') event.target.blur()
      },
    })),
  hint ? h('div', { className: 'lc-setting-hint', style: hintStyle }, hint) : null)

  const SelectField = (label, hint, value, options, disabled, commit) => h('div', {
    style: { margin: '10px 0' },
  },
  h('label', { style: rowStyle },
    h('span', { style: { flex: '1 1 240px' } }, label),
    h('select', {
      'aria-label': label,
      value: String(value === undefined || value === null ? '' : value),
      disabled: disabled === true,
      style: Object.assign({}, inputStyle, { width: 180 }),
      onChange: (event) => commit(event.target.value),
    }, options.map((option) => h('option', { key: option[0], value: option[0] }, option[1])))),
  hint ? h('div', { className: 'lc-setting-hint', style: hintStyle }, hint) : null)

  /** resumedKinds：7 个 kind 的多选。宿主只认白名单内的值（CONTRACT §3）。 */
  const KindPicker = (label, hint, value, disabled, commit) => {
    const current = asList(value)
    return h('div', { style: { margin: '10px 0' } },
      h('div', { style: { marginBottom: 4 } }, label),
      h('div', { style: rowStyle }, TURN_END_KINDS.map((kind) => h('label', {
        key: kind,
        style: Object.assign({}, rowStyle, { gap: 5, cursor: 'pointer', marginRight: 10 }),
      },
      h('input', {
        type: 'checkbox',
        'aria-label': kind,
        checked: current.indexOf(kind) >= 0,
        disabled: disabled === true,
        onChange: (event) => {
          const next = current.filter((item) => item !== kind)
          if (event.target.checked) next.push(kind)
          commit(next)
        },
      }),
      h('span', { style: mono }, kind)))),
      hint ? h('div', { className: 'lc-setting-hint', style: hintStyle }, hint) : null)
  }

  /* ---------------- 配置字段清单（CONTRACT §2 的六个分组） ---------------- */
  const FIELDS = [
    ['basic', ['enabled', 'graceMs', 'cooldownMs', 'maxConsecutive', 'scheduleMode', 'dayStart', 'dayEnd', 'customStart', 'customEnd', 'activeFrom', 'activeUntil']],
    ['loop', ['loopAfterCompleted', 'loopMaxRounds', 'loopMaxDurationMs', 'loopBudgetNotice']],
    ['answer', ['autoAnswer', 'suppressNotifyOnAutoAnswer']],
    ['recovery', ['classify', 'resumedKinds', 'yieldToCompaction', 'yieldToWaitCap', 'waitGraceMs']],
    ['message', ['notify', 'continueText', 'guardTools', 'guardPendingText', 'guardDoneText']],
    ['diagnostics', ['locale', 'logLevel']],
  ]
  const GROUP_TEXT = {
    basic: ['基本设置', 'Basics'], loop: ['自主循环', 'Unattended loop'], answer: ['自动应答', 'Auto answers'],
    recovery: ['恢复与协作', 'Recovery and coordination'], message: ['消息与通知', 'Messages and notifications'], diagnostics: ['诊断', 'Diagnostics'],
  }
  const applicable = (key, config) => {
    if (key === 'dayStart' || key === 'dayEnd') return config.scheduleMode === 'day' || config.scheduleMode === 'night'
    if (key === 'customStart' || key === 'customEnd') return config.scheduleMode === 'custom'
    if (key === 'activeFrom' || key === 'activeUntil') return config.scheduleMode === 'until'
    if (['loopMaxRounds', 'loopMaxDurationMs', 'loopBudgetNotice'].includes(key)) return config.loopAfterCompleted === true
    if (key === 'suppressNotifyOnAutoAnswer') return config.autoAnswer === true
    if (key === 'waitGraceMs') return config.yieldToWaitCap === true
    if (key === 'guardPendingText' || key === 'guardDoneText') return config.guardTools === true
    return true
  }


  /**
   * 设置页组件。
   *
   * 三条纪律：
   *   1. **写失败不许显示「已保存」** —— 顶部状态条直接给失败原因；
   *   2. 界面上每个数都来自宿主回的归一化配置，不拿本地默认值冒充生效值；
   *   3. 时段那一块定时重算，用户能看见窗口什么时候开。
   */
  function Settings() {
    const snapshot = useExternal(store.get, store.subscribe)
    const binding = useExternal(getBinding, subscribeBinding)
    const busyPair = React.useState(false)
    const busy = busyPair[0]
    const setBusy = busyPair[1]
    const noticePair = React.useState('')
    const notice = noticePair[0]
    const setNotice = noticePair[1]
    const problemPair = React.useState('')
    const problem = problemPair[0]
    const setProblem = problemPair[1]
    const setTick = React.useState(0)[1]
    const sessionId = binding && typeof binding.key === 'string' ? binding.key : ''
    const config = snapshot.config
    const [tab, setTab] = React.useState('basic')

    React.useEffect(() => { const locate = event => { if(event.detail?.id === 'auto-continue' && FIELDS.some(row => row[0] === event.detail.tab))setTab(event.detail.tab) }; window.addEventListener('laurel:locate-setting',locate);return()=>window.removeEventListener('laurel:locate-setting',locate) }, [])

    React.useEffect(() => {
      store.load()
    }, [sessionId])

    React.useEffect(() => {
      // 只要这一页开着，就定时重算「距离窗口开启」。
      const timer = setInterval(() => setTick((value) => value + 1), 30000)
      return () => clearInterval(timer)
    }, [])

    const run = async (work, okText) => {
      setBusy(true)
      setProblem('')
      setNotice('')
      try {
        await work()
        if (okText) setNotice(okText)
      } catch (error) {
        setProblem(errorText(error))
      } finally {
        setBusy(false)
      }
    }

    const save = (patch) => run(() => store.save(patch), tr('saved'))
    const disabled = busy || snapshot.ready !== true

    /** 渲染一个配置项。 */
    const renderField = (name) => {
      const value = config[name]
      const label = fieldText(name, 'label')
      const hint = fieldText(name, 'hint')
      if (name === 'activeFrom' || name === 'activeUntil') return DateField(label, hint, value, disabled, next => save({ [name]: next }))
      if (name === 'resumedKinds') return KindPicker(label, hint, value, disabled, (next) => save({ resumedKinds: next }))
      if (name === 'scheduleMode') {
        return SelectField(label, hint, value, [
          ['always', tr('optionsAlways')],
          ['day', tr('optionsDay')],
          ['night', tr('optionsNight')],
          ['custom', tr('optionsCustom')],
          ['until', tr('optionsUntil')],
        ], disabled, (next) => save({ scheduleMode: next }))
      }
      if (name === 'locale') {
        return SelectField(label, hint, value, [
          ['auto', tr('optionsLocaleAuto')],
          ['zh', '中文'],
          ['en', 'English'],
        ], disabled, (next) => save({ locale: next }))
      }
      if (name === 'logLevel') {
        return SelectField(label, hint, value, [
          ['debug', 'debug'],
          ['info', 'info'],
          ['warn', 'warn'],
          ['error', 'error'],
        ], disabled, (next) => save({ logLevel: next }))
      }
      if (typeof value === 'boolean') return Toggle(label, value, (next) => save({ [name]: next }), hint, disabled)
      if (name === 'dayStart' || name === 'dayEnd' || name === 'customStart' || name === 'customEnd') {
        return ClockField(label, hint, value, FALLBACK[name], disabled, (next) => save({ [name]: next }))
      }
      if (name === 'continueText') {
        return TextField(label, hint, value, tr('fieldHintEmpty'), disabled,
          (next) => save({ continueText: next }), true)
      }
      if (name === 'guardPendingText' || name === 'guardDoneText') {
        return TextField(label, hint, value, tr('fieldHintEmpty'), disabled, (next) => save({ [name]: next }), false)
      }
      const limits = {
        graceMs: [0, 300000, 500],
        cooldownMs: [0, 3600000, 1000],
        maxConsecutive: [1, 100, 1],
        loopMaxRounds: [1, 1000, 1],
        loopMaxDurationMs: [60000, 86400000, 60000],
        waitGraceMs: [0, 600000, 5000],
        activeFrom: [0, 4102444800000, 60000],
        activeUntil: [0, 4102444800000, 60000],
      }[name] || [0, 1000000, 1]
      const seconds = ['graceMs', 'cooldownMs', 'loopMaxDurationMs', 'waitGraceMs'].includes(name)
      return seconds
        ? NumberField(label, hint, value / 1000, limits[0] / 1000, limits[1] / 1000, 0.001, disabled, next => save({ [name]: Math.round(next * 1000) }), false)
        : NumberField(label, hint, value, limits[0], limits[1], limits[2], disabled, next => save({ [name]: next }))
    }

    /**
     * 时段可视化：现在在不在窗口里、还有多久开。
     *
     * ── 两个真相源，宿主的优先 ────────────────────────────────────────
     * 宿主 /status 实际给的是**三个平铺字段**：schedule（人话描述）、
     * scheduleActive（boolean）、msUntilWindowOpen（number）。CONTRACT §5.1
     * 只写了 stats / attempts / paused，这三个字段是 P2 实现时补的、契约里
     * 没登记 —— 所以这里**两种形状都认**：有宿主结论就用宿主的（同一份语义
     * 只该有一个实现），没有才用本文件按 CONTRACT §4 语义算的那份。
     */
    const scheduleBlock = () => {
      const status = asObject(snapshot.status)
      const nowMs = Date.now()
      const local = scheduleState(config, nowMs)
      const hostActive = typeof status.scheduleActive === 'boolean' ? status.scheduleActive : null
      const hostMsUntil = Number.isFinite(Number(status.msUntilWindowOpen))
        ? Number(status.msUntilWindowOpen)
        : null
      // 兼容「以后契约改成嵌套对象」的可能：两种都认，宿主的优先。
      const nested = status.schedule && typeof status.schedule === 'object' ? asObject(status.schedule) : null
      const active = hostActive !== null
        ? hostActive
        : (nested && typeof nested.active === 'boolean' ? nested.active : local.active)
      const msUntil = hostMsUntil !== null
        ? hostMsUntil
        : (nested && Number.isFinite(Number(nested.msUntilOpen)) ? Number(nested.msUntilOpen) : local.msUntilOpen)
      const described = typeof status.schedule === 'string' && status.schedule
        ? status.schedule
        : null
      const lang = language()
      const rows = [
        // 宿主给了人话描述就用它（那是 P2 describeSchedule 的输出，中文）。
        Row(tr('scheduleNow'), described === null ? windowLabel(config, lang) : described),
        Row(tr('scheduleState'), active ? tr('scheduleInside') : tr('scheduleOutside')),
      ]
      if (!active) {
        rows.push(Row(tr('scheduleNext'), msUntil > 0 ? humanMs(msUntil, lang) : tr('scheduleNoNext')))
      }
      if (config.loopAfterCompleted === true) {
        const stats = asObject(status.stats)
        rows.push(Row(tr('loopBudget'),
          String(asNumber(stats.loopRounds, 0)) + ' / ' + String(asNumber(config.loopMaxRounds, 0))))
        // 宿主给了闸门结论就照抄 —— 「还能不能再开一轮」和「已用几轮」是两件事。
        const budget = status.loopBudget && typeof status.loopBudget === 'object' ? asObject(status.loopBudget) : null
        if (budget) {
          rows.push(Row(tr('loopAllowed'),
            budget.allowed === true ? tr('yes') : (tr('no') + (budget.detail ? ' · ' + String(budget.detail) : ''))))
        }
        if (asNumber(stats.loopStartedAt, 0) > 0) {
          rows.push(Row(tr('loopStarted'), stampText(stats.loopStartedAt)))
        }
      }
      return Section(tr('groupSchedule'), h('div', null, rows), tr('groupHintSchedule'))
    }

    /** 统计面板（CONTRACT §5.1 的计数口径）。 */
    const statsBlock = () => {
      const stats = asObject(asObject(snapshot.status).stats)
      const counts = [
        ['sent', asNumber(stats.sent, 0)],
        ['recovered', asNumber(stats.recovered, 0)],
        ['failed', asNumber(stats.failed, 0)],
        ['gaveUp', asNumber(stats.gaveUp, 0)],
        ['skipped', asNumber(stats.skipped, 0)],
        ['looped', asNumber(stats.looped, 0)],
      ]
      const byCode = asObject(stats.byCode)
      const codeKeys = Object.keys(byCode)
      const rows = counts.map((item) => Row(tr(item[0]), item[1]))
      rows.push(Row(tr('date'), typeof stats.date === 'string' ? stats.date : '—'))
      return Section(tr('stats'), h('div', null, rows),
        codeKeys.length === 0 ? null
          : Note(tr('byCode') + ': ' + codeKeys.map((key) => key + ' ' + String(byCode[key])).join(' · ')))
    }

    /** 会话级暂停与操作。 */
    const actionBlock = () => {
      const paused = asList(asObject(snapshot.status).paused)
      const sessionPaused = sessionId !== '' && paused.some((item) => asObject(item).sessionId === sessionId)
      const pausedRows = paused.length === 0
        ? Note(tr('noPaused'))
        : h('div', null, paused.map((item, index) => {
          const row = asObject(item)
          const until = asNumber(row.until, 0)
          return h('div', {
            key: String(row.sessionId || index),
            style: Object.assign({}, rowStyle, { justifyContent: 'space-between', borderTop: border, padding: '6px 0' }),
          },
          h('span', { style: mono }, String(row.sessionId || '—').slice(0, 24)),
          h('span', { style: { opacity: 0.8 } }, until > 0 ? stampText(until) : tr('pausedForever')))
        }))
      return Section(tr('actions'), h('div', null,
        Note(tr('pausedList')),
        pausedRows,
        h('div', { style: { marginTop: 10 } },
          Button(tr('resumeNow'), () => run(() => store.act('resume-now', sessionId || undefined), tr('saved')),
            disabled || sessionId === ''),
          Button(sessionPaused ? tr('unpauseSession') : tr('pauseSession'),
            () => run(() => store.act(sessionPaused ? 'unpause' : 'pause', sessionId || undefined), tr('saved')),
            disabled || sessionId === ''),
          Button(tr('resetStats'), () => run(() => store.act('reset-stats'), tr('resetConfirm')), disabled),
          Button(tr('loopReset'), () => run(() => store.act('loop-reset'), tr('resetConfirm')), disabled)),
        sessionId === '' ? Note(tr('noSession')) : Note(sessionPaused ? tr('sessionPaused') : tr('sessionActive'))))
    }

    /** 最近尝试流水。 */
    const attemptBlock = () => {
      const attempts = asList(asObject(snapshot.status).attempts)
      if (attempts.length === 0) return Note(tr('empty'))
      return h('div', {
        style: { maxHeight: 200, overflowY: 'auto', border: border, borderRadius: 6, padding: '4px 10px' },
      }, attempts.slice(0, 20).map((item, index) => {
        const row = asObject(item)
        return h('div', {
          key: String(row.at || index) + ':' + String(index),
          style: Object.assign({}, mono, { padding: '3px 0', overflowWrap: 'anywhere', opacity: 0.9 }),
        }, stampText(row.at)
          + ' · ' + String(row.sessionId || '—').slice(0, 18)
          + ' · #' + String(asNumber(row.consecutive, 0))
          + ' · ' + String(row.reason === undefined ? '—' : row.reason))
      }))
    }

    const statusLine = problem
      ? tr('loadFailed') + problem
      : busy
        ? tr('saving')
        : snapshot.ready !== true
          ? (snapshot.error ? tr('loadFailed') + snapshot.error : tr('connecting'))
          : notice || (config.enabled === false ? tr('globalOff') : tr('connected'))

    const group = FIELDS.find(row => row[0] === tab)
    const labelFor = key => GROUP_TEXT[key][language() === 'en' ? 1 : 0]
    const groups = Section(labelFor(tab), h('div', null, group[1].filter(name => applicable(name, config)).map(name =>
      h('div', { key: name, 'data-setting-key': name }, renderField(name)))))
    const tabs = h('div', { role: 'tablist', 'aria-label': labelFor('basic'), style: { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '12px 0' },
      onKeyDown: event => {
        const index = FIELDS.findIndex(row => row[0] === tab), delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!delta) return
        event.preventDefault(); const next = FIELDS[(index + delta + FIELDS.length) % FIELDS.length][0]; setTab(next)
        event.currentTarget.querySelector('[data-settings-tab="' + next + '"]')?.focus()
      } }, FIELDS.map(([key]) => h('button', { key, type: 'button', role: 'tab', id: 'continue-tab-' + key, 'data-settings-tab': key,
        'aria-selected': tab === key, 'aria-controls': 'continue-panel', tabIndex: tab === key ? 0 : -1, disabled: busy,
        style: Object.assign({}, inputStyle, { cursor: 'pointer', border: '1px solid currentColor', background: tab === key ? 'rgba(128,128,128,.15)' : 'transparent', color: 'inherit' }),
        onClick: () => setTab(key) }, labelFor(key))))

    return h('div', {
      'data-laurel-module': '',
      style: { padding: '4px 2px 24px', fontSize: 13, lineHeight: 1.5, maxWidth: 780, color: 'inherit' },
    },
    h('h2', { className: 'lc-embedded-heading', style: { fontSize: 18, margin: '0 0 6px' } }, tr('heading')),
    h('p', { className: 'lc-embedded-description', style: { margin: '0 0 12px' } }, tr('desc')),
    h('div', {
      role: problem ? 'alert' : 'status',
      'aria-live': 'polite',
      style: { minHeight: 22, marginBottom: 6, opacity: problem ? 1 : 0.85 },
    }, statusLine),
    h('div', { style: { marginBottom: 8 } },
      Button(tr('refresh'), () => run(() => store.load()), disabled)),
    tabs,
    h('div', { role: 'tabpanel', id: 'continue-panel', 'aria-labelledby': 'continue-tab-' + tab },
      tab === 'basic' ? scheduleBlock() : null,
      groups,
      tab === 'diagnostics' ? h('div', null, Section(tr('runtime'), h('div', null, statsBlock(), h('div', { style: { marginTop: 10 } }, attemptBlock()))), actionBlock()) : null))
  }

  /* ---------------- 会话区开关（CONTRACT §7.3） ---------------- */
  /**
   * 单个会话的开关。判定依据只有一条：/status 的 paused 里有没有这个 sessionId。
   * 点它只动**这个会话**，全局开关在设置页里。
   */
  function ContinueToggle(props) {
    const snapshot = useExternal(store.get, store.subscribe)
    const binding = useExternal(getBinding, subscribeBinding)
    const busyPair = React.useState(false)
    const busy = busyPair[0]
    const setBusy = busyPair[1]
    const problemPair = React.useState('')
    const problem = problemPair[0]
    const setProblem = problemPair[1]
    const propSession = props && typeof props.sessionId === 'string' ? props.sessionId : ''
    const sessionId = propSession || (binding && typeof binding.key === 'string' ? binding.key : '')
    const config = snapshot.config

    React.useEffect(() => {
      if (snapshot.ready !== true && snapshot.loading !== true) store.load()
    }, [sessionId])

    // 全局关闭时不显示这个开关（CONTRACT §7.3 的「默认显示，可配置隐藏」）。
    if (config.enabled === false) return null
    if (snapshot.ready !== true) {
      return h('span', { style: { fontSize: 12, opacity: 0.6 }, title: tr('connecting') }, '…')
    }
    const pausedList = asList(asObject(snapshot.status).paused)
    const paused = sessionId !== '' && pausedList.some((item) => asObject(item).sessionId === sessionId)
    const onClick = async () => {
      if (busy || sessionId === '') return
      setBusy(true)
      setProblem('')
      try {
        await store.act(paused ? 'unpause' : 'pause', sessionId)
      } catch (error) {
        setProblem(errorText(error))
      } finally {
        setBusy(false)
      }
    }
    const label = paused ? tr('toggleOff') : tr('toggleOn')
    return h('button', {
      type: 'button',
      'aria-pressed': !paused,
      'aria-label': label,
      title: problem ? tr('loadFailed') + problem : (paused ? tr('toggleTitleOff') : tr('toggleTitleOn')),
      disabled: busy || sessionId === '',
      onClick: onClick,
      style: {
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        padding: '2px 9px',
        borderRadius: 999,
        cursor: busy ? 'progress' : 'pointer',
        border: border,
        background: 'transparent',
        color: 'inherit',
        opacity: paused ? 0.65 : 1,
        whiteSpace: 'nowrap',
      },
    }, (paused ? '○ ' : '● ') + label)
  }

  /* ---------------- 注册 ---------------- */

  /** 单个插槽注册失败不许连累其它功能（与同套件其它模块的 safeEffect 同一策略）。 */
  const safeRegister = (label, work) => {
    try {
      ctx.effect(work, 'laurel-continue.' + label)
    } catch (error) {
      try {
        console.warn('[laurel-continue] ' + label + ' 挂载失败（已跳过）：' + errorText(error))
      } catch (inner) {
        /* 无 console 环境忽略 */
      }
    }
  }

  // 设置页：走 kit 的两路注册（聚合插槽优先，装载机不在时退回 settings.section）。
  // 不自己写 slots.inject —— 那样会漏掉 laurel-center.module 那一路，卡片展开就是空的。
  safeRegister('settings', () => registerSettingsSection(ctx, {
    id: SETTINGS_ID,
    order: SETTINGS_ORDER,
    label: () => tr('label'),
    component: Settings,
    slots: ctx.slots,
  }))

  // 会话区开关：conversation.input.left 是 list 插槽，可以安全追加。
  if (ctx && ctx.slots && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
    safeRegister('input-toggle', () => ctx.slots.inject(TOGGLE_SLOT, () => ctx.slots.register({
      name: TOGGLE_SLOT,
      id: TOGGLE_ID,
      order: SETTINGS_ORDER,
      label: () => tr('label'),
    }, ContinueToggle)))
  }

  // 语言切换后重渲染：语言是 store 之外的另一条源，切换时重新拉一次数据把界面刷新。
  if (ctx && ctx.locale && typeof ctx.locale.subscribe === 'function') {
    safeRegister('locale-refresh', () => ctx.locale.subscribe(() => {
      try {
        store.load()
      } catch (error) {
        /* 语言切换时刷新失败不影响界面 */
      }
    }))
  }
}
