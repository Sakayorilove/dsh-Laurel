/**
 * laurel-memory/retention-plane —— L11：让容量治理**真的有调度方**。
 *
 * ── 这个文件为什么存在（缺陷 L11，2026-10-22）───────────────────────────
 * `laurel-core/lib/retention.mjs` 早就写完了（33KB，`plan`/`apply`/`rollback`
 * 全在，`laurel-core/lib/index.mjs` 也 `export * as retention` 了），但
 * `grep -n retention` 在 `laurel-memory/lib/index.js` 与
 * `laurel-context/lib/index.js` **零命中** —— 模块在、调度不在。
 * 结果就是真仓两天长到 274MB（memory/ 单目录），没有任何东西会去问
 * 「这些 blob 还有人引用吗」。
 *
 * 手册 L11 的修法原文：「按 `coreId+projectId` 分卷 + 时间/体积 rotation；
 * blob 与 record 同生命周期；**保留 journal 不删**，只轮转 reads 侧」。
 * `retention.mjs` 实现的正是这个安全子集（引用计数而非年龄，journal 永不动）。
 * 这里补的是它缺的另一半：**谁在什么时候调它**，以及**结果从哪儿看得见**。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────
 *  1. **默认 dry-run**。真跑会删文件（哪怕有 tgz 备份），这种事不该由插件
 *     自己决定。`plan()` 才是默认动作；`apply` 必须显式 `apply:true` 才走，
 *     而且要等一次成功的 plan（不知道可回收多少就删，等于闭眼动刀）。
 *  2. **失败不抛**。治理是后台维护，它坏了不能连带记忆读写和宿主对话一起坏。
 *     所有异常记进 `lastError`，端点可见。
 *  3. **必须能回答「多久没跑过」**。`lastRunAt`/`nextRunAt`/`runs`/`skips`
 *     每次都写进状态 —— 一个没有心跳的定时器看起来和没接上完全一样。
 */

import { plan as planRetention, apply as applyRetention } from '../../laurel-core/lib/retention.mjs'

/** 默认间隔 6 小时：真仓 scanReferences 约 1.6~3.4 秒（4 万 journal 单元 / 3.7 万 blob），
 *  跑得比这更勤只会反复做同一份扫描而没有新孤儿可收。 */
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 首次延后 30 秒：apply 期宿主正忙着装载其它插件，scanReferences 是全盘扫，
 *  不要在启动路径上跟它抢盘。 */
export const DEFAULT_FIRST_DELAY_MS = 30 * 1000

/**
 * @param {object} opts
 * @param {string|null} opts.vaultDir
 * @param {object} [opts.policy]      透传给 `retention.normalizePolicy` 的策略（见 laurel-core）
 * @param {boolean} [opts.apply]      只有 true 才真删；默认 false = 只 plan
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.firstDelayMs]
 * @param {boolean} [opts.enabled]
 * @param {{info?:Function,warn?:Function}} [opts.log]
 * @param {() => number} [opts.clock]
 */
export function createRetentionPlane({
  vaultDir = null,
  policy = {},
  apply = false,
  intervalMs = DEFAULT_INTERVAL_MS,
  firstDelayMs = DEFAULT_FIRST_DELAY_MS,
  enabled = true,
  log = null,
  clock = Date.now,
} = {}) {
  const state = {
    state: 'idle', // idle | scheduled | ran | disabled | unavailable
    enabled: enabled === true && !!vaultDir,
    mode: apply === true ? 'apply' : 'plan-only',
    vaultDir,
    intervalMs,
    firstDelayMs,
    runs: 0,
    skips: 0,
    errors: 0,
    lastRunAt: null,
    lastRunMode: null,
    lastElapsedMs: null,
    nextRunAt: null,
    lastError: null,
    lastReport: null,
  }
  let timer = null
  let disposed = false

  /** 只留端点/面板要的那几项：整份 report 带 candidates 明细，几万条会把状态页撑爆。 */
  function summarize(report) {
    if (!report || typeof report !== 'object') return null
    return {
      ok: report.ok === true,
      mode: report.mode ?? null,
      dryRun: report.dryRun === true,
      candidateCount: report.candidateCount ?? null,
      reclaimableBytes: report.reclaimableBytes ?? null,
      byKind: report.byKind ?? null,
      orphanBlobs: report.orphanBlobs ?? null,
      blobTotal: report.blobTotal ?? null,
      journalUnits: report.journalUnits ?? null,
      // 真跑模式（`mode:'applied'`）的 archive 报告键名是 `rotated`，dry-run 是 `rotate`
      // —— 这两种模式各写一次字段名是 retention.mjs 的现状，这里两个都认，
      // 免得面板上「轮转了 0 代」和「这个字段根本没读到」长得一样。
      rotated: report.archive?.rotate ?? report.archive?.rotated ?? null,
      // 下面三项只在真跑后存在：删了几个、回收多少字节、journal 有没有被动过。
      // `journalUnchanged` 是 S10 的硬约束（journal 永不删），必须能一眼看到。
      ...(report.movedCount !== undefined ? { movedCount: report.movedCount } : {}),
      ...(report.reclaimedBytes !== undefined ? { reclaimedBytes: report.reclaimedBytes } : {}),
      ...(report.journalUnchanged !== undefined ? { journalUnchanged: report.journalUnchanged } : {}),
      elapsedMs: report.elapsedMs ?? null,
      rollbackCommand: report.rollbackCommand ?? null,
      // notes 是「这轮为什么没删/为什么少扫了」的唯一证据，必须带出来
      notes: Array.isArray(report.notes) ? report.notes.slice(0, 8) : [],
    }
  }

  async function runOnce(reason = 'manual') {
    if (disposed) return { ok: false, reason: 'disposed' }
    if (!state.enabled) {
      state.skips += 1
      return { ok: false, reason: 'no-vault' }
    }
    const t0 = clock()
    try {
      // 纪律 1：先 plan。真跑模式下，只有「plan 说可回收 > 0」才继续 apply ——
      // 没有候选时 apply 只会白写一代备份 tgz。
      const planned = await planRetention(vaultDir, policy)
      let report = planned
      let mode = 'plan'
      if (apply === true && (planned?.candidateCount ?? 0) > 0) {
        report = await applyRetention(vaultDir, policy)
        mode = 'apply'
      }
      state.runs += 1
      state.state = 'ran'
      state.lastRunAt = new Date(clock()).toISOString()
      state.lastRunMode = `${mode}${reason && reason !== 'manual' ? `:${reason}` : ''}`
      state.lastElapsedMs = clock() - t0
      state.lastReport = summarize(report)
      state.lastError = null
      return { ok: report?.ok === true, mode, report: state.lastReport }
    } catch (e) {
      state.runs += 1
      state.errors += 1
      state.state = 'ran'
      state.lastRunAt = new Date(clock()).toISOString()
      state.lastElapsedMs = clock() - t0
      state.lastError = String(e?.message ?? e)
      // 纪律 2：不抛。治理失败不该让记忆读写跟着坏。
      try { log?.warn?.(`retention 执行失败（已忽略）：${state.lastError}`) } catch { /* ignore */ }
      return { ok: false, reason: 'failed', error: state.lastError }
    }
  }

  /**
   * 起定时器。返回 disposer —— **调用方必须用它证明挂上了**，
   * 拿不到 disposer 就说明没挂（与 agent/pre-step 同一条纪律）。
   */
  function schedule(ctxEffect = null) {
    if (disposed) return null
    if (!state.enabled) {
      state.state = 'unavailable'
      return null
    }
    const tick = () => {
      if (disposed) return
      state.nextRunAt = new Date(clock() + intervalMs).toISOString()
      runOnce('scheduled').catch(() => { /* runOnce 自己吞了，这里只兜 Promise */ })
    }
    state.nextRunAt = new Date(clock() + firstDelayMs).toISOString()
    timer = setTimeout(tick, firstDelayMs)
    // unref：一个每 6 小时醒一次的后台治理任务不应该拖着宿主进程不退出。
    timer?.unref?.()
    state.state = 'scheduled'
    const dispose = () => {
      if (disposed) return
      disposed = true
      if (timer) { clearTimeout(timer); timer = null }
    }
    if (typeof ctxEffect === 'function') ctxEffect(dispose)
    return dispose
  }

  function status() {
    return {
      ...state,
      policy: policy && typeof policy === 'object' ? policy : {},
      // 默认 dry-run 时明确说出来，免得有人读成「已经清理过了」
      note: state.enabled
        ? (apply === true ? '会在 plan 找到候选后真删（先打 tgz 并逐文件复验 sha256）' : '只 plan，不删任何文件；要真清理需显式传入 retention.apply=true')
        : '未启用（没有核心仓路径或 config.retention.enabled=false）',
    }
  }

  return { runOnce, schedule, status, summarize, dispose: () => { disposed = true; if (timer) clearTimeout(timer); timer = null } }
}
