/**
 * dsh-warden · 大输出归档与有界呈现（R3 的正解）
 *
 * ── 为什么挂 `tools/post-execute` 而不是 `agent/pre-step` ──────────────
 * 旧版在 `agent/pre-step` 里筛 `decision.messages` 的 `role==='tool'` 消息。
 * 实读宿主 `dsh-agent-loop` 的 `preStep()`：那个 `messages` 是 **inbox 待追加
 * 的新批次**（`this.inbox.claim(...)` 的结果）加一条 runtime context，
 * 完整历史要到 `buildRequest()` 才从 session surface 构建。
 * **这一层通常根本没有旧工具结果**，所以旧版裁的是空气；
 * 旧单测人为塞了 20 条历史 tool 消息，才"测过"了一个生产不存在的输入。
 *
 * `tools/post-execute` 才是结果**进入 surface 之前**的位置。实读
 * `dsh-tools` 的 `postExecute()`：`accept` 决策可以替换 `content`
 * （不能同时给 `value`），并可以挂 `additionalContexts`。
 * 在这里把大文本换成有界摘要，原文就根本不会进上下文 ——
 * 比"先进去再裁掉"省得多，也不需要碰任何历史。
 *
 * ── 与官方压缩的分工（不抢 owner）─────────────────────────────────────
 *   `dsh-compaction-basic`        历史压缩的**唯一 owner**（压力压缩 + 溢出重试）
 *   `dsh-compaction-tool-result-pruner`  单条超长结果的 head+tail 裁剪
 *   warden（本模块）              **新产生的**大结果先落盘，只留有界摘要 + 指纹 + 引用
 *
 * warden 不改历史、不改冻结请求、不假装能算上下文容量。
 * `historyPruning` 在能力台账里明确是 `unsupported`。
 *
 * ── 三条不能破的底线 ───────────────────────────────────────────────────
 *   1. **归档失败就保留原结果。** 宁可上下文大，不能把数据弄丢。
 *   2. **失败结果不隐藏。** `isError` 的结果一律原样放过 ——
 *      错误信息本身往往就是最关键的证据。
 *   3. **不把"重新执行"当找回手段。** 写入、部署、网络请求都不可重放。
 *      摘要里给的是**文件路径 + 行区间**，让模型用宿主的读取工具去读。
 *      （这也正是 DeepAgents 的做法：输出先写 backend，再留预览与引用。）
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { archiveDirFor, isUnder, normalizePath, pluginPaths, resolveDshHome } from '../core/config.js'
import { atomicWriteFile } from '../core/filelock.js'
import { extractPath, sha256Hex } from '../core/text.js'

/** 自家工具的输出不归档（会形成噪声，而且它们本来就是短文本）。 */
const OWN_TOOLS = new Set([
  'warden_status', 'warden_stage', 'acquire_lock', 'release_lock', 'list_locks',
  'renew_lock', 'evidence_record', 'evidence_check',
])

/** 粗略 token 估算：CJK 一字一 token，其余 4 字符一 token。只用于显示。 */
function roughTokens(text) {
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) cjk++
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/** 把 content 里的文本块与非文本块分开。非文本块（图片/文件）必须原样保留。 */
function splitContent(content) {
  const blocks = Array.isArray(content) ? content : []
  const texts = []
  const others = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block)
    else others.push(block)
  }
  return { texts, others, totalChars: texts.reduce((sum, b) => sum + b.text.length, 0) }
}

/**
 * 归档正文，返回有界呈现所需的材料。
 *
 * @returns {{ok: true, file: string, hash: string, bytes: number, lines: number}|{ok: false, reason: string}}
 */
export function archiveText(home, sessionId, callId, toolName, text) {
  try {
    const dir = archiveDirFor(home, sessionId)
    mkdirSync(dir, { recursive: true })
    const safeCall = String(callId ?? `noid-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
    const file = join(dir, `${safeCall}.txt`)
    const bytes = Buffer.from(text, 'utf8')
    // 原子写（P2-8）：先写临时文件再改名，进程崩在中途也不会留下半截归档。
    // atomicWriteFile 自带尺寸校验且**失败就抛**，正好对上底线 1：
    // 抛出去被本函数的 catch 接住 → 返回 { ok:false } → 调用方保留原结果。
    atomicWriteFile(file, text)
    const lines = text.split('\n').length
    return { ok: true, file, hash: sha256Hex(bytes), bytes: bytes.length, lines }
  } catch (error) {
    return { ok: false, reason: `${error?.message ?? error}` }
  }
}

/* ── 归档目录回收（P2-8）──────────────────────────────────────────────
 * 归档是**只增不减**的：装几个月后 ~/.dsh 会无界膨胀，而且没有任何 UI/文档
 * 说去哪清。这里给一条最简单的回收规则：超容量或超时限 → **按会话目录整个删**。
 *
 * 为什么按会话目录删而不是按文件删：一个会话的归档是互相引用的证据链
 * （摘要里的「全文见 xxx.txt」），删掉中间几个文件比整段删掉更糟 ——
 * 留下的摘要会指向不存在的文件，反而制造假证据。
 *
 * ⚠ 两条铁律：
 *   1. **当前会话的目录永不回收。** 正在写的证据不能自己删自己。
 *   2. **回收失败绝不影响归档本身。** 回收是保洁，不是主流程。
 *
 * 阈值现在是模块内常量（DEFAULT_CONFIG 在 lib/core/config.js，不属本车道写域）。
 * 已在 RESULT.md 记一条「建议后续提进 DEFAULT_CONFIG」给 Lead。
 */

/** 归档目录总容量上限：200 MB。 */
export const ARCHIVE_MAX_BYTES = 200 * 1024 * 1024

/** 会话归档目录的保留天数：30 天。 */
export const ARCHIVE_MAX_AGE_DAYS = 30

/** 一次回收最多删多少个会话目录（防止异常情况下长时间阻塞）。 */
const RECYCLE_MAX_DIRS = 200

/**
 * 回收旧归档。**永不抛**。
 *
 * 顺序：先按年龄（超过 30 天且不是当前会话）删，再按容量（超 200MB 时从最老的
 * 会话开始删，直到降到阈值以下）。年龄优先是因为「过期数据」比「容量压力」更确定。
 *
 * @param {string} home 插件数据根
 * @param {{currentSessionId?: string, maxBytes?: number, maxAgeDays?: number, now?: number}} [options]
 * @returns {{scanned: number, removed: number, freedBytes: number, skipped: number, reason: string}}
 */
export function recycleArchive(home, options = {}) {
  const out = { scanned: 0, removed: 0, freedBytes: 0, skipped: 0, reason: '' }
  try {
    const root = pluginPaths(home).archive
    const current = String(options.currentSessionId ?? '')
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : ARCHIVE_MAX_BYTES
    const maxAgeDays = Number(options.maxAgeDays) > 0 ? Number(options.maxAgeDays) : ARCHIVE_MAX_AGE_DAYS
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000

    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      // 目录还不存在 = 没有东西可回收，不是错误。
      out.reason = '归档目录不存在'
      return out
    }

    /** @type {{name: string, dir: string, bytes: number, mtimeMs: number}[]} */
    const sessions = []
    /** 当前会话占的字节：**算进总量**（它确实占着盘），但永不作为删除候选。 */
    let protectedBytes = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      let bytes = 0
      let mtimeMs = 0
      try {
        for (const file of readdirSync(dir)) {
          try {
            const stat = statSync(join(dir, file))
            if (stat.isFile()) { bytes += stat.size; mtimeMs = Math.max(mtimeMs, stat.mtimeMs) }
          } catch { /* 单个文件读不到就跳过 */ }
        }
      } catch { continue }
      if (current && entry.name === current) { out.skipped++; protectedBytes += bytes; continue }
      sessions.push({ name: entry.name, dir, bytes, mtimeMs })
    }
    out.scanned = sessions.length

    /** 删一个会话目录。返回释放的字节数（失败返回 0）。 */
    const drop = (item) => {
      if (out.removed >= RECYCLE_MAX_DIRS) return 0
      try {
        rmSync(item.dir, { recursive: true, force: true })
        out.removed++
        out.freedBytes += item.bytes
        return item.bytes
      } catch {
        return 0
      }
    }

    // ① 按年龄：目录最后修改时间早于 cutoff → 删。
    const survivors = []
    for (const item of sessions) {
      if (item.mtimeMs > 0 && item.mtimeMs < cutoff) drop(item)
      else survivors.push(item)
    }

    // ② 按容量：仍超上限就从最老的开始删，直到降到阈值以下。
    //    总量含当前会话（它占着盘，不能假装不存在），但当前会话永不作为删除候选。
    let total = survivors.reduce((sum, item) => sum + item.bytes, 0) + protectedBytes
    if (total > maxBytes) {
      survivors.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const item of survivors) {
        if (total <= maxBytes) break
        const freed = drop(item)
        if (freed > 0) total -= freed
      }
      out.bytesAfter = total
    }

    out.reason = out.removed > 0 ? `回收 ${out.removed} 个会话归档目录` : '无需回收'
    return out
  } catch (error) {
    out.reason = `回收异常：${error?.message ?? error}`
    return out
  }
}

/* ── 摘要形态（#3 按工具分级，2026-10-17）─────────────────────────────
 *   grep / glob / search / codebase_search：输出重复度高，**留尾部没意义** ——
 *       只给「命中条数 + 前 N 行」（N 由 keepChars 按行累计截出）。
 *   read / cat / view：首尾都可能有信息，保留头尾，并明确写出
 *       「这份文件共 N 行，你要的区间可以用 offset/limit 精确读」。
 *   其它（bash / pwsh / run_code / …）：保持 0.2.x 的 head+tail。
 *
 * 所有形态都必须继续带：文件路径、行数、字节、sha256、按行区间读、
 * 以及「不要重新执行刚才那个工具」—— 这三条是不能破的底线。
 */

const HIT_SHAPE_TOOLS = new Set(['grep', 'glob', 'search', 'codebase_search'])
const FILE_SHAPE_TOOLS = new Set(['read', 'cat', 'view', 'read_file'])

/** 某工具该用哪种摘要形态：'hits' | 'file' | 'default'。大小写不敏感。 */
export function summaryShapeFor(toolName) {
  const name = String(toolName ?? '').trim().toLowerCase()
  if (HIT_SHAPE_TOOLS.has(name)) return 'hits'
  if (FILE_SHAPE_TOOLS.has(name)) return 'file'
  return 'default'
}

/** 所有形态共享的元信息：路径 / 行数 / 字节 / 指纹。 */
function archiveMetaLines(archived) {
  return `  文件：${archived.file}\n`
    + `  行数：${archived.lines}　字节：${archived.bytes}\n`
    + `  指纹：sha256:${archived.hash}\n`
}

const NO_RERUN_HINT = '**不要重新执行刚才那个工具** —— 写入、部署、网络请求这类操作重跑一次就有副作用，'
  + '而且重跑得到的输出未必和这次一致。\n'
const READ_BY_RANGE_HINT = '需要其它部分时，**用读取工具按行区间去读上面那个文件**（例如读第 200–320 行）。\n'

/** 按工具选摘要形态。纯函数，便于单测（#3）。 */
export function boundedSummaryFor({ toolName, text, archived, keepChars, headRatio = 0.5 }) {
  const shape = summaryShapeFor(toolName)
  if (shape === 'hits') return hitsSummary({ toolName, text, archived, keepChars })
  if (shape === 'file') return fileSummary({ toolName, text, archived, keepChars, headRatio })
  return boundedSummary({ toolName, text, archived, keepChars })
}

/**
 * 命中类工具（grep/glob/search/codebase_search）：命中条数 + 前 N 行。
 * 不显示尾部 —— 对这类输出，尾部只是另一批重复的命中。
 */
function hitsSummary({ toolName, text, archived, keepChars }) {
  const lines = text.split('\n')
  // "命中条数"按非空行计（排除 `--` 这类区间分隔行）。拿不到精确语义时
  // 这是唯一诚实的口径：一行输出最多对应一条命中（也可能是一行上下文）。
  const hitLines = lines.filter((line) => {
    const trimmed = line.trim()
    return trimmed.length > 0 && trimmed !== '--'
  }).length

  const picked = []
  let used = 0
  for (const line of lines) {
    const cost = line.length + 1
    if (picked.length > 0 && used + cost > keepChars) break
    picked.push(line)
    used += cost
    if (used >= keepChars) break
  }
  let shown = picked.join('\n')
  if (shown.length > keepChars) shown = shown.slice(0, keepChars)
  const shownLines = shown.length === 0 ? 0 : shown.split('\n').length

  return `[warden 归档] \`${toolName}\` 的输出共 ${text.length} 字符（约 ${roughTokens(text)} token）、`
    + `${lines.length} 行，已**完整**保存到本地文件，这里只显示**前 ${shownLines} 行命中**（约 ${shown.length} 字符）。\n`
    + archiveMetaLines(archived)
    + `  命中条数：约 ${hitLines} 条（按输出里的非空行计，不含 \`--\` 分隔行；一行可能是一条命中或一行上下文）。\n`
    + `  需要其余命中或完整上下文时，**用读取工具按行区间去读上面那个文件**（例如从第 ${shownLines + 1} 行起）。\n`
    + `  ${NO_RERUN_HINT}`
    + `\n──── 前 ${shownLines} 行 ────\n${shown}\n`
    + `──── 全文见 ${archived.file} ────`
}

/** 文件类工具（read/cat/view）：首尾 + 「共 N 行，offset/limit 精确读」。 */
function fileSummary({ toolName, text, archived, keepChars, headRatio = 0.5 }) {
  const ratio = Number.isFinite(headRatio) ? Math.min(1, Math.max(0, headRatio)) : 0.5
  const head = Math.ceil(keepChars * ratio)
  const tail = Math.max(0, keepChars - head)
  const headPart = text.slice(0, head)
  const tailPart = tail > 0 && text.length > headPart.length ? text.slice(-tail) : ''
  const omitted = Math.max(0, text.length - headPart.length - tailPart.length)
  return `[warden 归档] \`${toolName}\` 的输出共 ${text.length} 字符（约 ${roughTokens(text)} token），`
    + `已**完整**保存到本地文件，这里只显示首尾。\n`
    + archiveMetaLines(archived)
    + `  这份文件共 ${archived.lines} 行；你要的区间可以用 offset/limit 精确读`
    + `（例如 offset=200, limit=120，读第 200–320 行）。\n`
    + `  中间省略了 ${omitted} 字符。\n`
    + READ_BY_RANGE_HINT
    + NO_RERUN_HINT
    + `\n──── 开头 ${headPart.length} 字符 ────\n${headPart}\n`
    + (tailPart
      ? `──── 中间省略 ────\n──── 结尾 ${tailPart.length} 字符 ────\n${tailPart}\n`
      : '')
    + `──── 全文见 ${archived.file} ────`
}

/**
 * 其它工具（bash/pwsh/run_code/…）：首尾各一半 —— 0.2.x 的既有行为，保持不变。
 * （`boundedSummaryFor` 对未知工具回落到这里。）
 */
export function boundedSummary({ toolName, text, archived, keepChars }) {
  const head = Math.ceil(keepChars / 2)
  const tail = keepChars - head
  const headPart = text.slice(0, head)
  const tailPart = text.length > tail ? text.slice(-tail) : ''
  const omitted = text.length - headPart.length - tailPart.length
  return `[warden 归档] \`${toolName}\` 的输出共 ${text.length} 字符（约 ${roughTokens(text)} token），`
    + `已**完整**保存到本地文件，这里只显示首尾。\n`
    + `  文件：${archived.file}\n`
    + `  行数：${archived.lines}　字节：${archived.bytes}\n`
    + `  指纹：sha256:${archived.hash}\n`
    + `  中间省略了 ${omitted} 字符。\n`
    + `需要中间部分时，**用读取工具按行区间去读上面那个文件**（例如读第 200–320 行）。\n`
    + `**不要重新执行刚才那个工具** —— 写入、部署、网络请求这类操作重跑一次就有副作用，`
    + `而且重跑得到的输出未必和这次一致。\n`
    + `\n──── 开头 ${headPart.length} 字符 ────\n${headPart}\n`
    + (tailPart
      ? `──── 中间省略 ────\n──── 结尾 ${tailPart.length} 字符 ────\n${tailPart}\n`
      : '')
    + `──── 全文见 ${archived.file} ────`
}

/**
 * 读 map 里的单工具覆盖值。键统一小写（config.js 的 MAP_KEYS 归一化后即小写）。
 * 值不合法（非数字/非正数）视为没配 —— 回落到全局值。
 */
function toolOverride(map, toolKey) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null
  const value = Number(map[toolKey])
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
}

/**
 * 解析一次归档实际使用的阈值与保留字符数（#3 按工具分级）。
 *
 * 优先级：`archiveThresholdByTool[tool]` / `archiveKeepByTool[tool]`
 *       → `archiveThresholdChars` / `archiveKeepChars`。
 *
 * 兼容约束：**单工具覆盖之后**也必须满足 `keepChars * 2 <= threshold`，
 * 否则保留量会大到"归档了等于没归档"。违反时把 keep 夹到 `threshold / 4`。
 *
 * @returns {{toolKey: string, threshold: number, keepChars: number}}
 */
export function resolveArchiveLimits(toolName, config) {
  const toolKey = String(toolName ?? '').trim().toLowerCase()
  const threshold = toolOverride(config?.archiveThresholdByTool, toolKey)
    ?? (Number(config?.archiveThresholdChars) > 0
      ? Math.trunc(Number(config.archiveThresholdChars))
      : 4096)
  const keepOverride = toolOverride(config?.archiveKeepByTool, toolKey)
  let keepChars = keepOverride ?? Math.max(200, Number(config?.archiveKeepChars) || 800)
  if (keepChars * 2 > threshold) keepChars = Math.max(1, Math.floor(threshold / 4))
  return { toolKey, threshold, keepChars }
}

/**
 * **记账**：只有「内容确实被替换进上下文」之后才允许调用（P1-11）。
 *
 * 为什么要把这一步单独抽出来：旧版在归档落盘的那一刻就 `markObserved` + 写
 * `archive` 事件（含 `savedChars`），而 `after.js` 在下游给了 `value` 时会
 * **跳过内容替换** —— 于是「记了账但没省」，报表按 `savedChars` 累加出来的
 * 收益是虚的，用户据此判断哪条护栏该留会判错。
 *
 * 现在调用时机由调用方决定：真替换了才 commit，没替换就 reportArchiveDropped。
 * **本函数幂等**：同一个 entry 重复 commit 不会重复记账（由调用方保证只调一次，
 * 这里再兜一道 `entry.committed`）。
 *
 * 永不抛 —— 记账失败不许影响这次工具调用。
 *
 * @param {object} deps 归档器依赖（capabilities / onEvent / timeline / clock）
 * @param {object} entry 一次归档的完整描述
 * @returns {boolean} 有没有成功提交
 */
export function commitArchive(deps, entry) {
  const d = deps ?? {}
  const item = entry ?? {}
  if (item.committed === true) return false
  try {
    item.committed = true
    d.capabilities?.markObserved?.('archiveToolResults', `${item.tool} ${item.totalChars}→${item.keptChars} 字符`)
    // 坑3：归档事件要能事后**量化** —— callId 对齐到那次调用，step/turn 对齐到
    // 第几步/第几个用户回合（core/timeline.js），savedChars/savedTokensEst 给收益。
    // 拿不到位置就写 null，不写 0 假装是第一步。
    const pos = d.timeline?.position?.(item.sessionId) ?? { turn: null, step: null }
    const savedChars = Math.max(0, Number(item.totalChars) - Number(item.keptChars))
    d.onEvent?.({
      kind: 'archive',
      sessionId: item.sessionId,
      at: d.clock?.now?.() ?? Date.now(),
      callId: item.callId,
      step: Number.isFinite(pos.step) ? pos.step : null,
      turn: Number.isFinite(pos.turn) ? pos.turn : null,
      tool: item.tool,
      totalChars: item.totalChars,
      keptChars: item.keptChars,
      savedChars,
      savedTokensEst: Math.round(savedChars / 2.5),
      sha256: String(item.hash ?? '').slice(0, 16),
      detail: `${item.tool} 输出 ${item.totalChars} 字符已归档，呈现压到 ${item.keptChars} 字符（省 ${savedChars} 字符；sha256:${String(item.hash ?? '').slice(0, 12)}）`,
    })
    return true
  } catch {
    return false
  }
}

/**
 * 归档**没生效**：内容已经落盘，但下游决策不让替换（给了 `value` 或是 `block`）。
 *
 * 这时归档文件仍然在磁盘上（它是证据，不删），但**一分钱收益都不许记**。
 * 写一条 `archive-dropped` 让报表能把它排除掉，并让降级可见。
 *
 * @returns {boolean}
 */
export function reportArchiveDropped(deps, entry, reason) {
  const d = deps ?? {}
  const item = entry ?? {}
  try {
    const text = String(reason ?? '下游未采用归档摘要')
    d.capabilities?.markDegraded?.('archiveToolResults', `归档未生效（${text}），未计收益`)
    d.onEvent?.({
      kind: 'archive-dropped',
      sessionId: item.sessionId,
      at: d.clock?.now?.() ?? Date.now(),
      callId: item.callId,
      tool: item.tool,
      totalChars: item.totalChars,
      keptChars: item.keptChars,
      reason: text,
      detail: `${item.tool} 输出已归档但未替换呈现（${text}），本条不计收益`,
    })
    return true
  } catch {
    return false
  }
}

/**
 * 造归档钩子。挂在 `tools/post-execute` 上。
 *
 * @param {{home: string, config: () => any, capabilities?: any, log?: any,
 *          onEvent?: (e: object) => void, clock?: any}} deps
 * @param {{deferCommit?: boolean}} [options]
 *   `deferCommit:true` → **只算出 content，不记账**，由调用方在确认替换成功后
 *   调返回值的 `commit()`。`after.js` 用这个模式（它才知道下游给没给 value）。
 *   默认 false → 归档即记账（直接调用方，例如单测与 `installArchiver` 的老路径）。
 * @returns {(exec: object, result: object, config?: object) => (object|null)}
 *   返回 null 表示不介入；否则是 `{ content, commit, dropped, entry, ... }`。
 */
export function createArchiver(deps, options = {}) {
  const deferCommit = options?.deferCommit === true
  // 自己的归档目录：读它产生的输出**不再归档**（2026-10-17 审计）。
  // 否则"读一个 20KB 归档文件 → 又被归档成 1591 字符摘要 → 中段要靠
  // 再读一次 → 又一次超阈值"，结构上会递归切碎证据。
  // `deps.home` 是插件数据根，归档在其下 `archive/`。
  const ownArchiveRoot = (() => {
    try {
      return normalizePath(pluginPaths(deps.home ?? resolveDshHome()).archive)
    } catch {
      return ''
    }
  })()
  return function archiveDecision(exec, result, config) {
    try {
      if (config?.archiveToolResults === false) return null
      if (!result || result.isError) return null          // 底线 2：失败结果不隐藏
      const toolName = String(exec?.name ?? '')
      if (!toolName || OWN_TOOLS.has(toolName)) return null
      // 技能正文是本轮必须执行的指令，不能用 head/tail 摘要替换。
      const instructionPath = extractPath(exec?.arguments)
      if (/(^|[/:.])(?:skill|read_skill|load_skill)$/i.test(toolName)
        || (instructionPath && /(?:^|[/\\])SKILL\.md$/i.test(instructionPath))) return null
      if (Array.isArray(config?.archiveExcludeTools) && config.archiveExcludeTools.includes(toolName)) return null
      // 目标落在自己的归档目录里 → 放行，不再归档。
      if (ownArchiveRoot) {
        const target = extractPath(exec?.arguments)
        if (target && isUnder(target, ownArchiveRoot)) return null
      }

      const { texts, others, totalChars } = splitContent(result.content)
      // 阈值 / 保留量都支持按工具覆盖（键为小写工具名）。
      const { threshold, keepChars } = resolveArchiveLimits(toolName, config)
      if (texts.length === 0 || totalChars < threshold) return null

      const sessionId = String(exec?.agent?.session?.id ?? '') || 'no-session'
      const callId = String(exec?.callId ?? '') || `call-${deps.clock?.now?.() ?? Date.now()}`
      const text = texts.map((b) => b.text).join('\n')

      const archived = archiveText(deps.home, sessionId, callId, toolName, text)
      if (!archived.ok) {
        // 底线 1：归档失败就保留原结果，并让降级可见。
        deps.capabilities?.markDegraded?.('archiveToolResults', `归档写入失败：${archived.reason}`)
        deps.log?.warn?.(`[warden] 结果归档失败，保留原始输出（${toolName}）：${archived.reason}`)
        deps.onEvent?.({ kind: 'archive-failed', sessionId, detail: `${toolName}：${archived.reason}` })
        return null
      }

      const summary = boundedSummaryFor({ toolName, text, archived, keepChars })
      // 一次归档的完整描述：记账要用它，但**记不记由调用方决定**（P1-11）。
      const entry = {
        sessionId, callId, tool: toolName, totalChars,
        keptChars: summary.length, hash: archived.hash,
        file: archived.file, bytes: archived.bytes, lines: archived.lines,
        committed: false,
      }
      // 回收（P2-8）：保洁动作，跟着真实归档顺带跑，当前会话目录永不回收。
      // 回收（P2-8）：保洁动作，跟着真实归档顺带跑，当前会话目录永不回收。
      // 阈值从配置读（2026-10-24 起进 DEFAULT_CONFIG 与三档预设）。
      // 0 = 关掉那一条判据；两条都关时 recycleArchive 自己会 early-return。
      try {
        recycleArchive(deps.home, {
          currentSessionId: sessionId,
          now: deps.clock?.now?.(),
          maxBytes: config.archiveMaxBytes,
          maxAgeDays: config.archiveMaxAgeDays,
        })
      } catch { /* 保洁失败不影响归档 */ }

      // 非文本块（图片/文件）原样保留在摘要之后 —— 底线：不盲删媒体块。
      const content = [{ type: 'text', text: summary }, ...others]
      const commit = () => commitArchive(deps, entry)
      const dropped = (reason) => reportArchiveDropped(deps, entry, reason)
      // 默认（不 defer）：归档即记账，保持 installArchiver / 单测的老语义。
      // after.js 传 deferCommit:true，把记账推迟到"确实赋了 content"之后。
      if (!deferCommit) commit()
      return { content, commit, dropped, entry }
    } catch (error) {
      deps.capabilities?.markDegraded?.('archiveToolResults', `归档判定异常：${error?.message ?? error}`)
      return null
    }
  }
}

/**
 * 挂到 `tools/post-execute`。
 *
 * 与 `host/after.js` 的提醒共存：那边负责"返工/重复读/错误分型"的提醒，
 * 这边负责"大输出归档"。两者都在同一条 waterfall 上，所以这里**只返回
 * content 替换建议**，由 `after.js` 统一组装最终决策，避免两个监听器
 * 互相覆盖 content。
 */
export function installArchiver(ctx, deps) {
  return createArchiver(deps)
}
