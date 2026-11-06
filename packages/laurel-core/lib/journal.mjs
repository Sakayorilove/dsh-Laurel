/**
 * laurel-core/journal —— 版本化追加日志（正式变更的唯一权威）。
 *
 * 纪律：
 *  1. 每次变更是一个**提交单元**：有 txId、seq、校验、prev 链。半条/坏条不能当成空库。
 *  2. 尾部半条日志可隔离恢复：截到最后一个校验通过的 seq，并留下 `.recovered` 回执。
 *  3. 正文先落 blob 再写引用（由 vault 保证顺序），日志本身只存引用与元数据。
 *  4. 追加写用 O_APPEND，写完 fsync 才返回成功；不把 tmp+rename 当成刷盘。
 */
import { openSync, closeSync, writeSync, fsyncSync, readFileSync, readSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonical, sha256 } from './format.mjs'

export const JOURNAL_VERSION = 1

function lineHash(unit) {
  const { hash, ...rest } = unit
  return sha256(canonical(rest))
}

/** 打开（或创建）日志。返回句柄；调用方负责 close。 */
export function openJournal(file) {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'a')
  return { file, fd }
}

export function closeJournal(h) {
  try { closeSync(h.fd) } catch { /* 已关 */ }
}

/**
 * 读取并校验整条链。
 * @returns {{units:Array, lastSeq:number, tail:{ok:boolean, reason?:string, atLine?:number}, bad:Array}}
 */
export function readJournal(file) {
  if (!existsSync(file)) return { units: [], lastSeq: 0, tail: { ok: true }, bad: [] }
  const units = []
  const bad = []
  let prev = null
  let lastSeq = 0
  let lineNo = 0
  // 「坏行是不是最后一行」只有在读到下一行非空内容时才能定。
  // 原实现先扫一遍数出 lastNonEmptyLine 再比对；流式读没法预知未来，
  // 所以先假定它是尾部，等真读到后面的非空行再把这一条改成 false。
  // 只保留"最近一条坏行"的引用，避免每行都去遍历 bad（那是 O(n²)）。
  let lastBad = null

  const CHUNK = 1 << 20
  const buf = Buffer.allocUnsafe(CHUNK)
  const fd = openSync(file, 'r')
  let rest = ''
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null)
      if (n <= 0) break
      rest += buf.toString('utf8', 0, n)
      let idx = rest.indexOf('\n')
      while (idx !== -1) {
        const line = rest.slice(0, idx)
        rest = rest.slice(idx + 1)
        lineNo += 1
        handleLine(line, lineNo)
        idx = rest.indexOf('\n')
      }
    }
    // 文件末尾没有换行时，残留的就是最后一行
    if (rest.length > 0) {
      lineNo += 1
      handleLine(rest, lineNo)
    }
  } finally {
    try { closeSync(fd) } catch { /* 已关 */ }
  }

  /**
   * MC15：分块同步读，不再 `readFileSync` 整份 + `split('\n')`。
   * 真仓 journal 25MB，原写法峰值 ≈ 3 倍（原文串 + 行数组 + 解析后的对象）。
   * 链校验本来就是顺序的，流式完全等价。
   */
  function handleLine(line, atLine) {
    if (!line.trim()) return
    // 这一行有内容 → 上一条被判为"尾部"的坏行后面其实还有东西，它不是尾部
    if (lastBad !== null) { lastBad.tail = false; lastBad = null }
    const push = (reason) => { const b = { line: atLine, reason, tail: true }; bad.push(b); lastBad = b }
    let u
    try { u = JSON.parse(line) } catch { push('json'); return }
    if (u.v !== JOURNAL_VERSION) { push('version'); return }
    if (u.hash !== lineHash(u)) { push('hash'); return }
    if (u.prev !== prev) { push('chain'); return }
    if (u.seq !== lastSeq + 1) { push('seq'); return }
    units.push(u)
    prev = u.hash
    lastSeq = u.seq
  }

  // 只有**最后一行**坏才算可隔离的尾部；坏行后面还有内容 = 中间损坏，不能截断当恢复
  const tailBroken = bad.length > 0 && bad[bad.length - 1].tail
  const middle = bad.filter((b) => !b.tail)
  return {
    units,
    lastSeq,
    lastHash: prev,
    tail: tailBroken ? { ok: false, reason: bad[bad.length - 1].reason, atLine: bad[bad.length - 1].line } : { ok: true },
    middle,
    bad,
  }
}

/**
 * 追加一个提交单元并刷盘。
 * @param {{file:string, fd:number}} h
 * @param {{txId:string, at:number, ops:Array, meta?:object}} input
 * @param {string|null} prevHash
 */
export function appendUnit(h, input, prevHash, seq) {
  const unit = {
    v: JOURNAL_VERSION,
    seq,
    txId: input.txId,
    at: input.at,
    ops: input.ops ?? [],
    meta: input.meta ?? {},
    prev: prevHash ?? null,
  }
  unit.hash = lineHash(unit)
  const buf = Buffer.from(JSON.stringify(unit) + '\n', 'utf8')
  writeSync(h.fd, buf)
  fsyncSync(h.fd)
  return unit
}

/**
 * 隔离恢复尾部坏记录：把文件截到最后一个好单元的末尾，并写回执。
 * 不静默：返回被丢弃的字节数与原因，由调用方决定是否告警。
 */
export function recoverTail(file, journalState) {
  if (journalState.tail.ok) return { recovered: false }
  const raw = readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  let goodEnd = 0
  let acc = 0
  let kept = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) { acc += Buffer.byteLength(line) + 1; continue }
    let ok = false
    try {
      const u = JSON.parse(line)
      ok = u.v === JOURNAL_VERSION && u.hash === lineHash(u) && u.seq === kept + 1
    } catch { ok = false }
    if (!ok) break
    kept++
    acc += Buffer.byteLength(line) + 1
    goodEnd = acc
  }
  const before = statSync(file).size
  const dropped = before - goodEnd
  // 先写恢复副本，再截断原文件（保留可追溯的现场）
  const backup = file + '.recovered-' + Date.now()
  renameSync(file, backup)
  writeFileSync(file, raw.slice(0, goodEnd), 'utf8')
  const receipt = { at: new Date().toISOString(), keptSeq: kept, droppedBytes: dropped, backup }
  appendFileSync(join(dirname(file), 'recovery.log'), JSON.stringify(receipt) + '\n')
  return { recovered: true, ...receipt }
}

/**
 * 只读链尾：取最后一个**校验通过**的单元（含 prev/hash/seq）。
 *
 * ── 为什么需要它（P0 性能，2026-10-23）───────────────────────────────────
 * `commit()` 原来在每次写入前调 `readJournal()` 重读整份日志，理由是
 * 「内存 lastSeq 只是打开时的快照，另一个进程可能已经追加过」。这个理由成立，
 * 但代价是 O(整份日志)：真仓 46MB / 5.9 万单元时**每次提交 1.1–1.4 秒**，
 * 而一次会话开始会连着提交好几条（user/message、turn/start、tool/call…），
 * 于是用户看到的就是「每次会话前卡十秒」。而且这个数随日志线性增长 ——
 * 越用越慢，是设计缺陷不是数据问题。
 *
 * 追加只需要两个数：链尾的 `hash`（当 prev）和 `seq`（+1）。这两样都在最后
 * 一条完整单元里。所以从文件尾往前找**第一条自洽的单元**即可，不需要读全链：
 * 链的完整性由 `openVault()` 负责（启动时一次），不该由每一次写入负责。
 *
 * ── 与 readJournal() 的口径差异（必须明确，否则会静默改变语义）──────────
 *  1. 不校验 `prev` 链（只看本行 hash 自洽）。中间断裂由 openVault 发现。
 *  2. 尾部有坏行时**不**截断恢复，只如实返回 `tailTorn:true` 和最后一个好单元 ——
 *     截断是写入方拿不到锁时该做的事，不该由「读尾」这个只读动作做。
 *  3. 找不到任何完整单元（空文件 / 全是坏行）时返回 `ok:true, unit:null`，
 *     调用方按「空链」处理；只有 IO 失败才 `ok:false`。
 *
 * @returns {{ok:boolean, unit:object|null, size:number, torn:boolean, bytesRead:number, error:string|null}}
 */
export function readJournalTailUnit(file, { maxBytes = 1024 * 1024 } = {}) {
  let size = 0
  try {
    const st = statSync(file)
    size = st.size
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, unit: null, size: 0, torn: false, bytesRead: 0, error: null }
    return { ok: false, unit: null, size: 0, torn: false, bytesRead: 0, error: String(e?.message ?? e) }
  }
  if (size === 0) return { ok: true, unit: null, size: 0, torn: false, bytesRead: 0, error: null }

  // 从 64KB 起翻倍。单条单元 p99 ≈ 1.4KB、实测最大 214KB（一条 capture 带整段正文），
  // 64KB 覆盖绝大多数情况；装不下就翻倍，上限 maxBytes（再大就当成异常如实报）。
  // An unread window is not evidence of corruption. Honor smaller caps too.
  const cap = Number.isFinite(maxBytes) && maxBytes >= 1 ? Math.floor(maxBytes) : 1024 * 1024
  let len = Math.min(size, cap, 64 * 1024)
  let totalBytes = 0
  for (;;) {
    const start = size - len
    let buf
    let fd = null
    try {
      fd = openSync(file, 'r')
      buf = Buffer.allocUnsafe(len)
      let off = 0
      while (off < len) {
        const n = readSync(fd, buf, off, len - off, start + off)
        if (n <= 0) break
        off += n
      }
      if (off !== len) return { ok: false, unit: null, size, torn: false, bytesRead: totalBytes, error: 'short-read' }
    } catch (e) {
      return { ok: false, unit: null, size, torn: false, bytesRead: totalBytes, error: String(e?.message ?? e) }
    } finally {
      if (fd !== null) { try { closeSync(fd) } catch { /* 已关 */ } }
    }
    totalBytes += len

    const lines = buf.toString('utf8').split('\n')
    // start>0 时首段是被窗口切断的半行（也可能劈开多字节字符），不能当整行解析。
    const firstWhole = start > 0 ? 1 : 0
    // 文件末尾必须以换行收尾，否则最后一条完整单元后面还有半行没写完的字节 ——
    // 这时追加会把新单元拼到残行尾部，把两条都毁掉。如实标 torn 让调用方拒绝写。
    const endsWithNewline = buf[len - 1] === 0x0a
    let found = null
    let foundIsLast = false
    let torn = false
    // 从后往前找：最后一条空行不算，第一条能解析且 hash 自洽的就是链尾。
    for (let i = lines.length - 1; i >= firstWhole; i--) {
      const line = lines[i]
      if (!line.trim()) continue
      let u
      try { u = JSON.parse(line) } catch { torn = true; continue }
      if (!u || typeof u !== 'object' || Array.isArray(u)
        || u.v !== JOURNAL_VERSION || !Number.isInteger(u.seq) || u.seq < 1
        || typeof u.hash !== 'string' || !u.hash
        || u.hash !== lineHash(u)) {
        torn = true
        continue
      }
      found = u
      foundIsLast = i === lines.length - 1
      break
    }
    if (found && foundIsLast && !endsWithNewline) torn = true
    // 文件末尾没有换行 = 最后一行可能是写到一半的单元；split 后它仍是一行，
    // 解析成功与否已经在上面的循环里判过。这里只需判断「找到的是不是最后一个非空行」：
    // 若中间有坏行被跳过，就是撕裂尾（torn），如实报给调用方。
    if (found) return { ok: true, unit: found, size, torn, bytesRead: totalBytes, error: null }
    // 到文件头（或到上限）仍没有一条完整单元。
    // 两种情况必须分开，否则 `commit` 会自动恢复（截断）一个其实完好的仓：
    //  · start === 0：真的读到了文件开头还找不到 → 文件里没有合法单元（或全坏）
    //  · len >= maxBytes：只是**窗口不够**（尾部单条比 maxBytes 还大）。这时不能
    //    断言撕裂，必须让调用方知道「没读完」而不是「尾坏了」。
    if (start === 0) {
      return { ok: true, unit: null, size, torn: true, bytesRead: totalBytes, error: null }
    }
    if (len < cap) {
      len = Math.min(size, cap, len * 2)
      continue
    }
    return {
      ok: false,
      unit: null,
      size,
      torn: false,
      bytesRead: totalBytes,
      error: `tail-window-too-small:${len}`,
    }
  }
}

/** 生成一个提交单元 id。 */
export function newTxId(prefix = 'tx') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
