/**
 * laurel-context/model-summarize —— 模型摘要路线（S08）。
 *
 * 这是引擎里**唯一**会花推理的地方。纪律：
 *  1. 默认关闭。tier=zero 时永不调用。
 *  2. 所有调用过 gateway（预占→发送→结算），不绕过预算。
 *  3. 冻结 sourceRevision，返回后由 summary-protocol 校验；源变了就丢弃。
 *  4. 提示词要求模型保留受保护项；模型没保留就由协议层拒绝，不靠模型自觉。
 *  5. 输出只当候选，不当事实、不直接 adopted。
 */

import { makeSummaryCandidate, validateSummary, resolveAbsoluteSlice, filterResolvableRefs, findRefsInText } from './summary-protocol.mjs'
import { extractProtected, guardSummary } from './guard.mjs'
import { mergeProtectedItems, resolveGuardPolicy } from './mechanical-summarize.mjs'

/**
 * 提示词：明确要求保留五类受保护项，并要求标注不确定。
 *
 * 【S4】切片口径与机械路线**共用** `resolveAbsoluteSlice`：以前这里自己
 * `events.slice(range.start, range.end)`，机械路线也自己切 —— 两处各切一次，
 * 上游 `compaction-provider` 还先切了第三刀。同一个 range 在三处含义不同，
 * 于是 `range.start=5` 时摘要器看到的是 165 字符而不是 198 字符（MC06）。
 * 传进来的 `slice` 字段同样忽略（向后兼容）。
 */
export function buildSummaryPrompt({ events, range, protectedItems, level = 'T1', slice: incomingSlice }) {
  const resolved = resolveAbsoluteSlice({ events, range, slice: incomingSlice })
  if (!resolved.ok) {
    throw Object.assign(new Error(`摘要范围不可用：${resolved.reason}${resolved.hint ? `（${resolved.hint}）` : ''}`), {
      code: 'bad-range',
      reason: resolved.reason,
      events: resolved.events,
      range,
    })
  }
  const { slice, start } = resolved
  const body = slice.map((e, i) => `[${start + i}] ${e.role}: ${String(e.text ?? '').slice(0, 4000)}`).join('\n\n')
  const prot = (protectedItems ?? []).map((p) => `- (${p.kind}) ${p.value}`).join('\n')
  return [
    `你是上下文压缩器。把下面这段会话压成 ${level} 摘要。`,
    '',
    '硬性要求（缺一不可，缺了我这边会拒收）：',
    '1. 保留当前目标，原话关键短语不要改写。',
    '2. 保留所有禁止事项、前提条件、适用边界（"仅在…后"、"不能用于…"）。',
    '3. 保留未完成任务。',
    '4. 保留关键精确值（数字、版本、路径、命令、参数）。',
    '5. 保留活跃错误（含错误码与堆栈首行）。',
    '6. 不要把失败的尝试写成成功。',
    '',
    prot ? `以下条目必须逐条出现在你的输出里：\n${prot}\n` : '',
    '输出格式：直接给摘要正文，不要前言、不要 markdown 代码块。',
    '',
    '=== 会话片段 ===',
    body,
  ].filter(Boolean).join('\n')
}

/**
 * 用网关生成一个摘要候选。
 *
 * 【S4/S5】与机械路线同口径：
 *  - 只按绝对 range 切一次（传进来的 `slice` 忽略）；
 *  - `inputChars` 是绝对 range 的真实字符数，供轨 C 的收益判断使用；
 *  - 受保护项 = 调用方声明 ∪ 自动抽取；
 *  - 模型输出先过 `guardSummary`（0.35 / critical 零容忍，只许收紧），
 *    再过 `validateSummary`。守门不过就 `ok:false`，**不拿机械摘要糊过去**。
 *
 * @param {{engine:object, gateway:object, range:object, level?:string, protectedItems?:Array,
 *          signal?:AbortSignal, verifyRef?:Function, guardPolicy?:object, slice?:any}} args
 */
export async function summarizeWithModel({
  engine, gateway, range, level = 'T1', protectedItems = [], signal,
  verifyRef, guardPolicy, slice: incomingSlice,
  // 【坐标系】eventsOverride：让调用方用**自己的那份 events**（宿主表层）来切片。
  // 以前这里写死 `engine._events()`，于是 host-compaction 只能把表层位置硬夹成
  // 引擎下标（`Math.min(abs.start, revision)`）—— 夹出来的那段切到的是别的事件。
  // 现在表层切表层，覆盖身份靠 coveredIds 交回引擎映射。
  events: eventsOverride,
}) {
  const st = gateway.status()
  if (!st.enabled) {
    return { ok: false, reason: 'gateway-disabled', details: st.reasons, note: '零推理档或未配模型，不发起摘要请求' }
  }
  const events = Array.isArray(eventsOverride) ? eventsOverride : (engine._events?.() ?? [])
  const sourceRevision = engine.revision

  // 只切一次，与机械路线同一个函数（`slice` 字段忽略，向后兼容）。
  const resolved = resolveAbsoluteSlice({ events, range, slice: incomingSlice })
  if (!resolved.ok) {
    return {
      ok: false, reason: resolved.reason, range, events: resolved.events,
      hint: resolved.hint, ignoredSlice: resolved.ignoredSlice,
    }
  }
  const { slice, start, end, inputChars, textOf } = resolved

  // 受保护项自动提取：调用方没传的，这里自己抽（S5-1）。
  const rawText = slice.map((ev) => textOf(ev)).join('\n')
  const merged = mergeProtectedItems(protectedItems, extractProtected(rawText, { limit: 80 }))

  const prompt = buildSummaryPrompt({ events, range: { start, end }, protectedItems: merged, level })
  const out = await gateway.complete({ purpose: `context.summary.${level}`, input: prompt, signal })
  if (!out.ok) return { ok: false, reason: 'model-failed', details: out.reason, charged: out.charged }

  const body = String(out.text ?? '').trim()

  // ref 先验后写：模型正文里提到的 ref 一律核实，取不回的不登记。
  const { refs, dropped: droppedRefs } = filterResolvableRefs({
    refs: [...new Set([...findRefsInText(body), ...findRefsInText(rawText)])],
    verifyRef,
  })

  // 【坐标系】同机械路线：把事件身份交出去，由引擎映射回自己的下标。
  const coveredIds = slice.map((ev) => ev?.eventId).filter((id) => typeof id === 'string' && id)
  const candidate = makeSummaryCandidate({
    range: { start, end },
    sourceRevision,
    text: body,
    level,
    refs,
    protectedItems: merged,
    coveredIds,
  })
  const check = validateSummary(candidate, { protectedItems: merged })

  // 守门：与机械路线同一套策略，只许收紧。
  const guard = guardSummary({
    original: rawText,
    summary: body,
    policy: resolveGuardPolicy(guardPolicy),
    protectedItems: merged,
  })

  // 【契约】守门不过**不返回 ok:false**，而是 ok:true + acceptable:false。
  //
  // 这不是软化，恰恰相反：`host-compaction.mjs` 对 `ok:false` 的处理是
  // 「模型这条路失败 → log.warn → 落到机械路线继续」。如果这里返回 ok:false，
  // 压丢了限制条件的模型摘要会被机械摘要顶上去、照样替换真实历史 ——
  // 那正是 tests/mechanical-summarize.test.mjs:191「不偷偷退回机械摘要」要挡的事。
  // 只有 acceptable:false 才走那条分支：整条拒，不留替换。
  //
  // 所以 acceptable = 协议校验通过 **且** 守门通过；两道闸任一把关都算不过。
  const acceptable = check.ok && guard.ok
  const missing = [...(check.missing ?? []), ...(guard.missing ?? [])]

  return {
    ok: true,
    candidate,
    check,
    guard,
    refs,
    droppedRefs,
    inputChars,
    usage: out.usage,
    unknownUsage: out.unknownUsage,
    // 校验/守门失败也把候选交出去，让调用方决定重做还是放弃
    acceptable,
    missing,
    // 说清楚是谁挡的，别让调用方只看到一个 false
    rejectReason: acceptable ? null : (check.ok ? 'guard-reject' : 'protected-items-missing'),
  }
}
