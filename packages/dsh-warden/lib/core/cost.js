/**
 * dsh-warden · 用量折算金额（R11）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────
 * `host/usage.js` 的四桶（未缓存输入 / 缓存读 / 缓存写 / 输出）本来就有了，
 * 但它**只数 token，从不折算金额**，所以 warden 能告诉你"上下文多满"，
 * 却没法回答"这一会话花了多少钱、到没到预算"。护栏缺的正是后半句。
 *
 * 这个模块只做一件事：把四桶换成钱。它**不做**：
 *   - 不发请求、不查余额（那是 provider 的事，插件层没有凭据，也不该有）；
 *   - 不猜模型（拿不到模型名时用"未知档"并明确标 `estimated: true`）；
 *   - 不 kill 任何东西（只产出"到线了"的判断，由注入层决定怎么提醒）。
 *
 * ── 价目口径 ──────────────────────────────────────────────────────────
 * 默认价目来自 DeepSeek 官方价目页（2026-10-17 抓取
 * `https://api-docs.deepseek.com/quick_start/pricing`，`deepseek-flash` 列）：
 *
 *   1M 输入 token（缓存命中）  峰时 $0.006  谷时 $0.003
 *   1M 输入 token（缓存未命中）峰时 $0.3    谷时 $0.15
 *   1M 输出 token              峰时 $1.2    谷时 $0.6
 *
 * 峰时 = UTC 01:00–04:00 与 06:00–10:00，周一至周五，中国法定节假日除外；
 * 其余时间（含周末与节假日全天）按谷时。本模块**按 UTC 小时判峰谷**，
 * 不含节假日表 —— 所以节假日白天会被高估（保守，宁可早提醒）。
 *
 * 缓存写（cacheWrite）DeepSeek 不单独计价，按"未命中输入"计。
 *
 * ⚠ 价目会变。这里写死的是**默认值**，配置里 `costPrices` 可以整体覆盖；
 * 界面上显示金额时必须带上 `priceSource`，别把估算说成账单。
 */

/** 官方价目（USD / 1M token）。 */
export const PRICE_BOOK = Object.freeze({
  source: 'deepseek-pricing-2026-10-17',
  currency: 'USD',
  per: 1_000_000,
  /** 峰谷两套价。字段名与四桶一一对应。 */
  models: {
    'deepseek-flash': {
      cacheRead: { peak: 0.006, offPeak: 0.003 },
      cacheMiss: { peak: 0.3, offPeak: 0.15 },
      output: { peak: 1.2, offPeak: 0.6 },
    },
    'deepseek-v4-pro': {
      cacheRead: { peak: 0.044, offPeak: 0.022 },
      cacheMiss: { peak: 1.32, offPeak: 0.66 },
      output: { peak: 3.96, offPeak: 1.98 },
    },
  },
  /** 认不出模型时用的档：按 flash 的价，并标 `estimated`。 */
  fallbackModel: 'deepseek-flash',
})

/** UTC 峰时窗口（小时，左闭右开）。 */
const PEAK_UTC_WINDOWS = [[1, 4], [6, 10]]

/**
 * 现在是不是峰时。
 *
 * 只按 UTC 小时 + 周几判，**不含中国法定节假日表** —— 节假日白天会被
 * 当成峰时（高估），这是有意的保守方向：宁可早提醒，不要漏提醒。
 *
 * @param {number} atMs
 * @returns {boolean}
 */
export function isPeakHour(atMs) {
  const d = new Date(atMs)
  const day = d.getUTCDay() // 0=周日 6=周六
  if (day === 0 || day === 6) return false
  const hour = d.getUTCHours()
  return PEAK_UTC_WINDOWS.some(([from, to]) => hour >= from && hour < to)
}

/**
 * 归一化一个模型名到价目表的键。
 *
 * 用户/宿主给的可能是 `deepseek-v4.1-flash`、`provider/deepseek-v4.1-flash`、
 * `DeepSeek-Flash` 这些形态。这里只做"包含关系"匹配，认不出就返回 null，
 * **不硬猜**。
 */
export function priceKeyOf(model) {
  const raw = String(model ?? '').toLowerCase()
  if (!raw) return null
  if (raw.includes('v4-pro') || raw.includes('v4pro')) return 'deepseek-v4-pro'
  if (raw.includes('flash')) return 'deepseek-flash'
  return null
}

/**
 * 四桶 → 金额。
 *
 * @param {object|null} buckets `{uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens}`
 * @param {{atMs?: number, model?: string|null, prices?: object}} [options]
 * @returns {{known: boolean, usd: number|null, currency: string, peak: boolean,
 *            model: string|null, estimated: boolean, breakdown: object|null}}
 */
export function costOfBuckets(buckets, options = {}) {
  const unknown = {
    known: false, usd: null, currency: PRICE_BOOK.currency, peak: false,
    model: null, estimated: false, breakdown: null,
  }
  if (!buckets || typeof buckets !== 'object') return unknown

  const atMs = Number.isFinite(options.atMs) ? options.atMs : Date.now()
  const peak = isPeakHour(atMs)
  const priceKey = priceKeyOf(options.model)
  const table = options.prices?.models ?? PRICE_BOOK.models
  const effectiveKey = priceKey ?? PRICE_BOOK.fallbackModel
  const modelPrices = table[effectiveKey]
  if (!modelPrices) return unknown

  const phase = peak ? 'peak' : 'offPeak'
  const rate = (name) => {
    const entry = modelPrices[name]
    const value = entry?.[phase]
    return Number.isFinite(value) ? value : 0
  }

  const uncached = Math.max(0, Number(buckets.uncachedInputTokens) || 0)
  const cacheRead = Math.max(0, Number(buckets.cacheReadTokens) || 0)
  const cacheWrite = Math.max(0, Number(buckets.cacheWriteTokens) || 0)
  const output = Math.max(0, Number(buckets.outputTokens) || 0)
  if (uncached + cacheRead + cacheWrite + output === 0) {
    return { ...unknown, known: true, usd: 0, peak, model: priceKey, estimated: priceKey === null, breakdown: {
      cacheMissInput: 0, cacheReadInput: 0, cacheWriteInput: 0, output: 0,
    } }
  }

  // 缓存写不单独计价：按未命中输入价计入。
  const missRate = rate('cacheMiss')
  const parts = {
    cacheMissInput: uncached * missRate,
    cacheReadInput: cacheRead * rate('cacheRead'),
    cacheWriteInput: cacheWrite * missRate,
    output: output * rate('output'),
  }
  const usd = (parts.cacheMissInput + parts.cacheReadInput + parts.cacheWriteInput + parts.output) / PRICE_BOOK.per

  return {
    known: true,
    usd,
    currency: PRICE_BOOK.currency,
    peak,
    model: priceKey,
    /** 认不出模型 → 按 flash 价估算，必须显示成"估算"而不是账单。 */
    estimated: priceKey === null,
    breakdown: parts,
  }
}

/**
 * 预算闸门：累计金额到没到线。
 *
 * **只算"到线没有"，不 kill、不阻断。** 接不接、怎么提醒由调用方定。
 *
 * @param {object} input
 * @param {number} input.usd 本会话累计金额（USD）
 * @param {number} input.budgetUsd 预算（USD）；<=0 表示不设预算
 * @param {number} [input.warnRatio] 提前预警比例（0~1）
 * @returns {{configured: boolean, exceeded: boolean, warn: boolean, ratio: number|null, remainingUsd: number|null}}
 */
export function budgetGate({ usd, budgetUsd, warnRatio = 0.8 }) {
  const budget = Number(budgetUsd)
  const spent = Number(usd)
  if (!Number.isFinite(budget) || budget <= 0) {
    return { configured: false, exceeded: false, warn: false, ratio: null, remainingUsd: null }
  }
  if (!Number.isFinite(spent) || spent < 0) {
    return { configured: true, exceeded: false, warn: false, ratio: null, remainingUsd: budget }
  }
  const ratio = spent / budget
  const clampWarn = Number.isFinite(warnRatio) ? Math.min(0.99, Math.max(0.1, warnRatio)) : 0.8
  return {
    configured: true,
    exceeded: ratio >= 1,
    warn: ratio >= clampWarn && ratio < 1,
    ratio,
    remainingUsd: Math.max(0, budget - spent),
  }
}

/**
 * 按工具分账（P2-5）。**纯函数：只读入参，不碰钩子、不加数据源。**
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * `budgetGate` 只吃**会话累计**，它能回答「这一跑变贵了」，回答不了
 * 「**哪一部分**变贵了」。生态里 agent-guard 的原话就是这个缺口：
 * 一个工具在重试风暴里就能吃光整个额度，而会话级阈值只能事后告诉你总数。
 * `StepTable` 早就把每步的工具名记下来了（`recordTool`），金额也早就算得出来
 * （`costOfBuckets`）—— 缺的只是**把两者按步对上再按工具归拢**。所以这里
 * 不新增任何采集，只做一次分组求和。
 *
 * ── 分账口径（三条，写进返回值里，别让调用方猜）──────────────────────────
 *   1. **一步一个工具**：同一步若记了多个工具名，该步的金额**均分**到这些
 *      工具上（`sharedSteps` 说明有几步是这么分的）。原因：usage 按
 *      (turn, step) 上报，同一 step 里先后调了 read 和 edit 时，账本无法区分
 *      各自花了多少。均分是**唯一不丢钱也不重复计**的确定性做法 —— 任意加权
 *      的总和都会偏离总量。
 *   2. **没有工具名的步**（纯模型推理、或 tool/call 事件没到）：归到
 *      `__unattributed__`，并且**仍然计入总额**。不丢钱是硬要求。
 *   3. **峰谷价**沿用 `costOfBuckets` 的同一口径（UTC 小时，不含节假日表），
 *      不在这里另发明一套；每步用它**自己的时间戳**，只有该步没有时间时才回退
 *      到会话级时间。
 *
 * ── 守恒律（这是分账唯一的正确性保险）──────────────────────────────────
 *   所有工具金额之和 === 各步金额之和 === `costFromLedger` 的总和。
 *   只要对不上，就是丢钱或重复计，必须当成 bug。`conserved` 字段会当场核对。
 *
 * ⚠ **只读展示，不做硬闸。** 本函数不返回任何 deny/block 语义，插件也不会
 *   因为「某个工具贵」去拦工具 —— 生态里也没人做到硬阻，而误拦一次工具比
 *   多花几毛钱贵得多。
 *
 * ⚠ 口径：来源是**本进程启动后的内存账本**，按会话累计，**无法按日切分**。
 *   与 `costFromLedger` 同一口径（评审要求：不要自己另立一套）。
 *
 * @param {Array<object>} entries `StepTable.entries()` 的快照
 * @param {{atMs?: number, model?: string|null, prices?: object, sessionTotals?: object}} [stepTable]
 *        折价上下文（与 `topSteps` 的同名参数语义一致）。`sessionTotals` 若给
 *        （四桶），用于核对守恒并在返回值里给出 `conserved`。
 * @returns {{known: boolean, reason?: string, tools: Array<object>,
 *            totalUsd: number|null, unattributedUsd: number|null,
 *            unattributedTokens: number, unpricedSteps: number, conserved: object|null,
 *            basis: string, note: string}}
 */
export function costByTool(entries, stepTable = {}) {
  const basis = 'in-memory-ledger'
  const note = '内存账本按会话累计，只覆盖本进程启动后观察到的会话；无法按日切分，也不是官方账单。'
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : []
  if (list.length === 0) {
    // 没有步 = 没有可归因的钱。**返回 null 而不是 $0**（没统计不等于没花钱）。
    return {
      known: false,
      reason: '没有可用于归因的步骤记录（StepTable 里还没有收到过 usage 的步）',
      tools: [],
      totalUsd: null,
      unattributedUsd: null,
      unattributedTokens: 0,
      unpricedSteps: 0,
      conserved: null,
      basis,
      note,
    }
  }

  const ctx = stepTable && typeof stepTable === 'object' ? stepTable : {}
  const fallbackAt = Number.isFinite(ctx.atMs) ? ctx.atMs : 0
  const rows = new Map()
  let unpricedSteps = 0

  const bump = (name, usd, tokens, extra) => {
    let row = rows.get(name)
    if (!row) {
      row = {
        tool: name, usd: 0, tokens: 0, steps: 0,
        /** 有多少步的金额是跟别的工具均分的（说不清就标出来）。 */
        sharedSteps: 0,
        /** 该工具金额是否**完全**精确（false = 至少一部分是均分/未定价）。 */
        attributed: true,
      }
      rows.set(name, row)
    }
    row.usd += usd
    row.tokens += tokens
    row.steps += 1
    if (extra && extra.shared) row.sharedSteps += 1
    if (extra && extra.unpriced) row.attributed = false
    return row
  }

  for (const entry of list) {
    // 没有 usage 的步不进分账：没收到上报就没有金额可归，拿 0 顶上等于假装知道成本。
    if (entry.usageSeen === false) continue
    const buckets = entry.tokensBuckets
    if (!buckets || typeof buckets !== 'object') continue
    const tokens = (Number(buckets.uncachedInputTokens) || 0)
      + (Number(buckets.cacheReadTokens) || 0)
      + (Number(buckets.cacheWriteTokens) || 0)
      + (Number(buckets.outputTokens) || 0)

    const atMs = Number.isFinite(entry.at) && entry.at > 0 ? entry.at : fallbackAt
    const cost = costOfBuckets(buckets, {
      atMs: atMs > 0 ? atMs : undefined,
      model: entry.model ?? ctx.model ?? null,
      prices: ctx.prices,
    })
    const priced = cost && cost.known === true && Number.isFinite(cost.usd)
    const usd = priced ? cost.usd : 0
    if (!priced) unpricedSteps++

    const tools = Array.isArray(entry.tools)
      ? entry.tools.filter((name) => typeof name === 'string' && name.trim().length > 0)
      : []
    if (tools.length === 0) {
      // 规则 2：没有工具名 → 未归因，但**金额照计**（不丢钱）。
      bump(UNATTRIBUTED_TOOL, usd, tokens, { unpriced: !priced })
      continue
    }
    // 规则 1：一步多个工具 → 均分。均分保证各工具之和精确等于该步金额。
    const share = usd / tools.length
    for (const name of tools) {
      bump(name, share, tokens / tools.length, { shared: tools.length > 1, unpriced: !priced })
    }
  }

  const unattributed = rows.get(UNATTRIBUTED_TOOL)
  const tools = [...rows.values()]
    .map((row) => ({
      ...row,
      /** 均分/未定价的金额要能被界面标成估算，别把分摊说成实测。 */
      estimated: row.attributed === false || row.sharedSteps > 0,
    }))
    // 金额降序，同额按 tokens、再按名字 —— 稳定可断言，不依赖 Map 插入顺序。
    .sort((a, b) => (b.usd - a.usd) || (b.tokens - a.tokens) || a.tool.localeCompare(b.tool))

  const totalUsd = tools.reduce((sum, row) => sum + row.usd, 0)

  // 守恒核对：给了会话四桶就当场比一次，对不上要能被调用方看见（而不是静默）。
  let conserved = null
  if (ctx.sessionTotals && typeof ctx.sessionTotals === 'object') {
    const expected = costOfBuckets(ctx.sessionTotals, {
      atMs: fallbackAt > 0 ? fallbackAt : undefined,
      model: ctx.model ?? null,
      prices: ctx.prices,
    })
    if (expected && expected.known === true && Number.isFinite(expected.usd)) {
      const delta = Math.abs(totalUsd - expected.usd)
      conserved = { expectedUsd: expected.usd, deltaUsd: delta, ok: delta <= 1e-9 }
    }
  }

  return {
    known: true,
    tools,
    totalUsd,
    unattributedUsd: unattributed ? unattributed.usd : 0,
    unattributedTokens: unattributed ? unattributed.tokens : 0,
    /** 有多少步拿不到价目（金额按 0 计）—— 不让它静默变成「便宜」。 */
    unpricedSteps,
    conserved,
    basis,
    note,
  }
}

/** 未归因工具名：界面/测试要用同一个字面量，别各自写字符串。 */
export const UNATTRIBUTED_TOOL = '__unattributed__'
/** 金额显示：小额用 4 位，大额用 2 位。**所有展示都走这个函数**，避免各处小数不一致。 */
export function formatMoney(usd) {
  const value = Number(usd)
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

/** 预算提醒正文。只在"到线"时发一次，由 inject.js 记录已发状态。 */
export function budgetText({ usd, gate, model, estimated, peak }) {
  const parts = [
    `[warden] 本会话累计花费 **${formatMoney(usd)}**`,
    gate?.ratio !== null && gate?.ratio !== undefined ? `（预算的 ${Math.round(gate.ratio * 100)}%）` : '',
    gate?.exceeded ? '，**已到预算线**。' : '，接近预算线。',
  ]
  const lines = [parts.join('')]
  lines.push('这**不是**停止指令 —— 护栏不会替你砍掉请求。要不要继续由你判断，但请先做一件事：')
  lines.push('  ① 把当前进展和已确认的结论写进文件（别只留在上下文里）；')
  lines.push('  ② 如果还要继续，说明为什么这笔钱必须花；如果不继续，留一份能接手的交接。')
  if (estimated) lines.push('（金额是按 flash 价目估算的：拿不到模型名，可能有偏差。）')
  else if (peak) lines.push('（当前是峰时，单价是谷时的 2 倍。）')
  return lines.join('\n')
}