/**
 * laurel-context/engine —— Laurel 原生轻量上下文压缩引擎（机械层 + 摘要协议接入）。
 *
 * 只做 04 规格第 6 节 A/B/C 的**机械路径与协议**，不调用任何模型/API/embedding。
 *
 * 处理顺序（对应 B1–B10）：
 *   1 增量摄取（按 eventId 去重，不重投影全部历史）
 *   2 保存原文（hash 去重，先落 blob 再发布 ref）
 *   3 可逆致密化（还原后逐字节比对，失败就保留原输入）
 *   4 可回读视图（日志摘取保留中间错误/堆栈，省略处留 ref）
 *   5 压力与净收益重估
 *   6–7 摘要候选校验 + 原子提交（源 revision 变化则不提交）
 *   8 稳定渲染（摘要保持锚点，统计/时钟不进稳定前缀）
 *   9 按需取回（分页 / 搜索）
 *  10 计数与冷热（stats/惰性读盘）
 *
 * 纪律：
 *  - 本模块不 import 任何 DSH/Cordis 代码；存储/格式/检索全部来自 laurel-core 公共库。
 *  - 写入只经 vault.commit（先 blob 后 journal），失败不假装成功。
 *  - ref 由内容哈希派生，不含时间戳/随机数：同 hash 同 ref，跨进程/重启稳定。
 */
import { putBlob, getBlob } from '../../laurel-core/lib/blob.mjs'
import { sha256, contentHash, assertId } from '../../laurel-core/lib/format.mjs'
import { tokenize, search as textSearch } from '../../laurel-core/lib/textindex.mjs'
import {
  makeSummaryCandidate,
  validateSummary,
  normalizeRange,
  normalizeProtectedItems,
} from './summary-protocol.mjs'
import { guardSummary } from './guard.mjs'

export const TIERS = Object.freeze(['zero', 'balanced', 'full'])
export const REF_PREFIX = 'ctx://blob/'
/**
 * 致密化标记键。用控制字符，正常数据几乎不可能出现；即使出现也能被逐字节还原：
 * 普通对象的键若以 ESC 开头或恰好等于 TAG_KEY，会先加一个 ESC 前缀（可逆），
 * 所以「带 TAG_KEY 的对象」在编码结果里只可能是表，不存在歧义。
 */
const ESC = '\u0000'
const TAG_KEY = '\u0001lct'

/** 各档默认窗口与阈值（可由 createEngine 覆盖）。 */
export const TIER_POLICY = Object.freeze({
  zero: { limitTokens: 48_000, trigger: 0.72, minGain: 1_200, recentWindow: 12, modelCost: 0 },
  balanced: { limitTokens: 64_000, trigger: 0.78, minGain: 1_500, recentWindow: 10, modelCost: 1 },
  full: { limitTokens: 96_000, trigger: 0.82, minGain: 2_000, recentWindow: 8, modelCost: 2 },
})

/** 超过这个字符数的工具结果在摄取时自动外置（B2/B4）。 */
export const BIG_RESULT_CHARS = 4_096
/** 摘要正文上限，与协议保持一致。 */
const MAX_SUMMARY_CHARS = 20_000

// ---------------------------------------------------------------- 工具函数

/** 零依赖 token 估算：ASCII 4 字符≈1 token，CJK 1 字符≈1 token，其他 0.6。 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let ascii = 0, cjk = 0, other = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (c <= 0x7f) ascii++
    else if ((c >= 0x3040 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) cjk++
    else other++
  }
  return Math.ceil(ascii / 4 + cjk + other * 0.6)
}

/** ref 由内容哈希派生：字节稳定，同 hash 同 ref。 */
export function refOf(hash) {
  return REF_PREFIX + hash
}

const HASH_IN_REF = /^ctx:\/\/blob\/([0-9a-f]{64})$/

function stableEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  return contentHash(a) === contentHash(b)
}

function isTagged(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, TAG_KEY)
}

function needsEscape(k) {
  return k === TAG_KEY || k.startsWith(ESC)
}

/** 致密化：数组内同键对象压成列式表 + 常量列提升。 */
function denseNode(value) {
  if (Array.isArray(value)) {
    const tableable = value.length >= 3 && value.every(
      (x) => x && typeof x === 'object' && !Array.isArray(x) && !isTagged(x),
    )
    if (tableable) {
      const keys = Object.keys(value[0])
      const sameShape = keys.length > 0 && value.every((x) => {
        const k = Object.keys(x)
        return k.length === keys.length && keys.every((kk, i) => k[i] === kk)
      })
      if (sameShape) {
        const constCols = {}
        const varKeys = []
        for (const k of keys) {
          const first = value[0][k]
          if (value.every((x) => stableEqual(x[k], first))) constCols[k] = denseNode(first)
          else varKeys.push(k)
        }
        const out = { [TAG_KEY]: 1, keys, rows: value.map((x) => varKeys.map((k) => denseNode(x[k]))) }
        if (varKeys.length < keys.length) out.const = constCols
        return out
      }
    }
    return value.map(denseNode)
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) out[needsEscape(k) ? ESC + k : k] = denseNode(value[k])
    return out
  }
  return value
}

function restoreNode(node) {
  if (Array.isArray(node)) return node.map(restoreNode)
  if (node && typeof node === 'object') {
    if (node[TAG_KEY] === 1) {
      const keys = node.keys
      const constCols = node.const ?? {}
      const varKeys = keys.filter((k) => !Object.hasOwn(constCols, k))
      return node.rows.map((row) => {
        const obj = {}
        for (const k of keys) {
          obj[k] = Object.hasOwn(constCols, k) ? restoreNode(constCols[k]) : restoreNode(row[varKeys.indexOf(k)])
        }
        return obj
      })
    }
    const out = {}
    for (const k of Object.keys(node)) {
      out[k.startsWith(ESC) ? k.slice(1) : k] = restoreNode(node[k])
    }
    return out
  }
  return node
}

/** 探测原文缩进，用于把还原结果重新序列化成逐字节相同的文本。 */
function detectIndent(text) {
  const m = /\n([ \t]+)"/.exec(text)
  if (!m) return 0
  return m[1].includes('\t') ? '\t' : m[1].length
}

function serializeLike(value, indent) {
  return indent ? JSON.stringify(value, null, indent) : JSON.stringify(value)
}

const ERROR_RE = /(?:\berror\b|\bfail(?:ed|ure|s)?\b|exception|traceback|panic|fatal|assert(?:ion)?|denied|EACCES|ENOENT|ECONNREFUSED|exit code|错误|失败|异常|报错|断言|✗|✖|×)/i
const SUMMARY_RE = /(?:summary|totals?|passed|failed|ok\b|合计|总计|汇总|完成|通过|结果)/i

// ---------------------------------------------------------------- 引擎

/**
 * 规整注入的真实 token 投影来源（L10）。
 *
 * 接受四种写法：
 *  - `null` / `undefined`      → 没有真实投影 → 压力口径一律 `basis:'unknown'`
 *  - `Function`                → 调用一次，取它返回的对象（宿主能把实时 usage 包成函数）
 *  - `{ contextWindow:number }`→ 只知道真实窗口（profile 声明的 contextWindow）
 *  - `{ usedTokens:number|Function, measure:(text)=>number }`
 *
 * 拿不到就返回全 null 的空壳：调用方据此标 `unknown`，**绝不**拿字符数或启发式估算
 * 冒充实测（`compaction-provider.mjs` 的 `content.length` 就是这么做的）。
 *
 * @param {object|Function|null|undefined} src
 * @returns {{contextWindow:number|null, usedTokens:Function|null, measure:Function|null}}
 */
export function readPressureSource(src) {
  const empty = { contextWindow: null, usedTokens: null, measure: null }
  if (src == null) return empty
  let raw = src
  if (typeof raw === 'function') {
    try { raw = raw() } catch { return empty }
  }
  if (!raw || typeof raw !== 'object') return empty
  const contextWindow = Number.isFinite(raw.contextWindow) && raw.contextWindow > 0
    ? Math.round(raw.contextWindow)
    : null
  let usedTokens = null
  if (typeof raw.usedTokens === 'function') usedTokens = raw.usedTokens
  else if (Number.isFinite(raw.usedTokens) && raw.usedTokens >= 0) usedTokens = () => raw.usedTokens
  const measure = typeof raw.measure === 'function' ? raw.measure : null
  return { contextWindow, usedTokens, measure }
}

/**
 * 创建引擎。vault 必须是 openVault() 的返回值（引擎不自己建仓、不自己选路径）。
 *
 * @param {object} input
 * @param {object} input.vault
 * @param {string} input.sessionId
 * @param {'zero'|'balanced'|'full'} [input.tier]
 * @param {number} [input.limitTokens] 压力上限（token）。
 * @param {number} [input.triggerRatio] 触发阈值 0<r≤1；给了就覆盖 `TIER_POLICY[tier].trigger`。
 * @param {object|Function|null} [input.pressureSource] 真实 token 投影；见 readPressureSource。
 * @param {object|null} [input.guard]
 * @param {Function} [input.now]
 */
export function createEngine({
  vault,
  sessionId,
  tier = 'balanced',
  limitTokens,
  triggerRatio,
  pressureSource = null,
  guard = null,
  now = Date.now,
} = {}) {
  if (!vault || typeof vault !== 'object' || !vault.paths?.blobs) throw new TypeError('createEngine 需要 openVault() 的返回值')
  if (!TIERS.includes(tier)) throw new TypeError(`tier 必须是 ${TIERS.join('|')}，实际 ${JSON.stringify(tier)}`)
  assertId('sessionId', sessionId)

  // L09：调用方传了 triggerRatio 就必须生效。之前这个入参根本不在签名里，
  // index.js:100 传进来的 0.75 被静默丢掉，实际永远走档位默认值（配置骗人）。
  if (triggerRatio != null) {
    if (typeof triggerRatio !== 'number' || !Number.isFinite(triggerRatio) || triggerRatio <= 0 || triggerRatio > 1) {
      throw new TypeError(`triggerRatio 必须是 (0,1] 内的有限数，实际 ${JSON.stringify(triggerRatio)}`)
    }
  }

  const policy = {
    ...TIER_POLICY[tier],
    ...(limitTokens ? { limitTokens } : {}),
    ...(triggerRatio != null ? { trigger: triggerRatio } : {}),
  }

  // L10：口径全部落在这里，stats()/pressure() 只报"实际用了什么"。
  // 注意 pressureSource 可能是**函数**：apply 期宿主还没有 session（D130），
  // 真实窗口只能等它出现。所以这里取一次做初始值，pressure() 每次再问一次。
  const pressureSrc = readPressureSource(pressureSource)
  const limitTokensArg = limitTokens ?? null
  const limitSource = pressureSrc.contextWindow != null
    ? 'context-window'
    : (limitTokens ? 'caller' : 'tier-default')
  // 真实 contextWindow 压过硬编码的 limitTokens：profile 声明 1,000,000 而调用方
  // 写死 200,000 时，压力应该按 1,000,000 算（这正是实测缺陷的那一条）。
  if (pressureSrc.contextWindow != null) policy.limitTokens = pressureSrc.contextWindow
  // 守门策略来自配置（cordis 的 guard）；没配就只走 protocol 的基础校验。
  const guardPolicy = guard && typeof guard === 'object'
    ? { enabled: guard.enabled === true, maxWeightedLoss: guard.maxWeightedLoss ?? 0.35, allowCriticalLoss: guard.allowCriticalLoss === true }
    : null

  const state = {
    guardPolicy,
    lastGuard: null,
    sessionId,
    tier,
    // L10 口径：basis 只允许 'real'（来自注入的真实投影）/ 'estimated'（本引擎的
    // 零依赖估算，明确标注不算 real）/ 'unknown'（拿不到投影且没有可用估算）。
    basis: 'unknown',
    usedTokensSource: 'none',
    limitSource,
    revision: 0,            // source revision：每接受一个事件 +1
    accepted: 0,
    skipped: 0,
    watermark: null,        // 最后接受的 eventId（增量游标）
    events: [],             // 已摄取事件（不重投影历史：只追加）
    seen: new Set(),
    refs: new Map(),        // ref -> { ref, hash, bytes, tool, callId, preview, at }
    // MC12：预览是怎么造的、致密化省了多少，必须能被外部看见 ——
    // 否则「densify/extractLog 已经进数据流」这句话无法验证，只能靠读代码相信。
    previewModes: Object.create(null),   // 'inline' | 'densified' | 'log-extract' | 'head' -> 次数
    densifiedChars: 0,
    byCall: new Map(),      // callId -> ref
    summaries: [],          // 已发布摘要块
    summaryIds: new Set(),
    compactions: 0,
    lastCompactionAt: null,
    lastUsedAtCompaction: null,
    protectedItems: [],
    ingestBatches: 0,
    rebuildMs: 0,
  }

  const engine = { sessionId, tier, policy, state }

  // ------------------------------------------------------------ 打开时一次重建（B1 允许）

  /**
   * 单元/操作归属哪个会话。写入口子（ingest/externalize/commitSummary）都把
   * `meta.sessionId` 写上，所以读的时候只认它；操作级 `op.sessionId` 作为兼容位。
   * @returns {string|null} null = 未署名（历史遗留单元）
   */
  function sessionOf(unit, op) {
    const s = unit?.meta?.sessionId ?? op?.sessionId ?? null
    return typeof s === 'string' && s.length ? s : null
  }

  /**
   * 重放。**按本引擎的 sessionId 过滤**：同一个核心仓里多个会话的 journal 是混写的，
   * 不过滤就会把别的会话的事件、摘要、外置引用全灌进本会话（MC02）。
   */
  function replay() {
    const t0 = now()
    const units = vault.journal?.units ?? []
    let foreignUnits = 0
    let legacyUnits = 0
    for (const unit of units) {
      for (const op of unit.ops ?? []) {
        const owner = sessionOf(unit, op)
        if (owner == null) { legacyUnits++; continue }
        if (owner !== sessionId) { foreignUnits++; continue }
        if (op.op === 'ctx.ingest') {
          const body = getBlob(vault.paths.blobs, op.hash)
          if (!body.ok) throw new Error(`摄取正文丢失或损坏：${op.hash} (${body.reason})`)
          let batch
          try { batch = JSON.parse(body.data.toString('utf8')) } catch (e) { throw new Error(`摄取正文解析失败：${e.message}`) }
          for (const ev of batch.events ?? []) {
            const id = namespaceEventId(ev.eventId)
            if (state.seen.has(id)) continue
            state.seen.add(id)
            state.events.push({ ...ev, eventId: id, sessionId })
            state.accepted++
            state.watermark = ev.eventId
            state.revision = Math.max(state.revision, op.revision ?? 0)
          }
          state.ingestBatches++
        } else if (op.op === 'ctx.externalize') {
          state.refs.set(op.ref, { ...op, at: null })
          if (op.callId) state.byCall.set(op.callId, op.ref)
        } else if (op.op === 'ctx.summary') {
          if (state.summaryIds.has(op.id)) continue
          state.summaryIds.add(op.id)
          state.summaries.push(op.block ?? op)
        } else if (op.op === 'ctx.compaction') {
          state.compactions++
          state.lastCompactionAt = op.at ?? null
        }
      }
    }
    state.foreignUnits = foreignUnits
    state.legacyUnits = legacyUnits
    state.rebuildMs = now() - t0
  }

  /**
   * 事件 id 的会话命名空间。宿主给的 eventId 只在单个会话内唯一
   * （不同会话都会从 `ev-1` 数起），直接拿来当去重键会让两个会话互相吃掉对方的事件。
   * @param {string} rawId
   */
  function namespaceEventId(rawId) {
    return `${sessionId}:${rawId}`
  }
  replay()

  // ------------------------------------------------------------ B1 增量摄取

  /**
   * 只处理新事件。同 eventId 第二次出现直接跳过（返回 skipped），
   * 不会把已摄取历史重新投影一遍。
   * @returns {{accepted:number, skipped:number, watermark:string|null, revision:number}}
   */
  function ingest(events) {
    const list = Array.isArray(events) ? events : (events == null ? [] : [events])
    const fresh = []
    let skipped = 0
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') throw new TypeError('事件必须是对象')
      assertId('eventId', raw.eventId)
      // 去重键带会话命名空间：`ev-1` 这种宿主 id 只在会话内唯一，
      // 裸 id 做键会让第二个会话的 `ev-1` 被当成本会话的重复事件丢掉。
      if (state.seen.has(namespaceEventId(raw.eventId))) { skipped++; continue }
      const text = raw.text ?? raw.content ?? ''
      fresh.push({
        eventId: raw.eventId,
        role: raw.role ?? (raw.kind === 'tool' ? 'tool' : 'user'),
        kind: raw.kind ?? (raw.role === 'tool' ? 'tool' : 'message'),
        text: typeof text === 'string' ? text : JSON.stringify(text),
        at: raw.at ?? null,
        tool: raw.tool ?? null,
        callId: raw.callId ?? null,
      })
    }
    if (!fresh.length) {
      state.skipped += skipped
      return { accepted: 0, skipped, watermark: state.watermark, revision: state.revision }
    }
    const nextRevision = state.revision + fresh.length
    // 先持久化正文（hash 去重），后提交引用；提交失败就不改内存状态
    const payload = JSON.stringify({ v: 1, sessionId, events: fresh })
    const put = putBlob(vault.paths.blobs, payload)
    const res = vault.commit(vault, {
      ops: [{
        op: 'ctx.ingest',
        hash: put.hash,
        bytes: put.bytes,
        count: fresh.length,
        eventIds: fresh.map((e) => e.eventId),
        revision: nextRevision,
      }],
      meta: { kind: 'context.ingest', sessionId },
    })
    if (!res.ok) throw new Error(`摄取提交失败（写锁被占）：${res.reason}`)

    for (const ev of fresh) {
      state.seen.add(namespaceEventId(ev.eventId))
      state.events.push({ ...ev, eventId: namespaceEventId(ev.eventId), sessionId })
    }
    state.accepted += fresh.length
    state.skipped += skipped
    state.revision = nextRevision
    // watermark 用宿主原始 id（对外游标要和宿主事件对得上），内部去重键才带命名空间
    state.watermark = fresh[fresh.length - 1].eventId
    state.ingestBatches++

    // 摄取后立刻做机械层：大工具结果外置（B2/B4），不等到渲染
    for (const ev of fresh) {
      // 工具结果的 kind 在不同来源里写法不同：'tool' / 'result' / role==='tool'。
      // 只认 'tool' 会让真实链路上的大结果永远不被外置（方案要求的"原文外置"形同虚设）。
      const isToolResult = ev.kind === 'tool' || ev.kind === 'result' || ev.role === 'tool'
      if (isToolResult && String(ev.text ?? '').length >= BIG_RESULT_CHARS && !state.byCall.has(ev.callId)) {
        externalizeToolResult({ callId: ev.callId ?? ev.eventId, tool: ev.tool ?? 'tool', output: ev.text })
      }
    }
    return { accepted: fresh.length, skipped, watermark: state.watermark, revision: state.revision }
  }

  // ------------------------------------------------------------ B2/B4 原文外置

  /**
   * 大结果落 blob，返回稳定引用。ref 只由内容哈希派生：
   * 同 hash 同 ref，重复调用去重，不含时间戳/随机数。
   */
  /**
   * 生成外置结果的**预览**（MC12：把 `extractLog` / `densify` 接进真实数据流）。
   *
   * 三种模式，按信息量从高到低挑第一个能用的：
   *   `densified`    JSON 且已验证可逐字节还原 → 用紧凑文本，省掉全部缩进与空白；
   *   `log-extract`  多行文本 → `extractLog` 保头/尾/错误与堆栈行及邻行；
   *   `head`         其它 → 原文头部（这在此前是**唯一**的行为，也是主要问题：
   *                  一条 50 行的报错日志，关键的 ERROR 行往往在第 30 行，
   *                  无脑 slice(0,400) 让模型连"有错"都看不出来）。
   *
   * 纪律：
   *   1. `densify` 只有 `ok:true` 才用 —— 它的 ok 里已经含「还原后与原文字节相等」。
   *      不在这里自己再判一次，也不把 `no-gain`/`not-byte-identical` 当成功。
   *   2. 预览长度一律 ≤ PREVIEW_CHARS。宁可少给一点，也不要一条顶掉整个窗口。
   *   3. 不改 blob：`readOriginal(ref)` 仍取回逐字节原文，预览只是展示层。
   */
  function buildPreview(output) {
    const PREVIEW_CHARS = 400
    if (output.length <= PREVIEW_CHARS) {
      return { mode: 'inline', text: output, densifiedChars: 0 }
    }
    // 前缀/标记与正文共用同一个额度：400 是**总长**上限，不是正文上限。
    // 上一版把 400 字符正文拼在「〔已致密化…〕」后面，总长直接超出去。
    const withPrefix = (prefix, body) => `${prefix}${body.slice(0, Math.max(0, PREVIEW_CHARS - prefix.length - 1))}${
      body.length > PREVIEW_CHARS - prefix.length - 1 ? '…' : ''
    }`
    const trimmed = output.trimStart()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const dense = densify(output)
      if (dense.ok) {
        const prefix = `〔已致密化，可逐字节还原，省 ${dense.savedChars} 字符〕\n`
        return { mode: 'densified', text: withPrefix(prefix, dense.compactText), densifiedChars: dense.savedChars }
      }
    }
    const rawLines = output.split(/\r?\n/)
    if (rawLines.length > 8) {
      // 先按行裁宽：真实日志一行动辄 300~500 字符（长路径、长 JSON、长堆栈），
      // 整行交给 extractLog 时，挑中的头几行就把额度吃光。
      const LINE_CHARS = 100
      const clipped = rawLines
        .map((l) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l))
        .join('\n')
      // 按额度反推行数：400 字符装得下 3~4 行。**从宽到窄试，装下就用**。
      // extractLog 的优先级是「错误/失败行 4 > 其邻行 3 > 头尾 2」，
      // 所以额度紧时被留下的一定是错误行 —— 这正是要它挑的原因。
      for (const maxLines of [10, 8, 6, 5, 4, 3]) {
        if (maxLines > rawLines.length) continue
        const cut = extractLog(clipped, { maxLines, context: 1 })
        if (!cut.ok) break
        // 省略标记里的 ref 缩成后 8 位：一个标记就占 86 字符，两个标记吃掉四成额度。
        // 完整 ref 在同一段消息头里已经给出，预览里再抄一遍纯属浪费。
        const text = cut.text.replace(/ref=ctx:\/\/blob\/([0-9a-f]{64})/g, (_m, h) => `ref=…${h.slice(-8)}`)
        if (text.length <= PREVIEW_CHARS) {
          return { mode: 'log-extract', text, densifiedChars: 0 }
        }
      }
    }
    return { mode: 'head', text: `${output.slice(0, PREVIEW_CHARS - 1)}…`, densifiedChars: 0 }
  }

  function externalizeToolResult({ callId, tool, output } = {}) {
    if (typeof output !== 'string') throw new TypeError('externalizeToolResult 需要字符串 output')
    const put = putBlob(vault.paths.blobs, output)
    const ref = refOf(put.hash)
    const existing = state.refs.get(ref)
    // MC12：`extractLog` / `densify` 接到真实数据流（此前只在单测里被调用）。
    // 预览只影响「模型当下看到的那一眼」，blob 里存的仍是逐字节原文。
    const built = buildPreview(output)
    const preview = built.text
    const previewMode = built.mode
    const densifiedChars = built.densifiedChars
    state.previewModes[previewMode] = (state.previewModes[previewMode] ?? 0) + 1
    state.densifiedChars += densifiedChars
    const rec = {
      ref,
      hash: put.hash,
      bytes: put.bytes,
      tool: tool ?? 'tool',
      callId: callId ?? null,
      preview,
      previewMode,
      previewChars: preview.length,
      densifiedChars,
      deduped: put.deduped || Boolean(existing),
    }
    if (!existing) {
      const res = vault.commit(vault, {
        ops: [{
          op: 'ctx.externalize',
          ref,
          hash: put.hash,
          bytes: put.bytes,
          tool: rec.tool,
          callId: rec.callId,
        }],
        meta: { kind: 'context.externalize', sessionId },
      })
      if (!res.ok) throw new Error(`外置引用提交失败（写锁被占）：${res.reason}`)
      state.refs.set(ref, { ...rec, at: now() })
    }
    if (callId) state.byCall.set(callId, ref)
    return { ref, hash: put.hash, bytes: put.bytes, preview, previewMode, densifiedChars, deduped: rec.deduped }
  }

  // ------------------------------------------------------------ B3 可逆致密化

  /**
   * 致密化并**验证还原**：还原结果与原文逐字节相等才返回 ok。
   * @param {string|object} payload JSON 文本或值
   * @returns {{ok:true, compact:object, compactText:string, savedChars:number, restore:Function} | {ok:false, reason:string, detail?:string}}
   */
  function densify(payload) {
    const asText = typeof payload === 'string'
    const text = asText ? payload : JSON.stringify(payload)
    let parsed
    try { parsed = JSON.parse(text) } catch (e) { return { ok: false, reason: 'invalid-json', detail: e.message } }
    const dense = denseNode(parsed)
    const compactText = JSON.stringify(dense)
    if (compactText.length >= text.length) {
      return { ok: false, reason: 'no-gain', originalChars: text.length, compactChars: compactText.length }
    }
    const indent = asText ? detectIndent(text) : 0
    let restored
    try { restored = restoreNode(dense) } catch (e) { return { ok: false, reason: 'restore-failed', detail: e.message } }
    const back = asText ? serializeLike(restored, indent) : restored
    if (asText) {
      if (back !== text) {
        // 无法证明逐字节还原：保留原输入，不返回半可信的紧凑格式
        return { ok: false, reason: 'not-byte-identical', detail: '还原结果与原文不一致（可能是数字/转义格式差异）' }
      }
      if (contentHash(restored) !== contentHash(parsed)) {
        return { ok: false, reason: 'value-mismatch' }
      }
    } else if (JSON.stringify(restored) !== text) {
      return { ok: false, reason: 'not-byte-identical' }
    }
    return {
      ok: true,
      compact: dense,
      compactText,
      savedChars: text.length - compactText.length,
      restore: () => back,
    }
  }

  // ------------------------------------------------------------ B4 可回读摘取

  /**
   * 确定性日志摘取：保留错误/失败/堆栈/摘要行及邻近行，中间报错不丢；
   * 省略处留 `[...省略 N 行，ref=...]`，ref 指向原文 blob（可 readOriginal 回读）。
   */
  function extractLog(text, { maxLines = 120, context = 1 } = {}) {
    const src = String(text ?? '')
    const lines = src.split(/\r?\n/)
    const total = lines.length
    const put = putBlob(vault.paths.blobs, src)
    const ref = refOf(put.hash)
    // 下限必须是 1 而不是 12：12 会把「我只想要 3 行」的请求抬成 12 行，
    // 于是预览永远塞不进 400 字符额度、只能退回 head（MC12 实测踩过）。
    // 默认 maxLines=120 的既有行为不变：total>=12 时 max(1,min(120,total)) === min(120,total)。
    const budget = Math.max(1, Math.min(maxLines, total))

    if (total <= budget) {
      return { ok: true, text: src, totalLines: total, keptLines: total, omittedLines: 0, ref, truncated: false }
    }

    const priority = new Map()
    const mark = (i, p) => { if (i >= 0 && i < total) priority.set(i, Math.max(priority.get(i) ?? 0, p)) }
    for (let i = 0; i < Math.min(3, total); i++) mark(i, 2)               // 头部（命令/上下文）
    for (let i = Math.max(0, total - 3); i < total; i++) mark(i, 2)       // 尾部（收尾摘要）
    for (let i = 0; i < total; i++) {
      if (ERROR_RE.test(lines[i])) {
        mark(i, 4)
        for (let d = 1; d <= context; d++) { mark(i - d, 3); mark(i + d, 3) }
      } else if (SUMMARY_RE.test(lines[i])) {
        mark(i, 1)
      }
    }
    // 预算不够时按 (优先级降序, 行号升序) 确定性裁剪
    const chosen = [...priority.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, budget)
      .map(([i]) => i)
      .sort((a, b) => a - b)
    const kept = new Set(chosen)

    const out = []
    let omitted = 0
    let run = 0
    const flush = () => {
      if (run > 0) { out.push(`[...省略 ${run} 行，ref=${ref}]`); omitted += run; run = 0 }
    }
    for (let i = 0; i < total; i++) {
      if (kept.has(i)) { flush(); out.push(lines[i]) } else run++
    }
    flush()
    return {
      ok: true,
      text: out.join('\n'),
      totalLines: total,
      keptLines: kept.size,
      omittedLines: omitted,
      ref,
      truncated: true,
    }
  }

  // ------------------------------------------------------------ 渲染

  function summaryBlockFor(index) {
    return state.summaries.find((s) => index >= s.range.start && index < s.range.end) ?? null
  }

  function renderEvent(ev) {
    const ref = ev.callId ? state.byCall.get(ev.callId) : null
    if (ref && state.refs.has(ref)) {
      const rec = state.refs.get(ref)
      return {
        role: ev.role,
        content: `[工具结果已外置 tool=${rec.tool} bytes=${rec.bytes} ref=${ref}]\n预览: ${rec.preview}`,
      }
    }
    return { role: ev.role, content: ev.text }
  }

  /**
   * 稳定渲染：已发布摘要固定在覆盖区间起点（锚点），其余事件按序展开。
   * 不含时间戳/统计/计数 —— 这些走 pressure()/stats()，不进稳定前缀。
   * @returns {Array<{role:string, content:string}>}
   */
  function render() {
    const messages = []
    let i = 0
    while (i < state.events.length) {
      const block = summaryBlockFor(i)
      if (block && block.range.start === i) {
        const refs = (block.refs ?? []).length ? ` refs=${block.refs.join(',')}` : ''
        messages.push({
          role: 'system',
          content: `[压缩摘要 ${block.level} · 事件 ${block.range.start}..${block.range.end - 1} · ${block.id}${refs}]\n${block.text}`,
          anchor: true,
          summaryId: block.id,
          range: { ...block.range },
        })
        i = block.range.end
        continue
      }
      messages.push(renderEvent(state.events[i]))
      i++
    }
    return messages
  }

  function renderedTokens() {
    let sum = 0
    for (const m of render()) sum += estimateTokens(m.content)
    return sum
  }

  /**
   * 真实用量口径（L10）。
   *
   * 优先级：注入的宿主投影 > 注入的 measure > 本引擎启发式估算。
   * 前两者 `basis:'real'`，第三者 `basis:'unknown'` —— **估算值不许标成实测**，
   * 调用方看到 unknown 就该知道这个数不能拿去对外报账。
   * @returns {{tokens:number, basis:'real'|'unknown', source:'host-projection'|'injected-measure'|'heuristic-estimate'}}
   */
  function measureUsed() {
    // L10 修正：必须与 currentLimit() 一样**每次重解** pressureSource。
    // 之前这里用的是建引擎时缓存的 `pressureSrc`：apply 期宿主还没有 session，
    // 那一刻解析出来的是空壳（usedTokens/measure 全 null），于是真实投影早就读到了
    // （同一次压力计算里 currentLimit() 能报出 contextWindow:1000000），
    // 用量却永远回落到启发式 32728 —— 端点因此出现
    // 「limitTokens 是真的、usedTokens 是估的」这种自相矛盾。
    let live = null
    try { live = readPressureSource(pressureSource) } catch { live = null }
    const src = live ?? pressureSrc
    if (src.usedTokens) {
      let v = null
      try { v = Number(src.usedTokens()) } catch { v = null }
      if (Number.isFinite(v) && v >= 0) return { tokens: Math.round(v), basis: 'real', source: 'host-projection' }
    }
    if (src.measure) {
      let sum = 0
      let ok = true
      try {
        for (const m of render()) {
          const t = Number(src.measure(m.content))
          if (!Number.isFinite(t)) { ok = false; break }
          sum += t
        }
      } catch { ok = false }
      if (ok) return { tokens: Math.round(sum), basis: 'real', source: 'injected-measure' }
    }
    return { tokens: renderedTokens(), basis: 'unknown', source: 'heuristic-estimate' }
  }

  // ------------------------------------------------------------ B5 压力与净收益

  function mechanicalReclaimable() {
    let gain = 0
    for (const ev of state.events) {
      if (ev.kind !== 'tool') continue
      if (ev.callId && state.byCall.has(ev.callId)) continue
      const t = estimateTokens(ev.text)
      if (t > 80) gain += t - 40
    }
    return gain
  }

  function summaryCandidateRange() {
    const covered = new Set()
    for (const s of state.summaries) {
      for (let i = s.range.start; i < s.range.end; i++) covered.add(i)
    }
    const end = Math.max(0, state.events.length - policy.recentWindow)
    const indices = []
    for (let i = 0; i < end; i++) if (!covered.has(i)) indices.push(i)
    if (!indices.length) return null
    const tokens = indices.reduce((a, i) => a + estimateTokens(state.events[i].text), 0)
    return { start: indices[0], end: indices[indices.length - 1] + 1, indices, tokens }
  }

  /**
   * 当前窗口上限与它的来源（L10）。
   *
   * 惰性重解：`pressureSource` 是函数时每次调用都重读。宿主投影里的
   * contextWindow 是唯一权威 —— profile 声明 1,000,000 时，这里必须报 1,000,000，
   * 而不是调用方写死的 200,000（后者正是实测缺陷）。
   */
  function currentLimit() {
    let live = null
    try { live = readPressureSource(pressureSource) } catch { live = null }
    if (Number.isFinite(live?.contextWindow) && live.contextWindow > 0) {
      return { limitTokens: live.contextWindow, limitSource: 'context-window' }
    }
    return { limitTokens: policy.limitTokens, limitSource }
  }

  /** 压力视图。 */
  function pressure() {
    const used = measureUsed()
    const live = currentLimit()
    const limit = live.limitTokens
    const mech = mechanicalReclaimable()
    let reclaimable = mech
    if (tier !== 'zero') {
      const cand = summaryCandidateRange()
      if (cand) reclaimable += Math.ceil(cand.tokens * 0.7)
    }
    return {
      usedTokens: used.tokens,
      // L10：限制值必须报真实口径。来源写在 limitSource 里：'context-window' 是宿主
      // 声明的真实窗口，'caller' 是调用方写死的数，'tier-default' 是本档默认值。
      limitTokens: limit,
      limitSource: live.limitSource,
      ratio: limit > 0 ? Math.min(1, used.tokens / limit) : 0,
      // 'real' = 真实投影；'unknown' = 只有启发式估算（或连估算都没有），对外不可当实测报账
      basis: used.basis,
      usedTokensSource: used.source,
      trigger: policy.trigger,
      reclaimable,
      lastCompactionAt: state.lastCompactionAt,
    }
  }

  /**
   * 是否值得压缩：压力到位 + 净收益为正 + 没在刚整理过的水位上重复整理。
   * @returns {{yes:boolean, reason:string, expectedGain:number, expectedCost:number}}
   */
  function shouldCompact() {
    const p = pressure()
    if (p.ratio < policy.trigger) {
      return {
        yes: false,
        reason: `压力 ${p.ratio.toFixed(3)} 低于 ${tier} 档阈值 ${policy.trigger}`,
        expectedGain: p.reclaimable,
        expectedCost: 0,
      }
    }
    const mech = mechanicalReclaimable()
    let gain = mech
    let cost = 0
    if (tier !== 'zero') {
      const cand = summaryCandidateRange()
      if (cand) {
        gain += Math.ceil(cand.tokens * 0.75)
        // 摘要成本：读区间 + 写有界摘要（粗估，真实值由 S08 用宿主 usage 核对）
        cost = Math.ceil(cand.tokens * 0.3) + (tier === 'full' ? 900 : 500)
      }
    }
    if (gain < policy.minGain) {
      return { yes: false, reason: `可回收 ${gain} tokens 低于最小收益 ${policy.minGain}`, expectedGain: gain, expectedCost: cost }
    }
    const net = gain - cost
    if (net <= 0) {
      return { yes: false, reason: `净收益 ${net} ≤ 0（收益 ${gain} − 成本 ${cost}）`, expectedGain: gain, expectedCost: cost }
    }
    if (state.lastCompactionAt != null) {
      const grown = p.usedTokens - (state.lastUsedAtCompaction ?? 0)
      if (grown < policy.minGain) {
        return {
          yes: false,
          reason: `距上次整理只增长 ${grown} tokens，低于重写老前缀的门槛`,
          expectedGain: gain,
          expectedCost: cost,
        }
      }
    }
    return { yes: true, reason: `压力 ${p.ratio.toFixed(3)} ≥ ${policy.trigger}，净收益 ${net} > 0`, expectedGain: gain, expectedCost: cost }
  }

  // ------------------------------------------------------------ B6/B7 摘要提交

  function commitSummary(candidate, { protectedItems = [], guard: guardPolicy = null } = {}) {
    const merged = [...state.protectedItems, ...normalizeProtectedItems(protectedItems)]
    const check = validateSummary(candidate, { protectedItems: merged })
    if (!check.ok) {
      return { ok: false, reason: 'invalid', problems: check.problems, missing: check.missing }
    }
    let range = check.range
    // 【坐标系】先按**事件身份**把覆盖范围映射到本引擎的 state.events 下标。
    //
    // 以前这里直接用 candidate.range，也就是上游给的「表层位置」，然后拿它去
    // 跟 `state.summaries[].range`（引擎下标）比重叠 —— 两套坐标一撞，
    // 第二次压缩必然报 `range-overlaps-published`（表层每次压完都整体前移，
    // 而 state.events 只增不减）。于是「第一次能存、第二次永远失败」。
    //
    // 现在：调用方给了 coveredIds 就以身份为准定位下标，range 只用来展示。
    // 没给才退回老的位置判据（老调用方/老 journal 仍能工作）。
    const coveredIds = Array.isArray(candidate.coveredIds)
      ? candidate.coveredIds.filter((x) => typeof x === 'string' && x)
      : []
    let coveredEngineIds = null
    if (coveredIds.length) {
      const idx = []
      for (const raw of coveredIds) {
        const ns = namespaceEventId(raw)
        const i = state.events.findIndex((e) => e.eventId === ns || e.eventId === raw)
        if (i >= 0) idx.push(i)
      }
      if (!idx.length) {
        return {
          ok: false,
          reason: 'covered-ids-unmapped',
          note: '候选声明覆盖的事件一个都不在本引擎的 state.events 里（多半是别的会话的表层）',
          coveredIds: coveredIds.slice(0, 5),
          events: state.events.length,
        }
      }
      const uniq = [...new Set(idx)].sort((a, b) => a - b)
      range = { start: uniq[0], end: uniq[uniq.length - 1] + 1 }
      coveredEngineIds = uniq.map((i) => state.events[i].eventId)
    }
    if (candidate.sourceRevision !== state.revision) {
      // 迟到/范围变化的旧结果不提交，原视图继续可用
      return { ok: false, reason: 'source-revision-changed', expected: state.revision, candidate: candidate.sourceRevision }
    }
    if (range.end > state.events.length) {
      return { ok: false, reason: 'range-out-of-bounds', range, events: state.events.length }
    }
    // 守门器：比 protocol 的逐条存在性检查更严 —— 它按类别加权、剔噪声、
    // 并对"限制/错误"零容忍。policy.guard.enabled 为真时才生效。
    // 注意：这里比较的是**被压缩的原范围**与候选摘要文本，不是整个会话。
    if (guardPolicy?.enabled) {
      const origEvents = state.events.slice(range.start, range.end).map((e) => e.text ?? '')
      const g = guardSummary({
        original: origEvents,
        summary: String(candidate.text ?? ''),
        // 【D91】把上面 validateSummary 用的同一份 merged 传进来。
        // 原来只传文本，守门器只能靠 extractProtected 自己抽 —— 抽不到的就整条消失。
        protectedItems: merged,
        policy: {
          maxWeightedLoss: guardPolicy.maxWeightedLoss ?? 0.35,
          allowCriticalLoss: guardPolicy.allowCriticalLoss === true,
        },
      })
      if (!g.ok) {
        return {
          ok: false,
          reason: 'guard-reject',
          verdict: g.verdict,
          advice: g.advice,
          missing: g.missing,
          weightedLoss: g.weightedLoss,
          checked: g.checked,
        }
      }
      state.lastGuard = { verdict: g.verdict, checked: g.checked, at: Date.now() }
    }
    if (state.summaryIds.has(candidate.id)) {
      return { ok: true, id: candidate.id, already: true, range }
    }
    for (const s of state.summaries) {
      // 【坐标系】有身份就按身份判重叠（权威判据），没有才退回位置判重叠。
      // 位置判据在「表层前移、引擎只增」的场景下会误报，这正是它被降级的原因。
      if (coveredEngineIds) {
        const prev = Array.isArray(s.coveredIds) && s.coveredIds.length ? s.coveredIds : null
        if (prev) {
          const hit = coveredEngineIds.some((id) => prev.includes(id))
          if (hit) {
            return { ok: false, reason: 'range-overlaps-published', with: s.id, range, existing: s.range, by: 'covered-ids' }
          }
          continue
        }
      }
      if (range.start < s.range.end && s.range.start < range.end) {
        return { ok: false, reason: 'range-overlaps-published', with: s.id, range, existing: s.range, by: coveredEngineIds ? 'range-vs-legacy-block' : 'range' }
      }
    }
    const block = {
      id: candidate.id,
      level: candidate.level,
      range,
      sourceRevision: candidate.sourceRevision,
      text: candidate.text,
      refs: candidate.refs ?? [],
      protectedItems: merged,
      anchor: range.start,
      protectedChecked: check.checked.protected,
      // 存**引擎侧**的身份（已命名空间化），replay 时原样还原，下次判重叠才有据可依
      ...(coveredEngineIds ? { coveredIds: coveredEngineIds } : {}),
    }
    // 摘要块与 compaction 回执必须在**同一个提交单元**里写。
    // 分两次 commit 会在第二次时自己和自己抢写锁（第一次已持锁），
    // 表现为间歇性 commit-failed/"held" —— 这正是重复调用才复现的那类 bug。
    const res = vault.commit(vault, {
      ops: [
        { op: 'ctx.summary', id: block.id, block },
        { op: 'ctx.compaction', at: state.lastCompactionAt ?? now(), tier, mode: 'summary', level: block.level, gain: check.checked.protected },
      ],
      meta: { kind: 'context.summary', sessionId, level: block.level },
    })
    if (!res.ok) return { ok: false, reason: 'commit-failed', detail: res.reason, holder: res.holder }
    state.summaries.push(block)
    state.summaryIds.add(block.id)
    state.compactions++
    state.lastCompactionAt = now()
    state.lastUsedAtCompaction = measureUsed().tokens
    return { ok: true, id: block.id, range, already: false }
  }

  /** 便捷入口：生成候选 → 校验 → 提交（不生成摘要文本，那是 S08 的模型路线）。 */
  function publishSummary(candidate, opts = {}) {
    // 守门策略默认取自 createEngine 的 guard 配置；
    // 调用方仍可按次覆盖（例如"这次不要守门，只做记录"）。
    const policy = opts.guard !== undefined ? opts.guard : (state.guardPolicy ?? null)
    return commitSummary(candidate, { ...opts, guard: policy })
  }

  function makeCandidate(input) {
    return makeSummaryCandidate(input)
  }

  // ------------------------------------------------------------ B9 按需取回

  /**
   * callId → 外置原文 ref（只读）。
   *
   * 【为什么需要这个口】大工具结果被 `externalizeToolResult` 落成 blob 之后，
   * ref 存在 `state.byCall`（callId → ref）里，而宿主表层的工具结果事件只带
   * `callId`、不带 `ref`。摘要器（`mechanical-summarize`）收集引用时只看
   * `slice[i].ref` 与正文里的 `ctx://blob/…` 两种来源，于是**已经落盘的原文
   * 一个都登记不进摘要** —— 实测 refs 318 / blobs 318，而摘要里 ref 数 0，
   * 「压缩后能按 ref 取回原文」这条闭环是断的。
   *
   * 这里只是把内部已有的映射读出来，不新增状态、不改任何行为。
   */
  function refForCall(callId) {
    if (typeof callId !== 'string' || !callId) return null
    return state.byCall.get(callId) ?? null
  }

  function resolveRef(ref) {
    if (typeof ref !== 'string') return null
    const direct = HASH_IN_REF.exec(ref)
    if (direct) return direct[1]
    const rec = state.refs.get(ref)
    return rec ? rec.hash : null
  }

  /** 原文分页回取。 */
  function readOriginal(ref, { offset = 0, lines = 40 } = {}) {
    const hash = resolveRef(ref)
    if (!hash) return { ok: false, reason: 'unknown-ref', ref }
    const blob = getBlob(vault.paths.blobs, hash)
    if (!blob.ok) return { ok: false, reason: blob.reason, ref, hash }
    const text = blob.data.toString('utf8')
    const all = text.split(/\r?\n/)
    const start = Math.max(0, Math.min(offset, all.length))
    const count = Math.max(1, lines)
    const slice = all.slice(start, start + count)
    return {
      ok: true,
      ref,
      hash,
      totalLines: all.length,
      offset: start,
      lines: slice.length,
      text: slice.join('\n'),
      hasMore: start + slice.length < all.length,
      nextOffset: start + slice.length,
    }
  }

  let searchCache = null

  /** 原文搜索（零推理 BM25，不恢复全文）。 */
  function searchOriginal(query, { limit = 5 } = {}) {
    if (!searchCache) {
      searchCache = []
      for (const [ref, rec] of state.refs) {
        const blob = getBlob(vault.paths.blobs, rec.hash)
        if (!blob.ok) continue
        searchCache.push({ id: ref, ref, body: blob.data.toString('utf8'), tool: rec.tool, callId: rec.callId })
      }
    }
    const res = textSearch(searchCache, query, { limit })
    const hits = res.hits.map((h) => {
      const body = h.record.body
      const qs = new Set(tokenize(query))
      const lines = body.split(/\r?\n/)
      let at = -1
      for (let i = 0; i < lines.length; i++) {
        const lt = tokenize(lines[i])
        if (lt.some((t) => qs.has(t))) { at = i; break }
      }
      const from = Math.max(0, at - 1)
      const snippet = at < 0 ? body.slice(0, 300) : lines.slice(from, from + 3).join('\n')
      return {
        ref: h.record.ref,
        score: h.score,
        coverage: h.coverage,
        tool: h.record.tool,
        callId: h.record.callId,
        line: at,
        snippet,
      }
    })
    return { query: res.query, hits, poolSize: res.poolSize, reason: res.reason }
  }

  // ------------------------------------------------------------ 计数

  function stats() {
    const p = pressure()
    return {
      sessionId,
      tier,
      revision: state.revision,
      acceptedEvents: state.accepted,
      skippedEvents: state.skipped,
      ingestBatches: state.ingestBatches,
      events: state.events.length,
      refs: state.refs.size,
      blobs: state.refs.size,
      // MC12：预览构造方式与致密化收益 —— 「能力进数据流了吗」靠这两个数说话，
      // 否则只能靠读代码相信。
      previewModes: { ...state.previewModes },
      densifiedChars: state.densifiedChars,
      summaries: state.summaries.length,
      compactions: state.compactions,
      lastCompactionAt: state.lastCompactionAt,
      // 守门结果必须可观测，否则"守门器接没接上"无法从外部判断
      lastGuard: state.lastGuard,
      guardPolicy: state.guardPolicy,
      watermark: state.watermark,
      rebuildMs: state.rebuildMs,
      protectedItems: state.protectedItems.length,
      // L10：口径必须自证。只报一个 usedTokens 数字而说不出它从哪来，
      // 就等于允许调用方把估算当实测对外报账。
      usedTokens: p.usedTokens,
      limitTokens: p.limitTokens,
      basis: p.basis,
      usedTokensSource: p.usedTokensSource,
      limitSource: p.limitSource,
      // L09：实际生效的触发阈值（调用方传了就覆盖档位默认值，必须能读回来）
      triggerRatio: policy.trigger,
      // 跨会话隔离可观测：replay 跳过了多少别的会话/未署名的单元
      foreignUnits: state.foreignUnits ?? 0,
      legacyUnits: state.legacyUnits ?? 0,
    }
  }

  function setProtectedItems(items) {
    state.protectedItems = normalizeProtectedItems(items)
    return { ok: true, count: state.protectedItems.length }
  }

  /**
   * 已发布摘要覆盖过的事件 id 集合（只读，供选区跳头部）。
   *
   * 【为什么需要这个口】`selectCandidateRange` 以前恒从表层第一个非 system
   * 节点开始选。压缩成功后表层被换成一条 summary 消息，但那批原事件仍在
   * `state.events` 里、且已记进某条摘要的 `coveredIds`。下一轮又从头选，
   * 身份与已发布摘要重叠 → `commitSummary` 正确地报 `range-overlaps-published`
   * → 压缩失败 → 再选同一个 range → 再失败，无限重试。
   *
   * 真机实测（2026-10-22）：用量 92%、pressureChecks 240、errors 27，
   * 每次都是 `range=1..1007 problems=[range-overlaps-published]`，一次也压不进去。
   *
   * 返回 Set 而不是数组：调用方每轮要 `has()` 几百次，数组是 O(n)。
   * 每次现算而不是缓存：摘要会随压缩增长，缓存会让下一轮又从头选。
   */
  function coveredEventIds() {
    const out = new Set()
    for (const s of state.summaries) {
      if (!Array.isArray(s?.coveredIds)) continue
      for (const id of s.coveredIds) {
        if (typeof id === 'string' && id) out.add(id)
      }
    }
    return out
  }

  /**
   * 引擎里**从未被任何已发布摘要覆盖**的事件 id 集合（只读）。
   *
   * 与 `coveredEventIds()` 互补，但语义不同、必须分开：
   *   · `coveredEventIds()` = 已压过 → 选区**要避开**它
   *   · `uncoveredEventIds()` = 没压过 → 选区**应该落在**它上面
   *
   * 【为什么不能只靠 coveredEventIds 取反（2026-10-22 实测）】
   * 调用方只拿得到「哪些被覆盖」，但**不知道哪些事件存在于引擎里**，
   * 于是没法对「表层里一条事件」判断它到底属于哪边 —— 取反需要全集。
   * 真机数据：13500 条 events 里 7519 条被覆盖，未覆盖的 6135 条
   * **与已覆盖的深度交错**（最长连续未覆盖段只有 589 条，位于尾部）。
   * 所以这里直接把「未覆盖全集」算好交出去，让选区一次就能判。
   */
  function uncoveredEventIds() {
    const covered = coveredEventIds()
    const out = new Set()
    for (const e of state.events) {
      const id = e?.eventId
      if (typeof id !== 'string' || !id) continue
      if (covered.has(id)) continue
      out.add(id)
    }
    return out
  }

  /**
   * 给定一串**表层事件身份**，返回其中哪些已被已发布摘要覆盖。
   *
   * 【为什么需要这个口，而不是让调用方拿 Set 自己比（2026-10-22 实测）】——
   * 调用方（`selectCandidateRange`）拿到的是表层条目，其 `eventId` 是
   * `hostSurface()` 产出的 `ev-<seq>`；而本引擎 `state.summaries[].coveredIds`
   * 里存的是**命名空间化后**的 `host:ev-<seq>`。两边形状不同，调用方自己
   * 做前缀归一很容易只处理一个方向（实测踩了两版）。
   *
   * 更关键的是**顺序问题**：引擎 `state.events` 是**摄取到达顺序**，
   * 与宿主表层 `surface.nodes` 的 **seq 升序** 不是同一个顺序
   * （宿主重放历史时 `ev-9` 这类小 seq 可能很晚才到）。
   * 所以「按引擎下标区间判重叠」和「按表层位置选区」天生对不上 ——
   * 调用方只该问「我这一条被覆盖了吗」，不该自己推区间。
   *
   * @param {Array<string>} ids 表层条目的 eventId（裸的或带前缀都行）
   * @returns {boolean[]} 与入参等长的布尔数组：true = 已被覆盖
   */
  function coveredFlags(ids) {
    const list = Array.isArray(ids) ? ids : []
    const covered = coveredEventIds()
    const bare = (id) => (id.includes(':') ? id.slice(id.indexOf(':') + 1) : id)
    return list.map((raw) => {
      if (typeof raw !== 'string' || !raw) return false
      if (covered.has(raw)) return true
      const b = bare(raw)
      if (covered.has(b)) return true
      return covered.has(namespaceEventId(b))
    })
  }

  Object.assign(engine, {
    ingest,
    externalizeToolResult,
    densify,
    extractLog,
    pressure,
    shouldCompact,
    render,
    readOriginal,
    searchOriginal,
    stats,
    setProtectedItems,
    publishSummary,
    makeCandidate,
    refForCall,
    coveredEventIds,
    uncoveredEventIds,
    coveredFlags,
    _commitSummary: commitSummary,
  })
  // 必须用 defineProperty 定义 getter：写在 Object.assign 的对象字面量里的
  // `get revision(){}` 会被先求值成**当时的数值**再赋值，之后永远读到 0，
  // 于是"源 revision 变化就不提交"永远判成"已变化"，摘要一块都发不出去。
  Object.defineProperty(engine, 'revision', { get: () => state.revision, enumerable: true })
  // 只读事件视图：模型摘要路线需要按 range 取原文来拼提示词。
  // 返回浅拷贝数组，调用方不能借它改引擎内部状态。
  Object.defineProperty(engine, '_events', { get: () => () => state.events.slice(), enumerable: false })
  return engine
}

export { makeSummaryCandidate, validateSummary, normalizeRange, normalizeProtectedItems, sha256 }
