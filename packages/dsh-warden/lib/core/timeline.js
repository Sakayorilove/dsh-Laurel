/**
 * dsh-warden · 会话内位置（用户回合 / 步）
 *
 * ── 为什么要单独一层 ──────────────────────────────────────────────────
 * 提醒节流需要"同一文件、同一类型，**每个用户回合**最多一条"（坑1），
 * 归档事件需要能事后对齐"这是第几步发生的"（坑3）。
 * 这两个数字都**只从宿主的 `session/event` 来**，不猜、不数工具调用：
 *
 *   - `turn/start`  → 新的用户回合（一个"用户回合"= 用户发一句到模型交还控制权）
 *   - `step/start`  → 新的步（模型一次回复）
 *
 * ⚠ 为什么不用 `user/message` 当回合边界：注入的提醒本身就是 role=user 的消息，
 * 也会产生 `user/message`。实测 2026-10-16 那次会话里 `user/message` 共 232 条，
 * 其中 **151 条正是 warden 自己注入的提醒**（source.kind === 'warden'），
 * 真正的用户回合只有 26 个（`turn/start`）。拿 user/message 当边界，
 * 等于每发一条提醒就重置一次额度 —— 节流会自己把自己放开。
 *
 * ⚠ 拿不到事件时 turn/step 保持 **null**（不是 0）。调用方必须按"未知"处理：
 * 节流退回"只按会话上限"，绝不能把 0 当成"第 0 回合"来下结论。
 */

/** 会话表上限，防止长跑进程按会话无限增长。 */
const MAX_SESSIONS = 200

export class SessionTimeline {
  constructor() {
    /** @type {Map<string, {turn: number, step: number, turnKnown: boolean, stepKnown: boolean}>} */
    this.bySession = new Map()
  }

  /**
   * 吃一个 `session/event`。
   *
   * @returns {'turn'|'step'|null} 认出来的类型；不认识的返回 null（调用方不必分支）
   */
  observe(sessionId, event) {
    const type = String(event?.type ?? '')
    if (type !== 'turn/start' && type !== 'step/start' && type !== 'assistant/message') return null
    const s = this.session(sessionId)
    if (type === 'turn/start') { s.turn += 1; s.turnKnown = true; return 'turn' }
    s.step += 1
    s.stepKnown = true
    return 'step'
  }

  /**
   * 当前位置。**未知就是 null**，不要拿 0 当第一个回合/第一步。
   *
   * @returns {{turn: number|null, step: number|null, turnKnown: boolean, stepKnown: boolean}}
   */
  position(sessionId) {
    const s = this.bySession.get(String(sessionId ?? '-'))
    if (!s) return { turn: null, step: null, turnKnown: false, stepKnown: false }
    return {
      turn: s.turnKnown ? s.turn : null,
      step: s.stepKnown ? s.step : null,
      turnKnown: s.turnKnown,
      stepKnown: s.stepKnown,
    }
  }

  session(sessionId) {
    const id = String(sessionId ?? '-')
    let bucket = this.bySession.get(id)
    if (!bucket) {
      bucket = { turn: 0, step: 0, turnKnown: false, stepKnown: false }
      this.bySession.set(id, bucket)
      if (this.bySession.size > MAX_SESSIONS) {
        const first = this.bySession.keys().next().value
        this.bySession.delete(first)
      }
    }
    return bucket
  }

  reset(sessionId) {
    if (sessionId === undefined) this.bySession.clear()
    else this.bySession.delete(String(sessionId ?? '-'))
  }

  size() { return this.bySession.size }
}
