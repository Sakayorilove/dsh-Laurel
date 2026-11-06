/**
 * laurel-memory/host-model —— 直接用**宿主设置页里那批供应商与模型**
 *
 * ── 为什么是这个形状（2026-10-25 改为直接复用宿主设置）─────────────────────
 * D143 的第三条来源叫「harness 直连」，实现方式是：读 `<DSH_HOME>/openai-gateway/api-key`、
 * GET 本机网关的 `/v1/models`、再从宿主会话投影里猜「当前正在用的模型」。
 * 那条路能跑，但每一步都是外部猜测：
 *   - 网关是**第三方插件**（dsh-our-free-model 内嵌的 channel-pack）提供的，
 *     宿主自己的组合里根本没有它 —— 桌面 profile 实测该网关没有监听，
 *     面板因此永远显示「harness 网关现在不可用」；
 *   - 密钥文件、端口、模型 id 前缀规则都是别人的实现细节；
 *   - 「当前模型」从会话投影里翻，等于替宿主猜它想用哪个模型。
 *
 * 需求是：直接复用设置页里那些供应商，再选对应的模型。
 * 宿主（DeepSeek-Harness）本来就有官方的 `llm` 服务，它的 README 写明
 * "Choose this package whenever a plugin or composition needs to call a model:
 * it is the only supported path into provider adapters"。设置页里能选的那些
 * 供应商（llm-pi-ai 的 beichen-gpt、deepseek-official、deepseek-account …）
 * 全都注册在这个服务里。于是这里只做三件事：
 *   1. `listProviders()` + `listModels(provider)` 把**目录**交给设置页下拉框；
 *   2. 用户在面板里选定 (provider, model) 后，用 `llm.stream()` 直接发请求；
 *   3. 探活 = 校验 provider 已注册且模型可解析（**不花钱**，不是一次真调用）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *  1. 本包**不 import 宿主的任何包**（laurel-memory 的 package.json 里没有
 *     @deepseek-ai/* 依赖，装不进来）。所有对 llm 服务的调用都是**鸭子类型**：
 *     只要求 `listProviders / listModels / resolveModelInfo / stream` 存在。
 *  2. 服务**每次现取**（`getLlm()` 回调）：宿主里 llm 服务晚于插件 apply 才挂上
 *     是常态，apply 期存一份 null 就再也拿不到了（S1 踩过同一个坑）。
 *  3. 任何一步失败都返回 `{ok:false, reason}`，**不抛**（探活/目录用）；
 *     真正发请求的 `complete()` 则必须抛 —— 网关据此记账并把失败理由交回调用方。
 *  4. 密钥不经过本模块：凭据由宿主自己的 adapter 管（env / 宿主设置页），
 *     本模块只看得到 provider id 与 model id，日志里也只出现这两个。
 *
 * @module host-model
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 探活/目录查询的上限：目录查询是本地元数据，不该让面板等太久。 */
export const CATALOG_TIMEOUT_MS = 4000

/** 单次补全的默认上限（网关不会传，调用方也可以覆盖）。 */
export const DEFAULT_TIMEOUT_MS = 60_000

/**
 * 解析 DSH_HOME：与宿主 home-paths 同一规则（$DSH_HOME 优先，否则 ~/.dsh）。
 *
 * 这个函数原来住在 harness-model.mjs 里，被核心仓路径解析（index.js）与
 * 旧的网关发现共用。删掉网关那套之后仍然需要它 —— 桌面版宿主的插件跑在
 * Electron 子进程里，**那个环境没有 DSH_HOME**，只认环境变量会让
 * `~/.dsh/laurel-core` 兜底失效（D47 的教训）。
 *
 * @param {Record<string, string|undefined>} env
 * @param {string|null} fallbackHome
 */
export function resolveDshHome(env = process.env, fallbackHome = null) {
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromEnv) return fromEnv
  const base = fallbackHome ?? homedir()
  return join(base, '.dsh')
}

/** 宿主的 llm 服务长什么样（鸭子类型，只列我们真正用到的四个方法）。 */
export function isLlmService(value) {
  return !!value
    && typeof value.listProviders === 'function'
    && typeof value.stream === 'function'
}

/**
 * 造一个「每次调用现取」的 llm 视图。
 * @param {() => any} getLlm
 */
function llmView(getLlm) {
  let service = null
  try { service = typeof getLlm === 'function' ? getLlm() : getLlm } catch { service = null }
  return isLlmService(service) ? service : null
}

/** 带超时的 AbortSignal（宿主不保证 adapter 守时，面板不能一直转圈）。 */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * 列出宿主已注册的供应商。
 * @param {() => any} getLlm
 * @returns {{ok: boolean, reason: string|null, providers: Array<{id: string, name: string}>}}
 */
export function listHostProviders(getLlm) {
  const llm = llmView(getLlm)
  if (!llm) return { ok: false, reason: '宿主没有提供 llm 服务（这个组合里没有装载模型供应商）', providers: [] }
  let rows
  try { rows = llm.listProviders() } catch (e) {
    return { ok: false, reason: `列供应商失败：${String(e?.message ?? e)}`, providers: [] }
  }
  const providers = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row.id === 'string' && row.id)
    .map((row) => ({ id: row.id, name: typeof row.name === 'string' && row.name ? row.name : row.id }))
    // 同一 provider 只留一条：设置页里出现两个同名项等于让用户选了个寂寞
    .filter((row, i, all) => all.findIndex((other) => other.id === row.id) === i)
  if (providers.length === 0) return { ok: false, reason: '宿主 llm 服务里一个供应商都没注册', providers: [] }
  return { ok: true, reason: null, providers }
}

/**
 * 供应商目录 + 每家的模型目录 —— 设置页下拉框的数据源。
 *
 * 单个供应商的 `listModels` 失败**不拖垮整份目录**：有的 adapter 要联网才发现
 * 模型（账号型），它报错时其余供应商仍然可选。失败的项带 `modelsOk:false` 与
 * 原因，面板据此退化成「直接填模型 id」而不是显示一个空下拉框。
 *
 * @param {() => any} getLlm
 * @param {{timeoutMs?: number}} [options]
 */
export async function listHostCatalog(getLlm, { timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
  const listed = listHostProviders(getLlm)
  if (!listed.ok) return { ok: false, reason: listed.reason, providers: [] }
  const llm = llmView(getLlm)
  const providers = []
  for (const provider of listed.providers) {
    if (typeof llm.listModels !== 'function') {
      providers.push({ ...provider, models: [], modelsOk: false, modelsError: '宿主的 llm 服务没有 listModels' })
      continue
    }
    const guard = withTimeout(undefined, timeoutMs)
    try {
      const rows = await llm.listModels(provider.id, guard.signal)
      const models = (Array.isArray(rows) ? rows : [])
        .filter((row) => row && typeof row.id === 'string' && row.id)
        .map((row) => ({ id: row.id, name: typeof row.name === 'string' && row.name ? row.name : row.id }))
      providers.push({ ...provider, models, modelsOk: true, modelsError: null })
    } catch (e) {
      providers.push({ ...provider, models: [], modelsOk: false, modelsError: String(e?.message ?? e) })
    } finally {
      guard.dispose()
    }
  }
  return { ok: true, reason: null, providers }
}

/**
 * 宿主「默认模型」（设置页里 agent-default-model 那份配置）。
 *
 * 只是给面板一个「用宿主默认模型」的按钮值，**不参与路由**：用户没选的时候
 * 我们不会偷偷用这个去发请求（那又会变成替用户猜）。
 *
 * @param {any} ctx
 */
export function hostDefaultSelection(ctx) {
  try {
    const service = ctx?.get?.('agentDefaultModel')
    const found = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
    if (!found || typeof found.provider !== 'string' || typeof found.model !== 'string') {
      return { ok: false, provider: null, model: null, reason: '宿主没有公布默认模型' }
    }
    if (!found.provider || !found.model) return { ok: false, provider: null, model: null, reason: '宿主默认模型是空的' }
    return { ok: true, provider: found.provider, model: found.model, reason: null }
  } catch (e) {
    return { ok: false, provider: null, model: null, reason: String(e?.message ?? e) }
  }
}

/**
 * 校验一对 (provider, model) 现在真的能用 —— **不发补全请求**。
 *
 * 为什么不做一次真 ping（D143 的旧 probe 就是真发一次）：换一次下拉框就打一次
 * 模型、走一次配额，用户随手点两下就是钱。这里只查两件宿主自己就能回答的事：
 * provider 在不在注册表里、这个模型能不能被解析出来。
 *
 * @param {() => any} getLlm
 * @param {{provider: string, model: string, timeoutMs?: number}} sel
 */
export async function probeHostSelection(getLlm, { provider, model, timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
  if (!provider || !model) return { ok: false, reason: '还没选供应商或模型' }
  const listed = listHostProviders(getLlm)
  if (!listed.ok) return { ok: false, reason: listed.reason }
  if (!listed.providers.some((row) => row.id === provider)) {
    const names = listed.providers.map((row) => row.id).join(', ')
    return { ok: false, reason: `宿主里没有注册供应商「${provider}」；可选：${names}` }
  }
  const llm = llmView(getLlm)
  if (typeof llm.resolveModelInfo !== 'function') {
    // 老内核没有 resolveModelInfo：至少确认 provider 在（上面已确认），不拦。
    return { ok: true, provider, model, modelName: model, note: '宿主没有 resolveModelInfo，只校验了供应商' }
  }
  const guard = withTimeout(undefined, timeoutMs)
  try {
    const info = await llm.resolveModelInfo(provider, model, guard.signal)
    return {
      ok: true,
      provider,
      model,
      modelName: typeof info?.name === 'string' && info.name ? info.name : model,
      contextWindow: info?.context?.contextWindow ?? null,
      note: null,
    }
  } catch (e) {
    const code = typeof e?.code === 'string' ? `（${e.code}）` : ''
    return { ok: false, reason: `宿主不认这个模型${code}：${String(e?.message ?? e)}` }
  } finally {
    guard.dispose()
  }
}

/** 从 finish chunk 造失败：宿主把错误规范化成了终止块，不是抛出来的。 */
function failureOf(reason) {
  const failure = reason?.failure ?? {}
  const error = new Error(String(failure.message ?? '模型调用失败'))
  if (typeof failure.code === 'string') error.code = failure.code
  if (typeof failure.status === 'number') error.status = failure.status
  return error
}

/**
 * 造一个「走宿主 llm 服务」的 provider（形状与 laurel-core 的 provider 一致）。
 *
 * 契约（laurel-core/lib/gateway.mjs 的调用方视角）：
 *   `complete({ purpose, input, maxOutputTokens, signal, timeoutMs })`
 *     → `{ ok:true, text, usage:{inputTokens, outputTokens}|null, model, unknownUsage }`
 *   失败时**抛**（网关会把它记成 provider-error 并按预占保守结算）。
 *
 * @param {{
 *   getLlm: () => any,
 *   provider: string,
 *   model: string,
 *   timeoutMs?: number,
 *   log?: {warn?: Function},
 * }} cfg
 */
export function createHostProvider({
  getLlm, provider, model, timeoutMs = DEFAULT_TIMEOUT_MS, log = null,
} = {}) {
  if (typeof getLlm !== 'function' && !isLlmService(getLlm)) throw new TypeError('createHostProvider 需要 getLlm')
  if (!provider) throw new TypeError('createHostProvider 需要 provider')
  if (!model) throw new TypeError('createHostProvider 需要 model')

  async function complete({ input, prompt, system, maxOutputTokens, signal, timeoutMs: perCall } = {}) {
    const llm = llmView(getLlm)
    if (!llm) throw new Error('宿主没有提供 llm 服务，发不出请求')
    const text = String(input ?? prompt ?? '')
    if (!text.trim()) throw new Error('空输入，未发起请求')

    const guard = withTimeout(signal, perCall ?? timeoutMs)
    let acc = ''
    let usage = null
    let finish = null
    try {
      /** @type {any} 一次性请求：RequestUserInput 不带 id/source，正是给这种调用用的 */
      const request = { provider, model, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }
      if (typeof system === 'string' && system) request.system = system
      if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) request.maxTokens = maxOutputTokens
      request.signal = guard.signal
      for await (const chunk of llm.stream(request)) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') acc += chunk.text
        else if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage
        else if (chunk.type === 'finish') finish = chunk.reason ?? null
      }
    } finally {
      guard.dispose()
    }

    if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) throw failureOf(finish)
    if (finish && finish.kind === 'max-tokens') {
      const error = new Error('模型在输出上限处被截断（结果不完整）')
      error.code = 'MAX_TOKENS'
      throw error
    }
    if (!acc.trim() && finish && finish.kind === 'tool-calls') {
      throw new Error('模型返回了工具调用而不是文本（这条来源只接受纯文本）')
    }
    if (!acc.trim()) throw new Error('模型没有返回任何文本')
    return {
      ok: true,
      text: acc,
      usage: usage
        ? { inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null }
        : null,
      model,
      unknownUsage: !usage,
    }
  }

  return {
    name: `host-llm@${provider}/${model}`,
    shape: 'host-llm',
    provider,
    model,
    complete,
    /** 面板「为什么没生效」用：只查注册表与模型目录，不发请求。 */
    probe: (opts = {}) => probeHostSelection(getLlm, { provider, model, ...opts }),
    describe: () => probeHostSelection(getLlm, { provider, model }),
    setLog: (next) => { log = next },
  }
}
