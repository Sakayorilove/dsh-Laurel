/**
 * dsh-warden · 数据层：共享资源锁 / 读数指纹台账 / 事件日志
 *
 * ── 四条纪律 ───────────────────────────────────────────────────────────
 *   1. **IO 失败必须报失败。** 旧版 `#persist()` 把写异常吞掉后照样
 *      `return { ok: true, lock }` —— 评审已复现"写盘失败仍报已取得"。
 *      现在写不进去就是 `{ ok: false }`，绝不谎报。
 *   2. **锁的身份是资源，不是名字。** 见 `core/resource.js`。
 *   3. **读改写必须走独占锁。** `writeFileSync(tmp)+renameSync` 只保证
 *      "读到的永远是完整的一份"，不保证两个进程的改动都在（R4）。
 *   4. **台账只追加。** 指纹一旦写下不改，改的是"它还有效吗"的判定。
 *
 * ── 过期 ≠ 旧写者已停止（R4 的核心）───────────────────────────────────
 * TTL 到点只说明"我们不再替它保证"，**不说明它已经停手**。120 秒到点时
 * 那个部署脚本可能还在跑。所以这里两道防线：
 *   - **fence（栅栏令牌）**：每次取得/回收/抢占都让该资源的 fence +1。
 *     旧持有者手里的 fence 就过期了，`renew` / `release` 会被明确拒绝，
 *     它也就无法再声称自己还持有执行权。
 *   - **回收要有证据**：`isStale()` 要求"已过期 **且** 持有者进程确实不在"
 *     两个条件同时成立；只有其一，宁可让新来的排队，也不把资源从
 *     一个可能还在写的人手里抢走。
 *
 * ── 2026-10-24 P1-9：同 pid 多会话的死锁（补第三条判据）─────────────────
 * 上面那条纪律在**单进程多会话**下会变成永久死锁：主控会话与它派出的所有
 * 子代理**共享宿主 pid**（`process.pid`），于是 pid 永远"活着"——
 * 一个被遗忘的锁（子代理抛错/被 interrupt/会话结束没 `release_lock`）
 * 会一直占着资源，直到用户重启宿主或人工强制释放。
 * 实测复现：`probe3 E3.2`「过期 60 秒后另一个会话取得 = **false**」。
 *
 * 所以加**第三条**判据（不动前两条，也不放宽成"过期即可回收"）：
 *   `已过期` **且** `同 pid` **且** `该会话已不再活跃`（心跳停超过 3×TTL）
 *   → 才允许回收。
 *
 * 「会话活跃」由 `renewBySession()` 续：`session/event` 每来一条事件就替该会话
 * 持有的锁续一次 `heartbeatAt`（**不推 `expiresAt`** —— 租期仍归持有者用
 * `renew_lock` 管，这里只证明"这个会话还活着"）。心跳停了 = 会话没了 =
 * 它手里的锁可以回收。**跨 pid 的情形仍走原来的"进程不在"判据**，
 * 那条没有被削弱。
 *
 * 还有一条不改的底线：**过期 ≠ 对方已停手**。所以即使判定可回收，
 * `acquire` 也**不会静默抢**——它返回 `canTakeOver: true` 并要求调用方
 * 用 `force: true` 明确表示"我知道自己在接管一把过期锁"。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { HASH_ALGORITHM_VERSION, pluginPaths, resolveDshHome } from './config.js'
import { systemClock } from './clock.js'
import { atomicWriteFile, pidAlive, withFileLock } from './filelock.js'
import { resolveResourceId, resourcesConflict } from './resource.js'
import { sha256File, shortHash } from './text.js'

/** 事件日志轮转阈值。 */
const EVENT_ROTATE_BYTES = 512 * 1024

/**
 * 事件日志。带简单的轮转：超过 512KB 就砍掉前一半。
 *
 * @returns {boolean} 写成功了没有。旧版无条件吞掉失败，现在把结果交回调用方。
 */
export function appendEvent(event, home = resolveDshHome(), clock = systemClock()) {
  try {
    const paths = pluginPaths(home)
    mkdirSync(paths.dir, { recursive: true })
    try {
      if (statSync(paths.events).size > EVENT_ROTATE_BYTES) {
        const text = readFileSync(paths.events, 'utf8')
        const lines = text.split('\n')
        atomicWriteFile(paths.events, lines.slice(Math.floor(lines.length / 2)).join('\n'))
      }
    } catch { /* 轮转失败不影响写入 */ }
    appendFileSync(
      paths.events,
      `${JSON.stringify({ at: new Date(clock.now()).toISOString(), ...event })}\n`,
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

/**
 * 事件日志尾巴，给设置页与运行监控看。
 *
 * `sessionId` 非空时**先过滤再取尾巴** —— 不能先截最后 N 行再筛会话：长会话的
 * 早期事件会被别的会话挤掉，「本会话运行了几次」就会少算。文件很小（512KB 轮转），
 * 全解析一遍是毫秒级。
 */
export function readEvents(home = resolveDshHome(), limit = 80, sessionId = null) {
  try {
    const text = readFileSync(pluginPaths(home).events, 'utf8')
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    const wanted = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
    const rows = []
    for (let i = lines.length - 1; i >= 0 && rows.length < limit; i -= 1) {
      let row
      try { row = JSON.parse(lines[i]) } catch { continue }
      if (!row || typeof row !== 'object') continue
      if (wanted && row.sessionId !== wanted) continue
      rows.push(row)
    }
    return rows
  } catch {
    return []
  }
}

/** 锁表的默认 TTL。 */
const DEFAULT_LOCK_TTL_MS = 120_000

/** 锁表文件（整体重写，短生命周期）。 */
function lockTableFile(home) {
  return pluginPaths(home).locks
}

function readLockTable(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { locks: {}, fences: {} }
    return {
      locks: parsed.locks && typeof parsed.locks === 'object' ? parsed.locks : {},
      fences: parsed.fences && typeof parsed.fences === 'object' ? parsed.fences : {},
    }
  } catch {
    return { locks: {}, fences: {} }
  }
}

/** 会话心跳停多久就认为「这个会话没了」。默认 3×TTL（锁默认 TTL 120s → 6 分钟）。 */
export const SESSION_HEARTBEAT_GRACE_FACTOR = 3

/** 锁默认 TTL 的导出别名（`renewBySession` 与 `isStaleLock` 共用同一口径）。 */
export const LOCK_TTL_MS = DEFAULT_LOCK_TTL_MS

/**
 * 一条锁记录**陈旧到什么程度**。四档，调用方按档位决定「等 / 提示 / 回收」。
 *
 *   `live`      不陈旧：没过期；或过期但持有者进程活着**且**会话心跳新鲜
 *   `hard`      证据硬：持有者**进程不在**（跨进程崩溃 / 已退出）→ 可直接回收
 *   `session`   证据够硬：同 pid，但该会话心跳停了超过宽限 → 可回收
 *   `ambiguous` 证据软：同 pid、过期，**但心跳还在宽限内** → 只提示，不代抢
 *
 * ── 为什么原来只有两档就够，现在不够（P1-9）────────────────────────────
 * 原来只回答「过期 **且** 持有者进程死了吗」。这在**单进程多会话**下永远答 false：
 * 主控与它派出的所有子代理**共享宿主 pid**，pid 永远活着。于是一个被遗忘的锁
 * （子代理抛错 / 被 interrupt / 会话结束没 release_lock）会一直占着资源，
 * 直到重启宿主或人工强放 —— 实测 `probe3 E3.2 = false`。
 *
 * 所以加**会话级**判据：`renewBySession()` 在 `session/event` 上替该会话续
 * `heartbeatAt`。心跳停超过宽限 = 这个会话没了 = 它手里的锁可以回收。
 *
 * ── 四档怎么分（R4：过期 ≠ 对方已停手）────────────────────────────────
 * 关键是**分清楚「能证明它停了」和「只是怀疑它停了」**：
 *
 *   `hard`     进程不在 → 铁证，不可能还在写。回收没有任何风险。
 *   `session`  心跳停了超过 3×TTL → 强证据。会话只要还在跑，`session/event`
 *              就会不断来；连续 6 分钟一条事件都没有，基本只能是它已经结束。
 *              **这一档要能自动回收**，否则 P1-9 还是没修（E3.2 仍是 false）。
 *   `ambiguous` 过期了但心跳还在宽限内 → 只是怀疑。它可能正在跑一个长任务、
 *              宿主暂时没派事件。**这一档绝不代抢**，只返回 `canTakeOver` 提示。
 *
 * 拿不到 `heartbeatAt`（老记录 / 没接线）时按 `ambiguous` 处理 —— 与
 * 「缺 pid 就保守」同理：读不懂就别说它死了，但也别假装它正当持有。
 *
 * 这个函数**保持纯函数**（除 `pidAlive` 这类只读探测），单测能逐分支钉死。
 *
 * @param {object} entry 锁记录
 * @param {number} now 当前时间（毫秒）
 * @param {{currentPid?: number, graceMs?: number}} [options]
 *   `currentPid` 默认 `process.pid`：只有**本进程内**的锁才可能走会话档。
 *   `graceMs` 默认 `3 × DEFAULT_LOCK_TTL_MS`；**`<= 0` = 关掉会话档**（回退验证用它）。
 * @returns {'live'|'hard'|'session'|'ambiguous'}
 */
export function lockStaleness(entry, now, options = {}) {
  if (!entry || typeof entry !== 'object') return 'hard'
  const expiresAt = Number(entry.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt > now) return 'live'
  if (entry.pid === undefined || entry.pid === null) return 'live'
  // ── 原有判据（一字未改）：持有者进程不在 → 硬证据 ──
  if (!pidAlive(entry.pid)) return 'hard'
  // ── 第三条（P1-9）：同进程时用会话心跳判「这个会话还在不在」──
  //
  // 宽限 = **3 × 这把锁自己的 TTL**（任务书口径 "3×lockTtlMs"），不是全局默认 TTL：
  // 有人用 ttlMs=1000 拿的锁，宽限就该是 3 秒，而不是按 120 秒默认值算成 6 分钟。
  // 锁自己的 TTL 从 (expiresAt - renewedAt) 反推，拿不到才退回默认 TTL。
  const explicitGrace = options?.graceMs
  let graceMs
  if (explicitGrace === undefined || explicitGrace === null) {
    const renewedAt = Number(entry.renewedAt)
    const ownTtl = (Number.isFinite(renewedAt) && renewedAt > 0) ? expiresAt - renewedAt : NaN
    const ttl = (Number.isFinite(ownTtl) && ownTtl > 0) ? ownTtl : DEFAULT_LOCK_TTL_MS
    graceMs = ttl * SESSION_HEARTBEAT_GRACE_FACTOR
  } else {
    graceMs = Number(explicitGrace)
  }
  // graceMs <= 0 = 显式关掉这一档：退回旧行为（过期但进程活着 → 不陈旧）。
  if (!Number.isFinite(graceMs) || graceMs <= 0) return 'live'
  const currentPid = Number(options?.currentPid ?? process.pid)
  if (Number(entry.pid) !== currentPid) return 'live'
  const heartbeatAt = Number(entry.heartbeatAt)
  // 读不懂心跳：既不能证明它停了，也不能假装它正当持有 → 软证据档。
  if (!Number.isFinite(heartbeatAt)) return 'ambiguous'
  return now - heartbeatAt > graceMs ? 'session' : 'ambiguous'
}

/**
 * 一条锁记录是不是陈旧的（`lockStaleness` 的布尔版，保留给既有调用点与单测）。
 *
 * ⚠ 这里把 `ambiguous`（疑似、证据不足）也**算作陈旧** —— 本函数的语义是
 * 「能不能动它」，`ambiguous` 确实该考虑动它了。但**能不能代抢**是另一回事：
 * `acquire()` 用 `lockStaleness()` 分档，`ambiguous` 只提示 `canTakeOver`、不代抢。
 *
 * 要区分「证据有多硬」请直接用 `lockStaleness`。
 */
export function isStaleLock(entry, now, options = {}) {
  return lockStaleness(entry, now, options) !== 'live'
}

/**
 * 共享资源锁。
 *
 * 语义：**同一个规范资源同一时刻只有一个写者**。读不受限（`conflictFor`
 * 只在写路径上被调用）—— 别的子代理正需要读它来核对读数。
 */
export class LockStore {
  /**
   * @param {string} [home]
   * @param {{clock?: any, log?: any, onEvent?: (e: object) => void, capabilities?: any}} [deps]
   */
  constructor(home = resolveDshHome(), deps = {}) {
    this.home = home
    this.paths = pluginPaths(home)
    this.file = lockTableFile(home)
    this.lockFile = `${this.file}.lock`
    this.clock = deps.clock ?? systemClock()
    this.log = deps.log ?? null
    this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null
    this.capabilities = deps.capabilities ?? null
    this.stats = { acquired: 0, denied: 0, ioFailed: 0, reclaimed: 0, unresolved: 0, renewed: 0, released: 0, heartbeatRenewed: 0, takeOverHinted: 0 }
    /**
     * 会话心跳宽限（毫秒）。超过它就认为"这个会话没了"，它持有的同 pid 锁可回收。
     * `0` = 关掉 P1-9 的第三条判据（回退验证与保守部署用）。
     */
    const grace = Number(deps.sessionHeartbeatGraceMs)
    // undefined = 按**每把锁自己的 TTL** 算宽限（默认口径）；给了数字才统一覆盖。
    this.sessionHeartbeatGraceMs = Number.isFinite(grace) && grace >= 0 ? grace : null
    /** 最近一次观察到会话心跳的时间（内存态，进程重启归零是安全的）。 */
    this.sessionHeartbeats = new Map()
  }

  /** `lockStaleness` 的判定口径：把本实例的两个参数固定下来，调用点不必重复传。 */
  #staleness(entry, now) {
    return lockStaleness(entry, now, {
      currentPid: process.pid,
      // null = 不覆盖，按这把锁自己的 TTL 算宽限。
      ...(this.sessionHeartbeatGraceMs === null ? {} : { graceMs: this.sessionHeartbeatGraceMs }),
    })
  }

  /** 某把锁当前的宽限毫秒数（提示文案要用，避免各处重复算）。 */
  #graceMsFor(entry) {
    if (this.sessionHeartbeatGraceMs !== null) return this.sessionHeartbeatGraceMs
    const expiresAt = Number(entry?.expiresAt)
    const renewedAt = Number(entry?.renewedAt)
    const ownTtl = (Number.isFinite(expiresAt) && Number.isFinite(renewedAt) && renewedAt > 0)
      ? expiresAt - renewedAt
      : NaN
    const ttl = (Number.isFinite(ownTtl) && ownTtl > 0) ? ownTtl : DEFAULT_LOCK_TTL_MS
    return ttl * SESSION_HEARTBEAT_GRACE_FACTOR
  }

  /** 布尔版，给只需要"能不能动它"的调用点用。 */
  #stale(entry, now) {
    return this.#staleness(entry, now) !== 'live'
  }

  /**
   * 该不该从 `list()` 里隐藏（2026-10-24 修：P1-9 改坏了 R4）。
   *
   * ⚠ 这里**不能**用 `#stale()`：它把 `ambiguous` 也算作陈旧，而 `ambiguous` 的语义
   * 恰恰是「怀疑但证据不足」。原来的行为是「过期但持有者进程活着 → 仍然看得见」，
   * 那是 R4「过期 ≠ 对方已停手」的直接体现，也是 `smoke.mjs` 那条
   * 「过期的锁隐身（可注入时钟）」在钉的东西。P1-9 只该让**证据够硬的**两类消失：
   *   · `hard`    持有者进程不在 —— 铁证
   *   · `session` 同 pid 但会话心跳停超宽限 —— 强证据
   * `ambiguous`（心跳还在宽限内 / 读不到心跳）继续可见，由 `acquire()` 给
   * `canTakeOver` 提示让调用方决定，**不在这里代藏**。
   */
  #hiddenFromList(entry, now) {
    const level = this.#staleness(entry, now)
    return level === 'hard' || level === 'session'
  }

  /** 读全部未过期的锁。读不到文件 = 空表（这一条是安全的失败方向）。 */
  list(now = this.clock.now()) {
    const table = readLockTable(this.file)
    const out = {}
    for (const [id, entry] of Object.entries(table.locks)) {
      if (!entry || typeof entry !== 'object') continue
      const expiresAt = Number(entry.expiresAt) || 0
      if (expiresAt > 0 && expiresAt <= now && this.#hiddenFromList(entry, now)) continue
      out[id] = this.#shape(id, entry, table.fences)
    }
    return out
  }

  #shape(id, entry, fences) {
    return {
      id,
      name: typeof entry.name === 'string' ? entry.name : id,
      resourceId: typeof entry.resourceId === 'string' ? entry.resourceId : '',
      resourceKind: typeof entry.resourceKind === 'string' ? entry.resourceKind : '',
      path: typeof entry.path === 'string' ? entry.path : '',
      owner: typeof entry.owner === 'string' ? entry.owner : '',
      pid: entry.pid ?? null,
      fence: Number(fences?.[entry.resourceId] ?? entry.fence ?? 1),
      acquiredAt: Number(entry.acquiredAt) || 0,
      renewedAt: Number(entry.renewedAt) || 0,
      expiresAt: Number(entry.expiresAt) || 0,
      // P1-9：会话级存活证据（老记录没有这两项 → 显示空/0，按"未知"处理）
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
      heartbeatAt: Number(entry.heartbeatAt) || 0,
      note: typeof entry.note === 'string' ? entry.note : '',
    }
  }

  /**
   * 尝试取得某个资源的执行权。
   *
   * @param {{name?: string, resource?: string, path?: string, owner: string,
   *          ttlMs?: number, note?: string, cwd?: string}} request
   * @returns {{ok: true, lock: object}|{ok: false, reason: string, heldBy?: object, unresolvable?: boolean}}
   */
  acquire(request) {
    const owner = typeof request?.owner === 'string' ? request.owner.trim() : ''
    if (!owner) return { ok: false, reason: '缺少持有者标识（拿不到会话 id）' }

    // ── 资源身份：命名资源优先，其次路径 ──
    const target = request.resource?.trim() || request.path?.trim() || request.name?.trim() || ''
    const resolved = resolveResourceId(target, request.cwd ?? '', {
      mergeCrossPlatform: request.mergeCrossPlatform !== false,
    })
    if (!resolved.resolvable) {
      this.stats.unresolved++
      this.capabilities?.markObserved?.('lockCoverageGap', `无法归一：${resolved.reason}`)
      return {
        ok: false,
        unresolvable: true,
        reason: `这个目标无法归一成可靠的资源身份，因此**没有加锁**：${resolved.reason}\n`
          + `请改用①绝对路径，或②明确的命名资源（desktop-input / display-mode / deployment:<目标> / port:<端口>）。`,
      }
    }

    const now = this.clock.now()
    const ttl = Number(request.ttlMs) > 0 ? Number(request.ttlMs) : DEFAULT_LOCK_TTL_MS
    const name = typeof request.name === 'string' && request.name.trim() ? request.name.trim() : resolved.resourceId

    const outcome = withFileLock(this.lockFile, () => {
      const table = readLockTable(this.file)

      // ── 冲突判定：任何**资源身份相撞**的锁都算，不看锁名 ──
      for (const [id, entry] of Object.entries(table.locks)) {
        if (!entry || typeof entry !== 'object') continue
        if (entry.owner === owner) continue
        if (!resourcesConflict(entry.resourceId, resolved.resourceId)) continue
        const heldBy = this.#shape(id, entry, table.fences)
        const staleness = this.#staleness(entry, now)
        if (staleness === 'live') {
          return { ok: false, heldBy, conflictOn: id }
        }
        // ── 陈旧 ≠ 可以抢。按**证据硬度**分档处理（P1-9 / R4）────────────────
        //
        // hard    ：持有者**进程不在** → 铁证，不可能还在写。自动回收。
        // session ：同 pid，但该**会话**心跳停超宽限（默认 3×TTL=6 分钟）。会话只要
        //           还在跑，session/event 就会不断来；连续 6 分钟一条都没有，基本只能
        //           是它已经结束（子代理抛错/被中断后没 release_lock 就是这个样子）。
        //           P1-9 要修的正是这一档，所以它**必须能自动回收**，否则 E3.2 仍是 false。
        // ambiguous：过期了，但会话心跳还在宽限内 —— 只是**怀疑**它停了。
        //           这一档**绝不代抢**：返回 canTakeOver，要调用方显式 force:true。
        //           这是 R4「过期 ≠ 对方已停手」在会话粒度上的延续。
        const evidenceIsHard = staleness === 'hard' || staleness === 'session'
        if (!evidenceIsHard) {
          this.stats.takeOverHinted++
          const quietSec = Math.max(0, Math.round((now - (Number(entry.heartbeatAt) || now)) / 1000))
          this.onEvent?.({
            kind: 'lock-takeover-hinted',
            detail: `${owner} 想拿 ${resolved.resourceId}：${entry.owner} 的锁已过期，会话心跳 ${quietSec} 秒前还在，未静默抢占`,
          })
          return {
            ok: false,
            heldBy,
            conflictOn: id,
            stale: true,
            canTakeOver: true,
            reason: `资源已被 ${entry.owner} 占用。那把锁**已经过期**，但它所在的会话 ${quietSec} 秒前还有活动`
              + `（宽限 ${Math.round(this.sessionHeartbeatGraceMs / 1000)} 秒内）—— 可能正在跑一个长任务，只是宿主暂时没派事件给它。`
              + `所有会话共用宿主 pid（pid=${entry.pid}），单看进程无法证明它停了，所以**不静默抢**。`
              + '确认它不会再写这个资源后，带 force:true 重新 acquire_lock 即可接管（fence 会推进，旧持有者的续租/释放都会被拒）。',
          }
        }
        // 证据够硬：回收，并让 fence 推进使旧持有者立刻失效。
        this.stats.reclaimed++
        this.onEvent?.({
          kind: 'lock-reclaim',
          detail: staleness === 'session'
            ? `回收会话已停的锁 ${entry.name}（原持有者 ${entry.owner} 会话心跳停超 ${Math.round(this.sessionHeartbeatGraceMs / 1000)} 秒）`
            : `回收陈旧锁 ${entry.name}（原持有者 ${entry.owner} pid=${entry.pid} 已不在）`,
        })
        delete table.locks[id]
      }

      const fence = Number(table.fences[resolved.resourceId] ?? 0) + 1
      table.fences[resolved.resourceId] = fence

      const existing = table.locks[resolved.resourceId]
      const lock = {
        name,
        resourceId: resolved.resourceId,
        resourceKind: resolved.kind,
        path: resolved.path,
        owner,
        pid: process.pid,
        fence,
        acquiredAt: existing?.owner === owner ? (existing.acquiredAt ?? now) : now,
        renewedAt: now,
        expiresAt: now + ttl,
        // ── P1-9：会话级存活证据 ──────────────────────────────────────────
        // 所有会话共享宿主 pid，pid 判据在"单进程多会话"下恒为"活着"。
        // 所以额外记「哪个会话」+「最后一次看到它活动的时间」，
        // 由 renewBySession() 在 session/event 上续（见该方法注释）。
        sessionId: owner,
        // ⚠ 这里**不写** heartbeatAt：acquire 那一刻还没有任何「会话还在活动」的
        // 证据。写了之后 lockStaleness 会把一把从没续过租的锁判成 session 档
        // （心跳「5 秒前」很新鲜，但那个 5 秒是 acquire 本身），于是过期就自动回收 ——
        // 那正是 host-contract 的 R4「过期但持有者进程还在 → 不许回收」在钉的契约。
        // 只有 renewBySession() 真的续过一次，才有 session 档的证据。
        note: typeof request.note === 'string' ? request.note.slice(0, 300) : '',
        hashVersion: HASH_ALGORITHM_VERSION,
      }
      table.locks[resolved.resourceId] = lock
      // 写失败必须让调用方知道（R4）。atomicWriteFile 会抛。
      atomicWriteFile(this.file, `${JSON.stringify(table, null, 2)}\n`)
      return { ok: true, lock: this.#shape(resolved.resourceId, lock, table.fences) }
    }, { clock: this.clock, holder: `lockstore:${owner}` })

    if (!outcome.ok) {
      this.stats.ioFailed++
      this.capabilities?.markDegraded?.('sharedLock', `锁表读写失败：${outcome.reason}`)
      this.log?.warn?.(`共享锁未取得（IO 失败）：${outcome.reason}`)
      // ⚠ 绝不返回 ok:true。旧版就是在这里谎报的。
      return { ok: false, reason: `锁表读写失败，本次**没有取得**执行权：${outcome.reason}`, ...(outcome.heldBy ? { heldBy: outcome.heldBy } : {}) }
    }

    const value = outcome.value
    if (!value.ok) {
      this.stats.denied++
      const held = value.heldBy
      this.onEvent?.({
        kind: 'lock-denied',
        detail: `${owner} 想拿 ${resolved.resourceId}，被 ${held?.owner} 挡下`,
      })
      return {
        ok: false,
        reason: `资源已被 ${held?.owner ?? '另一个会话'} 占用`,
        ...(held ? { heldBy: held } : {}),
        resourceId: resolved.resourceId,
      }
    }

    this.stats.acquired++
    this.capabilities?.markObserved?.('sharedLock', `取得 ${resolved.resourceId}（fence=${value.lock.fence}）`)
    this.onEvent?.({
      kind: 'lock-acquire',
      detail: `${owner} 取得 ${resolved.resourceId}（fence=${value.lock.fence}，${Math.round(ttl / 1000)} 秒后过期）`,
      mergedCrossPlatform: resolved.mergedCrossPlatform,
    })
    return { ok: true, lock: value.lock, mergedCrossPlatform: resolved.mergedCrossPlatform }
  }

  /**
   * 续租。长任务必须在过期前续，否则会被判陈旧回收。
   *
   * fence 不匹配 = 这把锁已经被回收/抢占了，**续租失败**，
   * 调用方必须停手（这就是执行面的 fencing）。
   */
  renew({ resourceId, owner, fence, ttlMs }) {
    const now = this.clock.now()
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_LOCK_TTL_MS
    const outcome = withFileLock(this.lockFile, () => {
      const table = readLockTable(this.file)
      const entry = table.locks[resourceId]
      if (!entry) return { ok: false, reason: '这把锁已经不在了（可能已过期并被回收）' }
      const currentFence = Number(table.fences[resourceId] ?? entry.fence ?? 1)
      // fence 先判：令牌失效说明这把锁**已经被回收/抢占过**，
      // 这比"现在归谁"更根本 —— 旧持有者必须先停手，而不是被告知换个主人。
      if (fence !== undefined && Number(fence) !== currentFence) {
        return {
          ok: false,
          fenced: true,
          reason: `栅栏令牌已失效（你的是 ${fence}，当前是 ${currentFence}）——`
            + '这把锁曾被回收或抢占，**你必须停止对该资源的写入**并重新申请。',
        }
      }
      if (entry.owner !== owner) return { ok: false, reason: `这把锁现在归 ${entry.owner}` }
      entry.renewedAt = now
      entry.expiresAt = now + ttl
      entry.fence = currentFence
      atomicWriteFile(this.file, `${JSON.stringify(table, null, 2)}\n`)
      return { ok: true, lock: this.#shape(resourceId, entry, table.fences) }
    }, { clock: this.clock, holder: `lockstore:renew:${owner}` })

    if (!outcome.ok) {
      this.stats.ioFailed++
      return { ok: false, reason: `续租失败（IO）：${outcome.reason}` }
    }
    if (outcome.value.ok) {
      this.stats.renewed++
      return outcome.value
    }
    return outcome.value
  }

  /**
   * 释放。
   *
   * `force` **不是万能钥匙**（R4：强制释放活锁不能只凭模型 force:true）：
   *   - 持有者自己 → 直接放
   *   - `actor === 'user'`（设置页/HTTP，背后是真人）+ force → 放，并记账
   *   - `actor === 'model'` + force → **只有锁确实陈旧才放**；活锁一律拒绝
   *   - 其余 → 拒绝
   *
   * @returns {{ok: boolean, released?: boolean, reason?: string, heldBy?: object}}
   */
  release({ resourceId, name, owner, force = false, actor = 'model', fence }) {
    const now = this.clock.now()
    const outcome = withFileLock(this.lockFile, () => {
      const table = readLockTable(this.file)
      // ⚠ 这里必须用"空串也算没有"的判定，不能用 `??`：
      // HTTP 面在没有 resource 时会传 `resourceId: ''`，`?? ` 不会穿透空串，
      // 于是 key 变成 ''、查不到锁、反而回一句"本来就没有这把锁"（ok:true）。
      const byName = Object.keys(table.locks).find((id) => table.locks[id]?.name === name)
      const key = (typeof resourceId === 'string' && resourceId.length > 0)
        ? resourceId
        : (byName ?? ((typeof name === 'string' && name.length > 0) ? name : ''))
      const entry = table.locks[key]
      if (!entry) return { ok: true, released: false, reason: '本来就没有这把锁' }

      const stale = this.#stale(entry, now)
      const isOwner = typeof owner === 'string' && owner.length > 0 && entry.owner === owner
      const currentFence = Number(table.fences[entry.resourceId] ?? entry.fence ?? 1)

      if (!isOwner) {
        const userForced = force === true && actor === 'user'
        const staleForced = force === true && stale
        if (!userForced && !staleForced) {
          return {
            ok: false,
            heldBy: this.#shape(key, entry, table.fences),
            reason: force === true
              ? `这把锁**还活着**（持有者 ${entry.owner}，pid=${entry.pid}，`
                + `${Math.max(0, Math.round((entry.expiresAt - now) / 1000))} 秒后过期）。`
                + '模型端的 force 不能释放活锁 —— 过期不代表对方已经停手。'
                + '要么等它自己 release/过期，要么由用户在设置页强制释放。'
              : `这把锁归 ${entry.owner}，只有持有者能释放。`,
          }
        }
        if (userForced && !stale) {
          this.onEvent?.({
            kind: 'lock-force-release',
            detail: `用户在设置页强制释放了 ${entry.name}（原持有者 ${entry.owner} 可能仍在写，fence 已推进）`,
          })
        }
      }

      if (isOwner && fence !== undefined && Number(fence) !== currentFence) {
        return {
          ok: false,
          fenced: true,
          reason: `栅栏令牌已失效（你的是 ${fence}，当前是 ${currentFence}）——这把锁已被回收或抢占。`,
        }
      }

      delete table.locks[key]
      // fence **保留并推进**：这样旧持有者即使没收到通知，也无法再续租或声称持有。
      table.fences[entry.resourceId] = currentFence + 1
      atomicWriteFile(this.file, `${JSON.stringify(table, null, 2)}\n`)
      return { ok: true, released: true, resourceId: entry.resourceId }
    }, { clock: this.clock, holder: `lockstore:release:${owner || actor}` })

    if (!outcome.ok) {
      this.stats.ioFailed++
      return { ok: false, reason: `释放失败（IO）：${outcome.reason}` }
    }
    if (outcome.value.released) {
      this.stats.released++
      this.onEvent?.({ kind: 'lock-release', detail: `${owner || actor} 释放了 ${lockLabel(resourceId, name)}` })
    }
    return outcome.value
  }

  /**
   * 这次操作的目标资源，是不是正被**别人**占着？
   *
   * 只在写路径上调用。判据是**规范资源身份的冲突集合**（含父子路径），
   * 不是锁名。归一不出来返回 null（fail-open）—— 但调用方必须把
   * "没覆盖到"记进能力台账，不能假装全面强制。
   *
   * @param {string} targetOrResourceId 规范 id，或原始路径
   * @param {string} owner 当前会话
   * @param {{path?: string, cwd?: string, now?: number}} [options]
   * @returns {object|null} 占用者
   */
  conflictFor(targetOrResourceId, owner, options = {}) {
    const now = options.now ?? this.clock.now()
    const isId = typeof targetOrResourceId === 'string'
      && (targetOrResourceId.startsWith('path:') || targetOrResourceId.startsWith('named:'))
    const resolved = isId
      ? { resolvable: true, resourceId: targetOrResourceId }
      : resolveResourceId(targetOrResourceId, options.cwd ?? '')
    if (!resolved.resolvable) return null

    for (const lock of Object.values(this.list(now))) {
      if (lock.owner === owner) continue
      if (resourcesConflict(lock.resourceId, resolved.resourceId)) return lock
    }
    return null
  }

  /**
   * 会话心跳：由 `session/event` 每来一条事件调用一次，替该会话持有的锁续
   * `heartbeatAt`。**这是 P1-9 的证据来源。**
   *
   * ── 它续什么、不续什么（很重要）──────────────────────────────────────
   * 只续 `heartbeatAt`，**不推 `expiresAt`**：
   *   · `expiresAt` 是**租期**，归持有者用 `renew_lock` 管；自动推租期等于让
   *     一把被遗忘的锁永远不过期，又把 P1-9 打回去了。
   *   · `heartbeatAt` 是**存活证据**，只说明这个会话还在产生事件。
   * 两者分开，才能在「租期早过了」与「会话其实还活着」同时成立时保持保守。
   *
   * ── 为什么要节流 ────────────────────────────────────────────────────
   * `session/event` 在长会话里非常密集。每来一条就 读盘→改→写盘 会把锁表文件
   * 写成热点。所以同一会话在 `throttleMs` 内最多落盘一次（默认 TTL 的 1/10，
   * 即 12 秒）：既远小于 3×TTL 的宽限，也不会成热点。
   *
   * @param {string} sessionId 会话 id
   * @param {{throttleMs?: number, now?: number}} [options]
   * @returns {{renewed: number, skipped?: string, error?: string}}
   *          `renewed` 是**本次真的落了盘**的锁数量（0 也可能是正常的节流）。
   */
  renewBySession(sessionId, options = {}) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!id) return { renewed: 0, skipped: 'no-session-id' }
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : this.clock.now()
    const throttle = Number(options.throttleMs) >= 0
      ? Number(options.throttleMs)
      : Math.max(1000, Math.round(DEFAULT_LOCK_TTL_MS / 10))
    // 节流：同一会话的心跳不必每条事件都落盘。
    const last = this.sessionHeartbeats.get(id)
    if (Number.isFinite(last) && throttle > 0 && now - last < throttle) {
      return { renewed: 0, skipped: 'throttled' }
    }

    const outcome = withFileLock(this.lockFile, () => {
      const table = readLockTable(this.file)
      let count = 0
      for (const entry of Object.values(table.locks)) {
        if (!entry || typeof entry !== 'object') continue
        // 老记录没有 sessionId：用 owner 兜底（acquire 写入时 sessionId === owner）。
        const entryOwner = typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : entry.owner
        if (entryOwner !== id) continue
        entry.heartbeatAt = now
        count++
      }
      // 一条都没有就不写盘（读多写少，避免无意义的 rename）。
      if (count === 0) return { renewed: 0 }
      atomicWriteFile(this.file, `${JSON.stringify(table, null, 2)}\n`)
      return { renewed: count }
    }, { clock: this.clock, holder: `lockstore:heartbeat:${id}` })

    if (!outcome.ok) {
      this.stats.ioFailed++
      this.log?.warn?.(`锁会话心跳续期失败：${outcome.reason}`)
      this.onEvent?.({ kind: 'lock-heartbeat-failed', detail: `${id}: ${outcome.reason}` })
      return { renewed: 0, error: outcome.reason }
    }
    this.sessionHeartbeats.set(id, now)
    if (outcome.value.renewed > 0) this.stats.heartbeatRenewed += outcome.value.renewed
    return { renewed: outcome.value.renewed }
  }

  /** 统计快照。 */
  snapshot() {
    return { ...this.stats, held: Object.keys(this.list()).length }
  }
}

function lockLabel(resourceId, name) {
  return resourceId || name || '(未知)'
}

/**
 * 读数指纹台账。
 *
 * ── 它治的是什么 ───────────────────────────────────────────────────────
 * 实测痛点：验收期间部署反复变化，读数无法归属。根因是**读数与产物
 * 之间没有绑定** —— 谁都能拿一个数说"我测的是最新版"。
 *
 * ── 四种状态，绝不把"不知道"显示成"有效"（R5）─────────────────────────
 *   `verified`   绑定过产物，且当前指纹与记录时**逐字节一致**
 *   `stale`      绑定过产物，但指纹变了 —— 这条读数作废
 *   `unverified` 没绑定产物 / 环境未知 / 指纹算法是旧版 —— **不能当验收通过**
 *   `error`      产物读不到、台账写不进去等
 *
 * `verified` 只代表"产物身份没变"这一件具体的事。它**不等于**测试通过、
 * 也不等于实验环境没被污染（补充评审 R9-D：与 Strata 的 verified 更不是
 * 同一件事，那边说的是"这个文件读过且没变"）。
 */
export class EvidenceLedger {
  /**
   * @param {string} [home]
   * @param {{clock?: any, log?: any, onEvent?: (e: object) => void, capabilities?: any}} [deps]
   */
  constructor(home = resolveDshHome(), deps = {}) {
    this.home = home
    this.paths = pluginPaths(home)
    this.clock = deps.clock ?? systemClock()
    this.log = deps.log ?? null
    this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null
    this.capabilities = deps.capabilities ?? null
  }

  /**
   * 记一条。**写不进去就返回失败**，不返回一个假装存在的记录对象（R5）。
   *
   * @param {{label: string, artifact?: string, artifactHash?: string, reading: string,
   *          owner?: string, note?: string, environment?: object, hashVersion?: number}} entry
   * @returns {{ok: true, row: object}|{ok: false, reason: string}}
   */
  record(entry) {
    const now = this.clock.now()
    let artifactHash = String(entry.artifactHash ?? '')
    const artifact = String(entry.artifact ?? '')
    // 给了产物路径却没给指纹时，自己按字节算一次。
    // 否则调用方一旦忘了传 hash，就会静默产出一堆 unverified 的"读数"，
    // 看起来记上了、实际永远无法核对。
    if (!artifactHash && artifact && isAbsolute(artifact)) {
      try {
        artifactHash = sha256File(artifact).hash
      } catch (error) {
        this.capabilities?.markObserved?.('evidenceLedger', `产物读不到，记为 unverified：${error?.message ?? error}`)
      }
    }
    const row = {
      at: new Date(now).toISOString(),
      label: String(entry.label ?? '').slice(0, 120),
      artifact,
      artifactHash,
      hashVersion: Number(entry.hashVersion) > 0 ? Number(entry.hashVersion) : HASH_ALGORITHM_VERSION,
      reading: String(entry.reading ?? '').slice(0, 500),
      owner: String(entry.owner ?? ''),
      note: String(entry.note ?? '').slice(0, 300),
      environment: entry.environment && typeof entry.environment === 'object' ? entry.environment : {},
      id: shortHash(`${now}:${entry.label}:${entry.reading}:${artifactHash}`),
    }
    try {
      mkdirSync(this.paths.dir, { recursive: true })
      appendFileSync(this.paths.evidence, `${JSON.stringify(row)}\n`, 'utf8')
    } catch (error) {
      this.capabilities?.markDegraded?.('evidenceLedger', `台账写入失败：${error?.message ?? error}`)
      return { ok: false, reason: `台账写入失败，这条读数**没有记上**：${error?.message ?? error}` }
    }
    this.capabilities?.markObserved?.('evidenceLedger', `${row.label} @${row.artifactHash.slice(0, 12) || '(无指纹)'}`)
    return { ok: true, row }
  }

  /** 全部读数（最新的在前）。 */
  list(limit = 200) {
    try {
      const text = readFileSync(this.paths.evidence, 'utf8')
      const rows = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { rows.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
      }
      return rows.slice(-limit).reverse()
    } catch {
      return []
    }
  }

  /**
   * 复核一条读数。
   *
   * @param {{label?: string, id?: string}} query
   * @param {(artifact: string) => {hash: string, algorithm: string}} hashOf
   *        由调用方提供"怎么算当前指纹"（必须是字节级 SHA-256）
   * @returns {{found: boolean, state: 'verified'|'stale'|'unverified'|'error',
   *            valid: boolean, row?: object, currentHash?: string, reason: string}}
   */
  check(query, hashOf) {
    const rows = this.list(500)
    const row = query?.id
      ? rows.find((r) => r.id === query.id)
      : rows.find((r) => r.label === query?.label)
    if (!row) {
      return { found: false, state: 'error', valid: false, reason: '台账里没有这条读数' }
    }
    if (!row.artifact || !row.artifactHash) {
      return {
        found: true,
        state: 'unverified',
        valid: false,
        row,
        reason: '这条读数没有绑定产物指纹，**无法核对** —— 它不是有效验收，只是一条自述。',
      }
    }
    // 旧算法（v1：先 String(buffer) 再 UTF-8 hash）的记录不能无条件继承为有效。
    const version = Number(row.hashVersion) || 1
    if (version < HASH_ALGORITHM_VERSION) {
      return {
        found: true,
        state: 'unverified',
        valid: false,
        row,
        reason: `这条读数的指纹是旧算法（hashVersion=${version}）算的：它把字节流先转成 UTF-8 字符串，`
          + '不同字节可能撞成同一个 hash，也与 sha256sum 不一致。**必须重新记录**，不能沿用它当验收。',
      }
    }

    let current
    try {
      current = hashOf(row.artifact)
    } catch (error) {
      return {
        found: true,
        state: 'error',
        valid: false,
        row,
        reason: `算不出当前指纹（产物读不到？）：${error?.message ?? error}`,
      }
    }
    const currentHash = String(current?.hash ?? '')
    if (!currentHash) {
      return { found: true, state: 'error', valid: false, row, reason: '当前指纹为空，无法核对' }
    }
    if (currentHash !== row.artifactHash) {
      return {
        found: true,
        state: 'stale',
        valid: false,
        row,
        currentHash,
        reason: `产物已漂移：记读数时是 ${row.artifactHash.slice(0, 12)}，现在是 ${currentHash.slice(0, 12)} —— 这条读数作废。`,
      }
    }
    return {
      found: true,
      state: 'verified',
      valid: true,
      row,
      currentHash,
      reason: '产物指纹逐字节一致。注意：这只证明**产物身份没变**，'
        + '不证明测试通过、也不证明实验环境没被污染。',
    }
  }

  /** 统计：总共几条、涉及几个不同产物指纹、各状态几条。 */
  stats() {
    const rows = this.list(2000)
    const byVersion = {}
    for (const row of rows) {
      const version = Number(row.hashVersion) || 1
      byVersion[version] = (byVersion[version] ?? 0) + 1
    }
    return {
      total: rows.length,
      artifacts: new Set(rows.map((r) => r.artifactHash).filter(Boolean)).size,
      bound: rows.filter((r) => r.artifactHash).length,
      unbound: rows.filter((r) => !r.artifactHash).length,
      legacyHashVersion: byVersion[1] ?? 0,
      byHashVersion: byVersion,
      hashAlgorithmVersion: HASH_ALGORITHM_VERSION,
    }
  }
}

/**
 * 会话级计数器（内存态，不落盘）。
 *
 * 只用来回答"这条命令在这个会话里跑了几次"。重启后归零是**可以接受**的：
 * 它只影响一次提醒，不是审计数据。
 */
export class Counters {
  constructor() {
    /** @type {Map<string, Map<string, number>>} sessionId → (key → count) */
    this.bySession = new Map()
    this.limit = 400
  }

  /** 加一并返回新的计数。 */
  bump(sessionId, key) {
    const id = String(sessionId ?? '-')
    let bucket = this.bySession.get(id)
    if (!bucket) { bucket = new Map(); this.bySession.set(id, bucket) }
    const next = (bucket.get(key) ?? 0) + 1
    bucket.set(key, next)
    // 单个会话的键数上限，防止超长会话把内存吃光。
    if (bucket.size > this.limit) {
      const first = bucket.keys().next().value
      bucket.delete(first)
    }
    return next
  }

  get(sessionId, key) {
    return this.bySession.get(String(sessionId ?? '-'))?.get(key) ?? 0
  }

  reset(sessionId) {
    if (sessionId === undefined) this.bySession.clear()
    else this.bySession.delete(String(sessionId ?? '-'))
  }
}
