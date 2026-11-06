/**
 * Laurel 系列 · 事件日志
 *
 * 每一条"判定"都落一条流水：弹了 / 有意没弹 / 点了 / 失败了。
 * 这是**事后能核对**的地基 —— 插件最常被问的问题就是"为什么没响"，
 * 而这个问题在只看代码的时候是答不出来的。
 *
 * 设计要点（别改，改了就没用了）：
 *   - **一行一个 JSON**：`Get-Content -Tail 5` 或 `jq` 直接能查；
 *   - **种类白名单**：只有声明过的 kind 才写进去，其它一律记成 `'other'`，
 *     免得浏览器半边一个拼写错误就污染整份日志；
 *   - **超 512KB 只留最后 200 行**：否则一个长久挂着的插件会写出一份几 MB 的日志；
 *   - **任何 IO 失败都吞掉**：记日志失败不许影响插件本身。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { pluginPaths } from './home.js'

const EVENT_LOG_MAX_BYTES = 512 * 1024
const EVENT_LOG_KEEP_LINES = 200
const EVENT_DETAIL_MAX_CHARS = 400

/** 字符串字段：截断；非字符串一律 null（不是空串 —— null 表示"没有这个信息"）。 */
function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null
}

/** 布尔字段：非布尔一律 null。 */
function bool(value) {
  return typeof value === 'boolean' ? value : null
}

/**
 * 造一个事件写入器。
 *
 * @param {object} options
 * @param {string} options.name 插件名（决定数据目录）
 * @param {Iterable<string>} options.kinds 允许的 kind 白名单
 * @param {string[]} options.extraKeys 这个插件特有的额外字段（会按 string/boolean 归一化）
 */
export function createEventWriter({ name, kinds, extraKeys = [] }) {
  const allowed = new Set(kinds)

  /** 一次调用无论成功失败都返回"本来要写的这条记录"，方便调用方/测试核对。 */
  function append(event, home) {
    const p = pluginPaths(name, home)
    const record = {
      t: new Date().toISOString(),
      kind: allowed.has(event?.kind) ? event.kind : 'other',
      sessionId: str(event?.sessionId, 80),
      title: str(event?.title, 120),
      body: str(event?.body, EVENT_DETAIL_MAX_CHARS),
      detail: str(event?.detail, EVENT_DETAIL_MAX_CHARS),
    }
    const src = event && typeof event === 'object' ? event : {}
    for (const key of extraKeys) {
      record[key] = typeof src[key] === 'boolean'
        ? src[key]
        : (typeof src[key] === 'string' ? src[key].slice(0, 120) : null)
    }
    try {
      mkdirSync(p.dir, { recursive: true })
      // 截断自己再吞掉异常：截断失败就继续追加，绝不因此丢事件。
      try {
        if (existsSync(p.events) && statSync(p.events).size > EVENT_LOG_MAX_BYTES) {
          const kept = readFileSync(p.events, 'utf8').split('\n').filter(Boolean).slice(-EVENT_LOG_KEEP_LINES)
          writeFileSync(p.events, `${kept.join('\n')}\n`, 'utf8')
        }
      } catch { /* 截断失败就继续追加 */ }
      appendFileSync(p.events, `${JSON.stringify(record)}\n`, 'utf8')
    } catch { /* 日志失败不影响插件本身 */ }
    return record
  }

  /**
   * 读最近 limit 条事件，**倒序**（最新的在前）。
   * 坏行直接跳过，不让一行坏 JSON 把整份历史废掉。
   */
  function read(limit = 20, home) {
    const p = pluginPaths(name, home)
    try {
      if (!existsSync(p.events)) return []
      const lines = readFileSync(p.events, 'utf8').split('\n').filter(Boolean)
      const take = Math.max(1, Math.min(EVENT_LOG_KEEP_LINES, limit))
      const rows = []
      for (const line of lines.slice(-take)) {
        try { rows.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
      }
      return rows.reverse()
    } catch {
      return []
    }
  }

  return { append, read, kinds: allowed }
}

export const EVENT_LOG_LIMITS = {
  maxBytes: EVENT_LOG_MAX_BYTES,
  keepLines: EVENT_LOG_KEEP_LINES,
  detailMaxChars: EVENT_DETAIL_MAX_CHARS,
}
