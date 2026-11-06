/**
 * laurel-core/vault —— 核心仓的公共资料层（记忆与压缩共用的唯一写入口）。
 *
 * 布局（逻辑，允许小文件合并，但类别与导出契约固定）：
 *   manifest.json    核心身份/格式/能力
 *   journal/         正式变更（权威）
 *   snapshots/       可校验状态快照（可重建）
 *   blobs/           内容寻址正文
 *   skills/          已采纳经验绑定的可读手册
 *   context/         原文引用、摘要、压缩块、恢复映射
 *   providers/       外部提供者兼容信息
 *   jobs/            待整理任务、游标
 *   budgets/         持久额度
 *   indexes/         可重建索引
 *   audit/           操作回执
 *   exports/         已生成备份（可配到仓外）
 *
 * 关键不变量：
 *  - 所有写入经过本模块的 commit()；它先写 blob 再写 journal，最后才返回成功。
 *  - 读失败 ≠ 空库：journal 损坏且无法恢复时抛错，不返回空。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { FORMAT, SCHEMA_VERSION, assertId, contentHash, nowIso } from './format.mjs'
import { appendUnit, closeJournal, newTxId, openJournal, readJournal, readJournalTailUnit, recoverTail } from './journal.mjs'
import { putBlob, getBlob, hasBlob, listBlobs } from './blob.mjs'
import { acquireWrite, inspectLock, releaseWrite } from './lock.mjs'

export const VAULT_DIRS = ['journal', 'snapshots', 'blobs', 'skills', 'context', 'providers', 'jobs', 'budgets', 'indexes', 'audit', 'exports']

/**
 * commit 抢写锁的退避预算。【D146c】
 * 为什么不是无限等：commit 由采集路径按步调用，卡住一步会拖住整轮对话。
 * 60ms 足够让「两个进程同一毫秒都来写」这种真实竞争错开（实测 4 进程同抢时
 * 平均每次持锁 <1ms），又不会让「别人真的在长写」变成无声等待。
 * 抢不到就照旧返回 `{ok:false, reason:'held'}` —— 上层能看见、能报出来，不是静默丢失。
 */
export const COMMIT_LOCK_WAIT_MS = 60

export function vaultPaths(dir) {
  return {
    dir,
    manifest: join(dir, 'manifest.json'),
    journal: join(dir, 'journal', 'journal.jsonl'),
    blobs: join(dir, 'blobs'),
    snapshots: join(dir, 'snapshots'),
    skills: join(dir, 'skills'),
    context: join(dir, 'context'),
    providers: join(dir, 'providers'),
    jobs: join(dir, 'jobs'),
    budgets: join(dir, 'budgets'),
    indexes: join(dir, 'indexes'),
    audit: join(dir, 'audit'),
    exports: join(dir, 'exports'),
  }
}

/** 建仓。coreId 必须由调用方（可信适配器）给出，不在这里随机生成后再忘掉。 */
export function initVault(dir, { coreId, projectId = null, environmentId = null, createdAt = Date.now() } = {}) {
  assertId('coreId', coreId)
  const p = vaultPaths(dir)
  mkdirSync(dir, { recursive: true })
  for (const d of VAULT_DIRS) mkdirSync(join(dir, d), { recursive: true })
  if (!existsSync(p.manifest)) {
    const manifest = {
      format: FORMAT, schemaVersion: SCHEMA_VERSION, coreId, projectId, environmentId,
      createdAt, updatedAt: createdAt,
      capabilities: ['memory', 'experience', 'context', 'archive'],
      note: 'coreId/projectId 独立于机器路径；路径变化靠项目映射，不靠改 id。',
    }
    writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + '\n')
  }
  return openVault(dir)
}

export function readManifest(dir) {
  const p = vaultPaths(dir)
  if (!existsSync(p.manifest)) return null
  try { return JSON.parse(readFileSync(p.manifest, 'utf8')) } catch (e) { throw new Error(`manifest 损坏：${e.message}`) }
}

/**
 * 打开仓。这里做"读失败 ≠ 空库"的判定：
 * journal 存在但链断在中间（非尾部）→ 抛错；断在尾部 → 隔离恢复并回执。
 *
 * ── 进程内链校验缓存（2026-10-23 性能）─────────────────────────────────
 * `readJournal()` 是全量读 + 逐条 sha256 链校验，真仓 46MB / 5.9 万单元实测 1.1 秒。
 * 一个宿主进程里会有多个入口各开一次仓（laurel-memory 的 apply、laurel-context 的
 * apply、compaction-entry、admin 端点……），每次付一遍就是启动卡顿的主因之一。
 *
 * 缓存键 = `(绝对路径, size, mtimeMs)`：journal 只追加，两者任一变化就重读。
 * 缓存的是**校验结果**，不是"跳过校验" —— 同一份字节不会校验两次。
 * 语义差异只有一条：两次 open 之间文件被**原地改写但大小和 mtime 都不变**时，
 * 第二次会拿到旧结果。这需要刻意伪造 mtime，且本仓的写入路径是 O_APPEND + fsync
 * （不原地改），所以不作为威胁模型；`readJournal` 本身仍可随时被显式调用做全量校验。
 */
const journalOpenCache = new Map() // resolvedDir -> { size, mtimeMs, journal }
const JOURNAL_CACHE_LIMIT = 4

function journalCacheKey(dir, journalPath) {
  const resolved = resolvePath(dir)
  try {
    const st = statSync(journalPath)
    return { key: resolved, size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return { key: resolved, size: -1, mtimeMs: -1 }
  }
}

function cachedReadJournal(dir, journalPath) {
  const { key, size, mtimeMs } = journalCacheKey(dir, journalPath)
  const hit = journalOpenCache.get(key)
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) {
    // LRU 触碰
    journalOpenCache.delete(key)
    journalOpenCache.set(key, hit)
    return { journal: hit.journal, cached: true }
  }
  const journal = readJournal(journalPath)
  // 只缓存**健康**的结果：坏链/坏尾必须每次重读，否则恢复动作会被缓存挡住。
  if (journal.tail?.ok && !(journal.middle?.length)) {
    journalOpenCache.delete(key)
    journalOpenCache.set(key, { size, mtimeMs, journal })
    if (journalOpenCache.size > JOURNAL_CACHE_LIMIT) journalOpenCache.delete(journalOpenCache.keys().next().value)
  } else {
    journalOpenCache.delete(key)
  }
  return { journal, cached: false }
}

/** 清空 openVault 的链校验缓存（测试与「强制重新校验」用）。 */
export function invalidateJournalCache() {
  const n = journalOpenCache.size
  journalOpenCache.clear()
  return { cleared: n }
}

export function openVault(dir, { recover = true } = {}) {
  const p = vaultPaths(dir)
  const manifest = readManifest(dir)
  if (!manifest) throw new Error(`不是核心仓（缺 manifest.json）：${dir}`)
  const first = cachedReadJournal(dir, p.journal)
  // 缓存命中时给调用方一份**独立的 units 数组**（元素共享，数组不共享）：
  // `commit()` 会 `v.journal.units.push(unit)`，两个句柄共用一个数组会把同一单元推进去两次，
  // 让快照/导出的 unitCount 与 merkle 失真。数组浅拷贝 5.9 万项约 1ms，可忽略。
  let journal = first.cached ? { ...first.journal, units: first.journal.units.slice() } : first.journal
  let recovery = null
  // 中间损坏 = 真实损坏：绝不能截断当"恢复"，也不能当空库
  if (journal.middle?.length) {
    throw new Error(`journal 中间损坏（不能当空库、不能截断）：${JSON.stringify(journal.middle.slice(0, 3))}`)
  }
  if (!journal.tail.ok && recover) {
    recovery = recoverTail(p.journal, journal)
    journal = readJournal(p.journal)
    if (!journal.tail.ok) throw new Error(`journal 尾部恢复失败：${JSON.stringify(journal.tail)}`)
    if (journal.middle?.length) throw new Error(`恢复后仍有中间损坏：${JSON.stringify(journal.middle.slice(0, 3))}`)
  }
  if (!journal.tail.ok) throw new Error(`journal 尾部损坏且未恢复：${JSON.stringify(journal.tail)}`)
  const v = { dir, paths: p, manifest, journal, recovery, lastSeq: journal.lastSeq, lastHash: journal.lastHash, journalCached: first.cached }
  // 句柄方法：让调用方可以 `vault.commit(vault, ...)`，也可以继续用模块级函数。
  // 两个业务模块共用这一份契约，避免各自假设一个不存在的方法。
  v.commit = (handle, input) => commit(handle ?? v, input)
  v.readBody = (hash) => readBody(v, hash)
  v.hasBody = (hash) => hasBody(v, hash)
  v.listBodies = () => listBodies(v)
  v.writeSnapshot = (name) => writeSnapshot(v, name)
  v.audit = (entry) => appendAudit(v, entry)
  v.inspectLock = () => inspectLock(v.dir)
  return v
}

/**
 * 提交单元：唯一写入入口。
 * @param {object} v openVault 的返回
 * @param {{ops:Array, meta?:object, body?:string|Buffer}} input
 */
export function commit(v, input) {
  // 【D146c】waitMs 让出 60ms 退避预算：commit 是毫秒级操作，抢不到锁就立刻把整笔提交判死，
  // 等于把正常的并发竞争当成数据丢失。实测 4 进程抢同一把锁时 42.5% 的调用直接 held。
  const lock = acquireWrite(v.dir, { waitMs: COMMIT_LOCK_WAIT_MS })
  if (!lock.ok) return { ok: false, reason: lock.reason, holder: lock.holder, note: lock.note }
  let h = null
  try {
    const ops = [...(input.ops ?? [])]
    let bodyRef = null
    if (input.body !== undefined) {
      const put = putBlob(v.paths.blobs, input.body)
      bodyRef = { hash: put.hash, bytes: put.bytes, deduped: put.deduped }
      ops.push({ op: 'blob.put', hash: put.hash, bytes: put.bytes })
    }
    // 关键：持锁后必须**从磁盘重读链尾**，不能用内存里的 lastSeq/lastHash。
    // 内存值只是本进程打开时的快照；另一个进程可能已经追加过，
    // 用它当 prev 会造出两个 seq 相同、prev 指向同一条的单元 →
    // 哈希链断裂 → 核心仓永久打不开（不可恢复的数据损坏）。
    //
    // 【性能，2026-10-23】重读**只读链尾**，不再整读全链。
    // 原来每次提交都 `readJournal()`（46MB / 5.9 万单元），实测 1.1–1.4 秒/次；
    // 会话开始连着提交好几条 → 用户每场会话先卡十秒，且随日志线性变慢。
    // 追加只需要链尾的 hash 与 seq，`readJournalTailUnit` 从文件尾往前找第一条自洽单元即可。
    // 链完整性仍由 openVault() 在启动时校验一次；这里只保证「不写出断链」。
    // 尾部撕裂（最后一条是写了一半的字节）时**不能追加**：O_APPEND 会把新单元
    // 直接拼在残行尾部，两条一起毁掉。此时我们持有写锁，正是做隔离恢复的时机 ——
    // 恢复后再读一次尾继续写，避免「一次崩溃留下的残行让之后所有采集都写不进去」。
    let tailRead = readJournalTailUnit(v.paths.journal)
    if (!tailRead.ok) {
      return { ok: false, reason: `journal-tail-read-failed:${tailRead.error ?? 'unknown'}` }
    }
    if (tailRead.torn) {
      const recovered = recoverTail(v.paths.journal, { tail: { ok: false, reason: 'torn' } })
      if (!recovered.recovered) return { ok: false, reason: 'journal-tail-torn' }
      tailRead = readJournalTailUnit(v.paths.journal)
      if (!tailRead.ok || tailRead.torn) return { ok: false, reason: 'journal-tail-torn' }
      // 恢复截掉了尾巴，内存视图里可能还留着被丢弃的单元，按 seq 截齐。
      v.journal.units = Array.isArray(v.journal.units)
        ? v.journal.units.filter((u) => Number.isInteger(u?.seq) && u.seq <= (tailRead.unit?.seq ?? 0))
        : []
      v.journal.recovery = recovered
    }
    const tailUnit = tailRead.unit
    const prevHash = tailUnit?.hash ?? null
    const nextSeq = (tailUnit?.seq ?? 0) + 1
    // 并行保护：本进程内存里的 lastSeq 比磁盘链尾**更靠前**，说明另一个进程刚追加过、
    // 而我们的 v.journal.units 还是旧的。内存视图按 seq 去重补一条即可（不重读全链）。
    if (Number.isInteger(v.lastSeq) && nextSeq <= v.lastSeq) {
      // 磁盘比内存旧 = 文件被外部替换/回滚过。此时 prev 以磁盘为准继续写，
      // 但内存视图不能直接 push（会造出重复 seq）。重置成「以磁盘链尾为准」。
      v.journal.units = Array.isArray(v.journal.units)
        ? v.journal.units.filter((u) => Number.isInteger(u?.seq) && u.seq < nextSeq)
        : []
    }
    // 日志句柄**必须在恢复之后才打开**：`recoverTail` 会 rename 原文件再重建，
    // 提前 open 拿到的是旧 inode，后续写入会全部落到备份文件里（实测：seq 停在 3，
    // 新单元人间蒸发）。所以这里按需打开，而不是函数开头就 open。
    h = openJournal(v.paths.journal)
    const unit = appendUnit(h, { txId: input.txId ?? newTxId(), at: Date.now(), ops, meta: input.meta ?? {} }, prevHash, nextSeq)
    v.lastSeq = unit.seq
    v.lastHash = unit.hash
    // 同步内存视图：快照/导出靠它统计，不能停留在打开时的那份
    v.journal.units.push(unit)
    return { ok: true, seq: unit.seq, txId: unit.txId, hash: unit.hash, body: bodyRef }
  } finally {
    if (h !== null) closeJournal(h)
    releaseWrite(lock.file, lock.fence)
  }
}

export function readBody(v, hash) {
  return getBlob(v.paths.blobs, hash)
}

export function hasBody(v, hash) {
  return hasBlob(v.paths.blobs, hash)
}

export function listBodies(v) {
  return listBlobs(v.paths.blobs)
}

/** 快照：把当前状态写成一个可校验文件（派生，可重建）。 */
export function writeSnapshot(v, name = 'state') {
  const state = {
    format: FORMAT, schemaVersion: SCHEMA_VERSION, coreId: v.manifest.coreId,
    at: nowIso(), lastSeq: v.lastSeq, lastHash: v.lastHash,
    unitCount: v.journal.units.length,
    merkle: contentHash(v.journal.units.map((u) => u.hash)),
  }
  const file = join(v.paths.snapshots, `${name}-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n')
  appendAudit(v, { op: 'snapshot.write', file, at: state.at })
  return { file, state }
}

export function appendAudit(v, entry) {
  mkdirSync(v.paths.audit, { recursive: true })
  appendFileSync(join(v.paths.audit, 'audit.jsonl'), JSON.stringify({ at: nowIso(), ...entry }) + '\n')
}

export { inspectLock, acquireWrite, releaseWrite }
