/**
 * laurel-memory/backfill —— 把已经存在的 DSH 会话记录重放进采集管线（一次性回填）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * `lib/index.js` 只是同步订阅 `session/event`。订阅是在会话**中途**生效的，
 * 生效之前已经发生的事件永远不会被投递，于是核心仓永久缺一段历史。
 * 只读审计 `implementation/evidence/journal-audit-20261020.md` 的 P3-15 / P0-2
 * 实测：本会话应采 710 条、实采 120 条，缺的 590 条全部落在订阅生效之前
 * （`missingAfterLastStored=0`，生效之后一条没漏）。补这一段只能靠把落盘的
 * 会话文件读回来重放 —— 就是本文件。它不是实时采集的第二条路，
 * 只是「把同一批事件补投一次」的入口。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *  1. **不另写一套写盘逻辑**：重放一律投给 `createCapture().handleSessionEvent`。
 *     幂等键、正文裁剪、身份不全就不采、旁路不抛，这些保证全部继承，
 *     不在这里复述第二份（复述就会漂移，两个写路径迟早不一致）。
 *  2. **一条坏路不拖垮整批**：单个会话文件解不开就记下路径与原因跳过，
 *     其它会话照常回填；单个事件失败同样只记账不中断。
 *  3. **不碰真实仓**：`dryRun` 全程不 `openVault`（不开 journal、不抢写锁、
 *     不做尾部恢复），而是把「会写什么」在一个临时目录里**真跑一遍**。
 *     这样去重计数也是真的（能看出多少条已经在仓里），而不是估算。
 *  4. 只用 node: 内置模块，不引入新依赖；纯 ESM，与包内风格一致。
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { openVault, readManifest } from '../../laurel-core/lib/vault.mjs'
import { readJournal } from '../../laurel-core/lib/journal.mjs'
import { createCapture, RECORDS_FILE } from './capture.mjs'

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

/** DSH 会话记录的固定文件名（实测 308 个文件全是这个名字，无变体）。 */
export const SESSION_FILE = 'session.v4.jsonl.zstd'

/** zstd 帧头 magic。会话文件是**多个帧顺序拼接**的，靠它切帧。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 找会话时要走的目录深度上限：`<sessions>/<workspace-slug>/<session-id>/文件` 只有两层。 */
const MAX_WALK_DEPTH = 3

/** 只读首帧拿会话头时最多读这么多个字节；首帧平均约 1.7KB，256KB 足够且有界。 */
const HEAD_PEEK_BYTES = 262144

/** 默认会话根。WSL 里 `~/.dsh/sessions` 可能不存在，调用方可以用 --sessions 覆盖。 */
export function defaultSessionsRoot() {
  return join(homedir(), '.dsh', 'sessions')
}

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/* ───────────────────────── 多帧解压 ───────────────────────── */

/**
 * 解多帧 zstd。
 *
 * `zstdDecompressSync` 只解**第一帧**，直接喂整份会话文件会只拿到开头几行
 * （实测 1.3MB 的文件只解出 294 字符）。会话文件是 N 个独立帧首尾相接写的，
 * 所以按 magic 扫描出每帧起点、逐帧解压再拼接。
 *
 * 做法与开发期验证过的会话帧解压脚本一致：
 * `decompressFrames()`（含「坏帧跳过、不毒死整份文件」的行为），但**不 import 它**：
 * 那是开发期工具，不是包源码。
 *
 * 与参考实现唯一的差别：这里额外返回帧数与坏帧数（返回对象而不是字符串）。
 * 回填报告要如实说「解了几帧、坏了几帧」，拿不到这两个数字就只能是猜。
 */
export function decompressFrames(buf) {
  if (!Buffer.isBuffer(buf)) return { text: '', frames: 0, broken: 0 }
  const starts = []
  let at = 0
  for (;;) {
    const i = buf.indexOf(MAGIC, at)
    if (i === -1) break
    starts.push(i)
    at = i + 4 // +4 而不是 +1：避免 magic 前缀重叠时把同一帧算两次
  }
  const parts = []
  let broken = 0
  for (let k = 0; k < starts.length; k += 1) {
    const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    try { parts.push(zstdDecompressSync(slice).toString('utf8')) } catch { broken += 1 }
  }
  return { text: parts.join(''), frames: starts.length, broken }
}

/* ───────────────────────── 解析成「会话 + 事件」 ───────────────────────── */

/**
 * 把解出来的 jsonl 文本解析成 `{ session, events }`。
 *
 * 真实形状（实测，与 capture 期望的略有差异）：
 *   首行  `{type:'session', version:4, id, createdAt, cwd, origin, ...}`
 *         —— **没有 header 对象，cwd 在顶层**；capture 的 `cwdOf()` 读
 *         `session.header.cwd ?? session.cwd`，所以这里包一层 header 兼容两种读法。
 *   其余  `{type, seq, time, data}` —— 原样当事件投给采集器，不做二次加工。
 *
 * 排序：全部事件都带整数 `seq` 时按 seq 升序重放。seq 是宿主的追加序号，
 * 也是幂等键的一半；文件本身是追加写的，通常已有序，排序只是防御
 * （截断/拼接异常时不让重放顺序乱掉）。有任何一个事件缺 seq 就保持原顺序，
 * 因为混排会把「没 seq 的事件」全挤到一端，反而更不像真实发生顺序。
 */
export function parseSessionText(text, { fallbackId = null } = {}) {
  const rows = []
  let badLines = 0
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { badLines += 1; continue }
    if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row)
    else badLines += 1
  }

  let header = null
  const events = []
  let ignoredRows = 0
  for (const row of rows) {
    if (!header && row.type === 'session') { header = row; continue }
    if (typeof row.type === 'string') { events.push(row); continue }
    // 既不是会话头也没有 type：不是事件，记账但不塞进管线（塞了只会变成 unknown-author 噪声）
    ignoredRows += 1
  }

  const seqOrdered = events.length > 0 && events.every((e) => Number.isInteger(e.seq))
  if (seqOrdered) events.sort((a, b) => a.seq - b.seq)

  const id = asString(header?.id) ?? fallbackId
  const cwd = asString(header?.cwd)
  return {
    header,
    // id 缺失也照样往下走：采集器会以 `identity:missing-session-id` 落账，
    // 比在这里提前返回更容易看出「到底缺了什么」。
    session: {
      id,
      cwd,
      header: {
        id,
        cwd,
        createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : null,
        origin: asString(header?.origin) ?? null,
        version: header?.version ?? null,
      },
    },
    events,
    badLines,
    ignoredRows,
    seqOrdered,
  }
}

/**
 * 读一个会话文件 → `{ok, session, events, frames, brokenFrames, badLines}`。
 * 解不开不抛：返回 `ok:false` 与原因，让上层记一笔继续下一个。
 */
export function readSessionFile(file, { fallbackId = null } = {}) {
  let buf
  try { buf = readFileSync(file) } catch (e) {
    return { ok: false, file, reason: 'unreadable', detail: e?.message ?? String(e) }
  }
  const { text, frames, broken } = decompressFrames(buf)
  if (frames === 0) {
    return { ok: false, file, bytes: buf.length, reason: 'not-zstd', detail: '文件里没有 zstd 帧（magic 28 b5 2f fd 出现 0 次）' }
  }
  if (!text) {
    return { ok: false, file, bytes: buf.length, frames, brokenFrames: broken, reason: 'all-frames-broken', detail: `${frames} 帧全部解压失败` }
  }
  const parsed = parseSessionText(text, { fallbackId })
  return { ok: true, file, bytes: buf.length, frames, brokenFrames: broken, ...parsed }
}

/* ───────────────────────── 找会话文件 ───────────────────────── */

/**
 * 只读首帧拿会话头，用于按创建时间排序。
 *
 * 为什么不整个解：整个会话根有 308 个文件、合计几百 MB，
 * 为了排序把每个都完整解一遍（还要再解第二遍去回填）代价与收益不成比例。
 * 会话头就是首行、落在第一帧里，读 256KB 足够；读不到就按 mtime 兜底。
 */
function peekCreatedAt(file) {
  let fd = null
  try {
    const size = statSync(file).size
    const want = Math.min(HEAD_PEEK_BYTES, size)
    if (want <= 0) return { createdAt: null }
    const buf = Buffer.alloc(want)
    fd = openSync(file, 'r')
    const read = readSync(fd, buf, 0, want, 0)
    const { text } = decompressFrames(buf.subarray(0, read))
    const firstLine = text.split('\n').find((l) => l.trim())
    if (!firstLine) return { createdAt: null }
    const row = JSON.parse(firstLine)
    return {
      id: asString(row?.id) ?? null,
      createdAt: Number.isFinite(row?.createdAt) ? row.createdAt : null,
    }
  } catch {
    return { createdAt: null, id: null }
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* 已关 */ } }
  }
}

/** 递归收集会话文件（深度有界，跳过读不动的目录）。 */
function walkSessionFiles(root) {
  const files = []
  const walk = (dir, depth) => {
    if (depth > MAX_WALK_DEPTH) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.zstd')) files.push(full)
    }
  }
  walk(root, 0)
  files.sort() // 路径排序先保证确定性，时间排序在上层再做
  return files
}

/**
 * 找会话文件。接受三种入口，覆盖「单个会话目录」与「整个 sessions 根」：
 *   1. 直接给 `.zstd` 文件
 *   2. 给单个会话目录（目录里有 session.v4.jsonl.zstd）
 *   3. 给 sessions 根或某个 workspace-slug 目录（向下最多 3 层找 .zstd）
 *
 * 找不到不返回空成功：`ok:false` + 原因，交给 CLI 报错。
 */
export function discoverSessions(path) {
  const target = resolve(String(path ?? '.'))
  if (!existsSync(target)) return { ok: false, kind: 'missing', path: target, files: [], reason: 'path-missing' }
  let st
  try { st = statSync(target) } catch (e) { return { ok: false, kind: 'unknown', path: target, files: [], reason: `stat:${e?.message ?? e}` } }

  if (st.isFile()) {
    return target.endsWith('.zstd')
      ? { ok: true, kind: 'file', path: target, files: [target] }
      : { ok: false, kind: 'file', path: target, files: [], reason: 'not-a-zstd-file' }
  }

  const direct = join(target, SESSION_FILE)
  if (existsSync(direct)) return { ok: true, kind: 'session-dir', path: target, files: [direct] }

  const files = walkSessionFiles(target)
  if (!files.length) {
    return {
      ok: false, kind: 'root', path: target, files: [],
      reason: 'no-session-files',
      note: `目录里没有 ${SESSION_FILE}（未向更深处继续找时会看到这个）`,
    }
  }
  return { ok: true, kind: 'root', path: target, files }
}

/**
 * 按会话创建时间升序（「按时间顺序重放」的字面要求）；同时间按路径。
 * 读不出 createdAt 的用文件 mtime 兜底 —— 会话文件是追加写的，
 * mtime 至少保证「后结束的会话排在后面」，不会是随机顺序。
 */
function orderByTime(files) {
  const decorated = files.map((file) => {
    const peeked = peekCreatedAt(file)
    let mtime = 0
    try { mtime = statSync(file).mtimeMs } catch { /* 读不到就 0 */ }
    return { file, id: peeked.id ?? file, createdAt: peeked.createdAt, key: peeked.createdAt ?? mtime }
  })
  decorated.sort((a, b) => (a.key - b.key) || String(a.file).localeCompare(String(b.file)))
  return decorated
}

/* ───────────────────────── dry-run 的临时仓 ───────────────────────── */

/**
 * 给 dry-run 造一个「影子仓」：只有 memory/records.jsonl，内容是从真实仓**拷来**的。
 *
 * 为什么不自己数「会采多少条」：那样得把 `handleSessionEvent` 的判定链
 * （shouldCapture → identity → project → 幂等键 → 裁剪）在 backfill 里重写一遍，
 * 两份逻辑迟早漂移，dry-run 报的数就会和真跑的数对不上，比不报更坏。
 * 这里让真正的采集器往临时目录里写：判定链一模一样，去重也查的是真实记录，
 * 只是写下去的东西落在临时目录、跑完删掉。真实仓全程只被 `readManifest` 读了一次。
 */
function makeShadowVault(vaultDir) {
  const dir = mkdtempSync(join(tmpdir(), 'laurel-backfill-dry-'))
  const real = join(vaultDir, RECORDS_FILE)
  let seeded = 0
  try {
    if (existsSync(real)) {
      mkdirSync(join(dir, 'memory'), { recursive: true })
      copyFileSync(real, join(dir, RECORDS_FILE))
      seeded = readFileSync(real, 'utf8').split('\n').filter((l) => l.trim()).length
    }
  } catch { /* 拷不动就当空影子仓：dry-run 会把已在仓里的算成「会采」，报告里 seeded 会显示 0 */ }
  return {
    dir,
    seeded,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉不影响结论 */ } },
  }
}

/* ───────────────────────── 回填主流程 ───────────────────────── */

/**
 * 回填。
 *
 * @param {object} opt
 * @param {string} opt.vaultDir   核心仓目录（真实仓，dry-run 也只读它）
 * @param {string} [opt.sessionsPath] 会话文件/会话目录/sessions 根
 * @param {boolean} [opt.dryRun]  只报会采多少、不写真实仓
 * @param {number} [opt.limit]    最多跑几个会话（排序后取前 N 个）
 * @param {string} [opt.tier]     档位，透传给 createCapture
 * @param {number} [opt.maxBodyChars] 单条正文上限，透传给 createCapture
 * @param {boolean} [opt.summaryOnly] 报告里不带 perSession（会话很多时输出会很长）
 * @returns {object} 报告。**不抛**除「仓本身不是核心仓」「一个会话文件都找不到」
 *   这两种用法级错误之外的东西 —— 数据级的坏路一律记进报告。
 */
export function backfill({
  vaultDir,
  sessionsPath = defaultSessionsRoot(),
  dryRun = false,
  limit = null,
  tier = 'zero',
  maxBodyChars = undefined,
  log = noopLog,
  summaryOnly = false,
  capture: injectedCapture = null,
} = {}) {
  const dir = resolve(String(vaultDir ?? ''))
  // 仓的两种校验都必须先做：不是核心仓就不能回填（否则会往普通目录里写孤儿记录）
  const manifest = readManifest(dir)
  if (!manifest) throw new Error(`不是核心仓（缺 manifest.json）：${dir}`)

  const found = discoverSessions(sessionsPath)
  if (!found.ok) throw new Error(`找不到可回填的会话：${found.path}（${found.reason}）`)

  const ordered = orderByTime(found.files)
  const picked = Number.isFinite(limit) && limit > 0 ? ordered.slice(0, Math.trunc(limit)) : ordered
  const capped = picked.length !== ordered.length

  // ── 采集器与写入目标 ──
  let vault = null
  let shadow = null
  let capture = injectedCapture
  let seqBefore = null
  if (capture) {
    // 注入的采集器（测试用）：什么都不额外准备
    if (!dryRun) { vault = openVault(dir); seqBefore = vault.lastSeq }
  } else if (dryRun) {
    shadow = makeShadowVault(dir)
    // dry-run 也要如实报「现在 journal 停在哪」：用 readJournal 纯读一遍链尾。
    // 它只读文件、不拿写锁、不做尾部恢复，所以不会改动真实仓一个字节。
    try { seqBefore = readJournal(join(dir, 'journal', 'journal.jsonl')).lastSeq } catch { seqBefore = null }
    // 影子仓只给 makeRecord 用的 coreId 与一个「假但成功」的提交函数：
    // seq 单调递增，便于肉眼确认「会写多少条、按什么顺序」。
    let seq = 0
    capture = createCapture({
      vault: { manifest: { coreId: manifest.coreId } },
      vaultDir: shadow.dir,
      tier,
      log,
      ...(Number.isFinite(maxBodyChars) ? { maxBodyChars } : {}),
      commitFn: () => ({ ok: true, seq: ++seq, body: { hash: `dry-${seq}` } }),
    })
  } else {
    vault = openVault(dir)
    seqBefore = vault.lastSeq
    capture = createCapture({
      vault,
      vaultDir: dir,
      tier,
      log,
      ...(Number.isFinite(maxBodyChars) ? { maxBodyChars } : {}),
    })
  }

  const skippedByReason = {}
  const eventsByType = {}
  const problems = []
  const perSession = []
  let eventsRead = 0
  let badLines = 0
  let ignoredRows = 0
  let okCount = 0
  let failedCount = 0
  let brokenFrames = 0

  try {
    for (const entry of picked) {
      const one = readSessionFile(entry.file, { fallbackId: entry.id })
      if (!one.ok) {
        failedCount += 1
        problems.push({ file: entry.file, reason: one.reason, ...(one.detail ? { detail: one.detail } : {}) })
        if (!summaryOnly) perSession.push({ file: entry.file, ok: false, reason: one.reason })
        continue
      }
      okCount += 1
      badLines += one.badLines
      ignoredRows += one.ignoredRows
      brokenFrames += one.brokenFrames ?? 0
      eventsRead += one.events.length
      for (const ev of one.events) {
        const type = typeof ev?.type === 'string' ? ev.type : '(no-type)'
        eventsByType[type] = (eventsByType[type] ?? 0) + 1
      }

      const before = capture.stats()
      for (const ev of one.events) {
        // capture.handleSessionEvent 本身保证不抛；这里再兜一层，
        // 是因为「回填是旁路，任何一条事件失败都不得中断整批」是硬要求，
        // 不能靠被调用方永远守约。
        let res
        try {
          res = capture.handleSessionEvent(one.session, ev)
        } catch (e) {
          res = { ok: false, reason: `threw:${e?.message ?? e}` }
          log.warn(`回填单条事件异常（已跳过，不影响整批）：${e?.message ?? e}`)
        }
        if (res && res.ok && res.duplicate) continue
        if (res && res.ok) continue
        const reason = String(res?.reason ?? 'unknown')
        skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1
      }
      const after = capture.stats()
      if (!summaryOnly) {
        perSession.push({
          file: entry.file,
          id: one.session?.id ?? null,
          ok: true,
          events: one.events.length,
          frames: one.frames,
          badLines: one.badLines,
          createdAt: one.session?.header?.createdAt ?? null,
          stored: after.stored - before.stored,
          duplicates: after.duplicates - before.duplicates,
          skipped: after.skipped - before.skipped,
          failed: after.failed - before.failed,
        })
      }
    }
  } finally {
    if (shadow) shadow.cleanup()
  }

  const stats = capture.stats()
  // dry-run 下 seqAfter 与 before 相同（没写任何东西），这正是要让人看见的：
  // 「会采 N 条」和「journal 一条都没动」必须同时出现在报告里。
  const seqAfter = vault ? vault.lastSeq : seqBefore

  // ── 如实结论 ──
  const notes = []
  let ok = true
  let reason = null
  if (okCount === 0 && failedCount > 0) {
    ok = false
    reason = 'all-sessions-failed'
    notes.push(`全部 ${failedCount} 个会话文件都读不出来，没有可回填的数据。逐条原因见 problems。`)
  } else if (stats.stored === 0 && stats.duplicates === 0) {
    ok = false
    reason = 'no-events-captured'
    notes.push(`读了 ${eventsRead} 条事件，一条都没采到（也没有一条已在仓中）。这不是「成功」，是这批数据里没有可采集的正文；按原因分类见 skippedByReason。`)
  }
  if (stats.stored === 0 && stats.duplicates > 0) {
    notes.push(`本次一条都没新写：${stats.duplicates} 条已在仓中（幂等生效）。如果这不是你预期的，说明之前已经回填过。`)
  }
  if (dryRun) notes.push('dry-run：真实仓只被读了 manifest 与 records，没有开 journal、没有抢写锁、没有写任何记录。上面的 capture 数字来自临时影子仓（跑完已删）。')
  if (capped) notes.push(`按 --limit ${Math.trunc(limit)} 只跑了 ${picked.length}/${ordered.length} 个会话。`)
  if (brokenFrames > 0) notes.push(`有 ${brokenFrames} 个 zstd 帧解压失败并跳过（该会话其余帧照常回填），行数可能少于完整会话。`)
  if (badLines > 0) notes.push(`有 ${badLines} 行 JSON 解析失败（多半是坏帧造成的不完整行），已跳过。`)

  return {
    ok,
    ...(reason ? { reason } : {}),
    dryRun: !!dryRun,
    vault: dir,
    coreId: manifest.coreId,
    sessions: {
      path: found.path,
      kind: found.kind,
      available: ordered.length,
      used: picked.length,
      okCount,
      failedCount,
    },
    events: { read: eventsRead, badLines, ignoredRows },
    capture: {
      seen: stats.seen,
      stored: stats.stored,
      duplicates: stats.duplicates,
      skipped: stats.skipped,
      failed: stats.failed,
    },
    skippedByReason,
    eventsByType,
    journalSeq: { before: seqBefore, after: seqAfter },
    problems,
    notes,
    ...(summaryOnly ? {} : { perSession }),
  }
}
