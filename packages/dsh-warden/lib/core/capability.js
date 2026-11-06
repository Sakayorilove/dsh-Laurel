/**
 * dsh-warden · 能力状态台账（R7）
 *
 * ── 它治的是什么 ───────────────────────────────────────────────────────
 * 评审实读的原文：`systemPrompt` 服务存在、但 `section()` 注册抛错之后，
 * 旧代码用「disposers 非空 + 服务方法存在」判断成功 —— 而 `llm/stream`、
 * `agent/pre-step` 的监听器也在同一个 `disposers` 里，所以判定恒为真，
 * 兜底规则**永远不投递**。界面 meanwhile 显示"已启用"。
 *
 * 根因是"已启用"这一个词被要求同时表达四件不同的事。这里把它们拆开：
 *
 *   supported  宿主有没有这个扩展点（服务/方法在不在）
 *   mounted    我们有没有真的挂上去（拿到那个**确切的** disposer / 句柄）
 *   observed   挂载之后有没有真的命中过一次（有数据流过来）
 *   degraded   挂了但坏了 / 宿主没有这个能力 / 依赖缺失
 *
 * 只有 `mounted` 为真才算"这条能力在工作"；`observed` 才证明它真的生效过。
 * 界面与 `warden_status` 一律读这份台账，不再各自猜。
 *
 * ── 两条纪律 ───────────────────────────────────────────────────────────
 *   1. **降级不许抛。** 记状态本身就是护栏的一部分，它坏掉不能连累宿主。
 *   2. **降级要限频落盘。** 同一个能力反复失败只写一条，避免长会话把
 *      events.log 刷爆；但"第一次失败"必须立刻可见。
 */

import { systemClock } from './clock.js'

/** 能力状态取值。`unknown` 只在还没探测过时出现。 */
export const CAPABILITY_STATES = ['unknown', 'supported', 'mounted', 'observed', 'degraded', 'unsupported', 'standby']

/** 同一条能力的降级日志最小间隔（毫秒）。 */
const DEGRADE_LOG_INTERVAL_MS = 60_000

/**
 * @typedef {object} Capability
 * @property {string} name
 * @property {string} label 给人看的中文名
 * @property {boolean} supported 宿主扩展点存在
 * @property {boolean} mounted 我们确实挂上了（有确切句柄）
 * @property {boolean} observed 挂载后确实命中过
 * @property {boolean} degraded 挂了但坏了 / 不可用
 * @property {string} detail 最近一次状态说明
 * @property {string} reason 降级原因（未降级为空串）
 * @property {number} observedCount 命中次数
 * @property {number} at 最近一次状态变更时刻
 */

export class Capabilities {
  /**
   * @param {{log?: any, onEvent?: (e: object) => void, clock?: {now: () => number}}} [deps]
   */
  constructor(deps = {}) {
    this.log = deps.log ?? null
    this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null
    this.clock = deps.clock ?? systemClock()
    /** @type {Map<string, Capability>} */
    this.entries = new Map()
    /** @type {Map<string, number>} 降级日志限频 */
    this.lastDegradeLog = new Map()
  }

  /** 登记一个能力（还没探测）。重复登记保留已有状态。 */
  define(name, label = '') {
    if (!this.entries.has(name)) {
      this.entries.set(name, {
        name,
        label: String(label || name),
        supported: false,
        mounted: false,
        observed: false,
        degraded: false,
        standby: false,
        detail: '',
        reason: '',
        observedCount: 0,
        at: 0,
      })
    }
    return this.entries.get(name)
  }

  #touch(entry) {
    entry.at = this.clock.now()
    return entry
  }

  /** 宿主扩展点存在（不代表我们挂上了）。 */
  markSupported(name, detail = '') {
    const entry = this.define(name)
    entry.supported = true
    entry.degraded = false
    entry.standby = false
    entry.reason = ''
    if (detail) entry.detail = String(detail)
    return this.#touch(entry)
  }

  /** 宿主没有这个扩展点：明确标不支持，**不静默**。 */
  markUnsupported(name, reason = '') {
    const entry = this.define(name)
    entry.supported = false
    entry.mounted = false
    entry.observed = false
    entry.degraded = true
    entry.standby = false
    entry.reason = String(reason || '宿主未提供该扩展点')
    return this.#touch(entry)
  }

  /**
   * 能力可用，但**由套件里另一个模块执行**（K1 / R9-A）。
   *
   * 这与 degraded / unsupported 都不同：宿主扩展点在、本模块也能挂，
   * 只是治理声明判给了别人，所以本模块主动不挂，避免两个负责人重复提醒。
   */
  markStandby(name, owner, reason = '') {
    const entry = this.define(name)
    entry.supported = true
    entry.mounted = false
    entry.observed = false
    entry.degraded = false
    entry.standby = true
    entry.reason = String(reason || `由 ${owner || '其他模块'} 执行`)
    entry.detail = String(owner ?? '')
    return this.#touch(entry)
  }

  /**
   * 确实挂上了。`handle` 必须是**这一次注册返回的那个句柄**——
   * 传 null/undefined 一律按挂载失败处理，这正是 R7 的病根。
   */
  markMounted(name, handle, detail = '') {
    const entry = this.define(name)
    const ok = handle !== null && handle !== undefined && handle !== false
    entry.mounted = ok
    entry.degraded = !ok
    entry.standby = false
    if (!ok) {
      entry.reason = '注册没有返回句柄'
      this.#note(name, entry.reason)
    } else {
      entry.supported = true
      entry.reason = ''
      if (detail) entry.detail = String(detail)
    }
    return this.#touch(entry)
  }

  /** 命中过一次（有真实数据流过）。 */
  markObserved(name, detail = '') {
    const entry = this.define(name)
    entry.observed = true
    entry.observedCount += 1
    if (detail) entry.detail = String(detail)
    return this.#touch(entry)
  }

  /** 挂了但坏了。限频写日志与事件，不抛。 */
  markDegraded(name, reason = '') {
    const entry = this.define(name)
    entry.degraded = true
    entry.mounted = false
    entry.standby = false
    entry.reason = String(reason || '未知原因')
    this.#touch(entry)
    this.#note(name, entry.reason)
    return entry
  }

  /** 卸载：mounted/observed 归零，supported 保留（宿主能力没变）。 */
  markUnmounted(name, detail = '') {
    const entry = this.define(name)
    entry.mounted = false
    entry.observed = false
    entry.observedCount = 0
    entry.degraded = false
    entry.standby = false
    entry.reason = ''
    if (detail) entry.detail = String(detail)
    return this.#touch(entry)
  }

  /** 限频地把一次降级写进日志与事件。 */
  #note(name, reason) {
    try {
      const now = this.clock.now()
      // ⚠ 必须用 has() 判"从没记过"，不能用 `?? 0`：
      // 时钟从 0 开始时 `0 - 0 < 间隔` 会把**第一次**降级也吞掉。
      if (this.lastDegradeLog.has(name) && now - this.lastDegradeLog.get(name) < DEGRADE_LOG_INTERVAL_MS) return
      this.lastDegradeLog.set(name, now)
      this.log?.warn?.(`[warden] 能力降级 · ${name}：${reason}`)
      this.onEvent?.({ kind: 'capability-degraded', capability: name, detail: reason })
    } catch { /* 记账失败不许影响主流程 */ }
  }

  get(name) {
    return this.entries.get(name) ?? null
  }

  /** 只读快照（按登记顺序）。 */
  snapshot() {
    return [...this.entries.values()].map((entry) => ({
      name: entry.name,
      label: entry.label,
      state: entry.degraded
        ? (entry.supported ? 'degraded' : 'unsupported')
        : entry.standby
          ? 'standby'
          : entry.observed
            ? 'observed'
            : entry.mounted
              ? 'mounted'
              : entry.supported
                ? 'supported'
                : 'unknown',
      supported: entry.supported,
      mounted: entry.mounted,
      observed: entry.observed,
      degraded: entry.degraded,
      standby: entry.standby,
      observedCount: entry.observedCount,
      detail: entry.detail,
      reason: entry.reason,
      at: entry.at,
    }))
  }

  /** 一行给人看的摘要，`warden_status` 与设置页共用。 */
  summaryLine() {
    return this.snapshot()
      .map((c) => `${c.name}=${c.state}${c.reason ? `(${c.reason})` : ''}`)
      .join(' ')
  }
}
