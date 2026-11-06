/**
 * laurel-memory/importer —— 旧数据只读导入（S04）。
 *
 * 旧格式（实测，2026-10-18）：
 *   ~/.dsh/strata/memories.jsonl   每行 {v,at,op,id,record?}
 *                                  op ∈ put/use/edit/forget/supersede
 *                                  record: {id,body,kind,scope,workspace,sessionId,tags,entities,links,salience,confidence,createdAt,updatedAt,supersededBy,quote,origin}
 *   ~/.dsh/forge/data/observations.jsonl  每行 {id,at,sessionId,turn,step,callId,tool,verdict,reason,exitCode,errorCode,signature,head,args,...}
 *   ~/.dsh/forge/injections.jsonl         每行注入回执
 *
 * 纪律：
 *  1. **只读**旧文件，不改不删；导入的是隔离的新仓。
 *  2. 保留 ID 映射（旧 id → 新 id），保留候选/正式/撤销状态，不改变资格。
 *  3. 重复导入幂等（同旧 id + 同内容版本不重复写）。
 *  4. 冲突只列出，不自动合并。
 *  5. 读失败 ≠ 0 条：解析坏行要计数并报告，不能静默返回空。
 */
import { existsSync, readFileSync } from 'node:fs'
import { contentHash, deriveRecordId } from '../../laurel-core/lib/format.mjs'

/** 逐行解析 JSONL，坏行计数但不隐藏。 */
export function parseJsonl(text) {
  const items = []
  const bad = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try { items.push({ line: i + 1, value: JSON.parse(line) }) } catch {
      bad.push({ line: i + 1, preview: line.slice(0, 120) })
    }
  }
  return { items, bad, totalLines: lines.length }
}

/**
 * 把 Strata 的 append-only 事件流折叠成当前状态。
 * 同一个 id 可能有多条事件（put/use/edit/forget/supersede），后者覆盖前者。
 */
export function foldStrataEvents(parsed) {
  const byId = new Map()
  const unknownOps = new Map()
  for (const { line, value: ev } of parsed.items) {
    const id = ev.id
    if (!id) continue
    const op = ev.op ?? 'put'
    if (!byId.has(id)) byId.set(id, { id, ops: [], current: null, firstAt: ev.at, lastAt: ev.at })
    const slot = byId.get(id)
    slot.ops.push(op)
    slot.lastAt = Math.max(slot.lastAt ?? 0, ev.at ?? 0)
    if (op === 'put' && ev.record) {
      slot.current = { ...ev.record }
    } else if (op === 'use') {
      if (slot.current) slot.current.usedAt = Math.max(slot.current.usedAt ?? 0, ev.at ?? 0)
    } else if (op === 'edit') {
      if (slot.current) {
        slot.current = { ...slot.current, ...(ev.patch ?? ev.record ?? {}), editedAt: ev.at }
      }
    } else if (op === 'forget') {
      if (slot.current) slot.current = { ...slot.current, supersededBy: 'forgotten', forgottenAt: ev.at }
    } else if (op === 'supersede') {
      if (slot.current) slot.current = { ...slot.current, supersededBy: ev.by ?? ev.supersededBy ?? null }
    } else {
      unknownOps.set(op, (unknownOps.get(op) ?? 0) + 1)
    }
  }
  return { byId, unknownOps: [...unknownOps.entries()].map(([op, n]) => ({ op, n })) }
}

/**
 * Strata 记录 → 新核心记录。
 * scope 映射：session/workspace/global 保留；project 用 workspace 路径的稳定哈希（不用路径当身份）。
 */
export function mapStrataRecord(rec, { coreId, projectIdFor }) {
  // 实测旧 kind 分布：insight 100 / decision 87 / fact 34 / constraint 11 / preference 2。
  // 映射到新核心的五类；**旧 kind 原文保留在 legacyKind**，不丢语义。
  const kindMap = {
    preference: 'preference',
    constraint: 'requirement',
    requirement: 'requirement',
    decision: 'fact',
    insight: 'fact',
    fact: 'fact',
    progress: 'progress',
    log: 'log',
  }
  const kind = kindMap[rec.kind] ?? 'fact'
  const projectId = projectIdFor(rec)
  // 撤销状态：旧 supersede 事件写入 by 字段；'forgotten-by-tool' 与普通 supersede 都要保留
  const supersededBy = rec.supersededBy ?? null
  const status = supersededBy ? (String(supersededBy).includes('forgotten') ? 'revoked' : 'retired') : 'adopted'
  const body = String(rec.body ?? '').trim()
  if (!body) return null
  return {
    id: deriveRecordId({ projectId, kind, body, at: rec.createdAt ?? 0 }),
    legacyId: rec.id,
    legacyKind: rec.kind ?? null,
    coreId, projectId, environmentId: null,
    kind, body,
    title: null,
    tags: Array.isArray(rec.tags) ? rec.tags : [],
    entities: Array.isArray(rec.entities) ? rec.entities : [],
    aliases: [],
    author: rec.origin === 'tool' ? 'tool' : 'user',
    evidence: rec.origin === 'tool' ? 'tool-observed' : 'user-said',
    status,
    revision: rec.editedAt ? 2 : 1,
    contentVersion: contentHash({ body, kind, tags: rec.tags ?? [] }),
    source: {
      source: 'strata', sourceVersion: '0.3.1',
      eventId: rec.id, sessionId: rec.sessionId ?? null,
      turn: null, step: null, toolCallId: null,
    },
    evidenceRefs: rec.quote ? [contentHash(rec.quote)] : [],
    quote: rec.quote ?? null,
    legacyScope: rec.scope ?? 'workspace',
    legacyWorkspace: rec.workspace ?? null,
    supersedes: [],
    createdAt: rec.createdAt ?? Date.now(),
    updatedAt: rec.updatedAt ?? rec.createdAt ?? Date.now(),
    usedAt: rec.usedAt ?? null,
  }
}

/**
 * Forge 观测 → 经验原始经历（raw），不是候选、更不是正式经验。
 * 只有成对的 failure→fix 且经外部验证，才能进入候选。
 */
export function mapForgeObservation(obs, { coreId, projectId }) {
  return {
    kind: 'raw-episode',
    coreId, projectId,
    legacyId: obs.id,
    at: obs.at,
    sessionId: obs.sessionId ?? null,
    turn: obs.turn ?? null,
    step: obs.step ?? null,
    callId: obs.callId ?? null,
    tool: obs.tool ?? null,
    verdict: obs.verdict ?? null,
    reason: obs.reason ?? null,
    exitCode: obs.exitCode ?? null,
    signature: obs.signature ?? null,
    head: obs.head ?? '',
    args: obs.args ?? null,
    cmd: obs.cmd ?? null,
    scope: obs.scope ?? null,
  }
}

/**
 * 导入结果报告：数量、坏行、未知 op、ID 映射、冲突。
 * **不允许**把"读失败"报成 0 条。
 */
export function importStrata({ memoriesPath, coreId, projectIdFor }) {
  if (!existsSync(memoriesPath)) return { ok: false, reason: 'missing-file', path: memoriesPath, count: null }
  let text
  try { text = readFileSync(memoriesPath, 'utf8') } catch (e) { return { ok: false, reason: 'read-error', error: String(e.message), count: null } }
  const parsed = parseJsonl(text)
  const folded = foldStrataEvents(parsed)
  const records = []
  const skipped = []
  for (const slot of folded.byId.values()) {
    if (!slot.current) { skipped.push({ id: slot.id, reason: 'no-put' }); continue }
    const mapped = mapStrataRecord(slot.current, { coreId, projectIdFor })
    if (!mapped) { skipped.push({ id: slot.id, reason: 'empty-body' }); continue }
    records.push(mapped)
  }
  return {
    ok: true,
    path: memoriesPath,
    parsedLines: parsed.items.length,
    badLines: parsed.bad,
    unknownOps: folded.unknownOps,
    eventCount: parsed.items.length,
    recordCount: records.length,
    skipped,
    records,
    idMap: Object.fromEntries(records.map((r) => [r.legacyId, r.id])),
  }
}

export function importForge({ observationsPath, coreId, projectId }) {
  if (!existsSync(observationsPath)) return { ok: false, reason: 'missing-file', path: observationsPath, count: null }
  let text
  try { text = readFileSync(observationsPath, 'utf8') } catch (e) { return { ok: false, reason: 'read-error', error: String(e.message), count: null } }
  const parsed = parseJsonl(text)
  const episodes = parsed.items.map(({ value }) => mapForgeObservation(value, { coreId, projectId })).filter(Boolean)
  // 同一 id 多条（实测有重复写入）→ 只保留最新一条
  const byId = new Map()
  for (const e of episodes) {
    const prev = byId.get(e.legacyId)
    if (!prev || (e.at ?? 0) >= (prev.at ?? 0)) byId.set(e.legacyId, e)
  }
  return {
    ok: true,
    path: observationsPath,
    parsedLines: parsed.items.length,
    badLines: parsed.bad,
    rawCount: episodes.length,
    dedupedCount: byId.size,
    episodes: [...byId.values()],
  }
}

/** 冲突列出（不自动合并）：同项目同 kind 且内容版本不同但 id 相同。 */
export function listConflicts(importedRecords, existingRecords) {
  const byLegacy = new Map(existingRecords.filter((r) => r.legacyId).map((r) => [r.legacyId, r]))
  const conflicts = []
  for (const r of importedRecords) {
    const prev = byLegacy.get(r.legacyId)
    if (!prev) continue
    if (prev.contentVersion !== r.contentVersion) {
      conflicts.push({ legacyId: r.legacyId, existingId: prev.id, incomingId: r.id, existingStatus: prev.status, incomingStatus: r.status })
    }
  }
  return conflicts
}
