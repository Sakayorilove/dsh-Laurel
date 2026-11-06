/**
 * laurel-memory/inject —— L03：让记忆**真的**进到每一轮请求里。
 *
 * ── 这个文件为什么存在（缺陷 L03，2026-10-22）─────────────────────────────
 * `lib/index.js` 里 `ctx.provide('laurel.memoryCore', {... renderPrefix ...})`
 * 一直挂着 `renderPrefix`，但全仓 `grep -rn renderPrefix` 只有**它自己那一行**：
 * 零消费者。也就是说「自动注入」这件事在代码里存在了几个月，实际一条 note
 * 都没进过模型请求 —— 单测全绿，因为单测直接调 `renderStablePrefix()` 断言
 * 字符串形状，从不问「谁在什么时机把它塞进哪一批消息」。
 *
 * 真实接缝只有两个（读 `dsh-warden/lib/host/inject.js` 的一手实现得出）：
 *
 *  1. `agent/pre-step`（**主路**）：waterfall `(payload, next) => decision`，
 *     payload = `{ messages, turn, step, signal, agent }`。
 *     纪律：先 `await next()` 拿最终批次，再 spread 改，只认 `decision.kind === 'enter'`。
 *     `messages` 是**本轮待追加的那一批新消息**（不是完整历史）—— 所以这里
 *     只用它做「本轮在说什么」的查询词，不指望从它读到旧上下文。
 *
 *  2. `systemPrompt.section()`（可选增强）：宿主根本不给 section 时
 *     （实测本机 `dsh-warden` 常报 `降级=rulesSection`）必须能降级，
 *     不能因为拿不到 section 就整块不注入。本文件只用它做「如果宿主有就加一段」，
 *     主路仍是 pre-step。
 *
 * 注入消息的形状是硬约束（手册陷阱 8 + 采集侧现实）：
 *   - `source.kind` 必须有，且是**本插件自己的名字**（不用 `plugin`/`injection`
 *     这种通用名，否则事后分不清是谁注入的）；
 *   - `content` 必须是 ContentBlock 数组（陷阱 9）；
 *   - 这条消息会被 `capture.mjs` 的 `authorKindOf` 看到。它把未知 `source.kind`
 *     原样当角色名回，于是会落到 `classifyAuthor → 'unknown' → 'unknown-author'`
 *     被拒采 —— 结果对（不会被采集回仓），但理由写错了。所以
 *     `capture.mjs` 的 `INJECTED_SOURCE_KINDS` 里同时加上了本名字（见那边注释），
 *     让「不采集」的原因是「这是插件注入」，而不是「身份不明」。
 *
 * 性能：核心仓 `memory/records.jsonl` 在本机已到 70MB / 3.4 万条。
 * 每一步都 `loadRecords()` 全量重读是几百毫秒级，会把 pre-step 变成瓶颈。
 * 这里用**增量读**：记住已读字节偏移，只解析新追加的行；文件变小（被轮转/
 * 重写）才整份重来。records.jsonl 只追加（`appendRecord`），这个前提成立。
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveQueryScope } from './capture.mjs'
import { EPISODES_FILE, loadEpisodes, episodeSearchable, episodeToRow } from './projection.mjs'
import { composeNotes, TIER_BUDGET, stampUsedAt } from './memory/index.mjs'
import { isSelfEchoRecord, renderStablePrefix } from './adapter-dsh.mjs'

/** 注入消息的 `source.kind`。用本插件名，别用通用 `plugin`。 */
export const INJECT_SOURCE_KIND = 'laurel-memory'

/** 注入块的开头标记。采集/回放/排查都靠它认出来。 */
export const INJECT_MARKER = '<laurel-memory>'

/** 查询词最多取多少字符：一个 user 消息动辄几千字，整段当 query 会把检索稀释成噪声。 */
const QUERY_MAX_CHARS = 400

/**
 * 会话级字符预算（S5，照 ZCode `recall/index.ts:20` 的
 * `MEMORY_RECALL_SESSION_CHARACTER_LIMIT = 61,440`）。
 *
 * 三档预算（800/1000/1200）管的是**一次**注入；这个数管的是**一场会话**。
 * 没有它，一个 200 步的会话最坏能注进 20 万字符 —— 步骤数不设限，而记忆
 * 每轮都在重投（尤其在"内容版本变了就重投"这条上线之后）。
 * 61,440 = 60 KiB，按本仓 zero 档 800 字符算等于 76 次满额注入。
 */
export const SESSION_CHAR_BUDGET = 61_440

/**
 * `usedAt` 回写的最小间隔（毫秒）。
 *
 * 回写是**一次真实的文件追加 + fsync**，而注入是每步都可能跑的路径。同一场会话里
 * 反复命中同一条记忆（很常见：用户在一个话题上来回问）没必要每步都写一行。
 * 5 分钟：足够把「写盘次数」压到一双手数得过来，又不至于让 usedAt 落得比
 * 使用者记得的还旧。可以按注入器逐个覆盖（`usedAtMinIntervalMs`）。
 */
const USED_AT_MIN_INTERVAL_MS = 5 * 60 * 1000

/**
 * 「本次没注入」的原因分几类。分类的意义在于**下一步该查哪儿**：
 *   - `no-data`   仓里没有可注入的记录 → 查采集链，不是查检索
 *   - `no-hit`    有记录但这次没匹配 → 别当故障
 *   - `error`     检索/索引真的坏了 → 报警
 *   - `already-injected-this-session` / 预算类 → 一切正常，只是不必再发
 * 原来的实现只有 no-hit 一个词，前三种从外面看完全一样。
 */
export const SKIP_REASONS = Object.freeze({
  noData: 'no-data',
  noHit: 'no-hit',
  error: 'error',
  alreadyInjected: 'already-injected-this-session',
  sessionBudget: 'session-budget-exhausted',
  // 笔记一条都没留下（命中了但额度不够）。目前预算表打不到这条（见 composeNotes 的说明），
  // 但它和 no-hit 是**两个方向**的排查：一个看预算，一个看检索。
  charBudget: 'char-budget',
  emptyQuery: 'empty-query',
  tierDisabled: 'tier-disabled',
})

/** 单条消息里拼进查询的词法量上限（防止超大粘贴把 regex 拖死）。 */
const MAX_MESSAGES_FOR_QUERY = 4

/**
 * 宿主/插件自己塞进 user 角色的那些块，**不是**用户在说话。
 *
 * 真跑证据：宿主每一轮都会往 messages 里追加一条 `<system-reminder>`（技能清单，
 * 300+ 字符）。原实现只跳过我们自己注入的 `<laurel-memory>`，于是这条提醒被当成
 * 用户原话吃掉了 400 字符查询预算里的 347 字符 —— 用户真正说的话只剩 53 字符，
 * `composeNotes` 命中 0 条，端点看着像「注入面在跑」（steps 一直涨）却
 * `injected: 0 / skipped: 46 / lastReason: "empty-query"`。
 *
 * 判据用「块的开头」而不是「全文包含」：用户在正文里讨论 `system-reminder`
 * 这个词本身是很常见的（本仓的排查记录里就有），按包含判会把正常提问整条丢掉。
 */
const INJECTED_TEXT_HEADS = ['<system-reminder>', '<available_skills>', INJECT_MARKER]

/** 这一段文本是不是宿主/插件注入的（不是用户原话）。 */
export function isInjectedText(text) {
  if (typeof text !== 'string') return false
  const head = text.replace(/^\s+/, '')
  for (const marker of INJECTED_TEXT_HEADS) {
    if (head.startsWith(marker)) return true
  }
  // 个别宿主把技能清单单独成块、前面还有别的包裹标记，退一步按「含 available_skills 结构」判。
  return head.includes('<available_skills>') && head.includes('</available_skills>')
}

function asString(value) {
  return typeof value === 'string' ? value : null
}

/**
 * 从一堆消息里取出「本轮在说什么」。
 *
 * 只认 user 角色、只取 text block、从后往前拼（最近的话最相关），
 * 拼到 `QUERY_MAX_CHARS` 就停。找不到就返回空串 —— 空串不是错误，
 * 调用方据此跳过注入（`composeNotes` 对空 query 没有命中，不会瞎注入）。
 */
export function queryFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const parts = []
  let used = 0
  for (let i = messages.length - 1; i >= 0 && parts.length < MAX_MESSAGES_FOR_QUERY; i -= 1) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    if (m.source?.kind && m.source.kind !== 'user') continue
    const blocks = Array.isArray(m.content) ? m.content : []
    const texts = []
    for (const b of blocks) {
      if (!b || b.type !== 'text' || typeof b.text !== 'string' || !b.text) continue
      // **逐块**跳过宿主/插件注入的内容：既包括我们自己注入的（下一轮不该拿上一轮的
      // 注入内容当查询词，会自我强化），也包括宿主的 `<system-reminder>` 技能清单 ——
      // 后者 300+ 字符，会整块吃满 QUERY_MAX_CHARS 预算，让真实提问命中为 0。
      //
      // 必须按块判、不能按整条消息判：宿主会把技能清单和用户原话塞进**同一条**
      // user 消息的两个 block 里，按整条 continue 会把用户原话一起丢掉（实测
      // `queryFromMessages` 返回空串，注入面看着在跑却 injected:0）。
      if (isInjectedText(b.text) || /^\s*(Team message from |<team[-_]message\b|<subagent[-_]notification\b)/i.test(b.text)) continue
      texts.push(b.text)
    }
    if (!texts.length) continue
    const text = texts.join('\n').trim()
    if (!text) continue
    const room = QUERY_MAX_CHARS - used
    if (room <= 0) break
    parts.unshift(text.slice(0, room))
    used += Math.min(text.length, room)
  }
  return parts.join('\n').trim()
}

/**
 * records.jsonl 的增量读取缓存。
 *
 * 返回的对象同时给出 `records`（按 id 去重、留 revision 最高的那份，与
 * `loadRecords()` 同口径）和 `stats`（让「到底重读过几次」可外部观测，
 * 否则又变成「看起来在跑」）。
 */
/** 噪声行的判据（Buffer 形态，用于在不解码的前提下跳过 `indexable:false` 的行）。 */
const NOISE_NEEDLE = Buffer.from('"indexable":false', 'utf8')

export function createRecordCache({ vaultDir, log = null } = {}) {
  const file = vaultDir ? join(vaultDir, 'memory', 'records.jsonl') : null
  const stats = { reads: 0, appendedLines: 0, badLines: 0, fullReloads: 0, bytesRead: 0, lastError: null, lastAt: null, skippedUnindexable: 0, skippedSelfEcho: 0 }
  let offset = 0
  /** 上次没读完的半行（Buffer，不是字符串 —— 分块边界可能劈开多字节字符）。 */
  let carry = Buffer.alloc(0)
  let byId = new Map()
  let loaded = false

  /** 取一行里 `prefix` 之后的字符串值（值里不含转义引号，见 loadKnownIdsOnly 的说明）。 */
  const fieldOf = (line, prefix) => {
    const at = line.indexOf(prefix)
    if (at < 0) return null
    const start = at + prefix.length
    const end = line.indexOf('"', start)
    return end < 0 ? null : line.slice(start, end)
  }

  const rebuild = () => {
    offset = 0
    carry = Buffer.alloc(0)
    byId = new Map()
    loaded = false
  }

  /**
   * 读一段新内容。`size` 是本次 stat 到的大小。
   * 全量重读的判据是「文件比上次短」或「上次读完的位置不是行边界」——
   * 不看 mtime：mtime 只说明被写过，不说明内容变了，用它判新鲜度会漏。
   *
   * ── 只解析「可检索」的行（2026-10-23 性能）────────────────────────────
   * `composeNotes` 最终走 `textSearch`，而它按 `isIndexable()` 过滤 —— 真仓里
   * `indexable:false` 的采集日志占 **94.8%**（54,763 条里 51,929 条），
   * 但它们占了 112MB 里的 92MB。原实现把每一条都 JSON.parse 一遍
   * （实测 700–900ms），第一场会话为此多等近一秒，而且随仓线性变慢。
   *
   * 现在先用**行内子串**判一下：含 `"indexable":false` 的行不解析、不入表。
   * 这个判据与 `textindex.isIndexable()` 等价（那里也是只看这个字段的 false），
   * 而 records.jsonl 的一行就是一条完整 JSON，字段不会跨行。
   * 副作用是 `records()` 只返回可检索的记录 —— 本缓存**只服务自动注入**，
   * 全量记录仍由 `loadRecords()` 提供（面板 / 导出 / reconcile 走那条）。
   * `stats.skippedUnindexable` 把跳过的条数报出来，避免「静默少了一半」。
   */
  const readNew = () => {
    if (!file) return { ok: false, reason: 'no-vault' }
    let size = 0
    try {
      const st = statSync(file)
      size = st.size
    } catch (e) {
      if (e?.code === 'ENOENT') {
        // 文件不存在 = 还没有任何记录，不是错误
        if (loaded) rebuild()
        return { ok: true, grew: 0, size: 0 }
      }
      stats.lastError = String(e?.message ?? e)
      return { ok: false, reason: 'stat-failed', error: stats.lastError }
    }
    if (size < offset) {
      stats.fullReloads += 1
      rebuild()
    }
    if (size === offset && loaded) return { ok: true, grew: 0, size }
    let fd = null
    try {
      fd = openSync(file, 'r')
      const len = size - offset
      const buf = Buffer.allocUnsafe(Math.max(0, len))
      const read = len > 0 ? readSync(fd, buf, 0, len, offset) : 0
      offset += read
      stats.bytesRead += read
      if (read > 0) {
        // 在 Buffer 上按行切，**只解码需要解析的行**。
        // 整串 `toString + split` 会把 108MB 全量解码成 UTF-16 字符串再切出 5.4 万段
        // （实测 343ms，其中解码+切分占大半）；而真正要解析的只有 2,846 条。
        // 这里用 `indexOf(0x0a)` 定位行边界、用 `indexOf(needle)` 判噪声行，
        // 两者都不产生字符串，只有命中的行才 `toString` + `JSON.parse`（实测 196ms）。
        //
        // 跨块半行：上一块没读完的尾巴存成 Buffer（`carryBuf`），与下一块拼起来再切，
        // 不能按字符串 carry（多字节字符会被劈开 —— 这正是 UTF-8 分块最常见的坑）。
        const needle = NOISE_NEEDLE
        const carryBuf = carry
        const scanBuf = carryBuf.length ? Buffer.concat([carryBuf, buf.subarray(0, read)]) : buf.subarray(0, read)
        let lineStart = 0
        let next = 0
        for (;;) {
          const nl = scanBuf.indexOf(0x0a, next)
          if (nl < 0) break
          processLine(scanBuf, lineStart, nl)
          lineStart = nl + 1
          next = lineStart
        }
        // 尾部半行留到下一次
        carry = scanBuf.subarray(lineStart)
        // 防御：单行超过 8MB 说明文件形态异常（正常单条 p99 < 2KB、实测最大 214KB）。
        // 直接放弃增量、整份重建，避免 carry 无界增长。
        if (carry.length > 8 * 1024 * 1024) {
          stats.fullReloads += 1
          rebuild()
          stats.lastError = 'line-too-long'
        }
      }
      loaded = true
      stats.reads += 1
      stats.lastAt = Date.now()
      return { ok: true, grew: read, size }
    } catch (e) {
      stats.lastError = String(e?.message ?? e)
      log?.warn?.(`记忆索引增量读取失败：${stats.lastError}`)
      return { ok: false, reason: 'read-failed', error: stats.lastError }
    } finally {
      if (fd !== null) { try { closeSync(fd) } catch { /* 关不掉不影响结果 */ } }
    }
  }

  /** 处理 scanBuf 的 [from,to) 这一段（不含换行符）。 */
  function processLine(scanBuf, from, to) {
    if (to <= from) return
    // 纯空白行快速跳过（不产生字符串）
    let p = from
    while (p < to && (scanBuf[p] === 0x20 || scanBuf[p] === 0x0d || scanBuf[p] === 0x09)) p++
    if (p >= to) return
    // 噪声行：整行不解码，只为了撤掉同 id 的旧修订才解码。
    const hit = scanBuf.indexOf(NOISE_NEEDLE, from)
    if (hit !== -1 && hit < to) {
      stats.skippedUnindexable += 1
      const line = scanBuf.toString('utf8', from, to)
      // 同一 id 的**新修订**如果变成不可检索，旧修订必须从表里撤掉，
      // 否则检索会命中一条已经被新版取代的正文。这里只抽 id/revision
      // 两个定长字段（与 loadKnownIdsOnly 同一套前提：值里没有转义字符）。
      const id = fieldOf(line, '"id":"')
      if (id) {
        const prev = byId.get(id)
        const rev = Number(fieldOf(line, '"revision":'))
        const prevRev = prev ? (Number.isFinite(prev.revision) ? prev.revision : 1) : -1
        if (prev && (!Number.isFinite(rev) || rev >= prevRev)) byId.delete(id)
      }
      return
    }
    let rec = null
    try {
      rec = JSON.parse(scanBuf.toString('utf8', from, to))
    } catch {
      stats.badLines += 1
      return
    }
    if (!rec || typeof rec.id !== 'string') { stats.badLines += 1; return }
    // P5d：**注入链与查询链必须同一个可检索数**。
    //
    // 此前这里只认行内子串 `"indexable":false`，而查询链走的是
    // `indexable !== false && !isSelfEchoRecord()`（capture.mjs 的 searchable），
    // 于是 2026-10-24 那批在黑名单诞生**之前**写下的 67 条自回显记录
    // （indexable≠false、正文却是记忆工具的命中列表/收窄提示）只被查询链挡掉，
    // 注入链照旧把它们注入模型 —— 实测 2,860 对 2,793，差的正好是这 67 条。
    //
    // 修法不是再写一套判据，而是**复用同一个** `isSelfEchoRecord`：
    // 两侧共用 SELF_ECHO_RULES + SELF_ECHO_AUTHOR_SCOPE，规则表改一次两边同时生效，
    // 不会再出现"两套口径各自漂移"。成本可接受：真正走到这里的只有可检索行
    // （真仓 2,860 条），每条最多跑 10 条正则，量级是几毫秒 —— 而那 52,263 条
    // 噪声行仍然在 `indexable:false` 那一支里被整行跳过，一次正则都不跑。
    if (isSelfEchoRecord(rec)) {
      stats.skippedSelfEcho += 1
      // 与噪声行同一套语义：同一 id 的新修订若变成自回显，旧修订必须撤掉，
      // 否则检索会命中一条已被新版取代的正文。
      const prevEcho = byId.get(rec.id)
      const revEcho = Number.isFinite(rec.revision) ? rec.revision : 1
      const prevEchoRev = prevEcho ? (Number.isFinite(prevEcho.revision) ? prevEcho.revision : 1) : -1
      if (prevEcho && revEcho >= prevEchoRev) byId.delete(rec.id)
      return
    }
    stats.appendedLines += 1
    const prev = byId.get(rec.id)
    // 同 id 留 revision 最高的：旧版必须能被新修订覆盖，否则纠正永远不生效
    if (!prev || (Number.isFinite(rec.revision) ? rec.revision : 1) >= (Number.isFinite(prev.revision) ? prev.revision : 1)) {
      byId.set(rec.id, rec)
    }
  }

  return {
    file,
    readNew,
    records: () => [...byId.values()],
    size: () => byId.size,
    stats,
    invalidate: () => { rebuild() },
  }
}

/**
 * 造一条注入消息。
 *
 * 形状照 `dsh-warden/lib/host/inject.js:284 createNotice` 抄：
 * `role:'user'` + `content:[{type:'text',text}]` + `source:{kind,form,summary}`。
 * 用 user 角色是宿主契约（注入走 user/message 才会被模型看到）；
 * `source.kind` 是本插件名，`form:'notice'` 让排查时能一眼认出「不是人说的」。
 */
export function createMemoryNotice(text, summary = '') {
  return {
    id: `laurel-memory-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: INJECT_SOURCE_KIND, form: 'notice', summary: String(summary ?? '').slice(0, 60) },
  }
}

/**
 * 注入器。
 *
 * `handlePreStep(payload, next)` 直接当 `agent/pre-step` 的 handler 用。
 * 三条纪律：
 *  1. **先 await next()**，只在它的结果上追加，不抢先返回；
 *  2. 只在 `decision.kind === 'enter'` 上动手（其它 kind 是拒绝/中断，改了会被吞）；
 *  3. 任何异常都吞掉并记账 —— 记忆坏了不能变成对话里的可见故障。
 */
export function createInjector({
  vaultDir = null,
  tier = 'zero',
  log = null,
  clock = Date.now,
  // 会话级预算可覆盖：真仓换算口径不一样（60 KiB 对 800 字符档），测试里也需要
  // 一个能压到几十字符的阈值来验证截断路径。默认照 ZCode 的 61,440。
  sessionCharBudget = SESSION_CHAR_BUDGET,
  // usedAt 回写的节流窗口（毫秒）。0 = 不节流，只给测试与排查用。
  usedAtMinIntervalMs = USED_AT_MIN_INTERVAL_MS,
  // 回写开关：注入侧默认写，但"读多写少"的部署（只读挂载 / 排查线上问题）能关掉。
  stampUsed = true,
} = {}) {
  const cache = createRecordCache({ vaultDir, log })
  let episodeStamp = null
  let episodeRows = []
  function readExperienceRows() {
    const file = vaultDir ? join(vaultDir, EPISODES_FILE) : null
    if (!file) return []
    let st
    try { st = statSync(file, { bigint: true }) } catch (e) {
      if (e.code === 'ENOENT') { episodeRows = []; episodeStamp = null; return [] }
      throw e
    }
    const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
    if (stamp !== episodeStamp) {
      const loaded = loadEpisodes(vaultDir)
      if (loaded.bad) throw new Error('bad-episode-lines:' + loaded.bad)
      episodeRows = loaded.episodes.filter(e => episodeSearchable(e)).map(episodeToRow)
      episodeStamp = stamp
    }
    return episodeRows
  }
  // tier 允许传函数：设置页切档后注入预算必须跟着走，
  // 不能一直停在 apply 那一刻的档位上。认不出的档位退回 zero（有界总比无界好）。
  const tierOf = () => {
    const t = typeof tier === 'function' ? tier() : tier
    return t in TIER_BUDGET ? t : 'zero'
  }
  const stats = {
    steps: 0,
    injected: 0,
    skipped: 0,
    errors: 0,
    lastReason: null,
    lastAt: null,
    lastNotes: 0,
    lastChars: 0,
    lastQuery: null,
    lastQueryAt: null,
    lastError: null,
    lastIndexError: null,
    // ── S5 新增：会话级计数与 usedAt 回写（端点 status() 会一起吐出来）──
    // 没有这三个数，"注入了多少"只能看最后一轮的 lastChars —— 一场会话的
    // 累计量、还剩多少预算、回写成功几条，全都看不见。
    // **按会话**计的累计注入字符（含注入块骨架）。不是进程级累计 ——
    // 一个宿主进程活几天、跑几十场会话，进程级计数会在第 76 次注入之后
    // 把整台机器永久静音，而"预算"的语义一直是"这场会话说够了"。
    sessionChars: 0,
    // 进程级总量只用于观测（自检/面板），**不参与**预算判断。两个数分开，
    // 免得以后有人拿错一个去比较。
    totalCharsAllSessions: 0,
    sessionBudget: sessionCharBudget,
    lastSessionId: null,    // sessionChars 是哪场会话的量（换会话后必须能说清）
    usedStamped: 0,         // usedAt 真写盘了几条
    usedSkipped: 0,         // 命中但没写（节流 / 版本变了 / 写失败）
    lastUsedStamp: null,    // { id, at, written, reason }
  }
  /**
   * `sessionId` → `{ ids: string, versions: string, chars: number }`
   *
   * ── 为什么键从 `sessionId:turn` 改成 `sessionId`（S5）──────────────
   * 旧键只做「同一轮不重复发」：换一轮就整批重投，于是**同一场会话里同一条记忆
   * 被注入了 5 次、10 次**（每轮一次的模型根本不会因此多知道什么，只是把
   * 上下文预算烧在复读上）。新键按会话记，重投条件是"内容版本变了"。
   *
   * ── 为什么重投条件要比"id 相同"更细 ────────────────────────────────
   * 纯集合去重（只按 id）：改过的记忆在本会话里**永远**不再出现 —— 那意味着
   * "上一轮我纠正了这条结论"，后续轮次还在用旧版。Laurel 每条记录都有
   * `contentVersion`（内容哈希）与 `revision`，所以能做得更好：id 相同但
   * 版本变了就重投（这条信息确实变了）；id 与版本都没变才跳过。
   */
  const sentBySession = new Map()

  const status = () => ({
    ...stats,
    tier: tierOf(),
    tiers: Object.keys(TIER_BUDGET),
    indexSize: cache.size(),
    indexFile: cache.file,
    cache: { ...cache.stats },
    // ── 三档状态（S9.3）────────────────────────────────────────────────
    // 端点/哨兵要区分「没有东西可注入」和「有东西但没命中」。`lastReason` 是
    // 自由文本（还可能被注成 `kind:deny` / `index:stat-failed` 这类），直接拿它
    // 做判断迟早出错，所以另出一个**归一化**的档位：
    //   'injected'  上一轮真的注入了
    //   'no-data'   仓里没有可注入的记录（采集链的问题）
    //   'no-hit'    有记录但这次没匹配（不是故障）
    //   'error'     检索/索引/自身异常（要报警）
    //   'skipped'   其它（档位关掉、被宿主拒绝、查询词为空、本会话已投过、预算用尽）
    lastReasonTier: reasonTier(stats.lastReason),
    // 会话去重的可观测面：现在记了几场会话、总预算多少、还剩多少。
    sessionsSeen: sentBySession.size,
    // 上一轮参与注入的那场会话还剩多少额度（没有会话就是整份额度）。
    lastSessionId: stats.lastSessionId ?? null,
    sessionBudgetRemaining: Math.max(0, sessionCharBudget - (stats.sessionChars ?? 0)),
  })

  /** 把自由文本的 lastReason 归到四个档位之一 —— 判据集中在这里，别散在调用点。 */
  function reasonTier(reason) {
    if (reason === 'injected') return 'injected'
    if (reason === 'no-data') return 'no-data'
    if (reason === 'no-hit') return 'no-hit'
    if (reason === 'error' || (typeof reason === 'string' && reason.startsWith('error:'))) return 'error'
    return 'skipped'
  }

  // 跳过时必须把上一轮的 notes/chars 清零：端点是照着这两个数显示
  // 「这一轮注入了多少」的，留着上一轮的值等于又一次「看起来在跑」。
  const note = (reason) => {
    stats.skipped += 1
    stats.lastReason = reason
    stats.lastNotes = 0
    stats.lastChars = 0
  }

  /**
   * 把 `usedAt` 回写到盘上（S5）。**只回写真的被注入的那几条**。
   *
   * 三条纪律：
   *  1. 回写失败绝不影响注入 —— 记忆已经要进请求了，丢一份统计不能变成丢一次注入；
   *  2. 带上注入时的 `revision` 当 baseRevision：正文已经被别人改过就不回写
   *     （那条记忆下一轮会以新版重投，把旧版标成"用过"是假账）；
   *  3. 节流（`usedAtMinIntervalMs`）：同一场会话里反复命中同一条，不必每步写盘。
   */
  function stampNotes(notes, records = []) {
    if (!stampUsed || !vaultDir) return
    // 把刚读到的整条记录递过去：省掉一次 108MB 的全文件扫描（见 stampUsedAt 的说明）。
    const byId = new Map((Array.isArray(records) ? records : []).map((r) => [r.id, r]))
    for (const n of notes) {
      if (byId.get(n.id)?.source === 'episode') continue
      try {
        const out = stampUsedAt(vaultDir, n.id, {
          now: clock(),
          baseRevision: n.revision,
          minIntervalMs: usedAtMinIntervalMs,
          record: byId.get(n.id) ?? null,
        })
        if (out.written) stats.usedStamped += 1
        else stats.usedSkipped += 1
        stats.lastUsedStamp = { id: n.id, at: clock(), written: !!out.written, reason: out.reason ?? null }
      } catch (e) {
        stats.usedSkipped += 1
        stats.lastUsedStamp = { id: n.id, at: clock(), written: false, reason: String(e?.message ?? e) }
      }
    }
    // 回写之后注入索引可能落后一行（多出来的那条 usedAt 版本），
    // 但读侧「同 id 取 revision 最高」会拿到后写的那条 —— 正文没变，无需重读。
  }

  async function handlePreStep(payload, next) {
    stats.steps += 1
    // next() 在 cordis waterfall 里通常是同步返回的，但宿主实现可能返回 promise。
    // 两种都接住 —— 只写 await 会在同步实现上多一个微任务，只写同步会在异步实现上拿到 undefined。
    const raw = typeof next === 'function' ? next() : undefined
    const decision = (raw && typeof raw.then === 'function') ? await raw : raw
    try {
      if (!decision || typeof decision !== 'object') { note('no-decision'); return decision }
      if (decision.kind !== 'enter') { note(`kind:${String(decision.kind)}`); return decision }
      if (!vaultDir) { note('no-vault'); return decision }
      const session = payload?.agent?.session ?? payload?.session ?? null
      const sessionId = asString(session?.id) ?? 'unknown'
      // 让端点能说清"这个 sessionChars 是哪场会话的"——只报一个孤零零的数字，
      // 换会话之后读的人分不清它是新会话的 0 还是旧会话的 1000。
      stats.lastSessionId = sessionId
      stats.sessionChars = sentBySession.get(sessionId)?.chars ?? 0
      const query = queryFromMessages(decision.messages)
      if (!query) { note(SKIP_REASONS.emptyQuery); return decision }
      stats.lastQuery = query.slice(0, 120)
      stats.lastQueryAt = clock()

      // 会话级预算（S5）：**这一场会话**累计注入超过 61,440 字符就停。
      // 判据放在查询与检索**之前**：预算用尽时连检索都不必做 —— 反正不会发出去，
      // 而全量检索是这条链上最贵的一步（真仓 2,860 条可检索记录）。
      //
      // 注意取的是 `sentBySession.get(sessionId).chars`（这场会话自己的量），
      // 不是进程级累计：注入器跟着宿主进程活，用进程级计数会让"跑了几十场
      // 会话之后，新会话一个字都注入不进去"——那不是预算，那是静音。
      const priorSession = sentBySession.get(sessionId)
      if (priorSession && priorSession.chars >= sessionCharBudget) {
        stats.sessionChars = priorSession.chars
        note(SKIP_REASONS.sessionBudget)
        return decision
      }

      const grew = cache.readNew()
      if (!grew.ok) { note(`index:${grew.reason}`); stats.lastIndexError = grew.error ?? grew.reason; return decision }
      if (grew.grew > 0) stats.lastIndexError = null
      const scope = resolveQueryScope({ agent: { session } })
      if (!scope.ok) { note('scope:' + scope.reason); return decision }
      const wanted = new Set(scope.projectIds ?? [scope.projectId])
      const experiences = readExperienceRows().filter(r => wanted.has(r.projectId) &&
        (!scope.environmentId || r.environmentId === scope.environmentId))
      const records = [...cache.records().filter(r => wanted.has(r.projectId)), ...experiences]
      stats.experiencePool = experiences.length
      stats.lastProjectId = scope.projectId
      // 索引为空是 **no-data**（没东西可注入），与 empty-index 是同一个意思，
      // 但用统一的三档词报出去 —— 端点与哨兵认这一个名字。
      if (!records.length) { note(SKIP_REASONS.noData); return decision }
      const useTier = tierOf()
      const composed = composeNotes(records, query, { tier: useTier, clock })
      if (!composed.notes?.length) {
        // composeNotes 已经分出 no-data / no-hit / error 三档，直接透传；
        // 剩下的 tier-disabled 之类按原样报（它属于"没东西可注入"，但不是异常）。
        note(composed.reason ?? SKIP_REASONS.noHit)
        return decision
      }
      // 重投判据：id **且** contentVersion 都没变才跳过。版本变了说明内容改过，
      // 本会话用过的那条已经过时，必须重投（纯集合去重做不到这一条）。
      const fingerprint = composed.notes.map((n) => `${n.id}@${n.contentVersion ?? n.revision ?? '?'}`).join(',')
      const seen = sentBySession.get(sessionId)
      if (seen && seen.fingerprint === fingerprint) { note(SKIP_REASONS.alreadyInjected); return decision }
      const text = renderStablePrefix({ notes: composed.notes, tier: useTier, now: clock() })
      if (!text) { note('empty-prefix'); return decision }
      const list = Array.isArray(decision.messages) ? decision.messages : []
      const message = createMemoryNotice(text, `${composed.notes.length} 条记忆`)
      // 只通过 `decision.messages` 交付，**不**再 `session.append()` 一份：
      // 宿主随后会把 messages 追加成 user/message，两处都写就是同一条出现两次。
      sentBySession.set(sessionId, {
        fingerprint,
        chars: (priorSession?.chars ?? 0) + text.length,
        at: clock(),
      })
      stats.sessionChars = priorSession ? priorSession.chars + text.length : text.length
      stats.totalCharsAllSessions += text.length
      // 会话表不需要淘汰策略（一场会话一个键，量级是"几十"），但会话数是无限的，
      // 长期在同一个进程里跑的宿主会让它慢慢涨。超过 256 场就丢最早的一半：
      // 这份表只用于本会话去重，丢了顶多重投一次，不是审计日志。
      if (sentBySession.size > 256) {
        const keys = [...sentBySession.keys()].slice(0, 128)
        for (const k of keys) sentBySession.delete(k)
      }
      stats.injected += 1
      stats.lastAt = clock()
      stats.lastNotes = composed.notes.length
      stats.lastChars = text.length
      stats.lastReason = 'injected'
      // usedAt 回写（S5）：**只在真的发出去之后**写。跳过、预算用尽、渲染为空都不写
      // —— "用过"必须等于"模型这一轮真的看到了"。
      stampNotes(composed.notes, records)
      return { ...decision, messages: [...list, message] }
    } catch (e) {
      stats.errors += 1
      stats.lastError = String(e?.message ?? e)
      stats.lastReason = 'error'
      try { log?.warn?.(`记忆注入失败（本轮跳过）：${stats.lastError}`) } catch { /* 日志失败无所谓 */ }
      return decision
    }
  }

  return { handlePreStep, status, invalidate: () => { cache.invalidate(); episodeStamp = null }, stats, cache }
}
