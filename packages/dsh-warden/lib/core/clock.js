/**
 * dsh-warden · 可注入时钟
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────────
 * 锁 TTL、等待期限、提醒冷却、阶段预算全是"时间到了没有"的判断。原先这些
 * 判断直接读 `Date.now()`，于是过期锁的单测只能写成「TTL=1ms，然后赌调度器
 * 在这 1ms 里没跑完」—— 快机器上它就没过期，用例随机失败（评审实测 82/83）。
 *
 * 这里把"现在几点"和"帮我定个时"收成一个小接口。生产用 `systemClock()`，
 * 测试用 `fakeClock()` 手动推进，**不再有真实时间竞速**。
 *
 * 依赖只有 node 内置，且这一层不 import 任何宿主包。
 */

/** 生产时钟。 */
export function systemClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  }
}

/**
 * 手动推进的假时钟。
 *
 * `advance(ms)` 会按到期顺序触发定时器（一次推进跨过多个定时器时，
 * 中间的定时器也会依次触发，`now()` 在每个回调里都是它当时的到期时刻），
 * 这样"续租把过期时间推后"这类逻辑能被真实地测出来。
 *
 * @param {number} [start] 起始时刻，默认 0
 */
export function fakeClock(start = 0) {
  let current = Number(start) || 0
  let seq = 0
  /** @type {Map<number, {at: number, fn: () => void}>} */
  const timers = new Map()

  const clock = {
    now: () => current,
    setTimeout(fn, ms) {
      const id = ++seq
      const delay = Number(ms)
      timers.set(id, { at: current + (Number.isFinite(delay) && delay > 0 ? delay : 0), fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    /** 当前挂着的定时器数量。测试断言"没有泄漏定时器"用。 */
    get pending() {
      return timers.size
    },
    /** 手动推进。返回本次触发了多少个定时器。 */
    advance(ms) {
      const target = current + Math.max(0, Number(ms) || 0)
      let fired = 0
      for (;;) {
        let nextId = null
        let nextAt = Infinity
        for (const [id, entry] of timers) {
          if (entry.at <= target && entry.at < nextAt) { nextAt = entry.at; nextId = id }
        }
        if (nextId === null) break
        const entry = timers.get(nextId)
        timers.delete(nextId)
        current = Math.max(current, entry.at)
        fired++
        try { entry.fn() } catch { /* 测试里的回调自己负责断言 */ }
      }
      current = target
      return fired
    },
    /** 直接跳到某个绝对时刻。 */
    setTo(value) {
      const target = Number(value) || 0
      return clock.advance(Math.max(0, target - current))
    },
  }
  return clock
}
