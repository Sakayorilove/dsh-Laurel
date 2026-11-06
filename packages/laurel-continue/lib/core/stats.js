/**
 * laurel-continue · 统计与事件日志
 *
 * 两件事，一个文件，因为它们是一体两面：**统计是给人看的结论，事件日志是
 * 支撑结论的证据**。只留统计的话，「为什么今天一次都没续」永远答不出来。
 *
 * 事件日志落盘 `$DSH_HOME/laurel-continue/events.log`，一行一个 JSON（契约 §5.3）：
 *
 *   { at, kind, sessionId?, detail? }
 *
 * 七种 kind，前六种是契约规定的，后两种是本模块让位规则的可观测证据（§6.3）：
 *   fire / skip / recover / giveup / loop-blocked / answer / error
 *   yield-compaction / yield-waitcap
 *
 * 三条纪律：
 *   1. **超 512 KB 只留最后 200 行** —— 否则一个长期挂着的插件会写出一份几 MB 的日志；
 *   2. **detail 截断到 400 字符**；
 *   3. **所有 IO 失败都吞掉** —— 记日志失败不许影响续跑本身。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { pluginPaths } from './home.js'

/** 事件日志的轮转阈值（字节）。 */
export const EVENT_LOG_MAX_BYTES = 512 * 1024
/** 轮转时保留的行数。 */
export const EVENT_LOG_KEEP_LINES = 200
/** detail 字段的最大字符数。 */
export const EVENT_DETAIL_MAX_CHARS = 400

/** 契约 §5.3 规定的 kind 白名单 + §6.3 的两条让位证据。 */
export const EVENT_KINDS = Object.freeze([
  'fire',
  'skip',
  'recover',
  'giveup',
  'loop-blocked',
  'answer',
  'error',
  'yield-compaction',
  'yield-waitcap',
])

/** 白名单之外的 kind 记成 'error'（拼错不该静默消失，也不该污染整份日志）。 */
const KIND_SET = new Set(EVENT_KINDS)

/** 统计字段（§5.1）。 */
const STAT_KEYS = Object.freeze([
  'sent', 'recovered', 'failed', 'gaveUp', 'skipped', 'looped',
])

/** 本地日期 `YYYY-MM-DD`（统计按本地天重置，跟用户看到的一致）。 */
export function todayKey(nowMs = Date.now()) {
  const date = new Date(Number(nowMs))
  if (Number.isNaN(date.getTime())) return '1970-01-01'
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return String(year) + '-' + month + '-' + day
}

/** 造一份空白统计。 */
function blankStats(nowMs) {
  const out = { date: todayKey(nowMs) }
  for (const key of STAT_KEYS) out[key] = 0
  out.byCode = {}
  out.loopRounds = 0
  out.loopStartedAt = 0
  return out
}

/** 造一个统计容器。跨天自动重置（只重置日计数，自主循环额度另算）。 */
export function createStats(nowMs = Date.now()) {
  let state = blankStats(nowMs)

  /** 跨天时把日计数清零，但**保留**自主循环的额度用量（那是跨天的预算）。 */
  function roll(now) {
    const day = todayKey(now)
    if (day === state.date) return state
    const loopRounds = state.loopRounds
    const loopStartedAt = state.loopStartedAt
    state = blankStats(now)
    // 循环额度还没到点就跨天了：保留它，否则「今天 23:59 开循环」会在 0 点白送一轮。
    if (loopStartedAt > 0) {
      state.loopStartedAt = loopStartedAt
      state.loopRounds = loopRounds
    }
    return state
  }

  return {
    /**
     * 记一次。
     * @param {string} key STAT_KEYS 之一
     * @param {number} [at]
     */
    bump(key, at = Date.now()) {
      const current = roll(at)
      if (!STAT_KEYS.includes(key)) return current
      current[key] += 1
      return current
    },

    /** 错误码直方图 +1。 */
    bumpCode(code, at = Date.now()) {
      const current = roll(at)
      const label = typeof code === 'string' && code.length > 0 ? code.slice(0, 40) : 'UNKNOWN'
      current.byCode[label] = (current.byCode[label] ?? 0) + 1
      return current
    },

    /** 记一轮自主循环。 */
    bumpLoop(rounds = 1, at = Date.now()) {
      const current = roll(at)
      current.loopRounds += Math.max(0, Math.round(rounds))
      if (current.loopStartedAt === 0) current.loopStartedAt = at
      return current
    },

    /** 循环额度复位（用户点「重置额度」或新一轮会话开始时）。 */
    resetLoop() {
      state.loopRounds = 0
      state.loopStartedAt = 0
      return state
    },

    /** 统计整体复位（不含循环额度：那是另一件事，有独立的 resetLoop）。 */
    reset(nowMsNow = Date.now()) {
      state = blankStats(nowMsNow)
      return state
    },

    /** 只读快照（深拷贝，调用方改不动内部状态）。 */
    snapshot(nowMsNow = Date.now()) {
      const current = roll(nowMsNow)
      return {
        date: current.date,
        sent: current.sent,
        recovered: current.recovered,
        failed: current.failed,
        gaveUp: current.gaveUp,
        skipped: current.skipped,
        looped: current.looped,
        byCode: { ...current.byCode },
        loopRounds: current.loopRounds,
        loopStartedAt: current.loopStartedAt,
      }
    },
  }
}

/** 截断 detail；非字符串一律 null（null 表示「没有这个信息」，与空串不同）。 */
function detailOf(value) {
  return typeof value === 'string' ? value.slice(0, EVENT_DETAIL_MAX_CHARS) : null
}

/** sessionId 截断。 */
function sessionOf(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 80) : null
}

/**
 * 造一个事件写入器。
 *
 * @param {{name?: string}} [options]
 */
export function createEventLog(options = {}) {
  void options
  const name = 'laurel-continue'

  /**
   * 追加一条事件。**无论成败都返回本来要写的那条记录**，
   * 方便调用方/测试核对「本来想记什么」。
   *
   * @param {{kind: string, sessionId?: string, detail?: string, at?: number}} event
   * @param {string} [home]
   */
  function append(event, home) {
    const src = event && typeof event === 'object' ? event : {}
    const record = {
      at: Number.isFinite(src.at) ? Math.round(src.at) : Date.now(),
      kind: KIND_SET.has(src.kind) ? src.kind : 'error',
      sessionId: sessionOf(src.sessionId),
      detail: detailOf(src.detail),
    }
    const paths = pluginPaths(home ?? undefined)
    try {
      mkdirSync(paths.dir, { recursive: true })
      // 轮转自己再吞一次异常：轮转失败就继续追加，绝不因此丢掉这条事件。
      try {
        if (existsSync(paths.events) && statSync(paths.events).size > EVENT_LOG_MAX_BYTES) {
          const kept = readFileSync(paths.events, 'utf8')
            .split('\n')
            .filter(Boolean)
            .slice(-EVENT_LOG_KEEP_LINES)
          writeFileSync(paths.events, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8')
        }
      } catch { /* 轮转失败就继续追加 */ }
      appendFileSync(paths.events, JSON.stringify(record) + '\n', 'utf8')
    } catch { /* 日志失败不影响续跑本身 */ }
    return record
  }

  /**
   * 读最近 limit 条事件，**最新在前**。坏行直接跳过。
   * @param {number} [limit]
   * @param {string} [home]
   */
  function read(limit = 20, home) {
    const paths = pluginPaths(home ?? undefined)
    try {
      if (!existsSync(paths.events)) return []
      const wanted = Number.isFinite(limit) ? Math.max(1, Math.round(limit)) : 20
      const take = Math.min(EVENT_LOG_KEEP_LINES, wanted)
      const lines = readFileSync(paths.events, 'utf8').split('\n').filter(Boolean)
      const rows = []
      for (const line of lines.slice(-take)) {
        try { rows.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
      }
      return rows.reverse()
    } catch {
      return []
    }
  }

  return { append, read, kinds: new Set(EVENT_KINDS) }
}

export const EVENT_LOG_LIMITS = Object.freeze({
  maxBytes: EVENT_LOG_MAX_BYTES,
  keepLines: EVENT_LOG_KEEP_LINES,
  detailMaxChars: EVENT_DETAIL_MAX_CHARS,
})

export const STAT_FIELDS = STAT_KEYS
