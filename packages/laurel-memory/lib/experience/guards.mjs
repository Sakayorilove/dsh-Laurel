/**
 * laurel-memory/experience/guards —— 晋升门（关闭 Forge F1 / F2 的同类缺陷）。
 *
 * F1（相邻条件丢失 / 正负混合仍 complete）：
 *   旧的 summaries.js 只保留命中"原因/动作"的相邻句，且 `complete` 允许任何成功词
 *   抵消 `uncertain`。这里改成：
 *     · 相邻句只要带**条件/边界/前提**就必须一起保留；
 *     · 否定/撤回/未完成信号**优先于**成功词 —— 同段出现即 uncertain；
 *     · complete 需要"有做法 + 有验证结果 + 无撤回信号 + 无未闭合前提"。
 *
 * F2（同 failureSignature 跨 project/environment/命令合并）：
 *   `sameScope` 要求 projectId + environmentId + 操作签名三者都相同。
 *   同错误签名不等于同修法，绝不因为签名相同就跨域合并。
 *
 * 纯函数：不读盘、不调模型、不执行命令。
 */

/** 条件/边界/前提的标记词：出现即说明这句话改变了适用范围。 */
const CONDITION_MARKERS = [
  '仅在', '只在', '只有', '前提', '除非', '若', '如果', '当…时', '条件',
  '不能用于', '不适用', '不得', '禁止', '不要', '勿', '避免',
  '必须先', '先完成', '之前', '之后才', '仅适用', '适用于', '限于',
]

/** 撤回/否定/未完成信号：优先级高于任何成功词。
 *
 * 注意 `错误` 这个词**不是**撤回信号 —— "原因是配置错误，改为…已经通过"里的
 * "错误"描述的是被修掉的原因，不是本次修复失败。把它算进撤回会让所有正常
 * 修复总结都判成 incomplete。真正的撤回信号是"这次修复无效/未完成"这层意思。
 */
const RETRACTION_MARKERS = [
  '无效', '不生效', '没用', '未完成', '还没', '尚未', '未验证',
  '回滚', '撤回', '作废', '取消', '不对', '没解决', '未解决',
  '不能用于', '不可用', '不适用', '推翻', '重新做', '放弃',
  '修复失败', '仍然失败', '还是失败', '依然失败',
]

/** 成功/完成词。它们**不能**单独把 complete 拉成 true。 */
const SUCCESS_MARKERS = ['通过', '成功', '已修', '修好', '解决', '完成', '生效', '验证通过', 'ok', 'passed']

/** 验证结果词。 */
const VERIFICATION_MARKERS = ['验证', '实测', '检查', '确认', '外部检查', 'CHECK_OK', 'exit 0', '退出码 0']

function hasAny(text, markers) {
  const s = String(text ?? '').toLowerCase()
  return markers.some((m) => s.includes(m.toLowerCase()))
}

/**
 * 把文本切成句子（中英文句末 + 换行 + 分号）。
 * 保留原始顺序与相邻关系 —— 相邻条件是判定 complete 的关键。
 */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 判断一段总结文字是否可以视为"完整且不再不确定"。
 *
 * @param {string} text
 * @returns {{complete:boolean, uncertain:boolean, reasons:string[], conditions:string[], retractions:string[]}}
 */
export function isCompleteSummary(text) {
  const s = String(text ?? '').trim()
  const reasons = []
  if (!s) return { complete: false, uncertain: true, reasons: ['空文本'], conditions: [], retractions: [] }

  const sentences = splitSentences(s)
  const conditions = sentences.filter((x) => hasAny(x, CONDITION_MARKERS))
  const retractions = sentences.filter((x) => hasAny(x, RETRACTION_MARKERS))
  const hasSuccess = hasAny(s, SUCCESS_MARKERS)
  const hasVerification = hasAny(s, VERIFICATION_MARKERS)

  // 撤回/未完成信号优先：只要出现，就不能算 done
  if (retractions.length) {
    reasons.push(`存在撤回/否定/未完成信号：${retractions[0].slice(0, 40)}`)
  }
  if (!hasSuccess) reasons.push('没有任何成功/完成表述')
  if (!hasVerification) reasons.push('没有验证办法或验证结果')

  // 关键：有前提/边界句时，若该句没有被明确纳入"验证过的做法"，
  // 就说明做法与条件还没对齐 —— 仍未闭合。
  if (conditions.length) {
    const unclosed = conditions.filter((c) => !hasAny(c, VERIFICATION_MARKERS))
    if (unclosed.length) {
      reasons.push(`存在未闭合的适用条件/边界：${unclosed.map((x) => x.slice(0, 30)).join(' | ')}`)
    }
  }

  const uncertain = retractions.length > 0 || conditions.some((c) => !hasAny(c, VERIFICATION_MARKERS))
  const complete = reasons.length === 0 && !uncertain
  return { complete, uncertain, reasons, conditions, retractions }
}

/**
 * 作用域相等（关闭 F2）：project + environment + 操作签名三者都相同才算同域。
 * 只比 failureSignature 是错的 —— 同签名可能来自完全不同的项目与修法。
 */
export function sameScope(a, b) {
  if (!a || !b) return false
  const pa = a.projectId ?? a.project ?? null
  const pb = b.projectId ?? b.project ?? null
  if (!pa || pa !== pb) return false
  const ea = a.environmentId ?? a.environment ?? null
  const eb = b.environmentId ?? b.environment ?? null
  if (ea !== eb) return false
  const sa = a.signature ?? a.actionSignature ?? null
  const sb = b.signature ?? b.actionSignature ?? null
  if (!sa || !sb || sa !== sb) return false
  return true
}

/**
 * 去重门：先严格限定作用域，再比较内容。
 * @returns {{duplicate:boolean, reason:string, sameScope:boolean}}
 */
export function duplicateGate(incoming, candidates) {
  const scoped = (candidates ?? []).filter((c) => sameScope(incoming, c))
  if (!scoped.length) {
    return { duplicate: false, reason: 'no-same-scope', sameScope: false, note: '同签名但跨项目/环境/命令，不得合并' }
  }
  const key = String(incoming.text ?? incoming.action ?? '').trim()
  for (const c of scoped) {
    const other = String(c.text ?? c.action ?? '').trim()
    if (key && key === other) return { duplicate: true, reason: 'identical-in-scope', sameScope: true, id: c.id }
  }
  return { duplicate: false, reason: 'same-scope-different-content', sameScope: true }
}

/**
 * 晋升前的综合门：结构（method）+ 文本（complete）+ 作用域去重。
 * 任何一项不过都不允许 adopted。
 */
export function canPromote({ method, summary, incoming, candidates }) {
  const blockers = []
  if (method && method.ok === false) blockers.push({ gate: 'method', missing: method.missing })
  if (summary) {
    const c = isCompleteSummary(summary)
    if (!c.complete) blockers.push({ gate: 'summary', reasons: c.reasons })
  }
  if (incoming && candidates) {
    const d = duplicateGate(incoming, candidates)
    if (d.duplicate) blockers.push({ gate: 'duplicate', reason: d.reason, id: d.id })
  }
  return { ok: blockers.length === 0, blockers }
}
