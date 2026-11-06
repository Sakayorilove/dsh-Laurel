/**
 * laurel-memory/experience/lifecycle —— 经验生命周期（S06）。
 *
 * 流程：raw-episode → candidate → trial → adopted → retired / revoked
 *
 * 纪律：
 *  1. 人工采纳（actor=human）与实际复用验证（outcome）**分开记录**；
 *     人点了"采纳"不等于"复用成功"。
 *  2. 调用次数不增加可信度：可信度只看真实 outcome。
 *  3. 每次变更产生新 revision，旧版本保留（不覆盖、不删除）。
 *  4. edit 后 contentVersion 变化 → 旧 Skill / 缓存 / 检索条目必须失效（F3 同类）。
 *  5. 预算账本不可用 → 拒绝发起新的模型整理（F4 同类），返回明确原因。
 *  6. 撤销可随时发生，撤销后不得复活。
 *
 * 纯逻辑 + 一个可注入的存储（commit）；本文件不读 DSH，也不直接调模型。
 */
import { contentHash, canonical } from '../../../laurel-core/lib/format.mjs'
import { validateMethod, methodFingerprint, normalizeResult, withDerivedEnv } from './method.mjs'
import { isCompleteSummary, sameScope } from './guards.mjs'

export const STATES = Object.freeze(['raw-episode', 'candidate', 'trial', 'adopted', 'retired', 'revoked'])

const ALLOWED = {
  'raw-episode': ['candidate', 'revoked'],
  candidate: ['trial', 'adopted', 'revoked', 'retired'],
  trial: ['adopted', 'retired', 'revoked'],
  adopted: ['retired', 'revoked'],
  retired: ['revoked', 'trial'],
  revoked: [],   // 终态：不允许从 revoked 复活
}

export function canTransition(from, to) {
  return (ALLOWED[from] ?? []).includes(to)
}

/** 经验条目：身份由适配器注入，方法结构由调用方给出。 */
export function makeExperience({ method, summary, actor, coreId, projectId, environmentId, legacyId = null, at = Date.now() }) {
  const m = validateMethod(method ?? {})
  const record = {
    v: 1,
    id: 'x-' + contentHash({ coreId, projectId, environmentId, method: method ?? null, summary: summary ?? '' }).slice(0, 20),
    coreId, projectId,
    environmentId: environmentId ?? null,
    state: 'candidate',
    method: method ?? null,
    methodOk: m.ok,
    methodMissing: m.missing ?? [],
    summary: String(summary ?? ''),
    fingerprint: method ? methodFingerprint(method) : null,
    legacyId,
    revision: 1,
    contentVersion: contentHash({ method: method ?? null, summary: summary ?? '' }),
    // 采纳与验证分开：这两个字段永远不互相推导
    adoption: { by: actor ?? null, at, kind: actor === 'human' ? 'human-click' : 'system' },
    verification: { result: 'none', at: null, evidence: [], note: '尚未做复用验证' },
    outcomes: [],
    createdAt: at,
    updatedAt: at,
  }
  return record
}

/** 晋升：必须 method 齐备 + summary complete + 作用域不冲突。 */
export function promote(record, { summary, actor, candidates = [], budget, at = Date.now() } = {}) {
  if (!record) return { ok: false, reason: 'missing-record' }
  if (!canTransition(record.state, 'candidate') && record.state !== 'candidate') {
    return { ok: false, reason: 'bad-transition', from: record.state, to: 'candidate' }
  }
  // F4 同类：预算不可用时不允许发起新的模型整理
  if (budget && budget.available === false) {
    return { ok: false, reason: 'budget-unavailable', detail: budget.reason ?? null, note: '账本不可用 → 拒绝新整理调用' }
  }
  // P5c：**先重推环境，再判 methodOk**。
  //
  // `record.methodOk` 是写入那一刻算出来的快照，而存量的 2,680 条是在
  // environmentId 还只能从 gitBranch 派生的年代写下的 —— 它们全部被冻成 false，
  // 于是人工点「采纳」也永远过不去（评审 §5.4 的"堵的不止一处"就是这件事）。
  // 环境这一项能不能补，靠的是**命令正文**（动作级，S3 的判据），与当时写没写
  // methodOk 无关。所以这里重算一遍，而不是相信那个快照。
  //
  // 只补环境：verification 是 failed/none 的做法补完环境**仍然**过不了
  // validateMethod（P5b），这是有意的 —— 重算不等于放宽。
  const envFixed = withDerivedEnv(record.method ?? {})
  const verdict = validateMethod(envFixed.method ?? {})
  const method = envFixed.derived.environmentId ? envFixed.method : (record.method ?? null)
  if (!verdict.ok) {
    return {
      ok: false,
      reason: 'method-incomplete',
      missing: verdict.missing ?? record.methodMissing ?? [],
      problems: verdict.problems ?? [],
      envDerived: envFixed.derived.environmentId,
    }
  }
  const text = summary ?? record.summary
  if (text) {
    const c = isCompleteSummary(text)
    if (!c.complete) return { ok: false, reason: 'summary-incomplete', reasons: c.reasons, uncertain: c.uncertain }
  }
  const clash = candidates.find((c) => c.id !== record.id && sameScope(c, record) && c.contentVersion === record.contentVersion)
  if (clash) return { ok: false, reason: 'duplicate-in-scope', with: clash.id }

  return {
    ok: true,
    record: {
      ...record,
      state: 'adopted',
      method,
      methodOk: true,
      methodMissing: [],
      methodProblems: [],
      // 记下这条 environmentId 是**重推**出来的还是原本就有 —— 事后可核对，
      // 否则「采纳」按钮看起来像是"放宽了判据"。
      ...(envFixed.derived.environmentId ? { envDerivedFrom: envFixed.derived.source } : {}),
      summary: text,
      revision: record.revision + 1,
      contentVersion: contentHash({ method, summary: text, adopted: true }),
      adoption: { by: actor ?? record.adoption?.by ?? null, at, kind: 'promoted' },
      updatedAt: at,
    },
  }
}

/** Automatic adoption uses structured evidence, never a rewritten success story.
 * Adoption is permission to recall; only later independent outcomes add confidence.
 */
export function autoPromote(record, { candidates = [], adoptedKeys = null, at = Date.now() } = {}) {
  if (!record) return { ok: false, reason: 'missing-record' }
  if (!['raw-episode', 'candidate', 'trial'].includes(record.state)) {
    return { ok: false, reason: 'ineligible-state' }
  }
  if (record.verification?.result === 'failed' || (record.outcomes ?? []).some(o => o.result === 'failed')) {
    return { ok: false, reason: 'prior-failure' }
  }
  const fixed = withDerivedEnv(record.method ?? {})
  const proposed = { ...fixed.method }
  // A recorded exact action has a known narrow boundary even when prose omitted it.
  // This adds a scope restriction, never an assertion about untested environments.
  const env = proposed.applicableEnv
  if (!proposed.limits?.length && env?.projectId && env?.environmentId) {
    proposed.limits = [`仅限工程 ${env.projectId}、环境 ${env.environmentId} 的原样操作；其他参数、工程与环境未验证。`]
  }
  const verdict = validateMethod(proposed)
  if (!verdict.ok) return { ok: false, reason: 'method-incomplete', missing: verdict.missing, problems: verdict.problems }
  const method = verdict.method
  if (method.verification?.result !== 'passed') return { ok: false, reason: 'verification-not-passed' }
  if (!record.projectId || method.applicableEnv.projectId !== record.projectId) {
    return { ok: false, reason: 'scope-mismatch' }
  }
  if (!Array.isArray(record.evidence) || !record.evidence.length ||
      !method.evidence.every(e => typeof e.id === 'string' && record.evidence.includes(e.id))) {
    return { ok: false, reason: 'unlinked-evidence' }
  }
  const key = automaticMethodKey({ ...record, method })
  const duplicate = adoptedKeys ? adoptedKeys.get(key) : candidates.find(c => c.id !== record.id &&
    ['adopted', 'revoked', 'retired'].includes(c.state) && automaticMethodKey(c) === key)
  if (duplicate) return { ok: false, reason: ['revoked', 'retired'].includes(duplicate.state) ? 'withdrawn-method' : 'duplicate-in-scope', with: duplicate.id }
  return { ok: true, record: {
    ...record, state: 'adopted', method, methodOk: true, methodMissing: [], methodProblems: [],
    environmentId: method.applicableEnv.environmentId,
    fingerprint: methodFingerprint(method),
    revision: (record.revision ?? 1) + 1,
    contentVersion: contentHash({ method, summary: record.summary, adopted: true }),
    adoption: { by: 'automatic', kind: 'automatic', at,
      evidenceKind: record.trigger === 'verified-action' ? 'tool-result' : 'source-report' },
    // Keep the original summary, boundaries and initial evidence. No invented outcomes.
    updatedAt: at,
  } }
}

/** Evidence ids vary across runs; identity for duplicate methods excludes those ids. */
export function automaticMethodKey(record) {
  const m = validateMethod(withDerivedEnv(record?.method ?? {}).method).method
  return contentHash({ projectId: record?.projectId, env: m?.applicableEnv?.environmentId,
    action: m?.action })
}

/**
 * 记录真实复用结果。**调用次数不是成功率**：每次 outcome 单独记，
 * 有效/无效/不适用分别累计，不因为调用多就抬升可信度。
 */
export function recordOutcome(record, { result, evidence = [], actor, at = Date.now() } = {}) {
  if (!record) return { ok: false, reason: 'missing-record' }
  if (!['adopted', 'trial'].includes(record.state)) {
    return { ok: false, reason: 'not-in-use', state: record.state }
  }
  const r = normalizeResult(result)
  if (!['passed', 'failed', 'pending'].includes(r)) {
    return { ok: false, reason: 'bad-result', got: result, allowed: ['passed', 'failed', 'pending'] }
  }
  const outcome = { result: r, evidence: [...evidence], actor: actor ?? null, at }
  return {
    ok: true,
    record: {
      ...record,
      outcomes: [...(record.outcomes ?? []), outcome],
      verification: r === 'passed'
        ? { result: 'passed', at, evidence: [...evidence], note: '复用验证通过' }
        : r === 'failed'
          ? { result: 'failed', at, evidence: [...evidence], note: '复用验证失败，应降级' }
          : { ...record.verification, result: 'pending', at },
      revision: record.revision + 1,
      updatedAt: at,
    },
  }
}

/** 撤销：终态，撤销后不得复活。 */
export function revoke(record, { reason, actor = 'user', at = Date.now() } = {}) {
  if (!record) return { ok: false, reason: 'missing-record' }
  if (record.state === 'revoked') return { ok: false, reason: 'already-revoked' }
  return {
    ok: true,
    record: {
      ...record,
      state: 'revoked',
      revokedReason: reason ?? null,
      revokedBy: actor,
      revision: record.revision + 1,
      contentVersion: contentHash({ revoked: true, at, prev: record.contentVersion }),
      updatedAt: at,
    },
  }
}

/** 降级 / 退役（与撤销不同：可再试用）。 */
export function retire(record, { reason, actor = 'user', at = Date.now() } = {}) {
  if (!record) return { ok: false, reason: 'missing-record' }
  if (!canTransition(record.state, 'retired')) return { ok: false, reason: 'bad-transition', from: record.state }
  return {
    ok: true,
    record: {
      ...record,
      state: 'retired',
      retiredReason: reason ?? null,
      retiredBy: actor,
      revision: record.revision + 1,
      updatedAt: at,
    },
  }
}

/** 编辑候选：contentVersion 必须变化，触发下游缓存/Skill 失效（F3）。 */
export function edit(record, patch, { actor = 'user', at = Date.now() } = {}) {
  if (!record) return { ok: false, reason: 'missing-record' }
  if (record.state === 'revoked') return { ok: false, reason: 'revoked-cannot-edit' }
  const method = patch.method ?? record.method
  const summary = patch.summary ?? record.summary
  const m = validateMethod(method ?? {})
  return {
    ok: true,
    record: {
      ...record,
      method, summary,
      methodOk: m.ok, methodMissing: m.missing ?? [],
      revision: record.revision + 1,
      contentVersion: contentHash({ method: method ?? null, summary, at }),
      updatedAt: at,
      editedBy: actor,
    },
  }
}

/**
 * 复用可信度：不返回"成功率=调用次数"。
 * 只按**有证据的 outcome** 统计，并显式标出样本量。
 */
export function confidenceOf(record) {
  const outcomes = (record?.outcomes ?? []).filter((o) => o.result === 'passed' || o.result === 'failed')
  const passed = outcomes.filter((o) => o.result === 'passed').length
  const failed = outcomes.filter((o) => o.result === 'failed').length
  const n = passed + failed
  return {
    samples: n,
    passed,
    failed,
    // 样本不足时不给高可信度
    level: n === 0 ? 'unverified' : (failed > 0 ? 'mixed' : (n >= 3 ? 'supported' : 'weak')),
    note: n === 0 ? '没有任何真实复用结果；采纳本身不算验证' : `基于 ${n} 次有结果的实际复用`,
  }
}

/** 检索门：状态过滤在打分之前，撤销/退役不参与推荐。 */
export function usableForRecommendation(record) {
  if (!record) return false
  if (record.state !== 'adopted') return false
  if (record.methodOk === false) return false
  const v = record.verification?.result
  if (v === 'failed') return false
  return true
}
