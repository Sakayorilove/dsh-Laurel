/**
 * laurel-memory/memory —— 记忆侧（S05）：记录、检索、纠正、撤销、自动提示。
 *
 * 与经验侧共用：同一事件来源、同一 blob 仓、同一检索入口、同一 revision 失效。
 *
 * 纪律（对应 01 §4.1 与 02 S05）：
 *  1. 区分偏好/要求/当前事实/进展/流水，作者与证据等级保留。
 *  2. 零推理：纯文本 n-gram/BM25，**先过滤权限/项目/状态再评分**。
 *  3. 冲突只列候选，不凭相似度覆盖事实。
 *  4. 自动提示单入口；同轮稳定快照；正文 revision 与使用时间分开。
 *  5. 纠正/撤销/权限变化 → 立即失效未发送的 note。
 *  6. 完整命令/前提不句内截断；超限整条跳过。
 */
import { contentHash, deriveRecordId, validateRecord, RECORD_KINDS, RECORD_STATUS, EVIDENCE_LEVEL } from '../../../laurel-core/lib/format.mjs'
import { search as textSearch } from '../../../laurel-core/lib/textindex.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireWriteLock, RECORD_LOCK_FILE } from './write-lock.mjs'
// 底层追加 IO **只在 capture.mjs 有一份**（fd + write + fsync）。这里改名导入，
// 不复制实现 —— 两份落盘语义就是「journal 有、records 没有」那类分叉的起点。
// 与 capture.mjs 互相 import 是既有形状（capture.mjs:54 早就 import 了本文件的 makeRecord），
// 用到时都是函数调用、不在模块求值期，所以不构成初始化死锁。
import { RECORDS_FILE, appendRecord as fileAppendRecord } from '../capture.mjs'

/**
 * 三档的自动注入预算（01 §2）。
 *
 * ── 契约变更（L06，2026-10-21）────────────────────────────────────────
 * 原为 300 / 600 / 1200。`adapter-dsh.mjs` 的 `INJECT_BUDGET` 提到 800/1000/1200 后
 * **这张表没跟着改**，而 `composeNotes()`（自动注入的真实出口）读的正是这张表 ——
 * 于是预算"改了"却完全不生效：零档实际仍按 300 字符整条跳过，用户依旧读不到完整结论。
 *
 * 两份预算表 = 两个真相，这是本仓栽过一次的坑（`clipResult` 写死过 300，同源）。
 * 现在两表数值一致，并由 `tests/tier-budget-sync.test.mjs` 逐字段深比较锁死：
 * 任一侧再漂移都会红，不靠「记得同步」。
 *
 * 为什么不直接 import adapter 的 INJECT_BUDGET：memory/ 是核心侧，
 * adapter 是宿主适配层，核心反向依赖适配层会把分层倒过来（且 adapter 已 import memory）。
 */
export const TIER_BUDGET = Object.freeze({
  zero: { maxChars: 800, maxNotes: 1 },
  balanced: { maxChars: 1000, maxNotes: 2 },
  full: { maxChars: 1200, maxNotes: 3 },
})

/**
 * 一条记忆记录。身份字段由适配器注入，不接受模型生成。
 */
export function makeRecord(input, { coreId, projectId, environmentId, clock = Date.now }) {
  const at = input.at ?? clock()
  const body = String(input.body ?? '').trim()
  if (!body) throw new Error('body 不能为空')
  const kind = RECORD_KINDS.includes(input.kind) ? input.kind : 'fact'
  const record = {
    id: input.id ?? deriveRecordId({ projectId, kind, body, at }),
    coreId, projectId, environmentId: environmentId ?? null,
    kind,
    body,
    title: input.title ?? null,
    tags: Array.isArray(input.tags) ? input.tags : [],
    entities: Array.isArray(input.entities) ? input.entities : [],
    aliases: Array.isArray(input.aliases) ? input.aliases : [],
    author: input.author ?? 'user',           // user | assistant | tool | system
    evidence: EVIDENCE_LEVEL.includes(input.evidence) ? input.evidence : 'unverified',
    status: RECORD_STATUS.includes(input.status) ? input.status : 'adopted',
    revision: 1,
    contentVersion: contentHash({ body, kind, tags: input.tags ?? [] }),
    source: input.source ?? null,             // {source, sourceVersion, eventId, sessionId, turn, step, toolCallId}
    evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs : [],
    supersedes: Array.isArray(input.supersedes) ? input.supersedes : [],
    createdAt: at,
    updatedAt: at,
    usedAt: null,                             // 与正文 revision 分开
  }
  const problems = validateRecord(record)
  if (problems.length) throw new Error(`记录不合法：${problems.join('; ')}`)
  return record
}

/**
 * 纠正一条记忆：保留旧版本，写新 revision。
 * 不覆盖、不删除；旧版本可查。
 */
export function correctRecord(old, patch, { clock = Date.now } = {}) {
  const body = patch.body !== undefined ? String(patch.body).trim() : old.body
  if (!body) throw new Error('纠正后的 body 不能为空')
  const next = {
    ...old,
    body,
    kind: patch.kind && RECORD_KINDS.includes(patch.kind) ? patch.kind : old.kind,
    tags: patch.tags ?? old.tags,
    revision: (old.revision ?? 1) + 1,
    contentVersion: contentHash({ body, kind: patch.kind ?? old.kind, tags: patch.tags ?? old.tags }),
    // supersedes 表示"本条取代了哪些**别的**记录"，不该把自己写进去。
    // 原来的 [...(old.supersedes ?? []), old.id] 有两个问题：
    //   1. 写的是自身 id（同一对象原地修订），等于自引用
    //   2. 连续纠正会把同一个 id 重复累积成 ["r-x","r-x"]
    // 修订前后同 id 时不需要记录取代关系 —— 版本变化由 revision 与 contentVersion 表达；
    // 只有换 id 的场景才追加。
    // supersedes 记录"这一条被修订过"的痕迹（原地修订时 id 不变，记的就是自身 id）。
    // 用 Set 去重：连续纠正多次不应把同一个 id 累积成 ["r-x","r-x","r-x"]。
    supersedes: [...new Set([...(old.supersedes ?? []), old.id])],
    updatedAt: clock(),
  }
  return next
}

/** 撤销：状态置 revoked，内容版本变化，所有派生视图必须失效。 */
export function revokeRecord(record, { reason, actor = 'user', clock = Date.now } = {}) {
  return {
    ...record,
    status: 'revoked',
    revokedReason: reason ?? null,
    revokedBy: actor,
    revision: (record.revision ?? 1) + 1,
    contentVersion: contentHash({ revoked: true, at: clock(), reason: reason ?? null, prev: record.contentVersion }),
    updatedAt: clock(),
  }
}

/**
 * 检索：先过滤（项目/状态/权限），再评分。
 * @param {Array} records
 * @param {string} query
 * @param {{projectId?:string, environmentId?:string, limit?:number, includeCandidates?:boolean, allowedProjects?:string[]}} opts
 */
export function searchMemory(records, query, opts = {}) {
  const allowed = opts.allowedProjects ? new Set(opts.allowedProjects) : null
  const filter = (r) => {
    if (r.status === 'revoked' || r.status === 'retired') return false
    if (!opts.includeCandidates && r.status === 'candidate') return false
    if (opts.projectId && r.projectId !== opts.projectId) return false
    if (opts.environmentId && r.environmentId !== opts.environmentId) return false
    if (allowed && !allowed.has(r.projectId)) return false
    return true
  }
  return textSearch(records, query, { ...opts, filter })
}

/**
 * 冲突检测：同项目同 kind 的高相似内容只**列出候选**，不自动覆盖。
 * 用 token 覆盖率做粗判，不做语义断言。
 */
export function findConflicts(records, incoming, { threshold = 0.6 } = {}) {
  const base = textSearch(records, incoming.body, {
    limit: 10,
    filter: (r) => r.projectId === incoming.projectId && r.kind === incoming.kind && r.status !== 'revoked' && r.id !== incoming.id,
  })
  return base.hits.filter((h) => h.coverage >= threshold).map((h) => ({ record: h.record, score: h.score, coverage: h.coverage }))
}

/**
 * 组装自动提示（单入口）。
 * 规则：同轮稳定快照；超预算整条跳过（不句内截断）；无命中不注入。
 */
/**
 * 一条 note 被截断后至少要留下多少字符。
 *
 * 手册 §4.1 L06 的判据是「零档 300 字符读不到一段完整结论」，800 才是下限。
 * 那条讲的是**整档预算**；这里是「剩余额度少于多少就不再往里塞」。
 * 取 200：一句中文 60–80 字符，200 能留下两三句完整的话 + 省略标记，
 * 比只留半句或者干脆丢掉都更能让模型判断「这条与我有关/无关」。
 */
export const NOTE_MIN_CHARS = 200

/** 截断标记。把省略字数写出来，读的人才知道自己没看到全文。 */
export function noteCutMarker(omitted) {
  return `…（省略 ${omitted} 字符）`
}

/**
 * 把一行 note 压进 avail 字符里，不足则截断并标注省略字数；
 * 剩余额度连 NOTE_MIN_CHARS 都不够时返回 null（由调用方记为 char-budget 跳过）。
 *
 * 迭代是因为标记里的省略字数本身占位：切得越多数字位数可能越少，所以要收敛。
 */
export function fitNote(line, avail) {
  const text = String(line ?? '')
  const room = Math.floor(Number(avail))
  if (!Number.isFinite(room) || room <= 0) return null
  if (text.length <= room) return { text, cut: false, omitted: 0 }
  if (room <= NOTE_MIN_CHARS) return null
  let keep = text.length
  for (let i = 0; i < 8; i++) {
    const mark = noteCutMarker(text.length - keep)
    const next = Math.max(1, room - mark.length)
    const out = text.slice(0, next) + noteCutMarker(text.length - next)
    if (out.length <= room) return { text: out, cut: true, omitted: text.length - next }
    const over = out.length - room
    if (next - over < 1) break
    keep = next - over
  }
  // 兜底：连标记都放不下时退化成纯省略号（保证返回值一定不超过 room）。
  const fallback = text.slice(0, Math.max(0, room - 1)) + '…'
  return { text: fallback, cut: true, omitted: text.length - Math.max(0, room - 1) }
}

/**
 * 组装自动提示（单入口）。
 *
 * 返回值里两个字段是 S5 之后才有的，别删：
 *   - `reason` 四档：`no-data`（没有东西可注入）/ `no-hit`（有东西但没命中）/
 *     `error`（检索坏了）/ `tier-disabled`（档位主动关掉）。前三档互斥，
 *     见函数体里的判据说明。
 *   - `notes[].at`：这条记录说的事发生在什么时候（毫秒）。渲染层据此算「距今 N 天」，
 *     拿不到就是 null —— 宁可不标，也不编一个日期。
 */
export function composeNotes(records, query, { tier = 'zero', projectId, snapshotKey, clock = Date.now } = {}) {
  const budget = TIER_BUDGET[tier] ?? TIER_BUDGET.zero
  if (tier === 'zero' && budget.maxNotes === 0) return { notes: [], reason: 'tier-disabled', snapshotKey }
  // ── 三档状态（S9.3）────────────────────────────────────────────────────
  // 原来只有 no-hit / tier-disabled，于是「**没有东西可注入**」（仓是空的、一条都
  // 没有）与「**有东西但没命中**」（仓里有 2,860 条，只是这次没匹配上）报成同一个
  // 词。从外面看这两件事一模一样，可处理方式完全相反：前者要去查采集链，后者
  // 只是这句提问跟记忆无关。加上 error（真坏了）一共三档，外加 tier-disabled。
  //
  // 判据放在**能不能拿到候选集**这一层，而不是看命中数：records 为空 = 没数据；
  // 检索抛错 = 坏了；检索正常但 0 命中 = 没命中。三者互斥，不靠猜。
  const source = Array.isArray(records) ? records : []
  if (!source.length) return { notes: [], reason: 'no-data', snapshotKey, at: clock() }
  let found
  try {
    found = searchMemory(source, query, { projectId, limit: budget.maxNotes * 3 })
  } catch (error) {
    return { notes: [], reason: 'error', error: String(error?.message ?? error), snapshotKey, at: clock() }
  }
  if (!found?.hits?.length) return { notes: [], reason: 'no-hit', snapshotKey }
  const notes = []
  let chars = 0
  const skipped = []
  for (const hit of found.hits) {
    const r = hit.record
    const line = `[${r.kind}] ${r.body}`
    if (notes.length >= budget.maxNotes) { skipped.push({ id: r.id, reason: 'note-cap' }); continue }
    // L06 余量缺陷（2026-10-22 真机）：原来这一行 `chars + line.length > maxChars` 就整条丢。
    // 真仓 zero 档 maxChars=800，而 log 类正文 avg=1435 —— **一条都放不进去**，
    // 于是一个字都不注入，端点却报 state:'ok'。装不下就截断，把省略字数标出来；
    // 只有剩余额度已经不够一句完整的话（< NOTE_MIN_CHARS）才真丢。
    const fitted = fitNote(line, budget.maxChars - chars)
    if (!fitted) { skipped.push({ id: r.id, reason: 'char-budget', need: line.length, avail: budget.maxChars - chars }); continue }
    // `at` 是**这条记录说的事**发生在什么时候，给 S5 的「距今 N 天」用。
    // 取 createdAt 而不是 updatedAt：纠正只改措辞，不该让一条三年前的结论看起来像今天写的
    // —— 年龄要标的是"这个说法多旧了"，不是"最后一次改字是什么时候"。
    // 两个字段都可能缺（外部导入 / 旧行），缺就传 null：拿不到年龄就不标，绝不猜。
    const at = Number.isFinite(r.createdAt) ? r.createdAt : (Number.isFinite(r.at) ? r.at : null);
    notes.push({ id: r.id, revision: r.revision, contentVersion: r.contentVersion, kind: r.kind, at, text: fitted.text, coverage: hit.coverage, ...(fitted.cut ? { truncated: true, omitted: fitted.omitted } : {}) })
    chars += fitted.text.length
  }
  if (!notes.length) {
    // ── 第四档：命中了、但一条都没留下（S9.3）─────────────────────────────
    // **这条分支目前用当前预算表打不到**（三档 maxChars 都 >= 800 > NOTE_MIN_CHARS，
    // 第一条命中总能用 fitNote 截出一段），写在这里是因为它守的是一条**不变量**：
    // 只要一条 note 都没产出，`reason` 就必须是显式的原因，不许留 undefined
    // 让调用方取下一位 —— inject.mjs 原来的写法就是 `composed.reason ?? 'no-hit'`，
    // 于是"预算不够"被报成"没命中"，排查跟着跑去查采集链（L06 46 步 0 注入那次
    // 就是这个形状，只不过当时 fitNote 还不存在，走的是更早的整条丢弃）。
    // 措辞上也刻意不叫 no-hit：仓里有东西、这次也匹配上了，只是额度不够。
    return { notes: [], chars: 0, budget, skipped, snapshotKey, reason: 'char-budget', at: clock() }
  }
  return { notes, chars, budget, skipped, snapshotKey, at: clock() }
}

/**
 * 校验一组"未发送的 note"是否仍然有效。
 * 纠正/撤销/权限变化后，旧 revision 必须被判失效。
 */
export function validateNotes(notes, currentRecords, { allowedProjects } = {}) {
  const byId = new Map(currentRecords.map((r) => [r.id, r]))
  const allowed = allowedProjects ? new Set(allowedProjects) : null
  return notes.map((n) => {
    const cur = byId.get(n.id)
    if (!cur) return { ...n, valid: false, reason: 'gone' }
    if (cur.status === 'revoked' || cur.status === 'retired') return { ...n, valid: false, reason: 'revoked' }
    if (cur.revision !== n.revision || cur.contentVersion !== n.contentVersion) return { ...n, valid: false, reason: 'content-changed' }
    if (allowed && !allowed.has(cur.projectId)) return { ...n, valid: false, reason: 'permission-changed' }
    return { ...n, valid: true }
  })
}

/* ─────────────────── 记录写入：锁 + 三重复核（S7）─────────────────── */

/**
 * 为什么写入口在这个文件里，而不是在 \`capture.mjs\` 的 \`appendRecord\` 里
 *
 * 本包有**两个**同名函数，职责完全不同（S7 任务书特别点出这一条）：
 *
 *   capture.mjs:377 \`appendRecord(vaultDir, record)\`
 *     底层 IO：\`openSync(file,'a')\` + \`writeSync\` + \`fsyncSync\`。它只保证「这一行
 *     写完并落盘」，不知道 revision、不知道谁基于哪个版本改、也不能失败得悄无声息
 *     （P0-2：journal 是权威、records 是读侧视图）。真实调用点是采集路径
 *     \`capture.mjs:938\`、reconcile 重建 \`capture.mjs:546\`、管理面更正/撤销
 *     \`admin-api.mjs:298/322\`。这些**都是「新记录第一次落库」或「journal 已经
 *     提交之后的视图补写」**，没有「基于旧版本改」的语义。
 *
 *   本文件的 \`appendRecord(vaultDir, record, opts)\`（新增）
 *     写入**入口**：拿锁 → 三重复核 → 追加 → 还锁。「这条记录基于哪个版本」在这个
 *     层次才有意义。复核放在底层 IO 里做不到 —— 那里没有调用方的 baseRevision。
 *
 * 两条路径的关系是**上下层**，不是两份实现：
 *   - 写用 \`appendRecord\`（入口）：抢不到锁就如实报 \`locked\`，不阻塞宿主；
 *   - 读用 \`capture.mjs\` 的 \`loadRecords\`：同口径（同 id 取 revision 最高那条），
 *     复核要读的「当前 revision」就来自它 —— 只有一份读语义。
 * 且 \`appendRecord\` 内部**直接调用** \`fileAppendRecord\`（capture.mjs 那两个），
 * 不重写一遍 fd + fsync：那会得到第二套落盘语义，正是 P0-2 忌惮的分叉来源。
 */

/** 记录侧的锁文件名在这里再导出一次：调用方不必知道锁实现在哪。 */
export { RECORD_LOCK_FILE }

/**
 * \`id\` 在 records.jsonl 里的当前版本。**只认盘，不认内存**。
 *
 * 为什么不用 \`loadRecords()\`：真仓实测 5.5 万行 / 108MB，全量 \`JSON.parse\`
 * 352ms + 整文件读 594ms —— 注入侧每一步都可能写一条，把这个代价挂在每条写入上
 * 是拿一个「每步几百毫秒」的延迟换一个「每几分钟才发生一次」的并发保护。
 * 这里改成**字节扫描**：只认行内 \`"id":"\` 之后的 id 与 \`"revision":\` 之后的数字，
 * 不 JSON.parse、不建整条对象（同一份真仓实测 264ms，且只在真的需要复核时才走）。
 *
 * 扫描的安全性依赖两条本仓自己保证的格式约定，写在这里以免以后被改坏：
 *   1. 记录 id 由 \`deriveRecordId\` 生成（\`r-\` + 十六进制），\`contentVersion\`
 *      是十六进制串，**都不含引号与转义**，所以按引号截断是精确的；
 *   2. records.jsonl 一行就是一条完整 JSON（\`JSON.stringify\` 产物），字段不跨行。
 * 万一格式漂了，最坏结果是多取一个脏 id —— 复核只会**多判**「版本不一致」，
 * 也就是多抛一次错，而不会把不一致判成一致。
 *
 * @returns {{exists:boolean, found:boolean, revision:number|null, contentVersion:string|null, status:string|null, file:string}}
 */
export function recordVersionOnDisk(vaultDir, id) {
  const file = join(vaultDir, RECORDS_FILE)
  const out = { exists: false, found: false, revision: null, contentVersion: null, status: null, file }
  if (!vaultDir || typeof id !== 'string' || !id) return out
  let buf
  try { buf = readFileSync(file) } catch { return out }
  out.exists = true
  const idNeedle = Buffer.from('"id":"' + id + '"', 'utf8')
  const revNeedle = Buffer.from('"revision":', 'utf8')
  const cvNeedle = Buffer.from('"contentVersion":"', 'utf8')
  const stNeedle = Buffer.from('"status":"', 'utf8')
  let pos = 0
  const strAt = (start) => {
    const end = buf.indexOf(0x22, start)
    return end < 0 ? null : buf.toString('utf8', start, end)
  }
  const numAt = (start) => {
    let end = start
    while (end < buf.length) {
      const c = buf[end]
      if ((c >= 0x30 && c <= 0x39) || c === 0x2d) end += 1
      else break
    }
    const n = Number.parseInt(buf.toString('utf8', start, end), 10)
    return Number.isFinite(n) ? n : null
  }
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos)
    const lineEnd = nl < 0 ? buf.length : nl
    // 只在**本行范围**内找 id：找全文第一次出现会把后面的命中提前带进来，
    // 行边界判断就失效了（最后一行 / 前面的行没有新行符时会漏）。
    const at = idNeedle.length ? buf.subarray(pos, lineEnd).indexOf(idNeedle) : -1
    const hit = at < 0 ? -1 : pos + at
    if (hit < 0) { pos = lineEnd + 1; continue }
    pos = hit
    // 命中本 id：同 id 取 revision 最高的一条（与 loadRecords 同口径）。
    const revAt = buf.indexOf(revNeedle, at)
    const rev = revAt >= 0 && revAt < lineEnd ? numAt(revAt + revNeedle.length) : null
    const cvAt = buf.indexOf(cvNeedle, at)
    const cv = cvAt >= 0 && cvAt < lineEnd ? strAt(cvAt + cvNeedle.length) : null
    const stAt = buf.indexOf(stNeedle, at)
    const st = stAt >= 0 && stAt < lineEnd ? strAt(stAt + stNeedle.length) : null
    if (rev === null ? !out.found : (out.revision === null || rev >= out.revision)) {
      out.found = true
      out.revision = rev ?? 1
      out.contentVersion = cv
      out.status = st
    }
    pos = lineEnd + 1
  }
  return out
}

/**
 * \`baseInvalid\` 归一成布尔。为什么接受三种写法：S7 的判据是「这条记录当时是不是
 * 处于失效态」，而调用方手里的说法不一 ——
 *   \`false\` / \`true\`       直接就是「是否失效」；
 *   \`undefined\`            调用方**不做**这条断言（不是「断言它有效」）；
 *   \`'revoked'\` / 数组     「必须处于这些状态之一」，这是面板/导出那边更自然的说法。
 * 归一之后只有两种结果，判定式子才写得干净：\`invalid !== baseInvalid\` 即抛。
 */
export function normalizeInvalidAssertion(baseInvalid) {
  if (baseInvalid === undefined) return undefined
  if (typeof baseInvalid === 'boolean') return baseInvalid
  if (Array.isArray(baseInvalid)) return baseInvalid.some((s) => s === 'revoked' || s === 'retired')
  return String(baseInvalid) === 'revoked' || String(baseInvalid) === 'retired'
}

/** 一条记录是否处于「失效态」。只有这两个状态算：candidate/trial 都还能被采用。 */
export function isInvalidRecord(record) {
  return record?.status === 'revoked' || record?.status === 'retired'
}

/**
 * 三重复核里的**两重版本断言**（第三重是锁本身：没持有当前 epoch 就不许写）。
 *
 * 来自 \`store.mjs:109\` 与 \`store.mjs:112\` —— 那两条注释把「为什么要分开」讲透了：
 *   - \`baseRevision\` 防的是**覆盖较新版本**（A 读到 rev1，B 改成 rev2，A 再写就该失败）；
 *   - \`baseInvalid\` 防的是**失效期间重发旧内容**：失效（revoke/retire）**刻意不改
 *     revision 的语义**，一个「撤销 → 又重新采用」的来回之后 revision 可能看起来没变，
 *     但 record 已经被污染过一轮了。所以失效态必须**单独**当一道栅栏，不能靠
 *     revision 顺带覆盖。
 *
 * 不一致就抛，**不写**（调用方拿到错误可以重读后重试；静默覆盖没有任何挽回手段）。
 */
export function assertRecordBase(vaultDir, record, { baseRevision, baseInvalid } = {}) {
  const disk = recordVersionOnDisk(vaultDir, record?.id)
  if (baseRevision !== undefined) {
    const current = disk.found ? disk.revision : 0
    if (current !== baseRevision) {
      throw new Error(
        '记录 ' + String(record?.id) + ' 已不是 ' + baseRevision + ' 版（盘上是 ' + current + '）；未写入，请重读后再改',
      )
    }
  }
  const want = normalizeInvalidAssertion(baseInvalid)
  if (want !== undefined) {
    const current = disk.found ? disk.status : null
    const isInvalid = current === 'revoked' || current === 'retired'
    if (isInvalid !== want) {
      throw new Error(
        '记录 ' + String(record?.id) + ' 的失效状态已改变（盘上 status=' + String(current) + '）；未写入',
      )
    }
  }
  return disk
}

/** 没变化不算新版本：判据 = 正文 + 内容版本 + kind + status 都没动（store.mjs:137 同一口径）。 */
export function sameRecordContent(old, next) {
  if (!old || !next) return false
  return old.body === next.body
    && old.contentVersion === next.contentVersion
    && (old.kind ?? null) === (next.kind ?? null)
    && (old.status ?? null) === (next.status ?? null)
}

/**
 * 写一条记录到 \`memory/records.jsonl\`：**拿锁 → 复核 → 追加 → 还锁**。
 *
 * 与 \`capture.mjs:377\` 的 \`appendRecord\`（底层 IO）不是一个函数，关系见本节头注释。
 *
 * @param {string} vaultDir 核心仓根
 * @param {object} record   已经过 \`makeRecord\`/\`correctRecord\` 的完整记录
 * @param {{baseRevision?:number, baseInvalid?:boolean|string|string[], allowSameContent?:boolean,
 *          waitMs?:number, ttlMs?:number}} opts
 * @returns {{ok:boolean, written:boolean, deduped?:boolean, revision?:number, record?:object,
 *           epoch?:number, reason?:string, error?:string, holder?:object|null}}
 */
export function appendRecord(vaultDir, record, opts = {}) {
  if (!vaultDir) return { ok: false, written: false, reason: 'no-vault' }
  if (!record || typeof record.id !== 'string' || !record.id) return { ok: false, written: false, reason: 'bad-record' }
  const lock = acquireWriteLock(vaultDir, { waitMs: opts.waitMs, ttlMs: opts.ttlMs })
  if (!lock.ok) {
    // 抢不到锁**不抛、不阻塞**：调用方按 reason 计数，下一轮重试。
    // 这里的失败必须与"写成功"长得完全不一样，否则又会变成静默丢失。
    return { ok: false, written: false, reason: 'locked', lockReason: lock.reason, holder: lock.holder ?? null }
  }
  try {
    const disk = assertRecordBase(vaultDir, record, opts)
    // 没变化不算新版本：盘上这条已经是同样的正文与内容版本 → 原样返回旧对象，
    // 不追加、不涨 revision。判据要读**盘上**的整条，而不是只看 revision —— 正文
    // 相同但 revision 不同（例如被撤销过又改回来）是两件不同的事，不能省。
    if (opts.allowSameContent !== false && disk.found) {
      const onDisk = loadRecordById(vaultDir, record.id)
      if (sameRecordContent(onDisk, record)) {
        return { ok: true, written: false, deduped: true, revision: onDisk.revision, record: onDisk, epoch: lock.epoch }
      }
    }
    fileAppendRecord(vaultDir, record)
    return { ok: true, written: true, revision: record.revision ?? 1, record, epoch: lock.epoch }
  } catch (error) {
    return { ok: false, written: false, reason: 'base-mismatch', error: String(error?.message ?? error) }
  } finally {
    // 释放必须在 finally：写失败也要放锁，否则一次 EACCES 就让记录侧永久 locked。
    try { lock.release?.() } catch { /* 释放失败不掩盖写入结果 */ }
  }
}

/**
 * 按 id 读盘上的最新版本（整条）。
 * 用于「没变化不算新版本」的判定 —— 那条判据要比正文，光有 revision 不够。
 * 命中才解析，其余行碰都不碰。
 */
export function loadRecordById(vaultDir, id) {
  if (!vaultDir || typeof id !== 'string' || !id) return null
  const file = join(vaultDir, RECORDS_FILE)
  let buf
  try { buf = readFileSync(file) } catch { return null }
  const needle = Buffer.from('"id":"' + id + '"', 'utf8')
  let best = null
  let pos = 0
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos)
    const lineEnd = nl < 0 ? buf.length : nl
    const at = buf.indexOf(needle, pos)
    if (at < 0 || at >= lineEnd) break
    try {
      const rec = JSON.parse(buf.toString('utf8', pos, lineEnd))
      if (rec?.id === id && (!best || (rec.revision ?? 1) >= (best.revision ?? 1))) best = rec
    } catch { /* 坏行跳过：读侧本来就有坏行计数这一说 */ }
    pos = lineEnd + 1
  }
  return best
}

/* ─────────────────── 使用时间回写（S5）─────────────────── */

/**
 * 把一条记录的 `usedAt` 抬到 `now`：**只动 usedAt，不动 revision / contentVersion**。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * §2.6 实测：真仓 55,129 条记录里 `usedAt` 有值的 **0 条**。"字段在、初始化为 null、
 * 没有任何写入方"——这正是「没人写的状态文件等于没有状态」。注入了哪些记忆、
 * 哪条真的被用过，从数据上完全看不出来。
 *
 * ── 为什么是「再追加一行」而不是「原地改文件」────────────────────────────
 * records.jsonl 是**只追加**的读侧视图：就地改一行要重写整个 108MB 文件，
 * 而且会破坏「journal 权威、records 可重建」这条分层（重建后的行里没有 usedAt）。
 * 追加新版本是这份文件本来就支持的形态——读侧 `loadRecords` / `recordVersionOnDisk`
 * 一律「同 id 取 revision 最高那条」。这里刻意**不涨 revision**：
 * 使用时间不是内容版本，§4 的纪律第 4 条要求两者分开（正文 revision 与使用时间分开）。
 * 两行的 revision 相同，读侧取到的是后写的那行（>= 比较，见 loadRecords），
 * 于是 usedAt 生效而 contentVersion 不变——正是 `validateNotes` 想要的。
 *
 * ── 代价（写清楚，不要以后被当成 bug）────────────────────────────────
 * 追加的这一行是**整条记录**（含 body）：records.jsonl 一行就是一条完整 JSON，
 * 写成 `{id, usedAt}` 这样的瘦行会被 `loadRecords` 当成"这个 id 的最新版"，
 * 于是正文消失。所以 usedAt 的代价 = 一条正文大小 × 回写次数。
 * 真仓可检索正文合计 6.0MB，注入一次通常 1–3 条 —— 靠调用方的节流
 * （inject.mjs 的 `usedAtMinIntervalMs`，默认 5 分钟）把这个代价压到可忽略。
 *
 * ── 为什么可以不拿锁 ─────────────────────────────────────────────────
 * 追加 + fsync 是 O_APPEND 的原子操作（capture.mjs:377 的 appendRecord 已验证这条路），
 * 而本函数与其它写者的唯一冲突是「同一条记录同时被 usedAt 附加与正文修订」——
 * 那时显式传 `baseRevision` 就会拿到 base-mismatch，交回调用方下一轮重试即可。
 * 注入侧是每步都可能跑的热路径，为它去抢一把租约锁，代价（一次 open/write/rename）
 * 远大于收益（usedAt 的精度是"最近用过"，丢一次不影响语义）。
 *
 * @returns {{ok:boolean, written:boolean, reason?:string, usedAt?:number, record?:object}}
 */
export function stampUsedAt(vaultDir, id, {
  now = Date.now(),
  baseRevision,
  minIntervalMs = 0,
  record = null,
} = {}) {
  if (!vaultDir || typeof id !== 'string' || !id) return { ok: false, written: false, reason: 'no-vault' }
  // `record` 是调用方**刚读到的**那一版（注入侧手里就有：它刚从自己的增量缓存里
  // 挑出这条）。给了就不读盘 —— 真仓 108MB / 5.5 万行，一次 `loadRecordById` 要
  // 594ms，挂在"每步都可能跑"的注入路径上等于把 pre-step 变成瓶颈。
  // 不给才读盘（CLI / 测试 / 没有缓存的调用方）。
  const current = record && record.id === id ? record : loadRecordById(vaultDir, id)
  if (!current) return { ok: false, written: false, reason: 'not-found' }
  if (baseRevision !== undefined && (current.revision ?? 1) !== baseRevision) {
    // 拿到的正文已经不是我注入的那一版了：不回写，交回调用方（它下一轮会重投新版）。
    return { ok: false, written: false, reason: 'base-mismatch', revision: current.revision ?? 1 }
  }
  const prev = Number.isFinite(current.usedAt) ? current.usedAt : null
  // 节流：同一档位里短时间内重复命中同一条，不值得每步都追加一行。
  // 0 表示不节流（默认），由调用方按自己的热度决定。
  if (prev !== null && minIntervalMs > 0 && now - prev < minIntervalMs) {
    return { ok: true, written: false, reason: 'throttled', usedAt: prev }
  }
  const next = { ...current, usedAt: now }
  try {
    fileAppendRecord(vaultDir, next)
  } catch (error) {
    // 回写失败**绝不能**让注入失败：这一条记忆已经要进请求了，
    // 丢了 usedAt 只是少一份统计，丢了注入是用户当场读不到结论。
    return { ok: false, written: false, reason: 'append-failed', error: String(error?.message ?? error) }
  }
  return { ok: true, written: true, usedAt: now, previousUsedAt: prev, record: next }
}

/** 原文分页：正文按需读，不一次全塞回窗口。 */
export function pageBody(records, id, { offset = 0, lines = 40 } = {}) {
  const r = records.find((x) => x.id === id)
  if (!r) return { ok: false, reason: 'not-found' }
  const all = r.body.split('\n')
  const slice = all.slice(offset, offset + lines)
  return { ok: true, id, total: all.length, offset, lines: slice.length, text: slice.join('\n'), hasMore: offset + lines < all.length }
}
