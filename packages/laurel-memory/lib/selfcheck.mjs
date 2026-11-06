/**
 * laurel-memory/selfcheck —— S8：哨兵。「它现在还活着吗？」
 *
 * ── 这个文件为什么存在（§10.4 的实测）──────────────────────────────────
 * 在 lib/ 全量检索：selfCheck|doctor|health( 命中 **0**。
 * 也就是说这个仓有一套很讲究的机制（采集、抽取、晋升门、注入、容量治理），
 * **但没有任何东西负责回答「它还活着吗」**。retention-plane.mjs 有
 * lastRunAt/nextRunAt/runs/skips —— 那是**单个零件**的自述，不是整体体检。
 *
 * ── 四条纪律（照 echo 的判据抄口径，不抄实现）──────────────────────────
 *  1. **每一项都必须真去读一次**。读配置下结论的体检会全报绿，而那种绿比红更坏：
 *     红会让你去修，绿会让你以为不用修。
 *  2. **四档状态，unmeasured 是一等公民**。「还没建」≠「坏了」。
 *     没有数据可测时如实报 unmeasured，**绝不折算成 ok**
 *     （summarize() 不把 unmeasured 加进 ok，verdict 也不会因为 unmeasured
 *     而变成 healthy —— 见下面的 verdictOf 逻辑）。
 *  3. **两个自检项**（selfcheck / node）。一个体检器必须先能报出
 *     「我自己坏了」——否则它坏了的时候，页面会安静地空着，
 *     而那看起来和「一切正常」一模一样。
 *  4. **跳过 = 那一格永远绿**。所以 selfcheck 项会核对「计划 N 项、
 *     实际产出 N 项」，少一项就自己报 error。
 *
 * ── 快检 / 深检两档（deep）──────────────────────────────────────────────
 *  | | 花多久 | 做什么 |
 *  | 快检 deep:false | 数十毫秒 | **不解 JSON**：按字节数行数、字符串探字段、只解析最后一行 |
 *  | 深检 deep:true  | 秒级（真仓 85MB）| **真解一次**：逐行 JSON.parse、坏行统计、fsync 证明可写 |
 *
 * 起因（echo 的原话）：「十项检查里九项是毫秒级的，只有两项要解那份多帧日志，
 * 而 v1 把那份日志解了两遍 —— 那不是体检慢，是我算重了。」
 * 这里同一份字节只读一次；快检不解 JSON，深检才解。
 *
 * ── 边界（写清楚，免得下一个人以为它是个修复器）────────────────────────
 *  · **只读**：唯一会碰盘的写入是 journal 项的 openSync(file,'a') 试开 ——
 *    **不写一个字节**（文件不存在时创建它，size 保持 0，并如实标 created:true）。
 *  · **不修任何东西**，也不给「建议改什么」（那是人的判断）。
 *  · **永不抛**：体检器自己炸掉时返回一条 selfcheck: error 而不是异常，
 *    否则调用方（CLI / 管理端点）会拿到一个 500，而 500 看起来和「没有体检」一样。
 *  · **不做历史**：只有「现在」，想看趋势得自己存（同 echo）。
 *
 * @module selfcheck
 */

import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** 四档状态。**顺序即严重度**（unmeasured 不在最坏那一头，但它也绝不是 ok）。 */
export const SELFCHECK_STATES = Object.freeze(['ok', 'warn', 'error', 'unmeasured'])

/** 报告格式版本：字段只增不删，加字段就 +1（与仓里其它端点同一纪律）。 */
export const SELFCHECK_VERSION = 1

/** 记录读侧视图。与 capture.mjs 的 appendRecord / cli.mjs 的 RECORDS_FILE 同一路径。 */
export const RECORDS_FILE = 'memory/records.jsonl'
/** 经验面唯一副本。与 projection.mjs 的 EPISODES_FILE 同一路径（这里不 import，
 *  因为哨兵要的是**原始文件真相**（行级），不是 projection 去重后的视图）。 */
export const EPISODES_FILE = 'experience/episodes.jsonl'
/** audit 通道。retention.apply 与 mode.write 会往这里追加。 */
export const AUDIT_FILE = 'audit/audit.jsonl'
/** 运行时模式文件（modelSource/tier/baseUrl）。由 lib/index.js 写。 */
export const MODE_FILE = '.laurel-mode.json'

/**
 * 计划产出的检查项 id。**这是契约**：selfcheck 项拿它核对实际产出数，
 * 少一项就自己报 error（「跳过 = 那一格永远绿」）。
 */
export const SELFCHECK_ITEM_IDS = Object.freeze([
  'manifest',
  'journal',
  'records',
  'episodes',
  'usedAt',
  'inject',
  'retention',
  'selfcheck',
  'node',
])

const noopLog = { info() {}, warn() {}, error() {}, debug() {} }

const PKG_ROOT = resolve(import.meta.dirname, '..')

// ── 小工具（都永不抛）────────────────────────────────────────────────

function safeStat(file) {
  try {
    const st = statSync(file)
    return { ok: true, exists: true, size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() }
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, exists: false, size: 0, mtimeMs: null, isFile: false }
    return { ok: false, exists: false, size: 0, mtimeMs: null, isFile: false, error: String(e?.message ?? e), code: e?.code ?? null }
  }
}

/** 取一行里 prefix 之后的字符串值（值里不含转义引号 —— records 的 id/state 满足）。 */
function fieldOf(line, prefix) {
  const at = line.indexOf(prefix)
  if (at < 0) return null
  const start = at + prefix.length
  const end = line.indexOf('"', start)
  return end < 0 ? null : line.slice(start, end)
}

/** 一条记录/经验的「时间」。认 createdAt / at / updatedAt，只认有限数字（毫秒）。 */
function timeOf(row) {
  for (const key of ['createdAt', 'at', 'updatedAt']) {
    const v = row?.[key]
    if (Number.isFinite(v)) return { ms: v, key }
  }
  return { ms: null, key: null }
}

function isoOf(ms) {
  if (!Number.isFinite(ms)) return null
  try { return new Date(ms).toISOString() } catch { return null }
}

/**
 * 读一个 jsonl 文件。
 *  · parse:false（快检）只按字节切行、数行数、抽最后一条能解析的行；
 *  · parse:true（深检）逐行 JSON.parse，顺带数坏行。
 * 读失败**不抛**：返回 { ok:false } 由调用方判 error。
 *
 * ── 为什么要有 scanCache 这一层（照 echo 的「一个 cache，17 秒变 9.5 秒」）──
 * records.jsonl 一项要喂两处：`records`（行数/最后一条时间）与 `usedAt`
 * （有多少条非空）。真仓 105MB，读一次 816ms、解析一次 1.2 秒 ——
 * 各读一遍不是「体检慢」，是**我算重了**。同一份字节一次运行里只读一次。
 */
/**
 * 一次运行内的**读缓存**（照 echo 的「一个 cache，17 秒变 9.5 秒」）。
 *
 * records.jsonl 一项要喂两处：records（行数/最后一条时间）与 usedAt（多少条非空）。
 * 真仓实测（/mnt/c 上 105MB）：readFileSync 816ms、split 45ms、逐行 parse 约 1.2s ——
 * 每一项各读一遍不是「体检慢」，是**我算重了**。
 * 所以一次 runSelfCheck 共用这一个 cache：同一份字节只读一次、只解一次。
 *
 * 键是「路径 + 是否解析」：快检与深检对同一文件的结论不同（快检只解最后一行），
 * 混用会让「深检没跑」看起来像「深检跑了」。缓存只在**一次运行**内有效
 * ——每次调 runSelfCheck 都新建，所以不会拿到上一秒的旧结论。
 */
function readCache() {
  const textCache = new Map()
  const scanCache = new Map()
  // 命中/未命中都要能自报：只报「缓存里几个文件」会被误读成「读了几次」——
  // 本仓第一次写这条测试时就把它当读次数用了，然后得出「读了 2 次」的假结论。
  // 按**文件**记真读次数：全局一个 counter 会被「另一个文件也读了一次」混淆，
  // 本仓第一次写这条测试时就撞上了（records 只读一次，总数却是 2，因为 episodes 也读）。
  const readCounts = new Map()
  let textHits = 0
  const text = (file) => {
    if (textCache.has(file)) { textHits += 1; return textCache.get(file) }
    let got
    try { got = { ok: true, text: readFileSync(file, 'utf8') } } catch (e) { got = { ok: false, error: String(e?.message ?? e), code: e?.code ?? null } }
    readCounts.set(file, (readCounts.get(file) ?? 0) + 1)
    textCache.set(file, got)
    return got
  }
  const scan = (file, opts) => {
    const parse = opts?.parse === true
    const key = file + '\u0000' + (parse ? 'parse' : 'lines')
    if (scanCache.has(key)) return scanCache.get(key)
    const out = scanJsonl(file, { parse }, { text })
    scanCache.set(key, out)
    return out
  }
  return {
    text,
    scan,
    /**
     * reads      = 总共真读了几次 readFileSync（所有文件合计）
     * readsOf(f) = 某个文件真读了几次 —— 断言「同一份字节不读第二遍」用它
     * hits       = 有多少次是从缓存拿的
     * files      = 缓存里现在有几个文件
     * scans      = 缓存里现在有几份解析结果
     */
    hits: () => ({
      reads: [...readCounts.values()].reduce((a, b) => a + b, 0),
      readsOf: (file) => readCounts.get(file) ?? 0,
      hits: textHits,
      files: textCache.size,
      scans: scanCache.size,
    }),
  }
}


function scanJsonl(file, { parse = false } = {}, io = null) {
  const st = safeStat(file)
  if (!st.ok) return { ok: false, exists: false, error: st.error, code: st.code, file, bytes: 0, lines: 0, bad: 0, lastRow: null, lastLine: null, rows: null }
  if (!st.exists) return { ok: true, exists: false, file, bytes: 0, lines: 0, bad: 0, lastRow: null, lastLine: null, rows: null }
  // 兜底：没注入读缓存时直接读文件（单文件一次，不做缓存）。
  // **不许引用 readCache().text 这种一次性构造** —— 那样每次调用都会新建一份缓存，
  // 等于没有缓存，还会让「共用一份 cache」这件事名存实亡。
  const read = io && typeof io.text === 'function'
    ? io.text
    : (p) => {
      try { return { ok: true, text: readFileSync(p, 'utf8') } } catch (e) { return { ok: false, error: String(e?.message ?? e), code: e?.code ?? null } }
    }
  const got = read(file)
  if (!got.ok) {
    return { ok: false, exists: true, error: got.error, code: got.code ?? null, file, bytes: st.size, lines: 0, bad: 0, lastRow: null, lastLine: null, rows: null }
  }
  const text = got.text
  let lines = 0
  let bad = 0
  let lastRow = null
  let lastLine = null
  const rows = parse ? [] : null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    lines += 1
    lastLine = line
    if (!parse) continue
    let row
    try { row = JSON.parse(line) } catch { bad += 1; continue }
    if (!row || typeof row !== 'object') { bad += 1; continue }
    lastRow = row
    rows.push(row)
  }
  if (!parse) {
    // 快检只解析**最后一条**：报「最后一条时间」必须是真的读出来的，不是数的。
    if (lastLine) {
      try { lastRow = JSON.parse(lastLine) } catch { lastRow = null; bad = 1 }
    }
  }
  return { ok: true, exists: true, file, bytes: st.size, mtimeMs: st.mtimeMs, lines, bad, lastRow, lastLine, rows }
}

/**
 * journal 可追加性探针：openSync(file,'a') 试开再关，**不写内容**。
 * 深检额外 fsync 一次并比对 size —— 只证明「能打开」不够，
 * 打不开 fsync 的 fd 一样是坏的（只读挂载 / 权限只剩 r）。
 */
function probeAppend(file, { deep = false } = {}) {
  const before = safeStat(file)
  let fd = null
  try {
    fd = openSync(file, 'a')
    const st = fstatSync(fd)
    if (deep) {
      fsyncSync(fd)
      const st2 = fstatSync(fd)
      if (st2.size !== st.size) {
        return { ok: false, reason: 'fsync-changed-size', error: '探针前后 size 不一致（' + st.size + ' → ' + st2.size + '）' }
      }
    }
    return { ok: true, created: !before.exists, bytes: st.size, deep }
  } catch (e) {
    return { ok: false, reason: 'append-probe-failed', error: String(e?.message ?? e), code: e?.code ?? null }
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* 关不掉不影响结论 */ } }
  }
}

// ── engines 判定（自己实现，不引依赖）────────────────────────────────

/**
 * 解析一个版本号。**只认数字三元组**，认不出就返回 null ——
 * 调用方据此报 unmeasured，而不是猜「大概满足」。
 */
function parseVersion(text) {
  const m = String(text ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** ^ 的上界（与 npm 语义一致：只对最高非零位封顶）。 */
function caretUpper(base) {
  const [maj, min, pat] = base
  if (maj > 0) return [maj + 1, 0, 0]
  if (min > 0) return [0, min + 1, 0]
  return [0, 0, pat + 1]
}

/**
 * 判版本是否满足一个 engines 区间。
 *
 * 支持：|| 分支、空白分隔的比较器、^ >= <= > < =、裸版本号。
 * **不支持的写法返回 null（不知道）**，绝不默认满足 ——
 * 一个「认不出的范围算通过」的判定，和把 unmeasured 折算成 ok 是同一个毛病。
 *
 * @returns {true|false|null}
 */
export function satisfiesEngines(versionText, rangeText) {
  const version = parseVersion(versionText)
  if (!version) return null
  const range = String(rangeText ?? '').trim()
  if (!range) return null
  let sawUnknown = false
  for (const alt of range.split('||')) {
    const parts = alt.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) { sawUnknown = true; continue }
    let ok = true
    let unknown = false
    for (const part of parts) {
      const m = part.match(/^(\^|>=|<=|>|<|=)?(.+)$/)
      if (!m) { unknown = true; break }
      const op = m[1] ?? '='
      const base = parseVersion(m[2])
      if (!base) { unknown = true; break }
      const c = cmpVersion(version, base)
      if (op === '^') {
        if (c < 0 || cmpVersion(version, caretUpper(base)) >= 0) { ok = false; break }
      } else if (op === '>=') { if (c < 0) { ok = false; break } }
      else if (op === '<=') { if (c > 0) { ok = false; break } }
      else if (op === '>') { if (c <= 0) { ok = false; break } }
      else if (op === '<') { if (c >= 0) { ok = false; break } }
      else if (op === '=') { if (c !== 0) { ok = false; break } }
      else { unknown = true; break }
    }
    if (unknown) { sawUnknown = true; continue }
    if (ok) return true
  }
  return sawUnknown ? null : false
}

// ── 各项检查 ────────────────────────────────────────────────────────
//
// 每一项返回 { id, state, detail, evidence }。
// **evidence 必须指向真的读过的东西**（文件、字节数、mtime、条数），
// 否则事后没人能复核「这条绿是怎么来的」。

function item(id, state, detail, evidence) {
  return { id, state, detail, evidence: evidence ?? null }
}

function checkManifest(ctx) {
  const file = join(ctx.vaultDir, 'manifest.json')
  const st = safeStat(file)
  if (!st.ok) return item('manifest', 'error', 'manifest.json 读不到（' + st.error + '）—— 仓的身份未知，其余各项的结论都不能当权威', { file, error: st.error })
  if (!st.exists) return item('manifest', 'error', 'manifest.json 不存在 —— 这不是核心仓（读侧视图和 journal 都可能对不上）', { file, exists: false })
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return item('manifest', 'error', 'manifest.json 解析失败（' + String(e?.message ?? e) + '）', { file, bytes: st.size })
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.coreId !== 'string') {
    return item('manifest', 'warn', 'manifest.json 能解析但缺 coreId —— 身份不完整，跨仓对齐会靠猜', { file, bytes: st.size })
  }
  return item('manifest', 'ok', '核心仓可读：coreId=' + parsed.coreId, {
    file, bytes: st.size, found: true, coreId: parsed.coreId,
    schemaVersion: parsed.schemaVersion ?? null, format: parsed.format ?? null,
  })
}

function checkJournal(ctx) {
  const file = join(ctx.vaultDir, 'journal', 'journal.jsonl')
  const probe = probeAppend(file, { deep: ctx.deep })
  const st = safeStat(file)
  if (!probe.ok) {
    return item('journal', 'error', 'journal 不可追加（' + probe.error + '）—— 这是权威写入通道，它坏了整仓只读', {
      file, path: file, error: probe.error, code: probe.code, exists: st.exists, bytes: st.size,
      appendProbe: false, mode: ctx.deep ? 'deep' : 'fast',
    })
  }
  const detail = st.exists
    ? 'journal 存在且可追加（' + st.size + ' 字节）'
    : 'journal 尚不存在：已试开并在仓内建了空文件（0 字节），可追加'
  return item('journal', 'ok', detail, {
    file, error: null, code: null, exists: st.exists, bytes: probe.bytes,
    appendProbe: true, created: probe.created === true, mode: ctx.deep ? 'deep' : 'fast',
  })
}

function checkRecords(ctx) {
  const file = join(ctx.vaultDir, RECORDS_FILE)
  const scan = ctx.io.scan(file, { parse: ctx.deep })
  if (!scan.ok) {
    return item('records', 'error', 'records.jsonl 读失败（' + scan.error + '）—— 读失败不是空库', { file, error: scan.error, code: scan.code ?? null })
  }
  if (!scan.exists || scan.lines === 0) {
    // 「还没建」≠「坏了」：这里**必须**是 unmeasured。
    return item('records', 'unmeasured', scan.exists
      ? 'records.jsonl 存在但 0 行 —— 没有数据可测（不是坏了，也绝不是 ok）'
      : 'records.jsonl 不存在 —— 还没有任何记忆被采集，没有数据可测', {
      file, exists: scan.exists, bytes: scan.bytes, lines: 0, reason: 'no-data',
    })
  }
  const t = timeOf(scan.lastRow)
  const bad = scan.bad ?? 0
  const base = {
    file, exists: true, bytes: scan.bytes, lines: scan.lines, badLines: bad,
    lastAt: t.ms, lastAtIso: isoOf(t.ms), lastAtField: t.key, mode: ctx.deep ? 'deep' : 'fast',
  }
  if (bad > 0) {
    return item('records', 'warn', scan.lines + ' 行里有 ' + bad + ' 行解析不了（最后一条 ' + (isoOf(t.ms) ?? '时间未知') + '）—— 坏行被静默跳过会让人对「查过了，没有」产生错误信心', base)
  }
  if (t.ms === null) {
    return item('records', 'warn', scan.lines + ' 条记录里最后一条没有可用的时间字段 —— 「多久没写过」这个数算不出来', base)
  }
  return item('records', 'ok', scan.lines + ' 条记录，最后一条 ' + isoOf(t.ms), base)
}

/**
 * 一个「0 行」的文件是**刚建出来的**还是**被清空/截断的**？
 *
 * 判据只有一条，而且是自明的：同一目录里有没有非空的 `.bak-*` 或轮转副本。
 *   · 没有 —— 说明这个面从来没产出过东西（真仓 `experience/` 到 2026-10-22 都不存在），
 *     报 **unmeasured**（「还没建」≠「坏了」）；
 *   · 有 —— 说明这里**曾经有内容**，现在没了，且没有任何东西会重建它，
 *     报 **error**（「被清空」= 真丢了）。
 *
 * 这条判据不是花招：正文里的「唯一副本」如果不能区分这两种情况，
 * 它就会在一条从没产出过经验的新仓上报红，然后所有人学会忽略那条红。
 */
function emptyFileVerdict(dirOfFile, baseName) {
  let entries = []
  try {
    entries = readdirSync(dirOfFile, { withFileTypes: true })
  } catch {
    return { suspicious: false, backups: [] }
  }
  const backups = []
  for (const ent of entries) {
    if (!ent.isFile()) continue
    if (!ent.name.startsWith(baseName + '.')) continue
    const full = join(dirOfFile, ent.name)
    const st = safeStat(full)
    if (st.ok && st.exists && st.size > 0) backups.push({ name: ent.name, bytes: st.size })
  }
  return { suspicious: backups.length > 0, backups }
}

function checkEpisodes(ctx) {
  const file = join(ctx.vaultDir, EPISODES_FILE)
  const scan = ctx.io.scan(file, { parse: ctx.deep })
  if (!scan.ok) {
    // 它是经验面的**唯一副本**（没有 journal 权威、没有 reconcile），读不到就是真丢了。
    return item('episodes', 'error', 'episodes.jsonl 读失败（' + scan.error + '）—— 经验面没有任何第二份真相', { file, error: scan.error, code: scan.code ?? null })
  }
  if (!scan.exists) {
    return item('episodes', 'error', 'episodes.jsonl 不存在（' + file + '）—— 它是经验面的唯一副本，丢了没有地方能重建', {
      file, exists: false, reason: 'missing-file',
      note: '本项按 error 报：经验面是唯一副本（没有 journal 权威、没有 reconcile），缺文件意味着下一次写入从零开始且无从恢复。'
        + '「从来没有产出过经验」在真仓表现为「文件存在、0 行」——那种情况报 unmeasured，见下一个分支',
    })
  }
  if (scan.lines === 0) {
    const emptied = emptyFileVerdict(dirname(file), 'episodes.jsonl')
    const base = { file, exists: true, bytes: scan.bytes, lines: 0, reason: emptied.suspicious ? 'emptied' : 'no-data', backups: emptied.backups }
    if (emptied.suspicious) {
      return item('episodes', 'error', 'episodes.jsonl 存在但 0 行，而同目录里还有非空备份（' + emptied.backups.map((b) => b.name).join(', ') + '）—— 这个面曾经有内容，现在没了，且没有东西会重建它', base)
    }
    return item('episodes', 'unmeasured', 'episodes.jsonl 存在但 0 行，也没有任何非空备份 —— 还没有任何经验被产出，没有数据可测', base)
  }
  const t = timeOf(scan.lastRow)
  // 状态分布：深检用解析结果，快检用行内字符串探（不解 JSON，与 inject.mjs 同一套前提）
  const byState = Object.create(null)
  const bad = scan.bad ?? 0
  if (ctx.deep) {
    for (const row of scan.rows ?? []) {
      const s = typeof row?.state === 'string' ? row.state : 'unknown'
      byState[s] = (byState[s] ?? 0) + 1
    }
  } else {
    // 快检：只做行内字符串探，不解 JSON（与 inject.mjs 的 NOISE_NEEDLE 同一套前提）。
    // 文本取自同一份 cache —— 上面 scan 已经把它读进来了，这里不再读第二遍。
    const got = ctx.io.text(file)
    if (got.ok) {
      for (const line of got.text.split('\n')) {
        if (!line.trim()) continue
        const s = fieldOf(line, '"state":"') ?? 'unknown'
        byState[s] = (byState[s] ?? 0) + 1
      }
    }
  }
  const base = {
    file, exists: true, bytes: scan.bytes, lines: scan.lines, badLines: bad, byState,
    lastAt: t.ms, lastAtIso: isoOf(t.ms), lastAtField: t.key, mode: ctx.deep ? 'deep' : 'fast',
  }
  if (bad > 0) {
    return item('episodes', 'warn', scan.lines + ' 行里有 ' + bad + ' 行解析不了（状态分布 ' + JSON.stringify(byState) + '）—— 唯一副本上的坏行就是真丢', base)
  }
  return item('episodes', 'ok', scan.lines + ' 条经验，状态 ' + JSON.stringify(byState) + '，最后一条 ' + (isoOf(t.ms) ?? '时间未知'), base)
}

/** usedAt 是否「有值」：null / undefined / 空串都算没有。 */
function hasUsedAt(row) {
  const v = row?.usedAt
  return v !== null && v !== undefined && v !== ''
}

/**
 * 快检口径下 usedAt 的**行内探针**（不解 JSON）。
 *
 * 判据与 inject.mjs 的 NOISE_NEEDLE 同一套：JSON.stringify 把 null 写成
 * \"usedAt\":null，而**正文里**出现同样字样时引号会被转义成 \\\"usedAt\\\"，
 * 于是裸的 \"usedAt\":null 只可能来自字段本身。
 * 代价：只认「字段在且非 null」，认不出「字段在但值被写成了别的空形态」——
 * 所以 fast 的结论会标 method:'line-probe'，要精确就 deep:true。
 */
function usedAtLineProbe(file, readText) {
  const got = readText(file)
  if (!got.ok) return { ok: false, error: got.error }
  const text = got.text
  let lines = 0
  let nullLines = 0
  let present = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    lines += 1
    const hasField = line.includes('"usedAt":')
    if (!hasField) continue
    present += 1
    if (line.includes('"usedAt":null')) nullLines += 1
  }
  return { ok: true, lines, present, nullLines, nonNull: present - nullLines }
}

function checkUsedAt(ctx) {
  const file = join(ctx.vaultDir, RECORDS_FILE)
  const st = safeStat(file)
  if (!st.ok) {
    return item('usedAt', 'error', 'records.jsonl 读失败（' + st.error + '）—— 连带 usedAt 也测不了', { file, error: st.error })
  }
  if (!st.exists || st.size === 0) {
    return item('usedAt', 'unmeasured', '没有记录可测 usedAt（records.jsonl 缺失或 0 行）', { file, lines: 0, reason: 'no-data' })
  }

  if (!ctx.deep) {
    const probe = usedAtLineProbe(file, ctx.io.text)
    if (!probe.ok) return item('usedAt', 'error', 'records.jsonl 读失败（' + probe.error + '）', { file, error: probe.error })
    if (probe.lines === 0) {
      return item('usedAt', 'unmeasured', '没有记录可测 usedAt（records.jsonl 存在但 0 行）', { file, lines: 0, reason: 'no-data' })
    }
    const base = {
      file, lines: probe.lines, considered: probe.lines, nonNull: probe.nonNull,
      fieldPresent: probe.present, sampled: false, method: 'line-probe', mode: 'fast',
      note: '快检按行内字样数（不解 JSON）；要精确到每条请用 deep:true',
    }
    if (probe.present === 0) {
      return item('usedAt', 'warn', 'records.jsonl 的 ' + probe.lines + ' 行里找不到 usedAt 字段 —— 这条记录形状上没有这个字段，等于「目前不存在」', base)
    }
    if (probe.nonNull === 0) {
      // 「没人写的状态文件等于没有状态」：字段在、初始化为 null、全库 0 条有值
      // —— 不是「待补」，是**这个字段目前没有任何写入方**。
      return item('usedAt', 'warn', 'records.jsonl 的 ' + probe.lines + ' 行里 usedAt 全为空 —— 这个字段目前没有任何写入方（不是「待补」，是「目前不存在」）', base)
    }
    return item('usedAt', 'ok', 'records.jsonl 的 ' + probe.lines + ' 行里 ' + probe.nonNull + ' 行的 usedAt 非空', base)
  }

  // 深检：真解一次，逐条判（这也让「字段在但值是空串」这类形状被看见）。
  // 走同一份 cache —— checkRecords 已经解过一遍，这里不重解。
  const scan = ctx.io.scan(file, { parse: true })
  if (!scan.ok) {
    return item('usedAt', 'error', 'records.jsonl 读失败（' + scan.error + '）—— 连带 usedAt 也测不了', { file, error: scan.error })
  }
  if (!scan.exists || scan.lines === 0) {
    return item('usedAt', 'unmeasured', '没有记录可测 usedAt（records.jsonl 缺失或 0 行）', { file, lines: 0, reason: 'no-data' })
  }
  const rows = scan.rows ?? []
  const hits = rows.filter(hasUsedAt)
  const base = {
    file, lines: rows.length, considered: rows.length, nonNull: hits.length,
    fieldPresent: rows.filter((r) => Object.hasOwn(r, 'usedAt')).length,
    sampled: false, method: 'parse', mode: 'deep',
  }
  if (hits.length === 0) {
    return item('usedAt', 'warn', 'records.jsonl 的 ' + rows.length + ' 条记录里 usedAt 全为空 —— 这个字段目前没有任何写入方（不是「待补」，是「目前不存在」）', base)
  }
  return item('usedAt', 'ok', 'records.jsonl 的 ' + rows.length + ' 条记录里 ' + hits.length + ' 条 usedAt 非空', base)
}

function checkInject(ctx) {
  const file = join(ctx.vaultDir, AUDIT_FILE)
  let status = null
  try { status = typeof ctx.injectStatus === 'function' ? ctx.injectStatus() : ctx.injectStatus } catch (e) {
    return item('inject', 'error', '读注入统计时抛错（' + String(e?.message ?? e) + '）', { source: 'injectStatus' })
  }
  if (status && typeof status === 'object') {
    const steps = Number.isFinite(status.steps) ? status.steps : 0
    const injected = Number.isFinite(status.injected) ? status.injected : 0
    const skipped = Number.isFinite(status.skipped) ? status.skipped : 0
    const base = {
      source: 'live-injector', steps, injected, skipped,
      lastReason: status.lastReason ?? null, lastAt: status.lastAt ?? null,
      lastError: status.lastError ?? null, indexSize: status.indexSize ?? null,
    }
    if (steps === 0) {
      return item('inject', 'unmeasured', '注入器在内存里、但还没走过任何一步（steps=0）—— 没有数据可测', base)
    }
    if (status.lastError) {
      return item('inject', 'error', '上一轮注入抛错：' + status.lastError, base)
    }
    if (injected === 0) {
      return item('inject', 'warn', '走过 ' + steps + ' 步、一次都没注入（skipped=' + skipped + '，lastReason=' + (status.lastReason ?? 'null') + '）—— 跑着但不产出，与没接上从外面看完全一样', base)
    }
    return item('inject', 'ok', '走过 ' + steps + ' 步，注入 ' + injected + ' 次、跳过 ' + skipped + ' 次（lastReason=' + (status.lastReason ?? 'null') + '）', base)
  }

  // 进程外（CLI）：注入统计**没有落盘**。这不是错误，是「我不知道」——
  // 唯一能替它说的是 audit 通道里有没有相关回执，而注入本身从不写 audit。
  const st = safeStat(file)
  if (!st.ok || !st.exists) {
    return item('inject', 'unmeasured', '注入统计只存在宿主进程内存里，没有落盘 —— 进程外无法测（不是坏了，是不知道）', {
      source: 'none', auditFile: file, auditExists: st.exists === true, reason: 'not-persisted',
      note: '要给这一项真数字，得让 injector 把 stats 落盘（那是另一件事，不在 S8 范围）',
    })
  }
  const scan = scanJsonl(file, { parse: false })
  const lastRow = scan.lastRow && typeof scan.lastRow === 'object' ? scan.lastRow : null
  return item('inject', 'unmeasured', '注入统计没有落盘；audit 通道里有 ' + scan.lines + ' 条回执'
    + (lastRow?.op ? '（最后一条 op=' + lastRow.op + '）' : '') + '，但注入本身不写 audit —— 仍然不知道注入面活没活', {
    source: 'audit-fallback', auditFile: file, auditLines: scan.lines, auditLastOp: lastRow?.op ?? null, reason: 'not-persisted',
  })
}

function checkRetention(ctx) {
  let status = null
  try { status = typeof ctx.retentionStatus === 'function' ? ctx.retentionStatus() : ctx.retentionStatus } catch (e) {
    return item('retention', 'error', '读容量治理状态时抛错（' + String(e?.message ?? e) + '）', { source: 'retentionStatus' })
  }
  const file = join(ctx.vaultDir, AUDIT_FILE)
  if (status && typeof status === 'object') {
    const base = {
      source: 'live-plane', state: status.state ?? null, enabled: status.enabled ?? null,
      mode: status.mode ?? null, runs: status.runs ?? 0, skips: status.skips ?? 0, errors: status.errors ?? 0,
      lastRunAt: status.lastRunAt ?? null, nextRunAt: status.nextRunAt ?? null,
      lastRunMode: status.lastRunMode ?? null, lastError: status.lastError ?? null,
    }
    if (status.enabled !== true) {
      return item('retention', 'warn', '容量治理未启用（没有核心仓路径，或 config.retention.enabled=false）—— 没有任何东西会去问「这些 blob 还有人引用吗」', base)
    }
    if (!status.lastRunAt) {
      return item('retention', 'unmeasured', '容量治理已排程但一次都没跑过（nextRunAt=' + (status.nextRunAt ?? 'null') + '）—— 没有数据可测', base)
    }
    if (status.lastError) {
      return item('retention', 'error', '上次治理失败：' + status.lastError, base)
    }
    return item('retention', 'ok', '上次 ' + status.lastRunAt + '（模式 ' + (status.lastRunMode ?? 'unknown') + '），下次 ' + (status.nextRunAt ?? '未排程') + '，累计 ' + base.runs + ' 次', base)
  }

  // 进程外：读 audit 回执。retention.apply 真跑会写一条 op:'retention.apply'。
  const scan = scanJsonl(file, { parse: false })
  if (!scan.ok || !scan.exists) {
    return item('retention', 'unmeasured', '容量治理是宿主进程里的定时器，进程外没有它的状态；audit 通道也不存在 —— 不知道它跑没跑过', {
      source: 'none', auditFile: file, auditExists: scan.exists === true, lastRunAt: null, nextRunAt: null, reason: 'not-persisted',
    })
  }
  let lastRunAt = null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    if (line.includes('"retention.apply"')) {
      try { lastRunAt = JSON.parse(line)?.at ?? lastRunAt } catch { /* 坏行跳过：这里只求「有没有跑过」 */ }
    }
  }
  if (!lastRunAt) {
    return item('retention', 'unmeasured', 'audit 里有 ' + scan.lines + ' 条回执但没有一条 retention.apply —— 不知道它跑没跑过（默认模式只 plan、不写 audit）', {
      source: 'audit', auditFile: file, lastRunAt: null, nextRunAt: null, reason: 'no-run-recorded',
    })
  }
  return item('retention', 'ok', 'audit 里最后一次真跑是 ' + lastRunAt + '（进程外看不到 nextRunAt）', {
    source: 'audit', auditFile: file, lastRunAt, nextRunAt: null,
  })
}

/**
 * 自检项之一：**哨兵自己**。
 *
 * 一个体检器必须先能报出「我自己坏了」——否则它坏了的时候，页面会安静地空着，
 * 而那看起来和「一切正常」一模一样。所以这里不写 ok 常量，而是真的核对三件事：
 *  1. 四档状态表没被改坏（改坏 = 别人据它做的判断全错）；
 *  2. 包根与自己这条计划的检查项表读得到（读不到就说明我自己的装载上下文坏了）；
 *  3. **计划 N 项、实际产出 N 项**（少一项 = 那一格永远绿）。
 */
function checkSelfCheck(ctx, producedIds) {
  const problems = []
  if (SELFCHECK_STATES.length !== 4) problems.push('状态表被改成 ' + SELFCHECK_STATES.length + ' 档（应为 4）')
  for (const need of ['ok', 'warn', 'error', 'unmeasured']) {
    if (!SELFCHECK_STATES.includes(need)) problems.push('状态表缺 ' + need)
  }
  const missing = SELFCHECK_ITEM_IDS.filter((id) => !producedIds.includes(id))
  const extra = producedIds.filter((id) => !SELFCHECK_ITEM_IDS.includes(id))
  if (missing.length) problems.push('计划 ' + SELFCHECK_ITEM_IDS.length + ' 项、实际产出 ' + producedIds.length + ' 项，缺：' + missing.join(', '))
  if (extra.length) problems.push('产出了计划外的检查项：' + extra.join(', '))

  let pkg = null
  let pkgError = null
  try { pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) } catch (e) { pkgError = String(e?.message ?? e) }
  if (pkgError) problems.push('读不到自己的 package.json：' + pkgError)

  const evidence = {
    states: SELFCHECK_STATES.slice(),
    itemIds: SELFCHECK_ITEM_IDS.slice(),
    produced: producedIds.length,
    planned: SELFCHECK_ITEM_IDS.length,
    pkgRoot: PKG_ROOT,
    packageJsonReadable: pkgError === null,
    version: pkg?.version ?? null,
    mode: ctx.deep ? 'deep' : 'fast',
    file: import.meta.filename ?? null,
  }
  if (problems.length) {
    return item('selfcheck', 'error', '哨兵自检不通过：' + problems.join('；'), evidence)
  }
  return item('selfcheck', 'ok', '哨兵可执行：' + SELFCHECK_ITEM_IDS.length + ' 项全部产出，状态表 4 档完整，自身 v' + (pkg?.version ?? 'unknown'), evidence)
}

/**
 * 自检项之二：**node 版本**是否满足 engines。
 * 认不出 engines 区间就报 unmeasured —— 「不知道」比「大概满足」诚实。
 */
function checkNode(ctx) {
  const version = ctx.nodeVersion ?? process.versions.node
  let engines = ctx.engines
  let enginesSource = 'provided'
  if (engines === undefined) {
    try { engines = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))?.engines?.node ?? null } catch { engines = null }
    enginesSource = 'package.json'
  }
  const base = { version, engines: engines ?? null, enginesSource }
  if (!engines) {
    return item('node', 'unmeasured', '读不到 engines.node，无法判定 ' + version + ' 是否被支持', base)
  }
  const verdict = satisfiesEngines(version, engines)
  if (verdict === null) {
    return item('node', 'unmeasured', 'engines 区间 ' + JSON.stringify(engines) + ' 用了本判定器不认识的写法 —— 不知道 ' + version + ' 算不算满足', base)
  }
  if (verdict === true) {
    return item('node', 'ok', 'node ' + version + ' 满足 engines.node=' + engines, base)
  }
  return item('node', 'error', 'node ' + version + ' **不满足** engines.node=' + engines + ' —— 本仓的写入路径依赖它的语义，跑起来可能静默出错', base)
}

// ── 汇总 ────────────────────────────────────────────────────────────

/**
 * 汇总。
 *
 * **unmeasured 绝不进 ok**。这不是「算一下计数」的细节，是这一整个模块的存在理由：
 * 把「没数据可测」折成「通过」，等于用一次漂亮的 9/9 盖住一个 9/10。
 *
 * verdict 同理：只要有 unmeasured，就**不是** healthy。
 *   · error > 0            → 'broken'
 *   · unmeasured > 0       → 'unknown'（就算其它项全 ok 也一样）
 *   · warn > 0             → 'degraded'
 *   · 其余                 → 'healthy'
 */
export { readCache as _readCache }

export function summarize(items, at = Date.now()) {
  const summary = { ok: 0, warn: 0, error: 0, unmeasured: 0, at, total: 0, verdict: 'unknown', note: '' }
  for (const it of items) {
    const state = it?.state
    if (!SELFCHECK_STATES.includes(state)) {
      // 认不出的状态不许悄悄计入任何一档 —— 计进 ok 就是最坏的那种假绿。
      summary.error += 1
      continue
    }
    summary[state] += 1
  }
  summary.total = items.length
  summary.verdict = summary.error > 0
    ? 'broken'
    : (summary.unmeasured > 0 ? 'unknown' : (summary.warn > 0 ? 'degraded' : 'healthy'))
  // 说人话的一句：别让人从四个数自己推。
  summary.note = summary.verdict === 'healthy'
    ? summary.ok + '/' + summary.total + ' 项通过，没有发现坏掉的部件'
    : '通过 ' + summary.ok + ' / 警告 ' + summary.warn + ' / 故障 ' + summary.error + ' / 未测 ' + summary.unmeasured + '（共 ' + summary.total + ' 项）'
      + (summary.unmeasured > 0 ? '；未测不等于通过' : '')
  return summary
}

/**
 * 跑一次体检。
 *
 * @param {string} vaultDir 核心仓目录
 * @param {{
 *   deep?: boolean,                          // 深检：真解一次 jsonl（快检不解 JSON）
 *   log?: object,
 *   clock?: () => number,
 *   injectStatus?: object|Function|null,     // 传入注入器 stats（宿主进程内）
 *   retentionStatus?: object|Function|null,  // 传入容量治理 status（宿主进程内）
 *   engines?: string|null,                   // 覆盖 engines.node（测试用）
 *   nodeVersion?: string,                    // 覆盖当前 node 版本（测试用）
 * }} [options]
 * @returns {{ items: Array<{id,state,detail,evidence}>, summary: object, version: number, vaultDir: string, deep: boolean }}
 */
export function runSelfCheck(vaultDir, options = {}) {
  const {
    deep = false,
    log = noopLog,
    clock = Date.now,
    injectStatus = null,
    retentionStatus = null,
    engines,
    nodeVersion,
  } = options || {}

  // 一次运行 == 一份读缓存：records.jsonl 同时喂 records 与 usedAt 两项，
  // 各读一遍在真仓上是 2×816ms（+ 2×1.2s 解析）。同一份字节只读一次、只解一次。
  // options.io 可以外部注入（测试用它断言「同一次运行只读一次」）。
  const io = options.io ?? readCache()
  const ctx = {
    vaultDir: typeof vaultDir === 'string' && vaultDir ? vaultDir : null,
    deep: deep === true,
    injectStatus, retentionStatus, engines, nodeVersion,
    io,
  }
  const at = clock()

  if (!ctx.vaultDir) {
    // 没给仓路径是**用法错误**，不是「没数据」。四档里最贴近的是 error：
    // 报 unmeasured 会让人以为「仓是好的，只是还没写」。
    return {
      version: SELFCHECK_VERSION,
      vaultDir: null,
      deep: ctx.deep,
      items: [item('manifest', 'error', '没有给核心仓路径 —— 一个也没测（这不是「没数据」，是调用方没告诉我在哪儿）', { vaultDir: null })],
      summary: summarize([{ state: 'error' }], at),
    }
  }

  const items = []

  /**
   * 跑一项检查。id 必须由调用方显式给出，**不从产出对象里反推**。
   *
   * ── 为什么（真仓上抓到的那次，2026-10-24）──────────────────────────────
   * 第一版在 catch 里写的是 item('unknown-' + items.length, ...)：
   * 一项抛错，它在报告里就叫 unknown-3；而 selfcheck 项的核对逻辑是按 id 比对的，
   * 于是同一次事故被报成两遍 —— 「缺 episodes」**且**「多出 unknown-3」。
   * 读者看到的是「计划表和实现对不上」，而真相只是「那一项自己炸了」。
   * 现在抛错的那一项**保留自己的 id**：它仍然是 episodes，只是 state=error。
   */
  const push = (id, fn) => {
    try {
      items.push(fn(ctx))
    } catch (e) {
      // 单项抛错**不许**吞成 ok，也不许炸掉整份报告：它就是那条检查项的 error。
      const message = String(e?.message ?? e)
      items.push(item(id, 'error', '检查项自身抛错：' + message, { error: message, thrown: true }))
      try { log?.warn?.('自检项抛错（' + id + '）：' + message) } catch { /* 日志失败不影响报告 */ }
    }
  }

  push('manifest', checkManifest)
  push('journal', checkJournal)
  push('records', checkRecords)
  push('episodes', checkEpisodes)
  push('usedAt', checkUsedAt)
  push('inject', checkInject)
  push('retention', checkRetention)
  // node 排在 selfcheck 之前：selfcheck 要核对「计划里的每一项都产出了」，
  // 排在它后面的项它看不见 —— 那正好又变成「跳过的那一格永远绿」。
  push('node', checkNode)
  // selfcheck 最后跑。「自己这一项现在正在跑」是已知事实，所以把它自己也算进
  // 已产出；其余 8 项必须真的在 items 里，少一项就报 error。
  push('selfcheck', (c) => checkSelfCheck(c, [...items.map((x) => x.id), 'selfcheck']))

  // 最终核对（checkSelfCheck 已经查过一遍；这里防的是它自己都没跑起来的情况）
  const produced = items.map((x) => x.id)
  if (!produced.includes('selfcheck')) {
    const missing = SELFCHECK_ITEM_IDS.filter((id) => !produced.includes(id))
    items.push(item('selfcheck', 'error', '哨兵没产出这些检查项：' + missing.join(', ') + ' —— 缺一项，报告就会是 N/N 全绿而真相不是', { planned: SELFCHECK_ITEM_IDS.slice(), produced }))
  }

  return {
    version: SELFCHECK_VERSION,
    vaultDir: ctx.vaultDir,
    deep: ctx.deep,
    items,
    summary: summarize(items, at),
  }
}

export default runSelfCheck
