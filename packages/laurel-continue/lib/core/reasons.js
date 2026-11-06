/**
 * laurel-continue · 回合结束原因分派（纯函数，无 IO）
 *
 * turn/end 的 data.reason.kind 是 merge-extensible 的联合类型，权威枚举共 7 个
 * （出处：dsh/packages/core/session/lib/types/types.d.ts 的 TurnEndReasonMap）：
 *
 *   completed  aborted  blocked  error  max-tokens  interrupted  forked
 *
 * 本模块只做一件事：把「这一轮为什么结束」翻译成「要不要续跑」。
 * **白名单外的一切 kind 一律不动** —— 猜测性续跑比不续跑危险得多：
 * 它会在策略拒绝、fork 收尾、崩溃补写这些场景里凭空开一轮新回合。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

import { isContextOverflowError, isQuotaExceededError } from './errors.js'

/** 权威枚举的 7 个 kind（顺序固定，日志与配置都按这个顺序呈现）。 */
export const TURN_END_KINDS = Object.freeze([
  'completed',
  'aborted',
  'blocked',
  'error',
  'max-tokens',
  'interrupted',
  'forked',
])

/** 默认续跑的 kind（error 还要再过一遍错误分类）。 */
export const RESUMABLE_KINDS = Object.freeze(['error', 'max-tokens'])

/* ------------------------------------------------------------------ *
 * 错误分类
 * ------------------------------------------------------------------ */

/**
 * 把各种形状的错误压成可检索的文本。
 *
 * 支持的形状（测试会各测一遍）：
 *   - Error 实例（含 cause 链）
 *   - string
 *   - { status, code, message } 这类结构化失败（宿主 LlmFailure 就是这种）
 *
 * @param {unknown} error
 * @returns {{text: string, code: string, name: string, status: number|undefined}}
 */
export function readFailure(error) {
  if (typeof error === 'string') {
    return { text: error, code: '', name: '', status: undefined }
  }
  if (!error || typeof error !== 'object') {
    return {
      text: error === undefined || error === null ? '' : String(error),
      code: '', name: '', status: undefined,
    }
  }
  const code = typeof error.code === 'string' ? error.code : ''
  const name = typeof error.name === 'string' ? error.name : ''
  const status = typeof error.status === 'number' ? error.status : undefined
  const parts = []
  if (typeof error.message === 'string') parts.push(error.message)
  if (code) parts.push(code)
  if (typeof error.type === 'string') parts.push(error.type)
  // cause 链最多走 4 层：够用，又不会在自引用上打转。
  let cursor = error.cause
  for (let depth = 0; depth < 4 && cursor; depth += 1) {
    if (typeof cursor === 'object') {
      if (typeof cursor.message === 'string') parts.push(cursor.message)
      if (typeof cursor.code === 'string') parts.push(cursor.code)
      cursor = cursor.cause
    } else {
      parts.push(String(cursor))
      break
    }
  }
  return { text: parts.join(' | '), code, name, status }
}

/** 永久性（重试无意义）的 HTTP 状态码。 */
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 405, 422])

/** 永久性的稳定错误码。 */
const PERMANENT_CODES = new Set([
  'QUOTA',
  'ACCOUNT_QUOTA',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED',
])

/**
 * 临时性的稳定错误码。
 *
 * 这份白名单是照抄宿主 `dsh-llm` 自己的 `DEFAULT_RETRYABLE_CODES`
 * （packages/llm/llm/src/retry-policy.ts 的第 18-24 行）：
 *
 *     ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
 *
 * 为什么必须照抄：`SERVER` 是 5xx 上游错误的**通用码**，而且实测常在
 * **不带 status、message 里也没有数字**的情况下出现
 * （真实形状：`{ code: 'SERVER', status: 503, message: 'Service temporarily unavailable' }`
 *   —— status 有时在，有时只有 code + message）。
 *
 * 早期实现要求「必须带 status 或 message 里有数字」才算临时性，结果是
 * **最常见的 503 走进「永久性失败」分支：不续跑，还通知用户「无法恢复」**。
 * 这个模块存在的全部理由就是扛 503，判错等于模块没用。
 *
 * 另外补几个同义的适配器码（上游没有 '' 前缀的统一拼法，这里按语义收录，
 * 多认几个只会让"该重试的继续重试"，不会造成静默放弃）。
 */
const TRANSIENT_CODES = new Set([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  // 同义/邻近拼法：不同适配器与代理层对同一件事的叫法不完全统一。
  'UPSTREAM',
  'SERVICE_UNAVAILABLE',
  'OVERLOADED',
  'NETWORK',
  'CONNECTION',
  'ECONNRESET',
  'ETIMEDOUT',
  'BUSY',
])

/** 从 `HTTP_503` 这类码里取出状态码。宿主适配器会这么拼（transport.ts:35）。 */
function statusFromCode(code) {
  const match = /^HTTP_(\d{3})$/.exec(code)
  return match ? Number(match[1]) : undefined
}

/** 500-599 / 429 / 408 → 临时性。 */
function isTransientStatus(status) {
  return (status >= 500 && status <= 599) || status === 429 || status === 408
}

/**
 * 临时性失败判定（契约 §3）：
 *   5xx / 429 / 超时 / 网络 → true
 *   401 / 403 / 余额 / 模型不存在 / 上下文超限 → false
 *
 * @param {unknown} error Error / string / { status, code, message }
 * @param {Record<string, unknown>} [config] 保留参数（未来可能引入白名单覆盖）
 * @returns {boolean}
 */
export function isTransientFailure(error, config) {
  void config
  const { text, code, status: rawStatus } = readFailure(error)
  const upper = code.toUpperCase()
  const status = rawStatus !== undefined ? rawStatus : statusFromCode(upper)

  // ══ 第 1 步：永久性优先 ════════════════════════════════════════════
  //
  // 顺序很关键：**永久性判定必须排在通用临时码之前**。
  // 否则 `{ code: 'SERVER', message: 'invalid api key' }` 会因为
  // SERVER 在临时白名单里而被误续跑 —— 一个凭证错误被重试到 maxConsecutive，
  // 用户看到的是「一直在重试、一直失败」，而不是「你的 key 不对」。

  // 上下文超限永远不是临时性：重发同样大小只是再烧一轮。
  // （让位给压缩由 classifyTurnEnd 负责，这里只回答「该不该重试」。）
  if (isContextOverflow(error)) return false
  if (PERMANENT_CODES.has(upper)) return false
  if (isQuotaExceededError(text)) return false

  // 鉴权 / 凭证 / 模型不存在：永久性（先看这些，别让 SERVER 抢先）。
  if (/\b(?:unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|invalid[ _-]?credential|missing[ _-]?(?:api[ _-]?key|credential)|not authorized)\b/i.test(text)) return false
  if (/\bmodel\b[^|]{0,60}(?:not[ _-]?found|does not exist|not available|unknown|unsupported)/i.test(text)) return false
  if (/\(40[13]\)|\bHTTP 40[13]\b/.test(text)) return false

  // 明确的 4xx（除 408/429）几乎都是"重试也不会变"的。
  if (status !== undefined && PERMANENT_STATUS.has(status)) return false

  // ══ 第 2 步：临时性 ════════════════════════════════════════════════

  // 2a. 状态码：5xx / 429 / 408。
  if (status !== undefined && isTransientStatus(status)) return true

  // 2b. 宿主的可重试码表（retry-policy.ts 的 DEFAULT_RETRYABLE_CODES 及同义码）。
  //     **只要码在白名单里就算临时性** —— 不要求 status 存在，也不要求
  //     message 里出现数字。`{ code: 'SERVER' }` 就是最常见的 503。
  if (TRANSIENT_CODES.has(upper)) return true

  // 2c. 文本兜底：超时、网络、限流、服务端。
  const transientText = /\b(?:timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|fetch failed)\b/i
  if (transientText.test(text)) return true
  if (/\b(?:rate[ _-]?limit(?:ed)?|too many requests|overloaded|server error|internal error|service (?:temporarily )?unavailable|bad gateway|gateway timeout|try again)\b/i.test(text)) return true
  if (/\(429\)|\(5\d{2}\)|\bHTTP 5\d{2}\b/.test(text)) return true

  // ══ 第 3 步：认不出来 → 按临时性处理 ════════════════════════════════
  //
  // 这里与「失败即放弃」的直觉相反，但是有意的：
  //   猜错成「临时性」= 多试一轮（有 maxConsecutive / 冷却兜底，代价有限且可见）；
  //   猜错成「永久性」= **静默放弃一个本来能恢复的会话**，而且会通知用户
  //                   「无法恢复」—— 一个错误的结论比多试一次贵得多。
  // 本模块的立身之本就是"扛住 503"，所以未知错误一律往"可能能恢复"那边站。
  return true
}

/**
 * 专门识别上下文超限（CONTEXT_WINDOW_EXCEEDED）。
 *
 * 这条判定被两处共用：让位规则 §6.1（只通知不续跑）与
 * isTransientFailure（超限不算临时性）。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isContextOverflow(error) {
  if (!error) return false
  const { text, code } = readFailure(error)
  if (code.toUpperCase() === 'CONTEXT_WINDOW_EXCEEDED') return true
  return isContextOverflowError(text)
}

/* ------------------------------------------------------------------ *
 * 分派
 * ------------------------------------------------------------------ */

/**
 * 判断某个 kind 是否在默认续跑白名单内。
 * @param {string} kind
 * @returns {boolean}
 */
export function isResumableKind(kind) {
  return RESUMABLE_KINDS.includes(kind)
}

/**
 * 把 turn/end 的原因翻译成动作。**永不抛。**
 *
 * 返回形状（契约 §3）：
 *   { action: 'resume' | 'skip' | 'notify', kind, causeKind?, note? }
 *
 * 附加字段的约定（契约只列了 action/kind/causeKind/note，这里是超集）：
 *   - action:'skip' 且 note:'reset' → 引擎要**清零连败计数**
 *     （aborted + cause.kind==='user'：用户主动取消，说明这条会话是活的）；
 *   - action:'notify' → 告知用户但不续跑（永久性失败 / 让位 / 额度耗尽）；
 *   - causeKind → aborted 的取消来源（user / parent / hook / disposed / legacy）；
 *   - code / message / status → 给通知文案用的原始信息；
 *   - yieldTo → 'compaction' 时表示让位给了上下文压缩（§6.1）。
 *
 * @param {{kind?: string, error?: unknown, reason?: {kind?: string}}} reason
 * @param {Record<string, unknown>} [config]
 * @returns {{action: string, kind: string, causeKind?: string, note?: string,
 *            code?: string, message?: string, status?: number, yieldTo?: string}}
 */
export function classifyTurnEnd(reason, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const kind = typeof reason?.kind === 'string' ? reason.kind : ''

  // ── 白名单外一律不动 ────────────────────────────────────────────────
  if (!TURN_END_KINDS.includes(kind)) {
    return { action: 'skip', kind: kind || 'unknown', note: 'unknown-kind' }
  }

  switch (kind) {
    case 'completed': {
      if (cfg.loopAfterCompleted === true) return { action: 'resume', kind, note: 'loop' }
      return { action: 'skip', kind, note: 'completed' }
    }

    case 'aborted': {
      const causeKind = typeof reason?.reason?.kind === 'string' ? reason.reason.kind : 'legacy'
      // 用户主动取消 = 这条会话刚刚证明它是活的 → 清零连败计数。
      // 其余取消来源（parent / hook / disposed / legacy）不清零：
      // 它们都不代表用户希望它继续。
      if (causeKind === 'user') return { action: 'skip', kind, causeKind, note: 'reset' }
      return { action: 'skip', kind, causeKind, note: 'cancelled' }
    }

    case 'blocked':
      return { action: 'skip', kind, note: 'policy-refused' }

    case 'interrupted':
    case 'forked':
      // 崩溃补写 / fork 种子收尾：都不是活循环发出的，绝不能触发续跑。
      return { action: 'skip', kind, note: 'lifecycle-marker' }

    case 'max-tokens': {
      const allowed = Array.isArray(cfg.resumedKinds) ? cfg.resumedKinds : RESUMABLE_KINDS
      if (!allowed.includes('max-tokens')) return { action: 'skip', kind, note: 'not-in-resumedKinds' }
      return { action: 'resume', kind }
    }

    case 'error': {
      const failure = reason?.error
      const { code, message, status, text } = {
        ...readFailure(failure),
        message: typeof failure?.message === 'string' ? failure.message : '',
      }

      // §6.1 让位上下文压缩：只通知，不续跑。
      // 文案不能说「无法恢复」—— laurel-context 正在同一轮里重试。
      if (cfg.yieldToCompaction !== false && isContextOverflow(failure)) {
        return {
          action: 'notify',
          kind,
          code: code || 'CONTEXT_WINDOW_EXCEEDED',
          message: message || text,
          yieldTo: 'compaction',
          note: 'yield-compaction',
        }
      }

      const allowed = Array.isArray(cfg.resumedKinds) ? cfg.resumedKinds : RESUMABLE_KINDS
      if (!allowed.includes('error')) return { action: 'skip', kind, note: 'not-in-resumedKinds' }

      // classify:false → 一律续跑（用户明确表示「别替我判断」）。
      if (cfg.classify === false) return { action: 'resume', kind, code, message: message || text }

      if (isTransientFailure(failure, cfg)) {
        return { action: 'resume', kind, code, message: message || text }
      }

      return {
        action: 'notify', kind, code, message: message || text, status, note: 'permanent-failure',
      }
    }

    default:
      return { action: 'skip', kind, note: 'unknown-kind' }
  }
}
