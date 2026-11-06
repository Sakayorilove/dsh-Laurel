/**
 * laurel-continue · 引擎主体
 *
 * 监听回合结束，决定要不要发一句「继续」。所有判断都在这里收口，
 * 因为这类插件最常见的坏法不是"没实现功能"，而是**在不该发的时候也发了**：
 * 用户刚点了取消、策略刚拒绝、上下文正在压缩、等待刚被截断 —— 这些时刻
 * 多发一句「继续」等于把用户的操作覆盖掉，而且现场极难复现。
 *
 * ── 发一条之前的完整闸门链（顺序不能换）────────────────────────────
 *   1. 总开关 enabled
 *   2. 生效时段（§4）
 *   3. 会话级暂停
 *   4. 原因码分派 classifyTurnEnd（§3）
 *   5. **让位上下文压缩**（§6.1）—— 只通知，不续跑
 *   6. **让位等待截断**（§6.2）—— waitGraceMs 内的 completed 不触发循环
 *   7. 冷却 cooldownMs
 *   8. 连续上限 maxConsecutive
 *   9. 自主循环的独立额度闸门（loopMaxRounds / loopMaxDurationMs）
 *
 * 让位（5、6）必须排在"要不要发"之前，否则会出现：先发了一句继续，
 * 然后才发现这一轮该让位 —— 消息已经进会话，收不回来了。
 *
 * ── 为什么要有独立的循环额度 ──────────────────────────────────────────
 * 「回合正常结束后也继续」等于按轮计费地自动烧钱。只靠 maxConsecutive 不够：
 * 它数的是**连续失败**，而正常结束的循环一轮都不算失败，于是会一直转下去。
 * 所以自主循环必须有自己的两道闸：轮数上限与总时长上限。到点即停并通知。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

import { classifyTurnEnd } from '../core/reasons.js'
import { describeSchedule, isScheduleActive, msUntilWindowOpen } from '../core/schedule.js'
import { createEventLog } from '../core/stats.js'
import { createStats } from '../core/stats.js'
import { resolveDshHome } from '../core/home.js'

/** 默认的「继续」文案（continueText 为空时用它）。 */
const DEFAULT_CONTINUE_TEXT = '继续'

/** 每会话最多保留多少条尝试记录（§5.1 说最近 20 条）。 */
const ATTEMPT_KEEP = 20

/** 引擎内部错误统一包一层，避免把栈里的私有形状漏到 HTTP。 */
function messageOf(error) {
  return String(error?.message ?? error)
}

/** 配置取值：允许传对象或 getter。 */
function readConfig(source) {
  try {
    const value = typeof source === 'function' ? source() : source
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** 取一个数，非有限数用 fallback。 */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 造一个引擎。
 *
 * @param {{config?: object|(() => object), home?: string, now?: () => number,
 *          events?: any, stats?: any, log?: any, deliver?: Function,
 *          getAgent?: Function, listSessions?: Function, ctx?: any,
 *          setTimer?: Function, clearTimer?: Function}} [options]
 * @returns {object} engine
 */
export function createEngine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const home = typeof options.home === 'string' && options.home.length > 0 ? options.home : resolveDshHome()
  const log = options.log ?? null
  const events = options.events ?? createEventLog()
  const stats = options.stats ?? createStats(now())
  const ctx = options.ctx ?? null

  /** 定时器由外部注入，便于测试「定时器是否真的被取消」；默认用 setTimeout 并 unref。 */
  const setTimer = typeof options.setTimer === 'function'
    ? options.setTimer
    : (fn, ms) => {
      const handle = setTimeout(fn, ms)
      // 所有定时器都必须 unref：这个模块不该把宿主进程留住。
      handle?.unref?.()
      return handle
    }
  const clearTimer = typeof options.clearTimer === 'function'
    ? options.clearTimer
    : (handle) => {
      if (handle !== undefined && handle !== null) clearTimeout(handle)
    }

  /** 每会话的连续计数与最近一次尝试时间。 */
  const consecutive = new Map()
  /** 每会话的冷却到期时间。 */
  const cooldownUntil = new Map()
  /** 每会话的暂停到期时间（0 / 缺失 = 未暂停）。 */
  const paused = new Map()
  /** 每会话最近 20 条尝试记录（§5.1）。 */
  const attempts = new Map()
  /** 每会话最近一次 {timedOut:true} 的时间戳（§6.2 的判据）。 */
  const lastTimedOutAt = new Map()
  /** 待触发的定时器（dispose 时要全部取消）。 */
  const timers = new Set()
  /** 进行中的「继续」发送（防止同一会话并发发两条）。 */
  const sending = new Set()
  /**
   * 进行中的投递 Promise，按会话记。
   *
   * 为什么需要它：投递是异步的，而 handleTurnEnd 是同步返回的。
   * 没有这张表，启动扫描里的 try/catch 只能接住**同步**异常，
   * 投递失败会变成一个无人处理的 rejection —— 一个会话炸了会表现为
   * 「扫描说成功、实际没发出去」，比直接报错更难查。
   */
  const inflight = new Map()
  const pendingRecovery = new Map()
  const currentTurn = new Map()

  let disposed = false
  const offs = []

  const config = () => readConfig(options.config)
  const getAgent = typeof options.getAgent === 'function'
    ? options.getAgent
    : (sessionId) => {
      try { return (typeof ctx?.get === 'function' ? ctx.get('agents') : ctx?.agents)?.get?.(sessionId) ?? null } catch { return null }
    }
  const listSessions = typeof options.listSessions === 'function' ? options.listSessions : () => []

  /* ---------------- 事件日志 ---------------- */

  function emit(kind, sessionId, detail) {
    try {
      events.append({ at: now(), kind, sessionId, detail }, home)
    } catch { /* 记日志失败不影响续跑 */ }
  }

  /* ---------------- 定时器 ---------------- */

  function schedule(fn, ms) {
    const handle = setTimer(() => {
      timers.delete(handle)
      if (disposed) return
      try { fn() } catch (error) { emit('error', null, '定时器回调异常：' + messageOf(error)) }
    }, Math.max(0, Math.round(ms)))
    timers.add(handle)
    return handle
  }

  function cancel(handle) {
    if (handle === undefined || handle === null) return
    timers.delete(handle)
    try { clearTimer(handle) } catch { /* 取消失败也继续 */ }
  }

  function cancelAll() {
    for (const handle of [...timers]) cancel(handle)
    timers.clear()
  }

  /* ---------------- 会话状态 ---------------- */

  function recordAttempt(sessionId, entry) {
    const list = attempts.get(sessionId) ?? []
    list.push(entry)
    while (list.length > ATTEMPT_KEEP) list.shift()
    attempts.set(sessionId, list)
  }

  function isPaused(sessionId) {
    const until = paused.get(sessionId)
    if (until === undefined) return false
    if (until > now()) return true
    // 到期的暂停自动解除，免得状态端点里一直挂着一个"暂停中"。
    paused.delete(sessionId)
    return false
  }

  /* ---------------- 发送 ---------------- */

  /** 真正的投递：注入的 deliver 优先，否则走 ctx.agents.get().steer()。 */
  async function deliver(payload) {
    if (typeof options.deliver === 'function') {
      const result = await options.deliver(payload)
      if (result === false || result?.ok === false) throw new Error('续跑消息未被接受')
      return true
    }
    const agent = payload.agent ?? getAgent(payload.sessionId)
    if (!agent) throw new Error('找不到会话 ' + String(payload.sessionId) + ' 的活 agent')
    // turn/end 在驱动器收尾前派发；零宽限时必须等真正 idle，再唤醒新回合。
    if (agent.status === 'running' && typeof agent.whenIdle === 'function') await agent.whenIdle()
    if (disposed || isPaused(payload.sessionId)) throw new Error('续跑已取消或暂停')
    if (pendingRecovery.get(payload.sessionId)?.id !== payload.messageId) throw new Error('续跑已被后续人工消息接管')
    return steer(agent, payload.text, payload.messageId)
  }

  /**
   * 往会话里投一句用户消息并唤醒它。
   *
   * 走 engine 的 steer/inject 而不是自己去拼 session 事件：
   * 宿主对"什么算唤醒"有它自己的合同（取消后的收敛、inbox 边界），
   * 绕过去写会在取消竞争时丢消息。
   */
  async function steer(agent, text, messageId) {
    const message = {
      role: 'user',
      content: [{ type: 'text', text }],
      // source.kind 用 'user'：这是**用户口吻的继续**，不是插件注入的上下文。
      // 用插件私有 kind 会让客户端把它渲染成系统提示，用户会以为自己在说话。
      source: { kind: 'user' },
    }
    const id = messageId
    const payload = { ...message, id }
    if (typeof agent.steer === 'function') {
      const result = await agent.steer(payload)
      if (result === false || result?.ok === false) throw new Error('agent 拒绝续跑消息')
      return true
    }
    if (typeof agent.followup === 'function') {
      const result = await agent.followup(payload)
      if (result === false || result?.ok === false) throw new Error('agent 拒绝续跑消息')
      return true
    }
    throw new Error('agent 既没有 steer 也没有 followup')
  }

  /* ---------------- 继续文案 ---------------- */

  /** 取出要发的文本。支持 {code} {message} {status} {tool} {turn} 占位符。 */
  function continueTextFor(context = {}) {
    const cfg = config()
    const template = typeof cfg.continueText === 'string' && cfg.continueText.trim().length > 0
      ? cfg.continueText
      : DEFAULT_CONTINUE_TEXT
    return template
      .replace(/\{code\}/g, String(context.code ?? ''))
      .replace(/\{message\}/g, String(context.message ?? ''))
      .replace(/\{status\}/g, String(context.status ?? ''))
      .replace(/\{tool\}/g, String(context.tool ?? ''))
      .replace(/\{turn\}/g, String(context.turn ?? ''))
      .trim()
  }

  /* ---------------- 自主循环额度闸门 ---------------- */

  /**
   * 自主循环还能不能再来一轮。
   *
   * 这两道闸是本模块相对同类插件多出来的：单靠 maxConsecutive 管不住
   * 「正常结束就继续」的循环，因为那种循环**一次失败都不产生**。
   *
   * @returns {{allowed: boolean, reason?: string, detail?: string}}
   */
  function loopBudget() {
    const cfg = config()
    const snap = stats.snapshot(now())
    const maxRounds = num(cfg.loopMaxRounds, 20)
    const maxDuration = num(cfg.loopMaxDurationMs, 3600000)

    if (snap.loopRounds >= maxRounds) {
      return {
        allowed: false,
        reason: 'rounds',
        detail: '自主循环已用满本轮额度：' + snap.loopRounds + '/' + maxRounds + ' 轮',
      }
    }
    if (snap.loopStartedAt > 0) {
      const elapsed = now() - snap.loopStartedAt
      if (elapsed >= maxDuration) {
        return {
          allowed: false,
          reason: 'duration',
          detail: '自主循环已超过总时长额度：'
            + Math.round(elapsed / 1000) + 's / ' + Math.round(maxDuration / 1000) + 's',
        }
      }
    }
    return { allowed: true }
  }

  /* ---------------- 主判定 ---------------- */

  /**
   * 处理一次回合结束。**同步**返回判定结果（投递本身是异步的）。
   *
   * @param {{sessionId: string, reason: object, agent?: any, at?: number}} input
   * @returns {object}
   */
  function handleTurnEnd(input = {}) {
    const sessionId = String(input.sessionId ?? '')
    pendingRecovery.delete(sessionId)
    const reason = input.reason && typeof input.reason === 'object' ? input.reason : {}
    const at = Number.isFinite(input.at) ? input.at : now()
    const cfg = config()

    const finish = (result) => {
      recordAttempt(sessionId, {
        sessionId,
        at,
        consecutive: consecutive.get(sessionId) ?? 0,
        reason: typeof reason.kind === 'string' ? reason.kind : 'unknown',
        action: result.action,
      })
      return result
    }

    // 1. 总开关
    if (cfg.enabled === false) return finish({ action: 'skip', note: 'disabled' })

    // 2. 生效时段
    if (!isScheduleActive(cfg, at)) {
      emit('skip', sessionId, '不在生效时段（' + describeSchedule(cfg) + '）')
      return finish({ action: 'skip', note: 'outside-schedule' })
    }

    // 3. 会话级暂停
    if (isPaused(sessionId)) {
      emit('skip', sessionId, '会话已暂停')
      return finish({ action: 'skip', note: 'paused' })
    }

    // 4. 原因码分派
    const verdict = classifyTurnEnd(reason, cfg)

    // ── aborted + user：清零连败计数 ──
    if (verdict.note === 'reset') {
      consecutive.delete(sessionId)
      cooldownUntil.delete(sessionId)
      return finish({ action: 'reset', kind: verdict.kind, causeKind: verdict.causeKind, consecutive: 0 })
    }

    if (verdict.action === 'skip') {
      // 非用户取消的 aborted 之类，也不该保留一个"快要放弃"的计数。
      emit('skip', sessionId, '原因 ' + verdict.kind + '：' + (verdict.note ?? '不续跑'))
      return finish({ action: 'skip', kind: verdict.kind, note: verdict.note })
    }

    // 5. §6.1 让位上下文压缩 —— 必须在发消息之前
    if (verdict.note === 'yield-compaction') {
      emit('yield-compaction', sessionId,
        '上下文超限已交给上下文压缩处理（code=' + (verdict.code ?? 'CONTEXT_WINDOW_EXCEEDED') + '），本模块不续跑')
      return finish({
        action: 'yield',
        kind: verdict.kind,
        note: 'yield-compaction',
        code: verdict.code,
        notifyText: '本轮上下文超限，已交给上下文压缩处理，压缩完成后会自动继续。',
      })
    }

    // 6. §6.2 让位等待截断 —— 同样必须在发消息之前
    if (cfg.yieldToWaitCap !== false) {
      const lastTimeout = lastTimedOutAt.get(sessionId)
      const grace = num(cfg.waitGraceMs, 45000)
      if (lastTimeout !== undefined && at - lastTimeout < grace) {
        emit('yield-waitcap', sessionId,
          '等待刚在 ' + Math.round((at - lastTimeout) / 1000) + 's 前被截断'
          + '（宽限 ' + Math.round(grace / 1000) + 's），不把这次 completed 当作续跑信号')
        return finish({ action: 'yield', kind: verdict.kind, note: 'yield-waitcap' })
      }
    }

    // 永久性失败：通知用户，不续跑，但要记 skipped（契约 §5.1）。
    if (verdict.action === 'notify') {
      stats.bump('skipped', at)
      if (verdict.code) stats.bumpCode(verdict.code, at)
      emit('skip', sessionId, '永久性失败（' + (verdict.code || verdict.message || '未知') + '），不续跑')
      return finish({
        action: 'notify',
        kind: verdict.kind,
        note: verdict.note,
        code: verdict.code,
        notifyText: '本轮因不可恢复的错误结束（' + (verdict.code || verdict.message || '未知原因') + '），已停止自动续跑。',
      })
    }

    if (verdict.action !== 'resume') {
      return finish({ action: 'skip', kind: verdict.kind, note: verdict.note ?? 'not-resumable' })
    }

    const isLoop = verdict.note === 'loop'

    // 8. 连续上限（自主循环不算失败，但同样受上限约束且不得叠加失败计数）
    const count = consecutive.get(sessionId) ?? 0
    const maxConsecutive = num(cfg.maxConsecutive, 3)
    if (!isLoop && count >= maxConsecutive) {
      stats.bump('gaveUp', at)
      emit('giveup', sessionId, '连续 ' + count + ' 次可恢复失败后放弃（上限 ' + maxConsecutive + '）')
      return finish({
        action: 'giveup',
        kind: verdict.kind,
        consecutive: count,
        notifyText: '连续 ' + count + ' 次自动继续后仍未恢复，已停止（上限 ' + maxConsecutive + '）。',
      })
    }

    // 9. 自主循环的独立额度闸门
    if (isLoop) {
      const budget = loopBudget()
      if (!budget.allowed) {
        emit('loop-blocked', sessionId, budget.detail)
        return finish({
          action: 'loop-blocked',
          kind: verdict.kind,
          note: budget.reason,
          notifyText: cfg.loopBudgetNotice !== false
            ? budget.detail + '，已停止自主循环。'
            : null,
        })
      }
    }

    // 7. 冷却
    const cooldown = num(cfg.cooldownMs, 20000)
    const ready = cooldownUntil.get(sessionId) ?? 0
    const sendAt = Math.max(at + num(cfg.graceMs, 10000), ready)
    const delayMs = Math.max(0, sendAt - at)

    const text = continueTextFor({ code: verdict.code, message: verdict.message })
    const plan = { sessionId, agent: input.agent ?? null, text, mode: isLoop ? 'loop' : 'resume', reason: verdict.kind, messageId: 'lc-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) }

    // 执行投递（异步）
    const fire = () => {
      if (disposed) return
      if (isPaused(sessionId)) return
      if (sending.has(sessionId)) return
      sending.add(sessionId)
      cooldownUntil.set(sessionId, now() + cooldown)
      pendingRecovery.set(sessionId, { id: plan.messageId, admitted: false, turn: null })
      emit('fire', sessionId, (isLoop ? '自主循环' : '续跑')
        + '（原因 ' + verdict.kind + (delayMs > 0 ? '，延迟 ' + delayMs + 'ms' : '') + '）')
      const task = Promise.resolve()
        .then(() => deliver(plan))
        .then(() => {
          stats.bump('sent', now())
          if (isLoop) stats.bumpLoop(1, now())
          // 发出去了不等于恢复了：必须看到本次消息入队后的对应输出。
          if (!isLoop) {
            const next = (consecutive.get(sessionId) ?? 0) + 1
            consecutive.set(sessionId, next)
          }
        })
        .catch((error) => {
          if (pendingRecovery.get(sessionId)?.id === plan.messageId) pendingRecovery.delete(sessionId)
          const current = consecutive.get(sessionId) ?? 0
          consecutive.set(sessionId, current + 1)
          stats.bump('failed', now())
          emit('error', sessionId, '投递失败：' + messageOf(error))
          // 抛出去，让**知道该拿这件事怎么办**的调用方（启动扫描）能看见。
          // 普通的回合结束路径不 await 它，所以这里不会变成未处理拒绝 ——
          // 下面的 finally 里把它从表里摘掉并挂一个空的 catch。
          throw error
        })
        .finally(() => {
          sending.delete(sessionId)
          inflight.delete(sessionId)
        })
      // 挂一个「已处理」标记：不 await 的调用方不会产生 unhandledRejection。
      task.catch(() => {})
      inflight.set(sessionId, task)
    }

    // consecutive 是**即将变成的值**：投递成功后才会真正自增（见 fire 里的
    // consecutive.set），而这个返回值是同步给的。报即将生效的值，才能和随后
    // getStatus().data.consecutive 读到的数对得上 —— 报自增前的旧值会让
    // 「刚发出去就查状态」这两个数字打架。
    const nextConsecutive = isLoop ? count : count + 1

    if (delayMs > 0) {
      const handle = schedule(fire, delayMs)
      return finish({
        action: 'defer', kind: verdict.kind, note: verdict.note, delayMs,
        fireAt: sendAt, text, timer: handle, consecutive: nextConsecutive,
      })
    }
    fire()
    return finish({
      action: 'fire', kind: verdict.kind, note: verdict.note, delayMs: 0,
      text, consecutive: nextConsecutive,
    })
  }

  /**
   * 记一次工具结果。§6.2 的判据就是从这里来的：
   * 「最近一次 timedOut:true 的工具结果」的时间戳。
   *
   * @param {{sessionId?: string, name?: string, result?: any, at?: number}} input
   */
  function handleToolResult(input = {}) {
    const name = String(input.name ?? '')
    // 只关心等待类工具。名字写死是有意的：这里是"识别等待被截断"，
    // 不是一张可配置的清单 —— 猜错名字会让让位规则静默失效。
    if (name !== 'wait_agent') return { tracked: false }
    const result = input.result
    const timedOut = result && typeof result === 'object' && result.timedOut === true
    if (!timedOut) return { tracked: false }
    const sessionId = String(input.sessionId ?? '')
    lastTimedOutAt.set(sessionId, Number.isFinite(input.at) ? input.at : now())
    return { tracked: true, sessionId }
  }

  /**
   * cordis `session/event` 适配器。
   * @param {any} session
   * @param {any} event
   */
  function handleSessionEvent(session, event) {
    if (!event || typeof event !== 'object') return
    const sessionId = String(session?.id ?? session?.sessionId ?? '')
    if (event.type === 'turn/end') {
      handleTurnEnd({ sessionId, reason: event.data?.reason })
      return
    }
    if (event.type === 'turn/start') {
      currentTurn.set(sessionId, event.data?.turn ?? null)
      return
    }
    const pending = pendingRecovery.get(sessionId)
    if (!pending) return
    if (event.type === 'user/message') {
      const message = event.data?.message ?? event.data
      if (message?.id === pending.id) {
        pending.admitted = true
        pending.turn = currentTurn.get(sessionId) ?? null
      } else if (!message?.source?.kind || message.source.kind === 'user') {
        // 人工消息接管了后续输出，不能归功于自动续跑。
        pendingRecovery.delete(sessionId)
      }
      return
    }
    if (event.type === 'assistant/message') {
      const data = event.data ?? {}
      const message = data.message ?? data
      const visible = message.content?.some?.(b => b.type === 'text' && b.text?.trim())
      if (pending.admitted && visible && pending.turn != null && data.turn === pending.turn) {
        stats.bump('recovered', now())
        consecutive.delete(sessionId)
        pendingRecovery.delete(sessionId)
        emit('recover', sessionId, '续跑消息 ' + pending.id + ' 入队后在对应回合观察到可见输出')
      }
    }
  }

  /**
   * 启动扫描里针对**单个会话**的续跑判定。
   *
   * 为什么不用调用方给的 reason 直接走 classifyTurnEnd：启动扫描面对的典型形状
   * 是 `{kind:'interrupted'}`（崩溃补写的收尾标记），而契约 §3 明确规定
   * interrupted **不触发续跑** —— 那条规则约束的是**活循环**的判定，
   * 而启动扫描的语义恰好相反：「进程崩了，把断在中间的会话接上」。
   *
   * 所以这里把「生命周期标记」翻译成一个等价的、**可恢复**的原因再走同一套闸门
   * （时段 / 暂停 / 冷却 / 上限一个都不绕），而不是另开一条旁路。
   *
   * @param {string} sessionId
   * @param {object} [reason] 调用方给的原始原因
   * @returns {object} handleTurnEnd 的返回值
   */
  function resumeOne(sessionId, reason) {
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'interrupted'
    const live = kind === 'completed' || kind === 'aborted' || kind === 'blocked' || kind === 'forked'
    // 活循环才发得出来的原因：启动扫描不该替它们决定续跑（用户可能只是关掉了窗口）。
    if (live) return { action: 'skip', kind, note: 'not-a-startup-case' }
    const effective = kind === 'error' || kind === 'max-tokens'
      ? reason
      // interrupted（或没给原因）：等价成一次「进程退出导致的临时性中断」。
      : { kind: 'error', error: { message: 'startup recovery: 进程在回合中途退出', status: 503 } }
    return handleTurnEnd({ sessionId, reason: effective })
  }

  /**
   * 启动扫描：宿主重启后，把"上次运行留下的、还没来得及续的"会话补上。
   *
   * **按会话隔离异常**：一个会话的投递炸了不许影响其余会话 ——
   * 这是本方法存在的全部理由。一个坏会话不该让另外九个该续的会话都停着。
   *
   * 为什么要 `await` 每一次投递：投递是异步的，只 try/catch 同步部分的话，
   * 失败会变成未处理拒绝，扫描却报告说「续上了」。所以要等它落定再计数。
   *
   * @param {Array<{sessionId: string, reason?: object}>} [list]
   * @returns {Promise<{scanned: number, resumed: number, failed: Array<{sessionId: string, error: string}>}>}
   */
  async function scanStartup(list) {
    const source = Array.isArray(list) ? list : listSessions()
    const cfg = config()
    const result = { scanned: 0, resumed: 0, failed: [] }

    if (cfg.enabled === false) return result
    if (!Array.isArray(source)) return result

    for (const item of source) {
      const sessionId = String(item?.sessionId ?? item?.id ?? '')
      if (!sessionId) continue
      result.scanned += 1
      // ★ 按会话隔离：这一个炸了只是它自己进 failed[]，循环继续。
      try {
        const outcome = resumeOne(sessionId, item?.reason)
        if (outcome.action !== 'fire' && outcome.action !== 'defer') {
          result.failed.push({
            sessionId,
            error: '未续跑：' + String(outcome.note ?? outcome.action),
          })
          continue
        }
        // 投递是异步的 —— 必须等它落定才知道这一路到底成没成。
        const task = inflight.get(sessionId)
        if (task !== undefined) await task
        result.resumed += 1
      } catch (error) {
        result.failed.push({ sessionId, error: messageOf(error) })
        emit('error', sessionId, '启动扫描处理失败：' + messageOf(error))
      }
    }
    return result
  }

  /* ---------------- 生命周期 ---------------- */

  /** 挂 ctx 监听。ctx 不可用时静默跳过（非 Web / 无 agents 的组合也能构造引擎）。 */
  function start() {
    if (disposed) return { mounted: 0 }
    let mounted = 0
    if (ctx && typeof ctx.on === 'function') {
      try {
        const offEvent = ctx.on('session/event', (session, event) => {
          try { handleSessionEvent(session, event) } catch (error) {
            emit('error', null, 'session/event 处理异常：' + messageOf(error))
          }
        })
        if (typeof offEvent === 'function') { offs.push(offEvent); mounted += 1 }
      } catch (error) { log?.warn?.('session/event 挂载失败：' + messageOf(error)) }

      try {
        const offTool = ctx.on('tools/result', (exec, result) => {
          try {
            handleToolResult({
              sessionId: String(exec?.agent?.session?.id ?? exec?.agent?.id ?? ''),
              name: String(exec?.name ?? ''),
              result,
            })
          } catch { /* 观测失败不影响工具本身 */ }
        })
        if (typeof offTool === 'function') { offs.push(offTool); mounted += 1 }
      } catch (error) { log?.warn?.('tools/result 挂载失败：' + messageOf(error)) }
    }
    return { mounted }
  }

  /** 全量清理：取消全部定时器 + 卸载全部监听。必须可重复调用。 */
  function dispose() {
    if (disposed) return { timers: 0, listeners: 0 }
    disposed = true
    pendingRecovery.clear()
    currentTurn.clear()
    const timerCount = timers.size
    cancelAll()
    let listenerCount = 0
    while (offs.length > 0) {
      const off = offs.pop()
      try { off?.() } catch { /* 清理失败无所谓 */ }
      listenerCount += 1
    }
    consecutive.clear()
    cooldownUntil.clear()
    paused.clear()
    lastTimedOutAt.clear()
    sending.clear()
    inflight.clear()
    return { timers: timerCount, listeners: listenerCount }
  }

  /* ---------------- 状态与操作 ---------------- */

  function getStatus() {
    const cfg = config()
    const snapshot = stats.snapshot(now())
    const attemptsOut = []
    for (const [sessionId, list] of attempts) {
      void sessionId
      attemptsOut.push(...list)
    }
    attemptsOut.sort((a, b) => b.at - a.at)
    return {
      ok: true,
      data: {
        version: typeof options.version === 'string' ? options.version : '0.1.0',
        home,
        config: cfg,
        paused: [...paused.entries()].map(([sessionId, until]) => ({ sessionId, until })),
        stats: snapshot,
        attempts: attemptsOut.slice(0, ATTEMPT_KEEP),
        schedule: describeSchedule(cfg),
        scheduleActive: isScheduleActive(cfg, now()),
        msUntilWindowOpen: msUntilWindowOpen(cfg, now()),
        consecutive: [...consecutive.entries()].map(([sessionId, count]) => ({ sessionId, count })),
        loopBudget: loopBudget(),
      },
    }
  }

  function resetStats() {
    stats.reset(now())
    attempts.clear()
    consecutive.clear()
    cooldownUntil.clear()
    return getStatus()
  }

  function resetLoop() {
    stats.resetLoop()
    return getStatus()
  }

  function pause(sessionId, until) {
    const key = String(sessionId ?? '')
    if (!key) return { ok: false, error: '缺少 sessionId' }
    const deadline = Number.isFinite(until) ? until : now() + 24 * 3600 * 1000
    paused.set(key, deadline)
    return { ok: true, sessionId: key, until: deadline }
  }

  function unpause(sessionId) {
    const key = String(sessionId ?? '')
    const existed = paused.delete(key)
    return { ok: true, sessionId: key, cleared: existed }
  }

  return {
    handleTurnEnd,
    handleToolResult,
    handleSessionEvent,
    scanStartup,
    rescan: scanStartup,
    start,
    dispose,
    getStatus,
    resetStats,
    resetLoop,
    pause,
    unpause,
    isPaused,
    internals: { stats, events, consecutive, paused, attempts, lastTimedOutAt, timers },
  }
}

export { DEFAULT_CONTINUE_TEXT }
