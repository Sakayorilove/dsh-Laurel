/**
 * dsh-warden · 用量与上下文压力（R2 的正解）
 *
 * ── 旧版错在哪 ─────────────────────────────────────────────────────────
 * 旧版挂在 `llm/stream` 上，从**回调入参**里找 `usage`：
 *
 *     const usage = payload?.usage ?? payload?.chunk?.usage
 *
 * 实读宿主 `dsh-llm`：
 *
 *     streamWithRegistration(options, prepared) {
 *       return this.ctx.waterfall(this, "llm/stream", options,
 *                                 () => this.adapterStream(options, prepared))
 *     }
 *
 * `options` 是**请求**，usage 只存在于 `next()` 返回的那个
 * `AsyncIterable<StreamChunk>` 里。旧回调看了一眼入参就 `return next()`，
 * 一个 usage 也没采到 —— 评审探针（100500 token 的流）证实 pre-step 之后
 * 仍然没有水位提醒。
 *
 * 就算改成包装那个流也很别扭：要么重复消费、要么吞掉错误、要么破坏取消。
 * 所以本版**不再挂 `llm/stream`**，改成两条都安全的路：
 *
 *   ① `session/event`（`(session, event)`）—— usage 会随着 assistant 事件
 *      **持久化**，读事件不消费任何流，天然不重不漏，还能拿到 turn/step 做去重。
 *   ② 官方 `sessionProjections` 的 `contextPressure` / `tokenUsage` 投影 ——
 *      `dsh-token-meter` 已经把它算好了，用 `cachedSnapshot()` 读，
 *      **不折叠历史**，放在热路径上安全。
 *
 * ── 口径必须分清（R2 的第二个问题）─────────────────────────────────────
 * 旧版把含输出的 `totalTokens` 当"当前上下文水位"，这是错的。实读官方定义：
 *
 *     pressureFrom = (usage) =>
 *       usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
 *
 * **当前压力是 prompt 侧的，不含输出。** 而累计用量是另一回事，四个桶要分开：
 * 未缓存输入 / 缓存读 / 缓存写 / 输出。本模块一律显式区分，
 * 拿不到就返回 `unknown`，**绝不用累计值冒充当前上下文**。
 *
 * `usageOfEvent()` 的判定顺序照抄 `dsh-token-meter` 的 `usageOf()`，
 * 不自创口径、不假定各 provider 的字段含义一致。
 *
 * ── 本版新增：成本归因（v0.3.0 #2 / #6）─────────────────────────────────
 * 只看总量回答不了"钱花在哪一步、哪一步最贵"。所以账本在维护四桶的同时，
 * 再记两张表（纯计算都在 `core/attribution.js`）：
 *
 *   ① 按步归因：`tool/call` 的 `data.name` 落到该 `(turn, step)`，随后
 *      `assistant/message` 的 usage 按**同一替换口径**落到同一步；每会话
 *      最多 200 步（超出丢最老的），`topSteps()` 按金额降序取 top N。
 *   ② 按子代理深度：`session.header.delegationDepth`（或扁平形态的
 *      `session.delegationDepth`）→ `byDepth()` 的 main / sub / unknown。
 *      两处都拿不到 → unknown，**不猜 main**。
 *
 * 归因数字只用来回答"是哪一步/哪一层"，不构成"省了多少钱"的结论。
 */

import {
  MAX_STEPS_PER_SESSION, StepTable, depthOfSession, groupByDepth, topOf,
} from '../core/attribution.js'
import { systemClock } from '../core/clock.js'
import { costOfBuckets } from '../core/cost.js'

/** usage 的四个桶。缺的字段按 0 计，但"整条 usage 都没有"和"是 0"必须能区分。 */
export const EMPTY_BUCKETS = Object.freeze({
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
})

/** 把宿主 usage 折成四桶。与官方 `bucketsFrom` 同口径。 */
export function bucketsFrom(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = Number(usage.inputTokens)
  const output = Number(usage.outputTokens)
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null
  const cacheRead = Number(usage.cacheReadTokens)
  const cacheWrite = Number(usage.cacheWriteTokens)
  return {
    uncachedInputTokens: input,
    outputTokens: output,
    cacheReadTokens: Number.isFinite(cacheRead) ? cacheRead : 0,
    cacheWriteTokens: Number.isFinite(cacheWrite) ? cacheWrite : 0,
  }
}

/** 四桶求和（累计用量）。 */
export function totalOf(buckets) {
  if (!buckets) return 0
  return buckets.uncachedInputTokens + buckets.cacheReadTokens
    + buckets.cacheWriteTokens + buckets.outputTokens
}

/** prompt 侧压力（不含输出）。与官方 `pressureFrom` 同口径。 */
export function pressureOf(buckets) {
  if (!buckets) return 0
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
}

/** 在 `event.data.stream` 里找最后一个 usage 块。 */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i--) {
    const chunk = stream[i]
    if (chunk?.type === 'usage' && chunk.usage) return chunk.usage
  }
  return undefined
}

/**
 * 从一个持久化会话事件里取出 usage。
 *
 * 判定顺序与 `dsh-token-meter` 的 `usageOf()` 一致：
 *   `assistant/message` 且带 `data.usage` → 用它；
 *   否则 `assistant/message` / `assistant/attempt` → 扫 `data.stream` 里最后一个 usage 块；
 *   其他事件类型 → 没有。
 */
export function usageOfEvent(event) {
  if (!event || typeof event !== 'object') return undefined
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastStreamUsage(event.data?.stream)
}

function addBuckets(a, b) {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

function subBuckets(a, b) {
  return {
    uncachedInputTokens: a.uncachedInputTokens - b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens,
    outputTokens: a.outputTokens - b.outputTokens,
  }
}

function bucketsEqual(a, b) {
  return a.uncachedInputTokens === b.uncachedInputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens
    && a.outputTokens === b.outputTokens
}

/**
 * 每会话的用量账本。
 *
 * 去重口径照抄官方 `tokenUsage` 投影：同一个 `(turn, step)` 的多次采样
 * **替换**而不是累加（重试/多次 chunk 上报都属于这一类），
 * `llm/retry-started` 关掉替换槽，让被重试的那次真正加进总量。
 */
export class UsageLedger {
  /** @param {{clock?: {now: () => number}, limit?: number, maxStepsPerSession?: number}} [options] */
  constructor(options = {}) {
    this.clock = options.clock ?? systemClock()
    this.limit = Number(options.limit) > 0 ? Number(options.limit) : 64
    /** 每会话最多保留多少步归因（#2 有界：超出丢最老的 turn/step）。 */
    this.maxStepsPerSession = Number.isSafeInteger(options.maxStepsPerSession)
      && options.maxStepsPerSession > 0
      ? options.maxStepsPerSession
      : MAX_STEPS_PER_SESSION
    /** @type {Map<string, object>} */
    this.bySession = new Map()
  }

  #entry(sessionId) {
    let entry = this.bySession.get(sessionId)
    if (!entry) {
      entry = {
        sessionId,
        totals: { ...EMPTY_BUCKETS },
        last: null,
        lastUsage: null,
        lastTurn: null,
        lastStep: null,
        requests: 0,
        at: 0,
        firstAt: 0,
        /** 最近一次请求看到的模型名（拿不到就是 null，折价会走估算档）。 */
        model: null,
        /** 观测到的子代理深度；null = 拿不到（byDepth 归 unknown，不猜 main）。 */
        depth: null,
        /** 每步 token / 工具归因表（按会话有界）。 */
        steps: new StepTable({ maxSteps: this.maxStepsPerSession }),
      }
      this.bySession.set(sessionId, entry)
      // 有界：只留最近用过的若干个会话。
      if (this.bySession.size > this.limit) {
        const oldest = this.bySession.keys().next().value
        if (oldest !== undefined && oldest !== sessionId) this.bySession.delete(oldest)
      }
    }
    return entry
  }

  /**
   * 喂一个会话事件。
   *
   * 第一个参数可以是 `session/event` 回调原样给的 session 对象，也可以是
   * 字符串 id（老调用方/测试）。**只有对象形态拿得到 `delegationDepth`**；
   * 拿不到就保持 null，`byDepth()` 会把它归 unknown。
   *
   * @param {string|object} sessionOrId
   * @param {object} event `session/event` 的第二个参数
   * @returns {boolean} 这次有没有真的更新账本
   */
  observe(sessionOrId, event) {
    const session = sessionOrId && typeof sessionOrId === 'object' ? sessionOrId : null
    const key = String(session?.id ?? sessionOrId ?? '')
    if (!key) return false
    const entry = this.#entry(key)
    const depth = depthOfSession(session)
    if (depth !== null) entry.depth = depth

    // 工具名本身不带成本，成本在随后（或之前）的 assistant/message usage 里。
    // 先落到该 (turn, step)，够 topSteps 时一起报出来。
    if (event?.type === 'tool/call') {
      const data = event.data ?? {}
      return entry.steps.recordTool(data.turn, data.step, data.name)
    }

    if (event?.type === 'llm/retry-started') {
      const last = entry.last
      if (last && last.turn === event.data?.turn && last.step === event.data?.step) {
        entry.last = null
        return true
      }
      return false
    }

    // 模型名只在 `request/header` 里出现一次。记下来给折价用 ——
    // 拿不到就一直保持 null，折价会明确标成"估算"，不猜。
    if (event?.type === 'request/header') {
      const model = event.data?.header?.config?.model
      if (typeof model === 'string' && model.length > 0 && model !== entry.model) {
        entry.model = model
        return true
      }
      return false
    }

    const usage = usageOfEvent(event)
    const buckets = bucketsFrom(usage)
    if (!buckets) return false

    const turn = event.data?.turn ?? null
    const step = event.data?.step ?? null
    const previous = entry.last && entry.last.turn === turn && entry.last.step === step
      ? entry.last.buckets
      : undefined

    entry.lastUsage = buckets
    entry.lastTurn = turn
    entry.lastStep = step
    entry.at = this.clock.now()
    if (entry.firstAt === 0) entry.firstAt = entry.at

    if (previous !== undefined && bucketsEqual(previous, buckets)) return false
    entry.requests += 1
    entry.totals = previous !== undefined
      ? addBuckets(subBuckets(entry.totals, previous), buckets)
      : addBuckets(entry.totals, buckets)
    entry.last = { turn, step, buckets }
    // 按步归因：口径与上面的累计完全一致 —— 同一 (turn,step) 是替换；
    // `llm/retry-started` 清掉 last 之后同一步再来，算该步的新一段（累加）。
    if (turn !== null && step !== null) {
      entry.steps.recordUsage(turn, step, buckets, {
        replace: previous !== undefined,
        at: Number.isFinite(event?.time) ? event.time : this.clock.now(),
        model: entry.model,
      })
    }
    return true
  }

  /** 某会话的账本快照。没有就返回 null（**不返回一堆 0 假装知道**）。 */
  sample(sessionId, options = {}) {
    const entry = this.bySession.get(String(sessionId ?? ''))
    if (!entry) return null
    const cost = costOfBuckets(entry.totals, {
      atMs: entry.at || this.clock.now(),
      model: entry.model ?? options.model ?? null,
      prices: options.prices,
    })
    return {
      source: 'session-event',
      /** prompt 侧压力，不含输出。只有累计口径时它也是"最近一次请求的压力"。 */
      pressureTokens: pressureOf(entry.lastUsage),
      /** 最近一次请求的四桶。 */
      lastUsage: entry.lastUsage ? { ...entry.lastUsage } : null,
      /** 累计四桶。 */
      totals: { ...entry.totals },
      cumulativeTokens: totalOf(entry.totals),
      /** 累计金额（USD）。`known:false` 表示这次折算拿不到价目，不是"花了 0"。 */
      cost,
      /** 账本里记到的模型名（来自 request/header；拿不到就是 null）。 */
      model: entry.model ?? null,
      requests: entry.requests,
      lastTurn: entry.lastTurn,
      lastStep: entry.lastStep,
      at: entry.at,
      firstAt: entry.firstAt,
      /** 事件账本看不到 contextWindow，也看不到压缩 —— 明确标出来。 */
      contextWindow: null,
      complete: false,
      /** 本会话最贵的几步（#2，可选字段；老调用方忽略即可）。 */
      topSteps: this.topSteps(entry.sessionId, options.stepLimit ?? 5, options),
    }
  }

  /** 全部会话的概览（给状态页用）。 */
  list(options = {}) {
    return [...this.bySession.values()].map((entry) => {
      const cost = costOfBuckets(entry.totals, {
        atMs: entry.at || this.clock.now(),
        model: entry.model ?? options.model ?? null,
        prices: options.prices,
      })
      return {
        sessionId: entry.sessionId,
        cumulativeTokens: totalOf(entry.totals),
        pressureTokens: pressureOf(entry.lastUsage),
        requests: entry.requests,
        usd: cost.usd,
        costKnown: cost.known,
        costEstimated: cost.estimated,
        /** 子代理深度；null 表示拿不到（byDepth 会归 unknown）。 */
        depth: entry.depth,
        at: entry.at,
        /** 本会话最贵的几步（#2，可选字段）。 */
        topSteps: this.topSteps(entry.sessionId, options.stepLimit ?? 5, options),
      }
    })
  }

  /**
   * 某会话成本最高的 n 步（#2）。
   *
   * 只列真的收到过 usage 的步：没有 usage 的步（例如只发了 tool/call 就被
   * 中断）没有 delta 可归因，用 0 顶上等于假装知道成本。turn/step 缺失的
   * usage 仍计入会话累计（`sample().cumulativeTokens`），但不进本列表 ——
   * 归不到步上的钱宁可不说，也不分摊到别的步。
   *
   * @param {string} sessionId
   * @param {number} [n=5]
   * @param {{model?: string|null, prices?: object}} [options]
   * @returns {Array<{turn:number, step:number, tokens:number, usd:(number|null), tools:string[]}>}
   */
  topSteps(sessionId, n = 5, options = {}) {
    const entry = this.bySession.get(String(sessionId ?? ''))
    if (!entry) return []
    const rows = []
    for (const row of entry.steps.entries()) {
      if (!row.usageSeen) continue
      const cost = costOfBuckets(row.tokensBuckets, {
        atMs: row.at || entry.at || this.clock.now(),
        model: row.model ?? entry.model ?? options.model ?? null,
        prices: options.prices,
      })
      rows.push({
        turn: row.turn,
        step: row.step,
        tokens: totalOf(row.tokensBuckets),
        usd: cost.usd,
        tools: row.tools,
      })
    }
    return topOf(rows, n)
  }

  /**
   * 按会话的 `delegationDepth` 分组记账（#6）。
   *
   * depth 只从 `session.header.delegationDepth` 或扁平形态的
   * `session.delegationDepth` 读；两处都没有就进 `unknown`，**不猜 main**。
   * 每组 `sessions=0` 只表示没有观测到的会话，不是"这一层花了 0 元"。
   *
   * @param {{model?: string|null, prices?: object}} [options]
   * @returns {{main: {tokens:number, usd:number, requests:number, sessions:number},
   *            sub: {tokens:number, usd:number, requests:number, sessions:number},
   *            unknown: {tokens:number, usd:number, requests:number, sessions:number}}}
   */
  byDepth(options = {}) {
    const rows = [...this.bySession.values()].map((entry) => {
      const cost = costOfBuckets(entry.totals, {
        atMs: entry.at || this.clock.now(),
        model: entry.model ?? options.model ?? null,
        prices: options.prices,
      })
      return {
        sessionId: entry.sessionId,
        depth: entry.depth,
        tokens: totalOf(entry.totals),
        usd: cost.usd,
        requests: entry.requests,
      }
    })
    return groupByDepth(rows)
  }

  reset(sessionId) {
    if (sessionId === undefined) this.bySession.clear()
    else this.bySession.delete(String(sessionId))
  }
}

/**
 * 读官方投影。这是"当前上下文压力"的**首选**来源。
 *
 * 用 `cachedSnapshot` 而不是 `snapshot`：前者只读已经物化好的缓存格子、
 * 不折叠历史，放在 pre-step 热路径上不会引入 O(surface) 的开销。
 * 代价是它可能略微落后于 live session —— 对"要不要提醒"这种判断足够。
 *
 * @returns {{pressureTokens: number|null, projectedTokens: number|null,
 *            contextWindow: number|null, totals: object|null, asOfSeq: number|null}|null}
 */
export function readOfficialPressure(ctx, session) {
  try {
    const projections = ctx?.get?.('sessionProjections')
    if (!projections?.cachedSnapshot || !session) return null
    const snap = projections.cachedSnapshot(session, ['contextPressure', 'tokenUsage'])
    if (!snap || typeof snap !== 'object') return null
    const pressure = snap.values?.contextPressure
    const usage = snap.values?.tokenUsage
    if (!pressure && !usage) return null
    return {
      pressureTokens: Number.isFinite(pressure?.pressureTokens) ? pressure.pressureTokens : null,
      projectedTokens: Number.isFinite(pressure?.projectedTokens) ? pressure.projectedTokens : null,
      contextWindow: Number.isFinite(pressure?.contextWindow) ? pressure.contextWindow : null,
      totals: usage && typeof usage === 'object' ? usage : null,
      asOfSeq: Number.isFinite(snap.asOfSeq) ? snap.asOfSeq : null,
    }
  } catch {
    return null
  }
}

/**
 * 合成一次"当前上下文有多满"的判断。
 *
 * 优先级：官方投影 → 事件账本 → unknown。
 * `basis` 字段说明这个数是怎么来的，界面与提醒文案必须带上它 ——
 * 拿不到就写 unknown，**不许用累计用量冒充当前压力**。
 *
 * @returns {{known: boolean, basis: string, pressureTokens: number|null,
 *            projectedTokens: number|null, contextWindow: number|null,
 *            ratio: number|null, cumulative: object|null, requests: number}}
 */
export function resolveContextLoad(ctx, session, sessionId, ledger, options = {}) {
  const official = readOfficialPressure(ctx, session)
  const fromEvent = ledger?.sample?.(sessionId, options) ?? null

  const pressure = official?.projectedTokens ?? official?.pressureTokens
    ?? (fromEvent ? fromEvent.pressureTokens : null)
  const basis = official?.projectedTokens != null
    ? 'official-projection:projected'
    : official?.pressureTokens != null
      ? 'official-projection:pressure'
      : fromEvent
        ? 'session-event:last-usage'
        : 'unknown'

  const contextWindow = official?.contextWindow ?? null
  const cumulative = official?.totals
    ? { source: 'official-projection', buckets: official.totals, tokens: totalOfBucketsLoose(official.totals) }
    : fromEvent
      ? { source: 'session-event', buckets: fromEvent.totals, tokens: fromEvent.cumulativeTokens }
      : null

  // 金额只认事件账本（官方投影的 tokenUsage 字段名不保证与四桶一致，
  // 拿它折价会静默算错 —— 宁可报 unknown）。
  const cost = fromEvent?.cost ?? { known: false, usd: null }

  return {
    known: pressure !== null,
    basis,
    pressureTokens: pressure,
    projectedTokens: official?.projectedTokens ?? null,
    contextWindow,
    ratio: pressure !== null && contextWindow ? pressure / contextWindow : null,
    cumulative,
    requests: fromEvent?.requests ?? 0,
    lastUsage: fromEvent?.lastUsage ?? null,
    /** 本会话累计金额（USD，事件账本口径）。 */
    cost,
    model: fromEvent?.model ?? options.model ?? null,
  }
}

/** 官方 tokenUsage 视图的字段名与我们的四桶一致，但不保证；宽松求和。 */
function totalOfBucketsLoose(buckets) {
  if (!buckets || typeof buckets !== 'object') return 0
  let sum = 0
  for (const value of Object.values(buckets)) {
    const n = Number(value)
    if (Number.isFinite(n)) sum += n
  }
  return sum
}

/**
 * 挂上用量采样。返回卸载函数；拿不到钩子返回 null。
 *
 * @param {any} ctx cordis 上下文
 * @param {{ledger: UsageLedger, capabilities?: any, log?: any,
 *          onEvent?: (e: object) => void}} deps
 */
export function installUsageSampling(ctx, deps) {
  if (typeof ctx?.on !== 'function') {
    deps.capabilities?.markUnsupported?.('usageSampling', '拿不到 ctx.on')
    return null
  }

  let off = null
  try {
    off = ctx.on('session/event', (session, event) => {
      try {
        const sessionId = session?.id
        if (sessionId === undefined || sessionId === null) return
        // 同一个事件流喂给"位置"：turn/start 给提醒节流、step/start 给归档事件。
        deps.timeline?.observe(String(sessionId), event)
        // 传 session 对象而不是 id：账本要读 header.delegationDepth（#6）；
        // 拿不到 depth 的会话账本里保持 null，byDepth 归 unknown。
        const updated = deps.ledger.observe(session, event)
        // 阶段预算的"回复数"必须真的被数到（2026-10-17 审计）：
        // `ProgressWatch.countReply()` 以前**没有任何调用者**，于是
        // `taskBudgetReplies: 30` 永远不会触发 —— 配置写着有闸门，实际是空的。
        // 一次 assistant 回复 = 一条 assistant/message 持久化事件。
        if (event?.type === 'assistant/message') {
          try { deps.progress?.countReply?.(String(sessionId)) } catch { /* 计数失败不影响采样 */ }
        }
        if (updated) {
          deps.capabilities?.markObserved?.('usageSampling', `${event?.type ?? 'event'} @${sessionId}`)
          // 只有真的收到带 turn/step 的 usage，才说"按步归因在出数据"。
          if (event?.type === 'assistant/message' || event?.type === 'assistant/attempt') {
            deps.capabilities?.markObserved?.('costByStep', `turn ${event.data?.turn} step ${event.data?.step}`)
          }
          // depth 是从 session 对象读到的；拿不到就不标 observed（byDepth 里是 unknown）。
          const depth = session?.header?.delegationDepth ?? session?.delegationDepth
          if (depth !== undefined && depth !== null) {
            deps.capabilities?.markObserved?.('subagentCost', `depth=${depth}`)
          }
        }
      } catch (error) {
        // 采样失败绝不影响会话；但要限频报出来，不能静默。
        deps.capabilities?.markDegraded?.('usageSampling', `采样异常：${error?.message ?? error}`)
      }
    })
  } catch (error) {
    deps.capabilities?.markDegraded?.('usageSampling', `session/event 挂载失败：${error?.message ?? error}`)
    return null
  }

  if (typeof off !== 'function') {
    deps.capabilities?.markDegraded?.('usageSampling', 'session/event 注册没有返回卸载句柄')
    return null
  }
  deps.capabilities?.markMounted?.('usageSampling', off, 'session/event')
  deps.capabilities?.markSupported?.('contextPressure', 'sessionProjections.contextPressure')
  // #2 / #6 的归因视图由同一个账本提供：钩子挂上即"能提供"，真正观察到
  // 带 turn/step 的 usage / delegationDepth 时才标 observed（见上面的回调）。
  deps.capabilities?.markSupported?.('costByStep', 'UsageLedger.topSteps')
  deps.capabilities?.markMounted?.('costByStep', off, 'session/event')
  deps.capabilities?.markSupported?.('subagentCost', 'UsageLedger.byDepth')
  deps.capabilities?.markMounted?.('subagentCost', off, 'session/event')

  const dispose = () => {
    try { off() } catch { /* 清理失败无所谓 */ }
    deps.capabilities?.markUnmounted?.('usageSampling', '已卸载')
    deps.capabilities?.markUnmounted?.('costByStep', '已卸载')
    deps.capabilities?.markUnmounted?.('subagentCost', '已卸载')
  }
  dispose.stats = { observed: () => deps.ledger.list().length }
  dispose.handle = off
  return dispose
}
