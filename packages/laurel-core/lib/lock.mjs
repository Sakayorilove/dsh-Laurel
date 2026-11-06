/**
 * laurel-core/lock —— 跨进程单写入 + 栅栏。
 *
 * 纪律：
 *  1. 用 O_EXCL 独占创建锁文件，内容是 {pid, host, at, fence, ttlMs}。
 *  2. 过期锁不等于可以抢：必须能证明持有者进程已不在（同机查 /proc，跨机靠 TTL + 明确告警）。
 *  3. 第二实例拿不到锁 → 只读模式，并给出可诊断原因；不删活锁。
 *  4. 释放带 fence：fence 不符说明锁已被回收，必须停止写入。
 *
 * 【D146 2026-10-22】三条实测缺陷，全部在本轮修掉，改动理由逐条记在这里：
 *  (a) **host 身份口径跨 OS 不等** → 陈旧锁永不回收。
 *      实测：Windows 宿主 `COMPUTERNAME='<HOST>'`，WSL 进程里 `process.env.COMPUTERNAME`
 *      是 `undefined`（不是空串，是不存在）→ host 字段退成 `'unknown'`；而 `os.hostname()`
 *      在 WSL 里是 `'<host>'`。于是 `holder.host === host` 恒为 false → `sameHost` 恒 false →
 *      `judgeHolder` 永远走「跨机锁无法确认持有者存活」分支，`reason='expired-but-alive-or-unknown-host'`。
 *      本工程恰好是 Windows 宿主 + WSL 脚本共用一个核心仓，这条路径是活的。
 *      修法：`hostIdentity()` 取 `COMPUTERNAME || os.hostname()`，比较时统一小写并去掉域名后缀；
 *      不写 `'unknown'`（把「不知道」当成一个真实主机名是这类 bug 的起点）。
 *  (b) **过期锁只能等 120 秒**（持有者已死但 TTL 没到）→ 这 120 秒里每一次 commit 都直接失败。
 *      实测 `repro-held.mjs`：`{pid:999999, host:本机, age:5s, ttl:120s}` → `reason:'held'`；
 *      同一个死 pid、`age:200s` → `ok:true`。
 *      修法：`pidAlive` 已能判死，但由于 (a) 的 host 不等根本走不到判死那一步；(a) 修完后
 *      同机死锁立刻可回收。跨机（真的另一台机器）仍不能判死 → 另加 `staleGrace`：
 *      `age > ttlMs * 2` 时按「租约彻底作废」回收，并把回收回执写进返回值，
 *      不再无声无息地永久卡死。（commit 是毫秒级操作，2×TTL=4 分钟仍未释放只可能是尸体。）
 *  (c) **抢不到就整笔判死，没有重试** → 正常并发竞争直接变成数据丢失。
 *      实测 `repro-contend.mjs`（4 进程 × 300 次抢同一把锁）：`ok=687 / held=510 (42.5%)`。
 *      修法：`acquireWrite` 增加 `waitMs` 退避重试预算（默认 0 = 保持旧行为，
 *      需要 fail-closed 的调用方不受影响）；`vault.commit` 传 `waitMs`。
 */
import {
  openSync, writeSync, closeSync, fsyncSync, readFileSync, existsSync, unlinkSync, mkdirSync, linkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'

export const LOCK_FILE = 'write.lock'

/**
 * 本进程的主机身份。**不许退回 `'unknown'`** —— 那会让跨 OS 的两个进程
 * 一个叫 `'unknown'`、一个叫 `'<HOST>'`，`sameHost` 恒 false，陈旧锁永不回收。
 */
export function hostIdentity() {
  const raw = process.env.COMPUTERNAME || process.env.HOSTNAME || hostname() || ''
  return String(raw).trim()
}

/** 主机名比较：大小写不敏感、忽略 `.local` / 域名后缀。空串视为不相等。 */
export function hostMatches(a, b) {
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\.local$/, '').split('.')[0]
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  return x === y
}

function readLock(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** 同步小睡：commit 本身就是同步的，这里阻塞当前线程不会比 commit 更糟。 */
function sleepSync(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 尝试取得写权。
 * @returns {{ok:true, fence:number, release:Function} | {ok:false, reason:string, holder?:object}}
 */
// 【T5b 2026-10-23】新增可选 `lockFile`：锁的**实现**（原子 link + fence + 陈旧回收 +
// 退避重试）与锁的**文件名**是两件事。此前文件名写死成 LOCK_FILE（write.lock，
// 供 vault.commit 保护 journal 链），于是任何别的写入临界区想复用这套锁，
// 都只能要么去抢 write.lock（把经验写入和整仓提交串成一条队，粒度错），
// 要么自己再抄一套——后者正是本仓反复忌惮的「第二套锁语义」。
// 默认值 = 原 LOCK_FILE，**所有现有调用方行为不变**；这是纯增量参数。
export function acquireWrite(vaultDir, { ttlMs = 120_000, host = hostIdentity(), attempt = 0, waitMs = 0, staleGrace = 2, reclaims = 0, lockFile = LOCK_FILE } = {}) {
  const file = join(vaultDir, lockFile)
  mkdirSync(dirname(file), { recursive: true })
  // fence 必须在**写入前只算一次**。写成 `{fence: Date.now()}` 又在返回里再算一次，
  // 两次会得到不同毫秒数 → releaseWrite 永远 fence-mismatch → 锁永久泄漏，
  // 表现为"第一次写成功、之后全部 held"。这类 bug 只在连续调用时暴露。
  // 只算一次 fence（写进文件与返回必须同一个值，否则 release 永远 mismatch）
  const fence = Date.now()
  // nonce 用于"确认这把锁是不是我抢到的"。不能只用 fence 判断：
  // 同一毫秒内两个进程可能得到相同 fence，会互相误认对方是自己的锁。
  const nonce = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  const payload = JSON.stringify({ pid: process.pid, host, at: fence, ttlMs, fence, nonce })
  // 原子创建：先写一个唯一临时文件，再用 link() 抢占正式锁名。
  // 直接用 open(wx) 再 write 会留下"文件已存在但内容为空"的窗口，
  // 这期间别的进程读锁会得到 unreadable-lock（并发下实测到过）。
  // link() 是原子的：要么成功且内容完整，要么失败。
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  let gotLock = false
  try {
    const fd = openSync(tmp, 'wx')
    try { writeSync(fd, payload); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      linkSync(tmp, file)
      gotLock = true          // link 成功 = 我们抢到了
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      // 已存在：别人占着
    }
  } catch (e) {
    if (!['EEXIST', 'ENOENT', 'EPERM'].includes(e.code)) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      return { ok: false, reason: 'io', error: String(e.message) }
    }
  } finally {
    try { unlinkSync(tmp) } catch { /* 别人已清 */ }
  }
  if (gotLock) {
    const h = readLock(file)
    if (h && h.nonce === nonce) return { ok: true, fence, file, nonce, release: () => releaseWrite(file, fence) }
    // 极端情况：link 后立刻被别人回收又重建。保守视为失败。
    return { ok: false, reason: 'held', holder: h }
  }
  // 【D146c】退避重试：等到这里的含义是"锁被别人占着"。旧行为是一次失败就返回，
  // 于是 42.5% 的正常竞争被上游当成数据丢失（vault.commit 直接把整笔提交判死）。
  // waitMs>0 时按 attempt 递增退避（1/2/4/8ms…上限 16ms），总预算不超过 waitMs。
  if (waitMs > 0) {
    const spent = attempt === 0 ? 0 : Math.min(16, 2 ** (attempt - 1))
    if (spent < waitMs) {
      sleepSync(spent)
      return acquireWrite(vaultDir, { ttlMs, host, attempt: attempt + 1, waitMs: waitMs - spent, staleGrace, reclaims, lockFile })
    }
  }
  // 落到这里说明锁被别人占着，走读锁判断
  const holder = readLock(file)
  if (!holder) {
    // 两种可能，必须分开处理，否则会把"锁刚被释放"误判成"锁读不出"：
    //   (a) 文件已不存在 → 持有者刚释放，锁其实是空的 → **重试获取**
    //   (b) 文件在但内容坏 → 真的需要人工确认
    if (!existsSync(file)) {
      const depth = (attempt ?? 0) + 1
      if (depth <= 3) return acquireWrite(vaultDir, { ttlMs, host, attempt: depth, waitMs, staleGrace, reclaims, lockFile })
      return { ok: false, reason: 'contended', note: '连续 3 次都在读锁前被释放，按竞争失败处理' }
    }
    const second = readLock(file)
    if (!second) {
      if (!existsSync(file)) {
        const depth = (attempt ?? 0) + 1
        if (depth <= 3) return acquireWrite(vaultDir, { ttlMs, host, attempt: depth, waitMs, staleGrace, reclaims, lockFile })
      }
      return { ok: false, reason: 'unreadable-lock', note: '锁文件存在但读不出，需人工确认' }
    }
    return judgeHolder(second, { vaultDir, ttlMs, host, file, waitMs, staleGrace, attempt, reclaims, lockFile })
  }
  return judgeHolder(holder, { vaultDir, ttlMs, host, file, waitMs, staleGrace, attempt, reclaims, lockFile })
}

/**
 * 对一个已读出的 holder 判定：能回收就回收，否则明确拒绝。
 * 抽成函数是为了让"重试一次"和"常规路径"共用同一套判定，避免两处逻辑漂移。
 *
 * 【D146a/b】两条回收路径，原来都没有：
 *  - 同机 + 持有者进程确实不在 → 立刻回收（这是原来唯一一条，但因 host 口径不等从来没生效过）。
 *  - 任意 host + 锁龄 > ttlMs * staleGrace（默认 2 倍）→ 按租约彻底作废回收，并留 receipt。
 *    commit 是毫秒级操作；4 分钟还没释放只可能是尸体。宁可回收（有 receipt 可追）也不要
 *    让整个核心仓永久只读 —— 这也是 `expired-but-alive-or-unknown-host` 这个 reason
 *    在真机上只增不减的原因。
 *
 * 注意 `reclaims` 与 `attempt` 是**两个独立计数**，不能合并：`attempt` 是 waitMs 退避
 * 走过的步数（抢不到锁就涨，几十毫秒内能涨到 10+），`reclaims` 才是「回收尸体锁」的次数。
 * 第一版把两者混用，结果 60ms 退避预算跑完后 reclaims 早已 > 5，正常回收被误判成死循环。
 */
function judgeHolder(holder, { vaultDir, ttlMs, host, file, waitMs = 0, staleGrace = 2, attempt = 0, reclaims = 0, lockFile = LOCK_FILE }) {
  const age = Date.now() - (holder.at ?? 0)
  const ttl = holder.ttlMs ?? 120_000
  const expired = age > ttl
  // 用 hostMatches 而不是 ===：跨 OS 共享核心仓时一侧是 `'<HOST>'`、另一侧 process.env.COMPUTERNAME
  // 根本不存在（退成 os.hostname() 的 `'<host>'`），字符串直接比永远不等 → 死锁永不被回收。
  const sameHost = hostMatches(holder.host, host)
  // 同机 + 持有者进程已不在 = 一定是尸体，**与 TTL 无关**：进程死了不会自己删锁文件。
  // 原来把这条判据挂在 `expired &&` 后面，于是死进程留下的锁要白等满 120 秒，
  // 这 120 秒里每一次 commit 都直接返回 {ok:false,reason:'held'}。
  const deadOwner = sameHost && !pidAlive(holder.pid)
  // 跨机（真·另一台机器）没法判活 → 只能靠租约：锁龄超过 N×TTL 视为尸体，带 receipt 回收。
  const leaseVoid = expired && age > ttl * Math.max(1, staleGrace)
  if (deadOwner || leaseVoid) {
    // 防死循环：回收后重抢如果又落到尸体锁（别的进程不停重建同一具），
    // 不能无限递归 —— 交回失败让上层看见，而不是把进程卡死在这里。
    if (reclaims >= 5) {
      return { ok: false, reason: 'reclaim-loop', holder, ageMs: age, note: `连续 ${reclaims} 次回收后仍抢不到，疑似有进程在重建同一具尸体锁` }
    }
    try { unlinkSync(file) } catch { /* 别人先回收了 */ }
    const again = acquireWrite(vaultDir, { ttlMs, host, attempt, waitMs, staleGrace, reclaims: reclaims + 1, lockFile })
    if (again.ok) {
      again.reclaimed = {
        via: deadOwner ? 'same-host-dead-pid' : 'lease-void',
        holder,
        ageMs: age,
        expired,
        note: deadOwner
          ? `同机持有者进程 ${holder.pid} 已不在，回收锁（锁龄 ${age}ms，TTL ${ttl}ms）`
          : `锁龄 ${age}ms 超过 ${staleGrace}×TTL，按租约作废回收（持有者主机 ${holder.host ?? '?'} 无法判活）`,
      }
    }
    return again
  }
  return {
    ok: false,
    reason: expired ? 'expired-but-alive-or-unknown-host' : 'held',
    holder,
    ageMs: age,
    note: expired && !sameHost ? '跨机锁无法确认持有者存活，按 TTL 判定但需人工确认' : undefined,
  }
}

export function releaseWrite(file, fence) {
  const holder = readLock(file)
  if (!holder) return { released: false, reason: 'missing' }
  if (holder.fence !== fence) return { released: false, reason: 'fence-mismatch', holder }
  try { unlinkSync(file); return { released: true } } catch (e) { return { released: false, reason: String(e.message) } }
}

/** 只读探测：给第二实例显示"谁占着"。 */
export function inspectLock(vaultDir) {
  const file = join(vaultDir, LOCK_FILE)
  if (!existsSync(file)) return { held: false }
  const holder = readLock(file)
  if (!holder) return { held: true, reason: 'unreadable' }
  return { held: true, holder, ageMs: Date.now() - (holder.at ?? 0), stale: Date.now() - (holder.at ?? 0) > (holder.ttlMs ?? 120_000) }
}
