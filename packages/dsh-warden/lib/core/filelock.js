/**
 * dsh-warden · 跨进程文件锁原语
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────────
 * 评审 R4 的原话：**「原子文件 rename 不是读改写事务」**。
 *
 * `writeFileSync(tmp)` + `renameSync(tmp, file)` 只保证「读到的永远是某一份
 * 完整的 JSON」，不保证「两个进程同时 读→改→写 之后两边的改动都还在」。
 * 后者必然丢一边。锁表、治理声明表都是典型的读改写，所以必须先拿到
 * **独占创建**的锁文件才允许改。
 *
 * 独占靠 `openSync(path, 'wx')`：`O_CREAT|O_EXCL`，文件已存在就抛 `EEXIST`。
 * 这是 POSIX/Windows 都由文件系统保证的原子操作，比"先 stat 再 write"可靠。
 *
 * ── 边界（必须诚实说明）────────────────────────────────────────────────
 *   1. 进程崩在临界区里会留下锁文件。所以锁文件带 `expiresAt` 与 `pid`，
 *      过期或持有者已死才可回收 —— **回收前必须验证持有者不在了**，
 *      不能只看时间（否则就是 R4 说的"过期不等于旧写者已停止"）。
 *   2. 这管不住"任意 shell 命令里看不出来的写入"。那种情况一律标未覆盖。
 *   3. 网络文件系统（含某些 `/mnt/*` 挂载）上 `O_EXCL` 语义不保证。
 *      因此默认把锁放在 `$DSH_HOME`（本机盘），不放共享挂载。
 *   4. `openSync(…,'wx')` 成功到写元数据之间有毫秒级窗口，进程死在这中间会留下
 *      **0 字节锁文件**。这类锁读不出 `expiresAt`/`pid`，所以改按**文件 mtime**
 *      兜底回收（比 4 倍 TTL 还老才动），否则它会永远占着锁（P1-6）。
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { systemClock } from './clock.js'

/** 默认锁持有上限。到期且持有者已死才可回收。 */
export const DEFAULT_LOCK_TTL_MS = 5000

/**
 * 拿不到锁时的重试节奏与等待方式。
 *
 * ⚠️ `withFileLock` 是**同步** API（6 个调用点全在同步钩子里），所以「等一会儿」
 * 只能是阻塞等待，不能 `await`。旧实现是纯自旋：
 * `while (Date.now() < until) {}`，40 × 8ms = 最坏 320ms **占满 CPU、卡死事件循环**，
 * 而治理心跳每 2 秒就要走一次锁。
 *
 * 现在的处理（P2-9）：
 *   1. `sleep()` 改用 `Atomics.wait` 真正挂起线程，等待期间不烧 CPU；
 *      运行时不允许阻塞才退回自旋（保证不因优化而抛错）。
 *   2. 重试从「固定 40 次」改成「**固定预算** 320ms」（= 改前 40×8ms 的最坏值），
 *      每次最多睡 `RETRY_DELAY_MS`，到点就放弃。
 *
 * 为什么要按预算而不是按次数：`Atomics.wait` 有 ~15.6ms 的定时器粒度，
 * 请求 16ms 实际睡 ~31ms（本机 Windows 10 + Node 22.22.2 实测）。
 * 若照搬「12 次 × 25ms」这种按次数的写法，实测 373ms，比改前的 320ms **更慢**
 * （只是不再烧 CPU）—— 那是"省了 CPU、慢了响应"，不算修好。
 * 按预算写就和粒度无关：**最坏阻塞 320ms 与改前一致**，唤醒次数由 40 降到 ~10。
 *
 * 实测对照（同一台机器，各 3 次）：
 *   旧 40×自旋 8ms  → 实际 320/320/320ms，CPU **328/328/313ms**（基本全程满载）
 *   旧口径 12×wait25 → 实际 374/371/373ms，CPU 15/0/0ms  ← 更慢，否掉
 *   本实现（预算 320ms）→ 实际 320~351ms（含每轮读锁/stat 开销），CPU 0ms
 *
 * 诚实边界：拿不到锁的那条路仍会**阻塞事件循环约 320ms**。根治要把
 * `withFileLock` 改 async 并同步改 6 个调用点（扩散性改动），**本次未做**。
 */
const RETRY_DELAY_MS = 16

/** 拿不到锁时最多耗多久（毫秒）。与改前 40×8ms 的最坏值相同，不改对外语义。 */
const RETRY_BUDGET_MS = 320

/** `Atomics.wait` 能不能用（每个进程只探测一次）。Node 主线程支持，浏览器主线程会抛。 */
let atomicWaitUsable = null

/**
 * 阻塞等一小段，**不空转 CPU**。
 *
 * `Atomics.wait` 在 Node 主线程可用（实测睡 120ms，user+system CPU = 0ms），
 * 它把线程真正挂起而不是空转。运行时不给用（例如浏览器主线程不允许阻塞）时
 * 才退回旧的自旋，保证「优化等待」不会变成「抛错」。
 */
function sleep(ms) {
  if (ms <= 0) return
  if (atomicWaitUsable !== false) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
      atomicWaitUsable = true
      return
    } catch {
      // SharedArrayBuffer 未共享 / 主线程不允许阻塞：落到下面的退路。
      atomicWaitUsable = false
    }
  }
  const until = Date.now() + ms
  while (Date.now() < until) { /* 退路：运行时不允许阻塞时才自旋 */ }
}

/** 锁文件"有多大年纪"的毫秒时间戳。读不到（`stat` 抛错/文件正在被删）返回 null。 */
function lockStatMs(file) {
  try {
    const mtimeMs = statSync(file).mtimeMs
    return Number.isFinite(mtimeMs) ? mtimeMs : null
  } catch {
    return null
  }
}

/** 进程还在不在。`process.kill(pid, 0)` 不发信号，只探测。 */
export function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isSafeInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    // ESRCH = 进程不存在；EPERM = 存在但不属于我们（也算活着）。
    return error?.code === 'EPERM'
  }
}

/** 锁文件里写了什么。读不出来当"内容未知"，不当"没人持有"。 */
function readLockMeta(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 这个陈旧锁能不能回收。
 *
 * 必须**两个条件都成立**：已过期，且持有者进程确实不在了。
 * 只有其一都返回 false —— 时间到了不代表旧写者已经停止（R4）。
 * `pid` 缺失时按「无法证明已停止」处理，保守不回收。
 *
 * ── 内容读不出来的锁（P1-6）─────────────────────────────────────────
 * `openSync(…,'wx')` 成功到写元数据之间有毫秒级窗口，进程死在这中间会留下
 * **0 字节锁文件**。它读不出 `expiresAt`/`pid`，旧逻辑第一句就是
 * `if (!meta) return false`，于是这把锁**永远回收不了** —— 治理表、锁表、心跳
 * 全都卡死，只能人工删文件。
 *
 * 所以加第三条路径：**`meta === null` 时按文件 mtime 判老**，
 * `statMs + ttlMs * 4 < now` 才算孤儿（给正常持锁者留 4 倍 TTL 余量）。
 * 临界区是毫秒级的，真要有人持锁超过 4×TTL，它早该按陈旧锁处理了。
 *
 * 这个函数**保持纯函数**：自己不读 fs。调用方把 `statMs`（`statSync(lock).mtimeMs`）
 * 当第三参传进来。**不传 statMs 就完全保持旧的保守行为** —— 这样单测能直接盯它，
 * 也不会让「读盘失败」悄悄变成「允许回收」。
 *
 * @param {object|null} meta 锁内容；`null` = 内容读不出来（可能就是 0 字节孤儿锁）
 * @param {number} now 当前时间（毫秒）
 * @param {number|null} [statMs] 锁文件 mtime（毫秒）；缺省 = 不知道文件多老 → 不回收
 * @param {number} [ttlMs] 这把锁的 TTL，用来算孤儿阈值；缺省 `DEFAULT_LOCK_TTL_MS`
 * @returns {boolean}
 */
export function reclaimable(meta, now, statMs, ttlMs) {
  if (!meta) {
    // 内容读不出来：只能靠「文件够老」。没给 statMs 就是旧的保守行为（不回收）。
    if (statMs === null || statMs === undefined) return false
    const mtimeMs = Number(statMs)
    const nowMs = Number(now)
    if (!Number.isFinite(mtimeMs) || !Number.isFinite(nowMs)) return false
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_LOCK_TTL_MS
    return mtimeMs + ttl * 4 < nowMs
  }
  const expiresAt = Number(meta.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt > now) return false
  if (meta.pid === undefined || meta.pid === null) return false
  return !pidAlive(meta.pid)
}

/**
 * 在独占锁保护下跑一次读改写。
 *
 * @param {string} lockFile 锁文件路径（不要和目标文件同名）
 * @param {() => T} body 临界区。里面的读改写才是原子的。
 * @param {{ttlMs?: number, clock?: any, holder?: string, onStale?: (meta: object|null) => void}} [options]
 *        `onStale` 收到的 `meta` 可能是 `null`（锁文件内容读不出来、按 mtime 当孤儿回收）。
 * @returns {{ok: true, value: T}|{ok: false, reason: string, heldBy?: object}}
 */
export function withFileLock(lockFile, body, options = {}) {
  const clock = options.clock ?? systemClock()
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_LOCK_TTL_MS
  const holder = options.holder ?? `${process.pid}`

  try {
    mkdirSync(dirname(lockFile), { recursive: true })
  } catch (error) {
    return { ok: false, reason: `建不出锁目录：${error?.message ?? error}` }
  }

  let fd = null
  const retryDeadline = Date.now() + RETRY_BUDGET_MS
  for (;;) {
    try {
      fd = openSync(lockFile, 'wx')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: `创建锁失败：${error?.code ?? error?.message ?? error}` }
      }
      const meta = readLockMeta(lockFile)
      // 内容读不出来（典型：崩溃留下的 0 字节锁）→ 补一次「文件够老」的兜底判定。
      // 正常路径（meta 可解析）不额外 stat，系统调用数与改动前一致。
      const statMs = meta === null ? lockStatMs(lockFile) : null
      if (reclaimable(meta, clock.now(), statMs, ttlMs)) {
        options.onStale?.(meta)
        try { rmSync(lockFile, { force: true }) } catch { /* 下一轮重试 */ }
        // 回收后立刻重试，但仍受预算约束：删不掉时不能原地死循环。
        if (Date.now() >= retryDeadline) break
        continue
      }
      // 有人真的持有（或无法证明它已停止）—— 等一会儿再试，但**到预算就放弃**。
      const remaining = retryDeadline - Date.now()
      if (remaining <= 0) break
      sleep(Math.min(RETRY_DELAY_MS, remaining))
    }
  }

  if (fd === null) {
    const meta = readLockMeta(lockFile)
    // 内容读不出来的锁不是「有人持有」。如实说清它多老、为什么还没被回收。
    const statMs = meta === null ? lockStatMs(lockFile) : null
    const ageMs = statMs === null ? null : Math.max(0, clock.now() - statMs)
    return {
      ok: false,
      reason: ageMs === null
        ? '在限定时间内没有取得文件锁'
        : '在限定时间内没有取得文件锁（锁文件内容读不出来，只有 ' + ageMs + 'ms 老，未达孤儿回收阈值 ' + (ttlMs * 4) + 'ms）',
      ...(meta ? { heldBy: meta } : {}),
    }
  }

  const expiresAt = clock.now() + ttlMs
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, holder, expiresAt })}\n`, 'utf8')
  } catch { /* 元数据写不进去不影响本次独占，只是回收时更保守 */ }

  try {
    const value = body()
    return { ok: true, value }
  } catch (error) {
    return { ok: false, reason: `临界区失败：${error?.message ?? error}` }
  } finally {
    try { closeSync(fd) } catch { /* 已关就忽略 */ }
    try { rmSync(lockFile, { force: true }) } catch { /* 删不掉就等它过期回收 */ }
  }
}

/** 原子写：先写临时文件再改名。失败**必须**抛给调用方，不许静默。 */
export function atomicWriteFile(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf8')
  try {
    // 改名前先确认临时文件真的落盘了，避免把 0 字节换上去。
    if (statSync(tmp).size !== Buffer.byteLength(text, 'utf8')) {
      throw new Error('临时文件大小与内容不一致')
    }
    renameSync(tmp, file)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* 清不掉就算了 */ }
    throw error
  }
}
