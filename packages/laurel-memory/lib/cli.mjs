#!/usr/bin/env node
/**
 * laurel-memory CLI —— 核心独立可用的命令入口（不依赖 DSH）。
 *
 * 用途：断网/无插件/换机器时直接读写核心仓；也是 S03 搬家与 S11 恢复的可重跑入口。
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { initVault, openVault, commit } from '../../laurel-core/lib/vault.mjs'
import { ARCHIVE_EXT, exportVault, restoreArchive, validateArchive } from '../../laurel-core/lib/archive.mjs'
import { searchMemory, composeNotes, pageBody, makeRecord, correctRecord, revokeRecord, TIER_BUDGET } from '../lib/memory/index.mjs'
import { importStrata, importForge } from '../lib/importer.mjs'
import { todayUsage } from '../../laurel-core/lib/budget.mjs'
import { TIER_LIMITS } from '../lib/gateway.mjs'

const RECORDS_FILE = 'memory/records.jsonl'

function recordsPath(vaultDir) { return join(vaultDir, RECORDS_FILE) }

/**
 * 读记录；坏行计数不隐藏，读失败不当 0 条。
 * 同一 id 有多条（纠正/撤销追加）时**只取 revision 最高的一条**，
 * 否则旧版本会和新版本一起被检索到 —— 这正是 Forge F3 的同类缺陷。
 */
function loadRecords(vaultDir) {
  const p = recordsPath(vaultDir)
  if (!existsSync(p)) return { records: [], bad: 0, exists: false }
  let text
  try { text = readFileSync(p, 'utf8') } catch (e) { throw new Error(`读取失败（不是空库）：${e.message}`) }
  const byId = new Map()
  let bad = 0
  let all = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { bad++; continue }
    all++
    const prev = byId.get(r.id)
    if (!prev || (r.revision ?? 1) >= (prev.revision ?? 1)) byId.set(r.id, r)
  }
  return { records: [...byId.values()], bad, exists: true, versions: all }
}

function appendRecord(vaultDir, rec) {
  mkdirSync(join(vaultDir, 'memory'), { recursive: true })
  appendFileSync(recordsPath(vaultDir), JSON.stringify(rec) + '\n')
}

const [, , cmd, ...args] = process.argv
const flags = {}
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2)
    const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true
    flags[k] = v
  } else {
    positional.push(args[i])
  }
}

function usage() {
  console.log(`laurel-memory CLI

  create <vault> --core-id <id>
  add <vault> --text <正文> [--kind fact|preference|requirement|progress|log]
  search <vault> <query> [--limit 5]
  notes <vault> <query> [--tier zero|balanced|full]
  page <vault> <id> [--offset 0 --lines 40]
  correct <vault> <id> --text <新正文>
  revoke <vault> <id> --reason <原因>
  import-strata <vault> --file <memories.jsonl>
  import-forge <vault> --file <observations.jsonl>
  import-session <vault> [--sessions <会话目录|sessions 根>] [--dry-run] [--limit N]
                 （把已有的 DSH 会话记录按时间顺序重放进采集管线；一次性补历史）
  export <vault> --out <file${ARCHIVE_EXT}>
  validate <file${ARCHIVE_EXT}>
  restore <file${ARCHIVE_EXT}> <target>
  usage <vault> --tier zero|balanced|full
  status <vault>
  selfcheck <vault> [--deep]   哨兵：每一项都真去读一次，四档 ok/warn/error/unmeasured
`)
}

try {
  if (!cmd || cmd === 'help' || cmd === '--help') { usage(); process.exit(0) }

  if (cmd === 'create') {
    const dir = resolve(positional[0])
    const v = initVault(dir, { coreId: flags['core-id'] ?? 'core-local' })
    console.log(JSON.stringify({ ok: true, vault: dir, coreId: v.manifest.coreId }, null, 1))
  } else if (cmd === 'add') {
    const dir = resolve(positional[0])
    const v = openVault(dir)
    const rec = makeRecord(
      { body: flags.text, kind: flags.kind, tags: flags.tag ? String(flags.tag).split(',') : [] },
      { coreId: v.manifest.coreId, projectId: flags.project ?? 'p-default', environmentId: null },
    )
    const c = commit(v, { ops: [{ op: 'record.put', id: rec.id }], body: rec.body })
    appendRecord(dir, { ...rec, journalSeq: c.seq, bodyHash: c.body?.hash ?? null })
    console.log(JSON.stringify({ ok: true, id: rec.id, seq: c.seq, hash: c.body?.hash }, null, 1))
  } else if (cmd === 'search') {
    const dir = resolve(positional[0])
    const { records } = loadRecords(dir)
    const r = searchMemory(records, positional.slice(1).join(' '), { limit: Number(flags.limit) || 5 })
    console.log(JSON.stringify({ query: r.query, hits: r.hits.map((h) => ({ id: h.record.id, score: +h.score.toFixed(2), coverage: +h.coverage.toFixed(2), kind: h.record.kind, body: h.record.body.slice(0, 160) })) }, null, 1))
  } else if (cmd === 'notes') {
    const dir = resolve(positional[0])
    const { records } = loadRecords(dir)
    const c = composeNotes(records, positional.slice(1).join(' '), { tier: flags.tier ?? 'zero' })
    console.log(JSON.stringify(c, null, 1))
  } else if (cmd === 'page') {
    const dir = resolve(positional[0])
    const { records } = loadRecords(dir)
    console.log(JSON.stringify(pageBody(records, positional[1], { offset: Number(flags.offset) || 0, lines: Number(flags.lines) || 40 }), null, 1))
  } else if (cmd === 'correct') {
    const dir = resolve(positional[0])
    const { records } = loadRecords(dir)
    const old = records.find((r) => r.id === positional[1])
    if (!old) { console.error('找不到记录'); process.exit(2) }
    const next = correctRecord(old, { body: flags.text })
    const v = openVault(dir)
    const c = commit(v, { ops: [{ op: 'record.correct', id: next.id, revision: next.revision }], body: next.body })
    appendRecord(dir, { ...next, journalSeq: c.seq, bodyHash: c.body?.hash ?? null })
    console.log(JSON.stringify({ ok: true, id: next.id, revision: next.revision, seq: c.seq }, null, 1))
  } else if (cmd === 'revoke') {
    const dir = resolve(positional[0])
    const { records } = loadRecords(dir)
    const old = records.find((r) => r.id === positional[1])
    if (!old) { console.error('找不到记录'); process.exit(2) }
    const next = revokeRecord(old, { reason: flags.reason })
    const v = openVault(dir)
    const c = commit(v, { ops: [{ op: 'record.revoke', id: next.id }] })
    appendRecord(dir, { ...next, journalSeq: c.seq })
    console.log(JSON.stringify({ ok: true, id: next.id, status: next.status, seq: c.seq }, null, 1))
  } else if (cmd === 'import-strata') {
    const dir = resolve(positional[0])
    const v = openVault(dir)
    const res = importStrata({
      memoriesPath: flags.file,
      coreId: v.manifest.coreId,
      projectIdFor: (rec) => 'p-' + String(rec.workspace ?? 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16),
    })
    if (!res.ok) { console.error(JSON.stringify(res)); process.exit(3) }
    for (const r of res.records) appendRecord(dir, r)
    console.log(JSON.stringify({
      ok: true, parsedLines: res.parsedLines, badLines: res.badLines.length,
      records: res.recordCount, unknownOps: res.unknownOps,
      statuses: res.records.reduce((a, r) => (a[r.status] = (a[r.status] ?? 0) + 1, a), {}),
    }, null, 1))
  } else if (cmd === 'import-forge') {
    const dir = resolve(positional[0])
    const v = openVault(dir)
    const res = importForge({ observationsPath: flags.file, coreId: v.manifest.coreId, projectId: 'p-forge' })
    if (!res.ok) { console.error(JSON.stringify(res)); process.exit(3) }
    mkdirSync(join(dir, 'experience'), { recursive: true })
    for (const e of res.episodes) appendFileSync(join(dir, 'experience', 'episodes.jsonl'), JSON.stringify(e) + '\n')
    console.log(JSON.stringify({ ok: true, parsedLines: res.parsedLines, badLines: res.badLines.length, raw: res.rawCount, deduped: res.dedupedCount }, null, 1))
  } else if (cmd === 'import-session') {
    // 一次性回填：把落盘的 DSH 会话记录重放进采集管线。
    // 与 import-strata / import-forge 的区别是数据源不是导出文件，而是宿主自己的
    // session.v4.jsonl.zstd；重放本身走 createCapture，不另开写盘路径。
    const dir = resolve(positional[0])
    const sessionsPath = flags.sessions ? resolve(String(flags.sessions)) : undefined
    const { backfill, defaultSessionsRoot } = await import('../lib/backfill.mjs')
    const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true'
    const limit = flags.limit === undefined ? null : Number(flags.limit)
    if (limit !== null && !Number.isFinite(limit)) { console.error('错误: --limit 需要数字'); process.exit(1) }
    // 会话文件动辄上千个事件，逐条打日志会把终端刷爆；除非显式 --verbose，否则只静音。
    const log = flags.verbose
      ? { debug() {}, info() {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) }
      : { debug() {}, info() {}, warn() {}, error() {} }
    const report = backfill({
      vaultDir: dir,
      sessionsPath: sessionsPath ?? defaultSessionsRoot(),
      dryRun,
      limit,
      tier: flags.tier ?? 'zero',
      log,
      // 会话很多时 --summary 只留汇总，不逐会话列；默认列出来，因为「哪一路出错」必须看得见。
      summaryOnly: flags.summary === true || flags.summary === 'true',
    })
    console.log(JSON.stringify(report, null, 1))
    // 用法级/数据级失败都用 3（与另外两个 import 一致），调用方按 !ok 判，不靠猜退出码含义。
    if (!report.ok) process.exit(3)
  } else if (cmd === 'export') {
    const dir = resolve(positional[0])
    const v = openVault(dir)
    const { records } = loadRecords(dir)
    const episodesPath = join(dir, 'experience', 'episodes.jsonl')
    let episodes = 0
    if (existsSync(episodesPath)) {
      for (const line of readFileSync(episodesPath, 'utf8').split('\n')) if (line.trim()) episodes++
    }
    const ex = exportVault(v, {
      outPath: resolve(flags.out),
      moduleVersions: { memory: '0.1.0' },
      expectedCounts: { records: records.length, episodes },
    })
    const base = {
      ok: ex.ok, path: ex.path, bytes: ex.bytes, sha256: ex.sha256,
      complete: ex.manifest.complete, gaps: ex.manifest.gaps, counts: ex.manifest.counts,
      declared: { records: records.length, episodes },
    }
    // 可选加密：给了 --password 就再包一层信封（内层仍是原 ZIP）
    if (flags.password) {
      const { encryptArchive, passwordHints } = await import('../../laurel-core/lib/encrypt.mjs')
      const plain = readFileSync(ex.path)
      const enc = encryptArchive(plain, String(flags.password))
      const encPath = ex.path + '.enc'
      writeFileSync(encPath, enc)
      base.encrypted = {
        path: encPath,
        bytes: enc.length,
        sha256: createHash('sha256').update(enc).digest('hex'),
        plainSha256: ex.sha256,
        hints: passwordHints(String(flags.password)),
        warning: '没有密码找回。口令丢失 = 包永久打不开。',
      }
    }
    console.log(JSON.stringify(base, null, 1))
    if (!ex.manifest.complete) process.exit(6)
  } else if (cmd === 'validate') {
    const raw = readFileSync(resolve(positional[0]))
    const { isEncrypted, decryptArchive, encryptInfo } = await import('../../laurel-core/lib/encrypt.mjs')
    let buf = raw
    let encInfo = null
    if (isEncrypted(raw)) {
      encInfo = encryptInfo(raw)
      if (!flags.password) {
        console.log(JSON.stringify({ ok: false, reason: 'encrypted', needPassword: true, info: encInfo }, null, 1))
        process.exit(7)
      }
      buf = decryptArchive(raw, String(flags.password))
    }
    const v = validateArchive(buf)
    console.log(JSON.stringify({
      ok: v.ok, problems: v.problems, complete: v.manifest?.complete, coreId: v.manifest?.coreId,
      counts: v.manifest?.counts, encrypted: !!encInfo, encInfo,
    }, null, 1))
    if (!v.ok) process.exit(4)
  } else if (cmd === 'restore') {
    const raw = readFileSync(resolve(positional[0]))
    const { isEncrypted, decryptArchive } = await import('../../laurel-core/lib/encrypt.mjs')
    let buf = raw
    if (isEncrypted(raw)) {
      if (!flags.password) {
        console.log(JSON.stringify({ ok: false, reason: 'encrypted', needPassword: true }, null, 1))
        process.exit(7)
      }
      buf = decryptArchive(raw, String(flags.password))
    }
    const r = restoreArchive(buf, resolve(positional[1]))
    console.log(JSON.stringify({ ok: r.ok, stage: r.stage, targetDir: r.targetDir, problems: r.problems }, null, 1))
    if (!r.ok) process.exit(5)
  } else if (cmd === 'probe') {
    // 探活模型端点：用户自己验证本地/API 是否通，不消耗业务预算
    const { providerForSource, sourceMatrix } = await import('../lib/providers.mjs')
    const source = String(flags.source ?? 'local')
    if (source === 'none') {
      console.log(JSON.stringify({ ok: true, source: 'none', note: '来源为 none：不会发起任何调用，全部功能仍可用', matrix: sourceMatrix() }, null, 1))
    } else {
      const baseUrl = flags.baseUrl ?? (source === 'local' ? 'http://127.0.0.1:11434/v1' : null)
      const model = flags.model
      if (!model) { console.error('错误: probe 需要 --model'); process.exit(1) }
      const p = providerForSource({
        source, baseUrl, model,
        shape: flags.shape ?? 'openai-chat',
        apiKeyEnv: flags.apiKeyEnv,
        timeoutMs: Number(flags.timeoutMs ?? 15_000),
      })
      const r = await p.probe({ timeoutMs: Number(flags.timeoutMs ?? 15_000) })
      console.log(JSON.stringify({
        ok: r.ok, source, provider: p.name, model: r.model ?? model,
        sample: r.sample ?? null, usage: r.usage ?? null,
        error: r.error ?? null,
        note: r.ok ? '端点与模型可用' : '不可用；未回退到其它来源（本地失败不会自动转远端）',
      }, null, 1))
      if (!r.ok) process.exit(3)
    }
  } else if (cmd === 'sources') {
    const { sourceMatrix } = await import('../lib/providers.mjs')
    console.log(JSON.stringify({ matrix: sourceMatrix() }, null, 1))
  } else if (cmd === 'usage') {
    const dir = resolve(positional[0])
    const tier = flags.tier ?? 'zero'
    console.log(JSON.stringify(todayUsage(dir, { limits: TIER_LIMITS[tier] }), null, 1))
  } else if (cmd === 'status') {
    const dir = resolve(positional[0])
    const v = openVault(dir)
    const { records, bad } = loadRecords(dir)
    console.log(JSON.stringify({
      ok: true, vault: dir, coreId: v.manifest.coreId, journalSeq: v.lastSeq,
      records: records.length, badLines: bad,
      statuses: records.reduce((a, r) => (a[r.status] = (a[r.status] ?? 0) + 1, a), {}),
      tiers: Object.keys(TIER_BUDGET),
    }, null, 1))
  } else if (cmd === 'selfcheck') {
    // S8：哨兵。**不 openVault** —— 开仓会跑一次全量 journal 链校验（真仓 1.1 秒），
    // 而体检要回答的是「文件与目录现在什么状态」，不该被开仓的严格性挡在门外
    // （仓坏了的时候恰恰最需要体检，开仓抛错就什么都测不到了）。
    const dir = resolve(positional[0] ?? '.')
    const deep = flags.deep === true || flags.deep === 'true'
    const { runSelfCheck } = await import('../lib/selfcheck.mjs')
    const report = runSelfCheck(dir, { deep })
    console.log(JSON.stringify(report, null, 1))
    // 退出码分三档，让脚本能判：0 = 没发现故障；3 = 检出故障（与其它 import
    // 命令的数据级失败同码）；0 也涵盖 unmeasured —— 「不知道」不是失败，
    // 把它当失败会训练人去忽略这个退出码。
    if (report.summary.error > 0) process.exit(3)
  } else {
    usage(); process.exit(1)
  }
} catch (e) {
  console.error('错误:', e.message)
  process.exit(1)
}
