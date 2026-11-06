/**
 * laurel-continue · 生效时段判定（纯函数，无 IO）
 *
 * 语义（契约 §4）：
 *   - [start, end) **半开区间**；start === end 表示全天；
 *   - **start > end 时跨午夜**（如 22:00 → 06:00）；
 *   - until 模式：activeUntil > now >= activeFrom，未设置或已过期即关闭。
 *
 * 为什么这条要单独一个文件：跨午夜是这类判定最常见的一处写错 ——
 * 写成 now >= start && now < end 之后，夜间模式会**整天都为 false**，
 * 而界面上「生效时段：夜间」看起来一切正常。所以这里把它拆成可单测的纯函数。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

/** 一天的分钟数。 */
const MINUTES_PER_DAY = 24 * 60

/** 合法的 scheduleMode 取值。 */
export const SCHEDULE_MODES = Object.freeze(['always', 'day', 'night', 'custom', 'until'])

/** 两位数补零。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * HH:MM → 当天的分钟数。
 *
 * 接受 H:MM（如 8:05）与 HH:MM；不合法一律返回 undefined
 * （**不是 null、不是 -1** —— undefined 才能和「合法的 0 点」区分开）。
 *
 * @param {unknown} text
 * @returns {number|undefined}
 */
export function parseClock(text) {
  if (typeof text !== 'string') return undefined
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return undefined
  if (hours < 0 || hours > 23) return undefined
  if (minutes < 0 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/** 分钟数 → HH:MM（按一天取模，负数也能落到合法值上）。 */
export function formatClock(totalMinutes) {
  const n = Number(totalMinutes)
  if (!Number.isFinite(n)) return '00:00'
  const wrapped = ((Math.round(n) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  return pad2(Math.floor(wrapped / 60)) + ':' + pad2(wrapped % 60)
}

/**
 * 把时钟字符串规整成 HH:MM。解析不出来就用 fallback（fallback 也坏则 00:00）。
 *
 * @param {unknown} text
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeClock(text, fallback = '00:00') {
  const parsed = parseClock(text)
  if (parsed !== undefined) return formatClock(parsed)
  const spare = parseClock(fallback)
  return spare === undefined ? '00:00' : formatClock(spare)
}

/**
 * 归一化 scheduleMode。白名单外一律 always。
 *
 * 为什么闭合到 always 而不是关闭：所有失败方向里，always 是唯一不会让人
 * 「以为开着、其实没开」的一种；而真正想关掉的人有总开关。
 *
 * @param {unknown} value
 * @returns {'always'|'day'|'night'|'custom'|'until'}
 */
export function normalizeScheduleMode(value) {
  return typeof value === 'string' && SCHEDULE_MODES.includes(value) ? value : 'always'
}

/**
 * 某个模式的时钟窗口边界（当天分钟数）。
 *
 *   - day    [dayStart, dayEnd)
 *   - night  日间窗口的**补集**：[dayEnd, dayStart)，天然跨午夜
 *   - custom [customStart, customEnd)
 *   - always / until 没有时钟窗口（返回 null）
 *
 * @param {Record<string, unknown>} config
 * @returns {{start: number, end: number}|null}
 */
export function windowOf(config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const mode = normalizeScheduleMode(cfg.scheduleMode)
  if (mode === 'day') {
    return { start: parseClock(cfg.dayStart) ?? 8 * 60, end: parseClock(cfg.dayEnd) ?? 22 * 60 }
  }
  if (mode === 'night') {
    // 夜间 = day 窗口的补集：边界仍是 dayStart/dayEnd，只是方向反过来。
    return { start: parseClock(cfg.dayEnd) ?? 22 * 60, end: parseClock(cfg.dayStart) ?? 8 * 60 }
  }
  if (mode === 'custom') {
    return { start: parseClock(cfg.customStart) ?? 9 * 60, end: parseClock(cfg.customEnd) ?? 18 * 60 }
  }
  return null
}

/** nowMs 落在当天的第几分钟（本地时区）。 */
export function minuteOfDay(nowMs) {
  const date = new Date(Number(nowMs))
  if (Number.isNaN(date.getTime())) return 0
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * 半开区间判定，支持跨午夜。
 *
 * @param {number} minute 当天分钟数
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
export function isInWindow(minute, start, end) {
  const m = ((Math.round(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  if (start === end) return true
  if (start < end) return m >= start && m < end
  return m >= start || m < end
}

/**
 * 生效时段判定。**这是引擎发消息前的第一道闸门。**
 *
 * @param {Record<string, unknown>} config
 * @param {number} [nowMs] 当前 epoch 毫秒（测试注入）
 * @returns {boolean}
 */
export function isScheduleActive(config, nowMs = Date.now()) {
  const cfg = config && typeof config === 'object' ? config : {}
  const mode = normalizeScheduleMode(cfg.scheduleMode)
  const now = Number(nowMs)

  if (mode === 'always') return true

  if (mode === 'until') {
    const from = Number(cfg.activeFrom)
    const until = Number(cfg.activeUntil)
    // 未设置（0 / 非有限数）即关闭：until 是「一段绝对窗口」，没有窗口就没有开启。
    if (!Number.isFinite(until) || until <= 0) return false
    if (!Number.isFinite(now)) return false
    const start = Number.isFinite(from) && from > 0 ? from : 0
    return now >= start && now < until
  }

  const window = windowOf(cfg)
  if (window === null) return true
  return isInWindow(minuteOfDay(now), window.start, window.end)
}

/**
 * 距窗口开启还有多少毫秒；0 表示**现在已经开着**。
 *
 * 给引擎用：不在时段内时不用反复轮询，直接算一个「到点再检查」的定时器。
 *
 * @param {Record<string, unknown>} config
 * @param {number} [nowMs]
 * @returns {number}
 */
export function msUntilWindowOpen(config, nowMs = Date.now()) {
  const cfg = config && typeof config === 'object' ? config : {}
  const now = Number(nowMs)
  if (!Number.isFinite(now)) return 0
  if (isScheduleActive(cfg, now)) return 0

  const mode = normalizeScheduleMode(cfg.scheduleMode)

  if (mode === 'until') {
    const from = Number(cfg.activeFrom)
    if (Number.isFinite(from) && from > now) return Math.max(0, Math.round(from - now))
    // 已过期：窗口不会再开，交给调用方决定（返回 0 表示「别等定时器了」）。
    return 0
  }

  const window = windowOf(cfg)
  if (window === null) return 0

  const date = new Date(now)
  const minute = date.getHours() * 60 + date.getMinutes()
  let deltaMinutes = window.start - minute
  if (deltaMinutes <= 0) deltaMinutes += MINUTES_PER_DAY
  const secondsIntoMinute = date.getSeconds() + date.getMilliseconds() / 1000
  return Math.max(0, Math.round((deltaMinutes * 60 - secondsIntoMinute) * 1000))
}

/**
 * 中文短描述，用于日志与状态端点。
 *
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
export function describeSchedule(config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const mode = normalizeScheduleMode(cfg.scheduleMode)

  if (mode === 'always') return '全天'
  if (mode === 'until') {
    const from = Number(cfg.activeFrom)
    const until = Number(cfg.activeUntil)
    if (!Number.isFinite(until) || until <= 0) return '限时（未设置窗口，当前不生效）'
    const startText = Number.isFinite(from) && from > 0 ? new Date(from).toLocaleString('zh-CN') : '现在'
    return '限时（' + startText + ' → ' + new Date(until).toLocaleString('zh-CN') + '）'
  }

  const window = windowOf(cfg)
  if (window === null) return '全天'
  const label = mode === 'day' ? '日间' : (mode === 'night' ? '夜间' : '自定义')
  const arrow = window.start > window.end ? ' →（跨午夜）' : ' → '
  return label + ' ' + formatClock(window.start) + arrow + formatClock(window.end)
}
