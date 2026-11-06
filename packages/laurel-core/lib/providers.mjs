/**
 * laurel-memory/providers —— 三个模型来源的**真实**实现。
 *
 * 之前 gateway 只是预算账本 + provider 注入点，仓库里没有任何会真正发请求的代码。
 * 这个文件补上：`none`（不接）、`local`（本地端点）、`api`（远端兼容端点）。
 *
 * 纪律：
 *  1. 只用 Node 内置 fetch，零第三方依赖。
 *  2. 密钥只从显式配置或环境变量读，**绝不打印、绝不写日志、绝不进错误信息**。
 *  3. 本地失败**不自动转远端**（避免费用失控与数据外泄）。
 *  4. 超时必须可控，且取消要能真的中断。
 *  5. 返回结构统一，usage 拿不到就明确说 unknown，不填 0 冒充。
 */

/** 支持的协议形状。都是 OpenAI 兼容或常见本地端点。 */
export const PROTOCOL_SHAPES = Object.freeze(['openai-chat', 'ollama-chat'])

export const DEFAULT_TIMEOUT_MS = 60_000

/** 把密钥打码，任何日志/错误里出现都替换掉。 */
export function redact(text, secrets = []) {
  let s = String(text ?? '')
  for (const sec of secrets) {
    if (!sec || String(sec).length < 6) continue
    s = s.split(String(sec)).join('***')
  }
  // 常见形态兜底
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-]{12,}/g, 'Bearer ***')
  s = s.replace(/\bsk-[A-Za-z0-9_\-]{12,}\b/g, 'sk-***')
  s = s.replace(/("?(?:api_?key|token|authorization)"?\s*[:=]\s*)"[^"]{8,}"/gi, '$1"***"')
  return s
}

/** 从环境变量或配置里取密钥（不落盘、不回显）。 */
export function resolveSecret(cfg = {}) {
  if (cfg.apiKey) return String(cfg.apiKey)
  const envName = cfg.apiKeyEnv ?? 'LAUREL_MODEL_API_KEY'
  const v = process.env[envName]
  return v ? String(v) : null
}

function stripTrailingSlash(u) {
  return String(u ?? '').replace(/\/+$/, '')
}

/**
 * 构造请求体（按协议形状）。
 * @returns {{url:string, headers:object, body:object}}
 */
export function buildRequest({ shape, baseUrl, model, prompt, maxOutputTokens, apiKey }) {
  if (!PROTOCOL_SHAPES.includes(shape)) throw new TypeError(`不支持的协议形状: ${shape}`)
  if (!baseUrl) throw new TypeError('缺 baseUrl')
  if (!model) throw new TypeError('缺 model')
  const base = stripTrailingSlash(baseUrl)

  if (shape === 'openai-chat') {
    const headers = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    return {
      url: `${base}/chat/completions`,
      headers,
      body: {
        model,
        messages: [{ role: 'user', content: String(prompt ?? '') }],
        max_tokens: maxOutputTokens,
        stream: false,
      },
    }
  }
  // ollama-chat：本地 Ollama 的 /api/chat
  return {
    url: `${base}/api/chat`,
    headers: { 'content-type': 'application/json' },
    body: {
      model,
      messages: [{ role: 'user', content: String(prompt ?? '') }],
      stream: false,
      options: { num_predict: maxOutputTokens },
    },
  }
}

/** 从响应体里抽正文与 usage（协议差异在这里收敛）。 */
export function parseResponse(shape, json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'bad-response' }
  if (shape === 'openai-chat') {
    const text = json.choices?.[0]?.message?.content
    if (typeof text !== 'string') return { ok: false, reason: 'no-content', raw: json }
    return {
      ok: true,
      text,
      usage: json.usage ? { inputTokens: json.usage.prompt_tokens ?? null, outputTokens: json.usage.completion_tokens ?? null } : null,
      model: json.model ?? null,
    }
  }
  // ollama
  const text = json.message?.content
  if (typeof text !== 'string') return { ok: false, reason: 'no-content', raw: json }
  const usage = (json.prompt_eval_count != null || json.eval_count != null)
    ? { inputTokens: json.prompt_eval_count ?? null, outputTokens: json.eval_count ?? null }
    : null
  return { ok: true, text, usage, model: json.model ?? null }
}

/**
 * 真 provider：会真的发 HTTP。
 * @returns {{name:string, shape:string, complete:Function, probe:Function}}
 */
export function createProvider(cfg = {}) {
  const {
    shape = 'openai-chat',
    baseUrl,
    model,
    apiKey = null,
    apiKeyEnv = 'LAUREL_MODEL_API_KEY',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    extraHeaders = {},
  } = cfg

  if (typeof fetchImpl !== 'function') throw new TypeError('需要 fetch（Node >= 18）')
  if (!baseUrl) throw new TypeError('createProvider 需要 baseUrl')

  const secret = apiKey ?? resolveSecret({ apiKeyEnv })
  const secretsToRedact = secret ? [secret] : []

  async function complete({ prompt, input, maxOutputTokens = 512, signal, timeoutMs: perCall } = {}) {
    const text = prompt ?? input ?? ''
    const req = buildRequest({ shape, baseUrl, model, prompt: text, maxOutputTokens, apiKey: secret })

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), perCall ?? timeoutMs)
    // 调用方的取消要真的传下去
    const onAbort = () => ctrl.abort(new Error('cancelled'))
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw new Error('cancelled') }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const res = await fetchImpl(req.url, {
        method: 'POST',
        headers: { ...req.headers, ...extraHeaders },
        body: JSON.stringify(req.body),
        signal: ctrl.signal,
      })
      const raw = await res.text()
      if (!res.ok) {
        const err = new Error(redact(`HTTP ${res.status}: ${raw.slice(0, 300)}`, secretsToRedact))
        err.status = res.status
        throw err
      }
      let json
      try { json = JSON.parse(raw) } catch { throw new Error('响应不是 JSON') }
      const parsed = parseResponse(shape, json)
      if (!parsed.ok) throw new Error(redact(`响应缺正文: ${String(parsed.reason)}`, secretsToRedact))
      return { ok: true, text: parsed.text, usage: parsed.usage, model: parsed.model, unknownUsage: parsed.usage === null }
    } catch (e) {
      // 保留原始错误的 status/name，否则调用方无法按状态码决定重试策略
      const wrapped = new Error(redact(String(e?.message ?? e), secretsToRedact))
      if (e?.status !== undefined) wrapped.status = e.status
      wrapped.name = e?.name ?? 'Error'
      wrapped.cause = e
      throw wrapped
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  /** 探活：只发一个极小请求，确认端点与模型都在。 */
  async function probe({ timeoutMs: t } = {}) {
    try {
      const r = await complete({ prompt: 'ping', maxOutputTokens: 4, timeoutMs: t ?? 10_000 })
      return { ok: true, model: r.model ?? model, sample: String(r.text ?? '').slice(0, 40), usage: r.usage }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  return { name: `${shape}@${stripTrailingSlash(baseUrl)}`, shape, model, complete, probe }
}

/** `none` 来源：明确什么都不做，调用即拒（不是静默返回空）。 */
export function createNullProvider() {
  return {
    name: 'none',
    shape: 'none',
    complete: async () => { throw new Error('模型来源为 none，不发起任何调用') },
    probe: async () => ({ ok: false, error: '来源为 none' }),
  }
}

/**
 * 按来源构造 provider。
 * @param {{source:'none'|'local'|'api'}} cfg
 */
export function providerForSource(cfg = {}) {
  const { source = 'none' } = cfg
  if (source === 'none') return createNullProvider()
  if (source === 'local' || source === 'api') {
    return createProvider({
      shape: cfg.shape ?? 'openai-chat',
      baseUrl: cfg.baseUrl ?? (source === 'local' ? 'http://127.0.0.1:11434/v1' : null),
      model: cfg.model,
      apiKeyEnv: cfg.apiKeyEnv ?? (source === 'api' ? 'LAUREL_MODEL_API_KEY' : 'LAUREL_LOCAL_MODEL_KEY'),
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      fetchImpl: cfg.fetchImpl,
    })
  }
  throw new TypeError(`未知来源: ${source}`)
}

/** 三个来源的能力矩阵（用于界面与文档，不含密钥）。 */
export function sourceMatrix(cfg = {}) {
  return ['none', 'local', 'api'].map((source) => ({
    source,
    needsKey: source === 'api',
    defaultBaseUrl: source === 'local' ? 'http://127.0.0.1:11434/v1' : (source === 'api' ? '(需配置)' : null),
    sendsDataOffMachine: source === 'api',
    canBeUsedOffline: source !== 'api',
    note: source === 'none' ? '零推理：0 次调用，全部功能仍可用' : (source === 'local' ? '本机端点，数据不出机器' : '远端端点，会发出提示词与上下文'),
  }))
}
