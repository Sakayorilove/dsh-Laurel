/**
 * laurel-memory/gateway —— 模型网关（S08）。
 *
 * 纪律：
 *  1. 默认 Disabled：关闭时**无请求、无探测、无 Key 读取、无子进程**。
 *  2. 所有推理（LLM/embedding/rerank/采样/JSON 修复）统一过这一个网关。
 *  3. 发送**之前**持久预占预算；usage 到达再结算；结果未知按预占保守记账。
 *  4. 预算不可用 → 零新调用（fail-closed），不偷偷外发。
 *  5. 本地失败不自动转远程；API 失败不无限换模型；每次尝试计数。
 *  6. 独立核心不 import ctx；宿主模型服务只是可选的一条 provider。
 */
import { reserve, settle, todayUsage, systemTimeZone } from './budget.mjs'
import { sha256 } from './format.mjs'

/** 三档的独立整理任务限额（01 §2，初值，非实测最优）。 */
import { providerForSource, sourceMatrix } from './providers.mjs'

export const TIER_LIMITS = Object.freeze({
  zero: {
    maxRequestsPerDay: 0, maxInputTokensPerDay: 0, maxOutputTokensPerDay: 0,
    singleInputTokens: 0, singleOutputTokens: 0, concurrency: 0,
  },
  balanced: {
    maxRequestsPerDay: 4, maxInputTokensPerDay: 20_000, maxOutputTokensPerDay: 2_000,
    singleInputTokens: 6_000, singleOutputTokens: 600, concurrency: 1,
  },
  full: {
    maxRequestsPerDay: 12, maxInputTokensPerDay: 80_000, maxOutputTokensPerDay: 8_000,
    singleInputTokens: 10_000, singleOutputTokens: 1_000, concurrency: 1,
  },
})

export const MODEL_SOURCES = Object.freeze(['none', 'local', 'api'])

/**
 * 建网关。
 * @param {{vaultDir:string, tier:'zero'|'balanced'|'full', source:'none'|'local'|'api',
 *          provider?:{complete:Function}, timeZone?:string, clock?:Function}} cfg
 */
export function createGateway(cfg) {
  const {
    vaultDir, tier = 'zero', source = 'none',
    provider = null, timeZone = systemTimeZone(), clock = Date.now,
  } = cfg
  const limits = TIER_LIMITS[tier] ?? TIER_LIMITS.zero
  let inflight = 0
  const calls = []

  /** 该网关当前是否允许发起任何模型调用。 */
  function status() {
    const reasons = []
    if (tier === 'zero') reasons.push('tier-zero')
    if (source === 'none') reasons.push('source-none')
    if (!provider) reasons.push('no-provider')
    if (limits.maxRequestsPerDay === 0) reasons.push('request-limit-zero')
    return { enabled: reasons.length === 0, reasons, tier, source, limits }
  }

  /**
   * 一次受预算约束的调用。
   * @param {{purpose:string, input:string, maxOutputTokens?:number, signal?:AbortSignal}} req
   */
  async function complete(req) {
    const st = status()
    if (!st.enabled) {
      return { ok: false, reason: 'disabled', details: st.reasons, charged: null, note: '未发起任何请求' }
    }
    if (limits.concurrency > 0 && inflight >= limits.concurrency) {
      return { ok: false, reason: 'concurrency-limit', inflight, limit: limits.concurrency }
    }
    const inputTokens = estimateTokens(req.input)
    const maxOutput = Math.min(req.maxOutputTokens ?? limits.singleOutputTokens, limits.singleOutputTokens)
    if (limits.singleInputTokens > 0 && inputTokens > limits.singleInputTokens) {
      return { ok: false, reason: 'single-input-limit', inputTokens, limit: limits.singleInputTokens }
    }
    const res = reserve(vaultDir, { limits, estimateInput: inputTokens, maxOutput, timeZone, at: clock(), purpose: req.purpose })
    if (!res.ok) {
      return { ok: false, reason: 'budget', details: res, charged: null, note: '预算不足/账本不可用 → 零新调用' }
    }
    inflight++
    const startedAt = clock()
    const call = { purpose: req.purpose, inputHash: sha256(req.input).slice(0, 16), reservationId: res.reservationId, startedAt, state: 'inflight' }
    calls.push(call)
    try {
      if (req.signal?.aborted) {
        settle(vaultDir, res, { unknown: true })
        call.state = 'cancelled'
        return { ok: false, reason: 'cancelled', charged: { input: inputTokens, output: maxOutput } }
      }
      const out = await provider.complete({
        purpose: req.purpose, input: req.input, maxOutputTokens: maxOutput, signal: req.signal,
      })
      // usage 到达则按实结算；否则保守按预占
      const usage = out?.usage
      const s = settle(vaultDir, res, usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {})
      call.state = s.unknown ? 'settled-unknown' : 'settled'
      call.usage = s.charged
      call.unknown = s.unknown
      return { ok: true, text: out?.text ?? '', usage: s.charged, unknownUsage: s.unknown, reservationId: res.reservationId }
    } catch (e) {
      // 失败/超时：不重试到另一个后端；结果未知按预占记账
      const s = settle(vaultDir, res, { unknown: true })
      call.state = 'failed'
      call.error = String(e?.message ?? e)
      call.usage = s.charged
      return { ok: false, reason: 'provider-error', error: call.error, charged: s.charged, note: '本地失败不自动转远程' }
    } finally {
      inflight--
    }
  }

  // 便捷：按来源现造一个真 provider（不在构造期发任何请求）
  function makeProvider(opts = {}) {
    return providerForSource({ ...opts, source: opts.source ?? source })
  }

  return {
    status, complete, limits, calls,
    usageToday: () => todayUsage(vaultDir, { timeZone, limits, at: clock() }),
    makeProvider,
    sourceMatrix,
  }
}

/**
 * 粗估 token：CJK 按 1 字符 ≈ 1 token，拉丁按 4 字符 ≈ 1 token。
 * **这是估算，不是实计**；回传时必须标注 basis。
 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0, other = 0
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/**
 * 输出校验：模型只能产出候选 + 有效引用。
 * 跨域/不存在 evidenceId/伪造成功 → 拒绝。
 */
export function validateModelOutput(out, { allowedProjects, knownEvidenceIds, projectId }) {
  const problems = []
  if (!out || typeof out !== 'object') return { ok: false, problems: ['输出不是对象'] }
  if (out.projectId && allowedProjects && !allowedProjects.includes(out.projectId)) problems.push('跨域：projectId 不在允许范围')
  if (out.projectId && projectId && out.projectId !== projectId) problems.push('跨域：projectId 与当前项目不符')
  for (const id of out.evidenceIds ?? []) {
    if (knownEvidenceIds && !knownEvidenceIds.has(id)) problems.push(`引用不存在：${id}`)
  }
  if (out.claimVerified === true && !(out.evidenceIds?.length)) problems.push('伪造成功：声称已验证但无证据引用')
  if (out.status && out.status === 'adopted') problems.push('模型不得直接把结果标为 adopted')
  return { ok: problems.length === 0, problems }
}
