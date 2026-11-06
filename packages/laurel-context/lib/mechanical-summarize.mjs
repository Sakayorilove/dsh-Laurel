/**
 * laurel-context/mechanical-summarize —— 不接模型的压缩路线（D136）。
 *
 * ── 为什么必须有这条路 ──────────────────────────────────────────────────
 * README 第 72 行早就写了「摘要按需生成，没接模型时只做机械摘要（首尾截取 +
 * 结构标记）」，但**代码里从来没有这个实现**：`host-compaction.mjs` 的
 * summarizer 只有一条路 —— 走 gateway，而 gateway 在零推理档恒为
 * `{enabled:false}`（`TIER_LIMITS.zero.maxRequestsPerDay = 0`）。
 *
 * 后果是致命的，而且只在"接管成功之后"才发生：
 *   1. Laurel 用 `ctx.provide('compaction', provider)` 把宿主的 compaction-basic
 *      挤掉（或改组合层把它换掉）；
 *   2. 宿主此后每次 `compactIfNeeded` 都问到 Laurel；
 *   3. Laurel 拿不到摘要器 → 返回 `null`；
 *   4. 宿主按契约理解 `null` = "这次没什么可压" → 不再尝试任何压缩；
 *   5. 于是**接管把一个本来能工作的压缩器换成了什么都不做的空壳**，
 *      上下文只涨不降，长会话最终撑爆。
 *
 * 所以机械摘要不是"降级体验"，是接管的**前置条件**：没有它就不该接管。
 *
 * ── 它做什么 ────────────────────────────────────────────────────────────
 * 不调用任何模型，纯字符串处理，结果确定（同样的输入永远同样的输出，
 * 便于测试与复现）：
 *   - 受保护项（目标/限制/错误等）**逐条原文保留**，放在最前面；
 *   - 每条事件按"首部 + 尾部"截取，中间用显式标记说明省略了多少字符；
 *   - 工具结果单独更狠地压缩（它们通常是最大头，且可回取原文）；
 *   - 保留每条的角色与序号，便于回溯。
 *
 * 纪律：**宁可压得少，不可把限制条件压丢**。受保护项丢失一律由
 * `summary-protocol.mjs` 的 validateSummary 拒收，不靠"模型自觉"。
 */

import { extractProtected, guardSummary } from './guard.mjs'
import {
  PROTECTED_KINDS,
  filterResolvableRefs,
  findRefsInText,
  makeSummaryCandidate,
  publishSummary,
  resolveAbsoluteSlice,
} from './summary-protocol.mjs'

/** 每条普通消息保留的首/尾字符数（中英文混合场景下的经验值）。 */
const HEAD_CHARS = 240
const TAIL_CHARS = 120
/** 工具结果更狠：只留首尾，且总额更小。 */
const TOOL_HEAD_CHARS = 180
const TOOL_TAIL_CHARS = 80
/** 摘要正文总上限（与 summary-protocol 的 MAX_SUMMARY_CHARS 一致）。 */
const MAX_TOTAL_CHARS = 20_000
/** 目标压缩比：摘要正文不超过原文的这个比例（留出余量，别把预算卡满）。 */
const TARGET_RATIO = 0.28
/** 再省也要给每条留的最小额度 —— 低于这个数摘要就没信息量了。 */
const MIN_PER_EVENT = 60
/** 预算下限：原文再短也要有点内容，但不能大到超过原文（见下面的 no-gain 兜底）。 */
const MIN_BUDGET = 200

/**
 * 把一段文本压成"首 + 省略标记 + 尾"。
 * 短文本原样返回 —— 不要为了统一而给短消息加噪音。
 */
/**
 * 截取首尾，中间留省略标记。
 *
 * 【S5-3】`ref` 参数是**可选且必须先验活**的：只有调用方确认能取回的引用才传进来。
 * 以前这里无条件写「原文可在核心仓按引用回取」，而摘要里根本没有任何 ref
 * （`summarizeMechanically` 硬编码 `refs: []`）—— 那句话是假的，
 * 用户照着找会发现无据可查。现在：有 ref 才写 ref，没 ref 就只说省略了多少字。
 */
export function clipMiddle(text, head = HEAD_CHARS, tail = TAIL_CHARS, ref = null) {
  const s = String(text ?? '')
  // 余量从 40 降到 8：40 会让"每条 60 字额度"永远命中原样返回分支，
  // 于是短消息完全不受预算约束 —— 这是 A5/E 两条守卫最初失败的原因。
  if (s.length <= head + tail + 8) return s
  const omitted = s.length - head - tail
  const note = ref ? `此处省略 ${omitted} 字符，原文凭 ${ref} 回取` : `此处省略 ${omitted} 字符`
  return `${s.slice(0, head)}\n…〔${note}〕…\n${s.slice(-tail)}`
}

/**
 * 机械摘要。
 *
 * ── 预算从哪来（D136 的第二半） ────────────────────────────────────────
 * 第一版只做了"逐条首尾截取"，而 `clipMiddle` 对短文本原样返回。
 * 于是 21 条各 40 字的短消息"压缩"完还是 840 字 —— 换掉 21 条表层事件，
 * 得到 1 条同样大的消息，**一个字都没省**。这不是压缩，只是搬家。
 *
 * 现在按原文体量算预算：目标 `原文 * TARGET_RATIO`，再按条数均摊，
 * 每条至少留 MIN_PER_EVENT。最后再兜一次底：**输出不得大于输入**，
 * 否则宁可不压（返回 ok:false / reason:'no-gain'），让上层照常返回 null，
 * 而不是把会话替换成一条更大的"摘要"。
 *
 * ── S4/S5：这一版补的四道闸 ─────────────────────────────────────────────
 *  1. **只切一次**（S4）：切片交给 `resolveAbsoluteSlice`，与模型路线同一个函数。
 *     收到的 `slice` 字段一律忽略（向后兼容老调用方），`inputChars` 一律
 *     按绝对 range 的真实字符数算 —— 以前按"传进来的片段"算，于是
 *     `compaction-provider` 先 slice 再传绝对 range 时，`start=5` 的场景
 *     拿 165 字符去冒充 198 字符（MC06）。
 *  2. **受保护项自动提取**（S5-1）：调用方没传的，本函数自己从原文里抽
 *     （必须/不许/禁止/不得/绝不能… + 具体动作）。以前 `protectedItems`
 *     只有调用方手填那一条路，而 `journal.protectedItems()` 默认是空数组 ——
 *     于是"禁止在生产环境执行 drop database"整句**从来没进过任何集合**。
 *  3. **发布前过 guard + publishSummary**（S5-2）：先 `guardSummary` 判加权丢失，
 *     再 `publishSummary` 走协议校验。任一不过就 `ok:false`，让上层保留原文。
 *  4. **ref 先验后写**（S5-3）：只登记**当场能取回**的 ref；取不回的不写进摘要。
 *
 * @param {object} args
 * @param {Array<{role?:string, text?:string, kind?:string}>} args.events 全量事件（**不要预先 slice**）
 * @param {{start:number, end:number}} args.range 要压的位置区间（左闭右开，绝对坐标）
 * @param {Array<{kind:string, value:string}|string>} [args.protectedItems] 调用方额外声明的受保护项
 * @param {string} [args.level] 层级标签
 * @param {number} [args.sourceRevision] 源版本，缺省取 0（publishSummary 要求非负整数）
 * @param {Function} [args.verifyRef] ref 验活：入参 ref，返回 true 表示能取回
 * @param {object} [args.engine] 有引擎时用它提交（走 _commitSummary 的原子路径）
 * @param {object} [args.guardPolicy] 只许**收紧**：阈值只能调低，critical 恒零容忍
 * @returns {{ok:true, text:string, refs:Array, mechanical:true, chars:number, inputChars:number, protectedItems:Array, guard:object}}
 *          或 {ok:false, reason:'no-gain'|'empty'|'bad-range'|'range-beyond-events'|'guard-reject'|'protocol-reject'|'no-gain-after-protect', ...}
 */
export function summarizeMechanically({
  events = [],
  range,
  protectedItems = [],
  level = 'T1',
  sourceRevision,
  verifyRef,
  engine,
  guardPolicy,
  // 老调用方可能还传着 slice（先自己切过的片段）。**故意只接住不使用**：
  // 切片口径只能有一个来源，见 resolveAbsoluteSlice 的说明。
  slice: incomingSlice,
} = {}) {
  // ① 只在这里切一次。老调用方传的 slice 字段被忽略（不报错，向后兼容）。
  const resolved = resolveAbsoluteSlice({ events, range, slice: incomingSlice })
  if (!resolved.ok) {
    return {
      ok: false,
      reason: resolved.reason,
      inputChars: resolved.inputChars,
      outputChars: 0,
      mechanical: true,
      events: resolved.events,
      hint: resolved.hint,
      ignoredSlice: resolved.ignoredSlice,
    }
  }
  const { slice, start, end, inputChars, textOf } = resolved

  // ② 受保护项 = 调用方声明的 ∪ 本函数自动抽到的。
  // 自动提取是 S5 的核心：以前只有"调用方手填"这一条路，而真实调用方
  // （journal.protectedItems()）默认返回空数组 —— 等于从来没人保护过任何东西。
  const rawText = slice.map((ev) => textOf(ev)).join('\n')
  const autoItems = extractProtected(rawText, { limit: 80 })
  const merged = mergeProtectedItems(protectedItems, autoItems)

  // 受保护项不计入预算：它们必须原样留下，压缩比由其余部分承担。
  const protectedChars = merged.reduce((n, p) => n + String(p.value ?? '').length + 24, 0)
  const targetTotal = Math.max(
    MIN_BUDGET,
    Math.min(MAX_TOTAL_CHARS, Math.floor(inputChars * TARGET_RATIO)),
  )
  const budget = Math.max(MIN_PER_EVENT * slice.length, targetTotal - protectedChars)
  const perEvent = Math.max(MIN_PER_EVENT, Math.floor(budget / slice.length))

  // ③ ref 先验后写（S5-3），**在写正文之前**算。
  // 以前这里硬编码 `refs: []`，而正文的省略标记写着"原文可在核心仓按引用回取" ——
  // 一个 ref 都没有，用户照着找必然无据可查（MC04）。现在：
  //   - 收集形状合法的 ref（正文里提到的事件 ref + 片段自带的事件 ref）；
  //   - 逐个问 verifyRef 能不能真的取回，取不回的一律不登记；
  //   - 每条事件只有 ref 通过验活，才在**它自己**的省略标记里写出 ref。
  // 宁可少给引用，绝不给假引用。
  // ③ ref 先验后写（S5-3），**在写正文之前**算。
  // 以前这里硬编码 `refs: []`，而正文的省略标记写着"原文可在核心仓按引用回取" ——
  // 一个 ref 都没有，用户照着找必然无据可查（MC04）。
  //
  // 【预算】ref 不是越多越好。真实会话实测（`ref-budget-probe.sh`）：
  //   318 个外置原文的 ref 一次性塞进来，末尾清单 21K 字符 > 整条摘要上限 20000
  //   → `bodyLimit` 被压成 0 → 正文只剩一个截断标记 → 受保护项全丢 → guard-reject。
  // 每个 inline ref 还要在省略标记里占 86 字符，318 个 = 27K，单这一项就超上限。
  // 所以两条限制：
  //   · inline ref 只给**省略最多**的前 MAX_REFS_INLINE 个（省 30 字符的不值得占 86 字符）；
  //   · 末尾清单按剩余额度截，超出的明写"另有 N 条在片段内联标记里"（不假装全列了）。
  // 一条 60K 的工具结果值得回读；把 318 条全列出来模型一条也用不上，
  // 那不是"可回取"，是把摘要变成索引页。
  const MAX_REFS_INLINE = 24
  const MAX_REFS_LIST = 24
  const REF_LINE_CHARS = 70
  const SNIPPET_FLOOR = 4_000
  const refPool = []
  for (let k = 0; k < slice.length; k += 1) {
    const own = slice[k]?.ref ? String(slice[k].ref) : null
    if (!own) continue
    refPool.push({ i: k, ref: own, omitted: Math.max(0, String(textOf(slice[k]) ?? '').length - MIN_PER_EVENT) })
  }
  refPool.sort((a, b) => b.omitted - a.omitted)
  const eventRefs = new Map()   // 事件下标 → 已验活的 ref
  for (const c of refPool.slice(0, MAX_REFS_INLINE)) {
    const { refs: okRefs } = filterResolvableRefs({ refs: [c.ref], verifyRef })
    if (okRefs.length) eventRefs.set(c.i, okRefs[0])
  }
  const candidateRefs = [...new Set([
    ...findRefsInText(rawText),
    ...eventRefs.values(),
  ])]
  const { refs: verifiedRefs, dropped: droppedRefs } = filterResolvableRefs({ refs: candidateRefs, verifyRef })

  // 头 + 受保护项。**受保护项不做任何截断**：它们压丢了就等于没压（守门器会直接拒）。
  const headLines = []
  headLines.push(`〔机械摘要 · ${level} · 事件 ${start}..${end - 1} · 共 ${slice.length} 条 · 未使用模型〕`)
  if (merged.length) {
    headLines.push('')
    headLines.push('必须保留的条目（原文）：')
    for (const p of merged) headLines.push(`- (${p.kind}) ${p.value}`)
  }
  const headText = headLines.join('\n')

  // 片段正文
  const snippetLines = []
  snippetLines.push('')
  snippetLines.push('会话片段（首尾保留，中间省略）：')
  for (let k = 0; k < slice.length; k += 1) {
    const ev = slice[k]
    const idx = start + k
    const role = ev.role ?? (ev.kind === 'tool' ? 'tool' : 'event')
    const isTool = ev.kind === 'tool' || role === 'tool'
    const raw = textOf(ev)
    // 额度按 perEvent 均摊；工具结果天然更短，给它打 0.7 折，省下的给正文
    const cap = isTool ? Math.max(MIN_PER_EVENT, Math.floor(perEvent * 0.7)) : perEvent
    const head = Math.max(20, Math.floor(cap * 0.66))
    const tail = Math.max(10, cap - head)
    const body = clipMiddle(raw, head, tail, eventRefs.get(k) ?? null)
    snippetLines.push(`[${idx}] ${role}: ${body}`)
  }
  const snippetText = snippetLines.join('\n')

  // ref 清单：按**剩余额度**截（先保证受保护项与一段正文）。
  // 这样 ref 清单永远挤不掉受保护项 —— 那是守门器的硬要求。
  const refsBudget = Math.max(0, MAX_TOTAL_CHARS - headText.length - SNIPPET_FLOOR)
  const listMax = Math.min(MAX_REFS_LIST, Math.floor(refsBudget / REF_LINE_CHARS))
  const refs = verifiedRefs.slice(0, listMax)
  const refsOmitted = verifiedRefs.length - refs.length
  let refsSection = refs.length ? `\n\n可回取的原文引用：\n${refs.map((r) => `- ${r}`).join('\n')}` : ''
  if (refsOmitted > 0) refsSection += `\n（另有 ${refsOmitted} 条引用写在各片段的省略标记里，未在此重复列出）`

  // 【必修，否则压缩永远落不了盘】上限必须连 ref 清单与截断标记一起算。
  //
  // 以前是「先切满 MAX_TOTAL_CHARS，再拼 '\n…〔机械摘要超长，已截断〕'」，
  // 而且 ref 清单是在截断**之后**追加的 —— 两条路都让正文最终**超过**协议上限：
  // 实测 20014 > 20000，validateSummary 判 invalid，上层把它记成
  // `protocol-reject`，整条摘要被丢弃，宿主看到"压了但没存"，
  // 端点永远 summaries:0 / compactions:0。现在先留出 ref 清单与标记的长度再切，
  // 保证 `text.length <= MAX_TOTAL_CHARS` 恒成立。
  const marker = '\n…〔机械摘要超长，已截断〕'
  const bodyLimit = Math.max(0, MAX_TOTAL_CHARS - refsSection.length)
  let text = `${headText}${snippetText}`
  if (text.length > bodyLimit) {
    text = `${text.slice(0, Math.max(0, bodyLimit - marker.length))}${marker}`
  }
  text += refsSection
  // ref 清单必须与「正文里真的写了 ref」一致：列出却没写进正文等于给假引用。
  const listedRefs = [...new Set([...refs, ...eventRefs.values()])]

  // 兜底：压完反而更大就不算压。上层据此返回 null（宿主会理解为"没什么可压"），
  // 绝不会拿一条更大的消息替换掉真实历史。
  // 【顺序】这条必须在追加 ref 之后：ref 清单本身会让正文变长，
  // 先判后加就能产出一条"通过了收益检查、但其实比原文更大"的摘要。
  if (text.length >= inputChars) {
    return { ok: false, reason: 'no-gain', inputChars, outputChars: text.length, mechanical: true }
  }

  // ④ 发布前过守门（S5-2）。这是"缺了就等于没压"的那道闸：
  // 以前的机械摘要把受保护项抄进正文就完事，**没人检查抄漏了没有**。
  const policy = resolveGuardPolicy(guardPolicy)
  const guard = guardSummary({ original: rawText, summary: text, policy, protectedItems: merged })
  if (!guard.ok) {
    return {
      ok: false,
      reason: 'guard-reject',
      inputChars,
      outputChars: text.length,
      mechanical: true,
      guard,
      missing: guard.missing,
      advice: guard.advice,
    }
  }

  // ⑤ 过协议校验 + 发布。engine 在时走 _commitSummary 的原子路径
  // （校验→锁→单次 vault.commit）；没引擎时只能做协议校验，
  // publishSummary 会明确回 no-store —— 我们照实报 published:false，
  // 不假装已经写进日志。
  // 【坐标系】把切片里的事件身份一并交出去，让引擎按身份判重叠。
  // 切片用的是**表层**坐标，引擎的下标是另一套；只有 eventId 两边一致。
  const coveredIds = slice.map((ev) => ev?.eventId).filter((id) => typeof id === 'string' && id)
  const candidate = makeSummaryCandidate({
    range: { start, end },
    sourceRevision: Number.isInteger(sourceRevision) ? sourceRevision : 0,
    text,
    level,
    refs,
    protectedItems: merged,
    coveredIds,
  })
  const published = publishSummary(candidate, { engine, protectedItems: merged })
  const publishGate = published.ok ? 'published' : (published.reason === 'no-store' ? 'protocol-only' : published.reason)
  if (published.ok === false && published.reason !== 'no-store') {
    return {
      ok: false,
      reason: 'protocol-reject',
      inputChars,
      outputChars: text.length,
      mechanical: true,
      guard,
      candidate,
      published,
      problems: published.problems ?? [published.reason],
    }
  }

  return {
    ok: true,
    text,
    refs,
    droppedRefs,
    mechanical: true,
    chars: text.length,
    inputChars,
    // 落盘后的摘要块 id（没落盘就是 null）。上层据此区分
    // 「压了并存进 journal」与「压了但只在内存里」，不要靠猜。
    publishedId: published.ok === true ? (published.id ?? candidate.id ?? null) : null,
    protectedItems: merged,
    // 自动抽到的条目**原样给出**（不只是计数）：调用方与日志要能回答
    // "这条禁令是谁保护起来的" —— 只看一个数字，无法判断是调用方声明的还是自动抽的。
    autoProtected: autoItems,
    guard,
    candidate,
    publishGate,
    published: published.ok === true,
    // 自证"收到了老调用方的 slice 字段但没用它"，方便排查双切片回潮
    ignoredSlice: resolved.ignoredSlice,
  }
}

/**
 * 守门策略只许**收紧**（这是配置契约，不是口味问题）。
 *
 * `cordis.patch.yml` 写的是 maxWeightedLoss:0.35 / allowCriticalLoss:false。
 * 摘要器内部绝不允许把它调松：阈值只能比 0.35 更低，
 * `allowCriticalLoss` 无论调用方传什么都恒为 false ——
 * 「丢了禁止事项也放行」这件事不该由一次函数调用决定。
 */
export const MAX_ALLOWED_WEIGHTED_LOSS = 0.35

export function resolveGuardPolicy(requested) {
  const raw = Number(requested?.maxWeightedLoss)
  const maxWeightedLoss = Number.isFinite(raw) && raw >= 0
    ? Math.min(raw, MAX_ALLOWED_WEIGHTED_LOSS)
    : MAX_ALLOWED_WEIGHTED_LOSS
  return { maxWeightedLoss, allowCriticalLoss: false }
}

/**
 * 合并受保护项：调用方声明的在前（人工判断优先），自动抽取的补在后面。
 * 未知类别**丢弃并记账**而不是抛错 —— 协议层对未知类别抛 TypeError 是对的
 * （那是"有人写错了契约"），但摘要器不该因为一条拼错的 kind
 * 就把整次压缩炸掉：丢掉这条 + 报出来，其余照压。
 */
export function mergeProtectedItems(declared = [], auto = []) {
  const out = []
  const seen = new Set()
  const dropped = []
  for (const raw of [...(declared ?? []), ...(auto ?? [])]) {
    if (raw == null) continue
    const kind = typeof raw === 'string' ? 'goal' : (raw.kind ?? 'goal')
    const value = typeof raw === 'string' ? raw : raw.value
    if (typeof value !== 'string' || !value.trim()) continue
    if (!PROTECTED_KINDS.includes(kind)) { dropped.push({ kind, value: String(value).slice(0, 60) }); continue }
    const key = kind + '|' + value.trim().slice(0, 50)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, value: value.trim().slice(0, 160) })
  }
  return Object.assign(out, { dropped })
}
