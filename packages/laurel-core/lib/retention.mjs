/**
 * laurel-core/retention —— 容量治理（缺陷台账 L11）：策略驱动的清理与轮转。
 *
 * 为什么需要这个模块：仓会一直涨。2026-10-21 实测真仓 97MB（journal 13M / blobs 44M /
 * memory 51M），25,685 条 journal 单元、23,219 个 blob 文件，而全仓**没有任何** pruner /
 * retainer（全仓 grep `rotate|prune|maxBytes|maxAge|retention|gc|tombstone` 只命中
 * guard.mjs 里一个无关的比例变量）。本模块就是缺失的那一层。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 【硬约束】journal 永不删。
 * ═══════════════════════════════════════════════════════════════════
 * journal 是唯一权威变更日志：所有快照、索引、检索侧数据都能从它重建，反过来不行。
 * 因此本模块对 `journal/` 目录**只读不写**：
 *   - collectCandidates() 永不产出位于 journal/ 下的候选；
 *   - executeRun() 在真正动每个文件之前调 assertNotJournal()，命中即抛错终止；
 *   - 轮转（rotate）也只轮转 `archive/` 下的备份代，**从不轮转 journal 本身**；
 *   - tests/retention.test.mjs 里有专门的断言：真跑前后 journal 文件的 sha256 与单元数
 *     必须逐字节一致。任何让 journal 变短/变化的实现都会当场测试变红。
 * 需要缩小 journal 只有一条合法的路：由上层决定后**新建分卷**（journal 目录下追加新
 * 段文件，旧段保留），绝不在本模块里 truncate / rm / rename journal。
 *
 * 安全前提是**引用计数**，不是年龄：
 *   - 只有「journal 里没有任何 op 指向、且 records.jsonl 等派生数据里也没出现过」的
 *     hash 才算孤儿（orphan）；
 *   - 任何在 journal 里出现过的 hash 一律不删，即使它很老；
 *   - records.jsonl / episodes.jsonl 里出现过的 64-hex 一律不删（可能被记录引用但
 *     journal 段已被人工搬走）。
 * 引用计数只会**收窄**可删集，任何策略参数都不能把非孤儿变成可删。年龄参数只能
 * 在孤儿集合内部进一步收窄（maxBlobAgeDays），永远不能反过来扩大。
 *
 * 两种执行模式：
 *   - dryRun（plan）：只读扫描，返回报告，**磁盘一个字节都不动**（不 mkdir、不写 audit）；
 *   - 真跑（apply）：先把全部候选打成 tgz 并**逐文件复验 sha256**，通过后才删原文件；
 *     返回值带 rollbackCommand，按它执行即可把文件数与内容恢复到真跑之前。
 */

import {
  createReadStream, existsSync, readdirSync, statSync, lstatSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync,
} from 'node:fs'
import { createInterface } from 'node:readline'
import { join, relative, sep, dirname, basename, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, gunzipSync } from 'node:zlib'
import { sha256 } from './format.mjs'

export const RETENTION_FORMAT = 'laurel-retention/1'
const HEX64 = /^[0-9a-f]{64}$/
const TOKEN64 = /[0-9a-f]{64}/g
const SHARD = 2

/** 默认策略：保守。孤儿可删（这是本模块存在的理由），非孤儿无论如何都不删。 */
export const DEFAULT_POLICY = Object.freeze({
  // 只对**孤儿** blob 生效；0 = 不限年龄（孤儿即可删）。设为 N 则只删龄 ≥ N 天的孤儿。
  maxBlobAgeDays: 0,
  // 防止「blob 已落盘、对应 journal 单元还没追加」的飞行中写入被误判为孤儿。
  // 60 分钟是安全余量；真仓核对时可显式传 0 看全量孤儿数。
  // 实测依据（2026-10-21 真仓连续 3 次只读扫描）：orphanBlobs = 3 / 4 / 0，全部 ageMinutes=0 ——
  // 宿主会话正在写，blob 先落盘、journal 后追加，这几秒里它长得就像孤儿。若默认值是 0，
  // 就会把正在被写入的正文删掉。这个闸不是洁癖，是真仓上量出来的必需品。
  minOrphanAgeMinutes: 60,
  // snapshots/ 与 exports/ 是派生/备份数据，按「保留最新 N 个文件」收窄；0 = 不清理。
  maxSnapshotCount: 0,
  maxExportCount: 0,
  // archive/ 下 retention-*.tgz 备份代保留个数；0 = 不轮转。
  keepArchiveGenerations: 2,
  // blobs/ 下写入失败残留的 .tmp-* 文件属于垃圾，可清。
  includeTempResidue: true,
  // 备份 tgz 落点。null = 仓内 <vault>/archive/（默认，自包含）；
  // 指定绝对路径则落到仓外（如 .session-scratch/backups/），仓体积才会真正下降。
  backupDir: null,
  dryRun: true,
})

const POLICY_KEYS = new Set(Object.keys(DEFAULT_POLICY))

/** 校验并归一化策略：拼错键名必须报错，不能静默按默认值跑（少一个 key 就是多删一批）。 */
export function normalizePolicy(policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy }
  for (const k of Object.keys(policy)) {
    if (!POLICY_KEYS.has(k)) throw new TypeError(`未知 retention 策略键：${k}（允许：${[...POLICY_KEYS].join(', ')}）`)
  }
  const num = (k, { min = 0, int = false } = {}) => {
    const v = p[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || (int && !Number.isInteger(v))) {
      throw new TypeError(`retention 策略 ${k} 必须是 ≥${min} 的${int ? '整数' : '数字'}，实际: ${JSON.stringify(v)}`)
    }
    return v
  }
  num('maxBlobAgeDays')
  num('minOrphanAgeMinutes')
  num('maxSnapshotCount', { int: true })
  num('maxExportCount', { int: true })
  num('keepArchiveGenerations', { int: true })
  if (typeof p.includeTempResidue !== 'boolean') throw new TypeError('retention 策略 includeTempResidue 必须是布尔')
  if (typeof p.dryRun !== 'boolean') throw new TypeError('retention 策略 dryRun 必须是布尔')
  if (p.backupDir !== null && (typeof p.backupDir !== 'string' || !p.backupDir)) {
    throw new TypeError('retention 策略 backupDir 必须是非空字符串或 null')
  }
  return p
}

// ── 文件系统小工具 ──────────────────────────────────────────────────

function listFilesRecursive(root) {
  const out = []
  if (!existsSync(root)) return out
  const walk = (dir, rel) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      let st
      try { st = lstatSync(abs) } catch { continue }
      // 不跟随符号链接：链接目标可能在仓外，删它就是超出本模块职权
      if (st.isSymbolicLink()) continue
      if (e.isDirectory()) { walk(abs, r); continue }
      if (!st.isFile()) continue
      out.push({ abs, rel: r, bytes: st.size, mtimeMs: st.mtimeMs })
    }
  }
  walk(root, '')
  return out
}

function toPosix(p) {
  return p.split(sep).join('/')
}

function guardError(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

/**
 * journal 保护线。任何要动/要报的路径都必须先过这道闸。
 * 这是硬约束的**执行点**，不是注释里的口号。
 *
 * 大小写也按不敏感处理：真仓在 drvfs（/mnt/c, NTFS）上，`JOURNAL/x` 和
 * `journal/x` 是同一个文件；只比对小写会留一条绕过路径（已实测踩到）。
 */
export function assertNotJournal(absPath, vaultDir) {
  const rel = toPosix(relative(vaultDir, absPath))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw guardError('ERR_RETENTION_OUTSIDE_VAULT', `retention 拒绝仓外路径：${absPath}`)
  }
  const head = rel.split('/')[0].toLowerCase()
  if (head === 'journal' || head === 'journal.v4.jsonl.zstd') {
    throw guardError('ERR_RETENTION_JOURNAL', `retention 硬约束：journal 永不删/不截断/不改写，拒绝触碰 ${rel}`)
  }
  return rel
}

// ── 引用扫描 ────────────────────────────────────────────────────────

function collectHexFromValue(value, into) {
  if (typeof value === 'string') {
    if (HEX64.test(value)) into.add(value)
    return
  }
  if (Array.isArray(value)) { for (const v of value) collectHexFromValue(v, into); return }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) collectHexFromValue(v, into) }
}

async function forEachLine(file, fn) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) { if (line) fn(line) }
  } finally {
    rl.close()
  }
}

/**
 * 全仓引用扫描：算出「活着」的 hash 集合。
 *
 * 来源分三类，全部按「宁可多保护、不可多删」处理：
 *  1. journal/ 下所有 *.jsonl：逐行 JSON.parse，递归收集每个 op 内的 64-hex 字段
 *     （覆盖 blob.put / ctx.ingest / ctx.externalize / ctx.summary / ctx.compaction 等
 *      一切当前或未来的 op 形状，不按 op 名白名单，避免漏掉新 op）。
 *  2. memory/ 与 experience/ 下的 *.jsonl：逐行正则抽 64-hex（records.jsonl /
 *     episodes.jsonl 里出现过的 hash 一律不删）。
 *  3. 其余仓内文本文件（排除 blobs/ 与 archive/）：同样正则抽 64-hex。
 *
 * 返回里带耗时与规模，直接可当「规模成本」的实证数据用。
 */
export async function scanReferences(vaultDir) {
  const t0 = Date.now()
  const live = new Set()
  const journalDir = join(vaultDir, 'journal')
  const stat = {
    journalUnits: 0,
    journalOps: {},
    journalFiles: 0,
    journalBytes: 0,
    recordFiles: 0,
    recordLines: 0,
    recordBytes: 0,
    extraFiles: 0,
    extraBytes: 0,
    liveHashes: 0,
    elapsedMs: 0,
    phases: {},
  }

  // ① journal
  const tJ = Date.now()
  const journalFiles = listFilesRecursive(journalDir)
  for (const f of journalFiles) {
    if (!f.rel.endsWith('.jsonl')) continue
    stat.journalFiles += 1
    stat.journalBytes += f.bytes
    await forEachLine(f.abs, (line) => {
      let unit
      try { unit = JSON.parse(line) } catch {
        // 半行/坏行：不能当成「没引用」。整行按文本抽 64-hex 兜底，宁可多保护。
        for (const m of line.match(TOKEN64) ?? []) live.add(m)
        return
      }
      stat.journalUnits += 1
      const ops = Array.isArray(unit?.ops) ? unit.ops : null
      if (ops === null) {
        // 形状意外（没有 ops 数组的老单元/异形单元）。
        // 这里**绝不能**当成「没引用」——实测一个 `{op:"blob.put",hash}` 形状的单元会让
        // 整个 journal 的 live 集合变成 0，接着把全部活 blob 判成孤儿。宁可多保护：
        // 整个单元按文本抽 64-hex 兜底，并单独计数，让报告能看出「曾走过兜底路径」。
        stat.journalUnitsUnexpectedShape = (stat.journalUnitsUnexpectedShape ?? 0) + 1
        for (const m of line.match(TOKEN64) ?? []) live.add(m)
        return
      }
      for (const op of ops) {
        const name = typeof op?.op === 'string' ? op.op : 'unknown'
        stat.journalOps[name] = (stat.journalOps[name] ?? 0) + 1
        collectHexFromValue(op, live)
      }
      // 单元自身的 hash/prev 不是 blob 引用，故意不收（收了只会污染统计）
    })
  }
  stat.phases.journalMs = Date.now() - tJ

  // ② records / episodes
  const tR = Date.now()
  for (const sub of ['memory', 'experience']) {
    for (const f of listFilesRecursive(join(vaultDir, sub))) {
      if (!f.rel.endsWith('.jsonl')) continue
      stat.recordFiles += 1
      stat.recordBytes += f.bytes
      await forEachLine(f.abs, (line) => {
        stat.recordLines += 1
        for (const m of line.match(TOKEN64) ?? []) live.add(m)
      })
    }
  }
  stat.phases.recordsMs = Date.now() - tR

  // ③ 其余文本文件（审计、索引、providers、context 恢复映射等）
  // 关键性能点：**先在顶层把 blobs/ archive/ 这些大目录排除掉再递归**。
  // 早先的写法是先 listFilesRecursive(vaultDir) 再按首段过滤 —— 等于把 blobs 下
  // 两万多个文件全 stat 一遍才丢弃。在 drvfs（/mnt/c）上实测这一项独占 124s/250s；
  // 换成只进需要的子目录后同一份仓降到 ~1s 量级（见 TASK-F 回传的 MC15 数据）。
  const tE = Date.now()
  const skippedTop = new Set(['blobs', 'archive', 'journal', 'memory', 'experience'])
  const extraFiles = []
  for (const e of readdirSync(vaultDir, { withFileTypes: true })) {
    if (skippedTop.has(e.name)) continue
    if (e.isDirectory()) { for (const f of listFilesRecursive(join(vaultDir, e.name))) extraFiles.push(f) }
    else if (e.isFile()) {
      try {
        const st = lstatSync(join(vaultDir, e.name))
        if (!st.isSymbolicLink()) extraFiles.push({ abs: join(vaultDir, e.name), rel: e.name, bytes: st.size, mtimeMs: st.mtimeMs })
      } catch { /* 读不到就当不存在 */ }
    }
  }
  for (const f of extraFiles) {
    if (f.bytes > 32 * 1024 * 1024) continue
    if (!/\.(json|jsonl|txt|md|csv|log)$/i.test(f.rel)) continue
    stat.extraFiles += 1
    stat.extraBytes += f.bytes
    let text
    try { text = readFileSync(f.abs, 'utf8') } catch { continue }
    for (const m of text.match(TOKEN64) ?? []) live.add(m)
  }
  stat.phases.extraMs = Date.now() - tE

  stat.liveHashes = live.size
  stat.elapsedMs = Date.now() - t0
  return { live, stat }
}

// ── 候选收集 ────────────────────────────────────────────────────────

function ageDays(mtimeMs, now) {
  return (now - mtimeMs) / 86_400_000
}

/**
 * 收集可清理候选。**只报不删**，由 executeRun 决定要不要落地。
 * @returns {{candidates:Array, notes:Array, orphans:number, blobTotal:number}}
 */
export function collectCandidates(vaultDir, policy, live, clock = Date.now) {
  const now = clock()
  const candidates = []
  const notes = []
  let blobTotal = 0
  let orphanCount = 0

  // ① blobs：孤儿 + 写入失败残留
  // 注意 path 必须是**相对仓根**的路径（`blobs/<shard>/<hash>`），不是相对 blobs/：
  // rollback 靠这个路径把文件放回原位，写成 `c3/<hash>` 会还原到仓根下去（真实踩过）。
  //
  // 性能：drvfs（/mnt/c）上 lstat 一次约 5ms，两万多个 blob 逐个 stat 就是两分钟。
  // 但「大小 + mtime」只有**孤儿**和**残留**才用得上，活 blob 一个字段都不需要。
  // 所以这里先只 readdir 取名字（Dirent 自带类型，不 stat），过滤出候选再逐个 stat。
  const blobRoot = join(vaultDir, 'blobs')
  const blobEntries = []
  if (existsSync(blobRoot)) {
    for (const shard of readdirSync(blobRoot, { withFileTypes: true })) {
      if (!shard.isDirectory()) {
        // blobs/ 根下的散文件也扫，但不当成正常 blob 结构
        blobEntries.push({ abs: join(blobRoot, shard.name), rel: `blobs/${shard.name}`, name: shard.name, isShard: false })
        continue
      }
      const shardAbs = join(blobRoot, shard.name)
      let names
      try { names = readdirSync(shardAbs, { withFileTypes: true }) } catch { continue }
      for (const e of names) {
        if (!e.isFile()) continue      // 目录/符号链接都不跟，删链接会超出本模块职权
        blobEntries.push({ abs: join(shardAbs, e.name), rel: `blobs/${shard.name}/${e.name}`, name: e.name, isShard: true })
      }
    }
  }
  // 只有走到「要报候选」这一步才付出 stat 的代价
  const needStat = []
  for (const f of blobEntries) {
    const isResidue = f.name.startsWith('.tmp-') || /\.tmp-/.test(f.rel)
    if (isResidue) {
      if (policy.includeTempResidue) needStat.push({ f, kind: 'blob-residue', reason: '写入中断残留' })
      continue
    }
    if (!f.isShard || !HEX64.test(f.name)) { notes.push({ kind: 'blob-unrecognized', path: f.rel }); continue }
    blobTotal += 1
    if (live.has(f.name)) continue          // 非孤儿：无论如何不删
    orphanCount += 1
    needStat.push({ f, kind: 'blob-orphan', reason: 'journal 与 records 都没有引用' })
  }
  for (const { f, kind, reason } of needStat) {
    let st
    try { st = lstatSync(f.abs) } catch { notes.push({ kind: 'stat-failed', path: f.rel }); continue }
    if (st.isSymbolicLink() || !st.isFile()) continue
    const a = ageDays(st.mtimeMs, now)
    if (kind === 'blob-orphan') {
      if (policy.minOrphanAgeMinutes > 0 && a * 1440 < policy.minOrphanAgeMinutes) {
        notes.push({ kind: 'orphan-too-fresh', path: f.rel, ageMinutes: Math.round(a * 1440) })
        continue
      }
      if (policy.maxBlobAgeDays > 0 && a < policy.maxBlobAgeDays) {
        notes.push({ kind: 'orphan-not-old-enough', path: f.rel, ageDays: Math.round(a * 10) / 10 })
        continue
      }
    }
    // 最后一道闸：即便判定成孤儿，也不允许是 journal 下的路径
    assertNotJournal(f.abs, vaultDir)
    candidates.push({
      kind,
      path: f.rel,
      abs: f.abs,
      bytes: st.size,
      ...(kind === 'blob-orphan' ? { hash: f.name, ageDays: Math.round(a * 10) / 10 } : {}),
      reason,
    })
  }

  // ② snapshots / exports：按「保留最新 N 个」收窄（派生数据，可重建）
  const trimDir = (sub, keep, kind) => {
    if (keep <= 0) return
    const files = listFilesRecursive(join(vaultDir, sub))
    if (files.length <= keep) return
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const f of files.slice(keep)) {
      assertNotJournal(f.abs, vaultDir)
      candidates.push({ kind, path: toPosix(relative(vaultDir, f.abs)), abs: f.abs, bytes: f.bytes, reason: `超出保留数 ${keep}` })
    }
  }
  trimDir('snapshots', policy.maxSnapshotCount, 'snapshot')
  trimDir('exports', policy.maxExportCount, 'export')

  return { candidates, notes, orphans: orphanCount, blobTotal }
}

// ── 归档代轮转 ──────────────────────────────────────────────────────

const GEN_RE = /^retention-[0-9TZ-]+\.tgz$/

export function listGenerations(archiveDir) {
  if (!existsSync(archiveDir)) return []
  return readdirSync(archiveDir)
    .filter((n) => GEN_RE.test(n))
    .sort()                       // 名字里是定宽 ISO 时间戳 → 字典序即时间序
    .map((n) => ({ name: n, abs: join(archiveDir, n), bytes: statSync(join(archiveDir, n)).size }))
}

// ── 最小 tar（ustar）+ gzip：零依赖，且产物能用系统 tar 手工解开 ──────────

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0'
}

/**
 * ustar 的 name(100) + prefix(155) 装不下时返回 null，由调用方改用 PAX 扩展头。
 * 直接抛错是不行的：真实 blobs 路径 `blobs/<2>/<64>` 只有 73 字节，但备份要能容纳
 * 仓内任意深度的 exports/snapshots 文件，硬失败会让整次 apply 无法完成。
 */
function splitTarPath(name) {
  const bytes = Buffer.byteLength(name)
  if (bytes <= 100) return { name, prefix: '' }
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue
    const prefix = name.slice(0, i)
    const rest = name.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix }
  }
  return null
}

/** PAX 扩展头的载荷：`<len> path=<value>\n`，len 含自身长度字段。 */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  const bodyBytes = Buffer.byteLength(body)
  let len = bodyBytes + String(bodyBytes).length
  while (String(len).length + bodyBytes !== len) len = String(len).length + bodyBytes
  return Buffer.from(String(len) + body, 'utf8')
}

function tarHeader({ name, size, mtime, mode = 0o644, type = '0' }) {
  const h = Buffer.alloc(512)
  const split = splitTarPath(name)
  // 装不下时头里放一个被截断的占位名，真名由紧随其前的 PAX 记录给出（POSIX.1-2001）
  const nm = split ? split.name : name.slice(0, 100)
  const prefix = split ? split.prefix : ''
  h.write(nm, 0, 100, 'utf8')
  h.write(octal(mode, 8), 100, 8, 'latin1')
  h.write(octal(0, 8), 108, 8, 'latin1')
  h.write(octal(0, 8), 116, 8, 'latin1')
  h.write(octal(size, 12), 124, 12, 'latin1')
  h.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'latin1')
  h.write('        ', 148, 8, 'latin1')      // chksum 先填空格
  h.write(type, 156, 1, 'latin1')
  h.write('ustar\0', 257, 6, 'latin1')
  h.write('00', 263, 2, 'latin1')
  if (prefix) h.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1')
  return h
}

/** @param {Array<{name:string, data:Buffer, mtime?:number}>} entries */
export function tarPack(entries) {
  const parts = []
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8')
    const mtime = e.mtime ?? Date.now()
    const split = splitTarPath(e.name)
    if (!split) {
      // PAX 扩展头：type 'x'，载荷里带真实完整路径
      const payload = paxRecord('path', e.name)
      parts.push(tarHeader({ name: 'PaxHeader/' + basename(e.name).slice(0, 80), size: payload.length, mtime, type: 'x' }))
      parts.push(payload)
      const pad0 = (512 - (payload.length % 512)) % 512
      if (pad0) parts.push(Buffer.alloc(pad0))
    }
    parts.push(tarHeader({ name: e.name, size: data.length, mtime }))
    parts.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

/** @returns {Map<string, Buffer>} */
export function tarUnpack(buf) {
  const files = new Map()
  let p = 0
  let paxPath = null
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512)
    if (h.every((b) => b === 0)) break
    const rawName = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(h.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8)
    const type = h.subarray(156, 157).toString('latin1')
    p += 512
    if (type === 'x') {
      // PAX 扩展头：解析出 path= 后用于下一个条目
      const payload = buf.subarray(p, p + size).toString('utf8')
      const m = /(?:^|\n)[0-9]+ path=([^\n]*)\n/.exec(payload)
      paxPath = m ? m[1] : null
      p += Math.ceil(size / 512) * 512
      continue
    }
    const name = paxPath ?? (prefix ? `${prefix}/${rawName}` : rawName)
    paxPath = null
    if (type === '0' || type === '\0' || type === '') {
      files.set(name, Buffer.from(buf.subarray(p, p + size)))
    }
    p += Math.ceil(size / 512) * 512
  }
  return files
}

function writeTgz(file, entries) {
  const tgz = gzipSync(tarPack(entries), { level: 9 })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, tgz)
  return { bytes: tgz.length, sha256: sha256(tgz) }
}

function readTgz(file) {
  return tarUnpack(gunzipSync(readFileSync(file)))
}

// ── 主流程 ──────────────────────────────────────────────────────────

/**
 * 备份代名：ISO 时间戳把 `:` `.` 换成 `-`，保证字典序 == 时间序（listGenerations 靠这个排序）。
 * 参数是毫秒时间戳而非时钟函数——早期版本写 `clock()` 但调用点不传 clock，直接 TypeError。
 */
function generationName(nowMs = Date.now()) {
  return 'retention-' + new Date(nowMs).toISOString().replace(/[:.]/g, '-')
}

/**
 * 执行一次 retention（dryRun 走同一份计划，只是一个字节都不落盘）。
 *
 * @param {string} vaultDir 核心仓绝对路径
 * @param {object} [policy] 见 DEFAULT_POLICY
 * @returns {Promise<object>} 报告
 */
export async function run(vaultDir, policy = {}) {
  const p = normalizePolicy(policy)
  const t0 = Date.now()
  const { live, stat } = await scanReferences(vaultDir)
  const { candidates, notes, orphans, blobTotal } = collectCandidates(vaultDir, p, live)

  // ── 全局 sanity：一个活 blob 都没扫到，说明扫描本身出问题了（journal 形状变了、
  // 路径给错、编码变了…），而不是「仓里真的一万个孤儿」。这种时候删就是灾难，
  // 所以直接拒绝执行 —— 无论是 dry-run 还是真跑，都报同一个错，让人先去看扫描。
  if (blobTotal > 0 && live.size === 0) {
    const e = new Error(
      `retention 拒绝执行：仓里有 ${blobTotal} 个 blob，但引用扫描得到 0 个活 hash。` +
      `这几乎一定是扫描故障（journal 形状变化/路径错误），不是真有 ${blobTotal} 个孤儿；` +
      `请先跑 \`retention-cli.mjs scan --vault <仓>\` 核对。`,
    )
    e.code = 'ERR_RETENTION_EMPTY_LIVE_SET'
    e.referenceScan = stat
    throw e
  }

  const archiveDir = p.backupDir ? p.backupDir : join(vaultDir, 'archive')
  const reclaimableBytes = candidates.reduce((a, c) => a + c.bytes, 0)
  const byKind = {}
  for (const c of candidates) {
    byKind[c.kind] = byKind[c.kind] ?? { count: 0, bytes: 0 }
    byKind[c.kind].count += 1
    byKind[c.kind].bytes += c.bytes
  }
  const generations = listGenerations(archiveDir)
  // keepArchiveGenerations 指的是「这一轮跑完之后仓里留几个代」，而本轮在有候选时会
  // 再写一个新代，所以老代的可留额度要先扣掉 1。dry-run 用同一套算式，预测才有意义。
  const willWriteGeneration = candidates.length > 0
  const oldBudget = willWriteGeneration ? Math.max(0, p.keepArchiveGenerations - 1) : p.keepArchiveGenerations
  const rotateList = p.keepArchiveGenerations > 0 && generations.length > oldBudget
    ? generations.slice(0, generations.length - oldBudget)
    : []

  const report = {
    ok: true,
    format: RETENTION_FORMAT,
    dryRun: p.dryRun,
    mode: p.dryRun ? 'dry-run' : 'applied',
    vaultDir,
    policy: p,
    candidates: candidates.map(({ kind, path, bytes, reason, hash }) => ({ kind, path, bytes, reason, ...(hash ? { hash } : {}) })),
    candidateCount: candidates.length,
    reclaimableBytes,
    byKind,
    journalUnits: stat.journalUnits,
    orphanBlobs: orphans,
    blobTotal,
    notes,
    referenceScan: stat,
    archive: { dir: archiveDir, generations: generations.map((g) => ({ name: g.name, bytes: g.bytes })), rotate: rotateList.map((g) => g.name), keepArchiveGenerations: p.keepArchiveGenerations },
    elapsedMs: 0,
  }

  if (p.dryRun) {
    // dry-run 报告里也给一条可预演的 rollback 说法，但明确标出「尚未产生任何代」
    report.rollbackCommand = null
    report.note = 'dry-run：磁盘未被修改，未产生备份代，因此没有 rollbackCommand。'
    report.elapsedMs = Date.now() - t0
    return report
  }

  // ── 真跑 ──
  if (candidates.length === 0) {
    report.mode = 'applied-noop'
    report.movedCount = 0
    report.reclaimedBytes = 0
    report.rollbackCommand = null
    report.note = '没有可清理候选，未产生备份代。'
    report.journalUnitsBefore = stat.journalUnits
    report.journalUnitsAfter = (await scanReferences(vaultDir)).stat.journalUnits
    // noop 也要给结论：调用方不该因为「没删东西」就少一个可断言的字段
    report.journalUnchanged = report.journalUnitsBefore === report.journalUnitsAfter
    report.elapsedMs = Date.now() - t0
    return report
  }

  const generation = generationName()
  const tgzPath = join(archiveDir, `${generation}.tgz`)
  const manifest = {
    format: RETENTION_FORMAT,
    generation,
    vaultDir,
    createdAt: new Date().toISOString(),
    policy: p,
    journalUnits: stat.journalUnits,
    entries: candidates.map((c) => ({
      kind: c.kind, path: c.path, bytes: c.bytes, sha256: sha256(readFileSync(c.abs)),
    })),
  }
  const entries = [
    { name: 'MANIFEST.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
    ...candidates.map((c) => ({ name: c.path, data: readFileSync(c.abs), mtime: statSync(c.abs).mtimeMs })),
  ]
  const written = writeTgz(tgzPath, entries)

  // 复验备份：目标文件必须能逐个按 sha256 还原出来，才允许删原文件。
  const back = readTgz(tgzPath)
  const bad = []
  for (const e of manifest.entries) {
    const got = back.get(e.path)
    if (!got) { bad.push({ path: e.path, reason: 'missing-in-backup' }); continue }
    if (sha256(got) !== e.sha256) bad.push({ path: e.path, reason: 'hash-mismatch' })
  }
  if (bad.length) {
    try { unlinkSync(tgzPath) } catch { /* 备份不可信，删掉不掩盖问题 */ }
    throw new Error(`备份复验失败，已中止删除（原文件全部保留）：${JSON.stringify(bad.slice(0, 5))}`)
  }

  // 删原文件（此时备份已复验通过）
  let reclaimed = 0
  let removed = 0
  for (const c of candidates) {
    const rel = assertNotJournal(c.abs, vaultDir)   // 硬约束执行点：journal 在这里也过不去
    try {
      unlinkSync(c.abs)
      reclaimed += c.bytes
      removed += 1
      void rel
    } catch (e) {
      report.notes.push({ kind: 'unlink-failed', path: c.path, detail: String(e.message) })
    }
  }

  // 归档代轮转：只删更老的**备份 tgz**，不碰 journal
  const rotated = []
  let rotatedBytes = 0
  for (const g of rotateList) {
    try {
      const bytes = statSync(g.abs).size
      unlinkSync(g.abs)
      rotated.push(g.name)
      rotatedBytes += bytes
    } catch (e) {
      report.notes.push({ kind: 'rotate-failed', path: g.name, detail: String(e.message) })
    }
  }

  report.archive = {
    dir: archiveDir,
    generation,
    tgz: tgzPath,
    tgzBytes: written.bytes,
    tgzSha256: written.sha256,
    rotated,
    rotatedBytes,
    generations: listGenerations(archiveDir).map((g) => ({ name: g.name, bytes: g.bytes })),
  }
  report.movedCount = removed
  report.reclaimedBytes = reclaimed
  report.journalUnitsBefore = stat.journalUnits
  // 证明 journal 没被这条路径碰过：重扫它的单元数
  report.journalUnitsAfter = (await scanReferences(vaultDir)).stat.journalUnits
  report.journalUnchanged = report.journalUnitsBefore === report.journalUnitsAfter
  report.rollbackCommand = rollbackCommandFor(vaultDir, tgzPath)
  try {
    appendFileSync(join(vaultDir, 'audit', 'audit.jsonl'), JSON.stringify({
      at: new Date().toISOString(), op: 'retention.apply', generation,
      removedFiles: removed, reclaimedBytes: reclaimed, tgz: tgzPath, rotated,
    }) + '\n')
  } catch (e) {
    report.notes.push({ kind: 'audit-failed', detail: String(e.message) })
  }
  report.elapsedMs = Date.now() - t0
  return report
}

/** dryRun 专用包装：只报不改。 */
export async function plan(vaultDir, policy = {}) {
  return run(vaultDir, { ...policy, dryRun: true })
}

/** 真跑包装。 */
export async function apply(vaultDir, policy = {}) {
  return run(vaultDir, { ...policy, dryRun: false })
}

const CLI_PATH = fileURLToPath(new URL('../bin/retention-cli.mjs', import.meta.url))

function shellQuote(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`
}

export function rollbackCommandFor(vaultDir, tgzPath) {
  return `node ${shellQuote(CLI_PATH)} rollback --vault ${shellQuote(vaultDir)} --archive ${shellQuote(tgzPath)}`
}

/**
 * 回滚一代 retention：按 MANIFEST 把文件逐个放回原位并校验 sha256。
 * 幂等：目标已存在且内容一致时跳过。
 */
export async function rollback(vaultDir, tgzPath) {
  if (!existsSync(tgzPath)) return { ok: false, reason: 'archive-missing', tgzPath }
  const files = readTgz(tgzPath)
  const mfRaw = files.get('MANIFEST.json')
  if (!mfRaw) return { ok: false, reason: 'manifest-missing', tgzPath }
  const manifest = JSON.parse(mfRaw.toString('utf8'))
  const restored = []
  const skipped = []
  const problems = []
  for (const e of manifest.entries ?? []) {
    const rel = toPosix(e.path)
    if (rel.split('/')[0] === 'journal') {
      problems.push({ path: rel, reason: 'journal-is-never-restored-or-deleted-by-retention' })
      continue
    }
    const abs = join(vaultDir, ...rel.split('/'))
    if (isAbsolute(rel) || rel.startsWith('..')) { problems.push({ path: rel, reason: 'unsafe-path' }); continue }
    const data = files.get(e.path)
    if (!data) { problems.push({ path: rel, reason: 'missing-in-archive' }); continue }
    if (sha256(data) !== e.sha256) { problems.push({ path: rel, reason: 'hash-mismatch' }); continue }
    if (existsSync(abs)) {
      const cur = sha256(readFileSync(abs))
      if (cur === e.sha256) { skipped.push(rel); continue }
      problems.push({ path: rel, reason: 'target-exists-different' })
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, data)
    restored.push(rel)
  }
  return {
    ok: problems.length === 0,
    tgzPath,
    generation: manifest.generation,
    journalUnitsAtApply: manifest.journalUnits,
    restoredCount: restored.length,
    skippedCount: skipped.length,
    restored,
    skipped,
    problems,
  }
}
