/**
 * laurel-context/compaction —— **只** 提供 `compaction` 服务的窄入口（S7）。
 *
 * ## 为什么需要第二个入口
 *
 * `laurel-context`（`lib/index.js`）是全局一份的入口，它 provide `laurel.context`。
 * 而接管必须发生在**每个 agent 预设的 compaction 组内部**（`isolate: {compaction:true}`
 * 让组用私有 symbol 解析服务，根层 provide 到不了 —— 陷阱 3）。
 * 如果直接把整个 `laurel-context` 塞进四个预设组，第二次加载就会在
 * `laurel.context` 上撞名抛 `service "laurel.context" has been registered`。
 *
 * 所以拆成两个入口（手册 5.2 ① / MC14）：
 *
 * | 入口 | 在哪加载 | 提供什么 |
 * |---|---|---|
 * | `laurel-context` | profile 根层 | `laurel.context`、数据面、UI、引擎、摄取 |
 * | `laurel-context/compaction`（本文件） | **每个预设的 compaction 组内** | **只** `compaction` |
 *
 * 本文件不 provide `laurel.context`、不挂 webServer、不注册任何 tool。
 *
 * ## 契约（陷阱 2）
 *
 * 真实契约只有一条：`ctx.provide('compaction', <CompactionEngine 形状的实现>)`。
 * 宿主源码里 `CompactionEngine extends Service`，实例上只有 `ctx` / `name` 和
 * 三个方法 —— **没有 `setProvider` / `register`**。本文件也只走这一条。
 *
 * 三个方法的真实签名（`implementation/.asar-extract/compaction-index.js`）：
 *   compactIfNeeded(agent, trigger, signal)
 *   compactNow(agent, signal, sourceCommandId)
 *   compactRegion(start, end, agent, signal)
 *
 * ## 引擎复用（S7 第 3 条）
 *
 * 引擎一律来自 `./engine.mjs` 的 `createEngine`，**不写第二份**；仓一律走
 * `openVault` / `initVault`。与 `lib/index.js` 共享同一个 vault（`overlay.mjs` 的
 * 模块级 registry 是那条共享通道 —— 同一条 import 路径拿到同一个模块实例）。
 * 引擎按 **sessionId** 缓存：一台引擎只装一个会话的事件，跨会话不混（L11）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openVault, initVault } from '../../laurel-core/lib/vault.mjs'
import { createEngine } from './engine.mjs'
import { makeHostProvider } from './host-compaction.mjs'
// L09 第二处：端点要把「真正拿去比 ratio 的阈值」报出来，所以这里也要这份解析。
import { resolveTriggerRatio } from './compaction-provider.mjs'
// L10：entry 才是**真正对外提供 compaction 的那个入口**，它也必须用宿主投影量。
// 此前它拿 runtime.limitTokens（默认 200_000）判触发，而端点 stats 报的是
// lib/index.js 那条路的 limitTokens（1,000,000）—— 同一个端点里两个真相。
import { readProjectedPressure, usedTokensOf } from './host-pressure.mjs'
import {
  LAUREL_COMPACTION_ENTRY,
  isLaurelProvider,
  registerLaurelProvider,
  shareLaurelRuntime,
  sharedRuntime,
} from './overlay.mjs'

/** 插件名：与 `dir`/`id` 无关，宿主按 name 解析模块。 */
export const name = 'laurel-context-compaction'

/** 不 inject 任何服务：本入口不依赖 webServer / 别的宿主服务。 */
export const inject = []

/** 与 `exports["./compaction"]` 同值，供端点与测试比对。 */
export const ENTRY_SPECIFIER = LAUREL_COMPACTION_ENTRY

function makeLogger(level = 'info') {
  const rank = { debug: 10, info: 20, warn: 30, error: 40 }
  const min = rank[level] ?? 20
  const make = (n, fn) => (...args) => {
    if ((rank[n] ?? 20) < min) return
    try { fn('[laurel-context/compaction]', ...args) } catch { /* ignore */ }
  }
  return {
    debug: make('debug', console.debug.bind(console)),
    info: make('info', console.info.bind(console)),
    warn: make('warn', console.warn.bind(console)),
    error: make('error', console.error.bind(console)),
  }
}

/**
 * DSH 家目录：`DSH_HOME`（有就用）→ 否则 `~/.dsh`。与 `lib/index.js` 同一套理由（D47）。
 *
 * 2026-10-23：本包原先 `lib/index.js` 与这里各有一份**逐字相同**的副本，收敛成这一份。
 * 为什么放在本文件而不是 index.js：index.js 已经在顶部 import 本文件的
 * `compactionEntryStatus`，反过来让本文件 import index.js 会形成**循环依赖**
 * （那个循环下拿到的是未初始化绑定，index.js:84-87 的注释记的正是这个坑）。
 * 所以方向只能是「本文件导出、index.js 导入」，不给依赖图添新边。
 */
export function resolveDshHome() {
  const home = process.env.DSH_HOME
  if (home && home.length > 0) return home
  return join(homedir(), '.dsh')
}

function resolveVaultDir(config = {}) {
  if (config.vaultDir) return config.vaultDir
  const shared = sharedRuntime()
  if (shared.vaultDir) return shared.vaultDir
  const home = resolveDshHome()
  return home ? join(home, 'laurel-core') : null
}

/**
 * 打开（必要时初始化）核心仓。优先复用 `lib/index.js` 已经打开的那一份 ——
 * 两个入口必须看同一份仓，否则摘要写在一处、取回读另一处。
 */
function openSharedVault(dir, config = {}, log) {
  const shared = sharedRuntime()
  if (shared.vault && shared.vaultDir === dir) return shared.vault
  try {
    return openVault(dir)
  } catch (e) {
    if (/不是核心仓/.test(String(e?.message ?? e))) {
      return initVault(dir, { coreId: config.coreId ?? 'core-default' })
    }
    // 读不懂的仓不覆盖（与 index.js 同一策略）
    log.warn(`核心仓读取失败（不覆盖）：${e?.message ?? e}`)
    throw e
  }
}

/** 取这次调用针对的宿主 session。 */
function sessionOf(agent) {
  if (!agent || typeof agent !== 'object') return null
  if (agent.session && typeof agent.session === 'object') return agent.session
  if (agent.surface && typeof agent.surface === 'object') return agent
  return null
}

/** 进程级运行态：四个预设各 apply 一次，共用这一份。 */
const runtime = {
  /** sessionId → engine */
  engines: new Map(),
  /** sessionId → 宿主形状 provider 门面 */
  providers: new Map(),
  vault: null,
  vaultDir: null,
  gateway: null,
  tier: 'zero',
  limitTokens: 200_000,
  triggerRatio: null,
  /** 最近一次 apply 的结果（端点/测试读数用）。 */
  last: null,
  applies: [],
  /** 宿主 Context（apply 时记下）：读 sessionProjections 必须走它。 */
  ctx: null,
  /** 本次调用针对的宿主 session（门面每次调用前写入），读投影时要用。 */
  callSession: null,
  /** 事件流里最近见到的宿主 session：端点随时可读，不必等第一次压缩调用。 */
  trackedSession: null,
}

function engineFor(sessionId, config, vault) {
  const sid = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'host'
  const shared = sharedRuntime()
  // 与 lib/index.js 用同一会话时，直接复用那一份引擎（同一份 revision / 水位）。
  if (shared.engine && shared.sessionId === sid) {
    runtime.engines.set(sid, shared.engine)
    return shared.engine
  }
  const hit = runtime.engines.get(sid)
  if (hit) return hit
  const engine = createEngine({
    vault,
    sessionId: sid,
    tier: runtime.tier,
    limitTokens: runtime.limitTokens,
    ...(runtime.triggerRatio === null ? {} : { triggerRatio: runtime.triggerRatio }),
    guard: config.guard ?? null,
  })
  runtime.engines.set(sid, engine)
  return engine
}

/**
 * 当前真实窗口上限（L10）。
 *
 * 三级：宿主投影 contextWindow → 配置/运行态 limitTokens → 200_000 兜底。
 * **每次调用都重解**：apply 期宿主没有 session、投影还没物化，那一刻的值是假的。
 * 端点也要报这个值 —— 否则「entry.limitTokens=200000 而 stats.limitTokens=1000000」
 * 的自相矛盾会一直挂在那儿，下一个读端点的人还会以为判据是 200k。
 */
function liveLimitNow() {
  // 优先本次调用精确对应的会话；没调用过就用事件流里最近见到的那一个。
  // 两个都为空才说明宿主还没建会话 —— 那时确实只能报配置值，但要标 fallback。
  const live = readProjectedPressure(runtime.ctx, runtime.callSession ?? runtime.trackedSession)
  if (Number.isFinite(live?.contextWindow) && live.contextWindow > 0) return live.contextWindow
  if (Number.isFinite(runtime.limitTokens) && runtime.limitTokens > 0) return runtime.limitTokens
  return 200_000
}

/** 取（必要时建）该会话的宿主形状 provider。门面本身无状态，三个方法现取 session。 */
function providerFor(session, config, vault) {
  const sid = session?.id ?? (typeof config.sessionId === 'string' ? config.sessionId : null)
  const key = typeof sid === 'string' && sid.length > 0 ? sid : 'host'
  const hit = runtime.providers.get(key)
  if (hit) return hit
  // L10：窗口上限与用量都从宿主官方投影**现读**（见 liveLimitNow 的注释）。
  // 传函数而不是数字：apply 期求出的 200_000 被 provider 闭包记住就是一辈子。
  const liveLimit = liveLimitNow
  const provider = makeHostProvider({
    // 兜底：正常情况下宿主调用时会把 agent 传进来，我们从 agent.session 取那次真实会话
    session: null,
    vault,
    gateway: runtime.gateway ?? null,
    tier: runtime.tier,
    limitTokens: liveLimit,
    // L10：投影拿得到就用它当用量口径；拿不到返回 NaN，provider 退出真实口径判断
    // （不许把「字符数 ≈ token」当 quota 报账）。
    measure: () => {
      const v = usedTokensOf(readProjectedPressure(runtime.ctx, runtime.callSession ?? runtime.trackedSession))
      return Number.isFinite(v) ? v : NaN
    },
    engine: engineFor(key, config, vault),
    protectedItems: config.protectedItems ?? [],
    // S5-2：守门策略必须一路传到摘要器，否则机械路线用的是内部默认值，
    // 配置里的 maxWeightedLoss / allowCriticalLoss 等于没写。
    guardPolicy: config.guard ?? null,
    // L09 第二处：**这条才是真在跑的那条路**。此前 runtime.triggerRatio 只被
    // 存下来给端点看，从不传给 provider —— 于是 profile 写 `triggerRatio: 0.05`
    // 在自动压缩上完全没反应，`pressureChecks` 一直涨而 `pressureCompactions` 恒 0。
    // 传函数：配置被 HMR 换掉后不用重建 provider。
    triggerRatio: () => runtime.triggerRatio,
    log: config.__log ?? null,
  })
  runtime.providers.set(key, provider)
  return provider
}

/** 最近一次 apply 的可读摘要（`lib/index.js` 端点会把它带出去）。 */
export function compactionEntryStatus() {
  if (!runtime.last) return null
  const live = liveLimitNow()
  const configured = runtime.last.limitTokens
  return {
    ...runtime.last,
    // L10：`limitTokens` 是 apply 期写下的配置值（保留，便于追「配了什么」），
    // `limitTokensLive` 才是**此刻真正拿去算压力比**的数字。两者不一致时
    // 说明投影已经物化、配置值只是兜底 —— 端点上能直接看出来，不用猜。
    limitTokensLive: live,
    limitSource: live === configured ? 'configured' : (live === 200_000 ? 'fallback' : 'host-projection'),
    measureBasis: usedTokensOf(readProjectedPressure(runtime.ctx, runtime.callSession ?? runtime.trackedSession)) == null ? 'unknown' : 'real',
    // L09 第二处：`triggerRatio` 是配置里写的值（可能是 null），
    // `triggerRatioLive` 才是 provider 此刻真正拿去比 ratio 的那个数。
    // 两者不一致时立刻能看出「配置没接上闸门」—— 上一轮就是靠
    // `limitTokens vs limitTokensLive` 这组对照才抓到 L10 的同类问题。
    triggerRatioLive: resolveTriggerRatio(runtime.triggerRatio),
    triggerRatioSource: runtime.triggerRatio == null ? 'policy-default' : 'configured',
  }
}

/**
 * 唯一动作：`ctx.provide('compaction', <引擎>)`。
 *
 * @param ctx    cordis Context（在预设的 compaction 组内）
 * @param config `{vaultDir, tier, limitTokens, triggerRatio, sessionId}`
 */
export function apply(ctx, config = {}) {
  const log = config.log ?? makeLogger(config.logLevel)
  const state = {
    entry: ENTRY_SPECIFIER,
    installed: false,
    provided: false,
    reason: null,
    note: null,
    vaultDir: null,
    tier: config.tier ?? runtime.tier,
    limitTokens: config.limitTokens ?? runtime.limitTokens,
    triggerRatio: config.triggerRatio ?? runtime.triggerRatio,
    sessionId: config.sessionId ?? null,
    engineSessions: [],
    yields: 0,
    error: null,
    /** L10：会话追踪是否挂上（'ok' / 'unsupported' / 'error:…'）。 */
    sessionTracker: null,
  }

  // L10：记下 ctx —— 读 sessionProjections 只能走宿主 Context（config 里没有）。
  runtime.ctx = ctx ?? null
  // L10：记住宿主会话（宿主每轮都会派发 session/event）。
  // 没有这一步，端点在任何一次压缩调用之前都读不到投影 → 只能报 200_000 兜底，
  // 「entry 说 200k、stats 说 1000k」的自相矛盾就又回来了。
  try {
    const off = typeof ctx?.on === 'function'
      ? ctx.on('session/event', (session) => {
        if (session && typeof session === 'object' && session.surface) runtime.trackedSession = session
      })
      : null
    // 返回值是唯一的「挂上了」证据（同 L03 的纪律）；拿不到就如实记下。
    state.sessionTracker = typeof off === 'function' ? 'ok' : 'unsupported'
    if (typeof off === 'function' && typeof ctx?.effect === 'function') {
      ctx.effect(() => () => { try { off() } catch { /* 卸载失败不影响主流程 */ } }, 'laurel-context.entry-session-tracker')
    }
  } catch (e) {
    state.sessionTracker = `error:${String(e?.message ?? e)}`
  }
  runtime.tier = state.tier
  runtime.limitTokens = state.limitTokens
  runtime.triggerRatio = state.triggerRatio === undefined ? null : state.triggerRatio

  let vault = null
  try {
    const dir = resolveVaultDir(config)
    if (!dir) {
      state.reason = 'no-vault-dir'
      state.note = '找不到核心仓路径（DSH_HOME 未设置且未配置 vaultDir）'
      log.warn(state.note)
      runtime.last = state
      return { name, state }
    }
    state.vaultDir = dir
    vault = openSharedVault(dir, config, log)
    runtime.vault = vault
    runtime.vaultDir = dir
  } catch (e) {
    state.reason = 'vault-error'
    state.error = String(e?.message ?? e)
    log.error(`核心仓不可用，compaction 不提供：${state.error}`)
    runtime.last = state
    return { name, state }
  }

  // 与 lib/index.js 共享运行态：同一份 vault、同一份 gateway、同一份引擎。
  shareLaurelRuntime({
    vault,
    vaultDir: state.vaultDir,
    gateway: runtime.gateway,
    sessionId: state.sessionId,
    engine: state.sessionId ? engineFor(state.sessionId, config, vault) : null,
  })

  // 门面：三个方法每次现取 session → 现取该会话的引擎。构造期不碰 session（D130 的教训）。
  const facade = {
    name: 'compaction',
    compactIfNeeded(agent, trigger, signal) {
      const s = sessionOf(agent) ?? { id: state.sessionId ?? 'host' }
      runtime.callSession = s // L10：读投影要用本次真实会话
      return providerFor(s, config, vault).compactIfNeeded(agent, trigger, signal)
    },
    compactNow(agent, signal, sourceCommandId) {
      const s = sessionOf(agent) ?? { id: state.sessionId ?? 'host' }
      runtime.callSession = s
      return providerFor(s, config, vault).compactNow(agent, signal, sourceCommandId)
    },
    compactRegion(start, end, agent, signal) {
      const s = sessionOf(agent) ?? { id: state.sessionId ?? 'host' }
      runtime.callSession = s
      return providerFor(s, config, vault).compactRegion(start, end, agent, signal)
    },
  }
  // 自检用：声明我们是 Laurel 的 provider，且走的是 provide 这条路。
  Object.defineProperty(facade, '__laurelCompactionEntry', {
    value: Object.freeze({ entry: ENTRY_SPECIFIER, via: 'provide', shape: 'host' }),
    enumerable: false,
  })

  // ── 占用检测：后到者退让，不抛错（任务书「两入口共存不撞名」）──────────
  let existing
  try {
    existing = typeof ctx?.get === 'function' ? ctx.get('compaction') : ctx?.compaction
  } catch {
    existing = undefined
  }
  if (existing) {
    if (existing === facade || isLaurelProvider(existing)) {
      state.installed = true
      state.provided = true
      state.reason = 'already-laurel'
      state.note = '同名字段里已经是 Laurel 的实现（重复 apply / 热重载）：幂等复用，不重复注册'
      log.info(state.note)
      runtime.last = state
      return { name, state }
    }
    state.reason = 'occupied-by-host'
    state.note = 'ctx.compaction 已被别的实现占用：本入口退让，不覆盖、不抛错；'
      + '压缩权仍在占用方（isolate 组内应已由 overlay 换成 laurel-context/compaction，'
      + '出现这条说明组里还有别的 compression provider 排在前面）'
    state.yields += 1
    log.warn(state.note)
    runtime.last = state
    return { name, state }
  }

  if (typeof ctx?.provide !== 'function') {
    state.reason = 'unsupported-shape'
    state.note = '这个 ctx 没有 provide（不是真 cordis Context）：无法注册 compaction'
    log.warn(state.note)
    runtime.last = state
    return { name, state }
  }

  try {
    ctx.provide('compaction', facade)
    registerLaurelProvider(facade)
    state.provided = true
    state.installed = true
    state.reason = 'provided'
    state.note = `ctx.provide('compaction') 成功（${ENTRY_SPECIFIER}）`
  } catch (e) {
    state.reason = 'provide-failed'
    state.error = String(e?.message ?? e)
    state.note = 'ctx.provide("compaction") 抛错（通常是同名已注册）：退让，不抛错到宿主'
    log.warn(`${state.note}：${state.error}`)
  }

  state.engineSessions = [...runtime.engines.keys()]
  runtime.last = state
  runtime.applies.push({ at: Date.now(), reason: state.reason })
  if (runtime.applies.length > 20) runtime.applies.shift()
  return { name, state }
}

/** 测试用：清空本模块的运行态（不影响 `lib/index.js` 的共享仓）。 */
export function __resetEntryRuntime() {
  runtime.engines.clear()
  runtime.providers.clear()
  runtime.vault = null
  runtime.vaultDir = null
  runtime.gateway = null
  runtime.last = null
  runtime.applies.length = 0
}

/** 测试用：读运行态只读视图。 */
export function __entryRuntime() {
  return {
    engineSessions: [...runtime.engines.keys()],
    providerSessions: [...runtime.providers.keys()],
    vaultDir: runtime.vaultDir,
    applies: runtime.applies.slice(),
  }
}
