/**
 * laurel-memory/experience/skill —— Skill 投影（S06）。
 *
 * 纪律：
 *  1. 稳定 ID 由 adopted 记录 id + 方法指纹派生，防同名覆盖。
 *  2. Skill 文件、检索缓存、投影正文共用同一个 contentVersion；
 *     任一处改动 → 全部失效（F3 同类）。
 *  3. Skill 不默认执行经验里的命令；它只是可读手册，执行需用户另外授权。
 */
import { contentHash, canonical } from '../../../laurel-core/lib/format.mjs'
import { usableForRecommendation } from './lifecycle.mjs'
import { methodFingerprint } from './method.mjs'

export function skillId(record) {
  const fp = record.fingerprint ?? (record.method ? methodFingerprint(record.method) : null)
  return 'sk-' + contentHash({ experienceId: record.id, fingerprint: fp }).slice(0, 20)
}

/**
 * 投影成一个可读 Skill 手册（Markdown）。
 * 只允许 adopted 且方法齐备的经验投影；否则返回原因。
 */
export function projectSkill(record, { at = Date.now() } = {}) {
  if (!record) return { ok: false, reason: 'missing-record' }
  if (record.state !== 'adopted') return { ok: false, reason: 'not-adopted', state: record.state }
  if (record.methodOk === false) return { ok: false, reason: 'method-incomplete', missing: record.methodMissing }
  if (!usableForRecommendation(record)) return { ok: false, reason: 'verification-failed' }
  const m = record.method ?? {}
  const id = skillId(record)
  const contentVersion = record.contentVersion
  const lines = [
    `# ${m.title ?? '经验手册'}`,
    '',
    `- 适用环境：${envText(m.applicableEnv)}`,
    `- 操作：${actionText(m.action)}`,
    `- 验证：${verifyText(m.verification)}`,
    `- 限制：${limitsText(m.limits)}`,
    `- 来源：${evidenceText(m.evidence, record)}`,
    '',
    '> 本手册只作参考，不会自动执行其中命令。',
  ]
  const body = lines.join('\n')
  return {
    ok: true,
    skill: {
      id, experienceId: record.id, contentVersion,
      revision: record.revision,
      at,
      body,
      hash: contentHash(body),
      // 手册与投影正文绑定同一版本；任何一处变，另一处即失效
      binding: { experienceRevision: record.revision, contentVersion },
    },
  }
}

function envText(env) {
  if (!env) return '（未注明）'
  const parts = [env.projectId, env.environmentId, env.os, env.shell].filter(Boolean)
  return parts.length ? parts.join(' / ') : '（未注明）'
}
function actionText(action) {
  if (!action) return '（未注明）'
  if (typeof action === 'string') return action
  return [action.tool, action.command, action.args ? JSON.stringify(action.args) : null].filter(Boolean).join(' ')
}
function verifyText(v) {
  if (!v) return '（未注明）'
  return `${v.result ?? 'unknown'}${(v.how ?? v.method) ? ' · ' + (v.how ?? v.method) : ''}${v.evidence?.length ? ' · 证据 ' + v.evidence.length + ' 条' : ''}`
}
function limitsText(l) {
  if (!l) return '（未注明）'
  if (typeof l === 'string') return l
  if (Array.isArray(l)) return l.join('；')
  return [l.preconditions, l.notApplicable, l.notes].filter(Boolean).join('；') || '（未注明）'
}
function evidenceText(e, record) {
  const ids = []
  if (Array.isArray(e)) ids.push(...e.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean))
  else if (e) ids.push(typeof e === 'string' ? e : e.id)
  if (record?.legacyId) ids.push(`legacy:${record.legacyId}`)
  return ids.length ? ids.join(', ') : '（未注明）'
}

/**
 * 校验一个已存在的 Skill 是否仍与经验版本一致（F3 的运行时检查）。
 * 不一致 → 必须失效，不能继续注入。
 */
export function validateSkillBinding(skill, record) {
  if (!skill || !record) return { valid: false, reason: 'missing' }
  if (record.state !== 'adopted') return { valid: false, reason: 'not-adopted', state: record.state }
  if (!usableForRecommendation(record)) return { valid: false, reason: 'verification-failed' }
  if (skill.binding?.contentVersion !== record.contentVersion) {
    return { valid: false, reason: 'content-changed', skillVersion: skill.binding?.contentVersion, recordVersion: record.contentVersion }
  }
  if (skill.binding?.experienceRevision !== record.revision) {
    return { valid: false, reason: 'revision-changed', skillRevision: skill.binding?.experienceRevision, recordRevision: record.revision }
  }
  return { valid: true }
}

/** 同名防覆盖：多份 Skill 的 id 必须唯一；同名不同 id 允许并存，但冲突要报出来。 */
export function detectNameClash(skills) {
  const byTitle = new Map()
  for (const s of skills ?? []) {
    const title = /^#\s*(.+)$/m.exec(s.body ?? '')?.[1] ?? s.id
    if (!byTitle.has(title)) byTitle.set(title, [])
    byTitle.get(title).push(s.id)
  }
  return [...byTitle.entries()].filter(([, ids]) => new Set(ids).size > 1).map(([title, ids]) => ({ title, ids }))
}
