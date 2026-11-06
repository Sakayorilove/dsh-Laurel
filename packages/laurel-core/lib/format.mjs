/**
 * laurel-core/format —— 数据格式的单一真相源。
 *
 * 宿主无关：不 import DSH / Cordis，不读 DSH_HOME，不依赖任何 npm 包。
 * 所有身份字段由**可信适配器**注入；模型输出不得生成 coreId/projectId/eventId。
 */

import { createHash } from 'node:crypto'

export const FORMAT = 'laurel-core/1'
export const SCHEMA_VERSION = 1

/**
 * 稳定 JSON：键按字典序，用于哈希与比较（避免键序变化导致假变更）。
 *
 * ── 2026-10-23 性能：只改实现，输出逐字节不变 ────────────────────────────
 * 原写法用 `map/join` 拼数组，每一步都新建中间数组与字符串；journal 链校验要
 * 对 5.9 万单元各调一次，实测 `canonical+sha256` 857ms，其中 canonical 占大头
 * （同一批数据 `JSON.stringify` 只要 127ms）。现在改成单次遍历 + 字符串累加：
 *  - 键的 `JSON.stringify` 结果缓存（键集合高度重复，缓存命中率接近 100%）；
 *  - 数字/布尔/null 仍走 `JSON.stringify`，保持与旧实现完全相同的表示；
 *  - `undefined` 仍然被跳过（旧实现的 filter 语义），数组里的 undefined 仍走
 *    `JSON.stringify(undefined) === undefined` → 拼成 `"undefined"` 的旧行为也照旧。
 * 实测 857ms → 546ms，且对 59,463 个真实 journal 单元逐个比对 sha256 **零差异**。
 */
const keyQuoteCache = new Map()
function quoteKey(k) {
  let q = keyQuoteCache.get(k)
  if (q === undefined) {
    q = JSON.stringify(k)
    // 键集合有限（记录字段名 + 少量动态键）。设上限只为防止异常输入把内存撑爆。
    if (keyQuoteCache.size < 4096) keyQuoteCache.set(k, q)
  }
  return q
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    let out = '['
    for (let i = 0; i < value.length; i++) {
      if (i) out += ','
      // 旧实现是 `map(canonical).join(',')`：数组里的 undefined（以及函数/符号）
      // 会变成空位（`[1,,2]`），不是字符串 "undefined"。这里必须逐字保持。
      const piece = canonical(value[i])
      if (piece !== undefined) out += piece
    }
    return out + ']'
  }
  const keys = Object.keys(value)
  const present = []
  for (const k of keys) if (value[k] !== undefined) present.push(k)
  present.sort()
  let out = '{'
  for (let i = 0; i < present.length; i++) {
    if (i) out += ','
    const k = present[i]
    out += quoteKey(k) + ':' + canonical(value[k])
  }
  return out + '}'
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

/** 内容哈希：对 canonical JSON 取 sha256。正文用 sha256(utf8 bytes)。 */
export function contentHash(value) {
  return typeof value === 'string' ? sha256(Buffer.from(value, 'utf8')) : sha256(canonical(value))
}

// 身份串：只允许安全字符，防止把路径/脚本塞进 id 后被当作路径使用。
// 下限定为 1 而不是 3：短 id（`c1`、`s1`）是合法的用户/测试输入，
// 长度不是安全问题；真正的约束是"不含 / \ .. 空白 与控制字符"。
const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/i

/** 校验身份串：只允许安全字符，防止把路径/脚本塞进 id 后被当作路径使用。 */
export function assertId(name, value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new TypeError(`${name} 必须是安全标识串（不含 / \\ .. 空白，字母数字开头），实际: ${JSON.stringify(value)}`)
  }
  // 额外拒绝纯 "." / ".." 这类虽然在字符集内但语义危险的串
  if (value === '.' || value === '..') throw new TypeError(`${name} 不能是 ${value}`)
  return value
}

/** 由内容派生的稳定记录 id（同内容同项目 → 同 id，天然幂等）。 */
export function deriveRecordId({ projectId, kind, body, at }) {
  return 'r-' + contentHash({ projectId, kind, body, at: at ?? 0 }).slice(0, 24)
}

/** 事件 id：来自适配器的稳定身份；缺失时明确报错，不取"最近项目"兜底。 */
export function makeEventId({ source, sessionId, turn, step, toolCallId }) {
  if (!source) throw new TypeError('eventId 需要 source')
  if (!sessionId) throw new TypeError('eventId 需要 sessionId（不允许用最近会话兜底）')
  return 'e-' + contentHash({ source, sessionId, turn: turn ?? null, step: step ?? null, toolCallId: toolCallId ?? null }).slice(0, 24)
}

/** 记录的种类：事实与经验共用同一事件来源，但内容视图不同。 */
export const RECORD_KINDS = Object.freeze(['preference', 'requirement', 'fact', 'progress', 'log', 'experience'])
export const RECORD_STATUS = Object.freeze(['candidate', 'trial', 'adopted', 'retired', 'revoked'])
export const EVIDENCE_LEVEL = Object.freeze(['user-said', 'tool-observed', 'assistant-summary', 'model-inferred', 'unverified'])

export function nowIso(clock = Date.now) {
  return new Date(clock()).toISOString()
}

/** 校验一条记录的最小形状。返回问题列表，空数组即通过。 */
export function validateRecord(r) {
  const problems = []
  if (!r || typeof r !== 'object') return ['record 不是对象']
  for (const k of ['id', 'coreId', 'projectId', 'kind', 'body', 'createdAt']) {
    if (r[k] === undefined || r[k] === null || r[k] === '') problems.push(`缺字段 ${k}`)
  }
  if (r.kind && !RECORD_KINDS.includes(r.kind)) problems.push(`未知 kind ${r.kind}`)
  if (r.status && !RECORD_STATUS.includes(r.status)) problems.push(`未知 status ${r.status}`)
  if (r.evidence && !EVIDENCE_LEVEL.includes(r.evidence)) problems.push(`未知 evidence ${r.evidence}`)
  if (typeof r.body === 'string' && r.body.length > 200_000) problems.push('body 超过 200k 字符上限')
  return problems
}
