/**
 * laurel-context/host-compaction —— 把 Laurel provider 挂到宿主 ctx.compaction。
 *
 * 这是**唯一**允许 import 宿主形状的地方。
 *
 * ## 两层契约（D129 / D130 的教训）
 *
 * 契约有两层，修好第一层会让第二层第一次暴露出来：
 *   1. **注册**（D129）：宿主 `CompactionEngine extends Service`，实例上没有
 *      `setProvider` / `register`，接管只能在组合层（`ctx.provide('compaction')`
 *      或换掉提供该服务的那一行）。已修。
 *   2. **调用**（D130）：注册成功之后，宿主会按**它自己的签名**调三个方法。
 *      此前 Laurel 实现的是自己发明的签名，两边一起错、单测也一起错，
 *      所以从未被发现。本文件现在按宿主真实签名实现。
 *
 * ## 宿主真实契约（asar 内 `@deepseek-ai/dsh-compaction-basic/lib/index.js` 原文）
 *
 *   方法签名：
 *     compactIfNeeded(agent, trigger, signal)        // :915  trigger 是字符串
 *     compactNow(agent, signal, sourceCommandId)     // :986
 *     compactRegion(start, end, agent, signal)       // :972  start/end 是 **seq 整数**（闭区间）
 *   返回：`{ compactionId, startSeq, summarySeq, summary, shadowedRange:{start,end},
 *            shadowedSeqs, shadowedTokenCount, endSeq? }`，**没有可压时返回 `null`**
 *         （宿主用 `result !== null` 判断，返回 `{ok:false}` 会被当成"压过了"）。
 *
 *   session 模型：
 *     session.id / session.seq
 *     session.surface.nodes              // 当前表层的 seq 数组（这是表层的权威来源）
 *     session.surface.replaceGeneration  // 表层替换代数，用于稳定性校验
 *     session.eventAt(seq)               // 取事件
 *     session.deriveEventMessage(event)  // 事件 → 消息（可能为 null）
 *     session.append(type, data, opts?)  // 追加事件；opts.surfaceOp 才上表层
 *     session.requestHeader() / session.toolHistory()
 *
 *   表层替换（宿主的做法，见 :651）：
 *     session.append('user/message', checkpointMessage, {
 *       surfaceOp: { op: 'replace', startSeq, endSeq },
 *       sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
 *     })
 *
 * ## 为什么不再"取不到就用空 surface"
 *
 * D130 最危险的一点不是抛错，而是**静默成功**：旧实现忽略入参、拿自己内存里
 * 那份 surface 去压，宿主调用它压 A 会话时它压的是别的东西，还返回 `ok:true`。
 * 现在凡是拿不到真实 session / 表层，一律抛带原因的错，绝不假装成功。
 */

import { randomUUID } from 'node:crypto'
import { createCompactionProvider, ManualCompactionError } from './compaction-provider.mjs'
import { createEngine } from './engine.mjs'
import { summarizeWithModel } from './model-summarize.mjs'
import { summarizeMechanically } from './mechanical-summarize.mjs'

/** 宿主 compaction 契约要求的三个操作（dsh-compaction 的 CompactionEngine）。 */
export const COMPACTION_METHODS = Object.freeze(['compactIfNeeded', 'compactNow', 'compactRegion'])

/**
 * 判断一个 session 是不是宿主真实形状（seq 模型）。
 * 老测试里的假 session 只有 `events()`，走兼容路径。
 */
export function isHostSession(session) {
  return !!session
    && typeof session === 'object'
    && session.surface != null
    && Array.isArray(session.surface.nodes)
    && typeof session.append === 'function'
}

/** 取不到宿主 session 时抛这个，不静默。 */
function requireHostSession(session, where) {
  if (!session) throw new TypeError(`${where} 需要宿主 session（宿主要求第一个参数是 agent，从 agent.session 取）`)
  if (!isHostSession(session)) {
    throw new TypeError(
      `${where} 拿到的 session 不是宿主形状：缺 surface.nodes 或 append。`
      + '宿主真实 session 有 session.surface.nodes（seq 数组）与 session.append(type, data, opts)；'
      + '此前 Laurel 读的是 session.events()/appendEvent()/replaceRange()，宿主一个都没有。',
    )
  }
}

/** 从 agent 里取 session；宿主三个方法都把 agent 放在不同位置，这里统一。 */
function sessionOf(agent, fallback) {
  const s = agent?.session ?? fallback
  return s ?? null
}

/**
 * 从 ContentBlock 数组/字符串里取出**可读正文**。
 *
 * 宿主消息的正文是 ContentBlock 数组，块类型至少四种：
 *   `{type:'text', text}`     真对话内容 → 要
 *   `{type:'reasoning', text}` 模型内部推理 → 不要（它不是对话内容，
 *                              混进正文会让摘要预算被推理占满、真实指令被挤掉）
 *   `{type:'tool-call', ...}`  工具调用参数（结构化）
 *   `{type:'image', ...}`      图片（无文本）
 *
 * 之前两处都写错了：
 *   · `hostSurface()` 用 `JSON.stringify(content)` —— 把 JSON 结构、转义、
 *     reasoning 块全算成正文，长度虚高一个量级；
 *   · `providerFor()` 用 `String(e.content ?? e.text ?? '')` —— `content` 是数组时
 *     得到字面量 `'[object Object]'`（13 字符），于是引擎眼里每条事件正文都一样、
 *     大工具结果永远达不到 `BIG_RESULT_CHARS`、`ctx.externalize` 一次也不发生。
 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      if (typeof block === 'string') parts.push(block)
      continue
    }
    if (block.type === 'reasoning') continue
    if (typeof block.text === 'string' && block.text) parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 从宿主原始事件里取「工具调用 id」。
 *
 * 真实形状（以会话存档实测为准，见 `.session-scratch/verify-20261021/callid-shape.sh`）：
 *   `tool/call`        → `data.callId`（顶层就是 callId）
 *   `tool/result`      → `data.message.toolCallId`（包在 message 里）
 *   `assistant/message`→ `data.message.content[]` 里 `{type:'tool-call', id}`
 *
 * 原来只读 `ev.callId ?? ev.toolCallId` —— 而 `ev` 是 `{type,seq,time,data}`，
 * callId 一个都在 `data` 里层。实测表层 4508 条**带 callId 0 条**，于是：
 *   · `state.byCall` 永远空 → 摘要拿不到 ref（「按 ref 回读原文」直接断掉）；
 *   · 工具结果与外置结果无法配对，选区只能一路回退到极小值。
 *
 * 不猜：按「派生消息 → data.message → data 本身 → 顶层（老测试形状）」顺序取第一个非空字符串。
 */
function callIdOf(ev, msg) {
  const d = ev?.data ?? {}
  const m = d.message ?? {}
  const candidates = [msg?.toolCallId, m.toolCallId, d.callId, ev?.toolCallId, ev?.callId]
  for (const v of candidates) {
    if (typeof v === 'string' && v) return v
  }
  return null
}

/** 工具名：`tool/call` 的 `data.name`、`tool/result` 的 `data.message.name` 等。 */
function toolNameOf(ev, msg) {
  const d = ev?.data ?? {}
  const m = d.message ?? {}
  for (const v of [m.name, d.name, d.toolName, msg?.name, ev?.toolName, ev?.tool]) {
    if (typeof v === 'string' && v) return v
  }
  return null
}

/**
 * 把宿主 session 适配成 provider 需要的 journal 接口。
 *
 * **坐标换算**：provider 内部用 0-based 位置区间 `[start, end)`；
 * 宿主用 seq 闭区间 `[startSeq, endSeq]`。表层的权威来源是
 * `session.surface.nodes`，位置 i ↔ seq `nodes[i]`。
 *
 * 同时记录最近追加的三个生命周期事件，供 facade 拼宿主返回形状。
 */
export function adaptJournal({ session, vault, protectedItems = [] } = {}) {
  if (!session) throw new TypeError('adaptJournal 需要宿主 session')

  const host = isHostSession(session)
  const surfaceList = []
  const log = []
  const appended = { start: null, summary: null, end: null }

  /** 宿主模式：把 seq 数组映射成 provider 认的事件列表。 */
  function hostSurface() {
    const nodes = session.surface.nodes
    const out = []
    for (const seq of nodes) {
      let ev
      try {
        ev = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined
      } catch {
        ev = undefined
      }
      let msg = null
      try {
        msg = typeof session.deriveEventMessage === 'function' && ev ? session.deriveEventMessage(ev) : null
      } catch {
        msg = null
      }
      const role = msg?.role ?? ev?.role ?? 'user'
      const content = msg?.content ?? ev?.content ?? ev?.text ?? ''
      out.push({
        // eventId 必须是安全标识串（laurel-core format.mjs 的 assertId 会拒数字），
        // 真实 seq 单独放在 seq 字段里，坐标换算只认 seq。
        eventId: `ev-${seq}`,
        seq,
        role,
        kind: ev?.kind ?? ev?.data?.kind ?? (role === 'tool' ? 'tool' : 'message'),
        // 工具名与 callId 都在 `ev.data` 里层（见 callIdOf 的注释）。
        tool: toolNameOf(ev, msg),
        callId: callIdOf(ev, msg),
        // 用 textOfContent 而非 JSON.stringify：ContentBlock 数组的 JSON 结构
        // 与 reasoning 块都不是「对话正文」，让它们进 text 会让
        // BIG_RESULT_CHARS 与摘要预算按假长度算。
        text: textOfContent(content),
        content,
        raw: ev,
      })
    }
    return out
  }

  /** 兼容模式（老测试 / 非宿主形状）：沿用 events() 的 surfaceOp 约定。 */
  function legacySurface() {
    const events = typeof session.events === 'function' ? session.events() : (session.events ?? [])
    for (const e of events) {
      if (e?.surfaceOp) surfaceList.push({ ...e })
      else log.push({ ...e })
    }
  }

  if (!host) legacySurface()

  let openStartId = null
  const scanOpen = () => {
    if (host) {
      // 从尾往头找最近的 compaction/start / compaction/end
      let id = null
      const last = Number.isInteger(session.seq) ? session.seq : 0
      for (let seq = last - 1; seq >= 0; seq -= 1) {
        const ev = typeof session.eventAt === 'function' ? session.eventAt(seq) : null
        if (!ev) continue
        if (ev.type === 'compaction/end') return null
        if (ev.type === 'compaction/start') return ev.compactionId ?? ev.id ?? String(seq)
      }
      return id
    }
    let id = null
    for (const e of log) {
      if (e.type === 'compaction/start') id = e.id
      if (e.type === 'compaction/end' && e.id !== undefined) id = null
    }
    return id
  }
  openStartId = scanOpen()

  /**
   * D142：当前打开的 turn 号（没有则为 null）。
   *
   * 宿主 `dsh-session-format-v3-to-v4` 要求
   * `compaction/start.data.turn === 当前 open turn`，并且
   * `compaction/end.data.turn === start.turn`。Laurel 早先一律写 `null`，
   * 自动压缩发生在 turn 内时就写出非法日志：会话下次加载直接
   * `compaction/start does not match the open turn`。
   * 这里从日志尾部向前找最近的 turn/start / turn/end，取真实 turn 号。
   */
  const hostOpenTurn = () => {
    if (!host) return null
    const last = Number.isInteger(session.seq) ? session.seq : 0
    for (let seq = last - 1; seq >= 0; seq -= 1) {
      const ev = typeof session.eventAt === 'function' ? session.eventAt(seq) : null
      if (!ev) continue
      if (ev.type === 'turn/end') return null
      if (ev.type === 'turn/start') return ev.data?.turn ?? ev.turn ?? null
    }
    return null
  }

  /** 位置区间 → 宿主 seq 闭区间。 */
  function toSeqRange(range) {
    const nodes = session.surface.nodes
    const startSeq = nodes[range.start]
    const endSeq = nodes[Math.min(range.end, nodes.length) - 1]
    return { startSeq, endSeq }
  }

  const journal = {
    surface: () => (host ? hostSurface() : surfaceList.slice()),

    /** 追加生命周期事件。宿主模式翻译成 session.append(type, data)。 */
    append: (ev) => {
      if (!host) {
        log.push(ev)
        if (ev.type === 'compaction/start') openStartId = ev.id
        if (ev.type === 'compaction/end') openStartId = null
        if (typeof session.appendEvent === 'function') session.appendEvent(ev)
        return ev
      }
      let out = null
      if (ev.type === 'compaction/start') {
        out = session.append('compaction/start', {
          compactionId: ev.id,
          ...(ev.trigger?.kind === undefined ? {} : { trigger: ev.trigger.kind }),
          // D142：必须是当前 open turn，不能是 null
          turn: ev.turn ?? hostOpenTurn(),
        })
        appended.start = out
        openStartId = ev.id
      } else if (ev.type === 'compaction/summary') {
        const shadowedSeqs = session.surface.nodes.slice(ev.range?.start ?? 0, ev.range?.end ?? 0)
        const shadowedRange = shadowedSeqs.length
          ? { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1] }
          : null
        out = session.append('compaction/summary', {
          compactionId: ev.startId ?? appended.start?.data?.compactionId,
          summary: ev.text ?? ev.summary ?? '',
          shadowedRange,
          shadowedSeqs,
          shadowedTokenCount: ev.chars ?? 0,
          provider: 'laurel',
          model: null,
          ...(ev.usage === undefined ? {} : { usage: ev.usage }),
        })
        appended.summary = out
        // 记下正文本身，别只依赖 append 的返回值：宿主 append 返回什么形状
        // 不在我们控制内，读不到就退化成空摘要（D137 的第二个入口）。
        appended.summaryText = String(ev.text ?? ev.summary ?? '')
      } else if (ev.type === 'compaction/end') {
        out = session.append('compaction/end', {
          compactionId: ev.startId ?? appended.start?.data?.compactionId,
          // D142：宿主校验 end.turn 必须与 start.turn 相同
          turn: ev.turn ?? appended.start?.data?.turn ?? hostOpenTurn(),
          ...(ev.ok === false ? { error: { code: ev.code ?? 'unknown' } } : {}),
        })
        appended.end = out
        openStartId = null
      } else {
        out = session.append(ev.type ?? 'laurel/event', ev)
      }
      return out
    },

    /** 唯一表层变更：宿主用 surfaceOp 表达替换。 */
    replaceRange: (range, message) => {
      const before = range.end - range.start
      if (!host) {
        const removed = surfaceList.splice(range.start, before, {
          role: message.role ?? 'user',
          content: message.content,
          surfaceOp: message.surfaceOp ?? 'replace',
          meta: message.meta,
        })
        if (typeof session.replaceRange === 'function') session.replaceRange(range, message)
        return { before, after: 1, removed: removed.length }
      }
      const { startSeq, endSeq } = toSeqRange(range)
      if (startSeq === undefined || endSeq === undefined) {
        throw new ManualCompactionError('region-unstable', '选区无法映射到宿主 seq', { range, nodes: session.surface.nodes.length })
      }
      const sourceEventSeqs = [
        ...(appended.start?.seq === undefined ? [] : [appended.start.seq]),
        ...(appended.summary?.seq === undefined ? [] : [appended.summary.seq]),
        ...session.surface.nodes.slice(range.start, range.end),
      ]
      // D141：替换消息必须是**宿主完整消息**，不能只有 {role, content}。
      // 宿主 dsh-time-context / dsh-session-reference 会逐条读
      // `message.source.kind`（无守卫），只有 {role, content} 时 source 是
      // undefined → `Cannot read properties of undefined (reading 'kind')`，
      // 整轮在模型请求前死亡。宿主自己的 checkpoint 用 createUserMessage
      // 生成 id + source:{kind:'compact-checkpoint',compactionId} + content 块。
      // 这里按同一形状构造，内容统一成 text 块（字符串 content 宿主也会拒绝）。
      const content = typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : (Array.isArray(message.content)
          ? message.content.map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b))
          : [{ type: 'text', text: String(message.content ?? '') }])
      const compactionId = appended.start?.data?.compactionId
        ?? appended.start?.data?.id
        ?? message.meta?.compactionId
        ?? null
      session.append('user/message', {
        id: randomUUID(),
        role: message.role ?? 'user',
        content,
        source: {
          kind: 'compact-checkpoint',
          ...(compactionId === null ? {} : { compactionId }),
        },
      }, {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs,
      })
      // 宿主语义：替换后该区间变成 1 条；removed 是被替换掉的表层条数
      return { before, after: 1, removed: before }
    },

    hasOpenStart: () => (host ? scanOpen() !== null : openStartId !== null),

    /**
     * 选区稳定性：选区边界不能切断未配对的工具调用。
     *
     * D140：判据必须和宿主同构。宿主 `@deepseek-ai/dsh-compaction/tool-pairing`
     * 的算法是逐 node 折叠 `eventDelta`（assistant/message 里 tool-call 块数 +N，
     * tool/result −1，其余 0），`cutBalanced[i]` 记录「切在第 i 个 node 之前是否平衡」。
     * 此前这里写的是 `pending.every(h => h.callSeq < endSeq || h.callSeq > endSeq)` ——
     * 那等于「只排除刚好落在 endSeq 上的那一个」，比宿主宽松得多：一个很早发出、
     * 至今没回答的 tool/call 会被判成「平衡」，于是选区把它和答案切开，
     * 宿主在 replace 阶段直接拒绝（region-unstable / node 0 之类）。
     *
     * 参数 position 是**开区间 end**，即选区覆盖到 nodes[position-1] 为止；
     * 要求「切在 nodes[position-1] 之后」平衡 ⇔ 折叠到该 node 为止 inProgress === 0。
     */
    pairingBalancedAt: (position) => {
      if (!host) return true
      const nodes = session.surface.nodes
      const lastIdx = Math.min(position, nodes.length) - 1
      if (lastIdx < 0) return true
      let inProgress = 0
      for (let i = 0; i <= lastIdx; i += 1) {
        let ev
        try {
          ev = typeof session.eventAt === 'function' ? session.eventAt(nodes[i]) : undefined
        } catch {
          return true // 读不到就不阻断，交给 runCompaction 之后的宿主硬校验兜底
        }
        if (!ev) return true
        if (ev.type === 'assistant/message') {
          const content = ev.data?.message?.content
          if (Array.isArray(content)) {
            inProgress += content.filter((b) => b && b.type === 'tool-call').length
          }
        } else if (ev.type === 'tool/result') {
          inProgress -= 1
        }
      }
      return inProgress === 0
    },

    protectedItems: () => protectedItems,

    /** 供 facade 拼宿主返回形状。 */
    _appended: appended,
    _log: log,
    _surface: surfaceList,
  }

  return journal
}

/**
 * 把任意来源的 range 归一化成**表层绝对位置**（左闭右开）。
 *
 * ── 为什么必须在这里统一归一化（S4 / L07 / MC06）─────────────────────────
 * 这个仓库里 range 只有一个语义：**表层层面的绝对位置**。
 * 缺陷版本里 `compaction-provider.mjs:146` 先 `surface.slice(range.start, range.end)`
 * 而 `:147` 仍然把绝对 range 一起传下来，下游 `mechanical-summarize` 又按
 * range 切了一次 —— 同一个范围被切两遍：
 *   · start=1 → 只喂进去尾部 5/6，inputChars 少算、摘要少覆盖一段；
 *   · start=5 → 第二刀在只剩 2 条的数组上切 [5,7) → 切空 → ok:false / reason:'empty'，
 *     整次压缩失败（用户看到的是"压不动"）。
 * 现在约定写死：**上游永远传表层全量 events + 绝对 range，只在这里归一化一次，
 * 只由下游按归一化后的 range 切一刀**。
 *
 * @param {{start?:number,end?:number}|null|undefined} range
 * @param {number} length 表层条目数
 * @returns {{start:number,end:number}} 恒为整数、0 <= start <= end <= length
 */
function normalizeRange(range, length) {
  const len = Number.isFinite(length) ? Math.max(0, Math.floor(length)) : 0
  const rawStart = Number(range?.start ?? 0)
  const rawEnd = Number(range?.end ?? len)
  const start = Math.min(len, Math.max(0, Number.isFinite(rawStart) ? Math.floor(rawStart) : 0))
  const end = Math.min(len, Math.max(start, Number.isFinite(rawEnd) ? Math.floor(rawEnd) : len))
  return { start, end }
}

/** 归一化 range 在表层上的真实字符数 —— 用来核对"有没有被少算"。 */
function charsInRange(events, range) {
  const textOf = (ev) => String(ev?.text ?? ev?.content ?? '')
  let n = 0
  for (let i = range.start; i < range.end; i += 1) n += textOf(events[i]).length
  return n
}

/**
 * 摘要器工厂（S4 / L07 / MC06 的归一化落点）。
 *
 * 契约（唯一一份，写在这里；上游不许再切片）：
 *   `summarizer({ events, range, signal })`
 *     · `events` = **表层全量条目**（不预切）
 *     · `range`  = **表层绝对位置**，左闭右开
 *   切一刀由本函数按归一化后的 range 完成。
 *
 * 两条路线都在这里：
 *   ① 模型路线：gateway 启用时走模型（质量高，但有预算与网络依赖）。
 *   ② 机械路线：gateway 不可用时**不返回失败**，改为纯字符串压缩。
 *
 * D136：此前只有 ①。于是零推理档（默认档！）接管宿主压缩后，
 * summarizer 恒返回 gateway-disabled → compactIfNeeded 恒返回 null →
 * 宿主按契约理解成"没什么可压"→ 压缩彻底停摆。那不是"接管没生效"，
 * 是**接管把一个能工作的压缩器换成了空壳**，长会话会撑爆上下文。
 *
 * 返回体里带 `inputChars`（本次压缩实际覆盖的原文体量）：它是 MC06 的
 * 判据 —— 必须等于绝对 range 在表层上的真实字符数，不是切片后的残余量。
 */
export function createHostSummarizer({ engine = null, gateway = null, log = null, protectedItems = [], guardPolicy = null } = {}) {
  /**
   * ref 验活器：拿引擎去问「这个 ref 现在还取不取得到」。
   *
   * 【必修】不传 verifyRef 时 `filterResolvableRefs` 会把**每一个** ref 都判成
   * `no-verifier` 丢掉 → 摘要正文写着「可按引用回取」却一个引用都没有，
   * 用户照着找必然无据可查（MC04 复发路径）。没有引擎时宁可返回 undefined，
   * 让下游走「没有 ref 就不写回取承诺」的分支，而不是写一堆假引用。
   */
  const verifyRef = (engine && typeof engine.readOriginal === 'function')
    ? (ref) => {
      try {
        return engine.readOriginal(ref, { lines: 1 }).ok === true
      } catch {
        return false
      }
    }
    : undefined

  /**
   * 给表层事件补上 `ref`（callId → 外置原文 ref）。
   *
   * 宿主表层的工具结果事件只有 `callId`，没有 `ref`；而 `mechanical-summarize`
   * 收集引用时只认 `slice[i].ref` 与正文里的 `ctx://blob/…`。不补这一层，
   * 已经落盘的原文一个都不会出现在摘要里 —— 用户拿到摘要也没法回读（MC04/MC05）。
   *
   * 注意必须在这里补而不是在 `providerFor` 里补一次：`runCompaction` 每次都用
   * `journal.surface()` 现取表层（表层会被 replaceRange 缩短），
   * `providerFor` 时刻的快照到真正压缩时已经过期。
   */
  const enrichRefs = (list) => {
    if (!engine || typeof engine.refForCall !== 'function') return list
    return list.map((ev) => {
      if (!ev || ev.ref) return ev
      const ref = engine.refForCall(ev.callId)
      return ref ? { ...ev, ref } : ev
    })
  }

  return async function summarizer({ events = [], range, signal } = {}) {
    const surface = enrichRefs(Array.isArray(events) ? events : [])
    const abs = normalizeRange(range, surface.length)

    if (engine && gateway?.status?.().enabled) {
      // 【坐标系】不再做 `Math.min(abs.start, revision)` 这种夹取。
      // 表层位置与引擎 state.events 下标在历史被替换/遮蔽之后并不相等，
      // 夹取出来的 range 切到的是**别的**事件（还会让摘要块记下一个假范围）。
      // 现在：表层 events + 表层 range 直接交给模型路线切（仍然只切一次），
      // 覆盖身份由 coveredIds（eventId）表达，回到引擎后按身份映射下标。
      if (abs.end > abs.start) {
        const r = await summarizeWithModel({
          engine, gateway, range: abs, events: surface, signal, protectedItems, verifyRef, guardPolicy,
        })
        if (r.ok && r.acceptable) {
          return {
            ok: true,
            text: r.candidate.text,
            usage: r.usage,
            unknownUsage: r.unknownUsage,
            refs: r.refs ?? [],
            inputChars: charsInRange(surface, abs),
          }
        }
        if (r.ok && !r.acceptable) {
          // 模型没保留受保护项 → **不退回机械摘要糊过去**，直接拒。
          // 压丢限制条件比不压危险得多（这是 guard 存在的全部理由）。
          return { ok: false, reason: 'protected-items-missing', missing: r.missing, check: r.check }
        }
        // r.ok === false：模型这条路失败，落到机械路线（下面继续），但要留下原因
        log?.warn?.(`模型摘要失败，改用机械摘要：${r.reason}`)
      }
    }

    // ② 机械路线：零推理、确定性、不花一分钱。传**全量** events + 归一化 range。
    //
    // 【必修】这里必须把 engine / verifyRef / sourceRevision 一起传下去：
    //   · 没有 engine 时 `publishSummary` 只能做协议校验（`no-store`），
    //     摘要**从来不会写进 journal** —— 端点永远 summaries:0 / compactions:0，
    //     而宿主以为压过了（表层被替换、原文只在内存里）。
    //   · 没有 sourceRevision，「源变了就丢弃」那条协议校验恒等于 0。
    //   · 没有 verifyRef，ref 全被判 no-verifier 丢掉（见上面 verifyRef 的说明）。
    const mech = summarizeMechanically({
      events: surface,
      range: abs,
      protectedItems,
      engine: engine ?? undefined,
      verifyRef,
      sourceRevision: engine && Number.isFinite(engine.revision) ? engine.revision : undefined,
      guardPolicy: guardPolicy ?? undefined,
    })
    if (!mech.ok) {
      return {
        ok: false,
        reason: mech.reason ?? 'mechanical-failed',
        inputChars: mech.inputChars ?? 0,
        range: abs,
        problems: mech.problems ?? null,
      }
    }
    return {
      ok: true,
      text: mech.text,
      refs: mech.refs,
      usage: null,
      unknownUsage: true,
      mechanical: true,
      inputChars: mech.inputChars ?? charsInRange(surface, abs),
      range: abs,
      summaryId: mech.publishedId ?? null,
    }
  }
}

/**
 * 建一个符合**宿主真实签名**的 provider。
 *
 * 三个方法都从 `agent.session` 取会话，绝不使用 apply 时捕获的那一个
 * （apply 时根本没有 session —— 那正是 `adaptJournal 需要宿主 session` 的来源）。
 */
export function makeHostProvider({ session, vault, gateway, tier = 'zero', limitTokens = 200_000, protectedItems = [], engine = null, engineFor = null, measure = null, guardPolicy = null, triggerRatio = null, log = null } = {}) {
  /** 为某次调用建一个绑到那个 session 的 provider。 */
  function providerFor(targetSession) {
    requireHostSession(targetSession, 'makeHostProvider')

    const journal = adaptJournal({ session: targetSession, vault, protectedItems })
    // L10： 现在可能是函数（每次调用现解真实窗口），但 
    // 只接受数字 —— 在这里显式求一次值给它。求不出有限正数就传 undefined，
    // 让引擎按档位默认值走（不把 0 / NaN 传进去，否则压力会算成 Infinity / NaN）。
    const resolveLimitFor = (s) => {
      const v = typeof limitTokens === 'function' ? limitTokens(s) : limitTokens
      return Number.isFinite(v) && v > 0 ? v : undefined
    }
    const engineLimit = resolveLimitFor(targetSession)
    // 【必须按会话分引擎，不能共用一份】
    // 引擎的 `state.events` / `state.summaries` 是**按 sessionId 命名空间**重建的，
    // 摘要的 `range` 又是引擎内部的位置坐标（从 1 开始）。一个引擎如果被多个会话共用，
    // 第二个会话的第一条摘要必然落在第一个会话已发布摘要的 range 里 → 每次压缩都
    // `protocol-reject / range-overlaps-published` → 自动压缩永远失败 → 上下文只涨不降。
    // 真机症状：某会话 124 次压缩全部 summarise-failed，最后 1,050,256 tokens > 1,048,576。
    // `engineFor` 由调用方按会话给引擎（带缓存）；只有显式传 `engine` 时才共用，
    // 那是老调用方的兼容路径，不能用于多会话场景。
    const eng = typeof engineFor === 'function'
      ? engineFor(targetSession)
      : (engine ?? createEngine({ vault, sessionId: targetSession?.id ?? 'host', tier, ...(engineLimit ? { limitTokens: engineLimit } : {}) }))

    // 把宿主表层喂给引擎，让 range 与引擎内部对齐（否则摘要器取不到原文）
    const surfaceNow = journal.surface()
    const seen = new Set()
    const fresh = []
    for (let i = 0; i < surfaceNow.length; i++) {
      const e = surfaceNow[i]
      const id = e.eventId ?? `host-${i}`
      if (seen.has(id)) continue
      seen.add(id)
      const role = e.role ?? 'user'
      const kind = e.kind ?? (role === 'tool' ? 'tool' : 'message')
      fresh.push({
        eventId: id,
        role,
        kind,
        tool: e.tool ?? e.toolName ?? null,
        callId: e.callId ?? e.toolCallId ?? null,
        // 宿主形状里 `content` 是 ContentBlock 数组，`??` 不会跳过它
        // （只有 null/undefined 才跳过），`String(array)` = '[object Object]'。
        // 这条写错时：引擎里每条正文都是 13 字符 → 大结果永不外置（refs/blobs 恒 0）
        // → 摘要按噪声分配预算，`ok:true` 但压的内容是错的。
        // 优先用 surface 已经算好的 `text`（hostSurface 用 textOfContent 产出），
        // 拿不到才回落到 content 展平。
        text: (typeof e.text === 'string' && e.text) ? e.text : textOfContent(e.content),
      })
    }
    if (fresh.length && typeof eng.ingest === 'function') eng.ingest(fresh)

    // 摘要器：唯一一份实现在 createHostSummarizer 里（含 range 归一化），
    // 这里只负责把本次调用的 eng / gateway / protectedItems 绑进去。
    // 上游传的是**表层全量 events + 绝对 range**，不许预切（S4 / L07 / MC06）。
    const summarizer = createHostSummarizer({ engine: eng, gateway, log, protectedItems, guardPolicy })

    // D136：`allowZeroTierSummary: true` 是必需的，别删。
    // 零推理档的原始语义是"不做**语义**摘要"（不接模型、不花推理），
    // 但机械摘要本来就是零推理的 —— 把两者混为一谈，结果就是
    // 零推理档下 compactIfNeeded 恒返回 `zero-tier-no-inference`，
    // 接管之后宿主一条历史都压不掉。允许机械摘要不等于允许模型调用：
    // 模型路线由 summarizer 里的 gateway.status().enabled 单独把关。
    // L10：**宿主官方投影优先于字符数粗估**。给了 measure 就用它；它返回非有限数
    // （投影还没物化）时 `compactIfNeeded` 的 ratio 会变成 NaN → 判不出「超了」，
    // 于是不触发 —— 这是对的：拿不准就不许假装知道，也不许把字符数当 token 报账。
    // L10：limitTokens 可能是函数（每次调用现解真实窗口），原样透传 ——
    // 在这里求值就等于把它钉死在 apply 期那个还不存在的投影上。
    const inner = createCompactionProvider({
      journal, summarizer, tier,
      // limitTokens 同理：内部 `resolveLimit()` 不带参数调用，这里把它绑到本次会话，
      // 免得根层 provider 在处理 B 的压缩时用 A 的窗口算压力比。
      limitTokens: typeof limitTokens === 'function' ? () => resolveLimitFor(targetSession) : limitTokens,
      // measure / limitTokens 都可能是函数：按会话分引擎之后，它们必须知道
      // "这次问的是哪个会话"，否则多会话并发时会把 A 的用量/窗口算到 B 头上。
      // 内部只按 `measure(surface)` 调用，多传一个会话参数对老实现是安全的。
      ...(typeof measure === 'function' ? { measure: (surface) => measure(targetSession, surface) } : {}),
      // L09 第二处：宿主自动触发这条路的压力阈值以前写死读 TRIGGER_POLICY.pressure，
      // `config.triggerRatio` 存进了 runtime 却从没传到这里 —— profile 写
      // `triggerRatio: 0.05` 完全没反应。现在原样透传（数字或函数都行）。
      ...(triggerRatio === null || triggerRatio === undefined ? {} : { triggerRatio }),
      // 【选区避开已压过的区间】不传这个，第二次压缩必然撞 range-overlaps-published
      // 并无限重试（真机实测 errors 27 / 用量一度 92%，一次也压不进去）。
      // **必须用本次会话的 `eng`**，不是外层 `engine`：按会话分引擎之后，
      // 外层那台是别的会话（或根层展示引擎），它的 coveredIds 与本会话无关，
      // 拿它跳头部会跳过本会话没压过的事件，或者漏掉本会话压过的。
      //
      // 优先 `coveredFlagsOf`：引擎 state.events 是**摄取到达顺序**，宿主表层是
      // **seq 升序**，两者顺序不同（ev-9 这类小 seq 可能很晚才到）。让引擎按
      // 表层身份直接回答「这条压过没有」，比调用方拿集合自己推区间可靠。
      // 老引擎没有这个口时退回 coveredEventIds（集合）。
      ...(typeof eng.coveredFlags === 'function'
        ? { coveredFlagsOf: (ids) => eng.coveredFlags(ids) }
        : {}),
      ...(typeof eng.coveredEventIds === 'function'
        ? { coveredIdsOf: () => eng.coveredEventIds() }
        : {}),
      allowZeroTierSummary: true,
    })
    return { journal, inner }
  }

  /**
   * 把 provider 内部结果翻译成宿主契约形状。
   * 宿主用 `result !== null` 判断"压过了没有"，所以无候选必须返回 null。
   *
   * **必须先快照表层**：provider 压完之后表层已经被替换，这时再读
   * `journal.surface()` 拿到的是"替换后的样子"，shadowedSeqs 会算成
   * `[摘要seq, 幸存seq...]` 这种毫无意义的组合（实测 [10,6,7]）。
   * 所以调用方要在压缩**之前**把 seq 列表取出来传进来。
   */
  function toHostResult(journal, innerResult, range, surfaceSeqsBefore) {
    if (!innerResult || innerResult.ok !== true) return null
    const nodes = surfaceSeqsBefore
    const startIdx = range?.start ?? 0
    const endIdx = (range?.end ?? 0) - 1
    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
    const start = journal._appended?.start
    const summary = journal._appended?.summary
    const end = journal._appended?.end
    return {
      compactionId: start?.data?.compactionId ?? innerResult.startId ?? null,
      startSeq: start?.seq ?? null,
      summarySeq: summary?.seq ?? null,
      ...(end?.seq === undefined ? {} : { endSeq: end.seq }),
      summary: summary?.data?.summary ?? journal._appended?.summaryText ?? '',
      shadowedRange: { start: shadowedSeqs[0] ?? null, end: shadowedSeqs[shadowedSeqs.length - 1] ?? null },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount: innerResult.chars ?? 0,
      provider: 'laurel',
      model: null,
      ...(innerResult.usage === undefined || innerResult.usage === null ? {} : { usage: innerResult.usage }),
    }
  }

  /** 取一个可用的 session：优先本次调用传入的，其次 apply 时捕获的。 */
  function resolve(agent, where) {
    const s = sessionOf(agent, session)
    requireHostSession(s, where)
    return s
  }

  /**
   * 契约操作之一：自动触发。
   * 宿主签名 compactIfNeeded(agent, trigger, signal)，trigger 是字符串
   * （'pressure' | 'context-overflow'）。
   */
  async function compactIfNeeded(agent, trigger, signal) {
    const s = resolve(agent, 'compactIfNeeded')
    const { journal, inner } = providerFor(s)
    // 压缩前快照 seq 列表：压完表层就被替换了，事后读会算错 shadowedSeqs
    const seqsBefore = journal.surface().map((e) => e.seq ?? e.eventId)
    const kind = typeof trigger === 'string' ? trigger : (trigger?.kind ?? 'pressure')
    let r
    try {
      r = await inner.compactIfNeeded({ signal, trigger: { kind } })
    } catch (e) {
      if (e instanceof ManualCompactionError) throw e
      throw new ManualCompactionError('summarise-failed', String(e?.message ?? e))
    }
    if (!r || r.ok !== true) return null
    return toHostResult(journal, r, r.range, seqsBefore)
  }

  /** 契约操作之二：显式按需。宿主签名 compactNow(agent, signal, sourceCommandId)。 */
  async function compactNow(agent, signal, sourceCommandId) {
    const s = resolve(agent, 'compactNow')
    const { journal, inner } = providerFor(s)
    const seqsBefore = journal.surface().map((e) => e.seq ?? e.eventId)
    const r = await inner.compactNow({ signal })
    if (!r || r.ok !== true) return null
    const out = toHostResult(journal, r, r.range, seqsBefore)
    if (sourceCommandId !== undefined && out) out.sourceCommandId = sourceCommandId
    return out
  }

  /**
   * 契约操作之三：指定范围。
   * 宿主签名 compactRegion(start, end, agent, signal)，**start/end 是 seq 闭区间**。
   */
  async function compactRegion(start, end, agent, signal) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new ManualCompactionError('region-unstable', '选区非法（宿主传 seq 整数）', { start, end })
    }
    const s = resolve(agent, 'compactRegion')
    const { journal, inner } = providerFor(s)
    // seq → 位置
    const nodes = s.surface.nodes
    const seqsBefore = nodes.slice()
    const startIdx = nodes.indexOf(start)
    const endIdx = nodes.indexOf(end)
    if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
      throw new ManualCompactionError('region-unstable', '选区 seq 不在当前表层', { start, end })
    }
    const range = { start: startIdx, end: endIdx + 1 }
    const r = await inner.compactRegion(range, { signal })
    if (!r || r.ok !== true) return null
    return toHostResult(journal, r, range, seqsBefore)
  }

  const facade = { compactIfNeeded, compactNow, compactRegion }

  // 自检用：暴露契约声明，方便探针核对签名
  Object.defineProperty(facade, '__laurelContract', {
    value: Object.freeze({
      shape: 'host',
      methods: {
        compactIfNeeded: ['agent', 'trigger', 'signal'],
        compactNow: ['agent', 'signal', 'sourceCommandId'],
        compactRegion: ['start', 'end', 'agent', 'signal'],
      },
      returnsNullWhenNothing: true,
    }),
    enumerable: false,
  })

  return facade
}

/**
 * 接管宿主压缩。
 *
 * **真实契约**（asar 内 `@deepseek-ai/dsh-compaction/lib/index.js` 原文）：
 * ```js
 * var CompactionEngine = class extends Service {
 *     constructor(ctx) { super(ctx, "compaction") }
 * }
 * ```
 * 它是 Cordis 的 **Service**：`ctx.compaction` 的值就是这个实例，实例上只有
 * `ctx` / `name` 和三个抽象方法。README 对"怎么接管"的原话是
 * 「把你的类作为插件加载，它就会成为该组合的压缩服务」——
 * 也就是说**接管发生在组合层**（谁 mount 了提供这个服务名的行），
 * 不存在 `setProvider` / `register` 这类运行时替换 API。
 *
 * 早先这里按 `svc.setProvider(provider)` / `svc.register(provider)` 探测，
 * 与真实契约不符：真实实例上没有这两个方法，于是永远落到 `unsupported-shape`，
 * 而 `at10-load-sim` 用的是**自造**的 `{ setProvider() {} }` 假 ctx，
 * 所以测试全绿、真实宿主永远接管不了（D129）。
 *
 * 现在只做两件真实可行的事：
 * 1. 本 realm 里 `compaction` 还空着 → `ctx.provide('compaction', provider)` 占住它；
 * 2. 已被占用 → 返回 `occupied`，并说清必须改组合层，绝不假装成功。
 */
export function registerWithHost(ctx, provider) {
  if (!ctx || typeof ctx !== 'object') return { ok: false, reason: 'no-ctx', canTakeOver: false }

  const get = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : ctx[name])
  let existing
  try {
    existing = get('compaction')
  } catch {
    existing = undefined
  }

  if (existing) {
    // 重复 apply / 热重载：已经是我们的实现就幂等成功，不重复注册。
    if (existing === provider) return { ok: true, via: 'provide', reused: true }
    return {
      ok: false,
      reason: 'occupied',
      note:
        'ctx.compaction 已被宿主实现占用。Cordis 的 Service 没有运行时替换 API'
        + '（真实契约里没有 setProvider/register）；接管只能在组合层做：'
        + '把该组合里提供 compaction 的那一行（通常是 compaction-basic）换成 laurel-context。',
      available: Object.keys(existing).slice(0, 20),
      canTakeOver: false,
    }
  }

  const provide = typeof ctx.provide === 'function' ? ctx.provide.bind(ctx) : null
  if (!provide) {
    return {
      ok: false,
      reason: 'unsupported-shape',
      note:
        '这个 ctx 既没有已注册的 compaction 服务、也没有 provide，无法注册实现。'
        + '（正常 Cordis ctx 一定有 provide；出现这个说明 ctx 不是真的 Context。）',
      canTakeOver: false,
    }
  }

  try {
    provide('compaction', provider)
  } catch (e) {
    return {
      ok: false,
      reason: 'provide-failed',
      error: String(e?.message ?? e),
      note:
        'ctx.provide("compaction") 抛错，通常表示同名服务已被注册（Cordis 会报 '
        + '`service "compaction" has been registered at <fiber>`）；接管需改组合层。',
      canTakeOver: false,
    }
  }

  const blind = invisibleToAgent(ctx, 'compaction', provider)
  if (blind.blind) {
    return {
      ...blind.verdict,
      via: 'provide',
      siblingCount: blind.siblingCount,
      isolatedEntries: blind.isolatedEntries,
    }
  }

  return { ok: true, via: 'provide', siblingProbe: blind.siblingProbe, isolateProbe: blind.isolateProbe }
}

/**
 * 「根层 provide 之后，agent 到底看不看得见」—— 唯一判据，两条路共用。
 *
 * `registerWithHost` 在 provide 之后调它，`lib/index.js` 的读取时复检也调它。
 * 分成两份写过一次就漂了（D131 第一次修复时读取时复检仍只数兄弟），所以合成一个。
 *
 * 两条信号各自都不充分，合起来才够：
 *   - 只数兄弟：组内没人提供这个服务时兄弟数是 0，但 isolate 组照样看不到根层
 *     （实测 `implementation/prove-isolate-empty-group.sh` → `GROUP-SEES-UNDEFINED`）。
 *   - 只读 isolate 声明：读不到 loader 时拿不到声明，会漏。
 * 任一成立都足以断定"agent 看不到这次 provide"，所以用或。
 *
 * 返回 `{ blind: boolean, verdict?, siblingProbe, isolateProbe, siblingCount, isolatedEntries }`。
 */
export function invisibleToAgent(ctx, name, ownValue) {
  const iso = isolateDeclarations(ctx, name)
  const siblings = siblingImpls(ctx, name, ownValue)
  const base = {
    siblingProbe: siblings.probe,
    isolateProbe: iso.probe,
    siblingCount: siblings.count,
    isolatedEntries: iso.entries,
  }
  if (iso.entries.length === 0 && siblings.count === 0) return { blind: false, ...base }
  return {
    blind: true,
    ...base,
    verdict: {
      ok: false,
      reason: 'isolated-sibling',
      note:
        `ctx.provide("${name}") 在根层成功了，但宿主在别的 isolate 域里也解析 ${name}`
        + '（桌面 profile 的 agent 预设就是 `isolate: { compaction: true }` 分组）。'
        + 'Cordis 按 symbol 解析服务，该组内的 agent 用的是另一个 symbol，看不到根层这次 provide —— '
        + '哪怕组内没人提供它也一样（组内没人时兄弟数是 0，但隔离依然生效）。'
        + '所以 agent 拿到的不是 Laurel，Laurel 的 provider 不会被调用，这次 provide 不能算接管成功。'
        + '真要接管必须改组合层，而且**只有一种安全写法**：'
        + '① 把预设 compaction 组里的 `isolate: { compaction: true }` 去掉（让组直接解析根层）；'
        + '② 同时删掉组内那一行 `compaction-basic`。'
        + '两件必须一起做 —— 只去掉 isolate 会在 agent 起来时抛 `service "compaction" has been registered`；'
        + '只删 compaction-basic 则组内什么压缩实现都没有（比现在更糟）。'
        + '**不要**把 laurel-context 塞进每个预设组：laurel-context 还会 provide `laurel.context`，'
        + '而预设的 isolate 只声明了 compaction，于是第二个预设加载时就会撞名抛错。'
        + '（两条都有真 cordis 库实证：implementation/prove-drop-isolation-order.mjs、'
        + 'implementation/prove-four-loads-collide.mjs）',
      canTakeOver: false,
    },
  }
}

/**
 * 数出「同名服务、但 symbol 不是本 ctx 当前解析到的那一个」的实例个数。
 *
 * 只在拿得到 `ctx.reflect.store` 时能数；拿不到就返回 `count: 0` 并在
 * `probe: 'unavailable'` 里说明 —— 不假装数过。
 */
export function siblingImpls(ctx, name, ownValue) {
  const store = ctx?.reflect?.store
  if (!store || typeof store !== 'object') return { count: 0, probe: 'unavailable' }
  const keys = Object.getOwnPropertySymbols(store)
  let count = 0
  for (const key of keys) {
    const impl = store[key]
    if (!impl || impl.name !== name) continue
    if (impl.value === ownValue) continue
    count += 1
  }
  return { count, probe: 'ok' }
}

/**
 * 找出组合层里声明了 `isolate: { <name>: ... }` 的 entry，**包括预设内部的嵌套组合**。
 *
 * 这是 D131 的**主判据**：`isolate` 让该 entry 用自己的 symbol 解析服务，所以根层的
 * `provide` 对它**永远不可见** —— 哪怕组内根本没人提供这个服务（实测
 * `VERDICT=GROUP-SEES-UNDEFINED`，见 `implementation/prove-isolate-empty-group.sh`）。
 *
 * **必须递归扫 `options.config.plugins`**（D131 第一次修复漏了这层）：桌面 profile 的
 * `preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis` 每个都在**自己的**
 * `config.plugins` 里写了 `- id: compaction` + `isolate: { compaction: true }` +
 * `compaction-basic`。这些是 agent 预设运行时动态加载的子组合，**不是** `loader.entries()`
 * 的顶层成员，只扫顶层会一个都找不到 → 报假 `ok:true`。
 * 证据：`implementation/prove-preset-has-compaction.sh`。
 *
 * 读不到 loader 时返回 `{ entries: [], probe: 'unavailable' }`，不假装查过。
 */
export function isolateDeclarations(ctx, name, { coveringName = null } = {}) {
  let loader
  try {
    loader = typeof ctx.get === 'function' ? ctx.get('loader') : ctx?.loader
  } catch {
    loader = undefined
  }
  if (!loader || typeof loader.entries !== 'function') return { entries: [], probe: 'unavailable' }
  const hits = []
  const seen = new Set()
  // S8 换装之后，`isolate` 声明**故意保留**（overlay.mjs:174：provider 要在组自己的
  // LocalRealm 里加载，agent 才天然看得见；拆掉 isolate 会抛 `service "compaction"
  // has been registered`）。于是「有 isolate 声明」不再等于「Laurel 到不了」——
  // 判据变成「这个隔离组里那一行是不是 Laurel」。给了 coveringName 就顺带算出来。
  const rowsOf = (item) => [
    item?.config,
    item?.options?.config,
    item?.config?.plugins,
    item?.options?.config?.plugins,
    item?.plugins,
  ]
  const coveredBy = (item) => {
    if (!coveringName) return null
    for (const rows of rowsOf(item)) {
      if (Array.isArray(rows) && rows.some((r) => r && r.name === coveringName)) return true
    }
    return false
  }
  const walk = (list, trail) => {
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const id = item.id ?? item.options?.id ?? null
      const iso = item.isolate ?? item.options?.isolate
      if (iso && Object.prototype.hasOwnProperty.call(iso, name)) {
        const key = `${trail}/${id}`
        if (!seen.has(key)) {
          seen.add(key)
          const rec = { id, label: iso[name], where: trail }
          if (coveringName) rec.coveredByLaurel = coveredBy(item)
          hits.push(rec)
        }
      }
      // cordis:group 的子项在 config（数组）里；agent-preset 的在 config.plugins 里。
      walk(item.config, `${trail}/${id}`)
      walk(item.options?.config, `${trail}/${id}`)
      walk(item.config?.plugins, `${trail}/${id}`)
      walk(item.options?.config?.plugins, `${trail}/${id}`)
      walk(item.plugins, `${trail}/${id}`)
    }
  }
  let scanned = 0
  try {
    for (const entry of loader.entries()) {
      scanned += 1
      const opts = entry?.options ?? {}
      const id = entry?.id ?? opts.id ?? null
      if (opts.isolate && Object.prototype.hasOwnProperty.call(opts.isolate, name)) {
        const key = `/${id}`
        if (!seen.has(key)) {
          seen.add(key)
          hits.push({ id, label: opts.isolate[name], where: '/' })
        }
      }
      walk(opts.config?.plugins, `/${id}`)
      walk(opts.plugins, `/${id}`)
    }
  } catch (e) {
    return { entries: [], probe: 'error', error: String(e?.message ?? e), scanned }
  }
  return { entries: hits, probe: 'ok', scanned }
}

/**
 * 换装路径（`hostCompaction.via === 'preset-overlay'`）上的探测读数。
 *
 * **这两个数在换装路径上不是判据，但必须如实报出来。**
 *
 * 为什么不是判据：`invisibleToAgent()` 的结论是「根层 provide 到不了 isolate 组」。
 * 换装走的是另一条路 —— 把预设组里那一行 `compaction-basic` 直接换成
 * `laurel-context/compaction`，于是 provider 在**组自己的 LocalRealm** 里加载，
 * agent 解析到的就是 Laurel。`overlay.mjs:174-175` 明确规定 `isolate` 一律不动，
 * 正是为了让这件事发生。所以换装成功后 `isolatedEntries` **必然非空**，
 * 那四个 `isolate: { compaction: true }` 声明是**机制**，不是「agent 看不见」。
 *
 * 为什么还必须报：手册 5.3 第 2 条要求端点给出 `siblingCount:0` /
 * `isolatedEntries:[]`。此前换装成功分支提前 return，这两个键在快照里根本不存在
 * （`undefined`），读者既无法判断「是不是 0」也无法判断「是不是没测」——
 * 这正是本轮踩的坑：拿 `undefined` 当「不满足」会误判，拿它当「满足」会漏判。
 * 所以：读数照给，另加 `judge:'not-blind-by-design'` 说明它为何不参与判定。
 *
 * @param {object} ctx     根层 Context（用来读 loader / reflect.store）
 * @param {string} name    服务名（'compaction'）
 * @param {*} ownValue     Laurel 自己的 provider（用于从兄弟里排除自己）
 */
export function probeOverlayTakeover(ctx, name, ownValue) {
  const sib = siblingImpls(ctx, name, ownValue)
  const iso = isolateDeclarations(ctx, name)
  return {
    siblingCount: sib.count,
    isolatedEntries: iso.entries,
    siblingProbe: sib.probe,
    isolateProbe: iso.probe,
    // 判据说明：这两个读数**不参与**「接没接上」的判定，接上的证据是
    // presetOverlay.basicRowsSwapped / basicRowsLeftAfterSwap===0。
    judge: 'not-blind-by-design',
    isolateMoot: true,
  }
}

export { ManualCompactionError }
