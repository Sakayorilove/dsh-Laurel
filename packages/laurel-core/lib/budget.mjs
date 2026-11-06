/**
 * laurel-core/budget —— 持久额度：预占 → 发送 → 按 usage 结算。
 *
 * 纪律：
 *  1. 发送**之前**持久预占（输入估算 + 输出上限），usage 到达再结算差额。
 *  2. 账本不可用 = 零新调用（fail-closed），不是"照常发但事后补记"。
 *  3. 跨进程争最后额度只放行一个（用锁 + 原子读改写）。
 *  4. 缺 usage / 结果未知 → 按预占额度保守记账，不退还。
 *  5. 时区/跨日按显式 zone 计算，不依赖进程本地时区。
 */
import { existsSync, mkdirSync, readFileSync, writeSync, unlinkSync, renameSync, fsyncSync, openSync, closeSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
// MC07：账本读改写必须持跨进程写锁。原先这里连 lock 都没 import，
// 于是头注释第 3 条「跨进程争最后额度只放行一个」是一句空话。
import { acquireWrite } from './lock.mjs'

/** 进程所在系统的 IANA 时区；取不到时退回 UTC。 */
export function systemTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/** 按 IANA 时区取本地日期 YYYY-MM-DD；不传 zone 时用系统时区。 */
export function localDate(at = Date.now(), timeZone = systemTimeZone()) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return fmt.format(new Date(at))
}

export function budgetPaths(vaultDir) {
  const dir = join(vaultDir, 'budgets')
  return { dir, ledger: join(dir, 'ledger.json'), reservations: join(dir, 'reservations.jsonl') }
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) { throw new Error(`预算账本损坏：${e.message}`) }
}

/**
 * 在预算自己的跨进程写锁里跑一段读改写（MC07）。
 *
 * 锁挂在 `budgets/write.lock`（不是 vault 根的 `write.lock`）：后者是
 * `vault.commit()` 的写锁，预算拿着它几毫秒去算个计数器，会让正在提交
 * 记录的那一路收到 `{ok:false, reason:'held'}` 而丢掉一次采集 —— 为了修超发
 * 制造一个丢数据的新故障，不划算。
 *
 * 拿不到锁 = **不放行**（fail-closed），不是「先照常发、事后补记」——
 * 那等于把超发换个名字。holder 一并带回，让人能看见被谁占着。
 *
 * 释放用 fence：`lock.mjs` 的 releaseWrite 在 fence 不符时会拒删并
 * 报 fence-mismatch，说明锁已被回收（主人死了 / TTL 到了），
 * 我们的写入可能被后来者覆盖过 —— 必须留下痕迹，不能当正常完成。
 */
function withLedgerLock(vaultDir, fn) {
  const lockRoot = join(vaultDir, 'budgets')
  const got = acquireWrite(lockRoot, { ttlMs: 10_000 })
  if (got?.ok !== true) {
    return {
      ok: false,
      reason: 'ledger-locked',
      holder: got?.holder ?? null,
      note: '另一个进程正在改预算账本 → 本次零新调用（fail-closed）',
    }
  }
  let out
  try {
    out = fn()
  } finally {
    const rel = got.release()
    if (rel?.released !== true) {
      out = out && typeof out === 'object'
        ? { ...out, lockRelease: rel }
        : { ok: false, reason: 'lock-release-failed', detail: rel }
    }
  }
  return out
}

function writeJsonAtomic(file, value) {
  const tmp = file + `.tmp-${process.pid}-${Date.now()}`
  // 【D92】三件事一起改，它们同源：
  //   ① 原来写的是 `writeFileSync(tmp, buf)` —— 那是**再打开一次同一个路径**写入，
  //      随后 fsyncSync 刷的是最初那个从没写过的句柄。实测在 Linux 上不丢数据
  //      （脏页挂在 inode 上，两个 fd 指向同一 inode，fsync 会一并刷），
  //      但那是依赖实现细节而不是依赖接口语义。改成 writeSync 用同一个 fd。
  //   ② 原来只有 finally{close}，没有 catch：写失败（典型 ENOSPC）时 .tmp-* 留在磁盘上，
  //      每失败一次多一个垃圾文件。blob.mjs 早就修过同一处并留了注释，这两处没跟上。
  //   ③ 清理范围要一路盖到 renameSync 成功为止 —— 只包住 write/fsync 的话，
  //      rename 失败（跨设备、目标被占、权限）同样会漏一个 .tmp 下来。
  let fd = null
  try {
    const buf = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8')
    fd = openSync(tmp, 'w')
    writeSync(fd, buf)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, file)
  } catch (e) {
    if (fd !== null) { try { closeSync(fd) } catch { /* 关不掉也要继续清理 */ } }
    try { unlinkSync(tmp) } catch { /* 清理失败不掩盖原始错误 */ }
    throw e
  }
}

export function defaultLedger(timeZone = systemTimeZone()) {
  return {
    version: 1, timeZone,
    days: {},
    note: 'days[YYYY-MM-DD] = {requests, inputTokens, outputTokens, reserved:{requests,input,output}}',
  }
}

export function loadLedger(vaultDir, timeZone = systemTimeZone()) {
  const p = budgetPaths(vaultDir)
  mkdirSync(p.dir, { recursive: true })
  const ledger = readJson(p.ledger, defaultLedger(timeZone))
  if (ledger.version !== 1) throw new Error(`预算账本版本不支持：${ledger.version}`)
  return ledger
}

function dayOf(ledger, date) {
  if (!ledger.days[date]) ledger.days[date] = { requests: 0, inputTokens: 0, outputTokens: 0, reserved: { requests: 0, input: 0, output: 0 } }
  const d = ledger.days[date]
  d.reserved ??= { requests: 0, input: 0, output: 0 }
  return d
}

/**
 * 预占一次调用。返回 {ok, reservationId} 或 {ok:false, reason}。
 * @param {object} limits {maxRequestsPerDay, maxInputTokensPerDay, maxOutputTokensPerDay}
 */
export function reserve(vaultDir, { limits, estimateInput, maxOutput, timeZone = systemTimeZone(), at = Date.now(), purpose = '' }) {
  const p = budgetPaths(vaultDir)
  mkdirSync(p.dir, { recursive: true })
  // MC07：整段读-判-写都在锁内。把判断放到锁外就等于没锁。
  return withLedgerLock(vaultDir, () =>
    reserveLocked(vaultDir, p, { limits, estimateInput, maxOutput, timeZone, at, purpose }))
}

function reserveLocked(vaultDir, p, { limits, estimateInput, maxOutput, timeZone, at, purpose }) {
  let ledger
  try { ledger = loadLedger(vaultDir, timeZone) } catch (e) {
    return { ok: false, reason: 'ledger-corrupt', error: String(e.message), note: '账本不可用 → 零新调用（fail-closed）' }
  }
  const date = localDate(at, timeZone)
  const d = dayOf(ledger, date)
  const used = d.requests + d.reserved.requests
  const usedIn = d.inputTokens + d.reserved.input
  const usedOut = d.outputTokens + d.reserved.output
  if (limits.maxRequestsPerDay !== undefined && used + 1 > limits.maxRequestsPerDay) {
    return { ok: false, reason: 'request-limit', date, used, limit: limits.maxRequestsPerDay }
  }
  if (limits.maxInputTokensPerDay !== undefined && usedIn + estimateInput > limits.maxInputTokensPerDay) {
    return { ok: false, reason: 'input-limit', date, usedIn, need: estimateInput, limit: limits.maxInputTokensPerDay }
  }
  if (limits.maxOutputTokensPerDay !== undefined && usedOut + maxOutput > limits.maxOutputTokensPerDay) {
    return { ok: false, reason: 'output-limit', date, usedOut, need: maxOutput, limit: limits.maxOutputTokensPerDay }
  }
  d.reserved.requests += 1
  d.reserved.input += estimateInput
  d.reserved.output += maxOutput
  const reservationId = `res-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  writeJsonAtomic(p.ledger, ledger)
  appendFileSync(p.reservations, JSON.stringify({ reservationId, at, date, purpose, estimateInput, maxOutput, state: 'reserved' }) + '\n')
  return { ok: true, reservationId, date, used: used + 1, limits, estimateInput, maxOutput, purpose }
}

/**
 * 结算：usage 到达则按实结算；usage 缺失/结果未知则按预占保守记账。
 * @param {{reservationId:string, estimateInput:number, maxOutput:number, date:string, purpose?:string}} res
 * @param {{inputTokens?:number, outputTokens?:number, unknown?:boolean}} usage
 */
export function settle(vaultDir, res, usage = {}) {
  const p = budgetPaths(vaultDir)
  // MC07：结算同样是读改写（把 reserved 挪到已用），也必须持锁。
  return withLedgerLock(vaultDir, () => settleLocked(vaultDir, p, res, usage))
}

function settleLocked(vaultDir, p, res, usage) {
  const ledger = loadLedger(vaultDir)
  const d = dayOf(ledger, res.date)
  d.reserved.requests = Math.max(0, d.reserved.requests - 1)
  d.reserved.input = Math.max(0, d.reserved.input - res.estimateInput)
  d.reserved.output = Math.max(0, d.reserved.output - res.maxOutput)
  const unknown = usage.unknown === true || usage.inputTokens === undefined || usage.outputTokens === undefined
  const input = unknown ? res.estimateInput : usage.inputTokens
  const output = unknown ? res.maxOutput : usage.outputTokens
  d.requests += 1
  d.inputTokens += input
  d.outputTokens += output
  writeJsonAtomic(p.ledger, ledger)
  appendFileSync(p.reservations, JSON.stringify({
    reservationId: res.reservationId, settledAt: Date.now(), date: res.date, purpose: res.purpose,
    state: unknown ? 'settled-unknown-conservative' : 'settled', input, output,
  }) + '\n')
  return { ok: true, charged: { input, output }, unknown }
}

/** 当日视图（给界面/CLI 看）。 */
export function todayUsage(vaultDir, { timeZone = systemTimeZone(), at = Date.now(), limits } = {}) {
  const ledger = loadLedger(vaultDir, timeZone)
  const date = localDate(at, timeZone)
  const d = ledger.days[date] ?? { requests: 0, inputTokens: 0, outputTokens: 0, reserved: { requests: 0, input: 0, output: 0 } }
  return {
    date, timeZone, limits: limits ?? null,
    used: { requests: d.requests, input: d.inputTokens, output: d.outputTokens },
    reserved: d.reserved,
    remaining: limits ? {
      requests: limits.maxRequestsPerDay === undefined ? null : limits.maxRequestsPerDay - d.requests - d.reserved.requests,
      input: limits.maxInputTokensPerDay === undefined ? null : limits.maxInputTokensPerDay - d.inputTokens - d.reserved.input,
      output: limits.maxOutputTokensPerDay === undefined ? null : limits.maxOutputTokensPerDay - d.outputTokens - d.reserved.output,
    } : null,
  }
}
