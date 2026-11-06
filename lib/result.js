/**
 * Laurel-Center · 结果封套（第二轮 F2 重写）
 *
 * ── 旧实现的两个谎报 ──────────────────────────────────────────────────────
 *   1. 写盘失败仍返回 `{ ok: true }` —— 用户以为设置保住了，重启后打回原形。
 *   2. bulk 内层 `{ ok:false, failed:[...] }` 被外层包成 `{ ok:true, data }`，
 *      调用者把它当普通成功。
 *
 * ── 现在的合同 ────────────────────────────────────────────────────────────
 * 解释只有一份（`lib/change-result.js`，宿主与客户端共用），本文件只负责**包封套**：
 * 每次操作带一个 `operationId`，逐项给：
 *   `outcome`      —— `success | partial | failure | unknown`
 *   `saved`        —— 用户层配置是否**确认**落到了目标值（`null` = 没确认）
 *   `applied`      —— 宿主是否已在本进程内应用
 *   `reason`       —— 稳定原因码（`restart-required` / `reload-failed` / `unconfirmed` …）
 *   `code`         —— 稳定机器码（`ok` / `no-native` / `missing` / …）
 *   `diagnostic`   —— 给人和日志看的原文
 * 整体 `outcome` 由逐项汇总，**不允许**用「内层失败、外层成功」的形状掩盖；
 * 任何 `partial` / `unknown` 都不许折成 `success`。
 */

import { itemOutcome, reasonOf, summarizeChange } from './change-result.js'

/** 逐项 → outcome（转给共用解释器）。 */
export { itemOutcome }

/** 汇总一批逐项结果。 */
export function summarize(items) {
  return summarizeChange(items)
}

/** 生成一次操作的稳定 id。不依赖 crypto，避免客户端环境差异。 */
export function newOperationId(prefix = 'op') {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}

/**
 * 把逐项结果包成统一响应。
 * 关键：**没有** `{ ok: true }` 这种一票通过的外壳 —— 调用者必须看 `outcome`。
 */
export function envelope(operationId, items, extra = {}) {
  const list = Array.isArray(items) ? items : []
  return {
    operationId,
    ...summarize(list),
    items: list.map((i) => ({
      id: i.id,
      outcome: itemOutcome(i),
      reason: reasonOf(i),
      saved: i.saved === true ? true : i.saved === false ? false : null,
      applied: i.applied === true || i.hostApplied === true,
      application: i.application,
      changed: i.changed === true,
      restartHelps: i.restartHelps === true,
      code: i.code ?? (i.ok ? 'ok' : 'unknown'),
      entryId: i.entryId,
      diagnostic: i.diagnostic,
      warnings: i.warnings ?? [],
    })),
    ...extra,
  }
}
