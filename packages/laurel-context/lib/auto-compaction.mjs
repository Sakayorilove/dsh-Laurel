/**
 * 自动压缩的**触发器**（D139）。
 *
 * 为什么要有这个文件：
 * 宿主的自动压缩不是由 compaction **服务**自己驱动的 —— `compaction-basic` 在
 * 构造时注册两个 hook（`_registerAutomaticCompaction()`，原文见
 * implementation/.asar-extract/compaction-basic-index.js:828-885）：
 *   · `agent/pre-step`      → `compactIfNeeded(agent, 'pressure', signal)`
 *   · `agent/request-error` → 只有 `failure.code === 'CONTEXT_WINDOW_EXCEEDED'`
 *                            且表层真的前进了才返回 `{ kind: 'retry' }`
 * **服务只提供「怎么压」，不提供「什么时候压」。**
 *
 * 于是「把 compaction-basic 换成 laurel-context」这个接管写法会删掉触发器：
 * 组内没人注册 pre-step，`compactIfNeeded` 一次都不会被调用。实测端点
 * `hostCompaction.ok=true`、`owner=laurel`，而 `stats.compactions=0`、
 * 会话里 Laurel 写过的 `compaction/summary` 是 0 条 —— 接管变成关掉自动压缩。
 * 证据：implementation/evidence/d139-takeover-kills-auto-compaction.log
 *
 * 本模块按宿主同一套契约注册这两个 hook，让「接管」真的等于「换人压」
 * 而不是「没人压」。hook 注册在根层即可：事件不跨 isolate 隔离
 * （implementation/prove-events-cross-isolate.mjs 实测 A/C 两项）。
 *
 * 关键约束：**只有 Laurel 真的是当前 owner 时才动作**（`isActive()`）。
 * 宿主 compaction-basic 仍生效时两个 owner 同时压会互相破坏锚点 ——
 * 这正是 host-compaction.mjs 的 `occupied`/`isolated-sibling` 要拦的情况。
 */

/** 宿主 `@deepseek-ai/dsh-llm` 的常量，原值见 asar：`CONTEXT_WINDOW_EXCEEDED = "CONTEXT_WINDOW_EXCEEDED"`。 */
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

/** 连续 overflow 重试上限，与宿主默认策略同量级（宿主按路由策略可配，这里取保守值）。 */
export const DEFAULT_MAX_OVERFLOW_RETRIES = 2

/**
 * 注册自动压缩触发器。
 *
 * @param ctx      cordis Context（根层即可）
 * @param provider 宿主形状的 compaction provider（`makeHostProvider` 的产物）
 * @param isActive () => boolean，**每次事件发生时**现算「Laurel 是不是 owner」
 * @param log      带 info/warn 的 logger
 * @returns `{ dispose, stats }`；dispose 幂等
 */
export function registerAutoCompaction(ctx, { provider, isActive, log, maxOverflowRetries = DEFAULT_MAX_OVERFLOW_RETRIES }) {
  const stats = { pressureChecks: 0, pressureCompactions: 0, overflowChecks: 0, overflowCompactions: 0, skippedNotOwner: 0, errors: 0, lastError: null, lastErrorAt: null, lastFailure: null }
  const overflowRetries = new Map()
  const offs = []

  const active = () => {
    try {
      return isActive() === true
    } catch {
      return false
    }
  }

  /**
   * 把失败原因压成**能读懂的**一行。
   *
   * 【必修，可观测性】以前只取 `err.message`，而 `ManualCompactionError` 的
   * message 就是 code 那个词（`protocol-reject` / `summarise-failed`），真正的原因
   * 全在 `err.details` 里（summarizer 的 `published.reason`、`problems`、
   * `candidate.range`、`inputChars`）。结果就是端点和宿主日志只显示
   * `步间压缩失败（继续本轮）: protocol-reject`，追问「为什么被协议拒」无从下手 ——
   * 这种「报了错但说不出原因」的日志等于没有日志。
   *
   * 现在把 details 里的关键判据挑出来拼在后面；details 缺失或本身序列化不了
   * 时退回原样，绝不让诊断代码自己把流程炸掉。
   */
  const describeFailure = (err) => {
    const text = err instanceof Error ? err.message : String(err ?? '')
    const d = err && typeof err === 'object' ? err.details : null
    if (!d || typeof d !== 'object') return text
    const bits = []
    if (typeof d.reason === 'string') bits.push(`reason=${d.reason}`)
    if (d.published && typeof d.published === 'object') {
      if (typeof d.published.reason === 'string') bits.push(`publish=${d.published.reason}`)
      if (Array.isArray(d.published.problems) && d.published.problems.length) {
        bits.push(`problems=${d.published.problems.slice(0, 4).join('|')}`)
      }
      if (Array.isArray(d.published.missing) && d.published.missing.length) {
        bits.push(`missing=${d.published.missing.slice(0, 3).map((m) => m?.kind ?? m).join('|')}`)
      }
      if (d.published.by) bits.push(`by=${d.published.by}`)
      if (d.published.with) bits.push(`with=${d.published.with}`)
    }
    if (Array.isArray(d.problems) && d.problems.length) bits.push(`problems=${d.problems.slice(0, 4).join('|')}`)
    if (Array.isArray(d.missing) && d.missing.length) bits.push(`missing=${d.missing.slice(0, 3).map((m) => m?.kind ?? m).join('|')}`)
    if (d.range && typeof d.range === 'object') bits.push(`range=${d.range.start}..${d.range.end}`)
    if (Number.isFinite(d.inputChars)) bits.push(`inputChars=${d.inputChars}`)
    if (Number.isFinite(d.events)) bits.push(`events=${d.events}`)
    if (Number.isFinite(d.surface)) bits.push(`surface=${d.surface}`)
    return bits.length ? `${text} (${bits.join(', ')})` : text
  }

  const warn = (msg, err) => {
    stats.errors += 1
    // 失败原因必须能被读到：只报 errors:1 而不说为什么，是「静默吞掉」的另一种写法。
    // 端点会把它带出去（readOnlySnapshot 的 autoCompaction.stats）。
    stats.lastError = `${msg}: ${describeFailure(err)}`
    stats.lastErrorAt = Date.now()
    // 完整 details 只挂在 stats 上（供端点/探针取），不进日志首行，避免刷屏。
    stats.lastFailure = err && typeof err === 'object'
      ? { code: err.code ?? null, message: String(err.message ?? ''), details: err.details ?? null }
      : null
    try { log?.warn?.(stats.lastError) } catch { /* ignore */ }
  }

  // ── 1. 步间压力 ────────────────────────────────────────────────────────
  // 返回 next() 的结果原样透传（宿主同一写法）：本监听不改变步进决策。
  const onPreStep = async (payload, next) => {
    const { agent, signal } = payload ?? {}
    if (!active()) { stats.skippedNotOwner += 1; return next() }
    if (signal?.aborted) return next()
    stats.pressureChecks += 1
    try {
      const result = await provider.compactIfNeeded(agent, 'pressure', signal)
      if (result !== null) {
        stats.pressureCompactions += 1
        try { log?.info?.(`自动压缩（步间压力）：shadowed ${result.shadowedSeqs?.length ?? 0} 条表层节点（seqs ${result.shadowedRange?.start}-${result.shadowedRange?.end}）`) } catch { /* ignore */ }
      }
    } catch (e) {
      // 与宿主一致：压不动就把这一轮放过去，不能因为压缩失败把用户的一步卡死。
      warn('步间压缩失败（继续本轮）', e)
    }
    return next()
  }

  // ── 2. 上下文溢出恢复 ──────────────────────────────────────────────────
  // 只有「真的因为超窗失败」且「表层真的前进了」才 retry，否则原样放行。
  const onRequestError = async (payload, next) => {
    const { agent, failure, signal } = payload ?? {}
    if (!active()) { stats.skippedNotOwner += 1; return next() }
    if (failure?.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()
    if (signal?.aborted) return next()
    stats.overflowChecks += 1
    const session = agent?.session
    if (!session?.surface) return next()
    const retries = overflowRetries.get(agent) ?? 0
    if (retries >= maxOverflowRetries) return next()
    const generation = session.surface.replaceGeneration
    let result
    try {
      result = await provider.compactIfNeeded(agent, 'context-overflow', signal)
    } catch (e) {
      // 但若表层已经前进，重试是有意义的：下一次请求带的是压缩后的历史。
      if (!signal?.aborted && session.surface.replaceGeneration > generation) {
        overflowRetries.set(agent, retries + 1)
        warn('溢出压缩失败但表层已前进，重试一次', e)
        return { kind: 'retry' }
      }
      warn('溢出压缩失败（保留原始错误）', e)
      return next()
    }
    if (signal?.aborted || session.surface.replaceGeneration <= generation) return next()
    if (result !== null) {
      stats.overflowCompactions += 1
      try { log?.info?.(`自动压缩（上下文溢出恢复）：shadowed ${result.shadowedSeqs?.length ?? 0} 条`) } catch { /* ignore */ }
    }
    overflowRetries.set(agent, retries + 1)
    return { kind: 'retry' }
  }

  // ── 3. 重试计数复位（与宿主同形）──────────────────────────────────────
  const onStatus = (payload) => {
    if (payload?.status === 'idle' && payload?.agent) overflowRetries.delete(payload.agent)
  }
  const onSessionEvent = (session, event) => {
    if (event?.type !== 'assistant/message') return
    for (const [agent, ] of overflowRetries) {
      if (agent?.session === session) overflowRetries.delete(agent)
    }
  }

  const on = (name, fn) => {
    const res = ctx?.on?.(name, fn)
    if (typeof res === 'function') offs.push(res)
    return typeof res === 'function'
  }

  const registered = {
    preStep: on('agent/pre-step', onPreStep),
    requestError: on('agent/request-error', onRequestError),
    status: on('agent/status', onStatus),
    sessionEvent: on('session/event', onSessionEvent),
  }

  let disposed = false
  return {
    stats,
    registered,
    /** 至少 pre-step 与 request-error 两条触发器都在，才算接管后自动压缩还在。 */
    complete: registered.preStep && registered.requestError,
    dispose() {
      if (disposed) return
      disposed = true
      for (const off of offs.splice(0)) { try { off() } catch { /* ignore */ } }
      overflowRetries.clear()
    },
  }
}
