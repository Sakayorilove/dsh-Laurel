/**
 * laurel-memory/experience/pipeline —— MC11：**记下流水 ≠ 经验学习系统**。
 *
 * ── 这个文件为什么存在（缺陷 MC11，2026-10-22）───────────────────────────
 * `lib/experience/` 四个文件（lifecycle / method / guards / skill）加起来约 32KB，
 * `makeExperience` / `promote` / `recordOutcome` / `projectSkill` 全都写好了、
 * 单测也全绿。但现场核查：
 *
 *   grep -rn 'makeExperience|promote(|recordOutcome' lib/  → 只有 lifecycle.mjs 自己
 *   grep -rn 'episodes.jsonl'                            → 唯一写盘点是 cli.mjs 的 import-forge
 *   真仓 ~/.dsh/laurel-core/experience/                  → 目录至今不存在
 *
 * 也就是说：**整条经验学习链没有活跃业务调用方**。采集只往 memory/records.jsonl
 * 写流水（4 万条），经验目录一个字节都没有。手册 MC11 的原文是
 * 「任务结束/纠正/失败 → 保守 episode → 候选 → 持久采纳 → 外部验证 → Skill 绑定与失效」。
 *
 * ── 纪律（比功能更重要）────────────────────────────────────────────────
 *  1. **保守触发**：只在三种信号上产 episode —— 一轮对话结束（`turn/end`）、
 *     用户明确纠正、工具明确失败。不是每条事件都产，否则经验目录会变成第二个
 *     流水账，"经验"这个词就废了。
 *  2. **自动采纳**：按完整方法、成功证据和作用域自动评估新旧条目。
 *     采纳不生成成功 outcome；后续真实执行结果独立记录，失败停止推荐。
 *  3. **方法不齐就留在 raw-episode 并**记下缺哪几项，不补全、不猜。缺项在
 *     端点可见，不是静默丢弃。
 *  4. **失败不抛**：经验学习坏了不能让记忆读写和宿主对话跟着坏（同
 *     retention-plane 的纪律）。
 *  5. **心跳可见**：`observed / triggered / emitted / skipped / errors / lastTrigger`
 *     全部进 status()。一个不产出的定时器和不存在的定时器，从外面看是一样的。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 身份摘要与 `makeExperience`/`contentHash` 同源（都走 laurel-core 的 canonical 哈希），
// 不自己造一套字符串拼接 —— 两套哈希迟早会在"同一个事实算出两个 id"上分家。
import { contentHash } from '../../../laurel-core/lib/format.mjs'
// T5b：写锁**复用** laurel-core 那套（原子 link 抢占 + fence + 同机死锁回收 + 退避重试），
// 不新写一套。抢锁的粒度与语义由 lock.mjs 决定，这里只决定「锁哪个文件名、等多久」。
import { acquireWrite } from '../../../laurel-core/lib/lock.mjs'

import {
  autoPromote, automaticMethodKey, canTransition, confidenceOf, makeExperience, promote, recordOutcome, revoke, retire, STATES, usableForRecommendation,
} from './lifecycle.mjs'
import {
  dedupeVerifiedPairs, methodFromCallPairs, methodFromPair, methodFromSummary, passingCallPairs,
  resolveApplicableEnv, validateMethod, withDerivedEnv,
} from './method.mjs'
import { projectSkill, skillId, validateSkillBinding } from './skill.mjs'
import { EPISODES_FILE, loadEpisodes } from '../projection.mjs'

/**
 * 单开关（S2）：verified-action 这条触发总闸。
 *
 * 全文件唯一一处。置 false 即回到 S1 交付时的三条触发集
 * （turn-end / correction / tool-failure），配对与去重代码仍在但不产条目 ——
 * 这样"开关关掉行为不变"可以被测试钉住，而不是靠记忆。
 * 照 ZCode 的 project-memory-retrieval-branch.ts 那样，用一个具名常量而不是
 * 散落在分支里的布尔字面量：想回退时只有一个地方要改。
 */
export const USE_VERIFIED_ACTION_TRIGGER = true

/**
 * 触发信号。名字进 `lastTrigger` 与 stats，改名就会破坏历史可读性。
 *
 * S2 起是**四条**：前三条由宿主事件驱动（走 windowRecords 窗口），
 * 第四条 `verified-action` 由配对结果驱动 —— 它与前三条**并列**，不是子集。
 * 实测依据：S1 四道闸门产出的 46 条 episode 窗口只装到 22/660 条通过绑定记录，
 * 638 条落在窗口外。把顺境塞进窗口等于自废 96% 的货。
 */
export const TRIGGERS = Object.freeze(['turn-end', 'correction', 'tool-failure', 'verified-action'])

/** 由配对结果驱动、**不走** b.records 窗口的触发集合。 */
const PAIR_DRIVEN_TRIGGERS = Object.freeze(['verified-action'])

/**
 * 用户明确纠正的说法。
 *
 * 为什么用关键词而不是让模型判断：这一步是在**采集侧**跑的，拿不到模型；
 * 而且"用模型判断该不该记经验"会让同一条对话在不同档位产出不同经验库。
 * 关键词会漏（口语千变万化），但漏了只是少一条候选，不会产出错的经验。
 * 宁可漏，不可错 —— 错的经验会被当成已验证做法推荐出去。
 */
const CORRECTION_RE = /(不对|不是这样|错了|你搞错|又错|搞反|说反了|不是我要的|重新做|别这样|不要再|刚才那步错|理解错|我指的是)/

/**
 * S9.1：**内容级**排除 —— 正文在谈 Laurel 自己代码的，不算"用户纠正"。
 *
 * 为什么作者门不够（实测，真仓 55,129 条记录）：
 * `CORRECTION_RE` 原样跑出 453 条命中，其中 **125 条（27.6%）** 的正文是
 * "我们排查 Laurel 自己"的对话 —— 读 `pipeline.mjs`、贴 `CORRECTION_RE`、
 * 写文档说"作者门漏了"。用户作者那 5 条里就有 4 条是这种。
 * 这正是 dsh-agent-soul 记的那个坑：**凡是从整份日志里搜关键词的检测，
 * 都会被你对这个检测的讨论污染**（报一次，永远报）。
 *
 * 所以判据是两层：作者必须是 `user`（作者门），且正文不含自家标识符（本表）。
 * 表里每一条都**独立可摘**（是数组，不是一个大正则）：某条误杀太重时只删那一行。
 */
export const SELF_REFERENCE_MARKERS = Object.freeze([
  'laurel-core',
  'laurel-memory',
  'pipeline.mjs',
  'episodes.jsonl',
  'CORRECTION_RE',
  'capture.mjs',
  'adapter-dsh.mjs',
])

/**
 * 正文点到了哪一个自家标识符（没点到返回 `null`）。
 * 大小写不敏感：同一条路径在 Windows 工具链里可能写成 `Pipeline.mjs`。
 */
export function selfReferenceIn(text) {
  const body = String(text ?? '')
  if (!body) return null
  const lower = body.toLowerCase()
  for (const marker of SELF_REFERENCE_MARKERS) {
    if (lower.includes(String(marker).toLowerCase())) return marker
  }
  return null
}

/**
 * 纠正判定的**完整门**：作者必须是用户 + 正则命中 + 正文不是在谈我们自己。
 *
 * 三者缺一都不算纠正。返回 `reason` 是为了让 status()/测试能说清"这条为什么
 * 不算"，而不是只看到一个 false —— 一个判据说不出拒绝理由，就等于无法审计。
 */
export function correctionVerdict(text, author = null) {
  if (author !== 'user') return { correction: false, reason: `author:${author ?? 'unknown'}` }
  const body = String(text ?? '')
  if (!CORRECTION_RE.test(body)) return { correction: false, reason: 'no-match' }
  const marker = selfReferenceIn(body)
  if (marker) return { correction: false, reason: 'self-reference', marker }
  return { correction: true, reason: 'user-correction' }
}

/**
 * 单条 episode 的证据上限（**含**触发那一条，取最近这么多条）。
 *
 * 为什么必须有上限：游标只保证"不重放已经产过的记录"，**不封顶**。
 * 实测无界窗口（"一直攒到下一次触发"）会让单条证据 p50 从 64 涨到 **237** ——
 * 那是把滚动窗口的噪声换成了另一种形状的噪声。48 这个数决定离线模拟里
 * 46 条 episode / 证据 p50≈49 的量级；改它就会改掉那个结果，所以它不是"调参"。
 */
export const EVIDENCE_CAP = 48

/**
 * S2：verified-action 的两道去重阈值（**默认入池口径**，不是可调参数）。
 *
 * 真仓实测：330 对通过 → 96 种归一化命令头 → 重复 ≥2 次的 24 种 → 跨 ≥2 会话的 3 种。
 * 起步只放 24 条。改这两个数会直接改掉那三个数之一，所以它们跟 EVIDENCE_CAP 一样
 * 是**结论**，不是配置项：一次性的探针命令（96 种里有 72 种只出现过一次）
 * 不该被当成"这台机器上已验证的做法"推荐出去。
 */
export const VERIFIED_MIN_REPEATS = 2
export const VERIFIED_MIN_SESSIONS = 2

/**
 * 工具失败的判决（这套判定与 `capture.mjs` 的 `[工具失败]` 前缀同源）。
 * `isError` 是采集侧已经算好的字段；这里只补事件自身可能带的退出码。
 */
function looksFailed(event) {
  if (event?.isError === true) return true
  const exit = event?.raw?.data?.exitCode ?? event?.exitCode
  return Number.isFinite(exit) && exit !== 0
}

/**
 * 这条采集事件是谁说的。**两种形状都认**，因为调用方不止一处：
 *  - 生产路径：`capture.mjs` 的 `toAdapterEvent` 给的是 `source.kind`（没有 `authorKind`）；
 *  - 测试与旧调用方：直接给 `authorKind: 'user'`。
 * 拿不到就返回 `null`（**不猜**）—— 判错的作者会让 no-user-prose 闸门放走一条
 * 本来不该产的 episode，那比少产一条更贵。
 */
function authorOf(event) {
  const kind = event?.authorKind ?? event?.source?.kind ?? null
  return typeof kind === 'string' && kind ? kind : null
}

/** 一行摘要：取用户原话或工具失败的第一行，限长，不留换行。 */
function oneLine(text, max = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * 从一段**捕获结果**里凑出一种经验条目。
 *
 * 只吃已经落盘的记录（有 id、有正文、有 projectId），不重新读宿主事件 ——
 * 采集侧已经做过脱敏、截断与身份判定，在这里再看一遍原文等于绕过那些纪律。
 */
export function episodeFromEvidence({
  trigger, records = [], userText = '', failedTool = null, coreId, projectId, environmentId = null, sessionId = null, at = Date.now(),
  /**
   * S2 接缝：**已经算好的**方法（`methodFromCallPairs` 的返回值）。
   * 给定时不再走 `methodFromSummary` —— 那条路是从散文里**推断**「看起来过了」，
   * 而 verified-action 的 verification 是工具结果里观测到的事实，两者不能混着抽。
   * 不给时行为一个字节都没变（S1 的三条触发全走默认分支）。
   */
  methodOverride = null,
} = {}) {
  if (!Array.isArray(records) || records.length === 0) return { ok: false, reason: 'no-evidence' }
  if (!projectId) return { ok: false, reason: 'missing-project' }
  if (!TRIGGERS.includes(trigger)) return { ok: false, reason: 'bad-trigger', trigger }

  // 证据取**记录 id**，不是正文：正文可以再回读（MC04），而把正文抄进经验里
  // 会在下一次脱敏规则升级后变成两份不一致的副本。
  const evidence = records.map((r) => r?.id).filter((x) => typeof x === 'string' && x)
  if (!evidence.length) return { ok: false, reason: 'no-evidence-ids' }

  const last = records[records.length - 1]
  const headline = trigger === 'tool-failure'
    ? `工具失败：${oneLine(failedTool?.tool ?? 'unknown')} — ${oneLine(failedTool?.text ?? '', 120)}`
    : trigger === 'correction'
      ? `用户纠正：${oneLine(userText, 140)}`
      // S2：顺境的一句话 —— 哪条命令、跑过了。命令原文来自调用侧（配对的 first 记录），
      // 不带条数与会话 id：理由同下面 summary 那段注释（易变字段会让同一件事换 id）。
      : trigger === 'verified-action'
        ? `验证通过：${oneLine(failedTool?.tool ?? 'shell', 40)} — ${oneLine(last?.body ?? '', 120)}`
        : `任务收尾：${oneLine(userText || last?.title || last?.body || '', 140)}`
  // summary 是**给人看的一句话**，只留能长期成立的部分。
  // 原来尾部带「依据 N 条记录，会话 session-…」—— N 会涨、会话 id 每次都不同，
  // 这两个字段让同一件事每次产出的 summary 都不一样（真跑：同一个 run_code
  // 失败被记成 3 条不同 id 的 episode）。可变的统计进 `evidence`（本来就有数组
  // 长度）与会话字段，不进摘要正文。
  const summary = headline

  // 方法**从证据正文里抽**，抽不到就是抽不到 —— `validateMethod` 会把缺项列出来。
  // 这里没有任何"补全"逻辑：一条只说了结论、没说怎么做也没说怎么验证的记录，
  // 就应该停在 raw-episode，而不是被编成一个看起来完整的方法。
  const env = {
    projectId,
    environmentId: environmentId ?? null,
    os: null,
    shell: null,
    cwd: null,
  }
  // S2：verified-action 走**已经算好的**方法（配对 + 通过标记 + 整句 limits），
  // 其余三条触发一个字节都没改，仍然从证据正文里保守抽取。
  const methodCheck = methodOverride ?? methodFromSummary(records.map((r) => String(r?.body ?? r?.text ?? '')).join('\n'), {
    projectId: env.projectId,
    environmentId: env.environmentId,
    // evidence 是**来源证据**（记录 id，可回读），不是"已验证"的意思。
    evidence,
    // verificationHow 如实描述我们凭什么说验证过：「依据原文自述」。
    // 不能写成"已跑测试"——那是在编。result 仍由正文关键词判定，
    // 正文没提验证 → unknown → validateMethod 拒 → episode 老实停在 raw-episode。
    verificationHow: '依据原文自述（可回读记录 id 核对）',
    verificationEvidence: evidence,
  })
  const method = methodCheck?.method ?? null
  const verdict = validateMethod(method ?? {})

  const base = makeExperience({
    method,
    summary,
    actor: 'system',
    coreId: coreId ?? 'unknown',
    projectId,
    environmentId: env.environmentId,
    at,
  })
  // `makeExperience` 直接产出 candidate；MC11 的链是 raw-episode → candidate，
  // 所以先降到 raw-episode，再由 `acceptCandidate()` 按方法完备度决定要不要升。
  // 用 spread 而不是改 lifecycle：那个文件的 21 行 STATES 是被测试与投影层
  // 同时引用的契约，为了一条调用方的方便去改它不合适。
  // id 用**身份摘要**重算：`makeExperience` 的 id 派生自 summary，
  // 而 summary 现已去掉易变字段；但同一句话仍可能在不同会话里重复出现，
  // 所以再把 trigger 与证据首条记录 id 揉进去 —— 同一故障 + 同一批证据
  // 应当得到同一个 id（去重才有意义），跨会话的同名故障则仍是两条（来源不同）。
  const identity = contentHash({
    trigger,
    headline,
    method: method ?? null,
    projectId,
    environmentId: env.environmentId,
    firstEvidence: evidence[0] ?? null,
  })
  const record = {
    ...base,
    id: 'x-' + identity.slice(0, 20),
    contentVersion: identity,
    state: 'raw-episode',
    trigger,
    sessionId: sessionId ?? null,
    evidence,
    methodMissing: verdict.missing ?? [],
    methodProblems: verdict.problems ?? [],
  }
  return {
    ok: true,
    record,
    methodOk: verdict.ok === true,
    missing: verdict.missing ?? [],
    problems: verdict.problems ?? [],
  }
}

/**
 * raw-episode → candidate。自动，但**只对方法齐备的**。
 * 返回答不出原因时调用方必须把 reason 记进 stats —— 一条永远升不上去的
 * 经验，如果连为什么都看不到，那就等于被静默丢弃了。
 */
export function acceptCandidate(record, { at = Date.now(), ctx = {} } = {}) {
  if (!record) return { ok: false, reason: 'missing-record' }
  if (record.state === 'candidate') return { ok: true, record, already: true }
  if (!canTransition(record.state, 'candidate')) {
    return { ok: false, reason: 'bad-transition', from: record.state, to: 'candidate' }
  }
  // P5c：先按**动作级**判据重推环境，再判完备性。
  // 存量的 2,680 条当年只能从 gitBranch 派生 environmentId，本机不是 git 仓库，
  // 于是 100% 是 null —— 它们不是"做法不可复用"，而是"环境没记下来"。
  // 命令正文里有没有 wsl / PowerShell 线索，是可以**事后重算**的（与 methodOk 快照无关）。
  // 只补环境：verification 是 failed 的仍然过不去（P5b），重算不等于放宽。
  const fixed = withDerivedEnv(record.method ?? {})
  const verdict = validateMethod(fixed.method ?? {})
  if (!verdict.ok) {
    return {
      ok: false,
      reason: 'method-incomplete',
      missing: verdict.missing ?? [],
      problems: verdict.problems ?? [],
      envDerived: fixed.derived.environmentId,
      note: '留在 raw-episode：方法不齐的经验不能被当成可推荐的结论，缺项已记录在条目上',
    }
  }
  return {
    ok: true,
    record: {
      ...record,
      state: 'candidate',
      method: fixed.method,
      methodOk: true,
      methodMissing: [],
      methodProblems: [],
      ...(fixed.derived.environmentId ? { envDerivedFrom: fixed.derived.source } : {}),
      revision: (record.revision ?? 1) + 1,
      updatedAt: at,
    },
  }
}

/**
 * S2：把一批记录**整仓**跑一遍 verified-action 的三道去重。
 *
 * 这是"验证通过"这条触发的离线口径，也是重放真仓用的那个函数。它与
 * `observe()` 里那条流式路径共用同一套判据（都走 `method.mjs` 的
 * `passingCallPairs` / `methodFromCallPairs` / `dedupeVerifiedPairs`），
 * 区别只在"什么时候知道重复次数"：
 *   - 这里一次性看到全部记录，重复次数是**全仓**的（真仓 330 → 96 → 24 → 3）；
 *   - observe 那条是逐条到的，只能按"池子里已经攒到的次数"算（见 emitVerifiedAction）。
 * 两个口径都写出来，是为了避免"重放能复现、运行时对不上"这种说不清的情况。
 *
 * 返回的是**待落盘的 episode 记录**，不写盘 —— 写盘由调用方决定（纪律 4：失败不抛）。
 *
 * @param {object[]} records 记录数组（形如 records.jsonl 的行）
 * @param {object} opts {coreId, projectId, environmentId, minRepeats, minSessions, max, at}
 * @returns {{stats:object, episodes:object[]}}
 */
export function planVerifiedActions(records = [], {
  coreId = null, projectId = null, environmentId = null,
  minRepeats = 2, minSessions = 2, max = 0, at = Date.now(), maxLimits = 3,
} = {}) {
  const methods = methodFromCallPairs(records, { projectId, environmentId, maxLimits })
  const pairs = methods.map((m) => m.pair)
  const dedupe = dedupeVerifiedPairs(pairs, { minRepeats, minSessions, max })
  const byResultId = new Map(methods.map((m) => [m.pair.resultRecordId, m]))

  const episodes = []
  const skipped = Object.create(null)
  for (const pick of dedupe.selected) {
    const built = byResultId.get(pick.resultRecordId)
    // 配对本该一一对应；对不上就是内部错位，如实记跳过的原因而不是硬造一条。
    if (!built) { skipped['pair-lost'] = (skipped['pair-lost'] ?? 0) + 1; continue }
    const ep = verifiedEpisodeFromPair(built, {
      coreId,
      projectId: projectId ?? pick.projectId ?? null,
      environmentId: environmentId ?? pick.environmentId ?? null,
      repeatCount: pick.repeatCount,
      sessionCount: pick.sessionCount,
      strong: pick.strong,
      at,
    })
    if (!ep.ok) { skipped[`build:${ep.reason}`] = (skipped[`build:${ep.reason}`] ?? 0) + 1; continue }
    episodes.push(ep)
  }

  return {
    stats: {
      boundPairs: null,               // 由 passingCallPairs 之前的阶段决定，此处不重算（见 replay 脚本）
      passingPairs: pairs.length,
      distinctCommands: dedupe.distinctCommands,
      repeatCommands: dedupe.repeatCommands,
      crossSession: dedupe.crossSession,
      rejectedSingle: dedupe.rejectedSingle,
      selected: dedupe.selected.length,
      emitted: episodes.length,
      withLimits: methods.filter((m) => m.limits.length > 0).length,
      withoutLimits: methods.filter((m) => m.limits.length === 0).length,
      skipped,
    },
    episodes,
  }
}

/**
 * 一条通过配对 → 一条 episode 记录（raw-episode 起，方法齐备才升 candidate）。
 *
 * 证据固定是 [调用 id, 结果 id] 两条：少一条就无法复核"下的什么命令、过了没有"。
 * 摘要里带命令头而不带条数/会话：同一条命令换个会话再来一次仍然是同一件事，
 * 摘要一变 id 就变，去重就全空转了（S1 那条注释记过同一个坑）。
 */
export function verifiedEpisodeFromPair(methodWithPair, {
  coreId = null, projectId = null, environmentId = null,
  repeatCount = 1, sessionCount = 1, strong = false, at = Date.now(),
} = {}) {
  const pair = methodWithPair?.pair
  if (!pair) return { ok: false, reason: 'missing-pair' }
  const records = [
    { id: pair.callRecordId, body: `调用 ${pair.tool} ${pair.command}`, author: 'tool' },
    { id: pair.resultRecordId, body: pair.output, author: 'tool' },
  ]
  const built = episodeFromEvidence({
    trigger: 'verified-action',
    records,
    coreId,
    projectId,
    environmentId,
    // 会话 id 落到条目上（来源可追溯），但不进摘要 —— 见上面的理由。
    sessionId: pair.sessionId,
    at,
    methodOverride: methodWithPair,
    // 摘要：同一条命令在任何会话里都是同一句，重复次数进字段不进正文。
    headlineOverride: `验证通过：${oneLine(pair.tool, 40)} — ${oneLine(pair.command, 120)}`,
  })
  if (!built.ok) return built
  return {
    ...built,
    record: {
      ...built.record,
      // 去重口径留在条目上，让"为什么它进池子了"可核对。
      verified: {
        command: pair.command,
        head: pair.head,
        repeatCount,
        sessionCount,
        strong,
        callRecordId: pair.callRecordId,
        resultRecordId: pair.resultRecordId,
        tool: pair.tool,
      },
    },
  }
}

/**
 * 追加一行版本到 `experience/episodes.jsonl`。读侧按 id 取 revision 最高的（loadEpisodes）。
 *
 * ── 写入纪律（T5a，2026-10-23）：fsync ──────────────────────────────────
 * 这里补上「写完即 fsync」，做法对齐 `capture.mjs` 的 appendRecord
 * （capture.mjs:377-388：同一个 fd 写、fsync、finally 关掉）。为什么必须补：
 * 裸 `appendFileSync` 只是把数据交给操作系统的页缓存就返回 `{ok:true}`，
 * 断电/宿主被强杀之后这一行可能压根没落盘，而调用方（emit/promote 链）已经
 * 按成功计了数 —— 那就是「内存里说写成了、盘上没有」的静默分叉。
 *
 * ── 写入纪律（T5b，2026-10-23）：补上写锁 ─────────────────────────────
 * 原来这里是整个经验侧唯一的**无锁写**。O_APPEND 的单行原子性只对「小于一次写系统调用
 * 上限的、单进程的」追加成立；本仓实测单行平均 12.6 KB，多进程/多会话并发时不能只靠它。
 * 现在按 records 侧同一种锁保护临界区：
 *   - 锁的实现来自 `laurel-core/lib/lock.mjs` 的 `acquireWrite`（与 vault.commit 同一套：
 *     原子 link 抢占、fence 校验、同机死锁回收、waitMs 退避重试），**不新写一套**；
 *   - 锁文件名取 `EXPERIENCE_LOCK_FILE`（`experience/write.lock`），**不抢** vault 的
 *     write.lock：经验行的追加和 journal 链的提交是两件事，共用一把锁会把两者串成
 *     一条队，等于用一个错误的粒度换一个正确的互斥。
 *   - 抢不到锁时**不阻塞调用方**，返回 `{ok:false, reason:'locked'}` 并带 holder 供诊断
 *     （emit 链会把它记进 stats.errors，与其它写失败同等可见）。
 *
 * **仍然存在、且这一轮没碰的缺口**（各自需要单独设计）：
 *   1. **无 journal 权威**：records 侧的事实先 `vault.commit` 进 journal，
 *      records.jsonl 只是**可重建的读侧视图**（capture.mjs 头注释第 4 条）。
 *      episodes.jsonl 是唯一副本 —— 它自己坏了就是真丢了，没有第二份真相。
 *   2. **无 reconcile 兜底**：records 侧有 `reconcileRecords`（capture.mjs:434 起）
 *      从 journal 重建缺失行。这里没有对应能力，写失败只能返回 write-failed
 *      让上层计数，事后无法从任何权威重建。
 * 差距是**真实存在**的，所以写在这里而不是假装对齐；补这两点各自需要
 * 「经验是否要进 journal」「reconcile 的读侧视图如何不去猜身份」的决定，属下一波。
 *
 * @returns {{ok:boolean, file?:string, revision?:number, state?:string, reason?:string, error?:string}}
 */
export function appendEpisode(vaultDir, record, { expectedRevision } = {}) {
  if (!vaultDir) return { ok: false, reason: 'no-vault' }
  if (!record || typeof record.id !== 'string') return { ok: false, reason: 'bad-record' }
  const file = join(vaultDir, EPISODES_FILE)
  // T5b：临界区 = 追加 + fsync。抢锁失败**不抛**、也不无限重试：
  // 与 vault.commit 同一口径（COMMIT_LOCK_WAIT_MS 注释：卡住一步会拖住整轮对话）。
  // 为什么这里还要一层「截止时间」重试：acquireWrite 的 waitMs 是**单次调用**的
  // 退避预算（睡完 spent 就递归，并扣掉这段 sleep），递归层数本身不受约束，
  // 每层还要真实做 open/link/read。并发 20 的实测里单靠它兜不住（会返回 held）。
  // 经验写入是可以晚 200ms 的旁路、不是 commit，所以给它一个明确的外层预算；
  // 超了照样如实返回 locked，不无限等。
  const lock = acquireEpisodeLock(vaultDir)
  if (!lock.ok) {
    return { ok: false, reason: 'locked', lockReason: lock.reason, holder: lock.holder ?? null }
  }
  let fd = null
  try {
    const latest = loadEpisodes(vaultDir).episodes.find(e => e.id === record.id)
    if ((expectedRevision !== undefined && (latest?.revision ?? null) !== expectedRevision) ||
        (latest && (record.revision ?? 1) <= (latest.revision ?? 1))) {
      return { ok: false, reason: 'stale-revision' }
    }
    mkdirSync(dirname(file), { recursive: true })
    // 用 openSync + writeSync 而不是 appendFileSync + 事后 open：
    // appendFileSync 内部自己开/关 fd，拿回来的是**另一个**句柄，对它 fsync
    // 依赖的是「两个 fd 指向同一 inode，fsync 会一并刷」这个实现细节
    // （laurel-core/lib/budget.mjs:75-79 记过同一个坑，D92）。用同一个 fd 才是
    // 依赖接口语义。
    fd = openSync(file, 'a')
    writeSync(fd, JSON.stringify(record) + '\n')
    // 不 fsync 的话，断电后 episodes 可能少尾巴，而调用方已按 ok:true 计数。
    fsyncSync(fd)
    return { ok: true, file, revision: record.revision ?? 1, state: record.state }
  } catch (error) {
    return { ok: false, reason: 'write-failed', error: String(error?.message ?? error) }
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* 关不掉不掩盖原始错误 */ } }
    // 释放必须放在 finally：写失败也要放锁，否则一次 EACCES 就让整个经验侧永久 locked。
    try { lock.release?.() } catch { /* 释放失败不掩盖写入结果 */ }
  }
}

/**
 * 经验侧的锁文件名。**必须与 vault 的 write.lock 分开**（理由见 appendEpisode 头注释）：
 * 前者保护「journal 链尾 + blob 引用」的一致，后者保护「episodes.jsonl 的单行追加」，
 * 两种临界区没有嵌套关系，共用一把锁只会让经验写入排队等整仓提交。
 * 放在 `experience/` 下而不是仓根，是为了让「谁保护谁」一眼可见。
 */
export const EXPERIENCE_LOCK_FILE = join('experience', 'write.lock')
/** 单次 acquireWrite 的退避预算，与 vault.commit 同值同理由（见 vault.mjs:31-38）。 */
export const EPISODE_LOCK_WAIT_MS = 60
/** 外层截止：在这段时间内反复重抢，超了就如实返回 locked（不无限阻塞对话）。 */
export const EPISODE_LOCK_DEADLINE_MS = 200
/**
 * 抢经验侧写锁。**实现全部来自 laurel-core**（`acquireWrite`），这里只负责
 * 「用哪个文件名、单次等多久、外层最多重抢几次」——这三点是本模块的业务决定，
 * 与 vault.commit 的决定不同，所以由本模块说，而不是往 lock.mjs 里加分支。
 *
 * 为什么不直接把 vault 的 `write.lock` 拿来用：粒度和语义都不同。见 EXPERIENCE_LOCK_FILE。
 */
function acquireEpisodeLock(vaultDir, { deadlineMs = EPISODE_LOCK_DEADLINE_MS } = {}) {
  const started = Date.now()
  let last = null
  for (let round = 0; round < 4; round += 1) {
    last = acquireWrite(vaultDir, { waitMs: EPISODE_LOCK_WAIT_MS, lockFile: EXPERIENCE_LOCK_FILE })
    if (last.ok) return last
    // 只有「别人占着」值得再等；io / unreadable-lock 这类问题重试只会更糟。
    if (!['held', 'expired-but-alive-or-unknown-host', 'contended'].includes(String(last.reason))) return last
    if (Date.now() - started >= deadlineMs) return last
  }
  return last
}

/** One lock covers the latest-state read and every automatic transition. */
export function transactEpisodes(vaultDir, change) {
  if (!vaultDir) return { ok: false, reason: 'no-vault' }
  const lock = acquireEpisodeLock(vaultDir)
  if (!lock.ok) return { ok: false, reason: 'locked', lockReason: lock.reason }
  let fd = null
  try {
    const loaded = loadEpisodes(vaultDir)
    // Never turn a partial/corrupt read into an automatic decision.
    if (loaded.bad) return { ok: false, reason: 'bad-episode-lines', bad: loaded.bad }
    const rows = change(loaded.episodes) ?? []
    if (!rows.length) return { ok: true, records: [], written: 0 }
    const file = join(vaultDir, EPISODES_FILE)
    mkdirSync(dirname(file), { recursive: true })
    fd = openSync(file, 'a')
    for (const row of rows) writeSync(fd, JSON.stringify(row) + '\n')
    fsyncSync(fd)
    return { ok: true, records: rows, written: rows.length }
  } catch (error) {
    return { ok: false, reason: 'write-failed', error: String(error?.message ?? error) }
  } finally {
    if (fd !== null) try { closeSync(fd) } catch {}
    try { lock.release?.() } catch {}
  }
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * 经验学习面的执行体。
 *
 * `observe(session, event, captured)` 由宿主事件流驱动（与采集同一入口），
 * 内部按会话累积证据，触发时产 episode 并落盘。
 */
export function createExperiencePlane({
  vaultDir = null,
  coreId = null,
  enabled = true,
  log = noopLog,
  clock = Date.now,
  /** 一次 turn 累积多少条记录才值得凑经验。1 条就产会让经验目录变成流水账。 */
  minRecordsPerEpisode = 2,
  /** 单会话内存里最多留多少条 turn 证据（超出丢最早，不是丢最新）。 */
  maxBufferedRecords = 64,
  /**
   * S2：单会话内存里最多留多少条**可配对**工具记录。
   *
   * 与 maxBufferedRecords 分开，因为两者服务的判据不同：窗口封顶是防"一次切走整段历史"，
   * 配对封顶是防"长会话把内存撑爆"。要给齐"同一条命令通过 2 次"的空间，
   * 所以给得比窗口宽（256 = 128 对）。真仓单会话最多 2,000+ 条工具记录，
   * 超出后丢最早已配过对的 —— 被丢的那些已经产过 episode，不会丢证据。
   */
  maxPairRecords = 256,
  /**
   * session → projectId。由 index.js 注入（它才能安全地 import `adapter-dsh.mjs` 的
   * `projectIdentityOf`：本文件被 capture 侧的同一条链引用，直接 import 会成环）。
   * 拿不到就返回 null → episode 被拒（`missing-project`），**不编身份**。
   */
  resolveProject = null,
} = {}) {
  const stats = {
    observed: 0, triggers: 0, emitted: 0, promoted: 0, outcomes: 0, revoked: 0,
    skipped: 0, errors: 0, lastTrigger: null, lastReason: null, lastError: null, lastAt: null,
    byTrigger: Object.create(null),
    /**
     * 跳过原因的分类计数。为什么必须显式记：原来只有 `skipped` 一个总数，
     * 于是"这一轮什么都没产"既可能是"没有触发"、也可能是"触发了但闸门拦住"，
     * 从外面看完全一样 —— 一个永远不产出的观察者与一个不存在的观察者，
     * 面板上是同一个形状。这里按原因分开，尤其是 `capture-denied:unknown-author`：
     * `turn/end` 这类事件本来就没正文、拿不到作者，它必须能自己说清"我不是没跑，是被拒了"。
     */
    skippedByReason: Object.create(null),
    /** 被内容级排除（S9.1）挡下的"纠正"条数 —— 这个数长期偏高说明我们又在排查自己。 */
    selfReferenceSkipped: 0,
    /** 命中 findSimilar 的次数（证据并进已有条目，不新增行）。 */
    deduped: 0,
    /**
     * 主信号 `turn/end` 到没到过经验面。**这不是装饰**：
     * 宿主 `turn/end` 没有正文、没有作者，采集侧按 `shouldCapture` 会把任何
     * 没有 `source.kind` 的事件判成 `unknown-author` 并以
     * `capture-denied:unknown-author` 记进采集侧的 skipped。而经验面的 observe
     * 只在**采集成功之后**被调用 —— 于是主信号可能一次都到不了这里，
     * 而 status() 里只有一个不涨的 `observed`，从外面看和"什么都没发生"一样。
     *
     * `observed`  = 宿主真的把 turn/end 送到过经验面几次（它≠triggers：后者是"凑够条件去产"）
     * `denied`    = 被采集侧以 `capture-denied:unknown-author` 挡回来的次数
     * `lastReason` = 最近一次被挡的原因（`null` 表示没被挡过）
     */
    turnEnd: { observed: 0, denied: 0, lastReason: null },
  }
  /** sessionId → { records: [], userText, failedTool, correction, lastEmittedRecordId, lastRecordId } */
  const buffers = new Map()
  const automatic = { mode: 'automatic', runs: 0, adopted: 0, outcomes: 0, deferred: {},
    lastAt: null, lastError: null, pending: true, nextRetryAt: null }

  function reconcileAutomatic(ids = null) {
    if (!enabled) return { ok: false, reason: 'disabled' }
    const deferred = {}
    const out = transactEpisodes(vaultDir, episodes => {
      const rows = []
      const adoptedKeys = new Map()
      for (const ep of episodes) {
        if (!['adopted', 'retired', 'revoked'].includes(ep.state)) continue
        const key = automaticMethodKey(ep), old = adoptedKeys.get(key)
        if (!old || ['revoked', 'retired'].includes(ep.state)) adoptedKeys.set(key, ep)
      }
      for (const current of episodes) {
        if (ids && !ids.includes(current.id)) continue
        if (!['raw-episode', 'candidate', 'trial'].includes(current.state)) continue
        const next = autoPromote(current, { adoptedKeys, at: clock() })
        if (next.ok) { rows.push(next.record); adoptedKeys.set(automaticMethodKey(next.record), next.record) }
        else deferred[next.reason] = (deferred[next.reason] ?? 0) + 1
      }
      return rows
    })
    automatic.runs += 1
    automatic.lastAt = clock()
    if (!ids) { automatic.deferred = deferred; automatic.pending = !out.ok }
    if (!out.ok) automatic.pending = true
    automatic.nextRetryAt = out.ok ? null : clock() + 30_000
    automatic.lastError = out.ok ? null : (out.error ?? out.reason)
    if (out.ok) { automatic.adopted += out.written; stats.promoted += out.written }
    else { stats.errors += 1; stats.lastError = 'automatic:' + automatic.lastError }
    return out
  }

  let feedbackStamp = null
  let feedbackMethods = new Map()
  function feedbackKey(projectId, environmentId, command) {
    return JSON.stringify([projectId, environmentId, command])
  }
  function matchesPair(ep, pair) {
    const m = ep.method
    return ep.state === 'adopted' && ep.projectId === pair.projectId &&
      m?.applicableEnv?.environmentId === pair.environmentId && m?.action?.command === pair.command &&
      (!m.action.tool || m.action.tool === pair.tool)
  }
  function refreshFeedbackMethods() {
    let st
    try { st = statSync(join(vaultDir, EPISODES_FILE), { bigint: true }) } catch (e) {
      if (e.code !== 'ENOENT') throw e
      feedbackStamp = null; feedbackMethods = new Map(); return
    }
    const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
    if (stamp === feedbackStamp) return
    const loaded = loadAll()
    if (loaded.bad) throw new Error('bad-episode-lines:' + loaded.bad)
    feedbackMethods = new Map()
    for (const ep of loaded.episodes) {
      if (ep.state !== 'adopted') continue
      const key = feedbackKey(ep.projectId, ep.method?.applicableEnv?.environmentId, ep.method?.action?.command)
      const bucket = feedbackMethods.get(key) ?? []
      bucket.push(ep); feedbackMethods.set(key, bucket)
    }
    feedbackStamp = stamp
  }

  function feedbackFromPairs(b) {
    const pairs = passingCallPairs(b.pairRecords, { includeFailed: true })
    const fresh = pairs.filter(p => !b.feedbackSeen?.has(p.resultRecordId))
    if (!fresh.length) return
    // Most commands have no reusable method. Avoid reparsing a 34 MB history for each one.
    refreshFeedbackMethods()
    const matching = fresh.filter(pair => pair.projectId && pair.environmentId &&
      (feedbackMethods.get(feedbackKey(pair.projectId, pair.environmentId, pair.command)) ?? [])
        .some(ep => matchesPair(ep, pair)))
    if (!matching.length) {
      b.feedbackSeen ??= new Set()
      for (const pair of fresh) b.feedbackSeen.add(pair.resultRecordId)
      return
    }
    const out = transactEpisodes(vaultDir, episodes => {
      const rows = []
      const latest = new Map(episodes.map(e => [e.id, e]))
      for (const pair of matching) {
        if (!pair.projectId || !pair.environmentId) continue
        for (const original of episodes) {
          const ep = latest.get(original.id)
          if (ep.state !== 'adopted') continue
          if (!matchesPair(ep, pair)) continue
          // Founding evidence and replays are not independent reuse samples.
          if ((ep.evidence ?? []).includes(pair.resultRecordId) || (ep.outcomes ?? []).some(o =>
            (o.evidence ?? []).includes(pair.resultRecordId))) continue
          const next = recordOutcome(ep, { result: pair.result, actor: 'automatic',
            evidence: [pair.callRecordId, pair.resultRecordId], at: clock() })
          if (next.ok) { rows.push(next.record); latest.set(ep.id, next.record) }
        }
      }
      return rows
    })
    if (out.ok) {
      b.feedbackSeen ??= new Set()
      for (const pair of fresh) b.feedbackSeen.add(pair.resultRecordId)
      automatic.outcomes += out.written
      stats.outcomes += out.written
    } else {
      automatic.lastError = out.error ?? out.reason
      stats.errors += 1
      stats.lastError = 'automatic-feedback:' + automatic.lastError
    }
  }

  // Existing backlog is evaluated once at startup; failed IO retries on a later event.
  reconcileAutomatic()


  /**
   * S2：验证通过的**池子** —— 归一化命令头 → { count, sessions, lastPair, emitted }。
   *
   * 为什么是**经验面级**而不是会话级：三道去重里有两道（重复 ≥2 次、跨 ≥2 会话）
   * 天生是跨会话的判据。放在会话缓冲区里，第二条同样的命令换个会话就永远凑不到 2，
   * 那个 24 与 3 在运行时就成了"永远达不到的数"。放在这一层，运行时的口径与
   * 重放脚本（planVerifiedActions）一致：同一个 head 只留一行，count 累加，
   * sessions 记来源会话，emitted 保证只落一次盘。
   *
   * 不是无界的：一个 head 一条，真仓满打满算 96 个键。
   */
  const verifiedPool = new Map()

  /** status() 里给出去的 verified-action 心跳（三个数都在，缺一个就说不清"为什么没产出"）。 */
  const verifiedStats = {
    pairsSeen: 0, poolSize: 0, emitted: 0, strong: 0,
    skippedBelowRepeat: 0, skippedBelowSessions: 0, lastHead: null,
  }

  const buf = (sessionId) => {
    const key = String(sessionId ?? 'unknown')
    let b = buffers.get(key)
    if (!b) {
      b = {
        records: [], userText: '', failedTool: null, correction: '',
        /** 宿主给不出 seq 时的顺序键（只用于"留最近一次"这个决定，不进任何身份摘要）。 */
        pairSeq: 0,
        /**
         * S1 游标：上一条已产 episode 的**最后一条记录 id**。
         * 原来用 `b.records.splice(0, len - maxBufferedRecords)` 切 64 条滚动窗口，
         * 结果同一批记录被 2,680 条 episode 反复切窗（证据并集只有 6,255 条）。
         * 游标之后，"已经当过一次证据"的记录不会再当第二次 —— 证据交集为空是**结构保证**，
         * 不是靠事后去重。
         */
        lastEmittedRecordId: null,
        /** 缓冲区里最后一条记录的 id。跳过时也要靠它推进游标（见 no-user-prose 闸门）。 */
        lastRecordId: null,
        /**
         * S2：本会话累计的**可配对记录**（带 source.toolCallId 的工具调用与结果）。
         *
         * 为什么单独一个数组而不是复用 b.records：
         *  - b.records 是**证据窗口**用的，会按 maxBufferedRecords 剪到 64 条；
         *    而 verified-action 恰恰不在这条窗口里（实测 96.7% 的通过绑定在窗口外），
         *    借用它会重现"自废 96%"那个错误。
         *  - 它只装 toolCallId 两侧的记录，形状与 passingCallPairs 的入参一致。
         * 上限比窗口宽得多：一次会话里同一条命令要通过 2 次才算"重复"，装太少就永远凑不够。
         */
        pairRecords: [],
      }
      buffers.set(key, b)
    }
    return b
  }
  const note = (reason) => {
    stats.skipped += 1
    stats.lastReason = reason
    const key = String(reason)
    stats.skippedByReason[key] = (stats.skippedByReason[key] ?? 0) + 1
  }

  /**
   * 发完就清掉粘滞信号（缺陷：真跑里同一句用户纠正被写成 91 条 episode）。
   *
   * `correction` / `failedTool` 是**一次性事件**，不是会话状态。原来它们一经置上
   * 就永远为真，而触发判定写的是 `else if (b.correction) → 产 episode`，
   * 于是该会话之后**每一条**事件都再产一条同名经验。
   * 一次纠正只值得一条经验；重复记录不是"更多证据"，是同一句话的副本。
   */
  const consumeSticky = (b) => {
    const used = { correction: b.correction, failedTool: b.failedTool }
    b.correction = ''
    b.failedTool = null
    return used
  }

  function reset(sessionId) {
    buffers.delete(String(sessionId ?? 'unknown'))
  }

  /**
   * 证据窗口：游标之后、最多 `EVIDENCE_CAP` 条，**含**触发记录本身。
   *
   * 三个细节都必须说清，否则"证据交集为空"只是一个巧合：
   *  1. 起点 = 上一条已产 episode 的最后一条记录**之后**（`lastEmittedRecordId` 找不到时
   *     退回缓冲区的头部 —— 缓冲区已经按 `maxBufferedRecords` 剪过，不会无限长）；
   *  2. 终点 = 触发记录（它已经在缓冲区里），不是"下一次触发之前"，否则一条 episode
   *     会把后面还没发生的事也吃掉；
   *  3. 上限取**最近** `EVIDENCE_CAP` 条（`.slice(-CAP)`）。取最早的 N 条会把触发点
   *     自己挤出去 —— 证据里没有"出事那一刻"，这条经验就没法回读了。
   */
  function evidenceWindow(b) {
    let start = 0
    if (b.lastEmittedRecordId) {
      const idx = b.records.findIndex((r) => r.id === b.lastEmittedRecordId)
      // 找不到说明它已经被 maxBufferedRecords 挤出缓冲区 —— 那就从头开始，
      // 反正缓冲区本身已经封顶，不会把整段历史重放一遍。
      if (idx >= 0) start = idx + 1
    }
    const tail = b.records.slice(start)
    return tail.length > EVIDENCE_CAP ? tail.slice(-EVIDENCE_CAP) : tail
  }

  /** 把游标推到缓冲区最后一条 —— 跳过时用它，保证「不产 episode」也不重放同一批记录。 */
  function advanceCursor(b) {
    if (b.lastRecordId) b.lastEmittedRecordId = b.lastRecordId
  }

  /**
   * S2：verified-action 的运行时出口。
   *
   * ── 它做什么 ────────────────────────────────────────────────────────
   *  1. 拿本会话攒下的 pairRecords 跑 `passingCallPairs`，得到"跑过并且过了"的对；
   *  2. 把每一对按**归一化命令头**放进经验面级的 verifiedPool（同一 head 一行，count 累加）；
   *  3. 只对"还没落过盘、且重复次数已达阈值"的 head 产 episode。
   *
   * ── 为什么阈值卡在 2 ────────────────────────────────────────────────
   * 一道实测事实：真仓 330 对通过里，96 种命令头有 72 种**只出现过一次**。
   * 一次性命令更可能是随手 tail 一个文件、sed 一段行，而不是"这台机器上已验证的做法"。
   * 要求重复 ≥2 次之后剩 24 条 —— 这就是本步默认入池的量。**不是 330。**
   *
   * ── "跨 ≥2 会话"为什么只打标记不入池条件 ────────────────────────────
   * 24 里只有 3 种跨会话。把它当入选条件会把默认产出压到 3 条，这一步就几乎没货；
   * 但它确实是更强的证据，所以标 strong 留给下游（面板/采纳）用。
   *
   * 返回：
   *   {ok:true, emitted:true, id, state, trigger:'verified-action', head, repeatCount, strong}
   *   {ok:true, emitted:false, ...}  —— 没有新的配对、或还没达到阈值
   *   {ok:false, reason}             —— 写盘失败（调用方会把它记进 errors 并原样返回）
   */
  function emitVerifiedAction(b, sessionId) {
    if (!b.pairRecords.length) return { ok: true, emitted: false, reason: 'no-pair-records' }

    // 只把**本批**新到的记录推进池子，避免每次事件都重扫整段会话历史（O(n²)）。
    // pairRecords 只增不减（超上限时从头部切），所以用长度差当增量游标。
    const start = b.pairScanned ?? 0
    const fresh = b.pairRecords.slice(start)
    b.pairScanned = b.pairRecords.length
    if (!fresh.length) return { ok: true, emitted: false, reason: 'no-fresh-pair-records' }

    // pairing 需要**整段历史**才配得齐（调用记录可能在上一批、结果在这一批），
    // 所以推断用全量、推进游标用增量。
    let pairs = []
    try {
      pairs = passingCallPairs(b.pairRecords)
    } catch (error) {
      verifiedStats.errors = (verifiedStats.errors ?? 0) + 1
      log?.warn?.(`verified-action 配对异常（已忽略）：${error?.message ?? error}`)
      return { ok: true, emitted: false, reason: 'pair-error' }
    }
    if (!pairs.length) return { ok: true, emitted: false, reason: 'no-passing-pairs' }

    // Identity belongs to each call pair, never to another session.
    /** 产出结果。**必须先声明**：return 语句用它，未声明会抛 —— 而 observe 的
     *  顶层 catch 会把异常记成 errors:1 并吞掉，看起来就像"这条触发从不产出"。 */
    let emittedAny = null
    for (const pair of pairs) {
      const head = pair.head
      if (!head) continue
      const scopeKey = JSON.stringify([pair.projectId, pair.environmentId, pair.tool, pair.command])
      let entry = verifiedPool.get(scopeKey)
      if (!entry) {
        entry = { head, count: 0, sessions: new Set(), callIds: new Set(), emitted: false, lastPair: null }
        verifiedPool.set(scopeKey, entry)
      }
      // 同一对（同一 callId）重复入池时 count 不该涨：一次通过算一次，不是每扫一遍算一次。
      // 用 callIds 而不是"跟 lastPair 比"——后者在 entry 刚建好的那一轮会把自己比掉。
      const pairKey = JSON.stringify([pair.sessionId, pair.callId])
      if (entry.callIds.has(pairKey)) continue
      entry.callIds.add(pairKey)
      entry.count += 1
      verifiedStats.pairsSeen += 1
      if (pair.sessionId) entry.sessions.add(String(pair.sessionId))
      // lastPair 始终指向**最近**一次通过（去重闸 1：同一归一化命令只留最近一次）。
      if (!entry.lastPair || pair.seq >= (entry.lastPair.seq ?? 0)) entry.lastPair = pair
      verifiedStats.lastHead = head
    }
    verifiedStats.poolSize = verifiedPool.size

    // 本轮要不要产：挑 count 已达标、还没落过盘的那些（一轮最多产一条，
    // 多出来的下一轮再产 —— 这样一次事件不会突然灌进几十条）。
    const ready = [...verifiedPool.values()]
      .filter((e) => !e.emitted && e.count >= VERIFIED_MIN_REPEATS)
      .sort((a, b2) => (b2.lastPair?.seq ?? 0) - (a.lastPair?.seq ?? 0))
    if (!ready.length) {
      // 有心跳才有诊断：池子里有货但都没到阈值 → 这个数长期不降说明阈值也许该复核，
      // 而不是"这条触发是死的"。
      verifiedStats.skippedBelowRepeat = [...verifiedPool.values()].filter((e) => e.count < VERIFIED_MIN_REPEATS).length
      return { ok: true, emitted: false, reason: 'below-repeat-threshold', poolSize: verifiedPool.size }
    }

    const pick = ready[0]
    const pair = pick.lastPair
    // 直接吃 pool 里的 pair，**不**把它拼回两条「记录」再解析一遍。
    // 拼装是有损往返：少写一层 JSON 外壳就会静默解析出 0 条，而且失败被
    // observe 的顶层 catch 吞掉，从外面看就是「这条触发从不产出」。
    // 环境身份：resolveProject 给的是会话级的，拿不到就先留 null，
    // 让 validateMethod 如实把它记成「环境不明 → 停在 raw-episode」（S3 之后再补逐动作的）。
    const methodWithPair = methodFromPair(pair, {
      projectId: pair.projectId ?? null,
      environmentId: pair.environmentId ?? null,
    })
    if (!methodWithPair) return { ok: true, emitted: false, reason: 'method-missing' }

    const built = verifiedEpisodeFromPair(methodWithPair, {
      coreId,
      projectId: pair.projectId ?? null,
      environmentId: pair.environmentId ?? null,
      repeatCount: pick.count,
      sessionCount: pick.sessions.size,
      strong: pick.sessions.size >= VERIFIED_MIN_SESSIONS,
      at: clock(),
    })
    if (!built.ok) return { ok: true, emitted: false, reason: `build:${built.reason}` }

    const accepted = acceptCandidate(built.record, { at: clock() })
    let record = accepted.ok ? accepted.record : built.record
    const written = appendEpisode(vaultDir, record)
    if (!written.ok) {
      // 写失败不回滚池子里的计数：这批记录确实过过，下一轮还能再产一次。
      stats.errors += 1
      stats.lastError = `episodes-write:${written.reason}`
      log?.warn?.(`verified-action 条目未写入（不影响其它功能）：${stats.lastError}`)
      return { ok: false, reason: written.reason }
    }
    reconcileAutomatic([record.id])
    record = loadAll().episodes.find(e => e.id === record.id) ?? record
    pick.emitted = true
    verifiedStats.emitted += 1
    if (pick.sessions.size >= VERIFIED_MIN_SESSIONS) verifiedStats.strong += 1
    verifiedStats.lastHead = pick.head
    stats.triggers += 1
    stats.byTrigger['verified-action'] = (stats.byTrigger['verified-action'] ?? 0) + 1
    stats.lastTrigger = 'verified-action'
    stats.emitted += 1
    stats.lastAt = record.updatedAt ?? record.createdAt ?? null
    if (!accepted.ok) stats.lastReason = `stay:${accepted.reason}`
    log?.info?.(`经验条目已记录（verified-action，${record.state}）：${record.id}`)
    emittedAny = {
      ok: true,
      emitted: true,
      trigger: 'verified-action',
      id: record.id,
      state: record.state,
      head: pick.head,
      repeatCount: pick.count,
      sessionCount: pick.sessions.size,
      strong: pick.sessions.size >= VERIFIED_MIN_SESSIONS,
      missing: accepted.ok ? [] : (accepted.missing ?? []),
      limits: methodWithPair.limits,
    }
    return emittedAny
  }

  /**
   * 宿主事件入口。**永不抛**：经验学习是副业，坏了不能连带记忆与对话。
   *
   * @param {object} session 宿主会话（取 id / header.cwd）
   * @param {string} hostType 原始事件类型（`turn/end` / `user/message` / `tool/result` …）
   * @param {object} adapterEvent 采集侧已归一化的事件（有 text/isError/toolName）
   * @param {object} captured `capture.handleSessionEvent` 的返回（有 id 才说明真落盘了）
   */
  function observe(session = null, hostType = '', adapterEvent = null, captured = null) {
    if (!enabled) { note('disabled'); return { ok: false, reason: 'disabled' } }
    stats.observed += 1
    /** S2：本次 observe 是否已经产出一条 verified-action（见 ②b 与 no-trigger 分支）。 */
    let lastVerifiedResult = null
    try {
      if (automatic.pending && clock() >= (automatic.nextRetryAt ?? 0)) reconcileAutomatic()
      const sessionId = String(session?.id ?? 'unknown')
      const b = buf(sessionId)

      // ⑦ 主信号 `turn/end` 的沉默必须能解释（第一半：到过几次 / 被拒几次）。
      //    宿主 `turn/end` 没有正文也没有作者 —— 采集侧 `shouldCapture` 对任何没有
      //    `source.kind` 的事件返回 `unknown-author`，于是它既不会落盘、也可能
      //    根本到不了这里。两种情况经验面都会**静默变成零产出**，而 status() 里
      //    只剩一个不涨的 observed，从外面看和"什么都没发生"一模一样。
      if (hostType === 'turn/end') stats.turnEnd.observed += 1
      // 只在 (*采集侧真的来拒过*) 时记账：`note()` 会推进 `skipped` 与 `lastReason`，
      // 而"宿主干脆没送 turn/end"和"送了但被挡"是两种沉默 —— 后者才算一道拒绝。
      // 没有 captured 的 turn/end 仍然算 observed（它到了经验面），只是没有被拒。
      if (captured && captured.ok !== true && captured.reason === 'capture-denied:unknown-author') {
        stats.turnEnd.denied += 1
        stats.turnEnd.lastReason = 'capture-denied:unknown-author'
      }

      // ① 正文证据：只认**真的落到仓里**的记录（captured.ok 且带 id）。
      //   没落盘的记录回读不到，写进证据列表就是死链。
      if (captured?.ok === true && typeof captured.id === 'string') {
        if (adapterEvent) {
          // 正文只留在**内存缓冲区**里，用于抽方法（action/limits/verification 全靠它）。
          // 落盘的 episode 只存记录 id —— 正文抄进经验会在下一次脱敏规则升级后
          // 变成两份不一致的副本，而 id 永远能回读到唯一那份（MC04）。
          // author 一并留在缓冲区：no-user-prose / direct-memory-write 两道闸门
          // 判的就是"窗口里有没有用户原话"，而正文里没有作者。
          const author = authorOf(adapterEvent)
          b.records.push({ id: captured.id, body: String(adapterEvent.text ?? ''), author })
          b.lastRecordId = captured.id
          // S2：带 toolCallId 的工具记录另存一份给 verified-action 配对用（理由见 pairRecords）。
          // 只收 tool 作者：用户/助手正文里的 "调用 xxx" 是散文，不是真的工具调用。
          const pairCallId = adapterEvent?.toolCallId
          if (typeof pairCallId === 'string' && pairCallId && author === 'tool') {
            const where = projectOf(session)
            b.pairRecords.push({
              projectId: where.projectId, environmentId: where.environmentId,
              id: captured.id,
              body: String(adapterEvent.text ?? ''),
              author,
              toolName: adapterEvent?.toolName ?? null,
              isError: adapterEvent?.isError === true,
              source: { toolCallId: pairCallId, sessionId },
              // 顺序键：宿主给得出 seq 就用它，否则用"进缓冲区的次序号"。
              // 去重闸 1 要"留最近一次"，没有顺序键那个决定就成了随机的。
              seq: Number.isInteger(adapterEvent?.seq) ? adapterEvent.seq : (b.pairSeq += 1),
            })
            if (b.pairRecords.length > maxPairRecords) {
              const removed = b.pairRecords.length - maxPairRecords
              b.pairRecords.splice(0, removed)
              b.pairScanned = Math.max(0, (b.pairScanned ?? 0) - removed)
            }
          }
          if (b.records.length > maxBufferedRecords) b.records.splice(0, b.records.length - maxBufferedRecords)
          // 用户原话用来写摘要：经验的"为什么"几乎总在用户那句纠正里。
          if (author === 'user') b.userText = oneLine(adapterEvent.text, 300)
          // S1 作者门 + S9.1 内容级排除：纠正只认「用户说的、且不是在谈我们自己」。
          // 原来的 `CORRECTION_RE.test(...)` 对**任何作者**都成立 —— 真仓 453 条命中里
          // tool 383 / assistant 65，于是工具回显里一句「不对」就把整段日志判成用户纠正。
          // 正则一个字没改，改的是"谁说的算 + 说的是不是我们自己的代码"。
          const verdict = correctionVerdict(adapterEvent.text, author)
          if (verdict.correction) {
            b.correction = oneLine(adapterEvent.text, 300)
          } else if (verdict.reason === 'self-reference') {
            // 命中正则、作者也是用户，但正文在谈 Laurel 自己 → 记数，不产经验。
            // 记数而不是静默：这个数长期偏高就说明采集侧又在灌我们的排查对话。
            stats.selfReferenceSkipped += 1
          }
          if (looksFailed(adapterEvent)) {
            b.failedTool = { tool: adapterEvent?.toolName ?? null, text: String(adapterEvent?.text ?? '') }
          }
        }
      }

      // ②b S2：verified-action **先于**窗口三条触发判定，且与它们并列、不共用窗口。
      //
      //    为什么排在前面：配对是"调用 + 结果两条都到了"才成立的，它一到就说明
      //    "这件事已经做完并且过了"。让它先落盘，窗口那三条（纠正/失败/turn-end）
      //    才不会把这一对拆开当证据用。两条路互不消费：本分支产完 episode 后**接着**
      //    走窗口判定，因为同一条事件里可能还带着一次用户纠正（那是另一条经验）。
      //
      //    开关关闭时这一步整体跳过，行为回到 S1 的三条触发集。
      if (USE_VERIFIED_ACTION_TRIGGER) {
        feedbackFromPairs(b)
        const va = emitVerifiedAction(b, sessionId)
        if (va?.ok === true && va.emitted === true) {
          // 落盘成功：把"这条事件已经产过一条经验"这件事带走，但**不 return** ——
          // 同一事件仍可能触发窗口那条（见上）。
          lastVerifiedResult = va
        } else if (va?.ok === false) {
          return va
        }
      }

      // ② 触发判定。`turn/end` 是主信号；纠正/失败是即时信号（不等 turn 结束，
      //    因为事故现场就在那一刻，等到后面几轮参数已经被覆盖了）。
      let trigger = null
      if (hostType === 'turn/end') trigger = 'turn-end'
      else if (b.correction) trigger = 'correction'
      else if (b.failedTool) trigger = 'tool-failure'
      if (!trigger) {
        // 「没有触发信号」不是「跳过」—— 它只是这一条事件与经验无关。
        // 基线口径（改动前）同样不计数，所以这里只进 skippedByReason 供观测，
        // **不涨 stats.skipped**：否则每一条 user/message 都会把 skipped 推高，
        // 那个数就不再等于「有意跳过多少次」。
        const key = 'no-trigger'
        stats.skippedByReason[key] = (stats.skippedByReason[key] ?? 0) + 1
        // S2：这一条事件本身没有窗口触发，但它可能刚刚产出了一条 verified-action。
        // 那个结果必须**带出去**，否则调用方看到 emitted:false 会以为什么都没发生。
        if (lastVerifiedResult) {
          const carried = lastVerifiedResult
          lastVerifiedResult = null
          return { ...carried, trigger: 'verified-action', windowTrigger: null }
        }
        return { ok: true, emitted: false, reason: 'no-trigger' }
      }

      stats.triggers += 1
      stats.byTrigger[trigger] = (stats.byTrigger[trigger] ?? 0) + 1
      stats.lastTrigger = trigger

      // ② 证据窗口：游标之后、上限 EVIDENCE_CAP 条（含触发记录）。
      //    从这里开始不再用 b.records 全量 —— 那是"滚动窗口"，会把同一批记录
      //    反复切成不同的 episode（真仓 2,680 条的成因之一）。
      const windowRecords = evidenceWindow(b)

      if (windowRecords.length < minRecordsPerEpisode) {
        // 证据太少不产经验：一条记录凑不出"方法"，产出来必然停在 raw-episode，
        // 而 raw-episode 又不会被检索到 —— 那就只是给磁盘加垃圾。
        if (hostType === 'turn/end') reset(sessionId)
        // 跳过时把游标推到缓冲区末尾：这批记录已经"看过"了，不该在下一轮再被当成新证据。
        advanceCursor(b)
        note(`too-few-records:${windowRecords.length}`)
        return { ok: true, emitted: false, reason: 'too-few-records', count: windowRecords.length }
      }

      // ②b direct-memory-write 闸门（Laurel 口径）：窗口里**全是**工具记录 → 不产。
      //     为什么这不是"证据不足"：工具单独的动作序列没有"为什么"，抽不出方法，
      //     落了盘也永远停在 raw-episode。区别在于**游标要挪**——这批记录已经被
      //     排除过，留着只会让下一次触发把同一批又切一遍。
      if (windowRecords.every((r) => r.author === 'tool')) {
        advanceCursor(b)
        note('direct-memory-write')
        return { ok: true, emitted: false, reason: 'direct-memory-write' }
      }

      // ②c no-user-prose 闸门：窗口里没有任何**用户原话** → 不产，但**不挪游标**。
      //     两条跳过路径对游标的处理刻意不同：
      //       - 全 tool：这批记录永远不可能是证据 → 挪过去；
      //       - 没有用户原话：这批记录只要再来一条用户原话就**能**当证据
      //         （实测差这一步：挪游标 45 条，不挪 45 条但证据 p50 从 43 掉到 33，
      //         "不挪"多保留的是紧邻触发点的上下文，也就是事故现场本身）。
      //     不挪的代价：下次触发会再扫一遍这批 —— 但它产不出 episode，
      //     所以不会变成重复证据；游标只在**真的产出**或**永久不可用**时才前进。
      if (!windowRecords.some((r) => r.author === 'user')) {
        note('no-user-prose')
        return { ok: true, emitted: false, reason: 'no-user-prose' }
      }

      const where = projectOf(session)
      // 先把粘滞信号取走并清空，再构造 episode —— 顺序反了的话，
      // 构造过程里抛错会让信号永远留在缓冲区里，下一轮继续产。
      const sticky = (trigger === 'correction' || trigger === 'tool-failure')
        ? consumeSticky(b)
        : { correction: b.correction, failedTool: b.failedTool }
      const built = episodeFromEvidence({
        trigger,
        records: windowRecords,
        userText: sticky.correction || b.userText,
        failedTool: sticky.failedTool,
        coreId,
        projectId: where.projectId,
        environmentId: where.environmentId,
        sessionId: hostType === 'turn/end' ? null : sessionId,
        at: clock(),
      })
      if (!built.ok) { note(`build:${built.reason}`); return { ok: true, emitted: false, reason: built.reason } }

      // ②d 查重：同 projectId + 同 summary 的未撤销条目已经存在 → **不新增条目**。
      //     `findSimilar` 一直定义在下面却零调用 —— 于是"每轮 turn/end 都产一条同义经验"
      //     这件事压根没被挡。接上它之后，命中时的动作是「只更新证据」：
      //     同一句话的第二批记录是**更多证据**，不是另一条经验，所以写的是同一条目的
      //     更高 revision（证据并集，仍受 EVIDENCE_CAP 封顶），而不是第二行。
      //     为什么要留这个分支而不是直接 return：证据丢了这条经验就再也不能回读
      //     它凭什么成立；而"再加一条同义条目"会让同一个结论在检索里占多个位置。
      const existing = findSimilar(loadAll().episodes, built.record)
      if (existing) {
        const merged = [...new Set([...(existing.evidence ?? []), ...built.record.evidence])]
        const refreshMethod = ['raw-episode', 'candidate', 'trial'].includes(existing.state) &&
          built.record.method?.verification?.result === 'passed'
        const updated = {
          ...existing,
          ...(refreshMethod ? { method: built.record.method,
            contentVersion: contentHash({ method: built.record.method, summary: existing.summary }),
            methodOk: built.record.methodOk, methodMissing: built.record.methodMissing,
            methodProblems: built.record.methodProblems } : {}),
          // 只留最近 EVIDENCE_CAP 条：并集无限长的话，这条经验的证据会随轮次线性膨胀，
          // 变成"什么都是它的证据" —— 那等于没有证据。
          evidence: merged.slice(-EVIDENCE_CAP),
          evidenceMergedAt: clock(),
          revision: (existing.revision ?? 1) + 1,
          updatedAt: clock(),
        }
        const mergedWritten = appendEpisode(vaultDir, updated)
        if (!mergedWritten.ok) {
          if (sticky.correction) b.correction = sticky.correction
          if (sticky.failedTool) b.failedTool = sticky.failedTool
          stats.errors += 1
          stats.lastError = `episodes-write:${mergedWritten.reason}`
          log?.warn?.(`经验证据合并未写入（不影响其它功能）：${stats.lastError}`)
          return { ok: false, reason: mergedWritten.reason }
        }
        reconcileAutomatic([updated.id])
        stats.deduped += 1
        stats.lastReason = 'duplicate-summary'
        // 这批记录已经归给那条经验了，游标必须跟着走 —— 否则下一次触发会把同一批再切一遍。
        const lastMerged = windowRecords[windowRecords.length - 1]?.id
        if (typeof lastMerged === 'string' && lastMerged) b.lastEmittedRecordId = lastMerged
        if (hostType === 'turn/end') reset(sessionId)
        return {
          ok: true, emitted: true, deduped: true, id: existing.id, state: existing.state, trigger,
        }
      }

      // ③ 升到 candidate（方法齐备才升），然后落盘。两步都要落盘：
      //    哪怕停在 raw-episode 也必须写出去 —— 否则"缺方法"这件事没有任何痕迹。
      const accepted = acceptCandidate(built.record, { at: clock() })
      let record = accepted.ok ? accepted.record : built.record
      const written = appendEpisode(vaultDir, record)
      if (!written.ok) {
        // 写盘失败 → 把刚取走的粘滞信号放回去：一次瞬时 IO 故障不该让
        // 用户那句纠正彻底消失（下一轮还能再产一次）。
        if (sticky.correction) b.correction = sticky.correction
        if (sticky.failedTool) b.failedTool = sticky.failedTool
        stats.errors += 1
        stats.lastError = `episodes-write:${written.reason}`
        log?.warn?.(`经验条目未写入（不影响其它功能）：${stats.lastError}`)
        return { ok: false, reason: written.reason }
      }
      reconcileAutomatic([record.id])
      record = loadAll().episodes.find(e => e.id === record.id) ?? record
      stats.emitted += 1
      // 游标推进到**这条 episode 的最后一条证据**：它之前的记录已经属于这条经验，
      // 下一条 episode 只能从它之后长出来 —— 这就是"任意两条证据交集为空"的结构保证。
      const lastEvidenceId = windowRecords[windowRecords.length - 1]?.id
      if (typeof lastEvidenceId === 'string' && lastEvidenceId) b.lastEmittedRecordId = lastEvidenceId
      stats.lastAt = record.updatedAt ?? record.createdAt ?? null
      if (!accepted.ok) stats.lastReason = `stay:${accepted.reason}`
      if (hostType === 'turn/end') reset(sessionId)
      log?.info?.(`经验条目已记录（${trigger}，${record.state}）：${record.id}`)
      return {
        ok: true, emitted: true, id: record.id, state: record.state, trigger,
        missing: accepted.ok ? [] : (accepted.missing ?? []),
      }
    } catch (error) {
      stats.errors += 1
      stats.lastError = String(error?.message ?? error)
      log?.warn?.(`经验学习异常（已忽略）：${stats.lastError}`)
      return { ok: false, reason: 'error' }
    }
  }

  /**
   * 会话 → `{projectId, environmentId}`。**每次都现算**（session 变了就要变），
   * 且与采集侧用同一个 `projectIdentityOf`（由 index.js 注入，见 resolveProject）。
   *
   * 为什么必须带 environmentId：`experience/method.mjs` 的 `validateMethod`
   * 有一条硬规则「applicableEnv 缺 environmentId（环境不明不能晋升）」。
   * 同一条命令在 WSL 与 Windows 上结果可能不同，环境不明就不该被当成
   * 已验证做法推荐出去。所以这里不能只取 projectId。
   */
  function projectOf(session) {
    if (typeof resolveProject !== 'function') return { projectId: null, environmentId: null }
    try {
      const value = resolveProject(session)
      if (typeof value === 'string' && value) return { projectId: value, environmentId: null }
      if (value && typeof value === 'object') {
        return {
          projectId: typeof value.projectId === 'string' && value.projectId ? value.projectId : null,
          environmentId: typeof value.environmentId === 'string' && value.environmentId ? value.environmentId : null,
        }
      }
      return { projectId: null, environmentId: null }
    } catch { return { projectId: null, environmentId: null } }
  }

  function loadAll() {
    const loaded = loadEpisodes(vaultDir)
    return loaded
  }

  /** 幂等：同 title/scope 已存在就不重复写（避免每轮 turn/end 都产一条同义经验）。 */
  function findSimilar(episodes, record) {
    return episodes.find((e) => e.id !== record.id
      && e.projectId === record.projectId
      && e.state !== 'revoked'
      && String(e.summary ?? '') === String(record.summary ?? '')) ?? null
  }

  function list({ includeAll = true } = {}) {
    const { episodes, bad, exists } = loadAll()
    return {
      ok: true,
      exists,
      bad,
      total: episodes.length,
      byState: episodes.reduce((a, e) => { const s = e?.state ?? 'unknown'; a[s] = (a[s] ?? 0) + 1; return a }, {}),
      episodes: includeAll ? episodes : episodes.filter(usableForRecommendation),
    }
  }

  /** 人工采纳（`actor` 必须写明是谁说的 —— 生命周期靠这个字段区分点击与验证）。 */
  function adopt(id, { actor = 'human', summary, at = clock() } = {}) {
    if (!enabled) return { ok: false, reason: 'disabled' }
    try {
      const { episodes } = loadAll()
      const current = episodes.find((e) => e.id === id)
      if (!current) return { ok: false, reason: 'not-found', id }
      if (current.state === 'adopted') return { ok: true, record: current, skill: projectSkill(current, { at }), unchanged: true }
      const next = promote(current, { summary, actor, candidates: episodes, at })
      if (!next.ok) {
        // 晋升门拒了但要让人知道**下一步怎么做**，否则「采纳」这个按钮等于坏的。
        // 最常见的是 `summary-incomplete`：自动摘要照抄了用户原话，里面带
        // 「前提是先备份…」这类条件句而没有对应验证结果，门会判未闭合。
        // 这不是 bug —— 那条规则防的是"把带前提的做法当无条件结论推荐出去"。
        if (next.reason === 'summary-incomplete') {
          return {
            ...next,
            hint: '采纳需要一段写明验证结果的摘要（同一句里既有做法又有验证，条件句也要说清是否已验证）。'
              + '自动摘要是照抄原文，通常不带验证结果，所以过不了这道门 —— 这是有意的。',
            currentSummary: current.summary,
            canRetryWithSummary: true,
          }
        }
        return next
      }
      const written = appendEpisode(vaultDir, next.record)
      if (!written.ok) return { ok: false, reason: written.reason }
      stats.promoted += 1
      return { ok: true, record: next.record, skill: projectSkill(next.record, { at }) }
    } catch (error) {
      stats.errors += 1
      stats.lastError = String(error?.message ?? error)
      return { ok: false, reason: 'error', error: stats.lastError }
    }
  }

  /** 真实复用结果。**采纳不等于验证**：这个入口是唯一能抬可信度的地方。 */
  function outcome(id, { result, evidence = [], actor = 'human', at = clock() } = {}) {
    if (!enabled) return { ok: false, reason: 'disabled' }
    try {
      const { episodes } = loadAll()
      const current = episodes.find((e) => e.id === id)
      if (!current) return { ok: false, reason: 'not-found', id }
      const next = recordOutcome(current, { result, evidence, actor, at })
      if (!next.ok) return next
      const written = appendEpisode(vaultDir, next.record)
      if (!written.ok) return { ok: false, reason: written.reason }
      stats.outcomes += 1
      return { ok: true, record: next.record, confidence: confidenceOf(next.record) }
    } catch (error) {
      stats.errors += 1
      stats.lastError = String(error?.message ?? error)
      return { ok: false, reason: 'error', error: stats.lastError }
    }
  }

  function bad(id, { why, at = clock() } = {}) {
    if (!enabled) return { ok: false, reason: 'disabled' }
    try {
      const { episodes } = loadAll()
      const current = episodes.find((e) => e.id === id)
      if (!current) return { ok: false, reason: 'not-found', id }
      const next = revoke(current, { reason: why, at })
      if (!next.ok) return next
      const written = appendEpisode(vaultDir, next.record)
      if (!written.ok) return { ok: false, reason: written.reason }
      stats.revoked += 1
      return { ok: true, record: next.record }
    } catch (error) {
      stats.errors += 1
      stats.lastError = String(error?.message ?? error)
      return { ok: false, reason: 'error', error: stats.lastError }
    }
  }

  function demote(id, { why, at = clock() } = {}) {
    if (!enabled) return { ok: false, reason: 'disabled' }
    const { episodes } = loadAll()
    const current = episodes.find((e) => e.id === id)
    if (!current) return { ok: false, reason: 'not-found', id }
    const next = retire(current, { reason: why, at })
    if (!next.ok) return next
    const written = appendEpisode(vaultDir, next.record)
    if (!written.ok) return { ok: false, reason: written.reason }
    return { ok: true, record: next.record }
  }

  /**
   * Skill 绑定与失效：投影成手册，并**同时**回读当前经验版本做一致性检查。
   * 只投影不给校验是没有意义的 —— 悬空 Skill 会继续按旧版本注入。
   */
  function skill(id, { at = clock() } = {}) {
    const { episodes } = loadAll()
    const current = episodes.find((e) => e.id === id)
    if (!current) return { ok: false, reason: 'not-found', id }
    const built = projectSkill(current, { at })
    if (!built.ok) return built
    const check = validateSkillBinding(built.skill, current)
    return { ok: true, skill: built.skill, id: built.skill.id, binding: check }
  }

  function status() {
    return {
      automation: { ...automatic, deferred: { ...automatic.deferred } },
      enabled: !!enabled,
      vaultDir: vaultDir ?? null,
      states: STATES.length,
      // 种类表叫 triggerKinds：`...stats` 里的 `triggers` 是**计数**，
      // 两个语义同名会互相覆盖（第一版就这么错了，测试断言深比较时暴露）。
      triggerKinds: [...TRIGGERS],
      buffered: buffers.size,
      minRecordsPerEpisode,
      evidenceCap: EVIDENCE_CAP,
      // S2 心跳：这条触发是"顺境"的唯一入口，它哑掉时从外面看和"今天没跑命令"一样，
      // 所以池子大小、已产条数、strong 条数、最近一条命令头都必须可见。
      verifiedAction: {
        enabled: !!USE_VERIFIED_ACTION_TRIGGER,
        minRepeats: VERIFIED_MIN_REPEATS,
        minSessions: VERIFIED_MIN_SESSIONS,
        poolSize: verifiedPool.size,
        emitted: verifiedStats.emitted,
        strong: verifiedStats.strong,
        pairsSeen: verifiedStats.pairsSeen,
        belowRepeat: [...verifiedPool.values()].filter((e) => e.count < VERIFIED_MIN_REPEATS).length,
        lastHead: verifiedStats.lastHead,
        errors: verifiedStats.errors ?? 0,
      },
      ...stats,
      byTrigger: { ...stats.byTrigger },
      // 拷贝一份：调用方拿到的快照不该因为之后又跳过一次而变（深比较断言会踩这个坑）。
      skippedByReason: { ...stats.skippedByReason },
      file: vaultDir ? join(vaultDir, EPISODES_FILE) : null,
      fileExists: vaultDir ? existsSync(join(vaultDir, EPISODES_FILE)) : false,
    }
  }

  return {
    observe,
    reconcileAutomatic,
    acceptCandidate,
    adopt,
    outcome,
    revoke: bad,
    retire: demote,
    skill,
    list,
    status,
    reset,
    /**
     * 固定 projectId（CLI / 迁移脚本场景：没有 session 可推）。
     * 宿主路径用构造参数 `resolveProject`，那条路按会话现算。
     */
    setProject(projectId, environmentId = null) {
      const fixed = projectId ?? null
      // eslint-disable-next-line no-param-reassign
      resolveProject = fixed ? () => ({ projectId: fixed, environmentId }) : null
    },
    /** 想从外面覆盖的话必须显式——否则「谁在用哪个身份」说不清。 */
    readonly: true,
    skillIdOf: (record) => skillId(record),
  }
}
