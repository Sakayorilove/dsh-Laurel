/**
 * laurel-context/compaction-claim —— 声明「压缩提醒这件事由我负责」（2026-10-23 新增）。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────────
 * 用户报「内耗护栏是不是和上下文压缩功能重复了」。查证后的准确结论：
 *
 *   · **功能不重复**：warden 明确声明它不裁历史（见 dsh-warden/lib/index.js
 *     的边界段：「官方 Basic+pruner 唯一的历史压缩 owner（warden 不裁历史）」），
 *     真正执行压缩的是本模块（auto-compaction.mjs 挂 agent/pre-step 调 compactIfNeeded）。
 *
 *   · **但有一处真重复**：warden 的 `compactionFallback` 会在
 *     「上下文压力到线 + 官方压缩没发生」时往 `decision.messages` 里**插一条提醒**，
 *     而本模块干的就是「真去压」。两者判同一个 ratio。
 *     结果：本模块压完了、warden 还在提醒「该压了」；或者本模块压不动、
 *     warden 再提醒一次 —— 同一件事两套话术。这就是用户感到「重复」的实感来源。
 *
 * ── 为什么不 import warden 的 governance.js ──────────────────────────────
 * 跨包 import 会让 laurel-context 硬依赖 dsh-warden（装一个必须装另一个），
 * 而这两个模块在设计上是**可独立安装**的。所以这里只复刻**文件协议**，
 * 不 import 代码：
 *
 *   $DSH_HOME/laurel-suite/governance.json
 *   {
 *     "protocol": 1,
 *     "claims": {
 *       "compactionNudge": { "owner": "laurel-context", "version": "...",
 *                            "priority": 150, "pid": 1234,
 *                            "heartbeatAt": <ms>, "expiresAt": <ms>, "reason": "..." }
 *     }
 *   }
 *
 * 协议版本、字段名、优先级语义必须与 warden 的 `lib/core/governance.js` 逐字一致
 * （那边 `GOVERNANCE_PROTOCOL_VERSION = 1`、`GOVERNANCE_TTL_MS = 15000`）。
 * **这是刻意的重复**：两个独立包共享一份磁盘协议，而不是共享一份代码。
 *
 * ── 失败时的行为（重要）─────────────────────────────────────────────────
 * 本模块的声明**失败一律静默降级**：拿不到就不声明，让 warden 继续发它的兜底提醒。
 * 理由：本模块的职责是压缩本身，声明只是「顺手告诉邻居我可以干这事」；
 * 声明失败绝不能影响压缩功能，也绝不能反过来让 warden 误以为有人在压。
 * 这与 warden 的纪律一致（护栏坏掉不许连带影响宿主里任何别的东西）。
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 与 warden 的 `GOVERNANCE_PROTOCOL_VERSION` 必须一致。 */
export const GOVERNANCE_PROTOCOL_VERSION = 1
/** 与 warden 的 `GOVERNANCE_DIR` / `GOVERNANCE_FILE` 必须一致。 */
export const GOVERNANCE_DIR = 'laurel-suite'
export const GOVERNANCE_FILE = 'governance.json'
/** 与 warden 的 `GOVERNANCE_TTL_MS` 必须一致（15 秒）。 */
export const GOVERNANCE_TTL_MS = 15_000

/** 本模块在治理表里的身份。优先级 150 > warden 的 100（见文件头说明）。 */
export const MODULE_ID = 'laurel-context'
export const MODULE_PRIORITY = 150
/** 本模块要声明的能力。 */
export const CAPABILITY = 'compactionNudge'

/** 锁文件名后缀：必须与 warden 的 governancePaths().lock **同名同位置**，否则两边锁的不是同一把。 */
const LOCK_SUFFIX = '.lock'
/** 拿不到锁时的重试节奏（与 warden 同口径）。 */
const RETRY_DELAY_MS = 8
const RETRY_COUNT = 24
/** 锁持有上限；到期且持有者已死才可回收。 */
const LOCK_TTL_MS = 5000

function sleepSpin (ms) {
  const until = Date.now() + ms
  while (Date.now() < until) { /* spin：毫秒级临界区，比引入 timer 依赖更可控 */ }
}

function pidAlive (pid) {
  const n = Number(pid)
  if (!Number.isSafeInteger(n) || n <= 0) return false
  try { process.kill(n, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/** 空/坏锁文件按 mtime 判老（与 warden filelock.js 的第三条路径同口径）。 */
function lockReclaimable (meta, statMs, now) {
  if (meta) {
    const expiresAt = Number(meta.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt > now) return false
    if (meta.pid === undefined || meta.pid === null) return false
    return !pidAlive(meta.pid)
  }
  if (!Number.isFinite(statMs)) return false
  return statMs + LOCK_TTL_MS * 4 < now
}

/**
 * 在独占锁保护下跑一次读改写。
 *
 * ⚠ 这是 2026-10-23 评审 P1-4 补的：原先本模块是「readTable → 改内存 → writeTable」
 * 全程不加锁，而 warden 那边每次 claim/heartbeat/release 都在 governance.json.lock
 * 里读改写。warden 的锁对我们毫无约束力，于是本模块整表覆写会吃掉 warden
 * 在这期间推进的 expiresAt / 别人的声明。
 *
 * 与 warden 的关系是「复刻协议不共享代码」：锁文件名必须一致
 * （<dir>/governance.json.lock），否则等于各锁各的。
 */
function withFileLock (lockFile, body) {
  try { mkdirSync(dirname(lockFile), { recursive: true }) } catch { return { ok: false, reason: '建不出锁目录' } }
  let fd = null
  for (let attempt = 0; attempt < RETRY_COUNT; attempt += 1) {
    try { fd = openSync(lockFile, 'wx'); break } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, reason: '创建锁失败：' + (error?.code ?? error?.message ?? error) }
      let meta = null
      try { meta = JSON.parse(readFileSync(lockFile, 'utf8')) } catch { meta = null }
      let statMs = NaN
      try { statMs = statSync(lockFile).mtimeMs } catch { statMs = NaN }
      if (lockReclaimable(meta, statMs, Date.now())) {
        try { rmSync(lockFile, { force: true }) } catch { /* 下一轮重试 */ }
        continue
      }
      sleepSpin(RETRY_DELAY_MS)
    }
  }
  if (fd === null) return { ok: false, reason: '在限定时间内没有取得文件锁' }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, holder: MODULE_ID, expiresAt: Date.now() + LOCK_TTL_MS }) + String.fromCharCode(10), 'utf8') } catch { /* 元数据写不进只影响回收保守性 */ }
  try {
    return { ok: true, value: body() }
  } catch (error) {
    return { ok: false, reason: '临界区失败：' + (error?.message ?? error) }
  } finally {
    try { closeSync(fd) } catch { /* 已关就忽略 */ }
    try { rmSync(lockFile, { force: true }) } catch { /* 删不掉就等过期回收 */ }
  }
}

function paths(home) {
  const dir = join(home, GOVERNANCE_DIR)
  return { dir, file: join(dir, GOVERNANCE_FILE), lock: join(dir, GOVERNANCE_FILE + LOCK_SUFFIX) }
}

function readTable(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { protocol: GOVERNANCE_PROTOCOL_VERSION, claims: {} }
    return {
      protocol: Number(parsed.protocol) || GOVERNANCE_PROTOCOL_VERSION,
      claims: parsed.claims && typeof parsed.claims === 'object' ? parsed.claims : {},
    }
  } catch {
    return { protocol: GOVERNANCE_PROTOCOL_VERSION, claims: {} }
  }
}

/**
 * 写回治理表。**用临时文件 + rename 保证原子性** ——
 * 两个进程同时写同一份 JSON 时，直接 writeFileSync 会写出半截文件，
 * 读的那一方（warden）解析失败就退化成「没有声明」，于是两边都发提醒。
 * rename 在同一分区内是原子的，读到的要么是旧的完整版、要么是新的完整版。
 */
function writeTable(file, table) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(table, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * 声明 `compactionNudge` 能力，并在后台续期。
 *
 * @param {object} options
 * @param {string} options.home      DSH 家目录（`$DSH_HOME` 或 `~/.dsh`）
 * @param {string} options.version   本模块版本（写进声明，便于事后对账）
 * @param {(msg: string, err?: any) => void} [options.log] 日志（失败也只在 debug 级）
 * @returns {{ acquired: boolean, owner: string, reason: string, release: () => void }}
 *          永远返回对象，**不抛**。`acquired=false` 时 `release` 是空函数。
 */
export function claimCompactionNudge({ home, version, log } = {}) {
  const empty = { acquired: false, owner: '', reason: '未提供 home，跳过声明', release: () => {} }
  if (!home) return empty

  let p
  try {
    p = paths(home)
    mkdirSync(p.dir, { recursive: true })
  } catch (error) {
    log?.(`治理目录建不出来，跳过声明：${error?.message ?? error}`)
    return { ...empty, reason: '治理目录不可写' }
  }

  const now = Date.now()
  const mine = { owner: MODULE_ID, version: version ?? 'unknown', priority: MODULE_PRIORITY }

  // ⚠ 2026-10-23 评审 P1-4：读改写必须在 warden 的同一把锁里做。
  // 原来这里是裸 readTable → 改内存 → writeTable，而 warden 那边每次
  // claim/heartbeat/release 都在 <dir>/governance.json.lock 里读改写 ——
  // 它那把锁对我们**毫无约束力**，我们整表覆写会吃掉它推进的 expiresAt
  // 和别人的声明（静默丢声明，两边都以为对方在管 = 谁都不管）。
  const lockedRead = withFileLock(p.lock, () => readTable(p.file))
  if (!lockedRead.ok) {
    log?.(`治理表被占（${lockedRead.reason}），本模块本次不声明 —— 让 warden 继续发它的兜底提醒`)
    return { acquired: false, owner: '', reason: '读治理表失败：' + lockedRead.reason, release: () => {} }
  }
  const table = lockedRead.value
  const existing = table.claims[CAPABILITY] ?? null

  // 判定与 warden 的 decideClaim **同语义、同顺序**（两边必须得出同一个答案）：
  //   1. 没人声明        → take
  //   2. 声明者是自己    → renew
  //   3. 过期 + pid 已死 → reclaim（两个条件都要成立：过期 ≠ 对方已停手）
  //   4. 我方优先级更高  → preempt
  //   5. 其余            → standby
  //
  // ⚠ 2026-10-23 评审 P1-4 订正：这里原本有一段**自相矛盾**的注释 —— 先说
  // 「本模块**不做** preempt」，三行之后又说「本模块启动时就 preempt」。代码一直是
  // preempt，前面那段是重构残留，已删除。**保留 preempt 是对的**：本模块优先级
  // 150 > warden 100，而且它真能压缩（warden 只能提醒），与 warden 的
  // decideClaim「priority 高的赢」完全一致。
  let action
  let reason
  const theirsPriority = Number(existing?.priority) || 0
  if (!existing || !existing.owner) {
    action = 'take'
    reason = '当前没有声明者'
  } else if (existing.owner === MODULE_ID) {
    action = 'renew'
    reason = '本来就是自己声明的'
  } else if (
    Number(existing.expiresAt) <= now
    // ⚠ 2026-10-23 评审 P1-4：缺 pid 时必须**保守不回收**。
    // 原来只写 !pidAlive(Number(existing.pid))，而 pidAlive(undefined) 返回 false，
    // 于是「过期 + 缺 pid」被判死直接抢占 —— 与 warden 的 isStaleClaim 结论**相反**
    // （它要求 pid 存在才可能回收）。同一份文件两边得出相反结论 = 定时炸弹。
    && existing.pid !== undefined && existing.pid !== null
    && !pidAlive(Number(existing.pid))
  ) {
    action = 'reclaim'
    reason = `原声明者 ${existing.owner} 已过期且进程不在（pid=${existing.pid}）`
  } else if (MODULE_PRIORITY > theirsPriority) {
    action = 'preempt'
    reason = `优先级 ${MODULE_PRIORITY} > ${existing.owner} 的 ${theirsPriority}`
  } else {
    action = 'standby'
    reason = `由 ${existing.owner}@${existing.version ?? '?'} 执行（优先级 ${theirsPriority} ≥ ${MODULE_PRIORITY}）`
  }

  if (action === 'standby') {
    log?.(`压缩提醒由 ${existing.owner} 负责，laurel-context 待命（${reason}）`)
    return { acquired: false, owner: String(existing.owner), reason, release: () => {} }
  }

  const claim = {
    ...mine,
    pid: process.pid,
    heartbeatAt: now,
    expiresAt: now + GOVERNANCE_TTL_MS,
    reason,
  }
  // 写入同样在锁里：临界区里**重新读一遍**再改，避免用临界区外的旧表覆写别人的新改动。
  const written = withFileLock(p.lock, () => {
    const fresh = readTable(p.file)
    fresh.claims[CAPABILITY] = claim
    fresh.protocol = GOVERNANCE_PROTOCOL_VERSION
    writeTable(p.file, fresh)
    return true
  })
  if (!written.ok) {
    log?.(`写治理声明失败（不影响压缩）：${written.reason}`)
    return { acquired: false, owner: '', reason: '写声明失败：' + written.reason, release: () => {} }
  }

  // 续期：每 TTL/3 刷新一次，保证 warden 那边看到的声明不会过期。
  // unref() —— 定时器绝不能拖住宿主退出。
  const timer = setInterval(() => {
    try {
      // 续期也必须在锁里读改写（P1-4）。不加锁的话，我们整表覆写会吃掉
      // warden 同一瞬间推进的别的声明。
      const out = withFileLock(p.lock, () => {
        const fresh = readTable(p.file)
        const cur = fresh.claims[CAPABILITY]
        // 只在「声明还是自己的」时续期。被别人抢走了就停手，不再争。
        if (!cur || cur.owner !== MODULE_ID) return { stop: true }
        fresh.claims[CAPABILITY] = { ...claim, heartbeatAt: Date.now(), expiresAt: Date.now() + GOVERNANCE_TTL_MS }
        writeTable(p.file, fresh)
        return { stop: false }
      })
      if (!out.ok) return   // 拿不到锁：下一次还会试；真过期了 warden 会自己接管
      if (out.value && out.value.stop) clearInterval(timer)
    } catch {
      // 续期失败不报错：下一次还会试；真过期了 warden 会自己接管（它的兜底提醒照发）。
    }
  }, Math.floor(GOVERNANCE_TTL_MS / 3))
  timer.unref?.()

  let released = false
  const release = () => {
    if (released) return
    released = true
    try { clearInterval(timer) } catch { /* ignore */ }
    try {
      // 释放同样在锁里（P1-4）：不加锁时整表覆写会吃掉 warden 的声明。
      // 只删自己的声明 —— 别人（例如 warden 重新抢到）的声明绝不能删。
      withFileLock(p.lock, () => {
        const fresh = readTable(p.file)
        if (fresh.claims[CAPABILITY]?.owner === MODULE_ID) {
          delete fresh.claims[CAPABILITY]
          writeTable(p.file, fresh)
        }
      })
    } catch { /* 释放失败无所谓：TTL 会自然过期 */ }
  }

  log?.(`压缩提醒由 laurel-context 负责（${action}：${reason}）`)
  return { acquired: true, owner: MODULE_ID, reason, release }
}

/** 读一眼当前声明状态（只读，给端点/探针用）。 */
export function readCompactionClaim(home) {
  if (!home) return { protocol: GOVERNANCE_PROTOCOL_VERSION, claim: null }
  const table = readTable(paths(home).file)
  return { protocol: table.protocol, claim: table.claims[CAPABILITY] ?? null }
}
