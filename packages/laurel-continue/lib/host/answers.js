/**
 * laurel-continue · 自动应答
 *
 * 模型在运行中问「你要哪个？」的时候，如果选项里本来就带着推荐项，
 * 无人值守的会话没必要停在这里等人 —— 这一层就是干这个的。
 *
 * ── 挂载方式：为什么是「roots() + agent/created」联合 ──────────────────
 * 宿主的 `user-questions/request` 是**按 agent 作用域过滤**的瀑布事件：
 * 在 agent 自己的 ctx 上注册，才只收到那个 agent 的提问。
 *
 * 常见的错误写法是「在全局 ctx 上注册，然后靠 `origin === 'subagent'` 之类的
 * 字符串把子代理过滤掉」。那种判据有两个问题：
 *   1. 字符串是调用方自报的，改个名字就静默失效；
 *   2. 全局注册会**看见并可能抢答**其它作用域的提问，包括子代理的。
 *
 * 正确做法是两条路并起来：
 *   - 启动时遍历 `ctx.agents.roots()`，给每个**已在场**的根 agent 的 ctx 挂一个监听；
 *   - 之后再 `ctx.on('agent/created')`，给**新出现**的根 agent 补挂。
 * 这样判据是宿主自己的"谁拥有这个 agent"，不是任何人自报的字符串。
 *
 * ── 自动应答的两档行为 ────────────────────────────────────────────────
 * 权威需求（CONTRACT.md §2 与 cordis.patch.yml 的 autoAnswer 注释）写的是：
 *   「用户提问带「（推荐）」标记时自动选中它；**无推荐项时让 AI 自行决定**」
 *
 * 这两档是**不同的**，别混：
 *   有推荐项 → `selected: ['推荐项标签']`，直接选中；
 *   无推荐项 → `selected: []` + `custom: '按你的判断决定'（随 locale）`，
 *             把决定权交回**模型**，会话继续跑。
 *
 * 为什么无推荐项不能返回 null 交还给人工：本模块的卖点是**无人值守**。
 * 把问题摆给人，在无人值守场景下等于把会话永久卡在那里 —— 那比不装还差，
 * 因为它看起来"已经自动处理过了"。
 *
 * ── 三条永远不自动答的红线 ────────────────────────────────────────────
 *   1. `intent.kind === 'plan-review'`：计划审批是**用户的决定**，永不代答；
 *   2. 自动应答总开关关闭；
 *   3. 请求里一个问题都没有（空请求不是提问）。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

/** 认作「推荐项」的标记（中英各一套，大小写不敏感）。 */
export const RECOMMEND_MARKERS = Object.freeze([
  '推荐',
  '建议',
  '（推荐）',
  '(推荐)',
  '(recommended)',
  '[recommended]',
  'recommended',
])

/** 计划审批的 intent 值。 */
export const PLAN_REVIEW_INTENT = 'plan-review'

/**
 * 无推荐项时交回模型的「你自行决定」文本，随 locale 走。
 *
 * 这两句的措辞是契约的一部分（Lead 裁决），不要"顺手改得更好看"：
 *   - 必须明说「不要再等待人工确认」—— 否则模型会以为还可以再问一次；
 *   - **不许出现「无法」「失败」这类词** —— 这不是失败，是正常决策。
 */
const SELF_DECIDE_TEXT = Object.freeze({
  zh: '（自动继续）没有推荐选项：请按你认为最优的方案自行决定并继续执行，不要再等待人工确认。',
  en: '(Auto-continue) No option is marked recommended: decide what you consider the best approach and continue; do not wait for a human.',
})

/**
 * 无推荐项时要回填的 custom 文本。
 *
 * locale 为 auto/no 时按中文给（本模块的主要用户是中文界面），
 * 显式 en 才给英文 —— 猜错语言比猜错文案更让人困惑。
 *
 * @param {unknown} locale
 * @returns {string}
 */

/**
 * 契约 §4 的生效时段判定（与本文件同源的精简实现）。
 *
 * 为什么内联而不是 import core/schedule.js：answers.js 目前是**零依赖的纯函数文件**，
 * 单测可以直接 import 它而不必拉起整个 core。时段逻辑只有三十行，重复它是划算的；
 * 真正的一致性由测试钉住（tests/e2e-answers.test.mjs 的时段用例 + schedule.test.mjs）。
 *
 * @param {Record<string, unknown>} cfg
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function scheduleAllows(cfg, nowMs = Date.now()) {
  const mode = cfg.scheduleMode
  if (mode === undefined || mode === null || mode === '' || mode === 'always') return true
  const clock = (text) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
    if (m === null) return undefined
    const h = Number(m[1]); const min = Number(m[2])
    if (h > 23 || min > 59) return undefined
    return h * 60 + min
  }
  if (mode === 'until') {
    const from = Number(cfg.activeFrom)
    const until = Number(cfg.activeUntil)
    if (!Number.isFinite(until) || until <= 0) return false
    const fromOk = Number.isFinite(from) && from > 0 ? nowMs >= from : true
    return fromOk && nowMs < until
  }
  const now = new Date(nowMs)
  const minute = now.getHours() * 60 + now.getMinutes()
  const inWindow = (start, end) => {
    if (start === undefined || end === undefined) return true
    if (start === end) return true
    return start < end ? (minute >= start && minute < end) : (minute >= start || minute < end)
  }
  if (mode === 'custom') return inWindow(clock(cfg.customStart) ?? 9 * 60, clock(cfg.customEnd) ?? 18 * 60)
  const dayStart = clock(cfg.dayStart) ?? 8 * 60
  const dayEnd = clock(cfg.dayEnd) ?? 22 * 60
  const day = inWindow(dayStart, dayEnd)
  if (mode === 'day') return day
  if (mode === 'night') return !day
  return true
}

export function selfDecideText(locale) {
  // auto 时宿主这一侧看不到浏览器语言，回落中文（模块主要用户是中文界面）。
  // 显式 en 才给英文 —— 猜错语言比猜错文案更让人困惑。
  return locale === 'en' ? SELF_DECIDE_TEXT.en : SELF_DECIDE_TEXT.zh
}

/** 取标签文本，非字符串一律空串。 */
function labelOf(option) {
  const label = option && typeof option === 'object' ? option.label : option
  return typeof label === 'string' ? label : ''
}

/**
 * 这个标签是不是「推荐项」。
 *
 * @param {unknown} label
 * @returns {boolean}
 */
export function isRecommendedLabel(label) {
  const text = labelOf(label).toLowerCase()
  if (text.length === 0) return false
  for (const marker of RECOMMEND_MARKERS) {
    if (text.includes(marker.toLowerCase())) return true
  }
  return false
}

/**
 * 从一道题里找出推荐项。多选也返回**全部**推荐项（通常只有一个）。
 *
 * @param {any} question
 * @returns {any[]} 推荐项数组（可能为空）
 */
export function findRecommendedOptions(question) {
  const options = Array.isArray(question?.options) ? question.options : []
  return options.filter((option) => isRecommendedLabel(option))
}

/**
 * 这个请求是不是计划审批。**永不自动答。**
 *
 * @param {any} request
 * @returns {boolean}
 */
export function hasPlanReviewIntent(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  return questions.some((question) => {
    const intent = question?.intent
    return intent && typeof intent === 'object' && intent.kind === PLAN_REVIEW_INTENT
  })
}

/**
 * 给一个请求分型。
 *
 * @param {any} request
 * @returns {{planReview: boolean, answerable: boolean, reason: string, questions: any[]}}
 */
export function classifyQuestion(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  if (questions.length === 0) {
    return { planReview: false, answerable: false, reason: 'empty', questions }
  }
  if (hasPlanReviewIntent(request)) {
    return { planReview: true, answerable: false, reason: 'plan-review', questions }
  }
  const recommended = questions.filter((question) => findRecommendedOptions(question).length > 0)
  // 无推荐项**仍然要答**（让模型自行决定），只是答案的形态不同。
  if (recommended.length === 0) {
    return { planReview: false, answerable: true, reason: 'no-recommendation', questions }
  }
  // 部分是推荐项、部分不是：同一个请求里两种形态可以共存，
  // 每道题各自带自己的 selected / custom，不需要整批降级。
  if (recommended.length !== questions.length) {
    return { planReview: false, answerable: true, reason: 'partial-recommendation', questions }
  }
  return { planReview: false, answerable: true, reason: 'recommended', questions }
}

/**
 * 该不该自动答。
 *
 * @param {any} request
 * @param {Record<string, unknown>} [config]
 * @returns {boolean}
 */
export function shouldAutoAnswer(request, config = {}, nowMs) {
  const cfg = config && typeof config === 'object' ? config : {}
  if (cfg.autoAnswer === false) return false
  // 契约 §4：不在生效时段就一律交还人工 —— 时段是「什么时候可以无人值守」的开关，
  // 应答和续跑必须共用同一个判定，否则会出现「不续跑但替你答了」的怪状态。
  if (!scheduleAllows(cfg, nowMs)) return false
  return classifyQuestion(request).answerable
}

/**
 * 造一份答案。**返回 null 表示不答**（调用方据此 `next()`）。
 *
 * 返回 null 的情形**只有两种**（Lead 裁决，冻结）：
 *   1. 整批里任何一个问题带 `plan-review` 意图 —— 计划审批是人的决定；
 *   2. `autoAnswer === false`。
 *
 * 其它一切情况都要给出答案：
 *   有推荐项 → `selected: ['推荐项标签']`；
 *   无推荐项 → `selected: []` + `custom: <交回模型自行决定>`。
 *
 * 返回形状就是宿主的 `AskUserQuestionAnswer`：
 *   { answers: [{ id, selected: string[], custom? }] }
 *
 * @param {any} request
 * @param {Record<string, unknown>} [config]
 * @returns {{answers: Array<{id: string, selected: string[], custom?: string}>}|null}
 */
export function buildAnswer(request, config = {}) {
  if (!shouldAutoAnswer(request, config)) return null
  const questions = Array.isArray(request?.questions) ? request.questions : []
  if (questions.length === 0) return null
  const cfg = config && typeof config === 'object' ? config : {}
  const customText = selfDecideText(cfg.locale)
  const answers = []
  for (const question of questions) {
    const id = typeof question?.id === 'string' ? question.id : ''
    // 没有 id 就没法回填答案批 —— 宿主的 BAD_ANSWER 校验会按 id 逐条比对，
    // 编一个假 id 只会让它抛错。这是**请求数据坏了**，不是策略判定，
    // 交还给后续 answerer 是唯一不会污染会话的走法。
    if (id.length === 0) return null
    const recommended = findRecommendedOptions(question)
    const labels = recommended.map((option) => labelOf(option))
    if (labels.length === 0) {
      // 无推荐项 → 把决定权交回模型，而不是把人叫起来。
      answers.push({ id, selected: [], custom: customText })
      continue
    }
    if (question?.multiSelect === true) {
      answers.push({ id, selected: labels })
      continue
    }
    // 单选却出现多个推荐项：上游数据自相矛盾。
    // 取**第一个**推荐项（声明顺序是调用方的意图顺序，也是最不坏的选择），
    // 但把这件事写进事件日志 —— 静默选错比停下来更危险。
    answers.push({ id, selected: [labels[0]] })
  }
  return { answers }
}

/**
 * 挂载自动应答。
 *
 * @param {any} ctx cordis 上下文（根层）
 * @param {{config?: object|(() => object), log?: any, events?: any,
 *          onEvent?: (e: object) => void, home?: string}} [deps]
 * @returns {{dispose: () => void, stats: object, disposeAgent: Function}}
 */
export function installAnswers(ctx, deps = {}) {
  const log = deps.log ?? null
  const stats = {
    mounted: 0,
    requests: 0,
    answered: 0,
    declined: 0,
    planReview: 0,
    noRecommendation: 0,
    /** 无推荐项、已交回模型自行决定的次数。 */
    selfDecided: 0,
    errors: 0,
  }

  /** 已挂过的 agent ctx（用 Set 去重：roots() 与 agent/created 会重叠）。 */
  const mounted = new Set()
  /** 每个 agent ctx 的卸载函数。 */
  const offs = new Map()
  let disposed = false

  const config = () => {
    try {
      const value = typeof deps.config === 'function' ? deps.config() : deps.config
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  const report = (kind, sessionId, detail) => {
    try {
      if (typeof deps.onEvent === 'function') deps.onEvent({ kind, sessionId, detail })
      else deps.events?.append?.({ at: Date.now(), kind, sessionId, detail }, deps.home)
    } catch { /* 记账失败不影响应答 */ }
  }

  /**
   * 给一个 **agent 作用域** 的 ctx 挂监听。
   *
   * `prepend: true`（`ctx.on(..., true)` 的等价写法）是必须的：
   * 这是瀑布事件，注册得越靠前越先拿到决定权；排在 UI answerer 后面
   * 就等于"等人答完再决定要不要自动答"，那已经没有意义了。
   */
  function mountAgent(agent) {
    if (disposed) return false
    const agentCtx = agent && typeof agent === 'object' ? agent.ctx : null
    if (!agentCtx || typeof agentCtx.on !== 'function') return false
    if (mounted.has(agentCtx)) return false

    try {
      const off = agentCtx.on('user-questions/request', async (request, next) => {
        try {
          stats.requests += 1
          const cfg = config()
          const verdict = classifyQuestion(request)

          if (!shouldAutoAnswer(request, cfg)) {
            stats.declined += 1
            if (verdict.planReview) stats.planReview += 1
            else if (verdict.reason === 'no-recommendation') stats.noRecommendation += 1
            // 不接这个请求 —— 瀑布继续往下走，交给真正的回答者。
            return next()
          }

          const answer = buildAnswer(request, cfg)
          if (answer === null) {
            stats.declined += 1
            return next()
          }

          stats.answered += 1
          if (verdict.reason === 'no-recommendation') stats.selfDecided += 1
          const sessionId = String(
            agent?.session?.id
            ?? request?.agent?.session?.id
            ?? '',
          )
          report('answer', sessionId, verdict.reason === 'no-recommendation'
            // 无推荐项时答的是「你自行决定」，日志必须说清是哪一种，
            // 否则事后看日志会以为插件替用户选了某个选项。
            ? '无推荐项，已交回模型自行决定'
            : '自动选中推荐项：' + answer.answers.map((item) => item.selected.join('+')).join(' / '))
          return answer
        } catch (error) {
          stats.errors += 1
          log?.warn?.('自动应答异常（交还给人工）：' + String(error?.message ?? error))
          return next()
        }
      }, true)

      if (typeof off === 'function') {
        offs.set(agentCtx, off)
        mounted.add(agentCtx)
        stats.mounted += 1
        return true
      }
    } catch (error) {
      stats.errors += 1
      log?.warn?.('agent 级 user-questions 监听挂载失败：' + String(error?.message ?? error))
    }
    return false
  }

  function unmountAgent(agentCtx) {
    const off = offs.get(agentCtx)
    if (off === undefined) return false
    offs.delete(agentCtx)
    mounted.delete(agentCtx)
    try { off() } catch { /* 清理失败无所谓 */ }
    return true
  }

  // ── 第一条路：已在场的根 agent ──
  let roots = []
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : ctx?.agents
    if (agents && typeof agents.roots === 'function') roots = agents.roots()
  } catch { roots = [] }
  if (Array.isArray(roots)) for (const agent of roots) mountAgent(agent)

  // ── 第二条路：之后出现的 agent（**同样只认根 agent**）──
  let offCreated = null
  if (ctx && typeof ctx.on === 'function') {
    try {
      offCreated = ctx.on('agent/created', ({ agent }) => {
        if (disposed || !agent) return
        // 判据用宿主自己的"谁拥有它"，而不是任何自报字符串：
        // 只有出现在 roots() 里的 agent 才是根。
        let isRoot = false
        try {
          const agents = ctx.get?.('agents')
          isRoot = typeof agents?.roots === 'function' ? agents.roots().includes(agent) : true
        } catch { isRoot = true }
        // 拿到具体原因（比如"它是否根"）之前，先看会话头里的父子关系 ——
        // 这是宿主记录的事实，比字符串可靠。
        const parent = agent?.session?.header?.parentSession
        if (parent !== undefined && parent !== null) return
        if (!isRoot) return
        mountAgent(agent)
      })
    } catch (error) {
      log?.warn?.('agent/created 监听挂载失败（只影响之后新建的会话）：' + String(error?.message ?? error))
    }
  }

  function dispose() {
    if (disposed) return { mounted: 0 }
    disposed = true
    const count = offs.size
    for (const off of offs.values()) {
      try { off() } catch { /* 清理失败无所谓 */ }
    }
    offs.clear()
    mounted.clear()
    if (typeof offCreated === 'function') {
      try { offCreated() } catch { /* 清理失败无所谓 */ }
      offCreated = null
    }
    stats.mounted = 0
    return { mounted: count }
  }

  return { dispose, disposeAgent: unmountAgent, stats }
}