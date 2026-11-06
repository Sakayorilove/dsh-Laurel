/**
 * dsh-warden · 成本按步 / 按子代理深度归因（纯计算）
 *
 * 这里不读事件、不碰文件、不查余额，只做三件可单测的事：
 *   ① 每会话的「按步归因表」：一步一行，记 token 与工具名集，容量有界；
 *   ② 排序：按金额取 top N；
 *   ③ 按 `delegationDepth` 分组：main / sub / unknown。
 *
 * ── 去重口径必须与 `UsageLedger` 的累计口径一致 ──────────────────────────
 * 同一 `(turn, step)` 的多次上报是**替换**不是累加（重试、多次采样都属于
 * 这一类），照抄官方 `tokenUsage` 投影。但 `llm/retry-started` 之后同一
 * `(turn, step)` 会重新从零上报 —— 那是**新的一段**，两段都真的花了钱，
 * 都要计入。所以「一步的贡献」拆成两段：
 *
 *     贡献 = sealed（已封口的历史段） + current（最近一次上报）
 *
 *   - 替换上报：只改 current；
 *   - 新段上报：sealed += current，current = 新值。
 *
 * 于是 `topSteps` 各步 tokens 之和 == 账本累计 tokens：既不会因为重复采样
 * 翻倍，也不会漏掉重试那次。是替换还是新段由调用方（`UsageLedger`，它手里
 * 有 `entry.last`）明确告知；本表**不自己猜**。
 *
 * ── 拿不到就 unknown ──────────────────────────────────────────────────
 * depth 缺失/非法 → 归 `unknown`，**不猜 main**。没有收到过 usage 的步不进
 * topSteps（用 0 冒充没发生过的成本，比不显示更坏）。
 */

/** 每会话最多保留多少步归因（超出丢最老的 turn/step）。 */
export const MAX_STEPS_PER_SESSION = 200

/** 分组名固定，顺序固定 —— 调用方不用猜键存不存在。 */
export const DEPTH_GROUPS = Object.freeze(['main', 'sub', 'unknown'])

const BUCKET_KEYS = Object.freeze([
  'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
])

function zeroBuckets() {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
}

function cloneBuckets(buckets) {
  const out = {}
  for (const key of BUCKET_KEYS) out[key] = Number(buckets?.[key]) || 0
  return out
}

/** 四桶逐项相加（门内函数也有同名实现；这里是归因表的独立口径）。 */
export function addBuckets(a, b) {
  return {
    uncachedInputTokens: (a?.uncachedInputTokens ?? 0) + (b?.uncachedInputTokens ?? 0),
    cacheReadTokens: (a?.cacheReadTokens ?? 0) + (b?.cacheReadTokens ?? 0),
    cacheWriteTokens: (a?.cacheWriteTokens ?? 0) + (b?.cacheWriteTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
  }
}

/** `(turn, step)` → 稳定的表键；缺一个就返回 null（不拿 0 顶）。 */
export function stepKey(turn, step) {
  // `Number(null)` 是 0 —— 必须先把"没给"挡掉，否则缺 turn 会被算成 turn 0。
  if (turn === null || turn === undefined || turn === '' || step === null || step === undefined || step === '') return null
  const t = Number(turn)
  const s = Number(step)
  if (!Number.isFinite(t) || !Number.isFinite(s)) return null
  return `${t}:${s}`
}

/**
 * 归一化 `delegationDepth`。
 *
 * 只接受非负安全整数；`undefined` / `null` / 空串 / 非法值一律返回 null
 * （由调用方映射成 unknown）。
 */
export function normalizeDepth(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

/**
 * 从 `session/event` 回调的第一个参数（session 对象）读 depth。
 *
 * 两处都试：`header.delegationDepth`（官方 SessionHeader）与
 * `session.delegationDepth`（持久化 `session` 事件的扁平形态）。
 * 都没有就是 null —— **不按"主会话默认 0"猜**。
 */
export function depthOfSession(session) {
  if (!session || typeof session !== 'object') return null
  return normalizeDepth(session.header?.delegationDepth ?? session.delegationDepth)
}

/** depth → 分组名。缺失/非法 → unknown。 */
export function depthGroupOf(depth) {
  const n = normalizeDepth(depth)
  if (n === null) return 'unknown'
  return n === 0 ? 'main' : 'sub'
}

/**
 * 每会话的按步归因表。
 *
 * 容量有界：超过 `maxSteps` 时丢 `(turn, step)` 最小的那条（会话内步号单调
 * 递增，所以等价于"丢最老的"）。工具记录也占一格，这样某一步先有 tool/call
 * 后有 usage 时不会丢工具名。
 */
export class StepTable {
  /** @param {{maxSteps?: number}} [options] */
  constructor(options = {}) {
    const max = Number(options.maxSteps)
    this.maxSteps = Number.isSafeInteger(max) && max > 0 ? max : MAX_STEPS_PER_SESSION
    /** @type {Map<string, object>} */
    this.steps = new Map()
  }

  get size() {
    return this.steps.size
  }

  /**
   * 把一个工具名记到 `(turn, step)`。
   *
   * @returns {boolean} 是否真的新增了工具名（同一步重复调用只记一次）
   */
  recordTool(turn, step, name) {
    const tool = typeof name === 'string' ? name.trim() : ''
    if (!tool) return false
    const rec = this.#touch(turn, step)
    if (!rec) return false
    if (rec.tools.includes(tool)) return false
    rec.tools.push(tool)
    return true
  }

  /**
   * 上报一步的 usage。
   *
   * @param {object} buckets 本次上报的四桶（是该步**本次**的值，不是累计值）
   * @param {{replace?: boolean, at?: number, model?: string|null}} [options]
   *        `replace:true` = 同一 (turn, step) 的重复采样（替换 current）；
   *        `replace:false` = 该步的新一段（sealed += current 后再换 current）。
   * @returns {boolean}
   */
  recordUsage(turn, step, buckets, options = {}) {
    if (!buckets || typeof buckets !== 'object') return false
    const rec = this.#touch(turn, step, options.at, options.model)
    if (!rec) return false
    if (options.replace === true) {
      rec.current = cloneBuckets(buckets)
    } else {
      rec.sealed = addBuckets(rec.sealed, rec.current)
      rec.current = cloneBuckets(buckets)
    }
    rec.usageSeen = true
    return true
  }

  /** 该步是否真的收到过 usage（没收到的不进 topSteps）。 */
  hasUsage(turn, step) {
    const key = stepKey(turn, step)
    return key !== null && this.steps.get(key)?.usageSeen === true
  }

  /**
   * 快照（按 (turn, step) 稳定排序，与容量淘汰口径一致）。
   *
   * @returns {Array<{turn:number, step:number, tokensBuckets:object,
   *                  tools:string[], usageSeen:boolean, at:number,
   *                  model:(string|null)}>}
   */
  entries() {
    return [...this.steps.values()]
      .map((rec) => ({
        turn: rec.turn,
        step: rec.step,
        tokensBuckets: addBuckets(rec.sealed, rec.current),
        tools: [...rec.tools],
        usageSeen: rec.usageSeen,
        at: rec.at,
        model: rec.model,
      }))
      .sort((a, b) => (a.turn - b.turn) || (a.step - b.step))
  }

  #touch(turn, step, at, model) {
    const key = stepKey(turn, step)
    if (!key) return null
    const stamp = Number.isFinite(at) ? at : 0
    const modelName = typeof model === 'string' && model.length > 0 ? model : null
    let rec = this.steps.get(key)
    if (rec) {
      if (stamp > 0) rec.at = stamp
      if (modelName !== null) rec.model = modelName
      return rec
    }
    rec = {
      turn: Number(turn),
      step: Number(step),
      sealed: zeroBuckets(),
      current: zeroBuckets(),
      tools: [],
      usageSeen: false,
      at: stamp,
      model: modelName,
    }
    this.steps.set(key, rec)
    this.#evictOldest()
    return rec
  }

  #evictOldest() {
    while (this.steps.size > this.maxSteps) {
      let oldestKey = null
      let oldest = null
      for (const [key, rec] of this.steps) {
        if (oldest === null
          || rec.turn < oldest.turn
          || (rec.turn === oldest.turn && rec.step < oldest.step)) {
          oldest = rec
          oldestKey = key
        }
      }
      if (oldestKey === null) return
      this.steps.delete(oldestKey)
    }
  }
}

/**
 * 按金额降序取 top N。
 *
 * 同一金额时依次按 tokens 降序、turn/step 升序，保证结果稳定可断言。
 * `usd` 不是有限数的行（拿不到价格）不参与排序 —— 不拿 0 冒充。
 *
 * @param {Array<{turn:number, step:number, tokens:number, usd:number, tools?:string[]}>} rows
 * @param {number} [n]
 */
export function topOf(rows, n = 5) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && Number.isFinite(row.usd)) : []
  const requested = Number(n)
  if (!Number.isFinite(requested)) return []
  const limit = Math.floor(requested)
  if (limit <= 0) return []
  return list
    .sort((a, b) => (b.usd - a.usd)
      || ((b.tokens ?? 0) - (a.tokens ?? 0))
      || (a.turn - b.turn)
      || (a.step - b.step))
    .slice(0, limit)
}

function finiteOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 按会话 depth 分组累计。
 *
 * @param {Array<{depth?: number|null, tokens?: number, usd?: number|null,
 *                requests?: number}>} entries 每个会话一行
 * @returns {{main: object, sub: object, unknown: object}}
 *         每组 `{tokens, usd, requests, sessions}`。sessions=0 表示这组没有
 *         观测到的会话，不是"花了 0 元"的结论。
 */
export function groupByDepth(entries) {
  const groups = {}
  for (const name of DEPTH_GROUPS) {
    groups[name] = { tokens: 0, usd: 0, requests: 0, sessions: 0 }
  }
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue
    const name = depthGroupOf(entry.depth ?? entry.delegationDepth ?? null)
    const group = groups[name]
    group.tokens += finiteOrZero(entry.tokens)
    group.usd += finiteOrZero(entry.usd)
    group.requests += finiteOrZero(entry.requests)
    group.sessions += 1
  }
  return groups
}
