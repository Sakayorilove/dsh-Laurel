/**
 * laurel-memory/admin-api —— MC13：管理面从「状态页」变成「能走完一件事」。
 *
 * ── 为什么需要这个文件（缺陷 MC13，2026-10-22）───────────────────────────
 * 现场核查：`lib/settings-api.js`（263 行）只做**设置读写**，`settingsSnapshot()`
 * 只回一个 `readOnlySnapshot()`；`lib/client/index.mjs` 的面板只渲染
 * 「状态 / 档位下拉 / 模型来源下拉 / 端点 / 应用」。手册 MC13 原文是
 * 「管理面主要是状态页，缺非程序员完整流程」。
 *
 * 也就是说：数据都在仓里（4 万条记录、经验条目、归档包、容量治理），但一个人
 * 想完成「今天发生了什么 → 这条为什么这么记 → 记错了更正 → 不该留的撤销 →
 * 这条经验能用吗 → 采纳 → 真的用了一次，成不成 → 搬家」这一串动作，只能去敲
 * CLI 或读代码。这不是「界面不够漂亮」，是**没有入口**。
 *
 * ── 边界（写清楚，免得下一个人以为这里是通用 RPC）────────────────────────
 *  1. 动作是**枚举**的（`ADMIN_ACTIONS`），不是转发器：未知动作直接拒，
 *     并且把可选动作列出来。开一个「你想干什么都行」的通道等于把
 *     vault 的全部能力暴露给一次 HTTP 请求。
 *  2. 本模块**不认识 HTTP**。鉴权、CSRF、请求体上限全部留在 `settings-api.js`
 *     那一层（已经过验证：本机 + 同源 + `x-laurel-ui` 头 + 8KB 上限）。
 *     这里只收到「已经放行的一次调用」和它的 JSON。
 *  3. 破坏性动作必须**显式确认**：`restore` 要求 `confirm:true` 且目标目录不得
 *     是本仓（否则一次误点就把活的仓盖掉）；`retention-apply` 同样要 `confirm:true`
 *     —— 它删的是 blob，`journal` 永不删（retention.mjs 的硬约束）。
 *  4. 读动作不做任何写入。`today` / `search` / `page` / `episodes` /
 *     `retention-plan` 五个都可以随便点。
 *
 * ── 已知限制（如实写）────────────────────────────────────────────────
 *  `restore` 仍然要把整个归档包读进内存（`restoreArchive(buf, …)` 的签名如此，
 *  改签名是 laurel-core 的契约变更，不在本步范围）。导出侧已经流式（MC15），
 *  恢复侧等下一轮。这里不假装它是流式的。
 *
 * @module admin-api
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path'

import { commit, openVault } from '../../laurel-core/lib/vault.mjs'
import { ARCHIVE_EXT, exportVault, restoreArchive, validateArchive } from '../../laurel-core/lib/archive.mjs'
import { apply as applyRetention, plan as planRetention } from '../../laurel-core/lib/retention.mjs'
import { appendRecord, loadRecords, recordOpPayload } from './capture.mjs'
import { correctRecord, pageBody, revokeRecord, searchMemory } from './memory/index.mjs'
import { EPISODES_FILE } from './projection.mjs'
import { runSelfCheck } from './selfcheck.mjs'

/**
 * 可选动作表。**这是契约**：前端按它渲染按钮，端点按它校验。
 * 加动作只改这里一处，两边的枚举漂移（D66 那类）就不会再出现。
 */
export const ADMIN_ACTIONS = Object.freeze([
  { id: 'today', kind: 'read', label: '今天' },
  { id: 'search', kind: 'read', label: '查记忆' },
  { id: 'page', kind: 'read', label: '读原文' },
  { id: 'episodes', kind: 'read', label: '看经验' },
  { id: 'correct', kind: 'write', label: '更正记录' },
  { id: 'revoke', kind: 'write', label: '撤销记录' },
  { id: 'adopt', kind: 'write', label: '采纳经验' },
  { id: 'outcome', kind: 'write', label: '记复用结果' },
  { id: 'retire', kind: 'write', label: '退役经验' },
  { id: 'episode-revoke', kind: 'write', label: '撤销经验' },
  { id: 'export', kind: 'write', label: '完整打包' },
  { id: 'restore', kind: 'write', label: '恢复核心仓' },
  { id: 'retention-plan', kind: 'read', label: '清理计划' },
  { id: 'retention-apply', kind: 'write', label: '执行清理' },
  // S8：哨兵。**读**动作（只读，唯一会碰盘的是 journal 的 append 试开，不写字节）。
  { id: 'selfcheck', kind: 'read', label: '自检' },
])

const ACTION_IDS = new Set(ADMIN_ACTIONS.map((a) => a.id))

const noopLog = { info() {}, warn() {}, error() {}, debug() {} }

const asString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const asInt = (v, fallback) => (Number.isInteger(v) ? v : fallback)

/**
 * 本地日的起点（毫秒）。
 *
 * 用**进程本地时区**而不是 UTC：这个面板是给人看的，「今天」指的是用户日历上的
 * 今天。宿主侧时区由 `cordis.patch.yml` 的 `timeZone` 决定（默认跟随系统时区），
 * 与进程本地时区一致；两者不一致时这里会与用户直觉差几小时，属于可接受偏差
 * （改法是给整个插件注入时区，那是另一件事）。
 */
function dayStart(now = Date.now()) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 正文首行、压到 100 字符 —— 列表里只需要一眼能认出是哪条。 */
function headOf(text, max = 100) {
  const line = String(text ?? '').split('\n').find((x) => x.trim()) ?? ''
  const t = line.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 造动作执行器。
 *
 * @param {{
 *   vaultDir: string|null,
 *   vault?: object|null,
 *   experience?: object|null,   // lib/experience/pipeline.mjs 的 plane
 *   log?: object,
 *   clock?: () => number,
 *   moduleVersions?: object,
 * }} deps
 */
export function createAdminActions({
  vaultDir: vaultDirInit = null,
  vault: vaultInit = null,
  experience: experienceInit = null,
  log = noopLog,
  clock = Date.now,
  moduleVersions = {},
} = {}) {
  // 这些是**可重新绑定**的：vault 在插件 apply 早期可能还没打开，经验面更晚才
  // 装配好。闭包里存一份构造时的快照，那天面板就会对着一个已经不存在的对象
  // 发号施令，而且报出来的错是「找不到记录」而不是「仓没挂上」。
  let vaultDir = vaultDirInit
  let vault = vaultInit
  let experience = experienceInit
  // S8：哨兵要读的两份**进程内**状态。它们（还）没有落盘，所以只能由接线层
  // 现取现塞；拿不到就是 null，哨兵会如实报 unmeasured 而不是猜。
  let selfcheckDeps = { injectStatus: null, retentionStatus: null }

  /** 由接线层在每次动作前刷新（见 lib/index.js 的 adminHandle）。 */
  function bind(next = {}) {
    if (Object.hasOwn(next, 'vaultDir')) vaultDir = next.vaultDir ?? null
    if (Object.hasOwn(next, 'vault')) vault = next.vault ?? null
    if (Object.hasOwn(next, 'experience')) experience = next.experience ?? null
    if (Object.hasOwn(next, 'injectStatus')) selfcheckDeps = { ...selfcheckDeps, injectStatus: next.injectStatus ?? null }
    if (Object.hasOwn(next, 'retentionStatus')) selfcheckDeps = { ...selfcheckDeps, retentionStatus: next.retentionStatus ?? null }
    return { vaultDir, hasVault: !!vault, hasExperience: !!experience }
  }

  const ready = () => {
    if (!vaultDir || !existsSync(vaultDir)) return { ok: false, reason: 'no-vault', error: '记忆核心仓不可用（没有路径或目录不存在）' }
    return null
  }
  const vaultOf = () => vault ?? openVault(vaultDir)

  /** 读记录。40k 条 / 85MB 全量解析约 1.2 秒 —— 面板点一次，不是热路径。 */
  function readRecords() {
    const loaded = loadRecords(vaultDir)
    return loaded
  }

  // ── 读动作 ──────────────────────────────────────────────────────────

  function today() {
    const { records, bad, exists } = readRecords()
    const start = dayStart(clock())
    const byKind = Object.create(null)
    const byAuthor = Object.create(null)
    let todayCount = 0
    for (const r of records) {
      const kind = r?.kind ?? 'unknown'
      byKind[kind] = (byKind[kind] ?? 0) + 1
      const author = r?.author ?? 'unknown'
      byAuthor[author] = (byAuthor[author] ?? 0) + 1
      const at = Number.isFinite(r?.createdAt) ? r.createdAt : (Number.isFinite(r?.at) ? r.at : null)
      if (at !== null && at >= start) todayCount += 1
    }
    const eps = experience?.list ? experience.list({ includeAll: true }) : { total: 0, byState: {}, episodes: [] }
    const pending = (eps.episodes ?? []).filter((e) => e?.state === 'candidate' || e?.state === 'raw-episode')
    return {
      ok: true,
      data: {
        vaultDir,
        exists,
        badLines: bad,
        records: records.length,
        todayRecords: todayCount,
        byKind,
        byAuthor,
        // 这些条目由系统继续观察，不是人工采纳待办。
        episodes: {
          total: eps.total ?? 0,
          byState: eps.byState ?? {},
          pending: pending.length,
          top: pending.slice(0, 5).map((e) => ({ id: e.id, state: e.state, summary: headOf(e.summary, 120) })),
        },
        asOf: clock(),
      },
    }
  }

  function search(payload) {
    const query = asString(payload?.query)
    if (!query) return { ok: false, reason: 'missing-query', error: '要给一个查询词' }
    const limit = Math.min(Math.max(asInt(payload?.limit, 5), 1), 20)
    const { records, bad } = readRecords()
    const result = searchMemory(records, query, { limit })
    return {
      ok: true,
      data: {
        query: result.query,
        badLines: bad,
        hits: (result.hits ?? []).map((h) => ({
          id: h.record.id,
          kind: h.record.kind,
          title: h.record.title ?? null,
          author: h.record.author ?? null,
          state: h.record.status ?? null,
          // 只回首行：正文靠 page 动作分页读（L06 的契约，列表里搬正文等于把
          // 一堆记录塞进一个响应里，还看不出哪条是想要的）。
          head: headOf(h.record.body),
          score: Number(h.score?.toFixed?.(3) ?? h.score),
          coverage: Number(h.coverage?.toFixed?.(3) ?? h.coverage),
        })),
      },
    }
  }

  function page(payload) {
    const id = asString(payload?.id)
    if (!id) return { ok: false, reason: 'missing-id', error: '要给一个记录 id' }
    const { records } = readRecords()
    const out = pageBody(records, id, {
      offset: Math.max(asInt(payload?.offset, 0), 0),
      lines: Math.min(Math.max(asInt(payload?.lines, 40), 1), 400),
    })
    if (!out?.ok) return { ok: false, reason: out?.reason ?? 'not-found', error: `读不到 ${id} 的正文` }
    return { ok: true, data: out }
  }

  function episodes(payload) {
    if (!experience?.list) return { ok: false, reason: 'no-experience', error: '经验学习面未启用' }
    const all = experience.list({ includeAll: true })
    const want = asString(payload?.state)
    const list = Array.isArray(all.episodes) ? all.episodes : []
    const filtered = want ? list.filter((e) => e?.state === want) : list
    return {
      ok: true,
      data: {
        total: all.total ?? list.length,
        byState: all.byState ?? {},
        exists: all.exists ?? false,
        badLines: all.bad ?? 0,
        automation: experience.status?.().automation ?? null,
        states: ['raw-episode', 'candidate', 'trial', 'adopted', 'retired', 'revoked'],
        episodes: filtered.slice(0, 50).map((e) => ({
          id: e.id,
          state: e.state,
          methodOk: !!e.methodOk,
          methodMissing: e.methodMissing ?? [],
          summary: headOf(e.summary, 200),
          adoption: e.adoption ?? null,
          verification: e.verification ?? null,
          outcomes: (e.outcomes ?? []).length,
          updatedAt: e.updatedAt ?? e.createdAt ?? null,
        })),
      },
    }
  }

  /**
   * S8：跑一次自检（哨兵）。
   *
   * 为什么挂在管理面而不是另开一条端点：`settings-api.js` 的两层栅栏
   * （宿主 connection.admit / 本机+同源 + `x-laurel-ui` 头 + 8KB 上限）
   * 已经验证过，再挂一条裸路由就得把同一道栅栏抄第二遍。
   * 本动作是 **read**：不写任何东西（journal 项的 append 试开不写字节）。
   *
   * `deep:true` 才真解 jsonl（真仓 85MB，秒级）；默认快检，数十毫秒。
   */
  function selfcheck(payload) {
    const deep = payload?.deep === true || payload?.deep === 'true'
    const report = runSelfCheck(vaultDir, {
      deep,
      clock,
      injectStatus: selfcheckDeps.injectStatus,
      retentionStatus: selfcheckDeps.retentionStatus,
    })
    // summary.verdict 是 'broken' 时仍然 ok:true —— 「体检成功跑完」与
    // 「体检发现故障」是两件事。把它折成 ok:false，面板只会显示一句
    // 错误文本，四个计数和逐项 detail 全丢了，那正好是最难修的那种界面。
    return { ok: true, data: { ...report, healthy: report.summary.verdict === 'healthy' } }
  }

  function retentionPlan(payload) {
    const policy = payload?.policy && typeof payload.policy === 'object' ? payload.policy : {}
    return planRetention(vaultDir, policy).then((report) => ({ ok: true, data: report }))
  }

  function retentionApply(payload) {
    // 破坏性：必须显式确认。它删 blob（journal 永不删），误点一次就是几百 MB 的
    // 原文没了 —— 虽然打了 tgz 并给了回滚命令，但那要人会去执行。
    if (payload?.confirm !== true) {
      return { ok: false, reason: 'confirm-required', error: '执行清理必须显式确认（confirm: true），并先看一次「清理计划」' }
    }
    const policy = payload?.policy && typeof payload.policy === 'object' ? payload.policy : {}
    return applyRetention(vaultDir, policy).then((report) => ({ ok: true, data: report }))
  }

  // ── 写动作 ──────────────────────────────────────────────────────────

  function correct(payload) {
    const id = asString(payload?.id)
    if (!id) return { ok: false, reason: 'missing-id', error: '要给一个记录 id' }
    const { records } = readRecords()
    const old = records.find((r) => r?.id === id)
    if (!old) return { ok: false, reason: 'not-found', error: `仓里没有 ${id}` }
    const patch = {}
    if (typeof payload?.text === 'string' && payload.text.trim()) patch.body = payload.text
    if (typeof payload?.kind === 'string' && payload.kind.trim()) patch.kind = payload.kind
    if (typeof payload?.title === 'string') patch.title = payload.title
    if (Object.keys(patch).length === 0) {
      return { ok: false, reason: 'empty-patch', error: '要有 text / kind / title 至少一项才叫更正' }
    }

    const next = correctRecord(old, patch, { clock })
    if (!next || typeof next.id !== 'string') return { ok: false, reason: 'correct-failed', error: '更正没生成新版本' }

    const v = vaultOf()
    const written = commit(v, {
      // S11-3：同一份 op-payload 契约 —— 更正后的记录也必须能照着重建，
      // 否则重建时又只能拿正文重跑分类（kind 可能变，projectId 只能猜）。
      ops: [{ op: 'record.correct', id: next.id, revision: next.revision, rev: next.revision, rec: recordOpPayload(next) }],
      body: next.body,
      meta: { kind: 'admin.correct', by: 'human', supersedes: old.id },
    })
    if (!written || written.ok !== true) {
      return { ok: false, reason: 'commit-failed', error: `journal 写入失败：${written?.reason ?? 'unknown'}` }
    }
    // 读侧视图（records.jsonl）随后写：journal 已提交，从这一刻这条版本就存在，
    // 这里失败也只是「视图少一行」，`reconcileRecords` 能补。
    appendRecord(vaultDir, { ...next, journalSeq: written.seq, bodyHash: written.body?.hash ?? null })
    return {
      ok: true,
      data: { id: next.id, revision: next.revision, seq: written.seq, supersedes: old.id, textHead: headOf(next.body) },
    }
  }

  function revoke(payload) {
    const id = asString(payload?.id)
    if (!id) return { ok: false, reason: 'missing-id', error: '要给一个记录 id' }
    const reason = asString(payload?.reason)
    if (!reason) return { ok: false, reason: 'missing-reason', error: '撤销要写原因（三个月后没人记得为什么撤的）' }
    const { records } = readRecords()
    const old = records.find((r) => r?.id === id)
    if (!old) return { ok: false, reason: 'not-found', error: `仓里没有 ${id}` }
    const next = revokeRecord(old, { reason, actor: 'human', clock })
    const v = vaultOf()
    const written = commit(v, {
      ops: [{ op: 'record.revoke', id: next.id, revision: next.revision, rev: next.revision, rec: recordOpPayload(next) }],
      meta: { kind: 'admin.revoke', by: 'human', reason },
    })
    if (!written || written.ok !== true) {
      return { ok: false, reason: 'commit-failed', error: `journal 写入失败：${written?.reason ?? 'unknown'}` }
    }
    appendRecord(vaultDir, { ...next, journalSeq: written.seq })
    return { ok: true, data: { id: next.id, status: next.status, revision: next.revision, seq: written.seq } }
  }

  function needExperience(action) {
    if (!experience || typeof experience[action] !== 'function') {
      return { ok: false, reason: 'no-experience', error: '经验学习面未启用，这个动作暂时不可用' }
    }
    return null
  }

  function adopt(payload) {
    const missing = needExperience('adopt')
    if (missing) return missing
    const id = asString(payload?.id)
    if (!id) return { ok: false, reason: 'missing-id', error: '要给一条经验 id' }
    const out = experience.adopt(id, {
      actor: 'human',
      ...(typeof payload?.summary === 'string' && payload.summary.trim() ? { summary: payload.summary } : {}),
      at: clock(),
    })
    // 晋升门拒了要原样把「下一步怎么做」透出去（`hint`/`currentSummary`），
    // 否则面板上只有一个红字，用户会以为按钮坏了。
    if (!out?.ok) return { ok: false, reason: out?.reason ?? 'rejected', error: out?.hint ?? `采纳被拒：${out?.reason}`, detail: out ?? null }
    return { ok: true, data: { id: out.record?.id, state: out.record?.state, skill: out.skill ?? null } }
  }

  function outcome(payload) {
    const missing = needExperience('outcome')
    if (missing) return missing
    const id = asString(payload?.id)
    const result = asString(payload?.result)
    if (!id) return { ok: false, reason: 'missing-id', error: '要给一条经验 id' }
    if (!['passed', 'failed', 'pending'].includes(result)) {
      return { ok: false, reason: 'bad-result', error: 'result 只能是 passed / failed / pending' }
    }
    const evidence = Array.isArray(payload?.evidence) ? payload.evidence.filter((x) => typeof x === 'string') : []
    const out = experience.outcome(id, { result, evidence, actor: 'human', at: clock() })
    if (!out?.ok) return { ok: false, reason: out?.reason ?? 'rejected', error: `记账失败：${out?.reason ?? 'unknown'}` }
    return { ok: true, data: { id: out.record?.id, verification: out.record?.verification ?? null, confidence: out.confidence ?? null } }
  }

  function retire(payload) {
    const missing = needExperience('retire')
    if (missing) return missing
    const id = asString(payload?.id)
    if (!id) return { ok: false, reason: 'missing-id', error: '要给一条经验 id' }
    const why = asString(payload?.reason)
    if (!why) return { ok: false, reason: 'missing-reason', error: '退役要写原因' }
    const out = experience.retire(id, { why, at: clock() })
    if (!out?.ok) return { ok: false, reason: out?.reason ?? 'rejected', error: `退役失败：${out?.reason ?? 'unknown'}` }
    return { ok: true, data: { id: out.record?.id, state: out.record?.state } }
  }

  function episodeRevoke(payload) {
    const missing = needExperience('revoke')
    if (missing) return missing
    const id = asString(payload?.id)
    if (!id) return { ok: false, reason: 'missing-id', error: '要给一条经验 id' }
    const why = asString(payload?.reason)
    if (!why) return { ok: false, reason: 'missing-reason', error: '撤销经验要写原因（这是终态，撤了不能复活）' }
    const out = experience.revoke(id, { why, at: clock() })
    if (!out?.ok) return { ok: false, reason: out?.reason ?? 'rejected', error: `撤销失败：${out?.reason ?? 'unknown'}` }
    return { ok: true, data: { id: out.record?.id, state: out.record?.state } }
  }

  async function exportArchive(payload) {
    const outPath = asString(payload?.outPath) ?? join(vaultDir, 'exports', `core-${new Date(clock()).toISOString().replace(/[:.]/g, '-')}${ARCHIVE_EXT}`)
    if (!isAbsolute(outPath)) return { ok: false, reason: 'relative-path', error: '导出路径必须是绝对路径（相对路径会跟着宿主 cwd 跑，找不到包）' }
    // 不许把包写进仓自己的数据目录：写进 blobs/ 会被下一次导出当成数据打进去，
    // 体积每导一次涨一倍。exports/ 是唯一允许的仓内落点（collectVaultFiles 排除了它）。
    const insideVault = outPath === vaultDir || outPath.startsWith(vaultDir + sep)
    if (insideVault && !outPath.startsWith(join(vaultDir, 'exports') + sep)) {
      return { ok: false, reason: 'unsafe-path', error: '归档只能写在仓的 exports/ 下，或仓外的绝对路径' }
    }
    const { records } = readRecords()
    const epFile = join(vaultDir, EPISODES_FILE)
    let episodesCount = 0
    if (existsSync(epFile)) episodesCount = readFileSync(epFile, 'utf8').split('\n').filter((x) => x.trim()).length
    const out = await exportVault(vaultOf(), {
      outPath,
      moduleVersions,
      expectedCounts: { records: records.length, episodes: episodesCount },
    })
    return {
      ok: true,
      data: {
        path: out.path,
        bytes: out.bytes,
        sha256: out.sha256,
        // 「导出了」和「导出完整」是两件事：缺原文的包也写得出 200MB。
        complete: out.manifest?.complete === true,
        gaps: out.manifest?.gaps ?? [],
        counts: out.manifest?.counts ?? null,
      },
    }
  }

  function restore(payload) {
    if (payload?.confirm !== true) {
      return { ok: false, reason: 'confirm-required', error: '恢复必须显式确认（confirm: true）' }
    }
    const archivePath = asString(payload?.archivePath)
    const targetDir = asString(payload?.targetDir)
    if (!archivePath) return { ok: false, reason: 'missing-archive', error: '要给归档包的绝对路径' }
    if (!targetDir) return { ok: false, reason: 'missing-target', error: '要给目标目录（恢复到一个新目录，不覆盖当前仓）' }
    if (!isAbsolute(archivePath) || !isAbsolute(targetDir)) {
      return { ok: false, reason: 'relative-path', error: '归档路径与目标目录都必须是绝对路径' }
    }
    const target = resolvePath(targetDir)
    // 目标不得是本仓、也不得在仓内：恢复是「搬到一台新机器/新路径」用的，
    // 允许它指向正开着的仓等于给一次误点发一张删库许可。
    if (target === resolvePath(vaultDir) || target.startsWith(resolvePath(vaultDir) + sep)) {
      return { ok: false, reason: 'target-is-live-vault', error: '目标目录不能是当前正在用的核心仓（要恢复请给一个新目录）' }
    }
    if (!existsSync(archivePath)) return { ok: false, reason: 'archive-missing', error: `找不到 ${archivePath}` }
    const bytes = statSync(archivePath).bytes
    // 顺带把「这个包多大」报出去：几百 MB 的包读进内存之前，人应该有一次知情机会。
    const buf = readFileSync(archivePath)
    const check = validateArchive(buf, { requireComplete: true })
    if (check.ok !== true) {
      return { ok: false, reason: 'archive-incomplete', error: '这个包不完整，拒绝恢复（缺原文的包恢复回来也不报错，那是最坏的失败）', problems: check.problems ?? [] }
    }
    const out = restoreArchive(buf, target, { overwrite: payload?.overwrite === true, requireComplete: true })
    if (out?.ok !== true) {
      return { ok: false, reason: out?.stage ?? 'restore-failed', error: `恢复失败（${out?.stage ?? 'unknown'}）`, problems: out?.problems ?? [] }
    }
    return { ok: true, data: { target, archiveBytes: bytes, ...out } }
  }

  const READ = new Map([
    ['today', today],
    ['search', search],
    ['page', page],
    ['episodes', episodes],
    ['retention-plan', retentionPlan],
    ['selfcheck', selfcheck],
  ])
  const WRITE = new Map([
    ['correct', correct],
    ['revoke', revoke],
    ['adopt', adopt],
    ['outcome', outcome],
    ['retire', retire],
    ['episode-revoke', episodeRevoke],
    ['export', exportArchive],
    ['restore', restore],
    ['retention-apply', retentionApply],
  ])

  /**
   * 执行一次动作。**永不抛**：面板上的一次误操作不该把宿主的路由打挂。
   *
   * @param {string} action
   * @param {object} payload
   */
  async function handle(action, payload = {}) {
    const id = asString(action)
    if (!id) return { ok: false, reason: 'missing-action', error: '要给一个 action', actions: ADMIN_ACTIONS.map((a) => a.id) }
    if (!ACTION_IDS.has(id)) {
      return { ok: false, reason: 'unknown-action', error: `不认识的动作：${id}`, actions: ADMIN_ACTIONS.map((a) => a.id) }
    }
    const blocked = ready()
    if (blocked) return blocked
    const fn = READ.get(id) ?? WRITE.get(id)
    if (!fn) return { ok: false, reason: 'unimplemented', error: `${id} 还没实现（枚举里有、实现里没有，属我方缺陷）` }
    try {
      return await fn(payload && typeof payload === 'object' ? payload : {})
    } catch (error) {
      const message = String(error?.message ?? error)
      log?.warn?.(`管理动作 ${id} 失败（已吞，不影响宿主）：${message}`)
      return { ok: false, reason: 'error', error: message }
    }
  }

  return {
    handle,
    bind,
    actions: ADMIN_ACTIONS,
    status: () => ({ vaultDir, actions: ADMIN_ACTIONS.map((a) => a.id), hasVault: !!vault, hasExperience: !!experience }),
  }
}
