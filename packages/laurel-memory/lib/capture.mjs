/**
 * laurel-memory/capture —— 宿主半边的「真的开始记录」（宿主无关部分）。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────
 * 在此之前 `lib/index.js` 只做了三件事：开仓、建网关、挂只读数据面。
 * `adapter-dsh.mjs` 里的 `shouldCapture` / `identityFromEvent` /
 * `classifyAuthor` 是**死代码** —— 全仓库只有 `tests/adapter.test.mjs`
 * 引用它们，宿主侧一次都没调用，于是核心仓 `journalSeq` 永远是 0，
 * `toolSurface()` 产出的工具定义也没有任何消费者。
 *
 * 这里把两段纯逻辑抽出来：
 *   1. 宿主事件 → 记忆记录（`createCapture`）
 *   2. 工具参数 → 查询结果文本（`executeMemoryQuery`）
 * 接线（取服务、订阅、注册）留在 `index.js`，逻辑本身可以脱离宿主单测。
 *
 * ── 纪律（与 index.js 顶部那份一致，这里再写一次因为最容易破）──────────
 *  1. **采集是旁路**：任何失败只影响本次采集，绝不影响宿主里正在进行的对话。
 *     `handleSessionEvent` 保证不抛 —— 内部逐层 try/catch，返回值只作诊断。
 *  2. **不造孤儿**：身份不全（缺 sessionId / 缺 cwd）就跳过。不用随机值、
 *     不用「最近会话」兜底；那种记录永远回不到来源。
 *  3. **幂等**：同一条宿主事件（同 sessionId + 同 seq）重复投递只写一条记录。
 *     幂等键是确定性的，重放/重试/进程重启都不会多出一条。
 *  4. **写入只经 vault.commit**（先 blob 后 journal），与 `lib/cli.mjs` 同一条路，
 *     不另开旁路写 journal。
 *  5. 记录落 `memory/records.jsonl`，与 `lib/cli.mjs` 的 `RECORDS_FILE` **同一个文件**：
 *     CLI 与宿主工具两条读路径必须看到同一批记录，不能各建一份。
 *
 * ── 采集出来的 kind 怎么定（L05，2026-10-21 修订）────────────────────────
 * 早先这里一律写 `kind:'log'`，理由是「采集层只看到谁说了什么，没资格判定
 * 那句话是偏好、要求还是事实」。理由是**对的**，结论是**错的**：
 * 实测真仓 29,819 条记录里 kind 全是 `log`，`preference`/`requirement`/`fact`
 * 六种白名单形同虚设 —— 全是 log 等于没有 kind，检索与注入都拿不到语义分层。
 *
 * 现在的做法：用**确定性关键词规则**（`adapter-dsh.mjs` 的 `classifyRecordFields`，
 * 与存量迁移脚本共用同一份）映射到六种 kind，并给 fact/requirement/preference
 * 生成 ≤60 字符的确定性 title。规则表是启发式、不是理解，所以：
 *  - author / evidence 原样保留，整理阶段仍可人工纠正；
 *  - `^调用 <工具名> ` 形态的工具调用日志归 `progress` 且标 `indexable:false`
 *    （落库可审计，但不进检索 —— L04 的去污染）；
 *  - 记忆套件自身工具（laurel_memory/laurel_context）的调用与回显**不采集**，
 *    否则「查一次污染一次」会自增强退化。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { commit as commitUnit, readBody as readBodyUnit } from '../../laurel-core/lib/vault.mjs'
import { readJournal } from '../../laurel-core/lib/journal.mjs'
import { getBlob } from '../../laurel-core/lib/blob.mjs'
import { contentHash } from '../../laurel-core/lib/format.mjs'
import { budgetFor, classifyRecordFields, identityFromEvent, isSelfEchoRecord, projectIdentityOf, shouldCapture } from './adapter-dsh.mjs'
// MC10 之后 `pageBody` / `searchMemory` 不再由本文件直接调用：检索统一走
// `projection.mjs` 的 `searchProjection`，分页读原文由本文件的 `pageText`
// 负责（它要按 blob 读全文，不能用只读 `record.body` 的 `pageBody`）。
// 留着未使用的 import 会让人误以为这里有第二条检索路径。
import { makeRecord } from './memory/index.mjs'
// MC10：经验（experience/episodes.jsonl）必须与记录走同一个查询投影，
// 否则「问一句过去怎么做的」只能查到事实流水，查不到已验证的做法。
import { describeEpisode, loadEpisodes, searchProjection } from './projection.mjs'
import { redactText, REDACT_VERSION } from './redact.mjs'

/** 记录文件：与 `lib/cli.mjs` 的 `RECORDS_FILE` 必须保持同一个字符串。 */
export const RECORDS_FILE = 'memory/records.jsonl'

/** 单条记录正文上限。宿主消息可能很长（贴了整个文件），全量进仓会拖垮检索。 */
const DEFAULT_MAX_BODY_CHARS = 8000

/** 工具结果的默认分页行数与上限行数。 */
const DEFAULT_PAGE_LINES = 40
const MAX_PAGE_LINES = 200

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

/* ───────────────────────── 事件归一 ───────────────────────── */

function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function sessionIdOf(session) {
  return asString(session?.id) ?? asString(session?.sessionId)
}

function cwdOf(session) {
  const cwd = session?.header?.cwd ?? session?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : null
}

/** 从 ContentBlock[] 里取可读文本；隐藏推理块**不取**。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * 只有推理块、没有正文、**也没有工具调用** → 这条消息才是内部思考，不该落库。
 *
 * P1-3：第三个条件不能省。DSH 的助手轮几乎总是 `reasoning + tool-call` 的组合
 * （实测一次会话 591 条 `assistant/message` 里 590 条带 tool-call，纯 reasoning 只有 1 条）。
 * 只看「有推理、没正文」就丢，等于把**所有**带工具调用的助手轮整类丢掉 ——
 * 而那一轮恰恰是「它决定做什么」，是记忆最该留住的东西（"当初为什么这么做"）。
 * 思维链正文仍然不采（`textOfContent` 只认 text 块），采的只是工具名 + 参数摘要。
 */
function reasoningOnly(content) {
  if (!Array.isArray(content)) return false
  let reasoning = false
  let text = false
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    // 带工具调用 → 这一轮有可观察的产出，不属于隐藏推理。
    if (block.type === 'tool-call') return false
    if (block.type === 'reasoning') reasoning = true
    else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') text = true
  }
  return reasoning && !text
}

/** 从 ContentBlock[] 里取工具调用块（P0-1 与 P1-3 共用）。 */
function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  const calls = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'tool-call') continue
    calls.push({
      id: asString(block.id),
      name: asString(block.name) ?? 'unknown',
      arguments: block.arguments,
    })
  }
  return calls
}

/**
 * 参数 → 字符串。宿主给的是 JSON 字符串（实测 676/676 都是 string 且都能 JSON.parse），
 * 但也容忍对象与坏 JSON：**解析不了就原样保留**，不许因为格式问题把参数吞掉。
 */
function stringifyArgs(args) {
  if (typeof args === 'string') {
    const raw = args.trim()
    if (!raw) return '{}'
    try { return JSON.stringify(JSON.parse(raw)) } catch { return raw }
  }
  if (args !== null && typeof args === 'object') {
    try { return JSON.stringify(args) } catch { return String(args) }
  }
  return '{}'
}

/** 参数摘要：单行化 + 限长。用于「决定/计划」类正文，全量参数由 tool/call 记录承担。 */
function summarizeArgs(args, max = 200) {
  const text = stringifyArgs(args)
  return text.length <= max ? text : `${text.slice(0, max)}…(+${text.length - max})`
}

/**
 * 正文装配。三种事件各有各的「该记什么」：
 *  - `tool/call`：**工具名 + 入参**。这是「当初下的是什么命令」的唯一落点（P0-1）。
 *  - 其它（user / assistant / tool/result）：正文就是可读 text 块（既有行为，不改）。
 *  - 助手轮只有推理块但带 tool-call：退而记「决定调用了哪些工具」（P1-3），
 *    不记思维链正文。
 */
function bodyOf(type, { content, data, toolCalls }) {
  if (type === 'tool/call') {
    const name = asString(data.name) ?? asString(toolCalls[0]?.name) ?? 'unknown'
    return `调用 ${name} ${stringifyArgs(data.arguments ?? toolCalls[0]?.arguments)}`
  }
  const text = textOfContent(content)
  if (text) return text
  if (toolCalls.length) {
    return toolCalls.map((c) => `调用 ${c.name} ${summarizeArgs(c.arguments)}`).join('\n')
  }
  return ''
}

/**
 * P0-1 配套：把工具名解析成一个**结构化字段**，让查询能按工具过滤，
 * 不必从正文里正则抠名字。
 *
 * `tool/call` 自带 `data.name`（实测 676/676 都有）。
 * `tool/result` 的事件里**没有**工具名，只有 `message.toolCallId` —— 那就要靠采集器
 * 在收到 `tool/call` 时登记的 `callId → name` 表反查。
 * 查不到时返回 null 而不是编一个名字：旧日志重放、跨进程、或者 tool/call 落在
 * 采集范围之外时，名字确实不可知，编出来就是假数据。
 */
function toolNameOf(event, type, callNames) {
  if (type !== 'tool/call' && type !== 'tool/result') return null
  const direct = asString(event?.toolName)
  if (direct) return direct
  const callId = asString(event?.toolCallId)
  if (callId && callNames?.has(callId)) return callNames.get(callId)
  return null
}

/**
 * 宿主消息来源 → `classifyAuthor` 认得的角色名。
 *
 * 宿主的 `MessageSourceMap` 是 `user | model | tool | system-prompt`，
 * 适配层用的是 `user | assistant | tool | system`。不转这一手，
 * 真实事件会一路落到 `unknown` 被全部拒掉（这正是此前「一条都不采」的原因之一）。
 * `plugin` / `injection` 原样透传，交给 `classifyAuthor` 判成 system。
 */
/**
 * P2-10：宿主往 `user/message` 里塞的**系统注入**来源。
 *
 * 实测一次会话 39 条 user/message 的 `source.kind` 分布：
 * `time-context 13 / subagent-settled 9 / user 5 / agent-message 5 /
 * model-selection 2 / user-approval 1 / agent-instructions 1 /
 * runtime-context 1 / skill-catalog 1 / tool-jobs 1`。
 *
 * 这些不是用户说的话，是宿主塞进上下文的时间、运行环境、技能目录、
 * 模型选择、审批策略变更、作业列表和指令。以前它们既不是白名单里的
 * `user/assistant/tool/system`，就一路落到 `unknown` 被 `unknown-author` 丢掉 ——
 * 丢是对的，**理由记错**才是问题（事后看不出「是注入」还是「身份不明」）。
 * 显式归 `system` 后跳过原因变成诚实的 `system-or-injected`。
 *
 * `user-approval` 也归 system：它通告的是「审批策略被改了」这一环境事实，
 * 不是一条用户任务；把它当 user 会让 `user-said` 这个证据等级说谎。
 */
const INJECTED_SOURCE_KINDS = new Set([
  // L03：本套件自己的自动注入（lib/inject.mjs 的 source.kind）。
  // 不加这一条，注入消息会落到 `unknown-author` 被拒 —— 结果同样是「不采集」，
  // 但理由记成「身份不明」，事后分不清是插件自己注入的还是来了未知来源。
  // 这条同时保证「上传的记忆注入不会被当成新记忆采回仓」这个自我强化闭环不成立。
  'laurel-memory',
  'time-context',
  'runtime-context',
  'skill-catalog',
  'model-selection',
  'user-approval',
  'agent-instructions',
  'tool-jobs',
])

function authorKindOf(type, message) {
  const sourceKind = asString(message?.source?.kind)
  if (sourceKind === 'model') return 'assistant'
  if (sourceKind === 'system-prompt') return 'system'
  // P2-10：子代理产出不是用户输入，也不能当 `tool`。
  // `agent-message`（子代理发来消息）与 `subagent-settled`（后台子代理收尾报告）
  // 的正文实测都是模型写的自然语言总结（「## 完成 … 改了哪些文件、测试结果」），
  // 不是机器可读的工具返回。归 `tool` 会让 evidence 落成 `tool-observed`——
  // 那是「被工具观测到的事实」，而这些句子是另一个模型的判断，属于
  // `assistant-summary`。所以归 `assistant` 更诚实。
  // 它们确实是真实工作痕迹（子代理跑了测试、改了文件），必须采，不能丢。
  if (sourceKind === 'agent-message' || sourceKind === 'subagent-settled') return 'assistant'
  if (INJECTED_SOURCE_KINDS.has(sourceKind)) return 'system'
  if (sourceKind) return sourceKind
  if (type === 'user/message') return 'user'
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  // P0-1：工具调用是工具侧的观察，author 归 tool，走既有 classifyAuthor 白名单，
  // 不新造角色。
  if (type === 'tool/call') return 'tool'
  if (type === 'developer/message' || type === 'system/message') return 'system'
  return null
}

// P0-1：`tool/call` 必须在内。此前只有 user/assistant/tool-result，
// 于是 635 次工具调用的**入参**一条都没落库：查得到「输出了什么」，
// 查不到「当初下的是什么命令」。
const CAPTURED_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'tool/call'])

/**
 * 把真实宿主事件压成适配层认得的扁平形状。
 *
 * 宿主事件是 `{ type, seq, time, data }`；适配层的 `shouldCapture` /
 * `identityFromEvent` 读的是 `{ source: {kind}, sessionId, turn, step,
 * toolCallId, reasoning }`。这一层转换就是此前缺的那块胶水 ——
 * 不转，`event.source` 永远是 undefined，一切都被判成 `unknown-author`。
 */
export function toAdapterEvent(session, hostEvent, hints = null) {
  const type = asString(hostEvent?.type) ?? asString(hostEvent?.name) ?? ''
  const data = hostEvent && typeof hostEvent.data === 'object' && hostEvent.data ? hostEvent.data : {}
  const message = data.message && typeof data.message === 'object'
    ? data.message
    : (typeof data.role === 'string' ? data : null)
  const content = message?.content ?? data.content
  const sourceKind = authorKindOf(type, message)
  const toolCalls = toolCallsOf(content)

  // P1-3：带工具调用的助手轮**不是**隐藏推理。`shouldCapture` 的第一道闸就是
  // `event.reasoning`，它在别的文件里（不许改），所以这个布尔必须在这里算准。
  // 实测一次会话 591 条 assistant/message 里 590 条带 tool-call（reasoning+tool-call 391 条），
  // 若把 reasoning 置 true 它们会被整类丢掉 —— 丢掉的正是「它决定做什么」。
  const hasToolCall = toolCalls.length > 0 || type === 'tool/call'
  const reasoning = !hasToolCall && (
    data.reasoning === true
    || reasoningOnly(content)
    || type === 'assistant/attempt'
  )

  return {
    type,
    seq: Number.isInteger(hostEvent?.seq) ? hostEvent.seq : null,
    time: Number.isFinite(hostEvent?.time) ? hostEvent.time : null,
    sessionId: sessionIdOf(session) ?? asString(hostEvent?.sessionId) ?? asString(data.sessionId),
    // P2-10：`user/message` 的 data 上**没有** turn/step（实测 39/39 都没有）。
    // 先认事件自带值，再退到调用方维护的「最近 turn/step 游标」，最后才是 null。
    // 取不到就显式 null，但绝不因为 null 而丢记录 —— turn 缺失是身份链的瑕疵，
    // 不是「这条不是记忆」的证据。
    turn: Number.isInteger(data.turn)
      ? data.turn
      : (Number.isInteger(hostEvent?.turn) ? hostEvent.turn : (Number.isInteger(hints?.turn) ? hints.turn : null)),
    step: Number.isInteger(data.step)
      ? data.step
      : (Number.isInteger(hostEvent?.step) ? hostEvent.step : (Number.isInteger(hints?.step) ? hints.step : null)),
    toolCallId: asString(data.callId)
      ?? asString(data.message?.toolCallId)
      ?? asString(hostEvent?.toolCallId)
      ?? asString(data.toolCallId),
    source: sourceKind ? { kind: sourceKind } : {},
    // P0-1：`tool/call` 的正文由 bodyOf 装配成「工具名 + 入参」。
    // 其它类型的正文仍是 textOfContent（`tool/result` 行为一个字节都没变）。
    text: CAPTURED_TYPES.has(type) ? bodyOf(type, { content, data, toolCalls }) : '',
    reasoning,
    toolCalls,
    // P2-11：失败事实在这里读出，交给采集层落进记录。
    isError: data.isError === true || data.message?.isError === true,
    // P0-1 配套：结构化工具名。`tool/call` 事件自带 `data.name`；
    // `tool/result` 没有工具名（只有 toolCallId），靠采集器里 callId→name 的表反查。
    toolName: asString(data.name) ?? asString(toolCalls[0]?.name),
    // P2-10：宿主消息 id。user/message 没有 turn/step，但有 id —— 保留它，
    // 至少能把记录对回原始消息。
    hostMessageId: asString(data.id) ?? asString(data.message?.id),
  }
}

/**
 * 幂等键：同一会话里 `seq` 是宿主的追加序号，重放同一条事件 seq 不变。
 * 没有 seq（合成事件/旧日志）时退到「类型 + 正文」的内容哈希 ——
 * 仍然确定性，同样不会在重试时多出一条。
 */
export function eventIdOf(identity, adapterEvent) {
  const key = Number.isInteger(adapterEvent?.seq)
    ? `seq:${adapterEvent.seq}`
    : `body:${contentHash({ type: adapterEvent?.type ?? null, text: adapterEvent?.text ?? '' })}`
  return 'e-' + contentHash({ source: identity?.source ?? 'dsh', sessionId: identity?.sessionId ?? null, key }).slice(0, 24)
}

/* ───────────────────────── 记录读写 ───────────────────────── */

/**
 * 读记录。坏行计数不隐藏，读失败直接抛（调用方决定怎么吞）。
 * 同一 id 有多版（纠正/撤销追加）只取 revision 最高的一条 —— 与 CLI 一致。
 */
export function loadRecords(vaultDir) {
  const file = join(vaultDir, RECORDS_FILE)
  if (!existsSync(file)) return { records: [], bad: 0, exists: false, file }
  const text = readFileSync(file, 'utf8')
  const byId = new Map()
  let bad = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { bad++; continue }
    const prev = byId.get(record.id)
    if (!prev || (record.revision ?? 1) >= (prev.revision ?? 1)) byId.set(record.id, record)
  }
  return { records: [...byId.values()], bad, exists: true, file }
}

/**
 * 追加一条记录到 `memory/records.jsonl`。
 *
 * P0-2：这里**必须能失败得响**。journal 是权威、records 是可重建的读侧视图，
 * 两者分叉在系统上"看起来正常"——查询照样能跑，只是少了那几条。
 * 所以写入用一个 fd 写完即 fsync，异常原样抛给调用方去计数/告警；
 * 吞在这里就等于把「journal 里有、records 里没有」变成静默常态。
 */
// MC13：管理面（admin-api.mjs）也必须走**同一条**读侧视图写入路径。
// 复制一份到 admin-api 会得到第二套 fsync 语义，两处漂移那天就是
// 「journal 有、records 没有」再次变成静默常态。所以把它导出，不抄。
export function appendRecord(vaultDir, record) {
  mkdirSync(join(vaultDir, 'memory'), { recursive: true })
  const file = join(vaultDir, RECORDS_FILE)
  const fd = openSync(file, 'a')
  try {
    writeSync(fd, JSON.stringify(record) + '\n')
    // 不 fsync 的话，断电后 records 可能比 journal 少尾巴 —— 正是 P0-2 那种分叉。
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * P0-2：从 journal 重建 records 里缺失的行。
 *
 * 为什么需要它：`handleSessionEvent` 是「先 `vault.commit`（写 blob + journal），
 * 再 `appendFileSync` 写 records」两步。journal 是权威，records 只是**可重建的
 * 读侧视图**；第二步失败时 journal 里已经有这条 `record.put`，records 里却没有 ——
 * 这个分叉不会报错，查询照样能跑，只是安静地少几条。审计里已实测出这个分叉
 * （appendRecord 必败时 `journalUnits=2` 而 `recordsFileExists=false`）。
 *
 * 修法不是「回滚 journal」（那会丢已提交的真相），而是提供**从权威重建视图**：
 * 扫 journal 的 `record.put`，用同一单元里的 `blob.put` 取回正文，
 * 只补 records 里没有的 id。重复调用安全：已存在的 id 一律跳过。
 *
 * 局限（如实写在这里，不假装完整）：journal 单元只记 id / meta / blob 引用，
 * 不含 kind、projectId 等字段；重建出来的记录用 `classifyRecordFields` 从正文
 * 重算 kind 与 title，projectId 取仓 manifest 的，并带 `reconciled: true` 标记，
 * 好让后续整理知道这条是重建的、不是原样。
 *
 * @returns {{ok:boolean, added:number, skipped:number, unrecoverable:number, journalUnits:number, bad:number, dryRun:boolean}}
 */
/**
 * 把一条记录压成「足够重建、但不含正文」的 journal op 载荷（S11-3）。
 *
 * 为什么不直接存整条：正文可能有几万字符，而它已经以内容寻址的方式躺在
 * `blob.put` 里（同单元去重、可校验 hash）。存第二份等于把仓体积翻倍换零收益。
 * 除正文外的字段（kind/title/projectId/coreId/author/evidence/source/status/
 * indexable…）加起来通常几百字节，而**恰恰是这些字段以前全丢了**，
 * 逼得重建只能猜 projectId、重跑分类。
 *
 * 保守起见只在值「非 undefined」时才带上，避免把一堆 null 写进每行 journal。
 */
// MC13：更正/撤销写 journal 时必须用**和采集完全一样**的 op-payload 形状，
// 否则同一条记录会有两种「可重建性」——采集写的能照原样还原，
// 管理面写的只能靠正文重跑分类。导出而非复制。
export function recordOpPayload(record) {
  const out = {}
  for (const [k, v] of Object.entries(record ?? {})) {
    if (k === 'body') continue            // 正文在 blob 里
    if (v === undefined) continue
    out[k] = v
  }
  return out
}

export function reconcileRecords({
  vault = null, vaultDir = null, projectId: projectIdHint = null, log = noopLog, dryRun = false, clock = Date.now,
} = {}) {
  // S11-3：`fromOpPayload` = 有几条是「照着 journal 里的记录版本原样还原」的
  // （`reconciledFrom:'op-payload'`），其余走 `body-classify`（老 journal，字段靠重算）。
  // 分开计数是为了让「重建出的 kind 和当初不一样」这件事可被观测而不是被平均掉。
  const out = { ok: false, added: 0, skipped: 0, unrecoverable: 0, journalUnits: 0, bad: 0, dryRun, fromOpPayload: 0 }
  if (!vaultDir) return { ...out, reason: 'no-vault-dir' }
  const journalFile = join(vaultDir, 'journal', 'journal.jsonl')
  // 没有 journal 就不是核心仓（或者仓还没建）：此时「回填成功、补了 0 条」是假话，
  // 会让调用方以为分叉已经处理完。如实说没得可对。
  if (!existsSync(journalFile)) return { ...out, reason: 'no-journal' }
  let journal
  try {
    journal = readJournal(journalFile)
  } catch (error) {
    return { ...out, reason: `journal-unreadable:${error?.message ?? error}` }
  }
  out.journalUnits = Array.isArray(journal.units) ? journal.units.length : 0
  out.bad = Array.isArray(journal.bad) ? journal.bad.length : (journal.bad ?? 0)
  // journal 中间损坏时**不要**动手：半坏链上重建出来的视图会缺一段，比不建更误导。
  if (journal.middle?.length) return { ...out, reason: 'journal-middle-corrupt' }

  let existing
  try {
    existing = loadRecords(vaultDir)
  } catch (error) {
    return { ...out, reason: `records-unreadable:${error?.message ?? error}` }
  }
  const have = new Set(existing.records.map((r) => r.id))
  const blobsRoot = join(vaultDir, 'blobs')
  // ── S11-3：projectId / coreId 不再「从第一条记录猜」─────────────────────
  //
  // 老写法是 `existing.records.find(r => r.projectId)?.projectId` —— 拿仓里**任意一条**
  // 已有记录的 projectId 当整仓的 projectId，这正是手册点名要拆掉的猜测。
  // 现在按「这条记录自己说了什么」优先：
  //   op.rec.projectId（S11-3 之后每条 record.put 都带）→ 显式参数 → manifest
  // 全都拿不到就写 `unknown` 并在记录上标 `fieldsUnknown`，**不借用别人的身份**。
  // `unknown` 是合法 id 形态（`ID_RE` 允许纯小写字母），且一眼能看出这是未知值。
  const UNKNOWN = 'unknown'
  const vaultProjectId = asString(projectIdHint) ?? asString(vault?.manifest?.projectId) ?? null
  const vaultCoreId = asString(vault?.manifest?.coreId) ?? null

  for (const unit of journal.units ?? []) {
    const ops = Array.isArray(unit.ops) ? unit.ops : []
    // 同一单元里 blob 引用先出现也没关系：整个单元先收齐再配对。
    const puts = ops.filter((o) => o?.op === 'record.put' && asString(o.id))
    if (!puts.length) continue
    const blobHashes = ops.filter((o) => o?.op === 'blob.put' && asString(o.hash)).map((o) => o.hash)
    for (const put of puts) {
      const id = put.id
      if (have.has(id)) { out.skipped++; continue }
      // journal 单元本身不记「这条 record.put 对应哪个 blob」，同单元只有一个 blob 时无歧义。
      if (blobHashes.length !== 1) { out.unrecoverable++; continue }
      const got = getBlob(blobsRoot, blobHashes[0])
      if (!got.ok || !got.data) { out.unrecoverable++; continue }
      const body = got.data.toString('utf8').trim()
      if (!body) { out.unrecoverable++; continue }

      // S11-3：op 里带了完整记录版本时，**照着它重建**，不再重跑分类。
      // 重跑分类会得到「与当初采集时不同的 kind」——同一个事件两条记录两种 kind，
      // 是比缺字段更坏的账。只有老 journal（没有 rec）才退回分类推断。
      const rec = put.rec && typeof put.rec === 'object' ? put.rec : null
      const author = asString(rec?.author) ?? asString(unit.meta?.author) ?? 'user'
      const evidence = asString(rec?.evidence)
        ?? (author === 'user' ? 'user-said' : author === 'tool' ? 'tool-observed' : 'assistant-summary')
      const cls = rec && asString(rec.kind)
        ? { kind: rec.kind, title: rec.title ?? null, indexable: rec.indexable !== false }
        : classifyRecordFields(body, { author, type: unit.meta?.type ?? null })
      const projectId = asString(rec?.projectId) ?? vaultProjectId ?? UNKNOWN
      const coreId = asString(rec?.coreId) ?? vaultCoreId ?? UNKNOWN
      const fieldsUnknown = []
      if (!asString(rec?.projectId) && !vaultProjectId) fieldsUnknown.push('projectId')
      if (!asString(rec?.coreId) && !vaultCoreId) fieldsUnknown.push('coreId')
      let record
      try {
        record = makeRecord({
          id,
          kind: cls.kind,
          body,
          title: cls.title,
          author,
          evidence,
          status: asString(rec?.status) ?? undefined,
          tags: Array.isArray(rec?.tags) ? rec.tags : ['capture', author, 'reconciled'],
          source: rec?.source ?? { source: 'dsh', eventId: unit.meta?.eventId ?? null, reconciledFromSeq: unit.seq },
          at: Number.isFinite(rec?.createdAt) ? rec.createdAt : (Number.isFinite(unit.at) ? unit.at : clock()),
        }, { coreId, projectId, environmentId: vault?.manifest?.environmentId ?? null })
      } catch (error) {
        log.warn?.(`重建记录 ${id} 失败：${error?.message ?? error}`)
        out.unrecoverable++
        continue
      }
      const row = {
        ...record,
        journalSeq: unit.seq,
        bodyHash: blobHashes[0],
        reconciled: true,
        // S11-3：重建来源如实记 —— 'op-payload' 表示照着 journal 里的记录版本还原，
        // 'body-classify' 表示老 journal，字段是从正文重算的（可能与当初不同）。
        reconciledFrom: rec ? 'op-payload' : 'body-classify',
        // 当初的 revision 要保留：用 1 覆盖会让「第 3 版」在下一次 loadRecords 去重时输给旧版。
        revision: Number.isFinite(rec?.revision) ? rec.revision : (record.revision ?? 1),
        // 重建时正文就是 blob 里的（脱敏后）全文；是否超上限只能按现有上限判断。
        truncated: false,
      }
      if (fieldsUnknown.length) row.fieldsUnknown = fieldsUnknown
      // L04：与实时采集同一条契约 —— `^调用 …` 日志落库但不进检索。
      if (!cls.indexable) row.indexable = false
      // S6：与实时采集同一条契约 —— 命中了自回显黑名单的那条，重建出来也必须不可检索。
      // 只在**从正文重算**时（!rec，老 journal）有 cls.selfEchoReason；
      // 照着 op-payload 还原时字段是当初写下的，不在这里重判（重判会让
      // 「同一条记录两个 indexable」再次出现，那是比缺字段更坏的账）。
      if (cls.selfEchoReason) row.selfEchoReason = cls.selfEchoReason
      if (rec) out.fromOpPayload++
      if (!dryRun) {
        try {
          appendRecord(vaultDir, row)
        } catch (error) {
          return { ...out, ok: false, reason: `records-write-failed:${error?.message ?? error}` }
        }
      }
      have.add(id)
      out.added++
    }
  }
  out.ok = true
  return out
}

/**
 * 在**不劈开代理对**的前提下取前 `n` 个 UTF-16 码元。
 *
 * ── 为什么必须有这一层（P5e）────────────────────────────────────────
 * JS 的 `slice` 按 UTF-16 码元切，emoji / 增补平面汉字这类**代理对**会被
 * 从中间劈开，留下一个孤立的高位代理（\uD800–\uDBFF）。孤立代理在字符串里
 * 看着"只是短了一个字符"，但**一旦按 UTF-8 编码落盘**（records.jsonl 就是这么
 * 写的），Node 的编码器会把它替换成 U+FFFD —— 于是磁盘上留下的是永久的
 * 替换符，原文那一个字再也回不来。实测复现（证据/P5-收尾-20261026/p5e-repro.cjs）：
 *   `'ab' + 😀 + 'cd'` 取 slice(0,3) → 末位 0xD83D（孤立高位代理）
 *   → `Buffer.from(x,'utf8').toString('utf8')` 含 U+FFFD，写盘再读回同样坏。
 * 检索引擎把 U+FFFD 当普通字符，于是"正文第一个字符就是替换符"的记录照样
 * 参与排序 —— 正是评审 §5.5 说的那种「坏头排到前排」。
 *
 * 只在**边界正好落在代理对中间**时退一个码元。退一个码元最多让正文短 1，
 * 而劈开代理对会让正文永久坏 1 个字符：代价完全不对称。
 */
function headSafe(text, n) {
  const cut = Math.max(0, Math.min(n, text.length))
  if (cut === 0 || cut >= text.length) return text.slice(0, cut)
  const last = text.charCodeAt(cut - 1)
  if (last >= 0xD800 && last <= 0xDBFF) {
    const nextCode = text.charCodeAt(cut)
    if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) return text.slice(0, cut - 1)
  }
  return text.slice(0, cut)
}

/** 取最后 `n` 个码元，同样不劈开代理对（起点落在代理对中间时前进一个）。 */
function tailSafe(text, n) {
  const cut = Math.max(0, Math.min(n, text.length))
  const start = text.length - cut
  if (start <= 0) return text.slice(start)
  const firstCode = text.charCodeAt(start)
  if (firstCode >= 0xDC00 && firstCode <= 0xDFFF) {
    const prevCode = text.charCodeAt(start - 1)
    if (prevCode >= 0xD800 && prevCode <= 0xDBFF) return text.slice(start + 1)
  }
  return text.slice(start)
}

function clipBody(text, maxChars) {
  const body = String(text ?? '').trim()
  if (body.length <= maxChars) return { text: body, truncated: false, originalChars: body.length }
  const marker = `\n…[已截断：原文 ${body.length} 字符，超出单条上限 ${maxChars}]`
  const room = Math.max(0, maxChars - marker.length)
  // P5e：用 headSafe 而不是 slice —— 见它的注释（劈开代理对会落盘成 U+FFFD）。
  return { text: headSafe(body, room) + marker, truncated: true, originalChars: body.length }
}

/* ──────────────── S6：write / edit / 大段 shell 输出的正文瘦身 ──────────────── */

/**
 * 会**整段搬运正文**的工具。它们的记录正文是这次调用的产物副本，不是结论。
 *
 * 真仓实测（2026-10-24，只读重放 55,129 条 / 正文 57.52 MB）：
 *   write 3,960 条 = 4.50 MB · edit 2,318 条 = 1.48 MB ·
 *   ops_bash 9,174 条 = 10.77 MB · pwsh 7,011 条 = 6.12 MB
 *   五类（含 bg_shell / batch_shell）合计 **23,955 条 = 27.39 MB = 正文 47.6%**。
 * 一条 write 的正文就是那篇源码本身（"调用 write {content:…, file_path:…}"），
 * 它 100% 已经在 blob 里存了一份（P1-4 之后存的是脱敏后**全文**），
 * records 再抄一遍等于拿一半的仓体积做同一件事。
 */
export const BULK_CONTENT_TOOLS = Object.freeze(['write', 'edit', 'str_replace_editor', 'apply_patch', 'multi_edit', 'ops_write'])

/** 会吐大段 stdout 的 shell 类工具。 */
export const BULK_SHELL_TOOLS = Object.freeze(['ops_bash', 'pwsh', 'bg_shell', 'bash', 'batch_bash', 'batch_shell', 'shell', 'exec'])

/**
 * 瘦身参数：正文超过阈值 → 存「头 HEAD + 尾 TAIL + 省略标记」。
 *
 * ── 为什么阈值按类分开 ─────────────────────────────────────────────
 * write/edit 的正文里**没有一个字的结论**，全是源码；shell 输出不一样 ——
 * 一条 800 字符的测试输出就可能是"哪几条断言红了"的全部证据。
 * 所以内容类阈值更狠（默认 2,000），shell 类更宽（默认 2,500）。
 *
 * ── 为什么保留尾巴 ────────────────────────────────────────────────
 * 只留开头会让「这次跑完是什么结果」永远读不到：`[exit code: 1]`、
 * `✔ 399 pass / ✖ 0 fail`、`[j-xxxx] done · exit=0` 全在末尾。
 * 头尾都留，中间那一段才是真正重复的部分（源码中段、日志刷屏）。
 *
 * ── 代价必须写出来 ───────────────────────────────────────────────
 * 瘦身是**有损的读侧操作**：record.body 变短了，检索只看得到头尾。
 * 这是刻意换的：中段的内容本来就没有检索价值（源码中段 / 刷屏日志），
 * 而原文一个字都没丢 —— blob 里仍是全文，按 id 分页照样读得到（见 bodyForVault）。
 * 所以记录上同时写瘦身量（slimmed / originalChars），让人事后能算出少了多少，
 * 而不是让 body 悄悄变短。
 */
export const SLIM_POLICY = Object.freeze({
  contentMaxChars: 2000,   // write / edit 类：源码整段搬运，阈值更狠
  shellMaxChars: 2500,     // shell 类：stdout 里可能夹着结论，放宽一点
  headChars: 800,          // 保留开头：工具名 + 参数键 + 源码头部（判断"改的是哪个文件"够用）
  tailChars: 400,          // 保留结尾：exit code / 测试汇总 / 尾部上下文
})

/** 这次采集该用哪个阈值；不参与瘦身的工具返回 null。 */
export function slimLimitFor(toolName, policy = SLIM_POLICY) {
  const name = String(toolName ?? '')
  if (!name) return null
  if (BULK_CONTENT_TOOLS.includes(name)) return policy.contentMaxChars
  if (BULK_SHELL_TOOLS.includes(name)) return policy.shellMaxChars
  return null
}

/** 瘦身标记。把省略的数字写出来 —— 读的人才知道自己没看到全文。 */
export function slimMarker(omitted, originalChars) {
  return '\n…[省略 ' + omitted + ' 字符 · 原文 ' + originalChars + ' 字符在 blob，按 id 分页可读全文]\n'
}

/**
 * 按 SLIM_POLICY 瘦身一条正文。不瘦身时原样返回（**同一个字符串**，
 * 调用方比 toolName 与长度就能判断有没有动过，不必再比一遍内容）。
 *
 * @returns {{text:string, slimmed:boolean, omitted:number, originalChars:number}}
 */
export function slimBody(body, { toolName, policy = SLIM_POLICY } = {}) {
  const text = String(body ?? '')
  const limit = slimLimitFor(toolName, policy)
  const originalChars = text.length
  if (limit === null || text.length <= limit) {
    return { text, slimmed: false, omitted: 0, originalChars }
  }
  // 头尾相加还不到阈值时不动手：那会把一条 2,100 字符的正文切成 1,200 + 标记
  // （省 0 字节，却丢掉中段）—— 瘦身只有在真能省下东西时才有意义。
  const keep = policy.headChars + policy.tailChars
  if (originalChars <= keep + 64) return { text, slimmed: false, omitted: 0, originalChars }
  const omitted = originalChars - keep
  // P5e：头尾都必须按**码点安全**切 —— 与 clipBody 同一个理由。
  // 实测（p5e-repro.cjs 第 3 段）：799 个 ASCII 后接一个 emoji 的正文，
  // slice(0, 800) 的末位正好是 0xD83D，写盘即 U+FFFD。
  const out = headSafe(text, policy.headChars) + slimMarker(omitted, originalChars) + tailSafe(text, policy.tailChars)
  return { text: out, slimmed: true, omitted, originalChars }
}

/* ───────────────────────── 采集 ───────────────────────── */

/**
 * 造一个采集器。不持有宿主对象，只持有仓句柄与日志。
 *
 * `commitFn` 可注入（默认就是 `vault.commit`），这样「commit 抛异常时
 * handler 不抛」可以被真测，而不是靠读代码相信。
 */
export function createCapture({
  vault = null,
  vaultDir = null,
  tier = 'zero',
  log = noopLog,
  clock = Date.now,
  maxBodyChars = DEFAULT_MAX_BODY_CHARS,
  commitFn = commitUnit,
  // 默认脱敏。设 false 只用于「证明脱敏确实在起作用」的对照实验与回归测试；
  // 生产路径不该关它 —— 关掉意味着密钥明文落盘，而核心仓是普通文件。
  redact = true,
  // 只为一件事存在：让「records 到底被整文件读了几次」可以被**行为**断言，
  // 而不是靠读代码相信。默认就是本文件的 loadRecords，生产路径不需要传。
  recordsReader = loadRecords,
  /**
   * MC11：采集成功后的旁路观察者 `(adapterEvent, captured, ctx) => void`，
   * `ctx = { session, hostType }`。session 与宿主事件类型都只有这一层手里有 ——
   * 让外部自己去找等于把「这条属于哪个会话」重新猜一遍。
   *
   * 经验学习面需要「这一条是什么作者、有没有报错、是哪个工具」，而这三样
   * 只有归一化后的 `adapterEvent` 上有（原始宿主事件里没有）。所以由采集这边
   * 交出去，而不是让外部再解析一遍宿主事件 —— 那等于绕过脱敏与身份判定。
   *
   * 调用点在写盘成功之后、`return` 之前，且**包在 try/catch 里**：
   * 观察者抛错不能把一条已经提交的记录报成 failed。
   */
  observed = null,
} = {}) {
  const stats = {
    seen: 0, stored: 0, duplicates: 0, skipped: 0, failed: 0, lastReason: null,
    redacted: 0, redactionHits: {},
    // P0-2：journal 已提交但 records 视图没写成功的条数。>0 就说明两者分叉了，
    // 调用方应当跑 reconcileRecords 把读侧补齐。
    recordsWriteFailed: 0,
    lastSuccessAt: null, lastFailureAt: null, lastError: null, consecutiveFailures: 0,
  }
  const markFailure = (reason) => {
    stats.lastFailureAt = clock()
    stats.lastError = reason
    stats.consecutiveFailures++
  }
  const markSuccess = () => {
    stats.lastSuccessAt = clock()
    stats.lastError = null
    stats.consecutiveFailures = 0
  }
  const known = new Set()
  // P0-1 配套：toolCallId → 工具名。tool/result 事件里没有工具名，
  // 只能靠先到的 tool/call 事件登记。只存字符串对，开销可忽略。
  const toolCallNames = new Map()
  // P2-10：turn/step 游标。宿主的 user/message 不自带 turn/step，只能由
  // turn/start、step/start 推进；进程重启后从头开始，历史记录不回填（本来也已经写下了）。
  const cursors = { turn: null, step: null }

  const note = (reason) => {
    stats.skipped++
    stats.lastReason = reason
    return { ok: false, reason }
  }

  // P1-6：`known` 只在**进程内第一次**判重时全量读一次 records，
  // 之后纯内存判断 + 每次成功采集增量补进去。此前的写法是"只要没命中就
  // 再全量读一遍整个 records.jsonl"——记录越多每次采集越慢（审计实测 534 条时
  // 单次读中位 5.6ms，随仓线性增长）。代价是进程生命周期内多留一个 id 集合，
  // 换来判重 O(1)；进程重启后第一次仍会全量读一次，这是刻意保留的
  // —— 否则跨进程/跨会话历史重复会重新写一遍。
  let knownLoaded = false
  /**
   * L05 副作用：记录 id 的键是 `hash(eventId, kind)`，而 kind 由正文决定。
   * 同一个宿主事件在规则升级前后可能被归成两个 kind → **两个 id** →
   * 重放（backfill / 跨进程补采）会把它当成新事件再写一条。
   * 所以判重不能只看 id，还要按 `source.eventId`（真正的事件身份，不含 kind）再看一眼。
   * 这不是额外成本：loadKnownOnce 已经把全量 records 读进内存了。
   */
  const knownEventIds = new Set()
  /**
   * 只抽 id 与 eventId，不解析整条记录。
   *
   * ── 为什么不是 loadRecords（2026-10-23 性能）──────────────────────────
   * 判重只需要两个字符串集合，而 `loadRecords` 会把 5.4 万条 / 112MB 全部
   * `JSON.parse` 成对象（实测 700–750ms），进程启动后的**第一场会话**为此多等
   * 近一秒。这里对原文做两次 `indexOf` 扫描（实测 108ms + 77ms），
   * 只取 `"id":"r-…"` 与 `"eventId":"e-…"` 两种**形态固定**的值。
   *
   * 安全性：这两个键的取值由本仓自己生成（`contentHash` 前缀），不含转义字符，
   * 所以按引号截断是精确的。万一格式漂了（值里出现引号），最坏结果是多取一个
   * 脏 id 进集合 —— 判重只会**多判**「已存在」，不会把已存在的判成新的。
   * 真正需要完整记录的地方（面板、导出、reconcile）仍走 loadRecords，不变。
   */
  function loadKnownIdsOnly() {
    const file = join(vaultDir, RECORDS_FILE)
    let text
    try { text = readFileSync(file, 'utf8') } catch { return }
    const scan = (prefix, want, into) => {
      let i = 0
      while ((i = text.indexOf(prefix, i)) !== -1) {
        const start = i + prefix.length
        const end = text.indexOf('"', start)
        if (end < 0) break
        const value = text.slice(start, end)
        if (value.length > 2 && value[0] === want && value[1] === '-') into.add(value)
        i = end
      }
    }
    scan('"id":"', 'r', known)
    scan('"eventId":"', 'e', knownEventIds)
  }
  function loadKnownOnce() {
    if (knownLoaded) return
    knownLoaded = true
    try {
      // 传了自定义 recordsReader（测试用）就照旧走它 —— 那条路径要断言「读了几次」。
      if (recordsReader !== loadRecords) {
        for (const record of recordsReader(vaultDir).records) {
          known.add(record.id)
          const eid = record?.source?.eventId
          if (typeof eid === 'string' && eid) knownEventIds.add(eid)
        }
        return
      }
      loadKnownIdsOnly()
    } catch { /* 读失败不阻断本次采集；journal 兜底还会再试一次 */ }
  }

  /**
   * P0-2：journal 兜底索引。
   *
   * records 是读侧视图，可能因为写失败/断电比 journal 少尾巴。判重只看 records 时，
   * 那些「journal 里有、records 里没有」的 id 会被当成没存过 → 重放又 commit 一次
   * 同 id 的 record.put，审计里实测到 `duplicateRecordPutIds=1`。
   *
   * 代价与取舍：journal 全量扫一次只为拿 id 集合（不读 blob、不校验正文），
   * 之后整个进程复用，不做二次扫描 —— 拒绝把 P1-6 的性能问题从 records 搬到 journal。
   * 惰性建立：只有 records 判重没命中时才去扫，正常路径（无分叉）不会付这份成本。
   *
   * ── 2026-10-23：这里不再走 readJournal() ──────────────────────────────
   * `readJournal()` 会对整条链做 JSON.parse + sha256 逐条校验（真仓 46MB / 5.9 万单元
   * 实测 1.1 秒），而本函数只需要 `record.put` 的 id 字符串。链完整性是 openVault
   * 的职责（启动时校验一次），不是「判重兜底」的职责。改成按行做文本匹配：
   * 命中 `"op":"record.put"` 的行再取 `"id"` 字段。坏行、半行一律跳过 ——
   * 这条路径本来就是「宁可多写一条，也不能阻断采集」。
   */
  let journalIds = null
  function loadJournalIdsOnce() {
    if (journalIds) return journalIds
    journalIds = new Set()
    const file = join(vaultDir, 'journal', 'journal.jsonl')
    let text
    try { text = readFileSync(file, 'utf8') } catch { return journalIds }
    let lineStart = 0
    while (lineStart < text.length) {
      let lineEnd = text.indexOf('\n', lineStart)
      if (lineEnd < 0) lineEnd = text.length
      const line = text.slice(lineStart, lineEnd)
      lineStart = lineEnd + 1
      // 先做一次便宜的包含判断：绝大多数行没有 record.put，不必再找 id。
      if (!line.includes('"record.put"')) continue
      const at = line.indexOf('"id":"')
      if (at < 0) continue
      const start = at + '"id":"'.length
      const end = line.indexOf('"', start)
      if (end < 0) continue
      const id = line.slice(start, end)
      if (id.length > 2 && id[0] === 'r' && id[1] === '-') journalIds.add(id)
    }
    return journalIds
  }

  function alreadyStored(id) {
    if (known.has(id)) return true
    loadKnownOnce()
    if (known.has(id)) return true
    if (loadJournalIdsOnce().has(id)) {
      known.add(id)
      return true
    }
    return false
  }

  /** 同一事件是否已经有记录（跨 kind 变更），见 knownEventIds 的注释。 */
  function eventAlreadyStored(eventId) {
    if (!eventId) return false
    loadKnownOnce()
    return knownEventIds.has(eventId)
  }

  /**
   * 宿主 `session/event` 的处理器。
   * **不抛**：采集失败绝不影响宿主里正在进行的对话（本文件既有纪律）。
   * `state.error` 也不许被污染成采集错误 —— 那只表示「核心仓本身坏了」。
   */
  function handleSessionEvent(session, hostEvent) {
    stats.seen++
    try {
      if (!vault || !vaultDir) return note('no-vault')

      // P2-10：`user/message` 的 data 上**没有** turn/step（实测 39/39 都没有），
      // 它们只在 `turn/start` / `step/start` 事件里出现。所以这里维护一份游标：
      // 见过哪个 turn/step 就记住，后续没自带 turn/step 的事件（user/message）用
      // 「最近一次进入的 turn/step」。取不到仍是 null —— 但**不因 null 丢记录**：
      // turn 缺失是身份链的瑕疵，不是「这条不是记忆」的证据。
      // 游标在 try 内更新，但它本身是纯内存赋值，不会抛。
      const hostType = asString(hostEvent?.type) ?? ''
      if (hostType === 'turn/start' || hostType === 'turn/end') {
        const t = hostEvent?.data?.turn
        if (Number.isInteger(t)) cursors.turn = t
      }
      if (hostType === 'step/start' || hostType === 'step/end') {
        const s = hostEvent?.data?.step
        const t = hostEvent?.data?.turn
        if (Number.isInteger(t)) cursors.turn = t
        if (Number.isInteger(s)) cursors.step = s
      }

      const event = toAdapterEvent(session, hostEvent, cursors)
      // A lifecycle signal has no body/author to capture, but must still close the
      // experience window. Do not fabricate a memory record for turn/end.
      if (hostType === 'turn/end') {
        try { observed?.(event, { ok: false, reason: 'signal-only' }, { session, hostType }) } catch {}
        return note('signal-only')
      }
      // L04 的前置条件：`shouldCapture` 要能认出「这是记忆套件自己的工具」，
      // 但 `tool/result` 事件里**没有工具名**（只有 toolCallId），
      // 所以先把 callId→name 反查的结果回填到 `event.toolName`，再交给适配层判定。
      // 回填而不是另开一条判定分支：排除策略只允许有一个落点，
      // 两个地方各写一份「是不是自工具」早晚会分叉。
      if (!event.toolName) event.toolName = toolNameOf(event, event.type, toolCallNames)
      const verdict = shouldCapture(event)
      if (!verdict.capture) return note(`capture-denied:${verdict.reason}`)
      if (!event.text) return note('empty-body')

      const identified = identityFromEvent(event)
      if (!identified.ok) return note(`identity:${identified.reason}`)
      const identity = identified.identity

      // cwd 缺失就不采集：projectId 只能从 cwd 派生，编不出来。
      const project = projectIdentityOf({ cwd: cwdOf(session) })
      if (!project.ok) return note(`project:${project.reason}`)

      // P0-1 配套：结构化工具名，让查询能按工具过滤，不必从正文里正则抠。
      // tool/call 自带 name；tool/result 没有，靠 tool/call 时登记的 callId→name 反查，
      // 查不到就留 null（旧日志/跨进程重放时确实可能没有，编一个名字是撒谎）。
      // 提到 id/kind 之前：L05 的分类要看 author 与 toolName，而 kind 参与 id 计算，
      // 所以必须在算 id 前定下来，且必须**确定性**（同事件重放 → 同 id）。
      const toolName = toolNameOf(event, event.type, toolCallNames)
      const author = verdict.author === 'assistant' ? 'assistant' : verdict.author === 'tool' ? 'tool' : 'user'
      const evidence = author === 'user' ? 'user-said' : author === 'tool' ? 'tool-observed' : 'assistant-summary'
      const isError = event.isError === true

      // L05：kind 不再硬写 'log'。规则表在 adapter-dsh.mjs（与迁移脚本共用同一份），
      // 纯关键词 + 事件形态，确定性、不调模型。分类用**脱敏前**的 event.text：
      // 脱敏只打码密钥、不改语义，而 event.text 在重放时逐字节一致 ——
      // 这样才能保证「同事件 → 同 kind → 同 id」。
      const classifySource = isError ? `[工具失败] ${event.text}` : event.text
      const cls = classifyRecordFields(classifySource, { author, type: event.type, toolName })

      const eventId = eventIdOf(identity, event)
      const kind = cls.kind
      // id 只由「事件 + kind」决定：重放同一条事件必然得到同一个 id。
      // 注意：加 `tool/call` 进 CAPTURED_TYPES **没有**动这个键 —— `eventIdOf` 只看
      // seq（没有 seq 时才退到 type+text 哈希），所以幂等性不受采集范围变化影响。
      const id = 'r-' + contentHash({ eventId, kind }).slice(0, 24)
      if (alreadyStored(id)) {
        stats.duplicates++
        stats.lastReason = 'duplicate'
        return { ok: true, duplicate: true, id }
      }
      if (eventAlreadyStored(eventId)) {
        // 同一宿主事件已经有记录（可能是旧规则写下的、kind 不同的 id）。
        // 不重写：重复采集比 kind 不准更糟 —— 它会造出两条同源记录。
        stats.duplicates++
        stats.lastReason = 'duplicate-event'
        return { ok: true, duplicate: true, id, reason: 'duplicate-event' }
      }

      // 脱敏必须在截断**之前**做：先截断会把长密钥切成半截，
      // 半截既不像密钥（匹配不到）又已经漏了一半 —— 这是最容易漏的顺序错误。
      const mask = redact === false
        ? { text: event.text, hits: [], counts: {} }
        : redactText(event.text, { enabled: true })
      if (mask.hits.length) {
        stats.redacted++
        for (const h of mask.hits) stats.redactionHits[h.category] = (stats.redactionHits[h.category] ?? 0) + 1
      }
      const content = clipBody(mask.text, maxBodyChars)

      // S6：write / edit / 大段 shell 输出的**读侧正文**瘦身。
      // 顺序必须是「脱敏 → 裁到单条上限 → 瘦身」：
      //   · 脱敏在前（既有纪律，见上一条注释）；
      //   · clipBody 在前，因为它按"超出单条上限"标注，是**数据完整性**的标记；
      //   · 瘦身在后，它按工具类型再压一次，是**读侧体积**的取舍。
      // 反过来（先瘦身再裁）会让 8,000 字符上限的标记消失，读的人分不清
      // "正文本来就短"和"原文更长但被裁过"。
      // 瘦身只动 record.body；blob 里仍是 mask.text 全文（下面 commitFn 传的就是它），
      // 所以「按 id 读全文」这条路一个字节都没受影响。
      // 工具失败的前缀也算进正文（与下面 makeRecord 的 body 装配保持同一个串），
      // 否则瘦身后再拼前缀会把尾巴挤掉，前后两次长度就对不上。
      const fullBody = isError ? '[工具失败] ' + content.text : content.text
      const trimmed = slimBody(fullBody, { toolName })

      // P2-11：工具失败的事实必须落库，否则失败调用与成功调用在记录里一模一样
      // （审计实测 634 条 tool/result 里 3 条 isError，字段全同）。
      // 为什么不用 `evidence: 'tool-failed'`：EVIDENCE_LEVEL 是 laurel-core/format.mjs
      // 里的闭合白名单（user-said / tool-observed / assistant-summary / model-inferred /
      // unverified），写一个不在枚举里的值会被 makeRecord 静默降级成 'unverified' ——
      // 那比不记更糟，因为看起来像"记了"。所以 evidence 保持 tool-observed（它确实是被
      // 工具观测到的），失败用 tags + 显式字段 + 正文前缀三重表达。
      // P2-9：makeRecord 把 at 拆进 createdAt/updatedAt，`at` 这个键最终不存在。
      // 外部脚本按 record.at 读会拿到 undefined；这里把同一个值显式留在记录上。
      const at = event.time ?? clock()

      const record = makeRecord({
        id,
        kind,
        body: trimmed.text,
        // L05：fact/requirement/preference 必须有 title（此前 29,819 条里 0 条有）。
        // 其它 kind 也带上同样的确定性摘要 —— 空 title 对面板与检索都没好处，
        // 而这条摘要是纯截取、不是编造。
        title: cls.title,
        author,
        evidence,
        tags: isError ? ['capture', author, 'tool-failed'] : ['capture', author],
        // P2-10：把宿主消息 id 一并留在 source 上 —— user/message 没有 turn/step，
        // 它是唯一能把记录对回原始消息的线索，丢了就再也回不去。
        source: {
          ...identity,
          eventId,
          ...(toolName ? { toolName } : {}),
          ...(event.hostMessageId ? { hostMessageId: event.hostMessageId } : {}),
        },
        at,
      }, {
        coreId: vault.manifest?.coreId,
        projectId: project.projectId,
        environmentId: project.environmentId ?? null,
      })
      // makeRecord 是白名单构包，未知输入键会被丢掉 —— 所以额外字段只能在它**之后**挂。
      // 三条都只在有值时才出现（和 redactVersion 一样的写法），不给正常记录添噪声。
      record.at = at
      if (isError) record.isError = true
      if (toolName) record.toolName = toolName
      // L04：`^调用 <工具名> ` 形态的工具调用日志只作审计，不进检索索引。
      // 显式写 `indexable:false`（而不是靠检索侧每次重算正则）——
      // 索引在别的包里，字段是唯一跨包、可被存量迁移复用、且能让人一眼看懂的契约。
      // 降级 ≠ 不采集：记录照落，按 id 仍可读回原文。
      if (!cls.indexable) record.indexable = false
      // S6：**拦了哪一条**黑名单，如实记在记录上。
      // 只写规则 id（不写正文）：事后要能回答"这条为什么不可检索"，
      // 而又不必再拿正则把整仓重跑一遍去猜；body 里可能含密钥，日志里不该出现。
      if (cls.selfEchoReason) record.selfEchoReason = cls.selfEchoReason
      // S6：瘦身量。瘦身是有损的读侧操作（见 slimBody 的注释），所以它必须可观测：
      //   slimmed        这次有没有动过正文
      //   originalChars  瘦身前（= clipBody 之后）的字符数
      //   recordChars    瘦身后真正落进 records 的字符数
      // 三个数一起看就知道少了多少、原文在 blob 里多长 —— 而不是让 body 悄悄变短。
      // 不动原文长度的承诺由 bodyHash 那条链路兑现（commitFn 收的是 mask.text 全文）。
      if (trimmed.slimmed) {
        record.slimmed = true
        record.slimmedFromChars = trimmed.originalChars
        record.slimmedOmitted = trimmed.omitted
      }

      const written = commitFn(vault, {
        // S11-3：`record.put` 必须**带得动重建**。
        //
        // 原来只写 `{op,id}`，正文从同单元的 `blob.put` 取，kind/projectId/title
        // 全丢 —— 于是 `reconcileRecords` 只能拿正文重跑分类（kind 可能变），
        // projectId 更只能去**仓里第一条记录**上借，那是在猜。
        // 现在把「除正文外的整条记录」原样塞进 op（`rec`）。正文仍只在 blob 里存一份
        // （内容寻址，去重），journal 行只多 ~300 字节，换来的是「照着重建 = 原样」。
        ops: [{ op: 'record.put', id: record.id, rev: record.revision ?? 1, rec: recordOpPayload(record) }],
        // P1-4：blob 存**脱敏后的全文**，不截断；`record.body` 才是裁剪后的摘要。
        // 此前这里传的是 `record.body`（已截断），于是超过 8000 字符的原文永久丢失
        // （审计实测 14 条命中，原文 242385 字符里丢了 130385，占 53.8%，最差一条
        // 49932 → 8000）。blob 是内容寻址的原文存储，它才是「原文还在」的地方；
        // records 只是读侧索引，可以短。脱敏已经在上面做完，所以全文进 blob 时
        // 密钥同样不会落盘（`mask.text` 就是脱敏结果）。
        body: mask.text,
        meta: {
          kind: 'capture',
          eventId,
          author,
          // 语义收紧：`truncated` 只表示 **record.body 被裁过**，不再暗示原文丢了。
          // 原文完整躺在 bodyHash 指向的 blob 里，`originalChars` 给出它的真实长度，
          // 面板/日志据此就能说"索引里有 8000 字符，原文 49932 字符在 blob"。
          truncated: content.truncated,
          originalChars: content.originalChars,
          // recordChars 必须是**真正落进 records 的那个长度**。S6 之后 body 还可能
          // 被 slimBody 再压一次，写 content.text.length 就会比 body 长 —— 那种
          // "元数据比正文长"的自相矛盾，正是这一类字段最容易漂的地方。
          recordChars: trimmed.text.length,
          // 只在真的打了码时才记，避免每条记录都带一个无信息量的字段。
          ...(mask.hits.length ? { redactVersion: REDACT_VERSION, redacted: mask.hits.length } : {}),
        },
      })
      if (!written || written.ok !== true) {
        stats.failed++
        stats.lastReason = `commit:${written?.reason ?? 'unknown'}`
        markFailure(stats.lastReason)
        log.warn(`采集未写入（锁/仓不可写，不影响宿主）：${stats.lastReason}`)
        return { ok: false, reason: 'commit-failed' }
      }

      // P0-2：journal 已提交成功 —— 从这一刻起这条记录**存在**，不因下面的
      // records 写失败而"没存"过。所以先登记 id（判重），再写读侧视图。
      // P0-1 配套：登记 callId → 工具名，供随后同 callId 的 tool/result 反查。
      // 放在写 records 之前：登记是内存操作，不该因为读侧写失败而失效。
      if (event.toolCallId && event.toolName) toolCallNames.set(event.toolCallId, event.toolName)
      known.add(id)
      knownEventIds.add(eventId)
      const journalSeq = written.seq
      const bodyHash = written.body?.hash ?? null
      try {
        appendRecord(vaultDir, {
          ...record,
          journalSeq,
          bodyHash,
          // P1-4：让读侧也知道原文在哪、被裁了多少，不必再回 journal 查。
          originalChars: content.originalChars,
          truncated: content.truncated,
        })
      } catch (error) {
        // 不回滚 journal（那是权威），但要**响**：计数 + 告警，告诉调用方跑
        // reconcileRecords 补读侧。此前这里异常会一路冒到最外层 catch，
        // 变成失败的采集 —— 记录明明已经提交，报 failed 是撒谎。
        stats.recordsWriteFailed++
        stats.lastReason = `records-write:${error?.message ?? error}`
        markFailure(stats.lastReason)
        log.warn(`记录已提交但读侧视图写入失败（journalSeq=${journalSeq}），可用 reconcileRecords 补齐：${error?.message ?? error}`)
        // 读侧写失败但 journal 已提交 —— 记录**存在**，经验同样应当看到它。
        if (typeof observed === 'function') {
          try { observed(event, { ok: true, id, seq: journalSeq }, { session, hostType }) } catch { /* ignore */ }
        }
        return { ok: true, id, seq: journalSeq, truncated: content.truncated, recordsWritten: false }
      }
      stats.stored++
      markSuccess()
      // MC11：把归一化事件交给旁路观察者。位置在 `stats.stored++` 之后 ——
      // 观察者看到的必须是"已经算成功"的那条，否则它会把失败当经验依据。
      if (typeof observed === 'function') {
        try { observed(event, { ok: true, id, seq: journalSeq }, { session, hostType }) } catch { /* 观察者自己的问题，不影响采集 */ }
      }
      return { ok: true, id, seq: journalSeq, truncated: content.truncated, recordsWritten: true }
    } catch (error) {
      // 关键：这里绝不 rethrow。宿主只打日志、不把异常传回对话。
      stats.failed++
      stats.lastReason = `error:${error?.message ?? error}`
      markFailure(stats.lastReason)
      log.warn(`采集失败（不影响宿主对话）：${error?.message ?? error}`)
      return { ok: false, reason: 'error' }
    }
  }

  return {
    handleSessionEvent,
    stats: () => ({ ...stats }),
    knownIds: () => [...known],
  }
}

/* ───────────────────────── 工具执行 ───────────────────────── */

/**
 * 结果裁剪：超过当前档位 `maxChars` 就**截断并标注**，不静默丢。
 * 返回值长度保证 `<= maxChars`。
 *
 * 省略 `maxChars` 时按**零档预算**收口（L06 契约变更：原来写死 300）。
 * 这个默认值此前与 `INJECT_BUDGET.zero.maxChars` 是同一个数字，但各写一份 ——
 * 两边一起漂移没人看得见。现在直接读预算表，改档位就同步，不会再分叉。
 */
export function clipResult(text, maxChars) {
  const value = String(text ?? '')
  const fallback = budgetFor('zero').maxChars
  const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : fallback
  if (value.length <= max) return value
  const marker = `…[已截断：原文 ${value.length} 字符，超出本档预算 ${max}]`
  if (marker.length >= max) return marker.slice(0, max)
  return value.slice(0, max - marker.length) + marker
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 取一条记录的**原文**：优先 blob（内容寻址的完整脱敏全文），退回 `record.body`。
 *
 * 为什么必须先试 blob：`record.body` 是读侧索引，采集时按 8,000 字符裁过
 * （`clipBody`），P1-4 之后原文只完整存在 blob 里。分页如果只读 `record.body`，
 * 一条 49,932 字符的记录就只有前 8,000 字符可分页，而 `total` 会报一个
 * **错的**小数字 —— 用户看到「共 120 行」其实是「共 8000 字符折算的 120 行」，
 * 后面 4 万多字符凭空消失。这不是显示问题，是数据完整性问题。
 *
 * blob 缺失/损坏不致命：退回截断版并在头里如实标注 `bodySource`，
 * 让调用方知道"读到的是索引副本，不是原文"。
 */
function bodyForVault(vaultDir, record) {
  const fallback = { text: String(record?.body ?? ''), source: 'record' }
  const hash = asString(record?.bodyHash)
  if (!vaultDir || !hash) return fallback
  try {
    const got = readBodyUnit({ paths: { blobs: join(vaultDir, 'blobs') } }, hash)
    if (got?.ok && got.data) return { text: got.data.toString('utf8'), source: 'blob' }
    return { ...fallback, source: 'record', bodyReason: got?.reason ?? 'unknown' }
  } catch {
    return { ...fallback, source: 'record', bodyReason: 'read-error' }
  }
}

/** 命中摘要：**只给 id + 首行 + 总行数**。正文一律走 `{id, offset, lines}` 分页取。 */
const HIT_FIRST_LINE_MAX = 80

function pageText(vaultDir, records, id, args, episodes = []) {
  const offset = Number.isFinite(args.offset) ? Math.max(0, Math.trunc(args.offset)) : 0
  const lines = Number.isFinite(args.lines)
    ? Math.min(MAX_PAGE_LINES, Math.max(1, Math.trunc(args.lines)))
    : DEFAULT_PAGE_LINES
  const rec = records.find((x) => x?.id === id)
  if (!rec) {
    // MC10：`x-…` 经验 id 与 `r-…` 记录 id 在同一个 id 空间里对用户可见，
    // 直读时必须能找到 —— 否则检索命中一条经验、按 id 却读不回来。
    const ep = episodes.find((x) => x?.id === id)
    if (ep) return describeEpisode(ep)
    return `未找到记录 ${id}（仓里共 ${records.length} 条记录、${episodes.length} 条经验）。可先用 query 检索。`
  }
  const body = bodyForVault(vaultDir, rec)
  const all = body.text.split('\n')
  const slice = all.slice(offset, offset + lines)
  const hasMore = offset + lines < all.length
  const head = `记录 ${id}：第 ${offset + 1}-${offset + slice.length}/${all.length} 行`
    + (hasMore ? '（还有后续，用 offset 继续）' : '')
    // 读到的是索引副本时必须说出来，否则用户以为这就是全文。
    + (body.source === 'blob' ? '' : `（⚠ 原文 blob 不可读${body.bodyReason ? `：${body.bodyReason}` : ''}，以下是读侧索引里的截断副本）`)
  return `${head}\n---\n${slice.join('\n')}`
}

/**
 * 经验检索的状态口径（MC10，2026-10-24 S4 改）。
 *
 * **默认只列已验证过的状态**：`candidate` / `trial` / `adopted`。
 * `raw-episode` 不进默认池，要查必须显式传 `states:['raw-episode']`。
 *
 * 为什么（两次真仓实测，两次都是极端）：
 *
 * 1. 2026-10-22：`episodeSearchable()` 默认只让 `adopted` 出现，而真仓 110 条
 *    经验**全部**停在 `raw-episode`（`acceptCandidate` 因 `verification.result
 *    :'unknown'` 拒升 —— 那道门是对的：没验证过的做法不能当推荐结论）。
 *    结果是工具永远报「可检索 0 条经验」，那些经验等于不存在。
 *    当时的修法改成「除了 revoked/retired 之外都列」。
 * 2. 2026-10-24：那条修法把 2,680 条 raw-episode 灌进了模型主动检索 ——
 *    10 组 query 的 top-10 里经验占 **23/99**（「用户纠正」一组 9/10）。
 *    于是"查记忆"变成了"读自己的调试回声"。
 *
 * 两个极端都错：全不列 = 假装没有；全列 = 被噪声淹没。所以口径定为
 * 「默认只列已验证过的状态」——未验证的仍留在文件里、可按 id 直读、
 * 可显式查询（可审计性不丢），只是不占默认答案。每条命中**仍然带状态**，
 * 让调用方看见可信度差异；要只看最硬的结论传 `states:['adopted']`。
 */

/** 显式查询允许的状态白名单（与 `laurel_memory` 的 states enum 一致）。 */
const EPISODE_QUERY_STATES = Object.freeze(['raw-episode', 'candidate', 'trial', 'adopted'])

/** 不传 `states` 时的默认状态集：**不含 `raw-episode`**。 */
const EPISODE_DEFAULT_STATES = Object.freeze(['candidate', 'trial', 'adopted'])

function episodeStatesArg(args) {
  // 显式 states 优先（并做白名单校验：未知状态不静默当成"全都要"，
  // 否则一个拼错的状态名会把「只看 adopted」悄悄变成「什么都看」）。
  // 白名单是 `EPISODE_QUERY_STATES` 而**不是**默认集：`raw-episode` 虽不在
  // 默认池里，显式要它时必须真给 —— 否则"显式查原始线索"会静默变成"查已验证
  // 的"，查询者以为看见了全部，那是最坏的一种失败。
  const raw = Array.isArray(args?.states)
    ? args.states
    : (typeof args?.states === 'string' ? [args.states] : null)
  if (raw && raw.length) {
    const wanted = raw.map((s) => String(s))
    const known = wanted.filter((s) => EPISODE_QUERY_STATES.includes(s))
    const unknown = wanted.filter((s) => !EPISODE_QUERY_STATES.includes(s))
    // 有认得的部分就按认得的查；**一个都不认得**时状态集为空
    // （`unrecognizedAll` 让调用方把经验池清空并报错），绝不退回默认集 ——
    // 否则「拼错一个状态名」会静默变成「查了别的状态」甚至「查了全部」。
    return { states: known, unknown, unrecognizedAll: known.length === 0, isDefault: false }
  }
  if (args?.includeCandidates === false) return { states: ['adopted'], unknown: [], unrecognizedAll: false, isDefault: false }
  return { states: EPISODE_DEFAULT_STATES, unknown: [], unrecognizedAll: false, isDefault: true }
}

function countEpisodeStates(episodes) {
  const out = {}
  for (const ep of episodes) {
    const st = ep?.state ?? 'candidate'
    out[st] = (out[st] ?? 0) + 1
  }
  return out
}

function searchText(vaultDir, records, query, args, episodes = []) {
  const limit = Number.isFinite(args.limit) ? Math.min(20, Math.max(1, Math.trunc(args.limit))) : 5
  const { states, unknown: unknownStates, unrecognizedAll, isDefault } = episodeStatesArg(args)
  // L04：`indexable:false` 的记录（`^调用 …` 工具调用日志）不参与检索。
  // 在这里过滤而不是在 `projection.mjs` 里，是因为那是统一投影层（两个来源共用）；
  // 字段本身写进了记录，索引侧将来也能各自按同一字段过滤 —— 契约只有一个：
  // 「`indexable === false` 的记录可按 id 读，但不出现在检索结果里」。
  // 总数仍报**全量**（仓里共 N 条），否则用户会以为记录丢了。
  //
  // S6：这里同时挡掉**存量**的自回显记录。黑名单是 2026-10-24 才有的，仓里已经躺着
  // 609 条它诞生之前写下的（真仓实测其中 67 条 indexable≠false，22 条是「已按当前工程
  // 收窄」）。采集侧的 indexable 只影响往后写的那批，而真仓只读、不回写 ——
  // 所以读取时用**同一份规则表**再挡一次（isSelfEchoRecord 不复制规则，只调用它）。
  // 记录上已经有 selfEchoReason 的新记录走快路径，不再跑正则。
  // 注意：**按 id 直读不经过这里**。挡的是检索排序，不是可审计性。
  const searchable = records.filter((r) => r?.indexable !== false && !isSelfEchoRecord(r))
  // MC10：经验与记录走同一个检索器、同一份预算。`searchProjection` 内部
  // 也是「先按状态过滤再打分」，并把 episode 投影成 record 同形行。
  // 状态名一个都不认得时，经验池必须是空的：宁可报"没查到 + 你状态名写错了"，
  // 也不拿默认集凑一批结果出来（那会让调用方以为筛选生效了）。
  const episodeInput = unrecognizedAll ? [] : episodes
  const found = searchProjection(searchable, episodeInput, query, { limit, states })
  // 按状态分解：只报一个「可检索 0 条」等于告诉用户"没有"，而事实常常是
  // "有，但都还没晋升"。差别的不是数字，是能不能采取行动。
  const byState = countEpisodeStates(episodes)
  const stateText = Object.keys(byState).length
    ? Object.entries(byState).map(([k, v]) => `${k} ${v}`).join('、')
    : '无'
  // S4：默认池里没有 `raw-episode`，但仓里有多少条必须说出来 ——
  // 否则"可检索 N 条经验"会被读成"仓里就这么多"，而真相是有一批没进默认池。
  // 顺带给出显式查询的下一步石子，别让调用方只能干猜。
  // 只在**走默认口径**时才提这句：调用方显式给了 states 就说明他知道自己在筛什么，
  // 每问一次都回一句"还有 N 条没查"是噪声。
  const rawHidden = byState['raw-episode'] ?? 0
  const hiddenNote = (isDefault && rawHidden > 0)
    ? `\n另有 ${rawHidden} 条 raw-episode 经验未进默认检索池（未验证的做法不作结论）；`
      + `要查传 states:["raw-episode"]，按 id 仍可直读。`
    : ''
  // 一个状态名都不认得时必须明说：静默返回"没有命中"会让调用方以为仓里没有，
  // 而真相是他把状态名拼错了。
  const unknownNote = unknownStates.length
    ? `\n⚠ states 里的 ${unknownStates.map((s) => `「${s}」`).join('、')}不是已知经验状态`
      + `（只有 raw-episode / candidate / trial / adopted），已忽略。`
    : ''
  const unverifiedNote = () => {
    const weak = Object.entries(byState)
      .filter(([k, v]) => v > 0 && k !== 'adopted' && states.includes(k))
      .map(([k, v]) => `${k} ${v}`)
    if (!weak.length) return ''
    return `\n注意：仓里有 ${weak.join('、')} 条经验**未晋升**（方法不齐或未验证），`
      + '本次已在检索范围内，它们能作线索，不能当已验证结论。'
  }
  if (!found.hits.length) {
    return `没有命中「${query}」（仓里共 ${records.length} 条记录、${episodes.length} 条经验，`
      + `其中可检索 ${searchable.length} 条记录 + ${found.episodePool} 条经验，`
      + `经验状态分布：${stateText}）。`
      + unknownNote
      + unverifiedNote()
      + hiddenNote
      + '可换更具体的词，或用 id 直读原文。'
  }
  // ── 契约变更（S3 L06，2026-10-21）────────────────────────────────────
  // 原来每条命中回 160 字符正文片段。实测这既浪费预算又不解决问题：
  //  1. 160 字符常常只够读到半句，模型据此判断相关性 = 靠猜；
  //  2. 5 条 × ~180 字符把零档 300 字符预算瞬间吃满，只剩 1 条能看见；
  //  3. 片段被 `clipResult` 二次截断后，连 id 都可能被切断，反而无法回读。
  // 现在只回 `id + 首行(≤80) + 总行数`：模型靠首行判断"是不是这条"，
  // 真要正文就用 `{id, offset, lines}` 分页精确取 —— 预算花在"选哪条"和"读哪段"上，
  // 不花在搬运注定要被丢掉的中段上。
  const lines = found.hits.map((hit) => {
    const body = bodyForVault(vaultDir, hit.record)
    const total = body.text.split('\n').length
    const first = oneLine(body.text.split('\n')[0] ?? '')
    const shown = first.length > HIT_FIRST_LINE_MAX ? first.slice(0, HIT_FIRST_LINE_MAX - 1) + '…' : first
    // 分数只保留 2 位：给相对轻重，不假装有精确语义。
    // 经验行的首行是摘要首句，标 `[经验]` 让模型知道这是**已验证的做法**，
    // 不是一条流水日志 —— 这两种东西的可信度完全不同。
    // 经验必须带生命周期状态：`经验/adopted` 是已验证的做法，
    // `经验/raw-episode` 只是「有人踩过这个坑」的线索，两者可信度差一个量级。
    const tag = hit.record.source === 'episode'
      ? `经验/${hit.record.episodeState ?? 'candidate'}`
      : (hit.record.kind ?? '?')
    return `- ${hit.record.id} [${tag}] 共${total}行 首行：${shown || '(空)'}`
  })
  return `命中 ${found.hits.length} 条（query=「${query}」，仓里共 ${records.length} 条记录 + ${episodes.length} 条经验，`
      + `可检索 ${searchable.length} 条记录 + ${found.episodePool} 条经验，经验状态分布：${stateText}）：\n`
      + `${lines.join('\n')}`
      + '\n用 id + offset/lines 读正文分页（经验 id 以 x- 开头，直读返回结构化视图）。'
      + unknownNote
      + unverifiedNote()
      + hiddenNote
}

/**
 * `laurel_memory` 工具的正文产出。
 *
 * - 给 `id`：读原文分页（大正文按需取，不一次塞满窗口）
 * - 给 `query`：走 `projection.mjs` 的统一投影返回命中摘要（记录 + 经验）
 * - 两者都给：`id` 优先（明确的原文请求比模糊检索更具体）
 *
 * 结果永远遵守 `INJECT_BUDGET[tier].maxChars`：超了就截断并标注。
 * 本函数不抛，坏输入返回可读的说明文本。
 */
/**
 * 同一个工作区的等价 cwd 写法。
 *
 * 为什么要这一层：`projectIdentityOf` 把 cwd 原样拼进哈希，于是
 * `D:\\x\\y`、`D:\\x\\y\\`、`D:/x/y`、`/mnt/d/x/y`、`  D:\\x\\y  `
 * 会派生出**五个不同 projectId**。加了作用域过滤之后，用户多写一个尾斜杠
 * 就会「查不到自己昨天的记录」—— 那看起来像记忆丢了，比不鉴权更糟。
 *
 * 采集侧不动（4 万条记录的 projectId 已按现有算法写死，改算法要全量迁移），
 * 只在查询侧把等价写法都算出来，命中任一即视为本工程。
 */
export function cwdVariants(cwd) {
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  if (!raw) return []
  const out = new Set([raw])
  const slashed = raw.replace(/\\/g, '/')
  out.add(slashed)
  out.add(slashed.replace(/\/+$/, ''))
  out.add(slashed + '/')
  const backed = slashed.replace(/\//g, '\\')
  out.add(backed)
  out.add(backed.replace(/\\+$/, ''))
  // WSL ↔ Windows：/mnt/<盘>/<rest> 与 <盘>:\\<rest> 是同一个目录
  const m = slashed.match(/^\/mnt\/([a-z])\/(.*)$/i)
  if (m) {
    const win = `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`
    out.add(win)
    out.add(win.replace(/\\+$/, ''))
  } else {
    const d = slashed.match(/^([a-z]):\/(.*)$/i)
    if (d) out.add(`/mnt/${d[1].toLowerCase()}/${d[2]}`)
  }
  return [...out].filter(Boolean)
}

/** 一组等价 projectId（去重、保序）。第一个是**原始 cwd** 派生的那个。 */
export function projectIdVariants(cwd) {
  const ids = []
  for (const variant of cwdVariants(cwd)) {
    const p = projectIdentityOf({ cwd: variant })
    if (p.ok && !ids.includes(p.projectId)) ids.push(p.projectId)
  }
  return ids
}

/**
 * MC01：从**真实执行上下文**解析调用方身份（宿主 `execute(args, exec)` 的第二参）。
 *
 * 口径照抄 dsh-warden（`lib/host/tools.js:83-91`）：会话 id 取
 * `exec.agent.session.id`，工作区取 `exec.agent.session.header.cwd`。
 * `projectId` 不另造一套算法 —— 用采集侧同一个 `projectIdentityOf`，
 * 否则"采进去的身份"和"查询时判的身份"会各算一套，永远对不上。
 *
 * 拿不到 cwd 就**不猜**：返回 `ok:false` 并说明缺哪一项，由上层决定拒绝。
 * 编一个 projectId 出来会让调用方看到别的工程的内容还以为是自己工作区的。
 */
export function resolveQueryScope(exec) {
  const session = exec?.agent?.session ?? null
  const sessionId = typeof session?.id === 'string' && session.id.length > 0 ? session.id : null
  const rawCwd = session?.header?.cwd ?? session?.cwd ?? null
  const cwd = typeof rawCwd === 'string' && rawCwd.trim() !== '' ? rawCwd.trim() : null
  if (!sessionId) return { ok: false, reason: 'no-session', note: '调用上下文里没有 session.id' }
  if (!cwd) return { ok: false, reason: 'missing-cwd', sessionId, note: '会话头里没有 cwd，无法判定属于哪个工程' }
  const project = projectIdentityOf({ cwd })
  if (!project.ok) return { ok: false, reason: project.reason ?? 'no-project', sessionId, cwd }
  return {
    ok: true,
    sessionId,
    cwd,
    projectId: project.projectId,
    // 等价写法派生出的全部 projectId：查询按「命中任一」收窄，
    // 免得 cwd 拼写差异把用户自己的历史挡在外面。
    projectIds: projectIdVariants(cwd),
    environmentId: project.environmentId ?? null,
    display: project.display ?? null,
  }
}

export function executeMemoryQuery({ vaultDir, tier = 'zero', args = {}, scope } = {}) {
  const budget = budgetFor(tier)
  const input = args && typeof args === 'object' ? args : {}
  let records = []
  let episodes = []
  let badLines = 0
  try {
    if (!vaultDir) return clipResult('记忆核心未就绪（没有核心仓路径），无法查询。', budget.maxChars)
    const loaded = loadRecords(vaultDir)
    records = loaded.records
    badLines = loaded.bad ?? 0
    // MC10：经验侧同样读，坏行同样计数。`experience/` 目录不存在是正常状态
    // （实时采集目前只产记录，不产 episode），所以这里不报错、不算坏行。
    try {
      const eps = loadEpisodes(vaultDir)
      episodes = eps.episodes
      badLines += eps.bad ?? 0
    } catch { episodes = [] }
  } catch (error) {
    return clipResult(`记忆核心读取失败：${error?.message ?? error}`, budget.maxChars)
  }

  // ── MC01：调用方作用域 ────────────────────────────────────────────────
  // `scope === undefined` 表示本地库/CLI 直调（不走宿主工具入口），不收窄 ——
  // 那条路径本来就有文件系统权限，在这里假扮鉴权只是自欺。
  // 一旦来自宿主工具入口（`scope` 必定存在），身份不全就**拒绝跨域**：
  // 索引里躺着多个工程的内容，缺 cwd 时任何返回都可能是别人的。
  let scopeNote = ''
  let scopeInfo = null
  if (scope !== undefined) {
    if (scope?.ok !== true) {
      return clipResult(
        `无法确定本次查询属于哪个工程，已拒绝跨工程检索（${scope?.reason ?? 'no-scope'}`
          + `${scope?.note ? `：${scope.note}` : ''}）。`
          + `索引里现有 ${records.length} 条记录、${episodes.length} 条经验，分属多个工程；`
          + '不按工程收窄就检索，等于把别人的历史当成你工作区的结论。'
          + '需要跨工程检索请显式给出 project（projectId）。',
        budget.maxChars,
      )
    }
    const before = records.length
    const beforeEp = episodes.length
    // 显式 `project` 只要那一个；不给则接受调用方 cwd 的全部等价派生值。
    const explicit = asString(input.project)
    const wanted = explicit
      ? [explicit]
      : (Array.isArray(scope.projectIds) && scope.projectIds.length ? scope.projectIds : [scope.projectId])
    const wantedSet = new Set(wanted.filter(Boolean))
    records = records.filter((r) => wantedSet.has(r?.projectId))
    // 经验同样收窄：`makeExperience` 写了 projectId，不收窄会把别的工程的做法
    // 当成适用于当前工程的已验证经验 —— 比查不到更危险。
    episodes = episodes.filter((e) => wantedSet.has(e?.projectId ?? 'unknown'))
    scopeInfo = {
      projectId: wanted[0],
      // 等价写法数量也要报出来：>1 说明这个工作区历史上被记成过多个工程，
      // 那是数据问题，不该悄悄藏起来。
      projectIdVariants: wanted.length,
      from: explicit ? 'arg' : 'caller-cwd',
      environmentId: scope.environmentId ?? null,
      sessionId: scope.sessionId ?? null,
      droppedRecords: before - records.length,
      droppedEpisodes: beforeEp - episodes.length,
    }
    // 只在真的收窄掉了东西时才提一句：没掉任何东西时这句话纯占预算。
    if (scopeInfo.droppedRecords > 0 || scopeInfo.droppedEpisodes > 0) {
      scopeNote = `〔已按当前工程收窄：未包含其它工程 ${scopeInfo.droppedRecords} 条记录、`
        + `${scopeInfo.droppedEpisodes} 条经验〕\n\n`
    }
  }

  // 坏行必须让调用方看见：静默丢掉的话，用户会以为"查过了，没有相关记忆"，
  // 而真相是"那几条读不出来"。这是最坏的一种错误 —— 让人对空结果产生错误信心。
  const warn = badLines > 0
    ? `⚠ 记忆索引里有 ${badLines} 行损坏（无法解析），本次查询不包含这些记录；可用 import-session 重放或从 journal 重建。\n\n`
    : ''
  try {
    if (asString(input.id)) {
      return clipResult(scopeNote + warn + pageText(vaultDir, records, input.id, input, episodes), budget.maxChars)
    }
    if (typeof input.query === 'string' && input.query.trim()) {
      return clipResult(scopeNote + warn + searchText(vaultDir, records, input.query.trim(), input, episodes), budget.maxChars)
    }
    return clipResult(
      scopeNote + warn + `需要 query 或 id 之一才能查记忆（仓里共 ${records.length} 条记录、${episodes.length} 条经验）。`
        + 'query 做检索，id 直读原文分页。',
      budget.maxChars,
    )
  } catch (error) {
    return clipResult(`记忆查询失败：${error?.message ?? error}`, budget.maxChars)
  }
}
