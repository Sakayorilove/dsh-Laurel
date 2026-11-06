/**
 * dsh-warden · 提醒节流（nudge throttle）
 *
 * ── 为什么会有这个文件 ────────────────────────────────────────────────
 * 0.2.0 的 rework/reread 提醒用 `shouldFire(count, threshold)`：**正好踩线，
 * 以及之后每个整数倍**都发。于是一次 3 小时会话里，同一个文件改到 72 次，
 * 就产生了 24 条几乎一样的提醒（实测 151 条提醒里 123 条是这两类，
 * 占提醒成本 90%），而计数从 ×3 涨到 ×72 期间**没有任何提醒改变了行为**。
 *
 * 两条策略（由 `nudgeOnceOnly` 选）：
 *
 * ── `nudgeOnceOnly: true`（0.3.0 起的默认）──────────────────────────────
 * 同一 `(sessionId, kind, key)` **只发一条完整提醒，之后永不再发**：
 * 不翻倍、不升级硬动作、不重复一行计数。理由是 2026-10-17 的实测：
 * 每条注入都会被之后**每一步**重发一次（水位提醒 142 条 × 203 字符 ≈
 * 2.9 万字符常驻），而重复提醒对行为改变是 0 —— 那就把"周期性播报"
 * 彻底换成"踩线时报一次，讲清楚，然后闭嘴"。
 *
 * ── `nudgeOnceOnly: false`（向后兼容路径）──────────────────────────────
 * 1. 首次踩线发一条（soft）；
 * 2. 之后只在**计数翻倍**时再发（3 → 6 → 12 …），摊薄刷屏；
 * 3. 到达 `nudgeHardAt` 时发**一条硬动作**（hard）：要求先落盘/说清试过什么/
 *    换策略，并声明这已是本会话对该键的最后一条；
 * 4. 每个键的 soft 条数上限 `nudgeMaxPerKey`，硬动作之后彻底闭嘴；
 * 5. **每个用户回合、每个键最多 `nudgeMaxPerTurn` 条**（默认 1）——
 *    同一回合里已经说过就不再叠第二条；回合边界只认 `turn/start`
 *    （见 core/timeline.js 的说明：`user/message` 里混着提醒自己）；
 * 6. 调用方按 `sent` 决定呈现：`sent === 1` 发全文，`sent > 1` 只发
 *    一行计数更新 —— "第 2 次起不再重发全文"落在这里（行为不变、成本减半）。
 *
 * 两条路径都保留"每个用户回合"的额度闸门：一次性不等于可以绕过回合上限。
 *
 * 纯函数式状态机，不依赖宿主、不读盘，方便单测与离线回放。
 */

/** 夹到 [lo, hi] 的整数。 */
function clampInt(value, lo, hi, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

/** 状态表上限：防止长跑进程里按 session×路径 无限增长。 */
const MAX_KEYS = 5000

/**
 * 这一次要不要走"只提醒一次"。
 *
 * 默认 **true**（0.3.0）：配置层、三档预设、DEFAULT_CONFIG 都写了 true，
 * 这里再兜一次底，避免调用方漏传时退回周期性播报。
 * 只有显式 `false` 才走旧的"翻倍 + 硬动作 + 上限"路径。
 */
function resolveOnceOnly(cfg, defaults) {
  const raw = cfg?.nudgeOnceOnly ?? defaults?.nudgeOnceOnly
  return raw === undefined ? true : raw !== false
}

/**
 * @param {object} defaults 默认配置（一般传 {}，逐次调用时用 cfg 覆盖）
 */
export function createNudgePolicy(defaults = {}) {
  const state = new Map()
  /** 跨键的"每回合总量"额度：`{turn, used}`。`turn === null` 表示拿不到回合信息。 */
  let turnBudget = { turn: null, used: 0 }

  return {
    /**
     * 决定这一次要不要发提醒。
     *
     * @param {string} kind      'rework' | 'reread' | 其它自定义键前缀
     * @param {string} sessionId 会话 id
     * @param {string} key       已含类型前缀的键（如 `w:<path>`）
     * @param {number} count     该键的累计次数（由 counters.bump 得到）
     * @param {number} threshold 首次触发阈值
     * @param {object} cfg       当次配置（nudgeOnceOnly / nudgeMaxPerKey / nudgeHardAt / nudgeMaxPerTurn）
     * @param {{turn?: number|null}} [where] 当前位置（见 core/timeline.js）。
     *   `turn` 有值时才按"每个用户回合最多 nudgeMaxPerTurn 条"限流；
     *   拿不到（null/undefined）就退回"只按会话上限"，**不猜回合**。
     * @returns {{tier:'soft'|'hard', sent:number, count:number}|null}
     *   `sent` 是该键在本会话里发出的第几条（1 起）：调用方据此决定
     *   "发全文"还是"只发一行计数更新"（坑1：第 2 次起不再重发全文）。
     *   `nudgeOnceOnly: true` 时 `sent` 恒为 1，且同一键之后永远返回 null。
     */
    decide(kind, sessionId, key, count, threshold, cfg = {}, where = {}) {
      const th = Number(threshold) > 0 ? Number(threshold) : 3
      const n = Number(count)
      if (!Number.isFinite(n) || n < th) return null
      const onceOnly = resolveOnceOnly(cfg, defaults)

      const maxSoft = clampInt(cfg.nudgeMaxPerKey ?? defaults.nudgeMaxPerKey, 1, 20, 3)
      const hardAt = clampInt(cfg.nudgeHardAt ?? defaults.nudgeHardAt, 2, 500, 9)
      const maxPerTurn = clampInt(cfg.nudgeMaxPerTurn ?? defaults.nudgeMaxPerTurn, 1, 10, 1)
      const turnBudgetMax = clampInt(cfg.nudgeTurnBudget ?? defaults.nudgeTurnBudget, 1, 20, 1)
      const turn = Number.isFinite(where?.turn) ? Number(where.turn) : null
      const mapKey = `${sessionId ?? ''}|${kind}|${key}`

      if (state.size > MAX_KEYS) state.clear()
      const st = state.get(mapKey) ?? { sent: 0, last: 0, hard: false, turn: null, turnSent: 0 }

      // 换用户回合 → 本回合的额度重新开始。拿不到 turn 就不按回合限流。
      if (turn !== null && st.turn !== turn) { st.turn = turn; st.turnSent = 0 }
      if (turn !== null && turnBudget.turn !== turn) turnBudget = { turn, used: 0 }
      // 两道回合闸门：本键在本回合的额度（nudgeMaxPerTurn）+ 全会话每回合总量
      // （nudgeTurnBudget）。后者是"上限的保证"：一次会话里提醒条数 ≤ 回合数 × 总量。
      const canSpeak = (turn === null || st.turnSent < maxPerTurn)
        && (turn === null || turnBudget.used < turnBudgetMax)

      // 已经发过硬动作 → 本会话对该键彻底闭嘴。
      if (st.hard) return null

      // ── 一次性策略（nudgeOnceOnly: true，默认）─────────────────────
      // 同一 (sessionId, kind, key) 首次踩线发一条完整提醒，之后永不再发。
      // 不翻倍、不升级硬动作 —— 2026-10-17 的实测是：重复播报的注入成本
      // 是线性的，而行为改变是 0。回合额度仍然生效（一次性 ≠ 无限量）。
      if (onceOnly) {
        if (st.sent > 0) return null
        // 本回合/总量额度已用完：本次不发、也不消耗，下一次调用（通常下个回合）
        // 仍然满足"首次踩线"，照样会发。
        if (!canSpeak) return null
        st.sent = 1
        st.last = n
        st.turnSent += 1
        if (turn !== null) turnBudget.used += 1
        state.set(mapKey, st)
        return { tier: 'soft', sent: 1, count: n }
      }

      // 硬动作：只发一次，且之后不再发 soft。
      // 本回合额度已用完时不发，但**也不消耗**它 —— 计数只增不减，
      // 条件在下一次调用（通常是下一个用户回合）依然成立。
      if (hardAt >= th && n >= hardAt) {
        if (!canSpeak) return null
        st.hard = true
        st.sent += 1
        st.last = n
        st.turnSent += 1
        if (turn !== null) turnBudget.used += 1
        state.set(mapKey, st)
        return { tier: 'hard', sent: st.sent, count: n }
      }

      // soft：首次踩线，或计数翻倍时才发；超过 soft 上限就静默。
      const first = st.sent === 0
      const doubled = st.last > 0 && n >= st.last * 2
      if (!first && !doubled) return null
      if (st.sent >= maxSoft) return null
      if (!canSpeak) return null

      st.sent += 1
      st.last = n
      st.turnSent += 1
      if (turn !== null) turnBudget.used += 1
      state.set(mapKey, st)
      return { tier: 'soft', sent: st.sent, count: n }
    },

    /** 只读快照，便于测试与诊断。 */
    snapshot() {
      return [...state.entries()].map(([k, v]) => ({ key: k, ...v }))
    },

    reset() {
      state.clear()
    },
  }
}
