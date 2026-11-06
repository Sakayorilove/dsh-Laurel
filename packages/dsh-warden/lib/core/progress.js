/**
 * dsh-warden · 无进展识别与最小阶段合同（R6 / R8）
 *
 * ── R6：旧版把正常开发当空转 ───────────────────────────────────────────
 * 旧 `host/after.js` 只按**路径**累计次数。于是：
 *   - 分九次读一个大文件的九个不同片段 → 三次"重复读"提醒（评审已复现 actual=3）
 *   - 编辑后验证、外部修改、压缩后的必要回读 → 一律算"又读了一次"
 *   - 失败的修改也进写计数，而提醒还建议"先完整重读" —— 与省上下文的方向相反
 *
 * 这里的判据换成**有没有新证据**：
 *   算进展：目标文件出现没见过的内容指纹 / 读过没读过的区间 /
 *           结果指纹变了（哪怕只是错误信息里多了一行定位）/ 记了一条新读数 /
 *           一个假设被否定
 *   不算进展：**只有日志时间戳不同**、随机 id 不同、同一条命令原样重跑
 *
 * 而且 `progressMode` 默认是 `observe` —— 先只记录、只在状态里可见，
 * 观察一段时间确认误判率之后，才由用户切到 `enforce`。
 *
 * ── R8：阶段合同 ───────────────────────────────────────────────────────
 * 一个很小的阶段记录：目标 / 验收项 / 源码与部署身份 / 当前假设 /
 * 最近新证据 / 下一步 / 资源占用 / 剩余必需项。
 *
 * **预算到点是复盘提醒，不是自动成功、也不是自动放弃。**
 * `complete` 状态有硬门槛：验收项非空且逐项都有依据；缺必需项时只能落到
 * `conditional-complete`（条件完成）/ `blocked`（等人）/ `failed`，
 * 三者必须可区分 —— 这正是评审要求的"缺必需项时不可 complete"。
 *
 * ── 与外部计划工具的关系 ───────────────────────────────────────────────
 * 计划与阶段依赖由计划工具负责。这里的阶段记录只是**执行面的收工合同**，
 * 不产生第二套互相覆盖的完成真相：字段里带 `planRef`，计划侧在场时以它的
 * 阶段状态为准，warden 只补"验收项齐不齐"。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { pluginPaths, resolveDshHome } from './config.js'
import { systemClock } from './clock.js'
import { callFingerprint, classifyToolError, ERROR_CLASS_HINTS, readRangeKey, readRangeOf, resultFingerprint, sha256Hex } from './text.js'

/** 阶段状态。四者必须可区分（R8）。 */
export const STAGE_STATUSES = ['in-progress', 'conditional-complete', 'blocked', 'failed', 'complete']

/** 同一类提醒的最小间隔。 */
const NOTICE_COOLDOWN_MS = 120_000

/** 单个阶段最多主动提醒几次；超了只留复盘，不再逐条累积。 */
const NOTICE_BUDGET_PER_STAGE = 6

/** 每个会话最多记住多少个指纹，防超长会话吃内存。 */
const FINGERPRINT_LIMIT = 600

function emptyState(sessionId) {
  return {
    sessionId,
    stageId: 'default',
    calls: new Map(),            // callFingerprint → count
    failures: new Map(),         // failureSignature → { count, class, lastAt, firstAt }
    fileHashes: new Map(),       // path → Set<hash>
    readRanges: new Map(),       // path → Set<rangeKey>
    resultPrints: new Set(),     // 见过的结果指纹
    evidenceMarks: 0,
    lastProgressAt: 0,
    lastProgressReason: '阶段开始',
    replies: 0,
    stageStartedAt: 0,
    noticeCount: 0,
    lastNoticeAt: new Map(),     // kind → at
    hypothesesNegated: 0,
    /** P2-2：「同一 call + 同一 result」连续配对数（与 calls / failures 独立）。 */
    lastPairCall: '',
    lastPairResult: '',
    lastPairCount: 0,
  }
}

/**
 * 无进展观察器。内存态；重启归零是可接受的（它只影响提醒，不是审计数据）。
 */
export class ProgressWatch {
  /**
   * @param {{clock?: any, capabilities?: any, onEvent?: (e: object) => void, log?: any}} [deps]
   */
  constructor(deps = {}) {
    this.clock = deps.clock ?? systemClock()
    this.capabilities = deps.capabilities ?? null
    this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null
    this.log = deps.log ?? null
    /** @type {Map<string, object>} */
    this.sessions = new Map()
    this.limit = 64
    this.stats = { progressEvents: 0, stalledEvents: 0, notices: 0, suppressed: 0, budgetExhausted: 0 }
  }

  #state(sessionId) {
    const key = String(sessionId ?? '-')
    let state = this.sessions.get(key)
    if (!state) {
      state = emptyState(key)
      state.lastProgressAt = this.clock.now()
      state.stageStartedAt = state.lastProgressAt
      this.sessions.set(key, state)
      if (this.sessions.size > this.limit) {
        const oldest = this.sessions.keys().next().value
        if (oldest !== undefined && oldest !== key) this.sessions.delete(oldest)
      }
    }
    return state
  }

  /**
   * 观察一次工具调用（成功或失败都要喂）。
   *
   * @param {{sessionId: string, name: string, args?: any, result?: object,
   *          targetPath?: string, targetHash?: string|null}} observation
   * @param {object} config 生效配置
   * @returns {{progress: boolean, reason: string, stalled: boolean, stallKind: string,
   *            repeatCount: number, errorClass: string, notice: string|null}}
   */
  observe(observation, config = {}) {
    const now = this.clock.now()
    const state = this.#state(observation.sessionId)
    const fingerprint = callFingerprint(observation.name, observation.args)
    const failureSignature = observation.result?.isError
      ? `${resultFingerprint(observation.result)}:${classifyToolError(errorTextOf(observation.result))}`
      : ''
    const errorClass = observation.result?.isError ? classifyToolError(errorTextOf(observation.result)) : ''

    const progress = []

    // ── 信号 1：目标文件出现了没见过的内容指纹 ──
    if (observation.targetPath && observation.targetHash) {
      let seen = state.fileHashes.get(observation.targetPath)
      if (!seen) { seen = new Set(); state.fileHashes.set(observation.targetPath, seen) }
      if (!seen.has(observation.targetHash)) {
        seen.add(observation.targetHash)
        progress.push(`目标文件出现了新内容（${shortId(observation.targetHash)}）`)
      }
      if (seen.size > 64) seen.delete(seen.keys().next().value)
    }

    // ── 信号 2：读过没读过的区间（这正是"分九次读九段"的正常做法）──
    const range = readRangeOf(observation.args)
    if (observation.targetPath && range) {
      let seen = state.readRanges.get(observation.targetPath)
      if (!seen) { seen = new Set(); state.readRanges.set(observation.targetPath, seen) }
      const rangeKey = readRangeKey(range)
      if (!seen.has(rangeKey)) {
        seen.add(rangeKey)
        progress.push(`读了新的区间（${rangeKey}）`)
      }
      if (seen.size > 256) seen.delete(seen.keys().next().value)
    }

    // ── 信号 3：结果指纹是新的（错误信息变了也算新定位）──
    const resultPrint = observation.result ? resultFingerprint(observation.result) : ''
    if (observation.result) {
      if (!state.resultPrints.has(resultPrint)) {
        state.resultPrints.add(resultPrint)
        progress.push(observation.result.isError ? '出现了新的失败定位' : '得到了新的结果')
        if (state.resultPrints.size > FINGERPRINT_LIMIT) {
          state.resultPrints.delete(state.resultPrints.values().next().value)
        }
      }
    }

    // ── 计数 ──
    const repeatCount = (state.calls.get(fingerprint) ?? 0) + 1
    state.calls.set(fingerprint, repeatCount)
    if (state.calls.size > FINGERPRINT_LIMIT) state.calls.delete(state.calls.keys().next().value)

    // ── P2-2：「结果停滞」的独立判据（与下面的 stalledByRepeat 分开）──
    // 那条要求同一 call 累计很多次且全程没有新证据；这条只看最近连续几次
    // 是不是同一对 call+result 原样重复 —— 等构建 / 轮询只变时间戳时更快认出来。
    if (resultPrint && state.lastPairCall === fingerprint && state.lastPairResult === resultPrint) {
      state.lastPairCount += 1
    } else {
      state.lastPairCall = resultPrint ? fingerprint : ''
      state.lastPairResult = resultPrint
      state.lastPairCount = resultPrint ? 1 : 0
    }

    let failureRepeat = 0
    if (failureSignature) {
      const entry = state.failures.get(failureSignature)
        ?? { count: 0, class: errorClass, firstAt: now, lastAt: now }
      entry.count += 1
      entry.lastAt = now
      state.failures.set(failureSignature, entry)
      if (state.failures.size > FINGERPRINT_LIMIT) state.failures.delete(state.failures.keys().next().value)
      failureRepeat = entry.count
    }

    const madeProgress = progress.length > 0
    if (madeProgress) {
      state.lastProgressAt = now
      state.lastProgressReason = progress.join('；')
      this.stats.progressEvents++
      this.capabilities?.markObserved?.('progressWatch', state.lastProgressReason)
    }

    // ── 无进展判定：同一失败签名重复，或同一调用原样重复 ──
    const threshold = Number(config.progressFailureThreshold) > 0 ? Number(config.progressFailureThreshold) : 3
    const stalledByFailure = failureRepeat >= threshold
    // 成功的原样重复要宽容得多：轮询、采样、等构建都可能是正当的。
    const stalledByRepeat = !failureSignature && repeatCount >= Math.max(threshold * 3, 6) && !madeProgress
    // P2-2：成功路径上的「结果停滞」—— 同一对 call+result 连续 N 次（默认 3；生态 agent-loop-guard 是 2）。
    const stagnationThreshold = Number(config.progressStagnationThreshold) > 0
      ? Number(config.progressStagnationThreshold) : 3
    const stalledByStagnation = !failureSignature && state.lastPairCount >= stagnationThreshold
    const stalled = stalledByFailure || stalledByRepeat || stalledByStagnation
    const stallKind = stalledByFailure ? 'same-failure' : stalledByRepeat ? 'same-call' : stalledByStagnation ? 'stalled-result' : ''

    if (stalled) {
      this.stats.stalledEvents++
      this.onEvent?.({
        kind: 'no-progress',
        sessionId: String(observation.sessionId),
        detail: `${stallKind} ×${stalledByFailure ? failureRepeat : repeatCount}：${observation.name}`,
      })
    }

    // 对外只暴露一个「重复了几次」：失败看失败签名，停滞看配对，其余看调用次数。
    const stallCount = stalledByFailure ? failureRepeat : stalledByStagnation ? state.lastPairCount : repeatCount
    const notice = stalled && config.progressWatch !== false
      ? this.#notice(state, stallKind, observation, { errorClass, failureRepeat, repeatCount: stallCount, threshold, config, now })
      : null

    return {
      progress: madeProgress,
      reason: madeProgress ? progress.join('；') : '没有新证据',
      stalled,
      stallKind,
      repeatCount: stalledByFailure ? failureRepeat : stalledByStagnation ? state.lastPairCount : repeatCount,
      errorClass,
      notice,
    }
  }

  /** 记一条"已确认的新证据"（evidence_record 成功、假设被否定等）。 */
  markEvidence(sessionId, reason) {
    const state = this.#state(sessionId)
    state.evidenceMarks += 1
    state.lastProgressAt = this.clock.now()
    state.lastProgressReason = String(reason ?? '记录了一条新读数')
    this.stats.progressEvents++
  }

  /** 记一次"假设被否定"—— 这算进展，不是失败。 */
  markHypothesisNegated(sessionId, hypothesis) {
    const state = this.#state(sessionId)
    state.hypothesesNegated += 1
    state.lastProgressAt = this.clock.now()
    state.lastProgressReason = `假设被否定：${String(hypothesis ?? '').slice(0, 120)}`
    this.stats.progressEvents++
  }

  /** 一次模型回复过去了（用于阶段预算）。 */
  countReply(sessionId) {
    const state = this.#state(sessionId)
    state.replies += 1
    return state.replies
  }

  /** 冷却 + 预算：决定这次要不要真的发提醒，以及发什么。 */
  #notice(state, stallKind, observation, meta) {
    const kind = stallKind
    // ⚠ 必须用 has() 判"从没提醒过"，不能用 `last ?? 0`：
    // 时钟从 0 开始时 `now - 0 = 0 < 冷却` 会把**第一条**提醒也吞掉。
    if (state.lastNoticeAt.has(kind) && meta.now - state.lastNoticeAt.get(kind) < NOTICE_COOLDOWN_MS) {
      this.stats.suppressed++
      return null
    }
    if (state.noticeCount >= NOTICE_BUDGET_PER_STAGE) {
      // 预算用完了：不再逐条累积成 user 消息，只留一条复盘。
      this.stats.budgetExhausted++
      return null
    }
    state.lastNoticeAt.set(kind, meta.now)
    state.noticeCount += 1
    this.stats.notices++

    const hint = ERROR_CLASS_HINTS[meta.errorClass] ?? ''
    const target = observation.targetPath ? `\n  目标：${String(observation.targetPath).slice(0, 140)}` : ''
    if (stallKind === 'same-failure') {
      return `[warden] 同一个失败已经原样出现 ${meta.failureRepeat} 次（类别：${meta.errorClass || '未分类'}）。`
        + `原地重试第 ${meta.failureRepeat + 1} 次不会得到不同结果。\n`
        + `  调用：${String(observation.name)}${target}\n`
        + (hint ? `  这类错误的正确做法：${hint}\n` : '')
        + `  请换一条**具体**的路：改假设、换工具、换执行面，或把这个阻塞报给用户。`
        + `不要"先把整个文件重读一遍"——那只会让上下文更满。`
    }
    return `[warden] 同一条调用已经原样执行 ${meta.repeatCount} 次，且没有产生任何新证据。`
        + `\n  调用：${String(observation.name)}${target}\n`
        + `  如果它是在等一个外部结果（构建、部署、子任务），请改用带期限的等待或去查状态，`
        + `而不是反复重发；如果它本该产生新信息，说明这条路已经走到头了，换一个方法。`
  }

  /** 阶段预算：到点只触发复盘，不自动成功、不自动放弃。 */
  budgetCheck(sessionId, config = {}) {
    const state = this.#state(sessionId)
    const now = this.clock.now()
    const elapsed = now - state.stageStartedAt
    const budgetMs = Number(config.taskBudgetMs) > 0 ? Number(config.taskBudgetMs) : 600_000
    const budgetReplies = Number(config.taskBudgetReplies) > 0 ? Number(config.taskBudgetReplies) : 30
    const byTime = elapsed >= budgetMs
    const byReplies = state.replies >= budgetReplies
    if (!byTime && !byReplies) return { due: false }
    return {
      due: true,
      reason: byTime && byReplies ? '时间与回复数都到线' : byTime ? '时间到线' : '回复数到线',
      elapsedMs: elapsed,
      replies: state.replies,
      lastProgressReason: state.lastProgressReason,
      sinceLastProgressMs: now - state.lastProgressAt,
      text: `[warden] 阶段预算到线（${byTime ? `已用 ${Math.round(elapsed / 60000)} 分钟` : ''}`
        + `${byTime && byReplies ? '、' : ''}${byReplies ? `${state.replies} 次模型回复` : ''}）。\n`
        + `这**不是**失败判定，也不是可以收工的信号 —— 只是一次复盘提醒。请只回三件事：\n`
        + `  ① 新的证据（最后一次有效进展：${state.lastProgressReason}）；\n`
        + `  ② 还剩哪些**必需**项没验；\n`
        + `  ③ 下一个方法是什么。\n`
        + `如果确实需要更长时间，说明理由后继续 —— 复杂任务可以扩大预算，但要先写清楚为什么。`,
    }
  }

  /** 无活动时长（给 S5 的"疑似无响应"用；有活动就不算无响应）。 */
  idleFor(sessionId) {
    const state = this.#state(sessionId)
    return this.clock.now() - state.lastProgressAt
  }

  /** 某会话的观察快照。 */
  snapshot(sessionId) {
    const state = sessionId === undefined
      ? null
      : this.sessions.get(String(sessionId))
    if (!state) {
      return [...this.sessions.values()].map((s) => this.#shape(s))
    }
    return this.#shape(state)
  }

  #shape(state) {
    return {
      sessionId: state.sessionId,
      stageId: state.stageId,
      replies: state.replies,
      evidenceMarks: state.evidenceMarks,
      hypothesesNegated: state.hypothesesNegated,
      lastProgressReason: state.lastProgressReason,
      lastProgressAt: state.lastProgressAt,
      idleMs: this.clock.now() - state.lastProgressAt,
      noticeCount: state.noticeCount,
      distinctCalls: state.calls.size,
      distinctFailures: state.failures.size,
    }
  }

  /** 开一个新阶段：清掉计数，但保留"已经见过的文件指纹"。 */
  startStage(sessionId, stageId) {
    const state = this.#state(sessionId)
    state.stageId = String(stageId ?? 'default')
    state.calls.clear()
    state.failures.clear()
    state.resultPrints.clear()
    state.replies = 0
    state.noticeCount = 0
    state.lastPairCall = ''
    state.lastPairResult = ''
    state.lastPairCount = 0
    state.lastNoticeAt.clear()
    state.stageStartedAt = this.clock.now()
    state.lastProgressAt = state.stageStartedAt
    state.lastProgressReason = '阶段开始'
  }
}

function shortId(hash) {
  return String(hash ?? '').slice(0, 12)
}

function errorTextOf(result) {
  if (!result) return ''
  const parts = []
  if (result.error?.message) parts.push(String(result.error.message))
  const content = result.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * 阶段合同台账（追加式落盘）。
 *
 * 落盘是为了跨重启能接上："我上一阶段做到哪、还差哪些必需项"。
 * 写失败**必须报失败** —— 收工合同写不下去还宣称完成，比没有合同更糟。
 */
export class StageLedger {
  /**
   * @param {string} [home]
   * @param {{clock?: any, log?: any, capabilities?: any, onEvent?: (e: object) => void}} [deps]
   */
  constructor(home = resolveDshHome(), deps = {}) {
    this.home = home
    this.paths = pluginPaths(home)
    this.clock = deps.clock ?? systemClock()
    this.log = deps.log ?? null
    this.capabilities = deps.capabilities ?? null
    this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null
  }

  /**
   * 写一条阶段记录。
   *
   * @returns {{ok: true, row: object}|{ok: false, reason: string}}
   */
  record(entry) {
    const now = this.clock.now()
    const acceptance = Array.isArray(entry.acceptance)
      ? entry.acceptance.slice(0, 40).map((item) => ({
        item: String(item.item ?? item ?? '').slice(0, 200),
        verified: item.verified === true,
        evidence: String(item.evidence ?? '').slice(0, 300),
      }))
      : []
    const row = {
      at: new Date(now).toISOString(),
      sessionId: String(entry.sessionId ?? ''),
      stageId: String(entry.stageId ?? 'default'),
      goal: String(entry.goal ?? '').slice(0, 400),
      acceptance,
      sourceIdentity: String(entry.sourceIdentity ?? '').slice(0, 300),
      deployTarget: String(entry.deployTarget ?? '').slice(0, 200),
      hypothesis: String(entry.hypothesis ?? '').slice(0, 400),
      newEvidence: String(entry.newEvidence ?? '').slice(0, 600),
      nextStep: String(entry.nextStep ?? '').slice(0, 400),
      resourceClaims: Array.isArray(entry.resourceClaims) ? entry.resourceClaims.slice(0, 20).map(String) : [],
      requiredRemaining: Array.isArray(entry.requiredRemaining) ? entry.requiredRemaining.slice(0, 40).map(String) : [],
      planRef: String(entry.planRef ?? ''),
      status: STAGE_STATUSES.includes(entry.status) ? entry.status : 'in-progress',
      id: shortId(sha256Hex(`${now}:${entry.sessionId}:${entry.stageId}:${entry.goal}`)),
    }

    // ── R8 的硬门槛：缺必需项不许 complete ──
    if (row.status === 'complete') {
      const problems = validateComplete(row)
      if (problems.length > 0) {
        return {
          ok: false,
          reason: `不能标成 complete：${problems.join('；')}。`
            + `请改成 conditional-complete（有条件完成）/ blocked（等人）/ failed，并写清缺什么。`,
          problems,
          row,
        }
      }
    }

    try {
      mkdirSync(this.paths.dir, { recursive: true })
      appendFileSync(this.paths.stages, `${JSON.stringify(row)}\n`, 'utf8')
    } catch (error) {
      this.capabilities?.markDegraded?.('stageContract', `阶段记录写入失败：${error?.message ?? error}`)
      return { ok: false, reason: `阶段记录写入失败，这条收工合同**没有落盘**：${error?.message ?? error}` }
    }
    this.capabilities?.markObserved?.('stageContract', `${row.stageId} → ${row.status}`)
    this.onEvent?.({ kind: 'stage', sessionId: row.sessionId, detail: `${row.stageId} → ${row.status}` })
    return { ok: true, row }
  }

  /** 某会话最近的阶段记录。 */
  latest(sessionId, limit = 200) {
    const rows = this.list(limit)
    if (sessionId === undefined) return rows[0] ?? null
    return rows.find((row) => row.sessionId === String(sessionId)) ?? null
  }

  list(limit = 200) {
    try {
      const text = readFileSync(this.paths.stages, 'utf8')
      const rows = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
      }
      return rows.slice(-limit).reverse()
    } catch {
      return []
    }
  }

  stats() {
    const rows = this.list(2000)
    const byStatus = {}
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    return { total: rows.length, byStatus }
  }
}

/**
 * `complete` 的门槛。返回空数组表示可以收工。
 *
 * 判据刻意保守：**没有验收项**、**有验收项没验**、**还有必需项没做**
 * 三种情况都不许 complete。
 */
export function validateComplete(row) {
  const problems = []
  if (!Array.isArray(row.acceptance) || row.acceptance.length === 0) {
    problems.push('没有列任何验收项（"做完了"不是验收项）')
  } else {
    const unverified = row.acceptance.filter((item) => item.verified !== true)
    if (unverified.length > 0) {
      problems.push(`${unverified.length} 个验收项还没有依据：${unverified.map((i) => i.item).slice(0, 3).join('、')}`)
    }
    const noEvidence = row.acceptance.filter((item) => item.verified === true && !item.evidence)
    if (noEvidence.length > 0) {
      problems.push(`${noEvidence.length} 个验收项标了已验但没写依据`)
    }
  }
  if (Array.isArray(row.requiredRemaining) && row.requiredRemaining.length > 0) {
    problems.push(`还有 ${row.requiredRemaining.length} 项必需项未完成：${row.requiredRemaining.slice(0, 3).join('、')}`)
  }
  if (!row.sourceIdentity) problems.push('没有记录源码身份（无法判断验收的是哪一版）')
  return problems
}
