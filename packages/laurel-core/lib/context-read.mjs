/**
 * laurel-core/context-read —— 压缩块与原文引用的**宿主无关**读取层（两包共用）。
 *
 * 为什么在 core 而不是 laurel-context：
 *   `laurel_context` 工具的**定义**在 laurel-memory 的 toolSurface() 里，
 *   但它的执行逻辑属于压缩层。两边各写一份必然漂移（这类漂移在本套件里
 *   已经发生过多次）。laurel-memory 不能 import laurel-context（依赖方向反了），
 *   所以实现下沉到这里：纯仓读取，只依赖 blob/journal/textindex。
 *
 * 数据来源（与 laurel-context/engine.mjs 完全一致，取自 journal 的四种 op）：
 *   ctx.externalize  → ref + hash（大工具结果外置后的可回读句柄）
 *   ctx.summary      → 已发布的摘要块
 *   ctx.compaction   → 压缩次数与时间
 *   ctx.ingest       → 摄取批次（本模块不读正文，只计数）
 *
 * 纪律：
 *  - 不 import 任何 DSH/Cordis 代码，不读 DSH_HOME。
 *  - 只读：不写 journal、不写 blob、不做 GC。
 *  - 读失败不等于空仓：journal 损坏时如实报 reason，返回空列表并带 error 字段。
 */
import { existsSync, statSync } from 'node:fs'
import { vaultPaths } from './vault.mjs'
import { readJournal } from './journal.mjs'
import { getBlob } from './blob.mjs'
import { tokenize, search as textSearch } from './textindex.mjs'

/** 与 engine.mjs 保持一致：ref 由内容哈希派生。 */
export const REF_PREFIX = 'ctx://blob/'
const HASH_IN_REF = /^ctx:\/\/blob\/([0-9a-f]{64})$/

/** 原文分页默认值。 */
const DEFAULT_PAGE_LINES = 40
const MAX_PAGE_LINES = 400

function refOf(hash) {
  return REF_PREFIX + hash
}

function oneLine(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 建一个读取器。
 *
 * @param {object} opts
 * @param {object} [opts.vault]    已打开的 vault（有就用它的 paths，省一次路径推算）
 * @param {string} [opts.vaultDir] 核心仓目录（没有 vault 时用）
 * @param {() => Map<string,object>|object[]} [opts.getRefs]
 *        进程内已有的 refs（engine 传自己的 state.refs）。
 *        给了就**优先**用它解析短 ref，避免每次扫描 journal；
 *        没给（或查不到）就按需扫 journal 并缓存。
 * @returns 读取器
 */
export function createContextReader({ vault = null, vaultDir = null, getRefs = null } = {}) {
  const blobsDir = vault?.paths?.blobs ?? (vaultDir ? vaultPaths(vaultDir).blobs : null)
  const journalFile = vault?.paths?.journal ?? (vaultDir ? vaultPaths(vaultDir).journal : null)

  /** journal 扫描缓存：用 (size,mtimeMs) 判新鲜度，不用 mtime 单独判（陷阱 5）。 */
  const scan = { key: null, refs: [], summaries: [], compactions: 0, lastCompactionAt: null, bad: 0, error: null }

  function refArrayOf(source) {
    if (!source) return []
    if (source instanceof Map) return [...source.values()]
    return Array.isArray(source) ? source : []
  }

  function journalRefs() {
    if (!journalFile || !existsSync(journalFile)) {
      return { refs: [], summaries: [], compactions: 0, lastCompactionAt: null, bad: 0, error: null }
    }
    // 新鲜度 = (size, mtimeMs) 组合，不用 mtime 单独判（陷阱 5：秒级粒度会漏掉同秒写入）
    const st = (() => {
      try {
        const s = statSync(journalFile)
        return `${journalFile}:${s.size}:${s.mtimeMs}`
      } catch {
        return journalFile
      }
    })()
    if (scan.key === st) return scan
    let state
    try {
      state = readJournal(journalFile)
    } catch (e) {
      return { refs: [], summaries: [], compactions: 0, lastCompactionAt: null, bad: 0, error: String(e?.message ?? e) }
    }
    const refs = []
    const byRef = new Set()
    const summaries = []
    const summaryIds = new Set()
    let compactions = 0
    let lastCompactionAt = null
    for (const unit of state.units ?? []) {
      for (const op of unit.ops ?? []) {
        if (op.op === 'ctx.externalize') {
          if (byRef.has(op.ref)) continue
          byRef.add(op.ref)
          refs.push({ ref: op.ref, hash: op.hash, bytes: op.bytes, tool: op.tool, callId: op.callId, at: null })
        } else if (op.op === 'ctx.summary') {
          const id = op.id ?? op.block?.id
          if (id && summaryIds.has(id)) continue
          if (id) summaryIds.add(id)
          summaries.push(op.block ?? op)
        } else if (op.op === 'ctx.compaction') {
          compactions++
          lastCompactionAt = op.at ?? null
        }
      }
    }
    scan.key = st
    scan.refs = refs
    scan.summaries = summaries
    scan.compactions = compactions
    scan.lastCompactionAt = lastCompactionAt
    scan.bad = state.bad ?? 0
    scan.error = null
    return scan
  }

  function listRefs() {
    const fromMemory = refArrayOf(getRefs?.())
    if (fromMemory.length) return fromMemory
    return journalRefs().refs
  }

  function summaries() {
    return journalRefs().summaries
  }

  function stateInfo() {
    const j = journalRefs()
    return {
      refs: listRefs().length,
      summaries: j.summaries.length,
      compactions: j.compactions,
      lastCompactionAt: j.lastCompactionAt,
      bad: j.bad,
      error: j.error,
    }
  }

  function resolveRef(ref) {
    if (typeof ref !== 'string') return null
    const direct = HASH_IN_REF.exec(ref)
    if (direct) return direct[1]
    for (const rec of refArrayOf(getRefs?.())) {
      if (rec.ref === ref) return rec.hash
    }
    for (const rec of journalRefs().refs) {
      if (rec.ref === ref) return rec.hash
    }
    return null
  }

  /** 原文分页回取（与 engine.readOriginal 同一契约）。 */
  function readOriginal(ref, { offset = 0, lines = DEFAULT_PAGE_LINES } = {}) {
    const hash = resolveRef(ref)
    if (!hash) return { ok: false, reason: 'unknown-ref', ref }
    if (!blobsDir) return { ok: false, reason: 'no-blob-store', ref, hash }
    const blob = getBlob(blobsDir, hash)
    if (!blob.ok) return { ok: false, reason: blob.reason, ref, hash }
    const text = blob.data.toString('utf8')
    const all = text.split(/\r?\n/)
    const start = Math.max(0, Math.min(Number.isFinite(offset) ? Math.trunc(offset) : 0, all.length))
    const count = Math.max(1, Math.min(MAX_PAGE_LINES, Number.isFinite(lines) ? Math.trunc(lines) : DEFAULT_PAGE_LINES))
    const slice = all.slice(start, start + count)
    return {
      ok: true,
      ref,
      hash,
      totalLines: all.length,
      offset: start,
      lines: slice.length,
      text: slice.join('\n'),
      hasMore: start + slice.length < all.length,
      nextOffset: start + slice.length,
    }
  }

  /**
   * 原文搜索（零推理 BM25，不恢复全文）。
   * 缓存键跟着 refs 数量走：新外置一条就必然重建，避免"永远查不到新块"（MC09）。
   */
  let cache = null
  let cacheKey = -1

  function searchOriginal(query, { limit = 5 } = {}) {
    const refs = listRefs()
    if (!cache || cacheKey !== refs.length) {
      cache = []
      cacheKey = refs.length
      for (const rec of refs) {
        if (!blobsDir) break
        const blob = getBlob(blobsDir, rec.hash)
        if (!blob.ok) continue
        cache.push({ id: rec.ref, ref: rec.ref, body: blob.data.toString('utf8'), tool: rec.tool, callId: rec.callId })
      }
    }
    const res = textSearch(cache, query, { limit })
    const qs = new Set(tokenize(query))
    const hits = (res.hits ?? []).map((h) => {
      const body = h.record.body
      const lines = body.split(/\r?\n/)
      let at = -1
      for (let i = 0; i < lines.length; i++) {
        if (tokenize(lines[i]).some((t) => qs.has(t))) { at = i; break }
      }
      const from = Math.max(0, at - 1)
      const snippet = at < 0 ? body.slice(0, 300) : lines.slice(from, from + 3).join('\n')
      return { ref: h.record.ref, score: h.score, coverage: h.coverage, tool: h.record.tool, callId: h.record.callId, line: at, snippet }
    })
    return { query: res.query, hits, poolSize: res.poolSize, reason: res.reason }
  }

  return { listRefs, summaries, stateInfo, resolveRef, readOriginal, searchOriginal, refOf }
}

/**
 * `laurel_context` 工具的正文产出（宿主无关，memory 包只负责接线）。
 *
 * 参数（与 toolSurface 里那份 definition 必须一致）：
 *   ref    压缩块/原文 ref（ctx://blob/… 或短 ref）→ 读原文分页
 *   query  检索词（也可直接给 ref，等价于 ref 分支）
 *   offset / lines  分页
 *
 * 返回值永远是**可读文本**，长度受 maxChars 约束（截断会标注）。
 * 本函数不抛：压缩块读不出来时给出可执行下一步，而不是空字符串。
 */
export function executeContextQuery({ vaultDir, vault = null, args = {}, maxChars = 1200, getRefs = null } = {}) {
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : 1200
  const clip = (text) => {
    const s = String(text ?? '')
    if (s.length <= budget) return s
    const marker = `…[已截断：原文 ${s.length} 字符，超出本档预算 ${budget}]`
    if (marker.length >= budget) return marker.slice(0, budget)
    return s.slice(0, budget - marker.length) + marker
  }
  const input = args && typeof args === 'object' ? args : {}
  let reader
  try {
    if (!vaultDir && !vault) return clip('上下文压缩仓未就绪（没有核心仓路径），无法回读。')
    reader = createContextReader({ vault, vaultDir, getRefs })
  } catch (e) {
    return clip(`上下文读取器创建失败：${e?.message ?? e}`)
  }

  const refArg = typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : null
  const queryArg = typeof input.query === 'string' && input.query.trim() ? input.query.trim() : null
  const offset = Number.isFinite(input.offset) ? Math.max(0, Math.trunc(input.offset)) : 0
  const lines = Number.isFinite(input.lines) ? Math.trunc(input.lines) : DEFAULT_PAGE_LINES

  try {
    // 1) 明确要 ref（或 query 本身长得像 ref）→ 读原文分页
    const wantRef = refArg ?? (queryArg && (queryArg.startsWith(REF_PREFIX) || HASH_IN_REF.test(queryArg)) ? queryArg : null)
    if (wantRef) {
      const page = reader.readOriginal(wantRef, { offset, lines })
      if (!page.ok) {
        // 三种失败要分开说，否则模型只知道"失败了"，不知道下一步做什么：
        //   unknown-ref  → 这个 ref 既不是内容哈希形态、也没在索引里
        //   missing      → ref 形态合法，但原文没登记或 blob 已不在仓里
        //   corrupt 等   → 读出来了但内容坏了
        let why
        if (page.reason === 'unknown-ref') {
          why = `没有登记过这个 ref（${oneLine(wantRef, 80)}）`
        } else if (page.reason === 'missing') {
          const info = reader.stateInfo()
          why = `没有登记过这个 ref 或原文已不在仓里（${oneLine(wantRef, 80)}）；`
            + `本仓已外置 ${info.refs} 段原文、${info.summaries} 个摘要块`
        } else {
          why = `原文读取失败：${page.reason}（${oneLine(wantRef, 80)}）`
        }
        return clip(`${why}。可换检索词：laurel_context({query:"关键词"})。`)
      }
      const head = `原文 ${oneLine(page.ref, 90)}：第 ${page.offset + 1}-${page.offset + page.lines}/${page.totalLines} 行`
        + (page.hasMore ? '（还有后续，用 offset 继续）' : '')
      return clip(`${head}\n---\n${page.text}`)
    }

    // 2) 检索词 → 在已外置正文里找
    if (queryArg) {
      const found = reader.searchOriginal(queryArg, { limit: Number.isFinite(input.limit) ? input.limit : 5 })
      if (!found.hits.length) {
        const info = reader.stateInfo()
        return clip(`没有命中「${queryArg}」（已外置 ${info.refs} 段原文、${info.summaries} 个摘要块）。`
          + '可换更具体的词；或用 ref 直读原文分页。')
      }
      const body = found.hits.map((h) => {
        const where = h.line >= 0 ? `第 ${h.line + 1} 行` : '开头'
        return `- ${h.ref}（${where}${h.tool ? `，tool=${h.tool}` : ''}）\n  ${oneLine(h.snippet, 240)}`
      }).join('\n')
      return clip(`命中 ${found.hits.length} 段（query=「${queryArg}」）：\n${body}`)
    }

    // 3) 什么都没给 → 报清现状与下一步
    const info = reader.stateInfo()
    const sum = reader.summaries()
    const tail = sum.length
      ? `\n最近摘要块：${sum.slice(-3).map((b) => oneLine(b.id ?? b.ref ?? '(匿名块)', 60)).join('、')}`
      : ''
    const warn = info.error ? `\n⚠ journal 读取有问题：${info.error}` : ''
    return clip(`需要 ref 或 query 之一才能回读压缩内容。当前：已外置 ${info.refs} 段原文、`
      + `${info.summaries} 个摘要块、压缩 ${info.compactions} 次${info.lastCompactionAt ? `（最后一次 ${info.lastCompactionAt}）` : ''}。`
      + `${tail}${warn}`)
  } catch (e) {
    return clip(`上下文查询失败：${e?.message ?? e}`)
  }
}
