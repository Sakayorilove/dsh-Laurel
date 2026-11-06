/**
 * laurel-memory/memory/write-lock —— 记录写入的租约锁（S7，对应 §9.8）。
 *
 * ── 形状从哪来 ────────────────────────────────────────────────────────
 * oh-my-dsh 的 \`src/dream/store.mjs:91-102\` 把「写权」拆成四件事，这里照搬这个**分离**：
 *   acquire(ttl) → epoch        拿到写权，并得到一个**单调递增**的 epoch
 *   holds(epoch)                我还是不是持有者（owner + epoch + 未过期，三条同时成立）
 *   renew(epoch, ttl)           续租
 *   release(epoch)              归还（带 fence：epoch 不符时不删别人的锁）
 * 介质换成锁文件：本仓不用 SQLite，\`openSync(file,'wx')\`（O_EXCL）+ 内容里写
 * \`{pid, host, at, ttlMs, epoch, nonce}\` 就能表达同一套语义。
 *
 * ── 为什么不直接复用 laurel-core/lib/lock.mjs 的 acquireWrite ──────────
 * 它有 fence、staleGrace、同机死锁回收 —— 但**没有 epoch**。S7 要的恰恰是
 * 「这条记录基于哪个版本」可验证：写入方拿着 epoch E，别人抢走之后它必须写不进去。
 * fence 是个随机串（只用来防误删），既不单调也不能对外承诺，所以替代不了 epoch。
 * 它的两条判断是**对的**，这里保留：
 *   1. 同机 + 持有者 pid 已经不在 → 立刻回收（与 TTL 无关，死进程不会自己删锁）；
 *   2. 任意主机 + 锁龄超过 staleGrace×TTL → 按租约作废回收（跨机没法判活，只能这样兜底）。
 * 主机身份怎么取、怎么比，**直接 import** laurel-core 的实现，不抄第二份 ——
 * D146a（Windows 的 COMPUTERNAME 与 WSL 的 hostname 口径不等导致死锁永不回收）
 * 就是从「各写一份」来的。
 *
 * ── epoch 为什么要一个旁路高水位 ───────────────────────────────────────
 * \`release()\` 会把锁文件删掉（验收要求「锁文件可删」），删掉之后**下一个持有者
 * 就读不到上一个 epoch 了** —— epoch 会从 1 重新开始，于是「进程 A 用 epoch 1
 * 写过、释放、进程 B 也拿到 epoch 1」这种复用就可能让 A 手里那张过期的票
 * 蒙混过关。store.mjs 不会有这个问题（lease 行永不删、只把 expires 置 0）。
 * 这里用 \`write.lock.epoch\` 记一个**只增不减的高水位**，代价是一个 20 字节的小文件，
 * 换掉的是一整类「epoch 复用」的静默错误。它只是提示，权威判断始终是锁文件本身。
 *
 * ── 性能口径（注入侧每一步都可能写）────────────────────────────────────
 * 临界区是毫秒级的（一次追加 + fsync），所以：
 *   - \`waitMs\` 默认 120ms：抢不到就退避重试，超了**如实返回 locked**，不阻塞对话；
 *   - 退避 1/2/4/8/16ms 封顶（与 laurel-core 同一套节奏），不用忙等也不睡长觉；
 *   - 锁文件**不做 fsync**：内容不到 200 字节、一次 write 就写完了，而「锁没了」
 *     只等于「这把锁没人拿」—— 由 O_EXCL 重新抢，不存在需要持久性的语义。
 */
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { hostIdentity, hostMatches } from '../../../laurel-core/lib/lock.mjs'

/**
 * 记录侧锁文件名。**刻意与另外两把锁分开**：
 *   - 仓根的 \`write.lock\`（vault.commit）保护「journal 链尾 + blob 引用」；
 *   - \`experience/write.lock\`（appendEpisode）保护 episodes.jsonl 的单行追加；
 *   - 这一把（\`memory/write.lock\`）保护 records.jsonl 的「校验 + 追加」整体。
 * 三个临界区没有嵌套关系，共用一把锁只会把三种不相干的写入串成一条队。
 */
export const RECORD_LOCK_FILE = join('memory', 'write.lock')

/** 租约时长：临界区是毫秒级，10s 足够容忍一次冷启动的全文件扫描。 */
export const DEFAULT_LOCK_TTL_MS = 10_000
/** 抢锁预算：抢不到就如实返回 locked（调用方计数，下一轮再试），不拖住宿主对话。 */
export const DEFAULT_LOCK_WAIT_MS = 120
/** 过期锁在「持有者还活着」时最多还能占多久（倍数 × TTL），超过按尸体回收。 */
export const DEFAULT_STALE_GRACE = 3

const LOCK_VERSION = 1

/** 同步小睡。临界区本身就是同步的，这里阻塞当前线程不会比一次 commit 更糟。 */
function sleepSync(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 持有者进程是否还在。**只对同机有意义**（跨机 pid 没有可比性，调用方必须先判主机）。
 * \`EPERM\` 表示进程在、只是我没权限发信号 —— 那也算活着。
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function lockPath(dir, lockFile) { return join(dir, lockFile) }
function epochFloorPath(dir, lockFile) { return join(dir, lockFile + '.epoch') }

/**
 * 读锁文件。
 * @returns {object|null} 不存在 / 空文件 / 内容坏掉一律 null —— 调用方必须自己
 *   用 existsSync 区分「没有锁」与「有锁但读不出」，这两件的处理完全相反。
 */
export function readWriteLock(dir, { lockFile = RECORD_LOCK_FILE } = {}) {
  const file = lockPath(dir, lockFile)
  try {
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return null
    const holder = JSON.parse(raw)
    return holder && typeof holder === 'object' ? holder : null
  } catch { return null }
}

/** epoch 高水位（只增不减）。读不到就是 0，不抛。 */
function readEpochFloor(dir, lockFile) {
  try {
    const n = Number.parseInt(readFileSync(epochFloorPath(dir, lockFile), 'utf8').trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch { return 0 }
}

/** 把高水位抬到 epoch。尽力而为：写不进去只影响「下一个人拿到的 epoch 可能偏小」，不阻断写入。 */
function bumpEpochFloor(dir, epoch, lockFile) {
  try {
    const floor = readEpochFloor(dir, lockFile)
    if (epoch > floor) writeFileSync(epochFloorPath(dir, lockFile), String(epoch) + '\n')
  } catch { /* 高水位只是提示，失败不影响正确性 */ }
}

function nextEpoch(dir, prev, lockFile) {
  const fromLock = Number(prev?.epoch)
  const base = Math.max(Number.isFinite(fromLock) && fromLock > 0 ? fromLock : 0, readEpochFloor(dir, lockFile))
  return base + 1
}

/** 判定锁当前归谁。返回 \`{state}\`：free / held / stale。 */
function judgeHolder(prev, at, { ttlMs, staleGrace, host }) {
  const age = at - (prev?.at ?? 0)
  const ttl = Number.isFinite(prev?.ttlMs) && prev.ttlMs > 0 ? prev.ttlMs : ttlMs
  if (age <= ttl) return { state: 'held', reason: 'held', ageMs: age }
  // 过期了。但「过期」不等于「人死了」：同一台机器上 pid 还活着就再等一会儿，
  // 超过 staleGrace×TTL 才按租约作废回收（staleGrace=1 等价于「一过期就抢」）。
  if (hostMatches(prev?.host, host) && pidAlive(prev?.pid) && age <= ttl * Math.max(1, staleGrace)) {
    return { state: 'held', reason: 'expired-but-alive', ageMs: age }
  }
  return { state: 'stale', reason: 'stale', ageMs: age }
}

/**
 * 抢记录侧写锁。
 *
 * @param {string} dir  核心仓根（锁落在 \`memory/write.lock\`）
 * @param {{ttlMs?:number, waitMs?:number, staleGrace?:number, now?:()=>number, lockFile?:string}} opts
 * @returns {{ok:true, epoch:number, file:string, holder:object, release:()=>object}
 *          |{ok:false, reason:string, holder?:object|null, ageMs?:number, note?:string, error?:string}}
 */
export function acquireWriteLock(dir, {
  ttlMs = DEFAULT_LOCK_TTL_MS,
  waitMs = DEFAULT_LOCK_WAIT_MS,
  staleGrace = DEFAULT_STALE_GRACE,
  now = Date.now,
  lockFile = RECORD_LOCK_FILE,
} = {}) {
  if (!dir) return { ok: false, reason: 'no-dir' }
  const file = lockPath(dir, lockFile)
  mkdirSync(dirname(file), { recursive: true })
  const host = hostIdentity()
  const nonce = process.pid + '-' + Math.random().toString(36).slice(2, 10)
  const started = now()
  let attempt = 0

  /** 还能不能再等一轮；不能再等就把失败原因原样交回去。 */
  const retryOr = (reason, holder) => {
    const nap = Math.min(16, 2 ** attempt)
    if (now() - started + nap > waitMs) {
      return { ok: false, reason, holder: holder ?? null, ageMs: holder ? now() - (holder.at ?? 0) : undefined }
    }
    sleepSync(nap)
    attempt += 1
    return null
  }

  for (;;) {
    const t = now()
    const exists = existsSync(file)
    // 注意 exists 与 readWriteLock 分开判：文件在但读不出来（刚被 O_EXCL 创建、
    // 内容还没写进）**绝不能被当成「没有锁」**，否则会去抢一个正在建立的锁。
    const prev = exists ? readWriteLock(dir, { lockFile }) : null
    let verdict
    if (exists && !prev) verdict = { state: 'held', reason: 'unreadable-lock' }
    else if (!prev) verdict = { state: 'free', reason: 'free' }
    else verdict = judgeHolder(prev, t, { ttlMs, staleGrace, host })

    if (verdict.state === 'held') {
      const stop = retryOr(verdict.reason, prev)
      if (stop) return stop
      continue
    }

    if (verdict.state === 'stale') {
      // 抢之前**再读一次**：读到的东西和刚才判定的不是同一把锁，说明别人已经换过手，
      // 那就重新判（不要拿一个过期的判断去删一把新的锁）。
      const again = readWriteLock(dir, { lockFile })
      const same = again && prev && again.epoch === prev.epoch && again.pid === prev.pid && again.at === prev.at && again.nonce === prev.nonce
      if (!same) {
        const stop = retryOr('contended', again)
        if (stop) return stop
        continue
      }
      try { unlinkSync(file) } catch { /* 别人先回收了，下面 O_EXCL 会说话 */ }
    }

    // 到这里：要么本来就没锁，要么刚把过期锁清掉。用 O_EXCL 建，谁建成谁持有。
    const epoch = nextEpoch(dir, prev, lockFile)
    let fd = null
    let created = false
    try {
      fd = openSync(file, 'wx')
      writeSync(fd, JSON.stringify({ v: LOCK_VERSION, pid: process.pid, host, at: t, ttlMs, epoch, nonce }))
      created = true
    } catch (error) {
      // EEXIST = 有人在我们判完之后抢先建了，退避重试即可；其它是真实的 IO 问题，别重试。
      if (error?.code !== 'EEXIST') return { ok: false, reason: 'io', error: String(error?.message ?? error) }
    } finally {
      if (fd !== null) { try { closeSync(fd) } catch { /* 关不掉不掩盖上面的错误 */ } }
    }

    if (!created) {
      const stop = retryOr('held', readWriteLock(dir, { lockFile }))
      if (stop) return stop
      continue
    }

    const holder = readWriteLock(dir, { lockFile })
    if (!holder || holder.nonce !== nonce) {
      // 极端竞态：刚建好就被别人回收/覆盖。**不假装拿到**，如实失败。
      return { ok: false, reason: 'contended', holder, note: '锁创建后立即被他人改写，放弃本次获取' }
    }
    bumpEpochFloor(dir, epoch, lockFile)
    return { ok: true, epoch, file, holder, release: () => releaseWriteLock(dir, epoch, { lockFile }) }
  }
}

/**
 * 我还是不是持有者：owner（pid + host）与 epoch 都得对上，并且没过期。
 *
 * 这是「过期 epoch 写入必抛错」的判据 —— store.mjs:100 同一个式子。
 */
export function holdsWriteLock(dir, epoch, { now = Date.now, lockFile = RECORD_LOCK_FILE } = {}) {
  if (!Number.isFinite(epoch)) return false
  const holder = readWriteLock(dir, { lockFile })
  if (!holder) return false
  if (holder.epoch !== epoch) return false
  if (holder.pid !== process.pid) return false
  if (!hostMatches(holder.host, hostIdentity())) return false
  const ttl = Number.isFinite(holder.ttlMs) && holder.ttlMs > 0 ? holder.ttlMs : DEFAULT_LOCK_TTL_MS
  return now() - (holder.at ?? 0) <= ttl
}

/** 续租。续不上就返回 false（调用方必须当成「锁已经不属于我」处理）。 */
export function renewWriteLock(dir, epoch, { ttlMs = DEFAULT_LOCK_TTL_MS, now = Date.now, lockFile = RECORD_LOCK_FILE } = {}) {
  if (!holdsWriteLock(dir, epoch, { now, lockFile })) return false
  const file = lockPath(dir, lockFile)
  const holder = readWriteLock(dir, { lockFile })
  if (!holder) return false
  const tmp = file + '.renew-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  try {
    writeFileSync(tmp, JSON.stringify({ ...holder, at: now(), ttlMs }))
    renameSync(tmp, file)
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    return false
  }
}

/**
 * 归还写权。**带 fence**：epoch 或 pid 不符就不删 ——
 * 那时锁已经不属于我了，删掉等于把别人的临界区打开。与 store.mjs:102 同一口径。
 */
export function releaseWriteLock(dir, epoch, { lockFile = RECORD_LOCK_FILE } = {}) {
  const file = lockPath(dir, lockFile)
  const holder = readWriteLock(dir, { lockFile })
  if (!holder) return { released: false, reason: existsSync(file) ? 'unreadable' : 'missing' }
  if (holder.epoch !== epoch || holder.pid !== process.pid) return { released: false, reason: 'fence-mismatch', holder }
  try { unlinkSync(file); return { released: true } } catch (error) { return { released: false, reason: String(error?.message ?? error) } }
}

/** 只读探测：给面板/诊断看「谁占着」。不改任何东西。 */
export function inspectWriteLock(dir, { now = Date.now, lockFile = RECORD_LOCK_FILE } = {}) {
  const file = lockPath(dir, lockFile)
  if (!existsSync(file)) return { held: false, file }
  const holder = readWriteLock(dir, { lockFile })
  if (!holder) return { held: true, reason: 'unreadable', file }
  const ageMs = now() - (holder.at ?? 0)
  const ttl = Number.isFinite(holder.ttlMs) ? holder.ttlMs : DEFAULT_LOCK_TTL_MS
  return { held: true, holder, ageMs, expired: ageMs > ttl, file }
}
