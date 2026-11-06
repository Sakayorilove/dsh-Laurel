/**
 * dsh-warden · 上下文层（`agent/pre-step` + `systemPrompt.section`）
 *
 * ── 这一层现在只做三件事 ───────────────────────────────────────────────
 *
 * ① **子代理纪律（星型拓扑 + 结论落文件）** —— 写进系统提示词的独立 section。
 *    它是**规则**不是**拦截**，跟着每一轮请求走，压缩之后也还在，
 *    比每轮塞一条消息便宜得多。
 *
 * ② **水位提醒** —— 数据来自 `host/usage.js`（官方 `contextPressure` 投影
 *    优先，退化到 `session/event` 账本，都没有就明确显示 unknown）。
 *    只提醒，不删改历史。
 *
 * ③ **压缩兜底提醒（#4，每会话最多一次）** —— 2026-10-17 实测：官方
 *    `dsh-compaction-basic` 默认 `thresholdRatio = 0.8`（1M 窗口 = 80 万才压），
 *    当天峰值只有约 52 万，**一次没触发**。所以"等到水位高了官方会自己压"
 *    在这台机器上是错的假设：用户可能在等一次不会来的压缩。这一段独立于
 *    ②b 观测压力（水位提醒三档默认关，不能把状态寄存在那一段里），
 *    在"本会话还没观察到压力下降、且 ratio 已到 `compactionFallbackRatio`"时
 *    发一次提醒，给出写交接 / 开新会话 / 手动 `/compact` 三条具体动作。
 *
 * ── 已经删掉的第三件事：历史"微压缩"（R3）────────────────────────────
 * 旧版在这里筛 `decision.messages` 里 `role === 'tool'` 的消息并换成占位符。
 * 实读宿主 `dsh-agent-loop` 的 `preStep()`：
 *
 *     const claimed = this.inbox.claim(target, position.turn)
 *     const decision = await this.dispatch.waterfall("agent/pre-step",
 *       { messages: claimed, ...position, signal },
 *       () => Promise.resolve({ kind: "enter",
 *                               messages: context === undefined ? claimed : [...claimed, context] }))
 *
 * `messages` 是 **inbox 待追加的那一批新消息**（外加一条 runtime context），
 * 随后 `step()` 把它 append 成新的 user/message；完整历史要到 `buildRequest()`
 * 才从 session surface 构建。**这一层通常根本没有旧工具结果。**
 * 旧单测人为往这批里塞了 20 条历史 tool 消息，于是测过了一个生产不存在的输入。
 *
 * 而且占位符写的是"请重新执行那个工具" —— 部署、写文件、发网络请求都
 * **不可重放**，把它当默认找回手段是错的。
 *
 * 所以本版：
 *   - `microCompact` 在**所有档位默认关闭**，且这一层不再裁剪历史；
 *   - 历史压缩的唯一 owner 是官方 `dsh-compaction-basic`
 *     （它挂在 `agent/pre-step` 上做压力压缩、`agent/request-error` 上做溢出重试，
 *      配置走 `modelPolicies` / `retainTokens`）。warden 不插第二个 owner；
 *   - 单条超长结果由官方 `dsh-compaction-tool-result-pruner` 处理
 *     （`thresholdChars: 8192`，head+tail）；
 *   - warden 自己那一份改成对**新产生的**大文本结果做归档 + 有界呈现，
 *     见 `host/archive.js`（挂在 `tools/post-execute`，那才是结果进入
 *     surface 之前的位置）。
 *
 * 这一层的能力状态里会明确写 `historyPruning = unsupported`，
 * **不假装可用**。
 *
 * ── 契约（实读 0.2.0-rc.2 运行件核对过）───────────────────────────────
 *   `agent/pre-step` 是 waterfall：`(payload, next) => decision`。
 *   payload = `{ messages, turn, step, signal, agent }`
 *   （`agent` 由 `dsh-agent` 的 `agentEvents().fused()` 注入，官方
 *    `dsh-compaction-basic:839` 与 `dsh-agent:193` 都是这么解构的）。
 *   - 必须 `await next()` 拿到最终批次，再在它之上改
 *   - 改写时**必须 spread**：`{ ...decision, messages }`
 *   - 只在 `decision.kind === 'enter'` 上动手
 *
 *   `systemPrompt.section({ name, order, text, interpolate?, complete? })`
 *   - `order` 必须是有限数，否则 TypeError
 *   - `text` 可以是字符串**或**函数（`assemble()` 里
 *     `typeof section.text === "function" ? section.text(context) : section.text`）
 *   - 同一层重名会抛
 *   - 返回「the exact Cordis effect disposer」—— **只有这个返回值**能证明挂上了
 */

import { randomUUID } from 'node:crypto'
import { resolveContextLoad } from './usage.js'
import { budgetGate, budgetText } from '../core/cost.js'

/** 提醒消息的 source 标记。与 `host/after.js` 用同一个 kind，便于事后筛选。 */
const NOTICE_KIND = 'warden'
const RULES_SECTION = 'warden:rules'

/**
 * section 的排序值。
 *
 * `getSectionOrder('warden:rules')` 会返回 `undefined`（`SECTION_ORDERS` 里
 * 没有这个名字，实读其实现是 `return SECTION_ORDERS[name]`，不抛），
 * 而 `section()` 要求 `order` 必须是有限数 —— 所以这里显式兜底。
 * 取 650：排在官方 `PLAN_POLICY`(500) 与 `TEAM_POLICY`(600) 之后，
 * 因为这几条纪律本来就是团队/计划层面的补充。
 */
const DEFAULT_SECTION_ORDER = 650

/**
 * 官方 `dsh-compaction-basic` 的默认触发比例（窗口的 80%）。
 *
 * 实测来源：今天 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 compaction 的
 * `thresholdRatio` 默认 0.8；1M 窗口 = 80 万才压，而今天的峰值只有约 52 万。
 * 这个数只用于提醒文案里的"还差多少"，warden 不改官方配置。
 */
export const OFFICIAL_COMPACTION_RATIO = 0.8

/**
 * 星型拓扑 + 结论落文件的规则正文。
 *
 * 写得短是刻意的：这段会跟着**每一轮请求**走，多一个字就是多一分常驻成本。
 */
export function rulesText(config = {}) {
  const parts = []
  if (config.starTopology !== false) {
    parts.push(
      '## 子代理纪律（星型拓扑）\n'
      + '- 默认走星型：子代理**向主控汇报**，由主控转达。需要协作时把请求发给主控。\n'
      + '- **不要私自**给其他子代理发消息、也不要回复它们的私聊，更不要互相"更正（请以这条为准）"——'
      + '两个子代理互相纠错时，读数会互相污染，最后谁都说不清哪个数是谁测的。\n'
      + '- 例外：**经调度的**结构化协调是合法的。如果主控或运行时已经批准了计划、'
      + '给出了成员白名单和轮数上限，并由运行时转发跨组消息，那就按它的要求返回结构化协调请求，'
      + '不要因为这条纪律而拒绝输出。判据是"有没有经过批准与转发"，不是"有没有跟别人说话"。\n'
      + '- 派活给子代理时，必须写清三件事：**目标、输出格式、边界**（哪些不做）。'
      + '边界不写，子代理就会重复劳动或留空。',
    )
  }
  if (config.resultsToFile !== false) {
    parts.push(
      '## 子代理结论落文件\n'
      + '- 子代理的结论**写进文件**（例如 `probe/<角色名>.md`），只把**文件路径 + 一行摘要**回给主控。\n'
      + '- 不要把大段结论直接贴进对话 —— 那会让主控的上下文迅速膨胀，而且每次转述都会失真。',
    )
  }
  if (config.lockGuard !== false) {
    parts.push(
      '## 共享资源\n'
      + '- 动手写一个"大家都会用"的资源之前，先用 `acquire_lock` 取得执行权；拿不到会告诉你现在是谁占着。\n'
      + '- 能**物理隔离**就隔离（各自一个独立目录/分支），比排队等锁省时间得多。\n'
      + '- 隔离不了的资源（桌面、显示模式、部署目标、端口、数据库、全局开关）才用锁。\n'
      + '- 锁**只覆盖护栏认得的写入路径**；任意 shell 命令里看不出来的写入不在覆盖范围内，别把它当成全局强制。',
    )
  }
  if (config.evidenceLedger !== false) {
    parts.push(
      '## 读数要能归属\n'
      + '- 记录任何测量结果时，**同时绑定当时产物的指纹**（sha256）。\n'
      + '- 复核时先比指纹：对不上就**直接判这条读数作废**，不要事后人工排查"这是哪一版的数"。\n'
      + '- 没绑定产物、产物读不到、环境未知的读数一律是 `unverified`，**不是** `verified`。',
    )
  }
  if (config.archiveToolResults !== false) {
    parts.push(
      '## 大输出会被归档\n'
      + '- 很长的工具输出会被自动落盘，你只看到有界摘要 + 文件路径 + 指纹。\n'
      + '- 需要原文时**按路径和行区间去读**（宿主自带的读取工具就能读），不要重新执行那个工具 —— '
      + '写入、部署、网络请求这类操作重跑一次就有副作用。',
    )
  }
  if (parts.length === 0) return ''
  return `<!-- warden -->\n${parts.join('\n\n')}\n`
}

/**
 * 水位提醒正文。
 *
 * `load` 是 `resolveContextLoad()` 的结果 —— 一定带上 `basis`，
 * 拿不到窗口大小时**明确说不知道占比**，不编一个百分比。
 *
 * ── 为什么分"首次全文 / 之后一行"（2026-10-17 审计）───────────────
 * 旧版每次都发 203 字符全文。实测一天 142 条水位提醒 = 2.9 万字符**常驻**
 * 在历史里，而它**不改变任何行为**（压缩 owner 是官方 compaction-basic，
 * warden 只提醒）。同一条信息第 2 条起没有必要再重复全文。
 * 所以：每个会话第一次发全文（含如何收尾的建议），之后只发一行数字。
 */
export function waterLevelText(load, growth, options = {}) {
  const k = (n) => `${Math.round(Number(n) / 1000)}k`
  const head = load.ratio !== null && load.ratio !== undefined
    ? `[warden] 当前上下文压力约 ${k(load.pressureTokens)} token，占窗口 ${Math.round(load.ratio * 100)}%`
      + `（窗口 ${k(load.contextWindow)}）`
    : `[warden] 当前上下文压力约 ${k(load.pressureTokens)} token（读不到窗口大小，占比未知）`
  const growthPart = Number.isFinite(growth) && growth > 0 ? `，比上次提醒又长了 ${k(growth)}` : ''

  // 第 2 条起只发一行：不重复建议、不重复口径说明。
  if (options.compact === true) {
    const ratioPart = load.ratio !== null && load.ratio !== undefined
      ? ` / ${Math.round(load.ratio * 100)}%`
      : ''
    const growthShort = Number.isFinite(growth) && growth > 0 ? `（+${k(growth)}）` : ''
    return `[warden] 上下文压力 ${k(load.pressureTokens)}${ratioPart}${growthShort}。`
  }

  const basisNote = load.basis === 'session-event:last-usage'
    ? '\n（这个数取自最近一次请求上报的 usage，不是宿主的实时投影；宿主的压缩看不到它。）'
    : ''
  return `${head}${growthPart}。${basisNote}\n`
    + `继续硬撑下去，后面每一步都会更慢、更贵，而且模型更容易忘掉前面说过的话。\n`
    + `建议现在做一件事：把已经确定下来的结论/决定写进文件或长期记忆，然后\n`
    + `① 收尾当前这一件事，开一个新会话继续；或者 ② 用 \`/compact\` 主动压缩。\n`
    + `**不要**在上下文已经很满的时候再开一批新子代理。`
}

/**
 * 压缩兜底提醒正文（#4）。
 *
 * 只说三件事：现在的占比、官方阈值在哪、可以做的三件事。
 * **不写"继续硬撑会变慢"这类空话** —— 那是体感，不是这轮能拿出的证据；
 * 有证据的是"官方压缩要 80% 才动手，而你现在还没到"。
 */
export function compactionFallbackText(load, options = {}) {
  const k = (n) => `${Math.round(Number(n) / 1000)}k`
  const configured = Number(options.officialRatio)
  const officialRatio = Number.isFinite(configured) && configured > 0 && configured < 1
    ? configured
    : OFFICIAL_COMPACTION_RATIO
  const pressure = Number(load?.pressureTokens) || 0
  const window = Number(load?.contextWindow) || 0
  const ratioText = load?.ratio !== null && load?.ratio !== undefined
    ? `${Math.round(load.ratio * 100)}%`
    : '占比未知'
  const head = window > 0
    ? `[warden] 当前上下文压力约 ${k(pressure)} token（窗口 ${k(window)} 的 ${ratioText}）`
    : `[warden] 当前上下文压力约 ${k(pressure)} token（读不到窗口大小，占比未知）`
  const threshold = window > 0
    ? `官方 dsh-compaction-basic 默认要等到窗口的 ${Math.round(officialRatio * 100)}%`
      + `（约 ${k(window * officialRatio)} token）才动手，离现在的 ${k(pressure)} 还差约 `
      + `${k(Math.max(0, window * officialRatio - pressure))} token。\n`
      + `也就是说，这个会话很可能**撑不到它触发**就先撞上单次请求上限或超时。`
    : `官方 dsh-compaction-basic 默认要等到窗口的 ${Math.round(officialRatio * 100)}% 才动手，`
      + `但这里读不到窗口大小，折不出具体 token。\n`
      + `也就是说，这个会话可能**撑不到它触发**就先撞上单次请求上限或超时。`
  return `${head}。本会话还没观察到官方压缩发生过。\n`
    + `${threshold}\n`
    + '现在选一条做（就一条，不用都做）：\n'
    + '① 把已经确定下来的结论、决定、文件路径写进文件（或 `memory_handoff` 交接），然后开新会话继续；\n'
    + '② 直接开一个新会话，把"要接着做什么"写进第一句话；\n'
    + '③ 发 `/compact` 手动压缩当前会话。\n'
    + '（warden 只提醒，不替你压缩，也不改历史。）'
}

/**
 * 每会话的"压缩观测"状态（#4）。
 *
 * **必须独立于水位提醒**：`waterLevelNudge` 三档默认都是 `false`，
 * 把状态塞进 ②b 里等于功能上线即死。这里只做三件事：
 *   - 记本会话最近一次看到的压力（**per-session**，绝不跨会话比较 `used < previous`）；
 *   - `used < previous` 判为"压力下降"（官方压缩发生过，或会话被截断）→ `compactedOnce`；
 *   - 记住兜底提醒发过没有（每会话最多一次）。
 *
 * 纯状态机，不碰 cordis，方便单测。
 */
export function createCompactionTracker() {
  /** @type {Map<string, {previous: number|null, compactedOnce: boolean, sent: boolean}>} */
  const state = new Map()
  const entry = (sessionId) => {
    const key = String(sessionId ?? '')
    let row = state.get(key)
    if (!row) {
      row = { previous: null, compactedOnce: false, sent: false }
      state.set(key, row)
    }
    return row
  }
  return {
    /**
     * 记一次压力观测。
     * @returns {{previous: number|null, dropped: boolean}} 首次观测时 previous=null。
     */
    observe(sessionId, used) {
      const row = entry(sessionId)
      const value = Number(used)
      if (!Number.isFinite(value)) return { previous: row.previous, dropped: false }
      const previous = row.previous
      const dropped = previous !== null && value < previous
      if (dropped) row.compactedOnce = true
      row.previous = value
      return { previous, dropped }
    },
    compactedOnce: (sessionId) => entry(sessionId).compactedOnce,
    sent: (sessionId) => entry(sessionId).sent,
    /** 现在该不该发：本会话没观察到压缩过，且还没发过。 */
    shouldNotify(sessionId) {
      const row = entry(sessionId)
      return !row.compactedOnce && !row.sent
    },
    markSent(sessionId) { entry(sessionId).sent = true },
    snapshot(sessionId) { return { ...entry(sessionId) } },
    clear() { state.clear() },
  }
}

/** 造一条提醒消息。 */
export function createNotice(text, summary) {  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NOTICE_KIND, form: 'notice', summary: String(summary ?? '').slice(0, 60) },
  }
  try { return structuredClone(message) } catch { return message }
}

/** 取服务：拿不到返回 null，不抛。 */
function requireService(ctx, name) {
  try { return ctx.get?.(name) ?? null } catch { return null }
}

/**
 * 把规则挂进系统提示词。
 *
 * @returns {{dispose: () => void}|null} 只有拿到**这次注册返回的确切句柄**才返回非 null。
 */
function installRulesSection(ctx, deps) {
  const systemPrompt = requireService(ctx, 'systemPrompt')
  if (!systemPrompt?.section) {
    deps.capabilities?.markUnsupported?.('rulesSection', '宿主没有 systemPrompt.section')
    return null
  }
  deps.capabilities?.markSupported?.('rulesSection', 'systemPrompt.section 可用')
  try {
    const order = (() => {
      const value = systemPrompt.getSectionOrder?.(RULES_SECTION)
      return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SECTION_ORDER
    })()
    const disposer = systemPrompt.section({
      name: RULES_SECTION,
      order,
      text: () => rulesText(deps.config?.() ?? {}),
    })
    if (typeof disposer !== 'function') {
      deps.capabilities?.markDegraded?.('rulesSection', 'section() 没有返回卸载句柄')
      return null
    }
    deps.capabilities?.markMounted?.('rulesSection', disposer, `order=${order}`)
    return { dispose: disposer }
  } catch (error) {
    // 重名（重载时上一份没卸干净）也走到这里 —— 明确报出来，不静默。
    deps.capabilities?.markDegraded?.('rulesSection', `section 注册失败：${error?.message ?? error}`)
    deps.log?.warn?.(`系统提示词 section 挂载失败（改用消息注入兜底）：${error?.message ?? error}`)
    return null
  }
}

/**
 * 挂上上下文层。返回卸载函数。
 *
 * @param {any} ctx cordis 上下文
 * @param {{config: () => any, home: string, log?: any, capabilities?: any,
 *          ledger?: any, onEvent?: (e: object) => void}} deps
 */
export function installInjection(ctx, deps) {
  if (typeof ctx?.on !== 'function') {
    deps.capabilities?.markUnsupported?.('waterLevelNudge', '拿不到 ctx.on')
    return null
  }
  const disposers = []
  const stats = {
    nudge: 0, ruleFallback: 0, steps: 0, loadUnknown: 0, budgetNotices: 0, costUnknown: 0,
    fallbackNotices: 0,
  }

  // 历史压缩：明确标不支持，不假装可用（R3）。
  deps.capabilities?.markUnsupported?.(
    'historyPruning',
    'warden 不裁剪历史；唯一 owner 是官方 dsh-compaction-basic（+ tool-result-pruner 治单条超长）',
  )

  /* ---------- ① 系统提示词里的规则（主通道） ---------- */
  // ⚠ 这个句柄必须**单独**记。旧版把它和 llm/stream、pre-step 的监听器
  // 一起塞进同一个 disposers 数组，然后用 `disposers.length > 0` 判断
  // "section 挂上了" —— section 注册抛错时那个判断依然为真，兜底永远不触发。
  let sectionHandle = null
  try {
    sectionHandle = installRulesSection(ctx, deps)
    if (sectionHandle) disposers.push(sectionHandle.dispose)
  } catch (error) {
    deps.capabilities?.markDegraded?.('rulesSection', `规则 section 挂载异常：${error?.message ?? error}`)
  }

  /* ---------- ② 每步：水位提醒 + 规则兜底 ---------- */
  const lastNudgeTokens = new Map()
  /** 已经发过全文水位提醒的会话：之后只发一行数字。 */
  const nudgeSentOnce = new Set()
  /** 已经发过花费提醒的会话 → 当时金额（用来判断"又翻倍了"才再提醒）。 */
  const budgetNoticeAt = new Map()
  /** 已经发过的阶段预算提醒（sessionId|reason），每个原因只发一次。 */
  const budgetNudged = new Set()
  const ruleInjected = new Set()
  /**
   * #4 压缩兜底：每会话的"上次压力 / 是否压缩过 / 是否已提醒"。
   * 独立于水位提醒的 `lastNudgeTokens` —— 那段默认关，状态不能寄存在那里。
   */
  const compaction = createCompactionTracker()
  // 治理仲裁（K1 / R9-A）：水位提醒在套件里有两个实现，
  // 判给别人时这里置 false，section 规则照常下发，但不再发水位提醒。
  let waterLevelOwned = true
  /**
   * 压缩兜底提醒是否由 warden 发（2026-10-23 新增）。
   *
   * 背景：用户报「内耗护栏和上下文压缩功能重复」。查证后确认：
   * warden 的 `compactionFallback` 在「压力到线 + 官方压缩没发生」时插提醒，
   * 而 `laurel-context` 干的就是**真去压缩**。两者判同一个 ratio → 真重复。
   *
   * 仲裁规则（与 waterLevelNudge 同一套治理声明机制）：
   *   · `laurel-context` 在跑（winning the `compactionNudge` claim）→ 它真能压，
   *     warden 不再发「该压缩了」的提醒 —— 否则用户会先收到"该压缩"再收到"已压缩"。
   *   · 只有 warden（没装 laurel-context）→ 兜底提醒照旧发，这是它存在的理由。
   *
   * 默认 `true`：没有仲裁调用时保持旧行为（单独装 warden 的用户不受影响）。
   */
  let compactionNudgeOwned = true

  const handler = async (payload, next) => {
    let decision = await next()
    try {
      const config = deps.config?.() ?? {}
      if (config.enabled === false) return decision
      if (decision?.kind !== 'enter') return decision

      const agent = payload?.agent
      const session = agent?.session
      if (!session) return decision
      const sessionId = String(session.id ?? '')
      if (!sessionId) return decision
      const workspace = session.header?.cwd ?? ''
      stats.steps++

      // ── ②0 用户插话 → 重置「同一目标重复」计数（P2-1，2026-10-24）──
      //
      // 官方 repeat-tool-reminder 在 agent/pre-step 里看到 source.kind===user 就清链：
      // 「A user interjection changes the context; repetition across it is not a loop.」
      // 这边原来 Counters.reset() 有定义但全库 0 调用点，所以用户插一句「换个方向」之后，
      // 之前的重复计数还压着，第二次改同一文件就误报。
      //
      // ⚠ 两个必须避开的坑：
      //   1. warden 自己注入的提醒也是 role=user —— 不排除等于自己给自己重置
      //      （timeline.js 记过：232 条 user/message 里 151 条是 warden 自己注入的）。
      //   2. 判据要用 payload.messages（进来的新批次），不是 decision.messages（我们刚插入的）。
      const incoming = Array.isArray(payload?.messages) ? payload.messages : []
      const realUserSpoke = incoming.some((m) => m?.role === 'user' && m?.source?.kind !== NOTICE_KIND)
      if (realUserSpoke && typeof deps.counters?.reset === 'function') {
        deps.counters.reset(sessionId)
        stats.userReset = (stats.userReset ?? 0) + 1
      }

      // ── ②a 规则兜底：只有在 section **确实没挂上**时才注入 ──
      if (sectionHandle === null && !ruleInjected.has(sessionId)) {
        const text = rulesText(config)
        if (text.length > 0) {
          const list = Array.isArray(decision.messages) ? decision.messages : []
          decision = { ...decision, messages: [...list, createNotice(text, 'warden rules')] }
          ruleInjected.add(sessionId)
          stats.ruleFallback++
          deps.capabilities?.markObserved?.('rulesFallback', `section 不可用，已注入消息 @${sessionId}`)
          deps.onEvent?.({ kind: 'rules-fallback', workspace, sessionId, detail: 'systemPrompt.section 未挂上，改用一次性消息注入' })
        }
      } else if (sectionHandle !== null) {
        deps.capabilities?.markObserved?.('rulesSection', `section 随请求下发 @${sessionId}`)
      }

      // ── ②a2 阶段预算（2026-10-17 审计：以前只在 warden_status 里算一次，
      //        等于装饰品。现在每步检查一次，到线只注入一条复盘，不阻断）──
      try {
        const due = deps.progress?.budgetCheck?.(sessionId, config)
        if (due?.due) {
          const budgetKey = `budget:${due.reason}`
          if (!budgetNudged.has(`${sessionId}|${budgetKey}`)) {
            budgetNudged.add(`${sessionId}|${budgetKey}`)
            const list = Array.isArray(decision.messages) ? decision.messages : []
            decision = { ...decision, messages: [...list, createNotice(due.text, 'stage budget')] }
            stats.budgetNotices = (stats.budgetNotices ?? 0) + 1
            deps.capabilities?.markObserved?.('stageContract', `阶段预算到线 @${sessionId}`)
            deps.onEvent?.({ kind: 'stage-budget', workspace, sessionId, detail: `${due.reason}；replies=${due.replies}` })
          }
        }
      } catch (error) {
        deps.capabilities?.markDegraded?.('stageContract', `阶段预算检查异常：${error?.message ?? error}`)
      }

      // ── ②b0 压力观测 + 压缩兜底提醒（#4）──
      // 这一段**不依赖水位提醒**：waterLevelNudge 三档默认 false，把状态塞进
      // ②b 里等于功能上线即死。观测本身不发消息，只更新每会话状态。
      const fallbackRatio = Number(config.compactionFallbackRatio) || 0
      let pressure = null
      if (fallbackRatio > 0 || (config.waterLevelNudge !== false && waterLevelOwned)) {
        try {
          pressure = resolveContextLoad(ctx, session, sessionId, deps.ledger)
        } catch (error) {
          deps.capabilities?.markDegraded?.('contextPressure', `读取上下文压力失败：${error?.message ?? error}`)
        }
      }
      // ── 2026-10-23 评审 P1-3c：观测与发送必须分开 ────────────────────────
      //
      // 旧代码把 `compaction.observe()` 一起关在 `compactionNudgeOwned` 这个 if 里面，
      // 与它自己下面注释写的「只让位发提醒、不让位观测」正好相反。后果是：
      // 被 laurel-context 抢占期间 warden **完全看不到压缩发生过**：
      //   ① 能力台账里 compactionFallback 长期停在「没有观测」；
      //   ② compactedOnce 一直是 false，一旦 context 退出、warden 重新拿到执行权，
      //      会对一个早已压过很多次的会话再发一次「该压缩了」。
      //
      // 现在：观测无条件跑（只要拿得到压力），只有「发不发那条提醒」看 compactionNudgeOwned。
      if (fallbackRatio > 0 && pressure) {
        try {
          if (!pressure.known) {
            // 读不到就明确 unknown，不发提醒、不编数字（也不冒充"已经压缩过"）。
            deps.capabilities?.markDegraded?.('compactionFallback', '读不到上下文压力，无法判断是否接近官方压缩阈值')
          } else {
            const used = Number(pressure.pressureTokens)
            // 观测：与「谁负责发提醒」无关，永远跑。
            const observed = compaction.observe(sessionId, used)
            if (observed.dropped) {
              // 压力变小 ⇒ 官方压缩（或会话被截断）确实发生过。之后不再兜底提醒。
              deps.capabilities?.markObserved?.(
                'compactionFallback',
                `观察到压力下降 ${observed.previous}→${used}，判定官方压缩已发生 @${sessionId}`,
              )
            }
            // 发送：只有本模块负责这件事时才发。
            // 2026-10-23 评审 P1-3b：`compactionNudgeOwned` 只在**挂载那一刻**被设一次，
            // 运行期被 laurel-context 抢占后没人再改它 → warden 会一直发「该压缩了」。
            // 所以这里额外做一次**限频活体复核**：governance.isActive 自带 2 秒限频
            // （GOVERNANCE_HEARTBEAT_MS），热路径上只是两次读内存，不会读盘。
            const stillMine = deps.governance?.isActive?.('compactionNudge') !== false
            const ratio = Number(pressure.ratio)
            if (compactionNudgeOwned && stillMine && Number.isFinite(ratio) && ratio >= fallbackRatio && compaction.shouldNotify(sessionId)) {
              const list = Array.isArray(decision.messages) ? decision.messages : []
              const text = compactionFallbackText(pressure)
              decision = { ...decision, messages: [...list, createNotice(text, 'compaction fallback')] }
              compaction.markSent(sessionId)
              stats.fallbackNotices = (stats.fallbackNotices ?? 0) + 1
              deps.capabilities?.markObserved?.(
                'compactionFallback',
                `ratio=${Math.round(ratio * 100)}% ≥ ${Math.round(fallbackRatio * 100)}%，`
                  + `本会话首次提醒且尚未观察到压缩 @${sessionId}`,
              )
              deps.onEvent?.({
                kind: 'compaction-fallback',
                workspace,
                sessionId,
                detail: `ratio=${Math.round(ratio * 100)}%; threshold=${Math.round(fallbackRatio * 100)}%;`
                  + ` pressure=${used}; ${pressure.contextWindow ? `window=${pressure.contextWindow}` : 'window=unknown'}`
                  + `; basis=${pressure.basis}; compactedOnce=false`,
              })
            }
          }
        } catch (error) {
          deps.capabilities?.markDegraded?.('compactionFallback', `压缩兜底提醒异常：${error?.message ?? error}`)
        }
      }

      // ── ②b 水位提醒 ──
      // 水位提醒同上：挂载期布尔 + 运行期限频活体复核（P1-3b 同源缺陷）。
      const waterLevelStillMine = deps.governance?.isActive?.('waterLevelNudge') !== false
      if (config.waterLevelNudge !== false && waterLevelOwned && waterLevelStillMine) {
        const load = pressure ?? resolveContextLoad(ctx, session, sessionId, deps.ledger)
        if (!load.known) {
          // 读不到就是读不到：记一次 unknown，不发提醒、不编数字。
          stats.loadUnknown++
          deps.capabilities?.markDegraded?.('contextPressure', `会话 ${sessionId} 读不到上下文压力（basis=unknown）`)
        } else {
          deps.capabilities?.markObserved?.('contextPressure', `basis=${load.basis} pressure=${load.pressureTokens}`)
          const used = load.pressureTokens
          const step = Number(config.waterLevelStep) || 50000
          const ratio = Number(config.waterLevelRatio) || 0
          const ratioTarget = ratio > 0 && load.contextWindow ? load.contextWindow * ratio : null
          const previous = lastNudgeTokens.get(sessionId) ?? 0
          const byStep = used - previous >= step
          const byRatio = ratioTarget !== null && used >= ratioTarget && previous < ratioTarget

          if (used < previous) {
            // 压力变小了（官方 Basic 压缩过 / 会话被截断）⇒ 重新起算，不提醒。
            lastNudgeTokens.set(sessionId, used)
          } else if (byStep || byRatio) {
            const list = Array.isArray(decision.messages) ? decision.messages : []
            // 每个会话第一次发全文，之后只发一行数字（见 waterLevelText 注释）。
            const firstFull = !nudgeSentOnce.has(sessionId)
            const text = waterLevelText(load, used - previous, { compact: nudgeSentOnce.has(sessionId) })
            if (firstFull) nudgeSentOnce.add(sessionId)
            decision = { ...decision, messages: [...list, createNotice(text, 'context level')] }
            lastNudgeTokens.set(sessionId, used)
            stats.nudge++
            deps.capabilities?.markObserved?.('waterLevelNudge', `used=${used} basis=${load.basis}`)
            deps.onEvent?.({
              kind: 'water-level',
              workspace,
              sessionId,
              detail: `pressure=${used}; basis=${load.basis}; step=${step}; full=${firstFull}`
                + `${load.contextWindow ? `; window=${load.contextWindow}` : '; window=unknown'}`,
            })
          }
        }
      }

      // ── ②c 花费闸门（R11）──
      // 只做两件事：把本会话累计金额算出来；到线时**注入一次**提醒，不阻断请求。
      // 数据来自 ① 的四桶账本，已经是现成的，不需要重新采样。
      if (config.costNudge !== false) {
        try {
          const load = resolveContextLoad(ctx, session, sessionId, deps.ledger)
          const cost = load.cost
          if (cost?.known && Number.isFinite(cost.usd)) {
            deps.capabilities?.markObserved?.('costMeter', `usd=${cost.usd} model=${cost.model ?? 'unknown'}`)
            if (config.budgetGate !== false) {
              const gate = budgetGate({
                usd: cost.usd,
                budgetUsd: config.costBudgetUsd,
                warnRatio: config.costWarnRatio,
              })
              if (gate.configured) {
                const already = budgetNoticeAt.get(sessionId) ?? null
                // 到线只发一次；但如果金额又涨了一倍（继续在烧），允许再提醒一次。
                const shouldTell = (gate.exceeded || gate.warn)
                  && (already === null || cost.usd > already * 2)
                if (shouldTell) {
                  const list = Array.isArray(decision.messages) ? decision.messages : []
                  const text = budgetText({
                    usd: cost.usd,
                    gate,
                    model: cost.model,
                    estimated: cost.estimated === true,
                    peak: cost.peak === true,
                  })
                  decision = { ...decision, messages: [...list, createNotice(text, 'cost budget')] }
                  budgetNoticeAt.set(sessionId, cost.usd)
                  stats.budgetNotices = (stats.budgetNotices ?? 0) + 1
                  deps.onEvent?.({
                    kind: 'cost-budget',
                    workspace,
                    sessionId,
                    detail: `usd=${cost.usd.toFixed(4)}; budget=${gate.ratio === null ? 'n/a' : Math.round(gate.ratio * 100) + '%'}`
                      + `; exceeded=${gate.exceeded}; model=${cost.model ?? 'unknown'}; estimated=${cost.estimated === true}`,
                  })
                }
              }
            }
          } else {
            // 拿不到价目/模型中任意一个 → 明确记一次降级，不假装花了 0。
            stats.costUnknown = (stats.costUnknown ?? 0) + 1
            deps.capabilities?.markDegraded?.('costMeter', '事件账本拿不到可用金额（价目未知或没有 usage）')
          }
        } catch (error) {
          deps.capabilities?.markDegraded?.('costMeter', `花费闸门异常：${error?.message ?? error}`)
        }
      }
    } catch (error) {
      // 上下文层失败绝不能影响这一轮对话，但要限频报出来。
      deps.capabilities?.markDegraded?.('waterLevelNudge', `pre-step 处理异常：${error?.message ?? error}`)
      deps.log?.warn?.(`上下文层失败（本轮跳过）：${error?.message ?? error}`)
    }
    return decision
  }

  let off = null
  try {
    off = ctx.on('agent/pre-step', handler)
  } catch (error) {
    deps.capabilities?.markDegraded?.('waterLevelNudge', `pre-step 挂载失败：${error?.message ?? error}`)
    deps.log?.warn?.(`pre-step 挂载失败：${error?.message ?? error}`)
  }
  if (typeof off === 'function') {
    disposers.push(off)
    deps.capabilities?.markMounted?.('waterLevelNudge', off, 'agent/pre-step')
    deps.capabilities?.markSupported?.('rulesFallback', '消息注入兜底通道')
    // 0.3.0：压缩兜底与水位提醒共用 pre-step，但状态机完全独立
    //（水位提醒默认关时它仍然工作 —— 这一点在 tests 里专门验过）。
    deps.capabilities?.markSupported?.('compactionFallback', '每会话最多一次的压缩兜底提醒')
    // 花费闸门：四桶折算金额在 usage.js 里，闸门在这一层。挂上就标 supported；
    // "命中过"由 pre-step 里的 markObserved 负责（到线或统计成功时）。
    if (deps.config?.()?.costNudge !== false) {
      deps.capabilities?.markSupported?.('costMeter', '四桶按官方价目折算，到线提醒一次（不阻断）')
    }
  } else {
    deps.capabilities?.markDegraded?.('waterLevelNudge', 'agent/pre-step 注册没有返回卸载句柄')
  }

  const dispose = () => {
    for (const d of disposers) {
      try { d() } catch { /* 清理失败无所谓 */ }
    }
    disposers.length = 0
    sectionHandle = null
    deps.capabilities?.markUnmounted?.('waterLevelNudge', '已卸载')
    deps.capabilities?.markUnmounted?.('rulesSection', '已卸载')
  }
  dispose.stats = stats
  dispose.handle = off
  dispose.sectionMounted = () => sectionHandle !== null
  /**
   * 治理仲裁开关（K1 / R9-A）。
   *
   * `false` = 水位提醒的执行权判给了套件里另一个模块，本模块只保留
   * 规则 section，不再发水位提醒 —— 保证"每次只有一份治理提醒"。
   * 被抢占后重新取得执行权时再置回 `true`。
   */
  dispose.setWaterLevelOwned = (owned) => {
    waterLevelOwned = owned !== false
    if (!waterLevelOwned) {
      deps.capabilities?.markStandby?.('waterLevelNudge', '', '治理声明判给了其他模块，本模块不发水位提醒')
      lastNudgeTokens.clear()
    }
    return waterLevelOwned
  }
  dispose.waterLevelOwned = () => waterLevelOwned
  /**
   * 压缩兜底提醒的让位开关（2026-10-23 新增，与 setWaterLevelOwned 同构）。
   *
   * `false` = 「谁负责真压缩」这项治理能力判给了别人（当前唯一候选是
   * `laurel-context`），本模块**不再发**「该压缩了」的兜底提醒。
   *
   * 为什么让位：laurel-context 真能压（它调 compactIfNeeded），warden 只能提醒。
   * 两个都发的话，用户会先收到"该压缩了"、再收到"已压缩" —— 同一件事两套话术，
   * 这正是用户报的「功能重复」的实感来源。
   *
   * 注意：**只让位"发提醒"这件事**，不让位观测。
   * `compaction.observe()` 仍照常更新每会话状态（它只在 fallbackRatio > 0 且
   * 拿到 pressure 时跑，那段代码在让位判断之前），所以能力台账里
   * 依然能看到「压力下降 ⇒ 压缩确实发生过」的证据。
   */
  dispose.setCompactionNudgeOwned = (owned) => {
    compactionNudgeOwned = owned !== false
    if (!compactionNudgeOwned) {
      deps.capabilities?.markStandby?.('compactionNudge', '', '治理声明判给了真正能压缩的模块，本模块不发兜底提醒')
    }
    return compactionNudgeOwned
  }
  dispose.compactionNudgeOwned = () => compactionNudgeOwned
  return dispose
}
