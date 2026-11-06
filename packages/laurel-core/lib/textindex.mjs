/**
 * laurel-core/textindex —— 零推理文本检索（n-gram + BM25）。
 *
 * 纪律：
 *  1. **先过滤，再评分**：权限/项目/状态/有效版本在打分之前筛掉，不靠分数掩盖。
 *  2. 冲突只列候选，不凭相似度覆盖事实。
 *  3. 不读盘；索引/语料由调用方持有，本模块只做**进程内缓存**（可用 invalidate() 清）。
 *  4. 中文 bigram、英文整词；emoji 与长命令按原样保留为 token。
 *  5. **不可检索的不进索引**：`indexable:false` / `indexed:false` 标记、以及 `^调用 <tool> …`
 *     这类工具调用日志（它不是知识，37% 的真仓记录是这种行），在 buildIndex 阶段就跳过。
 *
 * S3 改动说明（性能，L06 主因）：
 *  旧实现每次 search() 都 buildIndex(records) 重建全量倒排：27,798 条 ≈ 2.3s/次。
 *  现在 search() 用「语料扫描索引」：一次把（过滤后、折叠重复后）可检索文本取小写缓存起来，
 *  之后每次查询只做 indexOf 覆盖统计 + 候选精排。缓存键 = 内容指纹（见 fingerprint()）。
 *  search() 的签名与返回形状保持不变：{query, hits:[{record,score,coverage}], poolSize, indexSize}。
 */

const LATIN = /[a-z0-9_@./\\:-]{2,}/g
const CJK = /[\u3400-\u9fff\uf900-\ufaff]+/g
const EMOJI = /\p{Extended_Pictographic}/gu
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'not', 'you', 'has', 'have', '一个', '可以', '这个', '那个'])

/** 工具调用日志的固定回显形态：`^调用 <tool> <args…>`。它不是知识，只是过程噪声。 */
export const TOOL_CALL_LOG_RE = /^调用 [a-z_0-9]+ /

export function isToolCallLog(body) {
  return TOOL_CALL_LOG_RE.test(String(body ?? ''))
}

/** 调用方（capture/适配器）可以显式标记不可检索；两种写法都认。 */
export function isIndexable(record) {
  if (!record) return false
  if (record.indexable === false || record.indexed === false) return false
  return true
}

export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const out = []
  for (const m of s.matchAll(LATIN)) {
    const t = m[0].replace(/^[./\\]+|[./\\]+$/g, '')
    if (t.length >= 2 && !STOP.has(t)) out.push(t)
  }
  for (const m of s.matchAll(CJK)) {
    const run = m[0]
    if (run.length === 1) { out.push(run); continue }
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2))
  }
  for (const m of s.matchAll(EMOJI)) out.push(m[0])
  return out
}

/**
 * 与 tokenize() 语义等价、但不分配中间 token 数组的分词（给扫描索引和查询用）。
 * 仍返回 token 数组，语义必须与 tokenize() 一致，否则索引与查询会错位。
 */
export function tokenizeFast(text) {
  const s = String(text ?? '').toLowerCase()
  const out = []
  const n = s.length
  let i = 0
  while (i < n) {
    const c = s.charCodeAt(i)
    if (c < 128) {
      if (LATIN_CHAR[c]) {
        let j = i + 1
        while (j < n && s.charCodeAt(j) < 128 && LATIN_CHAR[s.charCodeAt(j)]) j++
        const t = s.slice(i, j).replace(/^[./\\]+|[./\\]+$/g, '')
        if (t.length >= 2 && !STOP.has(t)) out.push(t)
        i = j
        continue
      }
      i++
      continue
    }
    if (isCjkCode(c)) {
      let j = i + 1
      while (j < n && isCjkCode(s.charCodeAt(j))) j++
      if (j - i === 1) out.push(s[i])
      else for (let k = i; k + 1 < j; k++) out.push(s.slice(k, k + 2))
      i = j
      continue
    }
    // emoji 在 UTF-16 里是代理对：必须整对取出再判定，只测高位代理永远不匹配，
    // 会让 `searchMemory(recs, '🚀')` 变成空查询（memory.test.mjs 就守着这条）。
    if (c >= 0xd800 && c <= 0xdbff) {
      const pair = s.slice(i, i + 2)
      if (EMOJI_CHAR.test(pair)) out.push(pair)
      i += 2
      continue
    }
    if (EMOJI_CHAR.test(s[i])) out.push(s[i])
    i++
  }
  return out
}

export const FIELD_WEIGHTS = { body: 1.0, tags: 1.6, entities: 1.8, aliases: 1.8, title: 1.3 }
export const K1 = 1.2
export const B = 0.75

/**
 * 作者权重：**不删任何一类记录，只承认来源可信度差异**。
 *  - user：用户原话，是需求与决策的唯一权威来源。
 *  - assistant：自己的结论/计划，可信但可能被后来的对话推翻。
 *  - tool：工具输出（日志、cat、测试结果）是**可再生的证据**，不是知识本身；
 *    同一段工具输出往往在多个会话里重复落盘，命中它通常只是在复读机器噪声。
 * 这些不是"刷分参数"：权重用于抵消工具输出天生更长、重复词更多的优势（BM25 的长度归一化
 * 压不住 5 倍长度差），改任何一项都会在 a-recall-probe 上掉命中。
 */
export const AUTHOR_WEIGHT = { user: 1.0, assistant: 0.88, tool: 0.6 }

const LATIN_CHAR = (() => {
  const t = new Uint8Array(128)
  for (const ch of 'abcdefghijklmnopqrstuvwxyz0123456789_@./\\:-') t[ch.charCodeAt(0)] = 1
  for (let c = 65; c <= 90; c++) t[c] = 1
  return t
})()
const EMOJI_CHAR = /\p{Extended_Pictographic}/u
const isCjkCode = (c) => (c >= 0x3400 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)

/**
 * 单文档进入扫描语料的最大字符数：更长的尾部对反查没有增量，却按长度乘算内存/耗时。
 * 真仓实测（13k 可检索条目）：p50 587 / p90 5097 / p99 8000 字符；全量小写化是冷启动的主要成本
 * （4000→2000 省约 30ms）。反查 query 取自记录开头，截断尾部不影响命中。
 */
export const SCAN_CAP = 2000

function scanText(r) {
  const body = String(r.body ?? r.text ?? '')
  // 正文本身已够长时，元数据（tags/title/aliases/entities）拼接后也会被 SCAN_CAP 截掉，
  // 结果与被截断的正文逐字相同 —— 那就别拼了。`${body} …` 会强制展平整条正文（真仓约
  // 63MB），这是建语料里最贵的一步；而对足够长的正文，slice() 只产生视图，几乎免费。
  if (body.length >= SCAN_CAP) return body.slice(0, SCAN_CAP)
  const tags = (r.tags ?? []).join(' ')
  const title = r.title ? String(r.title) : ''
  const aliases = (r.aliases ?? []).join(' ')
  const entities = (r.entities ?? []).join(' ')
  const merged = title || aliases || entities ? `${body} ${title} ${tags} ${aliases} ${entities}` : `${body} ${tags}`
  return merged.length > SCAN_CAP ? merged.slice(0, SCAN_CAP) : merged
}

/** 查询里出现任何拉丁字母（或任何可折叠字符）时，才需要把语料折成小写再比；
 *  纯 CJK/emoji 查询直接扫原文，省掉全语料 toLowerCase（冷启动最贵的一段）。 */
function needsCaseFold(query) {
  const q = String(query ?? '')
  return q !== q.toLowerCase() || /[A-Za-z]/.test(q)
}

/** 同一条正文的多份落盘（真仓里常见：同一句用户原话重复 10 次）只该占一个结果名额。 */
function dedupKey(r) {
  return r.bodyHash ?? r.contentVersion ?? String(r.body ?? r.text ?? '')
}

/**
 * 展开成「可检索条目」：过滤噪声 → 按正文折叠重复（保留最新一条）→ 取截断后的扫描文本。
 * 文本保持原大小写，小写折叠推迟到真正出现拉丁查询时（见 foldTexts）。
 * 返回 entries: [{record, text, len, dups}]
 */
function compileEntries(records, opts = {}) {
  const skipToolCallLogs = opts.skipToolCallLogs !== false
  const foldDuplicates = opts.foldDuplicates !== false

  // 第一遍只做「过滤 + 挑出每组重复的代表」，不建文本：
  // 先建文本再丢弃重复，等于给每条重复正文都白做一次拼接与截断（真仓约 10% 的条目是重复）。
  const kept = []
  if (!foldDuplicates) {
    for (const r of records) {
      if (!isIndexable(r)) continue
      if (skipToolCallLogs && isToolCallLog(r.body ?? r.text)) continue
      kept.push({ record: r, dups: 0 })
    }
  } else {
    const seen = new Map() // key -> kept 数组下标
    for (const r of records) {
      if (!isIndexable(r)) continue
      if (skipToolCallLogs && isToolCallLog(r.body ?? r.text)) continue
      const key = dedupKey(r)
      const at = Number(r.createdAt) || 0
      const idx = seen.get(key)
      if (idx === undefined) {
        seen.set(key, kept.length)
        kept.push({ record: r, dups: 0, at })
        continue
      }
      const cur = kept[idx]
      cur.dups++
      // 同一正文多份落盘时保留「最新」那一份（createdAt 大者，同刻则后出现者）。
      if (at >= cur.at) { cur.record = r; cur.at = at }
    }
  }

  // 第二遍只给幸存者建扫描文本。
  const entries = new Array(kept.length)
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i]
    const text = scanText(k.record)
    entries[i] = { record: k.record, text, len: text.length || 1, dups: k.dups }
  }
  return entries
}

/**
 * 内容指纹：条数 + 首末 id + updatedAt 累加 + 正文字符数累加。
 * 追加、修改（updatedAt 变）、撤销（filter 后条数变）都会改变指纹；纯数字运算，12k 条 <1ms。
 */
export function fingerprint(pool) {
  const n = pool.length
  if (!n) return 'empty'
  let upd = 0
  let chars = 0
  for (let i = 0; i < n; i++) {
    const r = pool[i]
    upd = (upd + (Number(r.updatedAt) || 0)) % 2147483647
    chars = (chars + (r.body ? String(r.body).length : 0)) % 2147483647
  }
  return `${n}:${pool[0].id ?? ''}:${pool[n - 1].id ?? ''}:${upd}:${chars}`
}

const CACHE_LIMIT = 4
const scanCache = new Map() // key -> {entries, texts, lens, avgLen, n, chars, builtAt}

// 重建计数器。加它不是为了实现需要，而是因为「search() 不再每次全量重建」这条优化
// **必须能被外部观测**：只看耗时分不清「重建了但很快」和「根本没重建」，
// S3-3 验收要的是硬数字而不是「感觉快了」。
let buildCount = 0

export function invalidate() {
  const n = scanCache.size
  scanCache.clear()
  buildCount = 0
  return { cleared: n }
}

export function cacheStats() {
  return { size: scanCache.size, keys: [...scanCache.keys()], builds: buildCount }
}

function buildScanIndex(pool, opts = {}) {
  buildCount++
  const entries = compileEntries(pool, opts)
  const texts = new Array(entries.length)
  const lens = new Int32Array(entries.length)
  let totalLen = 0
  for (let i = 0; i < entries.length; i++) {
    texts[i] = entries[i].text
    lens[i] = entries[i].len
    totalLen += entries[i].len
  }
  return {
    entries,
    texts,
    lens,
    n: entries.length,
    avgLen: Math.max(1, totalLen / Math.max(1, entries.length)),
    folded: pool.length - entries.length,
    builtAt: Date.now(),
    lowered: null, // 惰性：只有出现拉丁字母查询时才折叠一次，之后复用
  }
}

/** 拉丁查询才需要的小写折叠视图；折叠一次后缓存在索引对象上。 */
function getLoweredIndex(index) {
  if (index.lowered) return index.lowered
  const { texts } = index
  const lower = new Array(texts.length)
  // 独立一份长度数组：个别字符（如 'İ'）小写后长度会变，不能就地改写主视图的 lens。
  const lens = new Int32Array(texts.length)
  let totalLen = 0
  for (let i = 0; i < texts.length; i++) {
    const l = texts[i].toLowerCase()
    lower[i] = l
    lens[i] = l.length || 1
    totalLen += lens[i]
  }
  index.lowered = {
    texts: lower,
    lens,
    entries: index.entries,
    n: index.n,
    avgLen: Math.max(1, totalLen / Math.max(1, texts.length)),
    folded: index.folded,
  }
  return index.lowered
}

function getScanIndex(pool, opts) {
  // 缓存键必须带上**改变语料构成**的选项：同一份 records 用 skipToolCallLogs:false 查一次、
  // 用默认值查一次，若共用一份缓存，第二次就会拿到第一次过滤后的语料 —— 静默少掉记录。
  // （这是实测踩到的坑：feed 进同一 pool、只换选项，结果集却不是该选项该有的样子。）
  const variant = `${opts.skipToolCallLogs === false ? 'raw' : 'clean'}|${opts.foldDuplicates === false ? 'keep' : 'fold'}`
  const key = `${fingerprint(pool)}#${variant}`
  const hit = scanCache.get(key)
  if (hit) {
    // LRU 触碰
    scanCache.delete(key)
    scanCache.set(key, hit)
    return { index: hit, key, cached: true }
  }
  const index = buildScanIndex(pool, opts)
  scanCache.set(key, index)
  if (scanCache.size > CACHE_LIMIT) scanCache.delete(scanCache.keys().next().value)
  return { index, key, cached: false }
}

/**
 * 倒排索引（对外保留的旧接口，形状不变）。
 * search() 不再走它；需要 postings/df 的调用方（调试、导出）仍可用。
 * 与旧版差异：跳过 indexable:false 与工具调用日志。
 */
export function buildIndex(records, opts = {}) {
  const docs = []
  const df = new Map()
  const totals = {}
  for (const r of records) {
    if (!isIndexable(r)) continue
    if (opts.skipToolCallLogs !== false && isToolCallLog(r.body ?? r.text)) continue
    const fields = {
      body: tokenize(r.body ?? r.text ?? ''),
      tags: tokenize((r.tags ?? []).join(' ')),
      entities: tokenize((r.entities ?? []).join(' ')),
      aliases: tokenize((r.aliases ?? []).join(' ')),
      title: tokenize(r.title ?? ''),
    }
    for (const k of Object.keys(fields)) totals[k] = (totals[k] ?? 0) + fields[k].length
    const seen = new Set(Object.values(fields).flat())
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1)
    docs.push({ record: r, fields })
  }
  const n = Math.max(1, docs.length)
  const avgLen = {}
  for (const k of Object.keys(FIELD_WEIGHTS)) avgLen[k] = Math.max(1, (totals[k] ?? 0) / n)
  return { n: docs.length, df, docs, avgLen }
}

function idf(df, n, t) {
  const d = df.get(t) ?? 0
  return Math.log(1 + (n - d + 0.5) / (d + 0.5))
}

function countOccurrences(text, token) {
  let tf = 0
  let p = text.indexOf(token)
  while (p >= 0) { tf++; p = text.indexOf(token, p + token.length) }
  return tf
}

/**
 * 检索。
 * @param {Array} records 已由调用方按权限/项目/状态过滤过的记录
 * @param {string} query
 * @param {{limit?:number, filter?:Function, minCoverage?:number,
 *          skipToolCallLogs?:boolean, foldDuplicates?:boolean}} opts
 * @returns {{query:string, hits:Array<{record:object,score:number,coverage:number}>,
 *            poolSize:number, indexSize:number, indexCacheKey:string, folded:number}}
 */
export function search(records, query, opts = {}) {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 5
  const minCoverage = opts.minCoverage ?? 0.34
  const pool = typeof opts.filter === 'function' ? records.filter(opts.filter) : records
  const qTokens = tokenizeFast(query)
  const uniqQ = [...new Set(qTokens)]
  if (!uniqQ.length) {
    return { query, hits: [], reason: 'empty-query', poolSize: pool.length, indexSize: 0 }
  }
  const { index, key } = getScanIndex(pool, opts)
  if (!index.n) return { query, hits: [], poolSize: pool.length, indexSize: 0, indexCacheKey: key, folded: index.folded }

  // 查询含拉丁字母时 tokenizeFast 已把 query 折成小写，语料也必须折；纯 CJK/emoji 查询
  // 大小写无关，直接扫原文即可（跳过全语料 toLowerCase）。
  const view = needsCaseFold(query) ? getLoweredIndex(index) : index
  const { texts, lens, entries, avgLen, n } = view
  const df = new Map()
  for (const t of uniqQ) df.set(t, 0)
  const cand = []
  for (let i = 0; i < n; i++) {
    const text = texts[i]
    let covered = 0
    for (const t of uniqQ) {
      if (text.indexOf(t) >= 0) { covered++; df.set(t, df.get(t) + 1) }
    }
    if (covered / uniqQ.length >= minCoverage) cand.push({ i, covered })
  }
  const scored = []
  for (const c of cand) {
    const e = entries[c.i]
    const title = texts[c.i]
    const len = lens[c.i]
    let score = 0
    for (const t of uniqQ) {
      const tf = countOccurrences(title, t)
      if (!tf) continue
      const num = tf * (K1 + 1)
      const den = tf + K1 * (1 - B + B * (len / avgLen))
      score += idf(df, n, t) * (num / den)
    }
    if (score <= 0) continue
    score *= (AUTHOR_WEIGHT[e.record.author] ?? 0.7)
    scored.push({ record: e.record, score, coverage: c.covered / uniqQ.length })
  }
  scored.sort((a, b) => b.score - a.score || String(a.record.id).localeCompare(String(b.record.id)))
  return {
    query,
    hits: scored.slice(0, limit),
    poolSize: pool.length,
    indexSize: n,
    indexCacheKey: key,
    folded: index.folded,
  }
}

/** 归一化到 0..1；全相等给 0，不制造假区分度。 */
export function normalize(values) {
  if (!values.length) return []
  const min = Math.min(...values), max = Math.max(...values)
  if (max - min < 1e-9) return values.map(() => 0)
  return values.map((v) => (v - min) / (max - min))
}
