/**
 * Laurel-Center · 一次性迁移（第二轮 F1 重写）
 *
 * 旧版本把「哪个子插件开着」记在 `$DSH_HOME/laurel-center/state.json`，并在**每次开机**
 * 把它同步回 loader —— 那条路会盖掉用户在 profile `cordis.patch.yml` 里显式写的决定。
 *
 * 现在配置的唯一真相是 profile 的 patch（用户层）。state.json 降级为**一次性迁移输入**：
 * 只把它当成「用户过去点过开」的旧记录，读一次，**不改它**。
 *
 * ── 第一轮为什么不够（本轮实测的两条反例）─────────────────────────────────
 *   1. 旧 state 记 `laurel:true`，用户层显式写 `disabled: true`。旧逻辑只看宿主报的
 *      `enabled === false` 就当成「默认值，可以迁」，于是把用户的明确关闭改回打开。
 *   2. 启动时原生服务还没就绪（所有行 `no-native`），计划为空却**照样**写下
 *      `migratedAt` —— 配置一行没迁，标记却说「已迁移」，此后永不再处理。
 *
 * ── 现在的规则 ────────────────────────────────────────────────────────────
 *   · 只迁移「state 说开」的行（不迁移「关」——那才是真的绕过用户层优先级）
 *   · 用户层**有显式顶层条目**（开或关都算）→ 一律不碰，记 `skipped-by-user`
 *   · 原生行映射不上（缺行/重复/只读/服务未就绪）→ 记 `pending`，**不打完成标记**
 *   · 旧数据归属判不出来（拿不到 profile 身份、用户层读不了）→ 记 `unattributed`，
 *     只给可审查的建议，不往任意 profile 写
 *   · 完成状态**按 profile 记**，不是全 Home 一个 `migratedAt`
 *     （否则第一个 profile 迁移完，第二个 profile 就被那个标记吞掉）
 *
 * 本文件是纯函数，IO 与生命周期在 lib/index.js。
 */

import { SUB_PLUGINS } from './registry.js'
import { hasExplicitOverride } from './patch.js'

/** 单条的处置结果。 */
export const ACTIONS = {
  migrate: 'migrate',                 // 要写用户层，把它打开
  alreadyOn: 'already-on',            // 用户层/宿主已经是开的
  skippedByUser: 'skipped-by-user',   // 用户层有显式条目（含显式关闭）
  pending: 'pending',                 // 原生还没就绪 / 映射冲突 → 下次再试
  unattributed: 'unattributed',       // 判不出归属或读不了用户层 → 不写
  notRequested: 'not-requested',      // 旧 state 说关，本来就不迁
}

/** 顶层原因码。 */
export const REASONS = {
  noSavedState: 'no-saved-state',
  alreadyMigrated: 'already-migrated',
  unattributed: 'unattributed',
  userLayerUnreadable: 'user-layer-unreadable',
  pending: 'pending',
  nothingToMigrate: 'nothing-to-migrate',
  pendingWrites: 'pending-writes',
}

/** 只有这两个动作会真的往用户层写。 */
const WRITE_ACTIONS = [ACTIONS.migrate]

/**
 * 算出这次要不要迁移、迁移哪些、以及能不能打完成标记。
 *
 * @param {{ enabled: Record<string, boolean>, updatedAt: string | null }} saved 旧 state（只读）
 * @param {Record<string, { state: string, enabled?: boolean }>} native 原生状态
 * @param {{
 *   overrides?: Record<string, unknown> | null,
 *   userLayerOk?: boolean,
 *   attribution?: { ok: boolean, key?: string | null, reason?: string | null } | null,
 *   completed?: boolean,
 * }} [options]
 *   `overrides`      —— 用户层显式条目（lib/patch.js 的 `readUserOverrides().overrides`）
 *   `userLayerOk`    —— 用户层读没读成功；false 时不许自动写
 *   `attribution`    —— 这次能不能确定「旧数据属于当前 profile」
 *   `completed`      —— 当前 profile 是否已经记过完成
 * @returns {{
 *   needed: boolean, terminal: boolean, reason: string,
 *   items: Array<{ id: string, action: string, detail: string | null }>,
 *   pending: string[], writes: string[],
 * }}
 */
export function planMigration(saved, native, options = {}) {
  const none = (reason) => ({ needed: false, terminal: false, reason, items: [], pending: [], writes: [] })

  if (!saved || saved.updatedAt === null || saved.updatedAt === undefined) return none(REASONS.noSavedState)
  if (options.completed === true) return none(REASONS.alreadyMigrated)

  const attribution = options.attribution ?? { ok: false, reason: 'no-profile-context' }
  const items = []

  // 归属判不出来：不往任何 profile 写，把「建议」原样交回去给人和日志看。
  if (!attribution.ok) {
    for (const p of SUB_PLUGINS) {
      if (saved.enabled?.[p.id] !== true) continue
      items.push({ id: p.id, action: ACTIONS.unattributed, detail: attribution.reason ?? 'unknown-owner' })
    }
    return { needed: false, terminal: false, reason: REASONS.unattributed, items, pending: [], writes: [] }
  }

  // 用户层读不了 → 无法判断有没有显式关闭，绝不自动写。
  if (options.userLayerOk === false) {
    for (const p of SUB_PLUGINS) {
      if (saved.enabled?.[p.id] !== true) continue
      items.push({ id: p.id, action: ACTIONS.unattributed, detail: REASONS.userLayerUnreadable })
    }
    return { needed: false, terminal: false, reason: REASONS.userLayerUnreadable, items, pending: [], writes: [] }
  }

  const overrides = options.overrides ?? {}

  for (const p of SUB_PLUGINS) {
    const want = saved.enabled?.[p.id] === true
    if (!want) {
      items.push({ id: p.id, action: ACTIONS.notRequested, detail: null })
      continue
    }
    // 用户层有显式条目（开或关）：用户已经表态，迁移闭嘴。
    if (hasExplicitOverride(overrides, p.id)) {
      items.push({ id: p.id, action: ACTIONS.skippedByUser, detail: 'explicit-user-layer-entry' })
      continue
    }
    const row = native?.[p.id]
    if (!row || row.state !== 'ready') {
      // 映射不上 / 服务未就绪：这次不写，也不打完成标记。
      items.push({ id: p.id, action: ACTIONS.pending, detail: row?.state ?? 'missing' })
      continue
    }
    if (row.enabled === true) {
      items.push({ id: p.id, action: ACTIONS.alreadyOn, detail: null })
      continue
    }
    items.push({ id: p.id, action: ACTIONS.migrate, detail: null })
  }

  const pending = items.filter((i) => i.action === ACTIONS.pending).map((i) => i.id)
  const writes = items.filter((i) => WRITE_ACTIONS.includes(i.action)).map((i) => i.id)
  const terminal = pending.length === 0
  const needed = writes.length > 0
  let reason = REASONS.nothingToMigrate
  if (!terminal) reason = REASONS.pendingWrites
  else if (needed) reason = REASONS.pending
  return { needed, terminal, reason, items, pending, writes }
}

/**
 * 逐项「这次算不算完成」。
 *
 * ── 为什么不能「有 outcome 就算完成」（第三轮 G1）─────────────────────────
 * 上一版 `canRecordCompletion` 只检查每个待写 id 有没有 outcome，注释还写着
 * 「成功 / 失败都算终态」。于是**写入失败也会打上 profile 完成标记**，下一次启动直接
 * `already-migrated` 跳过 —— 配置一行没迁，用户却永远失去了那次迁移。
 * 实测（真隔离文件 + 受控原生写失败）：第一次 outcome=failure 却 recorded=true，
 * 解除故障再跑 → already-migrated，原生总调用只有 1 次，patch 仍是 `[]`。
 *
 * 现在：**只有确知保存到目标**（`saved === true`）、用户明确表态、或本来就无需处理，
 * 才算完成。失败 / 未确认 / 取消一律保留为未完成，下次启动重新核对用户层再处理。
 *
 * 注意 `partial` 本身不足以判定保存成立：必须带 `saved` 证据。
 * `restart-required` / `reload-failed` 都是 `saved:true`（用户层已到位）→ 算完成；
 * `unknown`（saved 为 null）不算。
 */
export function itemCompletion(action, outcome) {
  if (action === ACTIONS.migrate) {
    if (!outcome) return false
    return outcome.outcome === 'success' || (outcome.outcome === 'partial' && outcome.saved === true)
  }
  return action === ACTIONS.alreadyOn || action === ACTIONS.skippedByUser || action === ACTIONS.notRequested
}

/**
 * 这次执行之后，profile 层面能不能记「完成」。
 *
 * @param {ReturnType<typeof planMigration>} plan
 * @param {Record<string, { outcome: string, saved?: boolean | null, reason?: string, code?: string }>} outcomes
 * @returns {{ complete: boolean, noop: boolean, done: string[], incomplete: Array<{id: string, action: string, reason: string}> }}
 */
export function completionState(plan, outcomes = {}) {
  const done = []
  const incomplete = []
  for (const item of plan.items) {
    const outcome = outcomes[item.id] ?? null
    if (itemCompletion(item.action, outcome)) {
      done.push(item.id)
      continue
    }
    incomplete.push({ id: item.id, action: item.action, reason: outcome?.reason ?? outcome?.outcome ?? item.action })
  }
  const noop = plan.reason === REASONS.noSavedState || plan.reason === REASONS.alreadyMigrated
  return { complete: !noop && incomplete.length === 0, noop, done, incomplete }
}
