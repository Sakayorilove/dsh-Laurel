/**
 * dsh-warden · 收益自报表（#5）
 *
 * 目的只有一个：让用户看得出**哪条护栏值得留**。
 * 今天（2026-10-17）的实测是：warden 自己有归档节省、提醒条数、花费的原始数据，
 * 但没有任何汇总 —— 于是"该关掉哪条"只能靠感觉。
 *
 * ── 数据源与口径 ────────────────────────────────────────────────────────
 *   - `events.log`：每行一个 JSON。`archive` 事件的 `at` 是**数字时间戳**
 *     （`host/archive.js` 用 `clock.now()` 写），其余事件的 `at` 是 **ISO 字符串**
 *     （`appendEvent` 统一包了一层 `new Date(...).toISOString()`）。
 *     两种都必须认；只认一种就会静默漏算掉整类事件。
 *   - `evidence.jsonl`：读数台账，`at` 是 ISO 字符串。
 *   - 花费：内存账本（`UsageLedger.list()`）。**拿不到就是 null，不是 0** ——
 *     "没统计"和"没花钱"是两件事。
 *
 * ── 不许把估算说成实测 ──────────────────────────────────────────────────
 * `savedTokensEst` 的语义是"归档后这段原文不会在后续每一步重发，按 2.5 字符/token
 * 折算省下的 token"，**不是**官方 usage 里的实测值，也不是账单。markdown 里逐字标注。
 */

import { readEvents } from './store.js'
import { costByTool, formatMoney } from './cost.js'

/**
 * 算"一条提醒"的 kind。
 *
 * `archive` / `archive-failed` / `evidence-record` / `lock-*` / `governance-*` /
 * `stage` / `ready` 这些是生命周期或记账事件，不是发给模型的提醒 —— 混进
 * "提醒条数"会让用户以为是模型被叨扰了那么多次，所以显式列白名单。
 */
export const NOTICE_KINDS = Object.freeze([
  'rework',
  'reread',
  'water-level',
  'no-progress',
  'cost-budget',
  'stage-budget',
  'compaction-fallback',
  'rules-fallback',
  'wait-capped',
  'edit-miss',
  'unknown-tool',
  'error-class',
])

/** `host/archive.js` 折算 token 时用的字符/token 比例（两处必须一致）。 */
export const ARCHIVE_CHARS_PER_TOKEN = 2.5

/**
 * 一条提醒「算不算复发」最少要看到几条 —— 少于这个数**无法判断**。
 *
 * 1 条只能证明「提醒发出去了」，证明不了「之后行为有没有变」。所以
 * `noticeRecurrence` 把「只出现过 1 条的键」单独记成 `unresolvedKeys`，
 * **绝不当成 0 次复发** —— 那正是虚荣指标的老毛病：把没观测写成没发生。
 */
export const RECURRENCE_MIN_NOTICES = 2

/**
 * 一条提醒的「同键」身份。
 *
 * 优先级：`key`（调用方显式给的稳定键）> `detail`（人读的那行）> kind 本身。
 * `detail` 里的 `×12` 这类计数每次都变，必须先抹掉，否则同一条提醒会被
 * 当成 N 个不同键，复发率恒为 0 —— 那种「测了等于没测」比不测更坏。
 */
function recurrenceKeyOf(row) {
  if (typeof row.key === 'string' && row.key.trim().length > 0) return row.key.trim()
  const raw = typeof row.detail === 'string' ? row.detail.trim() : ''
  if (raw.length === 0) return ''
  return raw.replace(/×\s*\d+/g, '×N')
}

/**
 * 提醒有效性：**同一键在提醒之后又 bump 了多少次**（P2-16）。
 *
 * ── 为什么换掉「提醒条数」───────────────────────────────────────────────
 * warden 自己量过：142 条提醒 ≈ 2.9 万字符常驻上下文、**零行为改变**。
 * 「发了多少条」是典型的虚荣指标 —— 多发一条只说明护栏更吵，不说明更有效。
 * 真正要回答的是「提醒之后，同一个问题又出现了几次」。这就是复发率。
 *
 * ── 口径（三条，缺一条结论就不可信）─────────────────────────────────────
 *   1. **同键 = (sessionId, kind, 归一化后的 detail)**。跨会话不合并：
 *      两个会话各自踩一次同一个文件，不代表提醒失效。
 *   2. **有过 count 的提醒用差值**：`rework` / `reread` 事件带 `count`
 *      （该键累计次数），所以「提醒后同键再 bump 次数」= 最后一条的 count
 *      减第一条的 count。这是**精确值**，不是估算。
 *   3. **没有 count 的提醒只数次数**：水位提醒这类没有累计计数，复发次数 =
 *      同键提醒条数 − 1，并明确标 `countKnown:false`（次数对，bump 数不知道）。
 *
 * ── 为什么默认配置下数据会很稀疏 ────────────────────────────────────────
 * `nudgeOnceOnly: true`（0.3.0 起的默认）让同一键**只发一条**提醒。
 * 既然只发一条，日志里就没有第二条可比 —— 于是 `evaluableKeys` 通常是 0。
 * 这时结论是「**没有可评估的提醒**」，**不是**「复发率 0%」。
 * 要真正评估有效性，需要临时把 `nudgeOnceOnly` 设成 false 跑一轮。
 *
 * @param {Array<object>} events 事件行（任意来源，纯函数只读入参）
 * @param {{sinceMs?: number, limit?: number}} [options]
 * @returns {{known: boolean, evaluableKeys: number, unresolvedKeys: number,
 *            noticeTotal: number, afterBumpsTotal: number|null,
 *            keys: Array<object>, byKind: object, note: string}}
 */
export function noticeRecurrence(events, options = {}) {
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : 0
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 20
  const note = '复发率口径：同一 (会话, 提醒类型, 归一化目标) 在提醒之后又出现的次数；'
    + '跨会话不合并。nudgeOnceOnly=true（默认）时每条提醒只出现一次，此时无法评估。'

  const groups = new Map()
  let noticeTotal = 0
  let order = 0
  for (const row of Array.isArray(events) ? events : []) {
    if (!row || typeof row !== 'object') continue
    if (!NOTICE_KINDS.includes(row.kind)) continue
    const at = eventTimeMs(row)
    if (at === null) continue
    if (at < sinceMs) continue
    noticeTotal++
    const sessionId = typeof row.sessionId === 'string' ? row.sessionId : ''
    const key = recurrenceKeyOf(row)
    const mapKey = `${sessionId}\u0000${row.kind}\u0000${key}`
    const count = finite(row.count)
    let group = groups.get(mapKey)
    if (!group) {
      group = {
        sessionId, kind: row.kind, key,
        notices: 0,
        firstAt: at,
        lastAt: at,
        countFrom: count,
        countTo: count,
        order: order++,
      }
      groups.set(mapKey, group)
    }
    group.notices += 1
    if (at < group.firstAt) { group.firstAt = at; group.countFrom = count }
    if (at >= group.lastAt) { group.lastAt = at; group.countTo = count }
  }

  const evaluable = []
  const byKind = {}
  for (const group of groups.values()) {
    const bucket = byKind[group.kind] ?? { evaluable: 0, unresolved: 0, notices: 0, afterBumps: 0 }
    bucket.notices += group.notices
    if (group.notices >= RECURRENCE_MIN_NOTICES) {
      bucket.evaluable += 1
      // 两端的 count 都有值才用差值；否则只能数次数。
      const countKnown = group.countFrom !== null && group.countTo !== null
      const afterBumps = countKnown
        ? Math.max(0, group.countTo - group.countFrom)
        : group.notices - 1
      bucket.afterBumps += afterBumps
      evaluable.push({
        sessionId: group.sessionId,
        kind: group.kind,
        key: group.key,
        notices: group.notices,
        countKnown,
        /** 回答「提醒有用吗」：>0 就是提醒之后同一个问题又来了这么多次。 */
        afterBumps,
        countFrom: group.countFrom,
        countTo: group.countTo,
        firstAt: group.firstAt,
        lastAt: group.lastAt,
        order: group.order,
      })
    } else {
      bucket.unresolved += 1
    }
    byKind[group.kind] = bucket
  }

  evaluable.sort((a, b) => (b.afterBumps - a.afterBumps) || (a.order - b.order))
  const afterBumpsTotal = evaluable.length === 0
    // 关键：没有可评估的键 → **null（未评估）**，不是 0（评估过且为 0）。
    ? null
    : evaluable.reduce((sum, item) => sum + item.afterBumps, 0)

  return {
    known: true,
    evaluableKeys: evaluable.length,
    unresolvedKeys: Object.values(byKind).reduce((sum, b) => sum + b.unresolved, 0),
    noticeTotal,
    afterBumpsTotal,
    keys: evaluable.slice(0, limit),
    byKind,
    note,
  }
}

/** 日志尾巴。events.log 超过 512KB 就轮转一半，这个上限远大于实际行数。 */
const EVENT_SCAN_LIMIT = 100000

/** 数字转有限数；不是数字就是一回事。 */
function finite(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 取一条事件的毫秒时间戳。**数字与 ISO 字符串都认**。
 *
 * @returns {number|null} 解析不出返回 null（不会拿 0 冒充 1970 年）。
 */
export function eventTimeMs(row) {
  if (!row || typeof row !== 'object') return null
  const at = row.at
  if (typeof at === 'number') return Number.isFinite(at) ? at : null
  if (typeof at === 'string' && at.trim().length > 0) {
    const ms = Date.parse(at)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/**
 * 把 `since` 参数解析成起始时间。
 *
 * 认：`'today'`（默认，**本地日**零点）、`'session'`（由调用方按会话解析）、
 * `'YYYY-MM-DD'`（本地日零点）、ISO 8601、纯数字毫秒时间戳。
 *
 * @returns {{ok: true, kind: string, sinceMs: number|null, spec: string}|{ok: false, reason: string}}
 */
export function resolveSinceWindow(since, now = Date.now()) {
  const raw = typeof since === 'string' ? since.trim() : ''
  const lower = raw.toLowerCase()
  if (raw === '' || lower === 'today') {
    const d = new Date(now)
    return {
      ok: true,
      kind: 'today',
      spec: 'today',
      sinceMs: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
    }
  }
  if (lower === 'session') return { ok: true, kind: 'session', spec: 'session', sinceMs: null }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number)
    const ms = new Date(year, month - 1, day).getTime()
    if (Number.isFinite(ms)) return { ok: true, kind: 'date', spec: raw, sinceMs: ms }
  }
  if (/^\d{11,16}$/.test(raw)) {
    // 纯毫秒时间戳（archive 事件那种口径）也能直接贴进来。
    const ms = Number(raw)
    if (Number.isFinite(ms)) return { ok: true, kind: 'epoch', spec: raw, sinceMs: ms }
  }
  const parsed = Date.parse(raw)
  if (Number.isFinite(parsed)) return { ok: true, kind: 'iso', spec: raw, sinceMs: parsed }
  return { ok: false, reason: `since 不是合法时间：${raw || '(空)'}（可用 today / session / YYYY-MM-DD / ISO 8601）` }
}

/**
 * 从内存账本条目汇总花费。
 *
 * **拿不到就返回 null**：没有条目、条目全是未知价目、或所选会话没有记录时，
 * 都不能折算成 `$0` —— 那会在界面上变成"今天没花钱"的错误结论。
 *
 * 口径提醒：`UsageLedger` 的累计值只覆盖**本进程启动后**观察到的会话，
 * 且是按会话累计（无法按日切分），所以结果标 `estimated`/`basis` 由界面说明。
 */
export function costFromLedger(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : 0
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : ''
  let usd = 0
  let requests = 0
  let tokens = 0
  let sessions = 0
  let unpricedSessions = 0
  let estimated = false
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (sessionId && entry.sessionId !== sessionId) continue
    const at = eventTimeMs({ at: entry.at })
    if (at !== null && at < sinceMs) continue
    const value = finite(entry.usd)
    if (entry.costKnown === false || value === null) {
      unpricedSessions++
      continue
    }
    sessions++
    usd += value
    requests += finite(entry.requests) ?? 0
    tokens += finite(entry.cumulativeTokens) ?? 0
    if (entry.costEstimated === true) estimated = true
  }
  if (sessions === 0) return null
  return {
    known: true,
    usd: Math.round(usd * 10000) / 10000,
    estimated,
    sessions,
    requests,
    tokens,
    unpricedSessions,
    basis: 'in-memory-ledger',
    note: '内存账本按会话累计，只覆盖本进程启动后观察到的会话；不是官方账单。',
  }
}

/**
 * 汇总一批事件。**纯函数**：只读入参，不碰文件系统。
 *
 * @param {Array<object>} events events.log 的行（可来自 `readEvents()`，也可来自测试）
 * @param {{sinceMs?: number, sessionId?: string, now?: number,
 *          evidenceRows?: Array<object>|null, ledgerEntries?: Array<object>|null}} options
 * @returns {{known: false, reason: string}|{known: true, archives: object, notices: object,
 *           evidence: object, cost: object|null, from: string, to: string,
 *           scanned: number, matched: number, undated: number}}
 */
export function summarizeEvents(events, options = {}) {
  if (!Array.isArray(events)) return { known: false, reason: '读不到事件日志（数据目录里还没有 events.log）' }
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : 0
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : ''

  const inRange = []
  let undated = 0
  for (const row of events) {
    if (!row || typeof row !== 'object') continue
    if (sessionId && row.sessionId !== sessionId) continue
    const at = eventTimeMs(row)
    if (at === null) {
      undated++
      continue
    }
    if (at < sinceMs) continue
    inRange.push(row)
  }

  if (events.length === 0) return { known: false, reason: '还没有可统计的事件（events.log 是空的）' }
  if (inRange.length === 0) {
    return {
      known: false,
      reason: sessionId
        ? '这个会话在事件日志里没有落在所选范围内的记录（超过 512KB 会轮转，旧会话可能已被滚掉）'
        : '所选时间范围内没有可统计的事件',
    }
  }

  let archiveCount = 0
  let savedChars = 0
  let savedTokensEst = 0
  const byKind = {}
  for (const row of inRange) {
    if (row.kind === 'archive') {
      archiveCount++
      const declaredChars = finite(row.savedChars)
      const chars = declaredChars !== null
        ? declaredChars
        : Math.max(0, (finite(row.totalChars) ?? 0) - (finite(row.keptChars) ?? 0))
      savedChars += chars
      const declaredTokens = finite(row.savedTokensEst)
      savedTokensEst += declaredTokens !== null ? declaredTokens : Math.round(chars / ARCHIVE_CHARS_PER_TOKEN)
      continue
    }
    if (!NOTICE_KINDS.includes(row.kind)) continue
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
  }
  const noticeTotal = Object.values(byKind).reduce((sum, n) => sum + n, 0)

  // 读数台账：调用方不传就明确 unknown（不能把"没读"写成 0 条）。
  let evidence
  if (Array.isArray(options.evidenceRows)) {
    let count = 0
    for (const row of options.evidenceRows) {
      if (!row || typeof row !== 'object') continue
      const at = eventTimeMs(row)
      if (at === null) continue
      if (at >= sinceMs) count++
    }
    evidence = { known: true, count }
  } else {
    evidence = { known: false, count: null }
  }

  let cost = null
  if (options.cost !== undefined) cost = options.cost
  else if (Array.isArray(options.ledgerEntries)) cost = costFromLedger(options.ledgerEntries, { sinceMs, sessionId })

  // 提醒有效性（P2-16）：**条数之外**再给一列「提醒后同键再 bump 次数」。
  // 只数提醒条数是虚荣指标（142 条提醒 ≈ 2.9 万字符常驻、零行为改变）。
  const recurrence = noticeRecurrence(inRange, { sinceMs })

  // 按工具分账（P2-5）：只有在调用方真的递了步记录时才算 —— 不自己造数据源。
  // 递的是 `StepTable.entries()` 的快照；没递就是 null（未统计 ≠ 花 0 元）。
  const byTool = Array.isArray(options.stepEntries)
    ? costByTool(options.stepEntries, {
      atMs: now,
      model: options.model ?? null,
      prices: options.prices,
      sessionTotals: options.sessionTotals,
    })
    : null

  return {
    known: true,
    from: new Date(sinceMs).toISOString(),
    to: new Date(now).toISOString(),
    scanned: events.length,
    matched: inRange.length,
    undated,
    archives: { count: archiveCount, savedChars, savedTokensEst },
    notices: { byKind, total: noticeTotal },
    recurrence,
    evidence,
    cost,
    /** P2-5：按工具分账。null = 调用方没递步记录（未统计），不是「各工具都没花钱」。 */
    costByTool: byTool,
  }
}

/** 千分位。只用于展示，避免不同浏览器 locale 影响输出。 */
function fmtInt(value) {
  const n = Math.round(Number(value) || 0)
  return n.toLocaleString('en-US')
}

function fmtUsd(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(Math.abs(n) >= 1 ? 2 : 4) : '—'
}

/**
 * 把汇总结果渲染成 markdown（给模型侧工具、HTTP 与终端看）。
 * 纯函数，不依赖 locale。**估算与实测逐字区分**。
 */
export function renderReportMarkdown(data) {
  if (!data || data.known !== true) {
    return `# warden 收益自报表\n\n没有可统计的数据：${data?.reason ?? '未知原因'}\n`
  }
  const lines = []
  lines.push('# warden 收益自报表')
  lines.push('')
  lines.push(`统计范围：${data.from} → ${data.to}（本地时区）`)
  lines.push(`事件：范围内 ${fmtInt(data.matched)} 条 / 日志共扫描 ${fmtInt(data.scanned)} 条`
    + (data.undated > 0 ? `；另有 ${fmtInt(data.undated)} 条没有可解析的时间，未计入` : ''))
  lines.push('')

  lines.push('## 归档收益')
  if (data.archives.count === 0) {
    lines.push('- 这个范围内没有发生归档。')
  } else {
    lines.push(`- 归档 ${fmtInt(data.archives.count)} 次，省下 ${fmtInt(data.archives.savedChars)} 字符`)
    lines.push(`- 约 ${fmtInt(data.archives.savedTokensEst)} token —— **估算**：`
      + `按"归档后这段原文不再在后续每一步重发"折算（${ARCHIVE_CHARS_PER_TOKEN} 字符/token），`
      + '不是实测 usage，也不是账单。')
  }
  lines.push('')

  lines.push('## 提醒分布')
  const kinds = Object.entries(data.notices.byKind).sort((a, b) => b[1] - a[1])
  if (kinds.length === 0) {
    lines.push('- 这个范围内没有发过提醒。')
  } else {
    // ⚠ 这张表是**原有格式**（`- <kind>：N 条`），前端在解析，不许改。
    for (const [kind, count] of kinds) lines.push(`- ${kind}：${fmtInt(count)} 条`)
    lines.push(`- 合计 ${fmtInt(data.notices.total)} 条`)
  }
  lines.push('')

  // ── 提醒有效性（P2-16）────────────────────────────────────────────────
  // 条数只说明「护栏更吵」，不说明「更有效」。这一节回答的是
  // 「提醒之后同一个问题又出现了几次」—— 那才是行为有没有变的证据。
  lines.push('## 提醒有效性（提醒后同键再 bump 次数）')
  const rec = data.recurrence
  if (!rec || rec.evaluableKeys === 0) {
    // 关键：这里**必须**说「没有可评估的提醒」，不能写成「复发 0 次」。
    // 默认 nudgeOnceOnly=true → 同一键只发一条 → 日志里没有第二条可比。
    if (data.notices.total === 0) {
      lines.push('- 这个范围内没有发过提醒，因此**无可评估的提醒**。')
    } else {
      lines.push(`- **本会话没有可评估的提醒**：${fmtInt(data.notices.total)} 条提醒分散在互不相同的键上，`
        + '每条都只出现过一次 —— 没有「提醒之后」可比，所以**不能**得出「复发 0 次」的结论。')
      if (rec && rec.unresolvedKeys > 0) {
        lines.push(`- 只出现过一次的键：${fmtInt(rec.unresolvedKeys)} 个（这些**未评估**，不是「没复发」）。`)
      }
      lines.push('- 要真正评估有效性，需要临时把 `nudgeOnceOnly` 设成 false 跑一轮，让同键出第二条提醒。')
    }
  } else {
    lines.push(`- 可评估的键 **${fmtInt(rec.evaluableKeys)}** 个（每个至少出现过 ${RECURRENCE_MIN_NOTICES} 条提醒）。`)
    if (rec.unresolvedKeys > 0) {
      lines.push(`- 另有 ${fmtInt(rec.unresolvedKeys)} 个键只出现过一次，**未评估**（不是「没复发」）。`)
    }
    lines.push('')
    lines.push('| 提醒类型 | 同键 | 提醒条数 | 提醒后再 bump | 口径 |')
    lines.push('|---|---|---|---|---|')
    for (const item of rec.keys) {
      const label = item.key.length > 0 ? item.key : '（无目标）'
      lines.push(`| ${item.kind} | ${label} | ${fmtInt(item.notices)} | ${fmtInt(item.afterBumps)} | `
        + `${item.countKnown ? '计数差值（精确）' : '按条数推算（无计数）'} |`)
    }
    lines.push('')
    lines.push(`- 提醒后再 bump 合计 **${fmtInt(rec.afterBumpsTotal)}** 次。`)
    lines.push('- **读数说明**：>0 表示提醒之后同一问题又出现了，说明这条提醒**没改变行为**；'
      + '0 才表示提醒之后没有再犯。这个数字来自事件日志里的累计计数，不是估算。')
  }
  lines.push('')

  lines.push('## 读数台账')
  lines.push(data.evidence.known === true
    ? `- 这个范围内新增 ${fmtInt(data.evidence.count)} 条读数（指纹台账只记"当时产物是什么"，不记好坏）。`
    : '- 未统计（拿不到读数台账）。')
  lines.push('')

  lines.push('## 花费')
  if (!data.cost) {
    lines.push('- 未统计：内存账本里没有可用金额。warden **不会**把"拿不到"写成 $0。')
  } else {
    lines.push(`- 约 $${fmtUsd(data.cost.usd)} —— 来自内存账本（${fmtInt(data.cost.sessions)} 个会话 / `
      + `${fmtInt(data.cost.requests)} 次请求${data.cost.estimated ? '；按官方价目估算' : ''}）`)
    lines.push(`- 口径：${data.cost.note}`)
    if (data.cost.unpricedSessions > 0) {
      lines.push(`- 另有 ${fmtInt(data.cost.unpricedSessions)} 个会话没有可用价目，未计入。`)
    }
  }
  lines.push('')
  lines.push('> 备注：归档省下的字符来自 warden 自己的归档事件（实际压掉了多少原文），'
    + '而"省下的 token"是按字符数折算的**估算**；两者都不是官方账单。')
  return `${lines.join('\n')}\n`
}

/**
 * 读数据 + 汇总 + 渲染。给 HTTP 与模型侧工具共用。
 *
 * @param {{home: string, since?: string, sessionId?: string, now?: number,
 *          config?: object, ledger?: any, evidence?: any,
 *          events?: Array<object>, evidenceRows?: Array<object>|null,
 *          ledgerEntries?: Array<object>|null}} options
 * @returns {object} `{known:true, generatedAt, since, data, markdown}` 或 `{known:false, reason}`
 */
export function buildReport(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const config = options.config ?? {}
  if (config.reportEnabled === false) {
    // 关闭不是错误：调用方（HTTP/工具/客户端）按"关掉了"处理，不要抛、不要报警。
    return {
      known: false,
      disabled: true,
      reason: '收益报表已在设置里关闭（reportEnabled=false）。到设置页的「诊断」页重新打开后再看。',
    }
  }
  const window = resolveSinceWindow(options.since, now)
  if (window.ok !== true) return { known: false, reason: window.reason }

  const events = Array.isArray(options.events)
    ? options.events
    : readEvents(options.home, EVENT_SCAN_LIMIT)
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : ''

  let sinceMs = window.sinceMs
  if (window.kind === 'session') {
    if (!sessionId) {
      return { known: false, reason: 'since=session 需要会话标识（HTTP 请带 sessionId，模型侧工具会自动带当前会话）' }
    }
    const times = []
    for (const row of events) {
      if (!row || row.sessionId !== sessionId) continue
      const at = eventTimeMs(row)
      if (at !== null) times.push(at)
    }
    if (times.length === 0) {
      return { known: false, reason: '事件日志里还没有这个会话的记录（日志超过 512KB 会轮转，旧会话可能已被滚掉）' }
    }
    sinceMs = Math.min(...times)
  }

  let ledgerEntries = options.ledgerEntries
  if (ledgerEntries === undefined) {
    try { ledgerEntries = options.ledger?.list?.() ?? null } catch { ledgerEntries = null }
  }
  let evidenceRows = options.evidenceRows
  if (evidenceRows === undefined) {
    try { evidenceRows = options.evidence?.list?.(5000) ?? null } catch { evidenceRows = null }
  }

  const data = summarizeEvents(events, {
    sinceMs,
    now,
    sessionId: window.kind === 'session' ? sessionId : '',
    evidenceRows,
    ledgerEntries,
  })
  const since = { spec: window.spec, kind: window.kind, sinceMs, from: new Date(sinceMs).toISOString() }
  if (data.known !== true) return { known: false, reason: data.reason, since, generatedAt: new Date(now).toISOString() }
  return {
    known: true,
    generatedAt: new Date(now).toISOString(),
    since,
    data,
    markdown: renderReportMarkdown(data),
  }
}