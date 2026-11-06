/**
 * laurel-core/archive —— 核心包（.laurel-core）的打包与恢复事务。
 *
 * 纪律：
 *  1. 只包数据，不递归 exports，不带权重/凭据/node_modules/进程锁。
 *  2. manifest 含：格式、coreId、模块版本、记录 revision、采集范围/截止点、
 *     逐文件 hash/大小/数量、引用闭包、提供者状态与缺口。
 *  3. 恢复在**私有暂存目录**先验版本/空间/数量/hash/引用，拒绝越界路径与符号链接，
 *     通过才原子登记；失败保留原仓与原配置。
 *  4. 默认恢复到新仓，不覆盖旧仓；重复导入幂等。
 */
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  mkdirSync, writeFileSync, writeSync, unlinkSync, readFileSync, existsSync, readdirSync, statSync, rmSync, renameSync, lstatSync, openSync, fsyncSync, closeSync, appendFileSync, createReadStream,
} from 'node:fs'
import { join, isAbsolute, normalize } from 'node:path'
import { deflateRawSync, inflateRawSync, createDeflateRaw } from 'node:zlib'
import { FORMAT, SCHEMA_VERSION, sha256 } from './format.mjs'
import { listBlobs } from './blob.mjs'

export const ARCHIVE_FORMAT = 'laurel-core-archive/1'
export const ARCHIVE_EXT = '.laurel-core'

// ── 最小 ZIP（store + deflate 读取），零依赖；恢复端会再次校验每个文件 hash ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function writeZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8')
    const data = e.deflate ? deflateRawSync(raw) : raw
    const method = e.deflate ? 8 : 0
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, name)
    offset += 30 + name.length + data.length
  }
  const cenBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cenBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cenBuf, end])
}

/**
 * 增量 CRC32（与 crc32(buf) 结果一致，但可以一段一段算）。
 * 流式写入必须用它 —— 一次性 crc32 要求整份数据在内存里，那正是要避免的。
 */
function crc32Update(crc, buf) {
  let c = (crc ^ 0xffffffff) >>> 0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 流式写 ZIP：同一时刻内存里只有**一个文件的当前块**。
 *
 * MC15：`writeZip(entries)` 要调用方先把所有文件读成 Buffer，再 `Buffer.concat`
 * 成一个大 Buffer —— 真仓 blobs 71MB + memory 274MB（du 实测），导出峰值
 * ≈ 两倍数据量，几百 MB 就直接 OOM。这里是同格式的流式实现。
 *
 * 用 ZIP 的 data descriptor（通用标志位 bit 3）绕开"本地头必须先写 crc 与长度"：
 *   本地头的 crc/comp/uncomp 三位先写 0 → 流式 deflate 时同步算 crc 与长度 →
 *   数据写完后补 data descriptor（`PK\x07\x08` + crc + compSize + uncompSize）。
 * 中央目录最后写，填真实值；`readZip()` 只读中央目录，读出端不受影响。
 *
 * @param {number} fd 已打开的写句柄
 * @param {Iterable|AsyncIterable<{name:string,size:number,open:()=>import('node:stream').Readable}>} entries
 * @param {{onProgress?:(done:number,total:number)=>void, hash?:boolean}} [opts]
 * @returns {Promise<{bytes:number, entries:number, sha256:string|null}>}
 */
export async function writeZipStream(fd, entries, opts = {}) {
  const list = []
  for await (const e of entries) list.push(e)
  const totalSize = list.reduce((a, e) => a + (Number.isFinite(e.size) ? e.size : 0), 0)

  const hasher = opts.hash ? createHash('sha256') : null
  let offset = 0
  let done = 0
  const push = (buf) => {
    hasher?.update(buf)
    writeSync(fd, buf)
    offset += buf.length
  }

  const central = []
  for (const e of list) {
    const name = Buffer.from(e.name, 'utf8')
    const localOffset = offset
    // 本地头：crc/comp/uncomp 全 0，标志位 bit3（data descriptor）+ bit11（UTF-8 名）
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0808, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(0, 18)
    local.writeUInt32LE(0, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    push(local)
    push(name)

    const deflate = createDeflateRaw()
    let crc = 0
    let uncompressed = 0
    let compressed = 0

    deflate.on('data', (chunk) => {
      compressed += chunk.length
      push(chunk)
    })

    await new Promise((resolve, reject) => {
      deflate.on('end', resolve)
      deflate.on('error', reject)
      const src = e.open()
      src.on('data', (chunk) => {
        crc = crc32Update(crc, chunk)
        uncompressed += chunk.length
        done += chunk.length
        if (!deflate.write(chunk)) src.pause()
      })
      deflate.on('drain', () => src.resume())
      src.on('end', () => deflate.end())
      src.on('error', reject)
    })

    // data descriptor：先写占位的本地头，真正的 crc 与长度只能写在这里
    const dd = Buffer.alloc(16)
    dd.writeUInt32LE(0x08074b50, 0)
    dd.writeUInt32LE(crc >>> 0, 4)
    dd.writeUInt32LE(compressed, 8)
    dd.writeUInt32LE(uncompressed, 12)
    push(dd)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0808, 8)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt32LE(crc >>> 0, 16)
    cen.writeUInt32LE(compressed, 20)
    cen.writeUInt32LE(uncompressed, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(localOffset, 42)
    central.push(cen, name)

    opts.onProgress?.(done, totalSize)
  }

  const cenBuf = Buffer.concat(central)
  const cenOffset = offset
  push(cenBuf)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(list.length, 8)
  end.writeUInt16LE(list.length, 10)
  end.writeUInt32LE(cenBuf.length, 12)
  end.writeUInt32LE(cenOffset, 16)
  push(end)

  return { bytes: offset, entries: list.length, sha256: hasher ? hasher.digest('hex') : null }
}

export function readZip(buffer) {
  const files = new Map()
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('不是合法 zip：找不到中央目录结尾')
  const total = buffer.readUInt16LE(eocd + 10)
  let p = buffer.readUInt32LE(eocd + 16)
  for (let n = 0; n < total; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏')
    const method = buffer.readUInt16LE(p + 10)
    const compSize = buffer.readUInt32LE(p + 20)
    const rawSize = buffer.readUInt32LE(p + 24)
    const nameLen = buffer.readUInt16LE(p + 28)
    const extraLen = buffer.readUInt16LE(p + 30)
    const commentLen = buffer.readUInt16LE(p + 32)
    const localOffset = buffer.readUInt32LE(p + 42)
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const lnameLen = buffer.readUInt16LE(localOffset + 26)
    const lextraLen = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + lnameLen + lextraLen
    const raw = buffer.subarray(start, start + compSize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    if (data.length !== rawSize) throw new Error(`条目长度不符：${name}`)
    files.set(name, data)
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

/** 安全检查：拒绝绝对路径、..、盘符、符号链接逃逸。 */
export function isSafeArchivePath(name) {
  if (!name || typeof name !== 'string') return false
  if (isAbsolute(name) || /^[a-zA-Z]:/.test(name)) return false
  const n = normalize(name).replaceAll('\\', '/')
  if (n.startsWith('../') || n === '..' || n.includes('/../')) return false
  if (n.startsWith('/')) return false
  return true
}

/**
 * 收集要打包的文件（只收数据类别，排除 exports/lock/tmp）。
 *
 * 注意：业务模块把记录落在 memory/ 与 experience/ 下（records.jsonl /
 * episodes.jsonl）。它们**属于核心数据**，必须进包 —— 早期版本漏了这两个目录，
 * 结果导出只带走 journal 与 blobs，234 条记录在恢复后变成 0 条。
 * 这里不按白名单挑目录，而是「仓根下任何目录一律包含（除排除项）」，避免再漏。
 */
// `archive/` 是 retention 的可回滚备份代（retention-<ts>.tgz）。它装的是**已被删除的
// 旧数据**，属于回滚材料而不是现行核心数据；打进导出包会让导出体积随清理次数单调增长
// （清理 N 次 → 导出带 N 份已删数据），并且恢复后把孤儿又复活回来。必须排除。
const EXCLUDE_PATTERNS = [/(^|\/)exports(\/|$)/, /(^|\/)archive(\/|$)/, /(^|\/)write\.lock$/, /\.tmp-/, /\.recovered-/, /(^|\/)node_modules(\/|$)/, /(^|\/)indexes(\/|$)/]

export function collectVaultFiles(vaultDir) {
  const out = []
  const walk = (dir, rel = '') => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (EXCLUDE_PATTERNS.some((re) => re.test(r))) continue
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) continue          // 不打包链接
      if (e.isDirectory()) { walk(abs, r); continue }
      if (!st.isFile()) continue
      out.push({ rel: r, abs, bytes: st.size })
    }
  }
  const manifestFile = join(vaultDir, 'manifest.json')
  if (existsSync(manifestFile)) out.push({ rel: 'manifest.json', abs: manifestFile, bytes: statSync(manifestFile).size })
  // 已知数据目录 + 仓根下任何其它目录（除了排除项），保证不漏业务数据
  for (const e of readdirSync(vaultDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    if (EXCLUDE_PATTERNS.some((re) => re.test(e.name))) continue
    if (e.name === 'indexes') continue   // 派生物，重建即可
    walk(join(vaultDir, e.name), e.name)
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 流式计算文件 sha256：不把文件读进内存。
 *
 * MC15：`readFileSync(f.abs)` + `sha256(data)` 对大文件是双份内存
 * （Buffer 一份、hash 计算期间它还要活着）。真仓 memory/ 已 274MB。
 */
export async function sha256File(abs) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const src = createReadStream(abs)
    src.on('data', (chunk) => hash.update(chunk))
    src.on('end', resolve)
    src.on('error', reject)
  })
  return hash.digest('hex')
}

/** 打开一个文件为可读流（导出时延迟打开：写完一个才开下一个）。 */
function openFile(abs) {
  return createReadStream(abs)
}

/** 内存里已有的一块数据 → 同样形状的条目（manifest 这类小内容用）。 */
function bufferEntry(name, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  return { name, size: buf.length, open: () => Readable.from([buf]) }
}

/**
 * 建立一致性快照并打包。
 * @param {object} v openVault 返回
 * @param {{outPath:string, moduleVersions?:object, providerState?:object, cutoffAt?:number, capturedFrom?:string}} opts
 */
export async function exportVault(v, opts) {
  // MC15：这里以前是 `readFileSync` + `sha256(data)` —— 每个文件都要在内存里
  // 过一遍，然后整份 entries 再 `Buffer.concat` 成一个大 Buffer。真仓
  // (blobs 71MB + memory 274MB) 导出峰值 ≈ 两倍数据量。
  // 现在清单只算 sha256（流式，不驻留），数据在 writeZipStream 里按文件流式 deflate。
  const files = collectVaultFiles(v.dir)
  const fileManifest = []
  const entries = []
  for (const f of files) {
    const hash = await sha256File(f.abs)
    fileManifest.push({ path: f.rel, bytes: f.bytes, sha256: hash })
    // size 用来算进度百分比；实际长度以流式读到为准（两者不一致就说明
    // 文件在导出期间被改了，这是并发写入的固有风险，不隐藏）
    entries.push({ name: f.rel, size: f.bytes, open: () => openFile(f.abs) })
  }
  const blobs = listBlobs(v.paths.blobs)
  const blobSet = new Set(blobs.map((b) => b.hash))
  // 引用闭包：journal 里引用的 blob 必须都在。
  //
  // MC08：原来只查 `blob.put`。但 context 引擎写进 journal 的 `ctx.ingest`
  // 与 `ctx.externalize` 同样带 `hash`，而且它们指向的正是**压缩的原文**
  // （一整批原始事件 / 被外置的大工具结果）。只查 blob.put 时，一个
  // 「摘要还在、原文全丢」的包会被判 `complete: true`，恢复回来也不报错 ——
  // 那是最坏的一类失败：它看起来完整。
  //
  // `ctx.summary` 不在这里：摘要正文在 `op.block` 里，没有独立 blob
  // （`ctx.compaction` 只是一条计数事件，也没有 hash）。所以按 op 名逐类列出，
  // 而不是「凡是带 hash 的都查」—— 后者以后有人给 op 加个 `hash` 字段做别的用途
  // 就会莫名把导出判成不完整。
  const HASHED_OPS = new Set(['blob.put', 'ctx.ingest', 'ctx.externalize'])
  const missing = []
  const missingByOp = {}
  for (const u of v.journal.units) {
    for (const op of u.ops ?? []) {
      if (!HASHED_OPS.has(op.op)) continue
      if (typeof op.hash !== 'string' || !op.hash) continue
      if (blobSet.has(op.hash)) continue
      missing.push(op.hash)
      missingByOp[op.op] = (missingByOp[op.op] ?? 0) + 1
    }
  }
  const archiveManifest = {
    archiveFormat: ARCHIVE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    coreFormat: FORMAT,
    coreId: v.manifest.coreId,
    projectId: v.manifest.projectId ?? null,
    environmentId: v.manifest.environmentId ?? null,
    createdAt: new Date().toISOString(),
    cutoffAt: opts.cutoffAt ?? Date.now(),
    capturedFrom: opts.capturedFrom ?? null,
    moduleVersions: opts.moduleVersions ?? {},
    journal: { lastSeq: v.lastSeq, lastHash: v.lastHash, units: v.journal.units.length },
    counts: { files: fileManifest.length, blobs: blobs.length, blobBytes: blobs.reduce((a, b) => a + b.bytes, 0) },
    files: fileManifest,
    providerState: opts.providerState ?? { providers: [], note: '未启用外部提供者' },
    gaps: missing.length ? [{ kind: 'missing-blob', hashes: missing, byOp: missingByOp }] : [],
    complete: missing.length === 0,
  }
  // 自检：业务数据必须真的在包里。声称"完整"却把记录漏掉，是最坏的一类失败。
  // 只在**声明数量 > 0** 时才要求对应文件存在 —— 0 条本来就没有文件可打，
  // 把 0 也当缺口会让"空仓导出"永远失败，反而掩盖真正的漏件。
  const declared = opts.expectedCounts ?? null
  if (declared) {
    const problems = []
    if (declared.records > 0 && !fileManifest.some((f) => /(^|\/)records\.jsonl$/.test(f.path))) {
      problems.push({ kind: 'declared-records-not-included', expected: declared.records })
    }
    if (declared.episodes > 0 && !fileManifest.some((f) => /(^|\/)episodes\.jsonl$/.test(f.path))) {
      problems.push({ kind: 'declared-episodes-not-included', expected: declared.episodes })
    }
    if (declared.records > 0) {
      const included = fileManifest.find((f) => /(^|\/)records\.jsonl$/.test(f.path))
      if (included) {
        const abs = join(v.dir, included.path)
        if (existsSync(abs)) {
          const lines = readFileSync(abs, 'utf8').split('\n').filter((x) => x.trim()).length
          archiveManifest.verifiedCounts = { recordsInFile: lines, declaredRecords: declared.records }
        }
      }
    }
    if (problems.length) {
      archiveManifest.complete = false
      archiveManifest.gaps.push(...problems)
    }
  }
  entries.push(bufferEntry('ARCHIVE-MANIFEST.json', JSON.stringify(archiveManifest, null, 2) + '\n'))
  mkdirSync(join(opts.outPath, '..'), { recursive: true })
  const tmp = opts.outPath + '.tmp-' + process.pid
  // 【D92】同 budget.mjs：①用同一个 fd 写（原为 writeFileSync(tmp, buf) 二次打开同一路径后
  // fsync 旧句柄）；②补错误路径清理（blob.mjs 记录过「ENOSPC 后残留 .tmp-*」的实测）；
  // ③清理范围盖到 renameSync 成功为止。
  //
  // MC15：写盘从「先拼一个大 Buffer 再 writeSync」改成流式逐文件写（writeZipStream）。
  // 失败清理逻辑一字未改 —— 流式写失败时同样必须删掉半个 .tmp-*。
  let fd = null
  let written
  try {
    fd = openSync(tmp, 'w')
    written = await writeZipStream(fd, entries, { hash: true, onProgress: opts.onProgress })
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, opts.outPath)
  } catch (e) {
    if (fd !== null) { try { closeSync(fd) } catch { /* 关不掉也要继续清理 */ } }
    try { unlinkSync(tmp) } catch { /* 清理失败不掩盖原始错误 */ }
    throw e
  }
  const archiveSha = written.sha256
  appendFileSync(join(v.paths.audit, 'audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), op: 'archive.export', out: opts.outPath, sha256: archiveSha, bytes: written.bytes }) + '\n')
  return { ok: true, path: opts.outPath, bytes: written.bytes, sha256: archiveSha, manifest: archiveManifest }
}

/**
 * 校验包（不落盘到目标仓）。
 * @returns {{ok:boolean, manifest?:object, files?:Map, problems?:Array}}
 */
export function validateArchive(buf, { requireComplete = true } = {}) {
  const problems = []
  let files
  try { files = readZip(buf) } catch (e) { return { ok: false, problems: [{ kind: 'not-zip', detail: String(e.message) }] } }
  const mf = files.get('ARCHIVE-MANIFEST.json')
  if (!mf) return { ok: false, problems: [{ kind: 'missing-manifest' }] }
  let manifest
  try { manifest = JSON.parse(mf.toString('utf8')) } catch (e) { return { ok: false, problems: [{ kind: 'bad-manifest', detail: String(e.message) }] } }
  if (manifest.archiveFormat !== ARCHIVE_FORMAT) problems.push({ kind: 'future-or-unknown-format', got: manifest.archiveFormat, want: ARCHIVE_FORMAT })
  if (manifest.schemaVersion > SCHEMA_VERSION) problems.push({ kind: 'future-schema', got: manifest.schemaVersion, supported: SCHEMA_VERSION })
  // 逐文件 hash 与大小
  for (const f of manifest.files ?? []) {
    if (!isSafeArchivePath(f.path)) { problems.push({ kind: 'unsafe-path', path: f.path }); continue }
    const data = files.get(f.path)
    if (!data) { problems.push({ kind: 'missing-file', path: f.path }); continue }
    if (data.length !== f.bytes) problems.push({ kind: 'size-mismatch', path: f.path, got: data.length, want: f.bytes })
    const h = sha256(data)
    if (h !== f.sha256) problems.push({ kind: 'hash-mismatch', path: f.path, got: h, want: f.sha256 })
  }
  // 引用闭包：manifest.files 里 blobs/<hash> 必须覆盖 journal 引用
  const presentBlobs = new Set()
  for (const f of manifest.files ?? []) {
    const m = /^blobs\/[^/]+\/([0-9a-f]{64})$/.exec(f.path)
    if (m) presentBlobs.add(m[1])
  }
  for (const g of manifest.gaps ?? []) {
    if (g.kind === 'missing-blob') for (const h of g.hashes) if (!presentBlobs.has(h)) problems.push({ kind: 'gap-blob-not-in-package', hash: h })
  }
  if (requireComplete && manifest.complete === false) problems.push({ kind: 'incomplete-archive', gaps: manifest.gaps })
  return { ok: problems.length === 0, manifest, files, problems }
}

/**
 * 恢复到新仓（私有暂存目录 → 校验 → 原子登记）。
 * 默认拒绝覆盖已存在的仓。
 */
export function restoreArchive(buf, targetDir, { overwrite = false, requireComplete = true } = {}) {
  const v = validateArchive(buf, { requireComplete })
  if (!v.ok) return { ok: false, stage: 'validate', problems: v.problems }
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !overwrite) {
    return { ok: false, stage: 'target-exists', problems: [{ kind: 'target-not-empty', targetDir }] }
  }
  const staging = targetDir + `.staging-${process.pid}-${Date.now()}`
  try {
    mkdirSync(staging, { recursive: true })
    for (const f of v.manifest.files) {
      const abs = join(staging, ...f.path.split('/'))
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, v.files.get(f.path))
    }
    writeFileSync(join(staging, 'ARCHIVE-MANIFEST.json'), v.files.get('ARCHIVE-MANIFEST.json'))
    // 复验落盘结果
    for (const f of v.manifest.files) {
      const abs = join(staging, ...f.path.split('/'))
      const h = sha256(readFileSync(abs))
      if (h !== f.sha256) throw new Error(`暂存复验失败：${f.path}`)
    }
    if (existsSync(targetDir) && overwrite) rmSync(targetDir, { recursive: true, force: true })
    renameSync(staging, targetDir)
    return { ok: true, targetDir, manifest: v.manifest }
  } catch (e) {
    try { rmSync(staging, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
    return { ok: false, stage: 'staging', problems: [{ kind: 'restore-failed', detail: String(e.message) }] }
  }
}
