/**
 * laurel-memory/projection —— MC10：经验与记录走**同一个查询投影**。
 *
 * ── 这个文件为什么存在（缺陷 MC10，2026-10-22）───────────────────────────
 * 仓里有两套内容、一个检索入口：
 *   memory/records.jsonl     事实与日常工作（preference/requirement/fact/progress/log/experience）
 *   experience/episodes.jsonl 经验生命周期条目（raw-episode→candidate→trial→adopted→…）
 *
 * 但 `executeMemoryQuery()` 只读前者。`grep -rn episodes` 在 `capture.mjs` 里
 * 零命中，唯一写盘点在 `lib/cli.mjs` 的 `import-forge` —— 也就是说：
 * **实时采集从不产 episode，查询也从不看 episode**。真仓 `experience/` 目录
 * 至今不存在（`cli export` 报 `episodes:0` 就是因为这个）。
 *
 * 手册 MC10 的修法原文：「统一记录/证据模型的查询投影；经验按状态筛选」。
 * 所以这里不新建第二套检索，而是把 episode **投影成与 record 同形的行**，
 * 交给同一个 `search()` —— 一套打分、一套预算、一套过滤。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *  1. **状态过滤在打分之前**（与 `searchMemory` 同一条纪律）。`revoked` 终态
 *     永不出现；`retired` 也不出现在默认检索里；`candidate`/`trial` 默认不出现
 *     （尚未验证的经验不该被当成结论注入），要看必须显式 `includeCandidates`。
 *  2. **不猜身份**：episode 缺 projectId 就保持 null，不改写成仓的 projectId。
 *  3. **投影不是拷贝**：`x-…` 的 id 原样保留，输出里标 `[经验]`，
 *     回读走同一套分页，用户不必知道它和记录存在不同文件里。
 *  4. 坏行计数**必须带出去**，与 records 同样的理由：静默丢行会让人对
 *     "查过了，没有" 产生错误信心。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { search as textSearch } from '../../laurel-core/lib/textindex.mjs'
import { usableForRecommendation } from './experience/lifecycle.mjs'
import { isSelfEchoRecord } from './adapter-dsh.mjs'

/** 经验条目落盘位置。与 `lib/cli.mjs` 的 `join(dir,'experience','episodes.jsonl')` 必须一致。 */
export const EPISODES_FILE = 'experience/episodes.jsonl'

/** 生命周期状态（`experience/lifecycle.mjs` 的 STATES，这里写死一份是**故意的**：
 *  投影层不该 import 生命周期层，否则两个模块互相依赖。两处不一致由测试锁死。） */
export const EPISODE_STATES = Object.freeze(['raw-episode', 'candidate', 'trial', 'adopted', 'retired', 'revoked'])

/**
 * 读经验条目。同一 id 多版本只取 revision 最高的（与 `loadRecords` 同一口径）。
 * 读不到文件返回空集而不是抛 —— 「还没有任何经验」是正常状态。
 */
export function loadEpisodes(vaultDir) {
  const file = vaultDir ? join(vaultDir, EPISODES_FILE) : null
  if (!file || !existsSync(file)) return { episodes: [], bad: 0, exists: false, file }
  const byId = new Map()
  let bad = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let ep
    try { ep = JSON.parse(line) } catch { bad += 1; continue }
    if (!ep || typeof ep.id !== 'string') { bad += 1; continue }
    const prev = byId.get(ep.id)
    if (!prev || (ep.revision ?? 1) >= (prev.revision ?? 1)) byId.set(ep.id, ep)
  }
  return { episodes: [...byId.values()], bad, exists: true, file }
}

/**
 * 经验正文：把 `summary` 与方法骨架拼成可检索文本。
 *
 * 为什么不只搜 `summary`：经验的价值在**操作**（命令/工具）与**限制**上。
 * 用户来问「上次那个 pnpm 命令怎么写的」，答案只存在于 `method.action`，
 * 不在 summary 里。把两者拼进投影正文，一套 BM25 就都能命中。
 */
export function episodeBody(ep) {
  const m = ep?.method ?? null
  const parts = []
  if (ep?.adoption?.kind === 'automatic') parts.push(ep.adoption.evidenceKind === 'tool-result'
    ? '依据：工具执行记录；采纳不代表在当前任务中已执行。'
    : '依据：历史原文自述；尚不能据此宣称当前任务验证成功。')
  const env = m?.applicableEnv
  if (env && (env.projectId || env.environmentId)) {
    parts.push(`环境：${[env.projectId, env.environmentId, env.shell].filter(Boolean).join(' / ')}`)
  }
  if (Array.isArray(m?.limits) && m.limits.length) parts.push(`限制：${m.limits.join('；')}`)
  const action = m?.action
  if (action) {
    const cmd = [action.tool, action.command, ...(Array.isArray(action.args) ? action.args : [])]
      .filter((x) => typeof x === 'string' && x)
      .join(' ')
    if (cmd) parts.push(`操作：${cmd}`)
  }
  if (m?.verification?.how) parts.push(`验证：${m.verification.how}（${m.verification.result ?? 'unknown'}）`)
  parts.push(String(ep?.summary ?? ''))
  return parts.filter((x) => x && x.trim()).join('\n')
}

/** 状态 → 是否参与默认检索。撤销是终态，任何情况都不参与。 */
export function episodeSearchable(ep, { includeCandidates = false, states = null } = {}) {
  const st = ep?.state ?? 'candidate'
  if (st === 'revoked') return false
  if (states && Array.isArray(states) && states.length) return states.includes(st)
  if (st === 'retired') return false
  if (st === 'adopted') return usableForRecommendation(ep)
  if (st === 'trial') return includeCandidates
  return includeCandidates          // candidate / raw-episode / 未知状态
}

/**
 * 投影成 record 同形。`kind` 用 `'experience'`（六种 record kind 里已有这个名字），
 * `status` 搬生命周期状态 —— 下游不需要知道两个文件的存在。
 */
export function episodeToRow(ep) {
  const st = ep?.state ?? 'candidate'
  return {
    id: ep?.id ?? null,
    kind: 'experience',
    title: typeof ep?.summary === 'string' ? ep.summary.slice(0, 60) : null,
    body: episodeBody(ep),
    status: st,
    episodeState: st,
    projectId: ep?.projectId ?? null,
    environmentId: ep?.environmentId ?? null,
    revision: Number.isFinite(ep?.revision) ? ep.revision : 1,
    // 故意不透传 `ep.contentVersion`：`laurel-core/lib/textindex.mjs:153` 的
    // `dedupKey(r)` 是 `r.bodyHash ?? r.contentVersion ?? 正文`，把 `contentVersion`
    // 当**内容身份**用（同内容多份落盘只留一条）。但经验里的 `contentVersion` 是
    // 生命周期版本号，不是正文哈希 —— 两条摘要完全不同的经验常常是同一次
    // import 写进来的、`contentVersion` 都是 `cv-1`，透传过去就会被索引层
    // 折叠成一条，看起来像「候选经验没参与检索」，实际是去重键撞了。
    // 经验正文已经是 `episodeBody()` 拼出的可检索文本，没有第二份副本要折叠，
    // 所以这里给 null，让去重键回落到正文本身。
    contentVersion: null,
    author: ep?.adoption?.by ?? null,
    createdAt: ep?.adoption?.at ?? null,
    source: 'episode',
    indexable: st !== 'revoked',
  }
}

/**
 * 统一检索：records 与 episodes 各投影一份，交给同一个 `search()`。
 *
 * 返回体保留 `hits`（`{record, score, coverage}` 形状不变，`record.source`
 * 区分来源）与两个池规模，方便调用方如实报告「可检索 N 条记录 + M 条经验」。
 */
export function searchProjection(records, episodes, query, opts = {}) {
  // S6：`searchProjection` 是统一投影层，被 capture.mjs 与经验侧共用。
  // 自回显的过滤放在这一层更靠得住 —— 调用方换了也不会漏掉那道闸。
  // 但**不能只放这一层**：capture.mjs 的 searchText 报的池规模要跟检索真用的一致，
  // 所以两边用同一个 isSelfEchoRecord（依赖方向是 projection → adapter，与
  // memory/index.mjs 已经 import adapter 的既有形状一致，不新造反向依赖）。
  const rowsOfRecords = (Array.isArray(records) ? records : [])
    .filter((r) => r && r.indexable !== false && r.status !== 'revoked' && r.status !== 'retired' && !isSelfEchoRecord(r))
  const rowsOfEpisodes = (Array.isArray(episodes) ? episodes : [])
    .filter((ep) => episodeSearchable(ep, opts))
    .map(episodeToRow)
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.trunc(opts.limit)) : 5
  const found = textSearch([...rowsOfRecords, ...rowsOfEpisodes], query, {
    ...opts,
    limit,
    // 状态过滤已在上面做过，这里不再传 filter，避免两处判据漂移。
    filter: undefined,
  })
  return {
    ...found,
    recordPool: rowsOfRecords.length,
    episodePool: rowsOfEpisodes.length,
    poolSize: rowsOfRecords.length + rowsOfEpisodes.length,
  }
}

/** 一条经验的完整视图（供 `id` 直读）。 */
export function describeEpisode(ep) {
  const m = ep?.method ?? null
  const lines = [
    `经验 ${ep.id}（${ep.state}）`,
    `摘要：${ep.summary || '(空)'}`,
  ]
  if (m?.applicableEnv) {
    const env = m.applicableEnv
    lines.push(`适用环境：${[env.projectId, env.environmentId, env.os, env.shell].filter(Boolean).join(' / ') || '(不明)'}`)
  }
  if (m?.action) {
    const a = m.action
    const cmd = [a.tool, a.command, ...(Array.isArray(a.args) ? a.args : [])].filter(Boolean).join(' ')
    if (cmd) lines.push(`操作：${cmd}`)
  }
  if (Array.isArray(m?.limits) && m.limits.length) lines.push(`限制：${m.limits.join('；')}`)
  if (m?.verification) lines.push(`验证：${m.verification.how ?? '(未写办法)'} → ${m.verification.result ?? 'unknown'}`)
  const outcomes = Array.isArray(ep?.outcomes) ? ep.outcomes : []
  if (outcomes.length) {
    lines.push(`复用结果：${outcomes.map((o) => o.result).join(', ')}（${outcomes.length} 次）`)
  } else {
    // 采纳不等于验证，这里必须说出来，否则用户会把「已采纳」当成「已验证」
    lines.push('复用结果：无（采纳本身不算验证）')
  }
  if (ep?.methodOk === false) lines.push(`方法缺项：${(ep.methodMissing ?? []).join(', ') || '(未知)'} —— 不可按此经验执行`)
  return lines.join('\n')
}
