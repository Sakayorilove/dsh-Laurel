/**
 * laurel-context/summary-protocol —— T1/T2/T3 摘要协议（机械校验，不含模型调用）。
 *
 * 纪律（对应 04 规格 3.4 / B7）：
 *  1. 候选必须绑定**固定 source revision**；源变化后的迟到结果一律不提交。
 *  2. 摘要非空、长度有界、范围合法；不满足直接拒绝，不"尽量写进去"。
 *  3. 受保护项（当前目标/禁止事项/未完成项/关键精确值/活跃错误）必须逐条出现在文本里；
 *     缺失就拒绝 —— 关键词校验只能证明"没漏掉这些"，不能证明语义正确。
 *  4. 提交是原子的：先写权威日志，成功后才更新内存/派生状态；重复 id、范围重叠都不提交。
 *  5. 本模块不 import 任何 DSH/Cordis 代码，也不调用模型。
 */
import { contentHash } from '../../laurel-core/lib/format.mjs'

export const SUMMARY_LEVELS = Object.freeze(['T1', 'T2', 'T3'])
/**
 * 受保护项类别（唯一来源，guard.mjs 从这里取，不再手写第二份）。
 *
 * 【S5】补 `constraint`：调用方**一直在用**这个写法 ——
 * `makeHostProvider({protectedItems})`、配置里的 protectedItems、以及
 * `mechanical-summarize.test.mjs` 的真实用例都写 `{kind:'constraint',value:'不许删任何文件'}`。
 * 而协议层只认 6 类，`normalizeProtectedItems` 对未知类别直接抛 TypeError：
 * 一条"不许删文件"的约束连**被计数**的资格都没有，直接让整次提交炸掉。
 * 收进白名单是**收紧**（它进分母，且与 forbidden 同权，丢了就拒），不是放宽。
 */
export const PROTECTED_KINDS = Object.freeze(['goal', 'forbidden', 'todo', 'exact', 'error', 'decision', 'constraint'])
export const MAX_SUMMARY_CHARS = 20_000
/** 仓内引用的形状（真伪只能靠仓读取验证，形状校验不能代替验活）。 */
const REF_SHAPED = /^ctx:\/\/blob\/[0-9a-f]{64}$/

/** 字符串是否是"合约形状"的仓内引用。 */
export function isRefShaped(ref) {
  return typeof ref === 'string' && REF_SHAPED.test(ref)
}

/** 从一段文本里找出所有形状合法的 ref（用于"摘要正文里引了但没登记"的检查）。 */
export function findRefsInText(text) {
  return [...String(text ?? '').matchAll(/ctx:\/\/blob\/[0-9a-f]{64}/g)].map((m) => m[0])
}

/**
 * 单切片契约（S4/S5，配合轨 C）。
 *
 * 摘要器**只按调用方给的绝对 range 切一次**，拒绝第二刀：
 * `compaction-provider.runCompaction` 以前先 `surface.slice(start,end)` 再带绝对
 * range 调进来，摘要器又按绝对 range 切一次 —— 于是 `range.start=5` 时
 * 拿 165 字符去冒充 198 字符（MC06），`range.start>=events.length` 时直接
 * 返回 empty。现在把"切哪儿"的定义收在这一个函数里，两条摘要路线共用，
 * 任何一侧都不再自己 slice。
 *
 * 严格而不是宽容：`range.end > events.length` 一律报 `range-beyond-events`，
 * 不做 clamp。clamp 会把"调用方还在传局部片段"伪装成正常结果
 * （`{start:1,end:7}` 配 6 条局部事件 → clamp 成 5 条，静默少 33 字符）。
 *
 * 收到的 `slice` 字段一律**忽略但不报错**（向后兼容：老调用方可能还传着）。
 *
 * @param {{events?:Array, range?:object, slice?:any}} args
 * @returns {{ok:true, slice:Array, start:number, end:number, inputChars:number, textOf:Function, ignoredSlice:boolean}
 *          |{ok:false, reason:'bad-range'|'range-beyond-events'|'empty', start:number, end:number, events:number, inputChars:number, hint?:string}}
 */
export function resolveAbsoluteSlice({ events = [], range, slice: ignoredSliceInput } = {}) {
  const list = Array.isArray(events) ? events : []
  const textOf = (ev) => String(ev?.text ?? ev?.content ?? '')
  const ignoredSlice = ignoredSliceInput !== undefined && ignoredSliceInput !== null
  const norm = normalizeRange(range)
  if (!norm) {
    return { ok: false, reason: 'bad-range', start: 0, end: 0, events: list.length, inputChars: 0, ignoredSlice, hint: `range 非法：${JSON.stringify(range ?? null)}` }
  }
  const { start, end } = norm
  if (end > list.length) {
    return {
      ok: false, reason: 'range-beyond-events', start, end, events: list.length, inputChars: 0, ignoredSlice,
      hint: `绝对 range [${start},${end}) 超出事件数 ${list.length}。摘要器只接受**全量 events + 绝对 range**，`
        + '调用方不要再预先 slice（否则 range 与坐标不再同一个坐标系）。',
    }
  }
  const slice = list.slice(start, end)
  const inputChars = slice.reduce((n, ev) => n + textOf(ev).length, 0)
  if (slice.length === 0) {
    return { ok: false, reason: 'empty', start, end, events: list.length, inputChars, ignoredSlice }
  }
  return { ok: true, slice, start, end, inputChars, textOf, ignoredSlice }
}

/**
 * 过滤出**能取回**的 ref。取不回的一律不进摘要（"摘要声称可回取"是 MC04 的原始缺陷）。
 * @param {{refs?:Array, verifyRef?:Function}} args
 * @returns {{refs:string[], dropped:Array<{ref:string, reason:string}>}}
 */
export function filterResolvableRefs({ refs = [], verifyRef } = {}) {
  const out = []
  const dropped = []
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (!isRefShaped(ref)) { dropped.push({ ref: String(ref), reason: 'not-ref-shaped' }); continue }
    if (typeof verifyRef !== 'function') { dropped.push({ ref, reason: 'no-verifier' }); continue }
    let ok = false
    try { ok = verifyRef(ref) === true } catch { ok = false }
    if (!ok) { dropped.push({ ref, reason: 'unreadable' }); continue }
    if (!out.includes(ref)) out.push(ref)
  }
  return { refs: out, dropped }
}

/** 把 {start,end} / [start,end] 归一化；非法返回 null（交给 validate 报问题，不在这里抛）。 */
export function normalizeRange(range) {
  const raw = Array.isArray(range) ? { start: range[0], end: range[1] } : range
  if (!raw || typeof raw !== 'object') return null
  const { start, end } = raw
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start < 0 || end < start) return null
  return { start, end }
}

/** 归一化受保护项：字符串视为 {kind:'goal'}，对象保留 kind/value。 */
export function normalizeProtectedItems(items) {
  const out = []
  for (const it of items ?? []) {
    if (it == null) continue
    const kind = typeof it === 'string' ? 'goal' : (it.kind ?? 'goal')
    const value = typeof it === 'string' ? it : it.value
    if (!PROTECTED_KINDS.includes(kind)) throw new TypeError(`未知受保护项类型: ${kind}（允许 ${PROTECTED_KINDS.join('/')}）`)
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('受保护项 value 必须是非空字符串')
    out.push({ kind, value: value.trim() })
  }
  return out
}

/**
 * 生成摘要候选。id 由 (range, sourceRevision, text) 内容派生：
 * 同一份结果重复生成 → 同 id（幂等），不含时间戳/随机数。
 */
export function makeSummaryCandidate({ range, sourceRevision, text, level = 'T1', refs = [], protectedItems = [], coveredIds = [] } = {}) {
  const norm = normalizeRange(range)
  const body = typeof text === 'string' ? text : (text == null ? '' : String(text))
  const candidate = {
    v: 1,
    level,
    range: norm ?? range ?? null,
    sourceRevision,
    text: body,
    refs: Array.isArray(refs) ? [...refs] : [],
    protectedItems: normalizeProtectedItems(protectedItems),
    // 【坐标系】coveredIds = 本次摘要覆盖的**事件身份**（eventId），不是位置。
    //
    // 为什么必须有它：`range` 是「表层位置」还是「引擎 state.events 下标」
    // 取决于谁在说话，而这两套坐标在历史被替换/遮蔽之后并不相等。
    // 位置用来展示（渲染摘要块摆在哪儿），身份用来判「这段我压过没有」。
    // 故意**不进 contentHash**：id 仍由 (level, range, sourceRevision, text)
    // 派生，同一份结果重复生成还是同一个 id（幂等契约不变）。
    coveredIds: Array.isArray(coveredIds) ? coveredIds.filter((x) => typeof x === 'string' && x) : [],
  }
  candidate.id = norm && Number.isInteger(sourceRevision)
    ? 'sum-' + contentHash({ level: candidate.level, range: norm, sourceRevision, text: body }).slice(0, 20)
    : null
  return candidate
}

function hasValue(text, value) {
  if (!value) return false
  if (text.includes(value)) return true
  // 精确值常被空格/大小写改动：退一步做去空白小写比较，但仍要求完整出现
  const norm = (s) => s.replace(/\s+/g, '').toLowerCase()
  return norm(text).includes(norm(value))
}

/**
 * 校验摘要候选。
 * @returns {{ok:boolean, problems:string[], missing:Array<{kind:string,value:string}>, checked:{protected:number}, id:string|null}}
 */
export function validateSummary(candidate, { protectedItems = [], maxChars = MAX_SUMMARY_CHARS } = {}) {
  const problems = []
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, problems: ['候选不是对象'], missing: [], checked: { protected: 0 }, id: null }
  }
  if (candidate.v !== 1) problems.push(`候选版本不支持: ${candidate.v}`)
  if (!SUMMARY_LEVELS.includes(candidate.level)) problems.push(`未知层级: ${candidate.level}（允许 ${SUMMARY_LEVELS.join('/')}）`)
  const range = normalizeRange(candidate.range)
  if (!range) problems.push(`范围非法: ${JSON.stringify(candidate.range)}`)
  if (!Number.isInteger(candidate.sourceRevision) || candidate.sourceRevision < 0) {
    problems.push(`sourceRevision 必须是非负整数，实际 ${JSON.stringify(candidate.sourceRevision)}`)
  }
  const text = typeof candidate.text === 'string' ? candidate.text : ''
  if (!text.trim()) problems.push('摘要正文为空')
  if (text.length > maxChars) problems.push(`摘要正文超过 ${maxChars} 字符上限（实际 ${text.length}）`)
  if (text.trim() && /^\[\.\.\.省略/.test(text.trim())) problems.push('摘要正文只有占位符，没有实际内容')

  const want = normalizeProtectedItems(protectedItems)
  const missing = want.filter((it) => !hasValue(text, it.value))
  for (const m of missing) problems.push(`受保护项缺失（${m.kind}）: ${m.value}`)

  return {
    ok: problems.length === 0,
    problems,
    missing,
    checked: { protected: want.length },
    id: candidate.id ?? null,
    range,
  }
}

/**
 * 原子发布：委托给引擎的提交器（引擎负责日志/状态/锁）。
 * 独立使用时也可以传 {currentSourceRevision, commit} —— 但推荐用 engine。
 *
 * 【S5-2】优先走 `engine.publishSummary`，**不要**直接调 `_commitSummary`。
 * 两者的差别不是风格问题：`engine.publishSummary`（engine.mjs:826-836）在调用方
 * 没显式给 guard 时，会填上 createEngine 里配置的 guardPolicy；而直接调
 * `_commitSummary` 拿到的是 `guard: null` → 引擎层那道守门**整段被跳过**，
 * `state.lastGuard` 永远是 null，外部看不出"这次到底过没过闸"。
 * 实测复现：机械摘要发布成功后 `engine.stats().lastGuard === null`，而
 * guardPolicy.enabled 明明是 true。
 *
 * @param {object} candidate
 * @param {{engine?:object, protectedItems?:Array, guard?:object, currentSourceRevision?:number, commit?:Function}} opts
 */
export function publishSummary(candidate, opts = {}) {
  const { engine, protectedItems, currentSourceRevision, commit } = opts
  if (engine && typeof engine.publishSummary === 'function') {
    // 带默认守门策略的那条路（存在就优先用它）
    return engine.publishSummary(candidate, { protectedItems, ...(opts.guard !== undefined ? { guard: opts.guard } : {}) })
  }
  if (engine && typeof engine._commitSummary === 'function') {
    return engine._commitSummary(candidate, { protectedItems })
  }
  // 无引擎时只做协议校验 + 显式提交回调，避免本模块偷偷持有存储
  const v = validateSummary(candidate, { protectedItems })
  if (!v.ok) return { ok: false, reason: 'invalid', problems: v.problems, missing: v.missing }
  if (!Number.isInteger(currentSourceRevision)) return { ok: false, reason: 'no-store', note: '缺少 engine 或 currentSourceRevision+commit' }
  if (candidate.sourceRevision !== currentSourceRevision) {
    return { ok: false, reason: 'source-revision-changed', expected: currentSourceRevision, candidate: candidate.sourceRevision }
  }
  if (typeof commit !== 'function') return { ok: false, reason: 'no-store', note: '缺少 commit 回调' }
  return commit(candidate, { protectedItems: v.checked.protected })
}
