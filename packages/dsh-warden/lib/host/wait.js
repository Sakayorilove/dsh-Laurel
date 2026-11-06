/**
 * dsh-warden · 等待期限（R1 的正解）
 *
 * ── 为什么不在 `tools/pre-execute` 里改参数 ────────────────────────────
 * 旧版就是这么干的，而且**从来没生效过**。实读宿主 `dsh-tools` 的
 * `createExecution()`：
 *
 *     arguments: deepFreeze(snapshotJsonValue(exec.arguments))
 *
 * `pre-execute` 拿到的 `exec.arguments` 是**深冻结**的。旧代码写
 * `args.value.timeout_ms = cap` → 严格模式下抛 TypeError → 被自己的
 * `catch {}` 吞掉 → 继续 `next()` → 工具体照旧收到 900000ms。
 * 评审用真实 Cordis + ToolRuntime 复现了这一点（探针 R1，defect=true）。
 *
 * `pre-execute` 的决策只有 `allow / deny / ask / cancel`，`tools.guard()`
 * 也只能返回一个拒绝字符串 —— **两处都改不了参数**。所以"把等待压短"
 * 这件事根本不属于那一层。
 *
 * ── 正确的层：`tools/execute` 上给一个期限信号 ─────────────────────────
 * 官方 `dsh-tool-call-timeout-policy` 就是这么做的（实读其 `apply()`）：
 *
 *     const d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
 *     const upstream = exec.signal
 *     exec.signal = d.signal
 *     try { const result = await next(); ... } finally { exec.signal = upstream }
 *
 * 也就是说 `exec.signal` 在这一层**是可写的**，而 `wait_agent` 恰恰把
 * `exec.signal` 一路交给 `agentTeams.waitForChange(caller, timeoutMs, signal)`
 * → `TeamActivity.wait()`，那里 `signal.addEventListener("abort", onAbort)`。
 * 于是给它一个更早到期的信号，等待就真的会提前结束 —— 不改模型传的参数、
 * 不碰权限与审批、不伪造"我把它改小了"。
 *
 * 两个必须保住的语义：
 *   1. **不会被误判成用户取消。** `callerCancelled(exec)` 读的是
 *      `cancellationStates.get(exec).callerSignal`（原始调用方信号），
 *      不是我们替换掉的 `exec.signal`。
 *   2. **等待到期限 ≠ 子任务失败。** `TeamActivity.wait()` 在 abort 时
 *      **reject** `TeamError(..., "TEAM_WAIT_ABORTED")`，直接放上去会变成
 *      isError，模型会读成"子代理挂了"。所以期限到了要**换成正常超时结果**
 *      `{ timedOut: true }` —— 这正是 `WAIT_VALUE_SCHEMA` 里
 *      "等到超时了，去重新 list" 的那个值。
 *
 * `additionalProperties: false` 的 schema 塞不进解释文字，所以解释走
 * `additionalContexts`（与官方 `dsh-repeat-tool-reminder` 同一条通道，
 * 会照常 replay / compact，事后能在会话记录里核对）。
 *
 * ── 三种时间要分清 ─────────────────────────────────────────────────────
 *   `waitCapMs`   单次等待调用的期限 —— **本模块强制**
 *   `idleLimitMs` 会话多久没有新活动 —— 只观测与上报，S4/S5 用来提醒
 *   `taskBudgetMs` 整个任务的预算    —— 只观测与上报，到点是复盘不是放弃
 * 把三者混成一个数，就会出现"30 秒没出最终答案 = 卡死"这种误判。
 */

import { systemClock } from '../core/clock.js'

/** 默认纳入期限管理的等待类工具。可在配置里增减。 */
export const DEFAULT_WAIT_TOOLS = ['wait_agent']

/** 宿主 `wait_agent` 自己声明的合法区间（实读其 execute）。 */
export const HOST_WAIT_RANGE_MS = { min: 10_000, max: 3_600_000, fallback: 30_000 }

/** 从（冻结的）参数里只读出模型请求的等待毫秒数。绝不写回。 */
export function requestedWaitMs(exec) {
  const raw = exec?.arguments
  let args = raw
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw) } catch { return null }
  }
  if (!args || typeof args !== 'object') return null
  const value = Number(args.timeout_ms)
  return Number.isFinite(value) ? value : null
}

/**
 * 这次等待该不该被我们截短。
 *
 * @returns {{effective: number, requested: number|null, reason: string}|null}
 *   不需要介入时返回 null。
 */
export function planWaitCap(exec, capMs, waitTools = DEFAULT_WAIT_TOOLS) {
  const cap = Number(capMs)
  if (!Number.isFinite(cap) || cap <= 0) return null
  const name = String(exec?.name ?? '')
  if (!name || !new Set(waitTools).has(name)) return null

  const requested = requestedWaitMs(exec)
  // 模型没传 ⇒ 用宿主默认值参与比较（宿主默认 30 秒，可能已经比上限大）。
  const assumed = requested ?? HOST_WAIT_RANGE_MS.fallback
  // 宿主对越界值会直接透传给 waitForChange（它自己再校验并抛），
  // 那种情况我们不插手，让宿主按它自己的合同报错。
  if (requested !== null && !Number.isSafeInteger(requested)) return null
  if (requested !== null && (requested < HOST_WAIT_RANGE_MS.min || requested > HOST_WAIT_RANGE_MS.max)) return null
  if (assumed <= cap) return null
  return { effective: cap, requested, reason: requested === null ? 'default' : 'over-cap' }
}

/**
 * 这个工具的输出 schema 收不收 `{ timedOut: true }`。
 *
 * 只有收得下才敢替换结果 —— 否则 `normalizeDispatchResult` 会在
 * `createSuccessResult` 里校验失败并抛，把一次正常的等待截断变成工具报错。
 */
export function acceptsTimedOutValue(tool) {
  const schema = tool?.output?.schema
  if (!schema || typeof schema !== 'object') return false
  if (schema.type !== 'object') return false
  const props = schema.properties
  if (!props || typeof props !== 'object') return false
  if (props.timedOut?.type !== 'boolean') return false
  const required = Array.isArray(schema.required) ? schema.required : []
  return required.every((key) => key === 'timedOut')
}

/** 期限到了之后给模型看的那句话（走 additionalContexts）。 */
export function waitCapNoticeText(capMs, requested, toolName) {
  const capSec = Math.round(Number(capMs) / 1000)
  const wantSec = Number.isFinite(Number(requested)) ? Math.round(Number(requested) / 1000) : null
  return `[warden] \`${toolName}\` 的等待在 ${capSec} 秒处被护栏截断`
    + `${wantSec !== null ? `（你请求的是 ${wantSec} 秒）` : '（你没有指定时长，用的是宿主默认值）'}。\n`
    + `这**不代表子任务失败了** —— 它可能还在跑。等待超时和子任务失败是两件事。\n`
    + `现在该做的：① 用 \`list_agents\` 看一下各成员的真实状态；② 有必需成员是 inactive 就先用 `
    + `\`send_message\` 把它叫醒，再决定要不要继续等；③ 同时可以先推进不依赖它的独立工作。\n`
    + `不要用更长的 timeout_ms 原地重试同一次等待 —— 上限还是 ${capSec} 秒。`
}

/** 造一条提醒消息。形状与宿主 `createUserMessage` 一致。 */
function createNotice(text, summary, uuid) {
  const message = {
    id: uuid(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'warden', form: 'notice', summary: String(summary ?? '').slice(0, 60) },
  }
  try { return structuredClone(message) } catch { return message }
}

/**
 * 挂上等待期限。返回卸载函数；拿不到钩子返回 null。
 *
 * @param {any} ctx cordis 上下文
 * @param {{config: () => any, capabilities?: any, log?: any, clock?: any,
 *          onEvent?: (e: object) => void, uuid?: () => string}} deps
 */
export function installWaitCap(ctx, deps) {
  if (typeof ctx?.on !== 'function') {
    deps.capabilities?.markUnsupported?.('waitCap', '拿不到 ctx.on，无法挂 tools/execute')
    return null
  }

  const clock = deps.clock ?? systemClock()
  const uuid = deps.uuid ?? (() => {
    // 避免在这一层硬依赖 node:crypto（调用方通常已经传了进来）。
    return `wd-${clock.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  })
  const stats = { armed: 0, fired: 0, substituted: 0, passedThrough: 0 }

  // 能力探测：宿主有没有 tools/execute 这一层。
  try {
    const tools = ctx.get?.('tools')
    if (tools?.get) deps.capabilities?.markSupported?.('waitCap', 'tools/execute 可用')
    else deps.capabilities?.markUnsupported?.('waitCap', '取不到 tools 服务')
  } catch (error) {
    deps.capabilities?.markUnsupported?.('waitCap', `探测 tools 服务失败：${error?.message ?? error}`)
  }

  let off = null
  try {
    off = ctx.on('tools/execute', async (exec, next) => {
      let plan = null
      try {
        const config = deps.config?.() ?? {}
        if (config.enabled === false) return await next()
        plan = planWaitCap(exec, config.waitCapMs, config.waitTools ?? DEFAULT_WAIT_TOOLS)
      } catch { plan = null }
      if (!plan) return await next()

      const upstream = exec.signal
      const controller = new AbortController()
      let fired = false
      const onUpstreamAbort = () => controller.abort(upstream?.reason)
      if (upstream?.aborted) controller.abort(upstream.reason)
      else upstream?.addEventListener?.('abort', onUpstreamAbort, { once: true })

      const timer = clock.setTimeout(() => {
        fired = true
        controller.abort(new Error('WARDEN_WAIT_CAP'))
      }, plan.effective)

      stats.armed++
      exec.signal = controller.signal
      try {
        let result
        try {
          result = await next()
        } catch (error) {
          // 不是我们自己发的期限（上游 abort、或下游在期限内自己抛的错）：原样上抛，别吞别人的错。
          if (!fired) throw error
          // 是我们发的期限到了、下游按宿主语义 reject
          // （TeamActivity.wait: reject(new TeamError('wait_agent aborted: ...', 'TEAM_WAIT_ABORTED'))）。
          // 这是「等到了上限」，不是「子任务失败」——统一交给下面既有的替换分支换成 timedOut。
          result = { isError: true, error: { message: String(error?.message ?? error) } }
        }
        if (!fired) { stats.passedThrough++; return result }

        stats.fired++
        const notice = createNotice(
          waitCapNoticeText(plan.effective, plan.requested, String(exec?.name ?? 'wait')),
          `wait cap ${plan.effective}ms`,
          uuid,
        )
        deps.onEvent?.({
          kind: 'wait-capped',
          sessionId: exec?.agent?.session?.id ?? '',
          workspace: exec?.agent?.session?.header?.cwd ?? '',
          detail: `${exec.name} 等待被截断到 ${plan.effective}ms（请求 ${plan.requested ?? '宿主默认'}）`,
        })
        deps.capabilities?.markObserved?.('waitCap', `${exec.name} → ${plan.effective}ms`)

        // 只在输出 schema 确实收得下 {timedOut:true} 时替换结果。
        let canSubstitute = false
        try { canSubstitute = acceptsTimedOutValue(ctx.get?.('tools')?.get?.(exec.name, exec.agent)) } catch { canSubstitute = false }

        const extra = [...(result?.additionalContexts ?? []), notice]
        if (canSubstitute && !upstream?.aborted) {
          stats.substituted++
          return { isError: false, value: { timedOut: true }, additionalContexts: extra }
        }
        // 替换不了就保留下游结果，但一定把解释带上；已经 isError 的不动它的 error。
        return result && typeof result === 'object' ? { ...result, additionalContexts: extra } : result
      } finally {
        clock.clearTimeout(timer)
        upstream?.removeEventListener?.('abort', onUpstreamAbort)
        exec.signal = upstream
      }
    })
  } catch (error) {
    deps.capabilities?.markDegraded?.('waitCap', `tools/execute 挂载失败：${error?.message ?? error}`)
    deps.log?.warn?.(`等待期限挂载失败（等待上限不生效，其余正常）：${error?.message ?? error}`)
    return null
  }

  if (typeof off !== 'function') {
    deps.capabilities?.markDegraded?.('waitCap', 'tools/execute 注册没有返回卸载句柄')
    return null
  }
  // 只有拿到"这一次注册返回的确切句柄"才算 mounted（R7 的病根就在这）。
  deps.capabilities?.markMounted?.('waitCap', off, 'tools/execute')

  const dispose = () => {
    try { off() } catch { /* 清理失败无所谓 */ }
    deps.capabilities?.markUnmounted?.('waitCap', '已卸载')
  }
  dispose.stats = stats
  dispose.handle = off
  return dispose
}
