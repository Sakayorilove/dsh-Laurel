/**
 * laurel-context/compaction-provider —— 按 DSH 真实 compaction 契约实现的后端。
 *
 * 契约（来自 @deepseek-ai/dsh-compaction@0.2.1-rc.1 的 README 与 index.js）：
 *   - 抽象 `CompactionEngine` 基类，三个操作：
 *       compactIfNeeded(trigger)  自动触发（pressure / context-overflow）
 *       compactNow()              显式按需
 *       compactRegion(range)      调用方指定范围
 *   - 日志锁协议：`compaction/start` 追加 → 摘要 → 追加 `compaction/summary`
 *     → 用一条承载摘要的 `user/message` 替换选区（**唯一表层变更**）
 *     → `compaction/end` 释放。
 *   - `compaction/start` 与 `compaction/end` 都**只写日志**，不上表层。
 *   - 摘要消息带稳定标记，消费方可识别压缩历史。
 *   - signal 必须转发到 `GenerateOptions.signal`，abort/dispose 要能停掉摘要。
 *   - 失败要抛 `ManualCompactionError`，带稳定 code；只有 start 之后失败才写 `compaction/end`。
 *
 * 这个文件**不 import DSH**：它只实现同样的形状，由宿主侧适配器注入到 ctx.compaction。
 * 这样它既能在宿主里当 provider，也能在纯 Node 里单元测试。
 */
import { createHash } from 'node:crypto'

/** 稳定标记：任何消费方都能识别"这是压缩摘要"。与宿主约定保持一致的做法。 */
export const SUMMARY_MARKER = '<!-- laurel:compaction-summary -->'

export const MANUAL_ERROR_CODES = Object.freeze([
  'busy',
  'cancelled',
  'region-unstable',
  'no-candidate',
  'summarise-failed',
  'persist-failed',
])

/** 手动压缩失败的稳定错误。 */
export class ManualCompactionError extends Error {
  constructor(code, message, details = {}) {
    super(message ?? code)
    this.name = 'ManualCompactionError'
    this.code = MANUAL_ERROR_CODES.includes(code) ? code : 'summarise-failed'
    this.details = details
  }
}

/** 触发压力阈值（与引擎 TIER_POLICY 分开：这里管宿主自动触发，那里管我们自己的压力）。 */
export const TRIGGER_POLICY = Object.freeze({
  pressure: 0.75,          // 超过 75% 才考虑
  contextOverflow: 0.92,   // 接近上限必须处理
  minGainChars: 400,       // 收益太小不动
})

/**
 * 解出「步间压力」的触发比例（L09 第二处）。
 *
 * 【为什么需要这个函数】`laurel-context` 有**两套**压力判据，配置只能进其中一套：
 *
 *   1. 引擎侧（`engine.mjs` 的 `TIER_POLICY[tier].trigger`）—— S6/L09 已修，
 *      `config.triggerRatio` 能进去，但它只管**我们自己**的压力读数。
 *   2. 宿主自动触发侧（本文件 `compactIfNeeded`）—— 此前写死读
 *      `TRIGGER_POLICY.pressure`，`config.triggerRatio` 压根没走到这里。
 *
 * 真机后果：profile 里写 `triggerRatio: 0.05` 完全没反应，端点
 * `compactionEntry.triggerRatio` 显示 `null`（entry 只把它存进 runtime，从不传下来），
 * 而 `autoCompaction.stats.pressureChecks` 一直涨、`pressureCompactions` 恒 0
 * —— 「配置被接受了，但没接到闸门上」，这正是 L09 的原始症状原样复发。
 *
 * 合法区间 `(0, 1]`；越界/非数字一律退回策略默认值而不是静默变成 0 或 NaN
 * （`NaN < 0.75` 为假会被当成「到阈值了」，那是拿不准却假装知道）。
 */
export function resolveTriggerRatio(requested) {
  const v = typeof requested === 'function' ? safeCall(requested) : requested
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : TRIGGER_POLICY.pressure
}

function safeCall(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

/**
 * 构建一条带标记的摘要消息（宿主表层只认 user/message）。
 */
export function buildSummaryMessage({ text, range, tier = 'T1', refs = [], at = Date.now() }) {
  const body = [
    SUMMARY_MARKER,
    `<!-- laurel:range ${range.start}-${range.end} tier=${tier} -->`,
    refs.length ? `<!-- laurel:refs ${refs.join(',')} -->` : '',
    '',
    String(text ?? '').trim(),
  ].filter((x) => x !== '').join('\n')
  return {
    role: 'user',
    surfaceOp: 'replace',
    content: body,
    at,
    // 供消费方识别，不进正文
    meta: { laurelSummary: true, range, tier, refs },
  }
}

/** 从任意消息里识别是不是我们的摘要。 */
export function isSummaryMessage(msg) {
  const text = typeof msg === 'string' ? msg : (msg?.content ?? msg?.text ?? '')
  return typeof text === 'string' && text.includes(SUMMARY_MARKER)
}

/**
 * Provider 主体。注入依赖以便测试：
 *   { journal, summarizer, signal, measure, tier, limitTokens }
 *
 * journal 需实现：
 *   append(event)                     追加日志事件
 *   replaceRange(range, message)       替换表层选区（唯一表层变更）
 *   surface()                          取当前表层事件
 *   hasOpenStart()                     是否有未匹配的 compaction/start（锁）
 */
export function createCompactionProvider(deps) {
  const {
    journal, summarizer, tier = 'zero', limitTokens = 200_000, // 可以是一个返回数字的函数
    measure = defaultMeasure, now = Date.now, eventId = () => 'ce-' + createHash('sha256').update(String(now()) + Math.random()).digest('hex').slice(0, 16),
    // L09 第二处：步间压力的触发比例。可以是数字，也可以是函数（每次现解
    // —— 配置在 apply 后被 HMR 换成别的值时不用重建 provider）。
    triggerRatio = null,
    // 【选区必须避开已压过的头部】返回「已经发布过的摘要覆盖的事件 id 集合」。
    // 不给就退回老行为（从头选）——但那样第二次压缩必然撞 range-overlaps-published，
    // 详见 selectCandidateRange 上方那段实测记录。
    coveredIdsOf = null,
    // 【首选】引擎直接回答「这些表层 eventId 里哪些已被已发布摘要覆盖」。
    // 为什么优先它而不是 coveredIdsOf：引擎 state.events 是**摄取到达顺序**，
    // 宿主表层是 **seq 升序**，两者顺序不同；调用方拿集合自己推区间会错。
    coveredFlagsOf = null,
  } = deps
  if (!journal || typeof journal.append !== 'function') throw new TypeError('journal 必须实现 append')
  if (!journal || typeof journal.replaceRange !== 'function') throw new TypeError('journal 必须实现 replaceRange')

  const state = {
    lastSummaryAt: null,
    compactions: 0,
    lastError: null,
    inFlight: false,
    /** L09 第二处：最近一次「压/不压」判定的完整读数，端点直接对账。 */
    lastGate: null,
  }

  /**
   * 每调用现解一次窗口上限（L10）。
   *
   * `limitTokens` 允许传函数：真实上下文窗口只有宿主投影知道，而投影在 apply 期
   * 还没物化。若在这里把它求值成一个数字，闭包就永远拿 200_000 当窗口
   * —— 端点 stats 报 1,000,000、实际按 200k 判，8% 用量就去压缩（真机实测）。
   * 解不出有限正数时退 200_000（档位默认量级），不静默当成 0 或 Infinity。
   */
  function resolveLimit() {
    const v = typeof limitTokens === 'function' ? limitTokens() : limitTokens
    return Number.isFinite(v) && v > 0 ? v : 200_000
  }

  /** 锁：有未匹配 start 就是 busy。 */
  function lockState() {
    return { busy: typeof journal.hasOpenStart === 'function' ? journal.hasOpenStart() : false }
  }

  /**
   * 取「已被已发布摘要覆盖的事件 id 集合」，给 selectCandidateRange 跳头部用。
   *
   * 每次现取而不是缓存：摘要是随压缩增长的，缓存一份旧集合会让下一轮又从头选。
   * 取不到就返回 null —— 退回老行为（从头选），不因为拿不到判据就整个不压。
   * 失败一律吞掉：这是优化选区的旁路信息，不能让它把压缩本身搞挂。
   */
  function resolveCoveredIds() {
    if (typeof coveredIdsOf !== 'function') return null
    try {
      const v = coveredIdsOf()
      return v && typeof v.has === 'function' ? v : null
    } catch {
      return null
    }
  }

  /** 取引擎的「这条被覆盖了吗」判定器；拿不到返回 undefined（选区退回老行为）。 */
  function resolveCoveredFlags() {
    if (typeof coveredFlagsOf !== 'function') return undefined
    return (ids) => {
      try {
        return coveredFlagsOf(ids)
      } catch {
        return null
      }
    }
  }

  /**
   * 本次判定要用的压力阈值（L09 第二处）。
   *
   * 优先用配置/调用方给的比例；没给才退 `TRIGGER_POLICY.pressure`。
   * 端点要能看出来用的是哪个，所以 `stats()` 把它带出去。
   */
  function pressureThreshold() {
    return resolveTriggerRatio(triggerRatio)
  }

  /**
   * 把「为什么压 / 为什么不压」记进 `state.lastGate` 并随返回值带出去。
   *
   * 【为什么需要】`below-pressure` 以前只报 reason，端点看不到「当前 ratio 多少、
   * 拿它跟哪个阈值比」。L09 那次就是这样漏了一个月：配置写着 0.05，闸门读的是
   * 写死的 0.75，而两边都不打印阈值 —— 面板上看不出谁在说谎。
   * 现在每次判定都留下 `{used, ratio, limit, threshold}`，端点直接能对账。
   */
  function decide(base, result = null) {
    const gate = {
      reason: base?.reason ?? null,
      used: Number.isFinite(base?.used) ? base.used : null,
      ratio: Number.isFinite(base?.ratio) ? base.ratio : null,
      limit: Number.isFinite(base?.limit) ? base.limit : null,
      threshold: Number.isFinite(base?.threshold) ? base.threshold : pressureThreshold(),
      at: now(),
    }
    state.lastGate = gate
    return result ? { ...result, gate } : { ...base, gate }
  }

  /**
   * 选范围时用的配对判据（D140）。
   *
   * 宿主 `selectCompactableRange` 在选范围阶段就把切割点退到工具配对平衡的位置；
   * Laurel 原先只在 runCompaction 里事后校验，于是「切在未配对的工具调用上」直接
   * 变成 region-unstable 失败、一次都压不成。这里把同一判据前移到选择阶段。
   */
  const pairHooks = typeof journal.pairingBalancedAt === 'function'
    ? { pairingBalancedAt: (position) => journal.pairingBalancedAt(position) }
    : {}

  /**
   * 核心流程：拿锁 → 摘要 → 写 summary 事件 → 替换表层 → 放锁。
   * 任何一步失败都要确保：要么没写 start，要么写了 end 记录失败。
   */
  async function runCompaction({ range, trigger, signal }) {
    if (lockState().busy) {
      throw new ManualCompactionError('busy', '已有压缩在进行（compaction/start 未闭合）')
    }
    if (signal?.aborted) throw new ManualCompactionError('cancelled', '调用方已取消')

    const surface = journal.surface()
    if (range.end > surface.length) {
      throw new ManualCompactionError('region-unstable', '选区超出表层长度', { range, surface: surface.length })
    }
    // 选区稳定性：不能在未回答的工具调用上切
    if (typeof journal.pairingBalancedAt === 'function' && !journal.pairingBalancedAt(range.end)) {
      throw new ManualCompactionError('region-unstable', '选区边界切断了未配对的工具调用', { range })
    }

    const startId = eventId()
    journal.append({ type: 'compaction/start', id: startId, trigger, range, at: now() })
    state.inFlight = true

    let result = null
    let failure = null
    try {
      // 方案 A（S4 / L07 / MC06）：这里**不许再切**。
      //
      // 此前是 `events: surface.slice(range.start, range.end)`，同时又把这个
      // **绝对** range 一起交给 summarizer；summarizer 按契约拿 range 去切
      // 自己的 events，于是同一个范围被切了**两遍**：
      //   · start=1：喂进去的只剩尾部 5/6，inputChars 少算、摘要少覆盖一段；
      //   · start=5：第二刀在 2~4 条长的数组上切 [5,7) → 切空
      //     → ok:false / reason:'empty'，压缩整体失败。
      // 现在契约统一成「表层全量事件 + 绝对 range」，只在
      // host-compaction 归一化一次、由下游按 range 切一刀。
      const out = await summarizer({
        events: surface,
        range,
        trigger,
        signal,
        protectedItems: typeof journal.protectedItems === 'function' ? journal.protectedItems() : [],
      })
      if (signal?.aborted) throw new ManualCompactionError('cancelled', '摘要期间被取消')
      if (!out?.ok) throw new ManualCompactionError('summarise-failed', out?.reason ?? '摘要失败', out)

      const msg = buildSummaryMessage({
        text: out.text, range, tier, refs: out.refs ?? [], at: now(),
      })
      journal.append({
        type: 'compaction/summary',
        id: eventId(), startId, range, tier,
        // D137：`text` 必须进事件。此前这里只写 `chars`（长度），正文只在
        // 表层那条消息里，事件本身是空的。宿主契约
        // （dsh-compaction-basic 的 commitCompactionBody）把
        // `compaction/summary` 的 `summary` 字段当摘要正文用 ——
        // 我们这边留空，宿主侧读到的就是空摘要，会话被替换成一条空白消息。
        text: String(out.text ?? ''),
        refs: Array.isArray(out.refs) ? out.refs : [],
        mechanical: out.mechanical === true,
        chars: String(out.text ?? '').length,
        usage: out.usage ?? null,
        at: now(),
      })
      // 唯一表层变更
      const replaced = journal.replaceRange(range, msg)
      result = {
        ok: true,
        range,
        tier,
        chars: String(out.text ?? '').length,
        replaced,
        startId,
        usage: out.usage ?? null,
        unknownUsage: out.unknownUsage ?? false,
      }
    } catch (e) {
      failure = e instanceof ManualCompactionError
        ? e
        : new ManualCompactionError('summarise-failed', String(e?.message ?? e))
      state.lastError = { code: failure.code, message: failure.message, at: now() }
    } finally {
      // 每次失败都恰好一次闭合尝试；闭合失败会留下未匹配 start 作为 busy 信号
      journal.append({
        type: 'compaction/end',
        id: eventId(), startId,
        ok: !failure,
        code: failure?.code ?? null,
        at: now(),
      })
      state.inFlight = false
    }

    if (failure) throw failure
    state.compactions++
    state.lastSummaryAt = now()
    return result
  }

  /** 三个契约操作之一：自动触发。 */
  async function compactIfNeeded({ signal, trigger } = {}) {
    const surface = journal.surface()
    const limitNow = resolveLimit()
    const used = measure(surface)
    // NaN（投影还没物化）时 ratio 是 NaN：`NaN < 0.75` 为假，于是会被判成
    // "到阈值了" 去压 —— 这是拿不准却假装知道。显式拦掉，返回 reason 让人看见。
    const ratio = used / limitNow
    if (!Number.isFinite(ratio)) return decide({ ok: false, reason: 'usage-unknown', used, ratio, limit: limitNow })
    const threshold = pressureThreshold()
    const kind = trigger?.kind ?? (ratio >= TRIGGER_POLICY.contextOverflow ? 'context-overflow' : 'pressure')

    // 零推理档 + 没有摘要器 → 不触发（但要说明原因，不静默）
    if (tier === 'zero' && !deps.allowZeroTierSummary) {
      return decide({ ok: false, reason: 'zero-tier-no-inference', used, ratio, limit: limitNow, threshold, note: '零推理档不做语义摘要' })
    }
    // L09 第二处：这里此前读的是写死的 `TRIGGER_POLICY.pressure`，
    // 配置里的 triggerRatio 到不了 —— 「配置被接受但没接上闸门」。
    if (kind === 'pressure' && ratio < threshold) {
      return decide({ ok: false, reason: 'below-pressure', used, ratio, limit: limitNow, threshold })
    }
    const range = selectCandidateRange(surface, limitNow, {
      ...pairHooks,
      coveredFlags: resolveCoveredFlags(),
      coveredIds: resolveCoveredIds(),
    })
    if (!range) return decide({ ok: false, reason: 'no-candidate', used, ratio, limit: limitNow, threshold })
    const gain = estimateGain(surface, range)
    if (gain < TRIGGER_POLICY.minGainChars) {
      return decide({ ok: false, reason: 'gain-too-small', gain, used, ratio, limit: limitNow, threshold, range })
    }
    const result = await runCompaction({ range, trigger: { kind }, signal })
    return decide({ ok: true, reason: 'compacted', kind, used, ratio, limit: limitNow, threshold, range }, result)
  }

  /** 三个契约操作之二：显式按需。 */
  async function compactNow({ signal } = {}) {
    const surface = journal.surface()
    const range = selectCandidateRange(surface, resolveLimit(), {
      ...pairHooks,
      coveredFlags: resolveCoveredFlags(),
      coveredIds: resolveCoveredIds(),
    })
    if (!range) throw new ManualCompactionError('no-candidate', '没有可压缩的范围')
    return runCompaction({ range, trigger: { kind: 'manual' }, signal })
  }

  /** 三个契约操作之三：指定范围。 */
  async function compactRegion(range, { signal } = {}) {
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start) {
      throw new ManualCompactionError('region-unstable', '选区非法', { range })
    }
    return runCompaction({ range, trigger: { kind: 'manual-region' }, signal })
  }

  function stats() {
    return {
      tier,
      limitTokens: resolveLimit(),
      triggerRatio: pressureThreshold(),
      compactions: state.compactions,
      lastSummaryAt: state.lastSummaryAt,
      lastError: state.lastError,
      lastGate: state.lastGate,
      inFlight: state.inFlight,
      lock: lockState(),
    }
  }

  return { compactIfNeeded, compactNow, compactRegion, stats, TRIGGER_POLICY, MANUAL_ERROR_CODES }
}

/** 默认测量：字符数当 token 的粗估（宿主会注入 ctx.tokenMeter，这里只作后备）。 */
function defaultMeasure(surface) {
  let n = 0
  for (const e of surface) {
    const t = e?.content ?? e?.text ?? ''
    n += typeof t === 'string' ? t.length : JSON.stringify(t ?? '').length
  }
  return n
}

/**
 * 表层 node 0 是不是 system prompt。
 *
 * D140：宿主契约（compaction-basic 的 `assertSystemHeadRewrite`）原文 ——
 * "Protect the system prompt at surface node 0. A replacement covering node 0
 * while that node is a `system/message` must itself be a `system/message` over
 * exactly that node"。压缩写的是 `user/message`，所以**只要选区包含 node 0，
 * 而 node 0 是 system/message，宿主每次都会拒绝**：
 * "surface replace: node 0 holds the system prompt and may be rewritten only by
 * a system/message over exactly that node"。
 *
 * 宿主的 `selectCompactableRange` 就是靠 `const firstIdx = systemHead(...) === undefined ? 0 : 1`
 * 跳过它的 —— 这里必须同样跳过，否则在真实会话上**每一次压缩都必然失败**。
 */
export function isSystemHead(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.role === 'system') return true
  if (entry.kind === 'system/message') return true
  if (entry.raw?.type === 'system/message') return true
  return false
}

/**
 * 选候选范围：跳过 node 0 的 system prompt、跳过**已经压过的头部**、保留尾部，
 * 并在需要时把切割点退到工具配对平衡的位置。
 *
 * - `start` 从第一个非 system 节点开始（宿主同款判据，见 isSystemHead）。
 * - `end` 是**开区间**（与 `surface.slice(range.start, range.end)` 一致）。
 * - `hooks.pairingBalancedAt(position)` 可选：为 false 时把 end 往前退，
 *   直到切割点不切断未配对的工具调用为止 —— 宿主 `selectCompactableRange`
 *   的 `while (keepFromIdx > firstIdx) { if (toolPairingBalancedBefore(...)) break; keepFromIdx -= 1 }`
 *   就是这个意思，缺了它 runCompaction 会抛 region-unstable。
 * - `hooks.coveredFlags(ids)` 可选（**首选**）：给一串表层 eventId，返回等长布尔数组，
 *   true = 该条已被已发布摘要覆盖。由引擎实现，调用方不该自己推。
 * - `hooks.coveredIds` 可选（兜底）：已覆盖事件 id 的 Set。只给了它就自己归一命名空间比。
 *   给了这两个中任意一个，选区就必须是**一段完全没被压过的连续区间**。
 *
 * 【为什么必须有这条（2026-10-22 真机缺陷，踩了四版）】─────────────────────
 * 以前 start 恒等于 firstIdx（表层第一个非 system 节点）。而压缩一旦成功，
 * 表层会被 replaceRange 换成一条 summary 消息 —— 那批原事件**并没有消失**，
 * 它们还在引擎的 state.events 里，并且已经被记进某条摘要的 coveredIds。
 *
 * 于是下一次压缩又从头选 [firstIdx, end)，这些事件的身份与已发布摘要重叠，
 * engine.commitSummary 正确地报 `range-overlaps-published`（判重叠是对的！），
 * 压缩失败 → 下一轮压力检查又选同一个 range → 再失败 …… 无限重试。
 *
 * 真机症状：pressureChecks 240、errors 27、用量一度 92%，
 * 每次都是 `range=1..1007 problems=[range-overlaps-published]`，一次也压不进去。
 *
 * 四版试错（前三个都实测不行，别再走回去）：
 *   ① `covered.has(surface[i].eventId)` → 命名空间不匹配（引擎存 `host:ev-N`、
 *      表层是裸 `ev-N`），永远 false，一条都跳不过去。
 *   ② 两侧归一后「遇到第一个未覆盖就停」→ 真机只把 start 从 1 挪到 2，
 *      后面仍压着大片已覆盖事件。
 *   ③ 「推进到最后一个已覆盖之后」→ start=13065，可压区间直接没了，返回 null。
 *   ④ 现在这版：**选区内部一条已覆盖的都不能有** —— start 取第一个未覆盖，
 *      end 取它之后第一个已覆盖（再受尾部保留约束）。
 *
 * 正确做法不是放宽判重（那会让同一段被压两遍、摘要重复计费），
 * 而是**选区自己避开已压过的地方**。压过的已经是摘要了，再压等于白干。
 */
export function selectCandidateRange(surface, limitTokens, hooks = {}) {
  if (!Array.isArray(surface) || surface.length < 3) return null
  const firstIdx = isSystemHead(surface[0]) ? 1 : 0

  // ── 可压范围：保留最后 30%（正在进行的工作），压前面 70% ──────────────
  const keepTail = Math.max(2, Math.floor(surface.length * 0.3))
  const hardEnd = surface.length - keepTail
  if (hardEnd <= firstIdx) return null

  // ── 取「这条压过没有」的判定器 ─────────────────────────────────────────
  // 首选 coveredFlags：引擎按表层身份直接回答，避开顺序与命名空间换算。
  // 兜底 coveredIds：只有集合时自己归一命名空间再比。
  const flags = resolveCoveredFlags(surface, hooks)
  const predicate = flags ? null : resolveCoveredPredicate(hooks)
  const isCovered = flags
    ? (i) => flags[i] === true
    : (predicate ? (i) => predicate(i, surface) : null)

  // ── 选一段干净区间：按「能回收多少字符」挑最大的一段，不是挑第一个 ────
  //
  // 【为什么按字符挑而不是按位置挑（2026-10-22 真机实测）】——
  // 13708 条 seq 升序表层里有 3837 段干净区间，绝大多数是碎片（1~3 条）。
  // 第一个干净区间只有 1 条 31 字符 —— 压它等于没压，estimateGain 还会判
  // gain-too-small 直接放弃，于是「明明还有 38 万字符可压，却一直不压」。
  // 最大的一段在尾部 [13082,13714) 共 632 条 / 384234 字符（22% 的正文）。
  // 所以选区要按「能回收多少」挑。
  let best = null
  if (isCovered) {
    let bestChars = 0
    let i = firstIdx
    while (i < hardEnd) {
      if (isCovered(i)) { i += 1; continue }
      let j = i
      let chars = 0
      while (j < hardEnd && !isCovered(j)) {
        const t = surface[j]?.text
        chars += typeof t === 'string' ? t.length : (t == null ? 0 : String(t).length)
        j += 1
      }
      if (j > i && chars > bestChars) {
        best = { start: i, end: j }
        bestChars = chars
      }
      i = j
    }
    // 一段干净的都没有 → 返回 null，让上层报 no-candidate。
    // 绝不硬压已压过的：那会撞 range-overlaps-published，而且重复计费。
    if (!best) return null
  } else {
    // 没有判定器（老调用方/测试桩）→ 保持老行为：从 firstIdx 到 hardEnd
    best = { start: firstIdx, end: hardEnd }
  }

  // ── 工具配对平衡：把 end 往前退到不切断未配对工具调用的位置 ────────────
  if (typeof hooks?.pairingBalancedAt === 'function') {
    let end = best.end
    while (end > best.start) {
      let ok = true
      try {
        ok = hooks.pairingBalancedAt(end) !== false
      } catch {
        ok = true // 判据读不到就不阻断，交给 runCompaction 的硬校验兜底
      }
      if (ok) break
      end -= 1
    }
    if (end <= best.start) return null
    return { start: best.start, end }
  }
  return best
}

/** 取引擎给的「这些表层 eventId 里哪些已覆盖」布尔数组；拿不到返回 null。 */
function resolveCoveredFlags(surface, hooks) {
  if (typeof hooks?.coveredFlags !== 'function') return null
  try {
    const f = hooks.coveredFlags(surface.map((ev) => ev?.eventId))
    return Array.isArray(f) && f.length === surface.length ? f : null
  } catch {
    return null
  }
}

/** 兜底：只用 coveredIds 集合构造「下标 → 是否已覆盖」判定器；没有就返回 null。 */
function resolveCoveredPredicate(hooks) {
  const covered = hooks?.coveredIds
  if (!covered || typeof covered.has !== 'function') return null
  const bare = (id) => (id.includes(':') ? id.slice(id.indexOf(':') + 1) : id)
  // 建一份裸 id 索引：之后每次判定都是 O(1)，不用反复切字符串。
  const bareSet = new Set()
  try {
    for (const id of covered) {
      if (typeof id === 'string' && id) bareSet.add(bare(id))
    }
  } catch {
    // 不可迭代就当空集：宁可退化成「都不算已覆盖」，也不要抛
  }
  const namespaces = Array.isArray(hooks?.namespaces) ? hooks.namespaces : []
  return (i, surfaceRef) => {
    const id = surfaceRef?.[i]?.eventId
    if (typeof id !== 'string' || !id) return false
    if (covered.has(id)) return true
    const b = bare(id)
    if (covered.has(b)) return true
    if (bareSet.has(b)) return true
    for (const ns of namespaces) {
      if (covered.has(ns + ':' + b)) return true
    }
    return false
  }
}


/** 收益估算：被压掉部分的字符减摘要预估（按 15% 估）。 */
export function estimateGain(surface, range) {
  let raw = 0
  for (const e of surface.slice(range.start, range.end)) {
    const t = e?.content ?? e?.text ?? ''
    raw += typeof t === 'string' ? t.length : JSON.stringify(t ?? '').length
  }
  return raw - Math.floor(raw * 0.15)
}
