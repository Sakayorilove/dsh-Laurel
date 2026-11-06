/**
 * laurel-context · 宿主半边入口。
 *
 * 与记忆核心**完全独立**：不 import 记忆核心，不要求它启用。
 * 只依赖 laurel-core 的公共存储。
 */
import { join } from 'node:path'
import { openVault, initVault } from '../../laurel-core/lib/vault.mjs'
import { systemTimeZone } from '../../laurel-core/lib/budget.mjs'
import { createGateway } from '../../laurel-core/lib/gateway.mjs'
import { createEngine } from './engine.mjs'
import { resolveOwner } from './owner.mjs'
import {
  invisibleToAgent,
  makeHostProvider,
  probeOverlayTakeover,
  registerWithHost,
} from './host-compaction.mjs'
import { registerAutoCompaction } from './auto-compaction.mjs'
import { claimCompactionNudge, readCompactionClaim } from './compaction-claim.mjs'
// resolveDshHome 也在这里：本包只保留 compaction-entry.mjs 那一份实现（2026-10-23 收敛）。
import { compactionEntryStatus, resolveDshHome } from './compaction-entry.mjs'
import { readProjectedPressure, usedTokensOf } from './host-pressure.mjs'
import { guardSummary } from './guard.mjs'
import { mountReadOnly } from './host-data.js'
import {
  createOverlayState,
  firstLaurelProvider,
  isLaurelProvider,
  describePresetEntries,
  overlayStatusOf,
  presetTakeoverOf,
  nudgePresetEntries,
  providePresetGate,
  registerLaurelProvider,
  describeLoaderTree,
  registerOverlay,
  shareLaurelRuntime,
} from './overlay.mjs'

export const name = 'laurel-context'
export const inject = []

const PACKAGE_NAME = 'laurel-context'
const VERSION = '0.1.0'

/**
 * 兜底窗口（L10 第三级）。与 `engine.mjs` 的 `TIER_POLICY[tier].limitTokens` 同源，
 * 只在「宿主投影拿不到 + 配置没写」时用，且端点里 `limitSource` 会写明是兜底值。
 */
const TIER_LIMIT_FALLBACK = Object.freeze({ zero: 48_000, balanced: 64_000, full: 96_000 })

function makeLogger(level = 'info') {
  const rank = { debug: 10, info: 20, warn: 30, error: 40 }
  const min = rank[level] ?? 20
  const make = (n, fn) => (...args) => {
    if ((rank[n] ?? 20) < min) return
    try { fn('[laurel-context]', ...args) } catch { /* ignore */ }
  }
  return { debug: make('debug', console.debug.bind(console)), info: make('info', console.info.bind(console)), warn: make('warn', console.warn.bind(console)), error: make('error', console.error.bind(console)) }
}

/**
 * 解析核心仓路径。显式配置优先，其次 `$DSH_HOME/laurel-core`（含 `~/.dsh` 兜底）。
 *
 * `resolveDshHome` 2026-10-23 起只有 `./compaction-entry.mjs` 那一份实现
 * （本文件与它原先各抄了一份逐字相同的副本）。为什么不反向：本文件已 import
 * compaction-entry，反过来会成环。D47 的理由见那边的注释。
 */
function resolveVaultDir(config = {}) {
  if (config.vaultDir) return config.vaultDir
  const home = resolveDshHome()
  if (!home) return null
  return join(home, 'laurel-core') // 与记忆核心共用同一个核心仓；独用时也会自建
}

/** 设置页读的端点前缀。与客户端 `lib/client/index.mjs` 的 DATA_API 必须一致。 */
const DATA_PATH = '/laurel-context'

// L10：读宿主官方投影的两个小函数搬到 lib/host-pressure.mjs。
// 原因：**真正对外提供 `compaction` 服务的是 lib/compaction-entry.mjs**（预设组内那份），
// 它也要用同一个口径；若它去 import './index.js'，就与 index.js 顶部的
// `import { compactionEntryStatus } from './compaction-entry.mjs'` 形成循环依赖，
// 循环下拿到的是未初始化绑定。拆成独立模块后两边共用一份实现，不复制第二份。
export { readProjectedPressure, usedTokensOf }
/** 安全取服务：cordis 的 Context 是受控代理，没 inject 的服务直接访问会抛。 */
function getService(ctx, name) {
  try {
    return ctx.get?.(name) ?? null
  } catch {
    return null
  }
}

export function apply(ctx, config = {}) {
  const log = makeLogger(config.logLevel)
  const state = {
    enabled: true,
    engine: 'laurel-native',
    tier: config.tier ?? 'zero',
    vaultDir: null,
    vault: null,
    engineInstance: null,
    /**
     * 按会话缓存的引擎（sessionId → engine）。
     *
     * 【为什么必须有这一份】`engineInstance` 是**根层展示用**的那一台，它的
     * sessionId 取自 `config.sessionId ?? 'host'`，整个进程只有一个。把它交给
     * `makeHostProvider` 的 `engine` 参数，等于让所有会话共用同一台引擎：
     * 引擎的摘要 `range` 是会话内位置坐标，第二个会话的第一条摘要必然落在
     * 第一个会话已发布摘要的区间里，于是每次压缩都被 `range-overlaps-published`
     * 拒掉（真机：某会话 124 次压缩全失败，最后 1,050,256 tokens 撞 400 上限）。
     * 现在按 `session.id` 分引擎；只有 `session.id` 取不到时才退回 `engineInstance`。
     */
    engines: new Map(),
    error: null,
    // S6/L10：当前宿主会话。apply 期宿主还没建会话（D130 的教训），
    // 只能在事件里抓；抓到之前压力口径一律 basis:'unknown'。
    session: null,
    sessionAt: null,
  }

  /** 取当前已知的宿主 session（可能为 null —— 那时不假装知道用量）。 */
  const currentSession = () => state.session

  /**
   * 声明「压缩提醒这件事由我负责」（2026-10-23 新增）。
   *
   * 为什么在这里做：`dsh-warden` 的 `compactionFallback` 会在
   * 「压力到线 + 官方压缩没发生」时插一条「该压缩了」的提醒，而本模块干的是
   * **真去压**。两者判同一个 ratio，于是用户会先收到"该压缩了"、再收到"已压缩"——
   * 这就是用户报的「内耗护栏和上下文压缩功能重复」的实感来源。
   *
   * 声明之后 warden 那边会 `setCompactionNudgeOwned(false)`，不再发兜底提醒；
   * 本模块没装时 warden 的兜底提醒照旧（它仍是有用的兜底）。
   *
   * **失败一律静默**：声明只是"告诉邻居我能干"，绝不影响压缩本身。
   * 拿不到 home（非桌面宿主 / 无 DSH_HOME）就跳过，行为退回旧版。
   */
  let compactionClaim = null
  try {
    const claimHome = resolveDshHome()
    compactionClaim = claimCompactionNudge({
      home: claimHome,
      version: VERSION,
      log: (msg) => log.info(msg),
    })
    state.compactionClaim = {
      acquired: compactionClaim.acquired === true,
      owner: compactionClaim.owner ?? '',
      reason: compactionClaim.reason ?? '',
    }
  } catch (e) {
    // 声明失败不影响压缩，但要在状态里留痕（不假装成功）。
    state.compactionClaim = { acquired: false, owner: '', reason: `声明异常：${e?.message ?? e}` }
  }

  try {
    const dir = resolveVaultDir(config)
    if (!dir) {
      state.enabled = false
      state.error = '找不到核心仓路径（DSH_HOME 未设置且未显式配置 vaultDir）'
      log.warn(state.error)
    } else {
      state.vaultDir = dir
      try {
        state.vault = openVault(dir)
      } catch (e) {
        if (/不是核心仓/.test(String(e.message))) {
          state.vault = initVault(dir, { coreId: config.coreId ?? 'core-default' })
        } else {
          state.error = `核心仓读取失败（不覆盖）：${e.message}`
          state.enabled = false
          log.error(state.error)
        }
      }
      if (state.vault) {
        state.engineInstance = createEngine({
          vault: state.vault,
          sessionId: config.sessionId ?? 'host',
          tier: state.tier,
          // L10：**不写死** 200_000。没配就交给档位默认值，配了才用调用方的数，
          // 两者都会被宿主投影里的真实 contextWindow 覆盖（见 engine.mjs currentLimit）。
          limitTokens: Number.isFinite(config.limitTokens) && config.limitTokens > 0 ? config.limitTokens : undefined,
          // L09：此前 createEngine 签名里根本没有 triggerRatio，这里传 0.75 被静默丢弃，
          // 实际永远走档位默认值 —— 配置写 0.75、行为跑 0.72，配置骗人。
          // 现在引擎接受它并按 (0,1] 校验；没配就不传，让档位默认值生效（不在这里造第二个默认值）。
          triggerRatio: Number.isFinite(config.triggerRatio) ? config.triggerRatio : undefined,
          // L10：真实用量与真实窗口都从宿主官方投影取；apply 期还没有 session，
          // 所以传函数而不是快照 —— 引擎每次算压力时现问。
          pressureSource: () => {
            const live = readProjectedPressure(ctx, currentSession())
            if (!live) return null
            return {
              contextWindow: live.contextWindow ?? (Number.isFinite(config.contextWindow) ? config.contextWindow : null),
              // 每次都重读：投影是活的，缓存一个数字等于报旧账。
              usedTokens: () => usedTokensOf(readProjectedPressure(ctx, currentSession())),
            }
          },
          // 守门配置来自 cordis 的 guard 段；不配则只走 protocol 的基础校验。
          guard: config.guard ?? null,
        })
      }
    }
  } catch (e) {
    state.enabled = false
    state.error = String(e?.message ?? e)
    log.error('初始化失败', state.error)
  }

  // ── 模型网关（D136）────────────────────────────────────────────────────
  // 此前这个包里 `state.gateway` **只被读、从没被赋值**（`:132` 读它，
  // 全文件 `state.gateway =` 出现 0 次）。于是 summarizer 永远拿到 null
  // → `gateway.status()` 抛错被吞 → 退回 gateway-disabled → 零推理档下
  // 接管宿主压缩后**一条历史都压不掉**。
  //
  // 网关实现已搬到 laurel-core（两包共用一份，不反向依赖 laurel-memory）。
  // 这里默认 tier=zero + source=none，网关 status().enabled 为 false，
  // 但对象本身是活的 —— summarizer 据此走机械摘要，而不是崩掉。
  try {
    state.gateway = createGateway({
      vaultDir: state.vaultDir ?? '',
      tier: state.tier,
      source: config.modelSource ?? 'none',
      timeZone: config.timeZone ?? systemTimeZone(),
      // 零推理档绝不在构造期创建任何网络侧对象：provider 由调用方现造
      provider: config.provider ?? null,
    })
  } catch (e) {
    state.gateway = null
    state.gatewayError = String(e?.message ?? e)
    log.warn('模型网关初始化失败（不影响机械摘要与本地压缩）', state.gatewayError)
  }

  // ── S8：预设组换装（overlay）──────────────────────────────────────────
  // 根层 `provide('compaction')` 到不了预设组的 isolate 域（陷阱 3），所以"让
  // agent 用 Laurel 压"的真正落点是把**预设组内部**那一行 compaction-basic 换成
  // `laurel-context/compaction`。钩子必须 `{global:true}` 且只能改 agent-preset
  // 这一节；**只换压缩提供者那一层**，其它行一行都不动。
  let overlayState = createOverlayState()
  let overlayRegistration = null
  try {
    overlayRegistration = registerOverlay(ctx, { log, state: overlayState, enabled: true })
    if (!overlayRegistration.ok) {
      log.warn(`overlay 未挂上（${overlayRegistration.reason}）：预设组不会被换装，压缩权仍在宿主`)
    }
  } catch (e) {
    overlayRegistration = { ok: false, reason: 'register-error', error: String(e?.message ?? e) }
    log.warn(`overlay 注册抛错（不影响独立使用）：${overlayRegistration.error}`)
  }

  // 与 `laurel-context/compaction` 入口共享运行态：两个入口各自 apply 一次，
  // 但必须看同一个仓、同一个网关，否则摘要写在一处、取回读另一处（S7 第 3 条）。
  try {
    shareLaurelRuntime({
      vault: state.vault,
      vaultDir: state.vaultDir,
      gateway: state.gateway ?? null,
      sessionId: config.sessionId ?? null,
      engine: state.engineInstance,
    })
  } catch { /* 共享失败不致命：compaction-entry 会自己开仓 */ }

  // ── S8-A：放行预设闸门 ────────────────────────────────────────────────
  // 必须是**最后一步**：前面钩子已挂、运行态已共享，此刻才允许四个预设行激活。
  // 顺序反了会出两种病：钩子没就位（换装落空，回到 S8 原状），或
  // `laurel-context/compaction` 先 apply 而共享运行态还没写好（各开一个仓）。
  let presetGate = null
  try {
    presetGate = providePresetGate(ctx)
    if (!presetGate.ok) {
      log.warn(`预设闸门 provide 失败（${presetGate.reason}）：四个预设行会一直等这个服务，`
        + '宿主可能起不来 agent；请检查 profile 里 preset-* 的 inject 行')
    }
  } catch (e) {
    presetGate = { ok: false, reason: 'provide-error', error: String(e?.message ?? e) }
    log.warn(`预设闸门 provide 抛错：${presetGate.error}`)
  }

  // S8-A 第二半：闸门只解决**下次装载**的时序。已经 ACTIVE 的预设行不会因为
  // patch 里多了一个 inject 就重新派发（`Entry.update()` 在 config 没变时直接
  // return），所以这里主动让它重解析一次 —— `Fiber.update(config, noSave=true)`
  // 是宿主自己的入口，会跑 `_resolveConfig()`（派发 internal/config）再重启插件，
  // 且不写盘。只在闸门就绪之后做：此时钩子必然已在位，否则推了也白推。
  let presetNudge = null
  if (presetGate?.ok === true && overlayRegistration?.ok === true) {
    try {
      presetNudge = nudgePresetEntries(ctx, { log })
      if (presetNudge.nudged.length > 0) {
        log.info(`S8-A：已重解析 ${presetNudge.nudged.length} 个预设行（${presetNudge.nudged.join(', ')}）`)
      } else if (presetNudge.skipped.length > 0) {
        log.warn(`S8-A：没有预设行可重解析（${presetNudge.skipped.map((s) => `${s.id}:${s.why}`).join('；')}）`)
      }
    } catch (e) {
      presetNudge = { ok: false, nudged: [], skipped: [], error: String(e?.message ?? e) }
      log.warn(`S8-A：重解析预设行抛错：${presetNudge.error}`)
    }
  } else {
    presetNudge = { ok: false, nudged: [], skipped: [], error: '闸门或钩子未就绪，跳过重解析' }
  }

  // 若宿主有 ctx.compaction 且配置要求接管，就按真实契约注册 provider。
  // 没有该服务时 registerWithHost 返回 unsupported —— 不假装接上。
  //
  // D130 的教训：**apply 阶段根本拿不到 session**（宿主还没建会话），
  // 所以 provider 不能在构造时就要求 session —— 那正是此前
  // `adaptJournal 需要宿主 session` 的来源。现在 provider 是"无状态门面"：
  // 三个方法每次被调用时从 `agent.session` 取那一次的真实会话。
  // 构造阶段只做注册，不碰 session。
  let hostRegistration = null
  // D138：**我们真的 provide 出去的那个对象**，与"是否接管成功"必须分开记。
  // 二者不是一回事：`isolated-sibling` 的时候 provide 是成功的（服务槽已被我们
  // 占住），只是 agent 那个 isolate 域看不见它。此前只记 hostRegistration，
  // 于是它 ok:false 时 `state.hostProvider` 保持 null —— 读取时复检把 null 当作
  // "自己的实现"传给 invisibleToAgent，我们自己那个 provider 就被当成
  // "别的域里的同名实现"数进兄弟，判据永远判盲：组合层改好之后端点照样报
  // isolated-sibling。证伪见 implementation/prove-takeover-recheck.mjs。
  /**
   * provider 用的窗口上限（L10）。
   *
   * 优先宿主投影里的真实 contextWindow，退到配置，最后才是档位默认值。
   * **不再写死 200_000** —— profile 声明 1,000,000 而这里写 200,000，
   * 等于把「本来只用了一成就该压」的会话判成「满了」。
   */
  const providerLimitTokens = (targetSession) => {
    const live = readProjectedPressure(ctx, targetSession ?? currentSession())
    if (Number.isFinite(live?.contextWindow) && live.contextWindow > 0) return live.contextWindow
    if (Number.isFinite(config.limitTokens) && config.limitTokens > 0) return config.limitTokens
    if (Number.isFinite(config.contextWindow) && config.contextWindow > 0) return config.contextWindow
    return TIER_LIMIT_FALLBACK[state.tier] ?? 200_000
  }

  /**
   * 端点该展示哪台引擎：优先当前会话那台（按会话分引擎之后的真实工作引擎），
   * 会话还没出现时退回 `engineInstance`。只读，不建新引擎 —— 端点每刷新一次
   * 就新建一台会白白重放整份 journal。
   */
  const displayEngine = () => {
    const sid = typeof state.session?.id === 'string' && state.session.id.length > 0 ? state.session.id : null
    if (sid && state.engines.has(sid)) return state.engines.get(sid)
    return state.engineInstance
  }

  /**
   * 取该会话的引擎：按 `session.id` 一台，绝不跨会话共用。
   *
   * 与 `compaction-entry.mjs` 的 `engineFor` 同一口径（那边按 sessionId 缓存），
   * 但这里必须自己有一份 Map：根层 provider 会在**多个会话**之间被调用。
   * `session.id` 拿不到时退回根层展示引擎 `engineInstance`（sessionId 为
   * `config.sessionId ?? 'host'`）—— 那是单会话兜底，不是常规路径。
   */
  const engineForSession = (targetSession) => {
    const sid = typeof targetSession?.id === 'string' && targetSession.id.length > 0 ? targetSession.id : null
    if (!sid) return state.engineInstance
    const hit = state.engines.get(sid)
    if (hit) return hit
    const liveLimit = providerLimitTokens(targetSession)
    const eng = createEngine({
      vault: state.vault,
      sessionId: sid,
      tier: state.tier,
      ...(Number.isFinite(liveLimit) && liveLimit > 0 ? { limitTokens: liveLimit } : {}),
      ...(Number.isFinite(config.triggerRatio) ? { triggerRatio: config.triggerRatio } : {}),
      guard: config.guard ?? null,
    })
    state.engines.set(sid, eng)
    return eng
  }

  let providedProvider = null
  // D138 复检要用「自己的实现」去排除自己，但 `providedProvider` 只在
  // `ok===true && via==='provide'` 时才赋值。apply 期判 `isolated-sibling`
  // 时它是 null，于是 `takeoverNow()` 里那句 `if (!providedProvider) return hostRegistration`
  // 会**直接返回旧的盲结论** —— D138 想要的「apply 盲、后来组合层改好 → 升级成成功」
  // 永远走不到。真机与单测都复现过：改好组合层后 `isolatedEntries` 已经是 []，
  // 但端点仍报 `ok:false / reason:isolated-sibling`。
  // 所以额外记一份「本次造的那个 provider」，不管有没有 provide 成功。
  let ownProvider = null
  // 复检翻成成功之后补登记过没有（见 takeoverNow 里那段说明）。
  let ownProviderRegistered = false
  try {
    if (state.engineInstance && config.takeoverHostCompaction === true) {
      const provider = makeHostProvider({
        // 仅作兜底：正常情况下宿主调用时会把 agent 传进来，我们从 agent.session 取
        session: null,
        vault: state.vault,
        gateway: state.gateway ?? null,
        tier: state.tier,
        // L10：provider 的触发比例也用真实窗口算，不写死 200_000。
        // 传**函数**：apply 期还没有 session，投影读不到，那时求值会把 200_000
        // 钉进 provider 闭包（真机实测：stats 报 1,000,000、判据按 200k，8% 就开压）。
        limitTokens: providerLimitTokens,
        // L10：provider 默认用字符数当 token（defaultMeasure），那只是粗估。
        // 宿主投影拿得到时就用它，拿不到返回 NaN —— provider 会退出真实口径的判断，
        // 而不是把「字符数 ≈ token」当成 quota 去比。
        // 传**本次会话**：根层 provider 会被多个会话调用，读 `currentSession()`
        // 在多会话并发时会把 A 的用量当成 B 的，压力判据就错人了。
        measure: (targetSession) => {
          const p = readProjectedPressure(ctx, targetSession ?? currentSession())
          const v = usedTokensOf(p)
          return Number.isFinite(v) ? v : NaN
        },
        engine: state.engineInstance,
        // 【关键】根层 provider 会被多个会话调用，必须按会话分引擎。
        // 只传 `engine` 的话，上面那台 sessionId='host' 的展示引擎会被所有会话共用，
        // 摘要 range 跨会话重叠 → 每次压缩 protocol-reject（真机事故的根因）。
        engineFor: engineForSession,
        protectedItems: config.protectedItems ?? [],
        // S5-2：守门策略必须传进摘要器。此前只有引擎那条路带 guard，
        // 机械摘要走的是 `resolveGuardPolicy(undefined)` 的内部默认值 ——
        // 配置里写的 maxWeightedLoss/allowCriticalLoss 对机械路线完全没生效。
        guardPolicy: config.guard ?? null,
        // L09 第二处：宿主自动触发这条路的阈值。此前只给了引擎，provider 侧
        // 永远读写死的 0.75 —— 配置写 triggerRatio 在自动压缩上完全没反应。
        triggerRatio: Number.isFinite(config.triggerRatio) ? config.triggerRatio : null,
        log,
      })
      hostRegistration = registerWithHost(ctx, provider)
      // D138 复检的「自己」：不管 provide 成不成功，本次造的就是自己。
      // 只用于 `invisibleToAgent` 排除自己（避免把自己数成兄弟），
      // **不用**于 `activeImpl()` —— 那个必须只认真正接上的实现。
      ownProvider = provider
      // D138：只有**真的 provide 出去过**才记下来（via==='provide'）。
      // occupied 时这个 provider 根本没进服务槽，读取时复检拿它去比对，
      // 会把宿主的实现数成"兄弟"从而把 occupied 误报成 isolated-sibling。
      // 读取时复检必须用**这个**对象，而不是 state.hostProvider
      // （后者在失败时是 null，会让自己的 provider 被数成兄弟）。
      //
      // 【必须同时要求 ok === true】`isolated-sibling` 这条路的返回也带
      // `via: 'provide'`（host-compaction.mjs 的 invisibleToAgent 分支），但它
      // **明确表示 agent 看不到这次 provide**。只按 via 记的话，这个不可见的根层
      // provider 会进 `providedProvider`，而 `activeImpl()` 第一顺位就取它 ——
      // 于是自动压缩被转发给一个「预设组里根本没人解析到」的实现，同时盖住了
      // 组内真正生效的 `laurel-context/compaction` 门面（L08 第二重阻断的翻版）。
      if (hostRegistration?.ok === true && hostRegistration?.via === 'provide') providedProvider = provider
      // 既然 provide 出去了，就在共享 registry 里登记一笔。
      // 没有这笔登记，`laurel-context/compaction`（预设侧窄入口）后来 apply 时
      // 在槽里看到一个**认不出来**的对象，只能判 `occupied-by-host` 退让 ——
      // 明明是 Laurel 自己占的位，却被记成"宿主还在占"。`isLaurelProvider`
      // 是"占位的是不是自己人"的唯一判据（overlay.mjs）。
      if (hostRegistration?.ok === true && hostRegistration?.via === 'provide') registerLaurelProvider(provider)
      // D131：只有真的接管成功才暴露接缝能力。此前无条件赋值，
      // 于是注册失败（occupied / isolated-sibling）时端点仍报"有这三个方法"，
      // 读者会以为接上了 —— 假成功的第二层。
      if (hostRegistration?.ok === true) state.hostProvider = provider

      // ── 两入口共存（本轨新增）──────────────────────────────────────────
      // `laurel-context/compaction`（预设组内那个窄入口）可能**先**占住了这个槽
      // —— 那是正确的终态：组里的 agent 解析到的就是它。此时 registerWithHost
      // 报 `occupied`，但占位的是**自己人**，不是"宿主还在压"。
      // 处理方式：退让，不覆盖、不重复注册、不抛错，把真实原因写进 hostCompaction。
      // 判据必须同时满足三条，缺一条就会造出"假成功"（本轨第一次落盘就踩了）：
      //   ① 不是因为"我们 provide 了但 agent 看不见"——`isolated-sibling` 说明槽里
      //      那对象**就是刚 provide 出去的自己**，把它当成"组内那份"重判成功，
      //      等于把 L08 的第一重阻断又盖回去（端点说 Laurel 在压，agent 实际看不到）。
      //   ② 占位对象不是本次 createCompactionProvider 造出来的 `provider` 本身。
      //   ③ 占位对象确实是 Laurel 的实现（isLaurelProvider）。
      if (hostRegistration?.ok !== true && hostRegistration.reason !== 'isolated-sibling') {
        const occupant = getService(ctx, 'compaction')
        if (occupant && occupant !== provider && isLaurelProvider(occupant)) {
          hostRegistration = {
            ok: true,
            via: 'entry-provide',
            reason: 'entry-provide',
            reused: true,
            yieldedTo: 'laurel-context/compaction',
            note: 'compaction 槽里已是 laurel-context/compaction（预设组侧入口）的实现：'
              + '根层入口退让，不重复注册、不抛错；压缩权在 Laurel',
          }
          providedProvider = occupant
          state.hostProvider = occupant
        }
      }
    } else {
      hostRegistration = { ok: false, reason: 'not-requested', note: '配置未要求接管宿主压缩' }
    }
  } catch (e) {
    hostRegistration = { ok: false, reason: 'register-error', error: String(e?.message ?? e) }
    log.warn('接宿主压缩失败（不影响独立使用）', hostRegistration.error)
  }

  // 仲裁用的"宿主是否仍在改写历史"必须按**实际结果**算，不能按"有没有请求接管"算。
  // 曾经写成 hostProvider: !!hostRegistration?.ok —— 接管成功反而被判成"宿主仍生效"，
  // 于是 owner 永远停在 host，还提示"先关闭宿主压缩提供者"。
  // 'unsupported' 要算 false：宿主根本没有 compaction 服务，不存在"宿主在压缩"。
  // D129 之后接管只有两条路：provide 成功（宿主不再生效）/ occupied、provide-failed（宿主仍生效）。
  const HOST_STILL_ACTIVE = new Set([
    'not-requested',
    'occupied',        // 宿主实现已占住 ctx.compaction，接管需改组合层
    'provide-failed',  // provide 抛错（通常是同名已注册）
    'isolated-sibling', // D131：provide 成功但同名实现在别的 isolate 域里，agent 看不到我们
    'unsupported-shape',
    'no-ctx',
    // 兼容旧版本可能写进快照的值，避免历史记录读出来自相矛盾
    'register-failed',
    'register-error',
  ])

  // D131：**apply 时机太早**。桌面 profile 的 agent 预设组是懒加载的，
  // Laurel 在根层 apply 时那个 isolate 域里的 compaction-basic 还没注册，
  // 于是 registerWithHost 数到 0 个兄弟、报 ok:true；等 agent 真的起来，
  // 兄弟才出现，而那时已经没人再检查了 —— 端点就永远显示"接管成功"。
  // 所以"到底接上没有"必须在**读取时**重新算，不能只信 apply 那一次的结果。
  //
  // 判据必须和 registerWithHost 共用同一份实现（invisibleToAgent），
  // 否则两条路会漂 —— 第一版这里只数兄弟，漏掉"组内空着但 isolate 生效"。
  //
  // D138：读取时复检**不能只在 apply 成功时做**。此前第一行是
  //   if (!hostRegistration?.ok) return hostRegistration
  // 于是 apply 期判成 isolated-sibling 之后，即使组合层被改好、那个隔离域
  // 已经不存在，这里也永远不再复检 —— 端点会一直停在旧结论上。
  // 现在改成两个方向都复检：
  //   · apply 说成功、读取时被判盲  → 降级成 isolated-sibling（D131 原意）
  //   · apply 说盲、读取时已不盲    → 升级成成功（D138 新增）
  // 并且"自己的实现"一律用 providedProvider，不用 state.hostProvider
  // （后者在失败时是 null，会让自己的 provider 被数成兄弟）。
  const takeoverNow = () => {
    if (!hostRegistration) return hostRegistration

    // ── S8 换装成功时，根层这一侧的每一个分支结论都不再是判据 ──────────────
    // 预设组里那一行已经是 `laurel-context/compaction`，组会用**自己的** LocalRealm
    // 解析到它 —— 根层 provide 到不了 isolate 组（陷阱 3），但这正是换装的目的：
    // 不靠根层可见性，靠组内就是 Laurel。
    //
    // 这段必须放在所有 reason 短路**之前**（包括 not-requested）：换装是**独立于**
    // 「有没有请求根层接管」的一条通道。把它排到后面会造出一个自相矛盾的端点读数
    // —— `owner:"laurel"`（resolveOwner 收到了 presetTakeover）配
    // `hostCompaction.ok:false / reason:"not-requested"`，而且 `autoActive()`
    // 会一直为 false，于是 `skippedNotOwner` 每轮 +1、一次都不压：
    // 同一个 L08 第二重阻断从另一个门进来（本轨第三轮才抓到）。
    if (presetTakeoverOf(overlayState)) {
      // L09c：换装路径也必须带上「看不看得见」的两个探测读数。
      // 手册 5.3 第 2 条要求读 `siblingCount` / `isolatedEntries`，而此前这条
      // 路径只返回换装计数，两个键是 undefined —— 验收时读不到，只能当成缺字段。
      //
      // 这里**不能**把 isolatedEntries 填成 []：`overlay.mjs:174-175` 明确写着
      // 「isolate 一律不动（陷阱 3）」—— 换装能在组内生效，正是靠 group 用自己的
      // LocalRealm 解析到 laurel-context/compaction。所以换装成功后，那四个预设组
      // 的 `isolate: {compaction:true}` 声明**必然还在**，isolatedEntries 非空是
      // 机制本身，不是残留污染。把它填成 [] 等于为让验收好看而改读数。
      //
      // 因此如实报读数，并用下面的字段把「非空」解释清楚：
      //   · isolateIsByDesign:true  → 组内隔离是换装生效的条件，不是缺陷
      //   · foreignSiblingCount     → 真正该为 0 的数：不属于本次 Laurel 实现的同名实例
      // L09c：读数与「判据说明」用与 registerWithHost 同一份实现（陷阱：两条路各写一遍必然漂）。
      const probe = probeOverlayTakeover(ctx, 'compaction', providedProvider)
      return {
        ok: true,
        via: 'preset-overlay',
        note: '预设组的压缩提供者已被 overlay 换成 laurel-context/compaction：agent 在组内解析到的就是 Laurel',
        swappedRows: overlayState.basicRowsSwapped,
        presetsSwapped: overlayState.presetsSwapped,
        // 手册 5.3 第 2 条的字段名照原样给出，值按真实探测填。
        siblingCount: probe.siblingCount,
        siblingProbe: probe.siblingProbe,
        isolatedEntries: probe.isolatedEntries,
        isolateProbe: probe.isolateProbe,
        // 这两个数在换装路径上**不参与**判定，只说清为什么。
        judge: probe.judge,
        isolateMoot: probe.isolateMoot,
        // 换装语义：组内 isolate 声明必须保留，非空即正确。
        isolateIsByDesign: true,
        isolateWhy: '换装靠组自己的 LocalRealm 解析到 laurel-context/compaction；'
          + '拆掉 isolate 反而会在 agent 起来时抛 service "compaction" has been registered（陷阱 3）',
        // 换装路径下真正该为 0 的判据：还有几行指向宿主实现。
        basicRowsLeftAfterSwap: overlayState.basicRowsLeftAfterSwap ?? 0,
      }
    }

    // 压根没请求接管 / 宿主没有这个服务 / 注册时抛错：这不是"看不看得见"的问题，
    // 复检也改变不了，直接原样返回。
    if (hostRegistration.reason === 'not-requested') return hostRegistration
    if (hostRegistration.reason === 'unsupported-shape') return hostRegistration
    if (hostRegistration.reason === 'no-ctx') return hostRegistration
    if (hostRegistration.reason === 'register-error') return hostRegistration
    if (hostRegistration.reason === 'register-failed') return hostRegistration
    // 预设组侧入口已经占住槽位（本轨新增）：这是正确终态，不需要再问根层看不看得见。
    // 根层看不见组内是对的 —— 组有自己的 LocalRealm；agent 解析到的是组内那份。
    if (hostRegistration.reason === 'entry-provide') return hostRegistration
    // 【到底该不该复检，按 reason 分档（2026-10-22 修 D138 时踩到）】——
    //
    // 复检要同时支撑两个方向，所以放行条件是「两个方向都需要的那些 reason」：
    //
    //   · `isolated-sibling` → **必须复检**。D138 的核心场景：apply 期那个隔离域
    //     还在，用户后来把组合层改好了（删掉 isolate.compaction），读取应翻成成功。
    //     原来这里写 `if (!providedProvider) return`，而 isolated-sibling 时
    //     providedProvider **恰好是 null**（它只在 ok===true && via==='provide' 时
    //     赋值）→ 复检永远不跑，D138 名存实亡。
    //
    //   · `ok === true`（apply 期就成功）→ **也要复检**。D131 的降级场景：
    //     apply 时干净、后来组合层变成隔离域 → 读取时必须降级，不能继续报成功。
    //
    //   · `occupied` / `provide-failed` → **不许复检**。槽里是别人的实现，
    //     复检只会把它数成兄弟、把自己的缺席说成"看得见"→ 假成功。
    //     这两条都有专门测试守着（"宿主实现已占用 compaction 时如实报 occupied"）。
    //
    // `ownProvider` 记的是本次造的那个 provider（与是否 provide 成功无关），
    // 只用来在 invisibleToAgent 里排除自己，避免把自己数成兄弟。
    const canRecheck = hostRegistration.ok === true || hostRegistration.reason === 'isolated-sibling'
    if (!canRecheck) return hostRegistration
    if (!ownProvider) return hostRegistration

    const blind = invisibleToAgent(ctx, 'compaction', ownProvider)
    if (!blind.blind) {
      // 不盲：不管是"apply 期就成功"还是"后来组合层改好了"，结论都是接管成功。
      // occupied/provide-failed 不可能走到这里（那两个分支没有 provide 成功），
      // 但为稳妥仍保留它们的 reason，见下方 isTakeover 判断。
      const wasOk = hostRegistration.ok === true
      if (wasOk) {
        return { ...hostRegistration, siblingProbe: blind.siblingProbe, isolateProbe: blind.isolateProbe }
      }
      // D138：配置与组合层都改好了，读的时候才确认下来。via 记 actually-provided
      // 便于排查"为什么这次和 apply 时不一样"。
      //
      // 【必须在这里补登记（2026-10-22 修 D138 时踩到的最后一环）】——
      // apply 期判 isolated-sibling 时 `ok !== true`，所以上面 :412 那句
      // `if (hostRegistration?.ok === true && ... ) registerLaurelProvider(provider)`
      // **没有执行** —— 服务槽里那个 provider 从来没被登记成"自己人"。
      // 于是复检翻成 ok:true 之后：
      //   · `activeImpl()` 里 `getService(ctx,'compaction')` 拿到的 occupant
      //     过不了 `isLaurelProvider()` 判定 → 返回 false；
      //   · `seamIfTakenOver()` 要求 `activeImpl()` 非空 → `compactIfNeeded`
      //     仍是 undefined。
      // 结果是端点说接管成功、接缝能力却拿不到（测试第 135 行就是这么红的）。
      // 所以确认成功这一刻补登记一次（幂等：registerLaurelProvider 内部按对象去重）。
      registerLaurelProvider(ownProvider)
      ownProviderRegistered = true
      return {
        ok: true,
        via: 'provide',
        reused: hostRegistration.reason === 'occupied',
        note: '读取时复检确认接管已生效（apply 时该隔离域尚未就位）',
        siblingProbe: blind.siblingProbe,
        isolateProbe: blind.isolateProbe,
      }
    }
    // 判盲：若原本是 ok:true 要降级；若原本已经是 blind 的结论则刷新探测读数。
    return { ...blind.verdict, siblingCount: blind.siblingCount, isolatedEntries: blind.isolatedEntries }
  }

  const hostStillActiveOf = (reg) => (reg ? HOST_STILL_ACTIVE.has(reg.reason) : true)

  // ── 自动压缩的触发器（D139）──────────────────────────────────────────────
  // 宿主的 `compaction-basic` 不只提供 `ctx.compaction` 这个**服务**，它还在构造时
  // 注册了 `agent/pre-step`（压力）与 `agent/request-error`（超窗恢复）两个 hook。
  // 服务只回答「怎么压」，hook 才回答「什么时候压」。
  //
  // 我此前给出的接管写法（去掉 isolate.compaction + 删掉组内 compaction-basic）
  // 会把这两个 hook 一起删掉 —— 于是 `compactIfNeeded` 再也不会被调用。
  // 实测证据：接管生效后端点 `hostCompaction.ok=true` / `owner=laurel`，但
  //   `stats.compactions=0`，会话里 Laurel 写的 `compaction/summary` 为 0 条。
  // 也就是说那个"接管"实际等于**把自动压缩关掉**，只留下手动 `/compact`。
  // 证据链：implementation/evidence/d139-takeover-kills-auto-compaction.log
  //
  // 所以接管必须自己带上触发器。hook 注册在根层就够：事件不跨 isolate 隔离
  // （implementation/prove-events-cross-isolate.mjs 的 A/C 两项实测）。
  // `isActive` 每读一次现算 —— 组合层改好之后自动生效，不需要重新 apply。
  let autoCompaction = null
  // ── L08 第二重阻断：`skippedNotOwner` 一直在涨 ───────────────────────────
  // 原来这里第一行是 `if (!providedProvider) return false`。可是换装（S8）之后
  // **根层本来就没 provide 成功**（组里 isolate，根层看不见），真正在组里干活的
  // 是 `laurel-context/compaction` 建的门面。于是 `autoActive()` 恒为 false，
  // 每来一个 `agent/pre-step` 就 `skippedNotOwner += 1` —— 触发器挂上了却永远不动，
  // 接管等于关掉自动压缩（D139 的老毛病换了个位置复发）。
  //
  // 现在的判据：谁在槽里就转发给谁。顺序是
  //   ① 根层自己 provide 成功的那个（providedProvider）
  //   ② 槽里已有的 Laurel 实现（entry-provide 的情况）
  //   ③ overlay 登记过的预设侧门面（`firstLaurelProvider()`）
  // 三个都没有才算"不是 owner"。
  const activeImpl = () => {
    if (providedProvider) return providedProvider
    const occupant = getService(ctx, 'compaction')
    if (occupant && isLaurelProvider(occupant)) return occupant
    return firstLaurelProvider()
  }
  const autoActive = () => {
    try {
      if (takeoverNow()?.ok !== true) return false
      return !!activeImpl()
    } catch {
      return false
    }
  }
  try {
    if (state.engineInstance) {
      autoCompaction = registerAutoCompaction(ctx, {
        provider: {
          // 永远经由 activeImpl() 现取，避免拿到 apply 期那个未接通的闭包；
          // 也覆盖"根层没接上、组里那份才是真的"的情况（L08 第二重阻断）。
          // 取到空就返回 null（与宿主契约的 returnsNullWhenNothing 一致），
          // 不能让 undefined.xxx 抛异常把整轮干掉。
          compactIfNeeded: (agent, trigger, signal) => activeImpl()?.compactIfNeeded(agent, trigger, signal) ?? null,
          compactNow: (agent, signal, sourceCommandId) => activeImpl()?.compactNow(agent, signal, sourceCommandId) ?? null,
          compactRegion: (start, end, agent, signal) => activeImpl()?.compactRegion(start, end, agent, signal) ?? null,
        },
        isActive: autoActive,
        log,
      })
      if (!autoCompaction.complete) {
        log.warn('自动压缩触发器注册不完整（宿主 hook 表可能变了）：接管后压力压缩可能不会发生')
      }
    }
  } catch (e) {
    log.warn(`自动压缩触发器注册失败（接管后需手动 /compact）：${e?.message ?? e}`)
  }

  // D134：`dataPlaneMounted` 必须在 `readOnlySnapshot` **之前**声明。
  // `ctx.provide()` 就在下面几行，宿主注册完服务往往立刻读一次 state；
  // 若声明留在「只读数据面」那段（provide 之后），那次同步读取会抛
  //   ReferenceError: Cannot access 'dataPlaneMounted' before initialization
  // laurel-memory 的 D114 就是这个形状、早已修好；laurel-context 当时漏了，
  // 同一个形状在两个包里只修了一个。证伪/证实见 implementation/prove-context-tdz.mjs。
  let dataPlaneMounted = false

  // 抽成函数：装载机和设置页都要读同一份，两份各写必然漂移。
  /**
   * 用量口径的可读描述（L10）。端点必须能回答「这个 usedTokens 是怎么来的」。
   */
  const describeUsage = () => {
    const live = readProjectedPressure(ctx, currentSession())
    const shown = displayEngine()
    const enginePressure = shown ? shown.pressure() : null
    const liveTokens = usedTokensOf(live)
    const source = live?.projectedTokens != null
      ? 'official-projection:projected'
      : live?.pressureTokens != null
        ? 'official-projection:pressure'
        : 'unknown'
    // L10 修正：basis 说的是**这一行 usedTokens 是从哪来的**，不能拿引擎的
    // basis 冒充。之前写 `basis: enginePressure?.basis ?? 'unknown'`，真机上
    // 端点出现 `basis:"unknown"` 却同时给出 `usedTokens:90107` 与
    // `source:"official-projection:projected"` —— 自相矛盾，读者无法判断这个数
    // 能不能拿去报账。现在：本快照自己读到了有限投影值就报 real；
    // 读不到才回落引擎口径（引擎停用时连口径都没有，仍是 unknown）。
    const basis = Number.isFinite(liveTokens)
      ? 'real'
      : (enginePressure?.basis ?? 'unknown')
    return {
      basis,
      source: Number.isFinite(liveTokens) ? source : (enginePressure?.usedTokensSource ?? source),
      // 宿主投影的原始读数：pressureTokens 是判断用的，projectedTokens 是下次请求的预估
      projection: live,
      contextWindow: live?.contextWindow ?? null,
      usedTokens: liveTokens,
      asOfSeq: live?.asOfSeq ?? null,
      sessionKnown: state.session != null,
      sessionAt: state.sessionAt,
    }
  }

  const readOnlySnapshot = () => {
    const reg = takeoverNow()
    const presetTakenOver = presetTakeoverOf(overlayState)
    return {
      enabled: state.enabled, engine: state.engine, tier: state.tier,
      vaultDir: state.vaultDir, error: state.error,
      engineNote: state.engineNote ?? null,
      nativeEngineActive: !!state.engineInstance,
      coreId: state.vault?.manifest?.coreId ?? null,
      // L08：owner 判定必须收「预设组是否已换装」这个真证据。
      // 只看根层 hostProvider 会得出"宿主仍在压"，而实际组里已经是 Laurel。
      owner: resolveOwner({
        hostProvider: hostStillActiveOf(reg),
        hostProviderSwapped: reg?.ok === true && reg?.via !== 'preset-overlay',
        presetTakeover: presetTakenOver,
        laurelEnabled: !!state.engineInstance,
      }),
      // 端点必须报**当前会话那台引擎**的读数。
      // 以前固定报 `engineInstance`（sessionId='host' 的展示引擎）；按会话分引擎之后
      // 它不再接收任何会话事件，继续读它会让端点永远停在旧账上（stats.events 不涨、
      // summaries 不变），设置页看到的是"压缩停了"的假象。
      pressure: displayEngine() ? displayEngine().pressure() : null,
      stats: displayEngine() ? displayEngine().stats() : null,
      // L10：用量口径必须自证。basis='unknown' 表示这个数只是启发式估算、
      // 不能对外报账；projection 段是宿主官方投影的原始读数（读不到就 null）。
      usage: describeUsage(),
      // S6：provider 侧真正拿去比阈值的窗口。与 engine 的 limitTokens 应当一致，
      // 不一致就说明 provider 还在用写死的数 —— 这正是本缺陷最初的症状。
      // 传当前会话：按会话分引擎后，每台引擎的窗口可能不同（投影按会话给）。
      providerLimitTokens: providerLimitTokens(currentSession()),
      hostCompaction: reg,
      // S8：换装是否真的落地（预设组里的压缩提供者是否已换成 Laurel）。
      presetOverlay: overlayStatusOf(overlayState),
    presetGate: presetGate ? { ...presetGate } : null,
    presetNudge: presetNudge ? { ok: presetNudge.ok, nudged: presetNudge.nudged, skipped: presetNudge.skipped, error: presetNudge.error } : null,
      // S8 诊断：预设 entry 的装载实况（有没有 fiber、plugins 是不是数组、还剩几行宿主实现）。
      // `presetsSeen===0` 时必须靠这一项分辨「钩子挂晚了」与「挂上了但判据不匹配」。
      presetEntries: describePresetEntries(ctx),
    loaderTree: describeLoaderTree(ctx),
      // S7：预设组侧那个窄入口最近一次 apply 的结果（只读）。
      compactionEntry: compactionEntryStatus(),
      // D139：接管之后「有没有人记得触发」必须看得见。此前只报
      // hostCompaction.ok=true，读者无法分辨"接上了并且会自己压"与
      // "接上了但永远没人调用" —— 后者正是删掉 compaction-basic 之后的状态。
      autoCompaction: autoCompaction
        ? {
            registered: autoCompaction.registered,
            complete: autoCompaction.complete,
            ownerActive: autoActive(),
            stats: autoCompaction.stats,
          }
        : null,

      // 设置页需要知道"这份数据是不是真的接上了"，不能靠猜。
      dataPlane: { mounted: !!dataPlaneMounted, path: DATA_PATH },
    }
  }

  // D138：接缝能力的"有没有"必须与 hostCompaction 用同一个判据现算。
  // 用 getter 而不是常量：取值那一刻才问 takeoverNow()，所以组合层改好之后
  // 不需要重新 apply。用 getter 而不是"永远返回一个函数"是为了保住 D131 的语义 ——
  // 没接管上时必须真的是 undefined，否则"有没有接上"又变成靠调用才暴露。
  const seam = (method) => function (...args) {
    const reg = takeoverNow()
    if (reg?.ok !== true) return undefined
    // 取实现也走 `activeImpl()`，不能只看根层 `providedProvider`：
    // 预设换装接管时根层这一份可能压根没 provide（没请求根层接管／被宿主占着），
    // 真正在组里干活的是 `laurel-context/compaction` 那个门面。判据仍是
    // takeoverNow() —— D131「只有真接管成功才暴露接缝能力」不变。
    const impl = activeImpl()
    if (!impl || typeof impl[method] !== 'function') return undefined
    return impl[method](...args)
  }
  const seamIfTakenOver = (method) => (takeoverNow()?.ok === true && activeImpl() ? seam(method) : undefined)

  ctx.provide?.('laurel.context', {
    version: VERSION,
    state: readOnlySnapshot,
    // 独立启停：关掉记忆核心也照样有这些能力
    // ingest 走**当前会话那台**引擎：按会话分引擎之后，写进 engineInstance
    // 等于写进一台没人读的引擎（端点已不再展示它的账）。
    ingest: (events) => displayEngine()?.ingest(events),
    // 原文按 hash 直取，不依赖哪台引擎；会话引擎优先，取不到再退展示引擎。
    readOriginal: (ref, opts) => (displayEngine() ?? state.engineInstance)?.readOriginal(ref, opts),
    // 搜索是**每台引擎各有一份 ref 索引**的（replay 只收本会话的 ctx.externalize）。
    // 只查一台必然漏掉其它会话外置的原文，所以跨会话合并去重后再搜。
    searchOriginal: (q, opts) => {
      const engines = [...new Set([displayEngine(), ...state.engines.values()].filter(Boolean))]
      if (!engines.length) return undefined
      if (engines.length === 1) return engines[0].searchOriginal(q, opts)
      const limit = Number.isFinite(opts?.limit) ? opts.limit : 5
      const seen = new Set()
      const hits = []
      for (const eng of engines) {
        const r = eng.searchOriginal(q, { ...opts, limit })
        for (const h of r?.hits ?? []) {
          if (h?.hash && seen.has(h.hash)) continue
          if (h?.hash) seen.add(h.hash)
          hits.push(h)
        }
      }
      // 各引擎都给的是本引擎内按分数排好的结果；这里只按分数重排一次取前 limit。
      hits.sort((a, b) => (b?.score ?? 0) - (a?.score ?? 0))
      return { ok: true, hits: hits.slice(0, limit) }
    },
    // 守门器：**在接别人产出的摘要时才有用** —— 它接在别人产出的摘要之后，
    // 缺关键约束就拒。这条路径不依赖原生引擎，所以单独暴露，不受 engine 选择影响。
    guardSummary: (args) => guardSummary({
      original: args?.original ?? '',
      summary: args?.summary ?? '',
      policy: {
        maxWeightedLoss: config.guard?.maxWeightedLoss ?? 0.35,
        allowCriticalLoss: config.guard?.allowCriticalLoss === true,
      },
    }),
    // 接缝能力（宿主压缩的三个操作），没接管时为 undefined。
    // D138：这里也不能按 apply 期的快照决定。apply 说盲、后来组合层改好了，
    // 端点会显示"已接管"但这三个方法仍是 undefined —— 又是一份写在两处的真相。
    // 用 getter：**取值那一刻**才问 takeoverNow()（与 hostCompaction 同一判据），
    // 所以组合层改好之后不需要重新 apply；没接管上时取到的确实是 undefined，
    // D131「只有真接管成功才暴露接缝能力」的语义不变。
    get compactIfNeeded() { return seamIfTakenOver('compactIfNeeded') },
    get compactNow() { return seamIfTakenOver('compactNow') },
    get compactRegion() { return seamIfTakenOver('compactRegion') },
  })

  // ── 会话追踪（S6/L10）──────────────────────────────────────────────────
  // 真实用量只能从「当前那个 session」的投影里读，而 apply 期拿不到它。
  // 这里只记录引用，不读内容、不持有历史（不构成第二份真相）。
  try {
    const remember = (session) => {
      if (!session || typeof session !== 'object') return
      if (state.session === session) return
      state.session = session
      state.sessionAt = Date.now()
    }
    const offEvent = ctx.on?.('session/event', (session) => remember(session))
    if (typeof offEvent === 'function') ctx.effect?.(() => offEvent, 'laurel-context.session-tracker')
    // pre-step 的 payload 里也有 agent.session：会话刚开、还没产生事件时靠它。
    const offStep = ctx.on?.('agent/pre-step', (payload, next) => {
      try { remember(payload?.agent?.session) } catch { /* ignore */ }
      return next()
    })
    if (typeof offStep === 'function') ctx.effect?.(() => offStep, 'laurel-context.session-tracker-step')
  } catch (e) {
    log.warn(`会话追踪未挂上（压力口径只能是 unknown）：${e?.message ?? e}`)
  }

  // ── 只读数据面（D48）────────────────────────────────────────────────────
  // 与记忆核心同一套理由：设置页在浏览器里，够不到 `laurel.context` 这个
  // 宿主服务（客户端只有宿主预置的 remote.* 命名空间）。状态必须挂到
  // webServer 上由页面 fetch。只读、无写端点。
  // 注意：`dataPlaneMounted` 声明在上面（readOnlySnapshot 之前），见 D134 的注释。
  const mountDataPlane = (routeCtx) => {
    const webServer = getService(routeCtx, 'webServer')
    const mounted = mountReadOnly(webServer, { path: DATA_PATH, collect: () => ({ ok: true, data: readOnlySnapshot() }) })
    dataPlaneMounted = mounted.ok === true
    if (!mounted.ok) log.warn(`设置页数据面未挂载：${mounted.note}`)
    if (mounted.dispose) routeCtx.effect?.(() => () => { try { mounted.dispose() } catch { /* 摘不掉就算了 */ } }, 'laurel-context.data-plane')
  }
  try {
    ctx.inject?.(['webServer'], mountDataPlane)
  } catch (e) {
    log.warn(`数据面订阅失败（不影响压缩本身）：${e?.message ?? e}`)
  }

  // 卸载时释放治理声明，否则 warden 会一直以为「有人在真压缩」而不发兜底提醒，
  // 结果是谁都不提醒（这与 warden 的纪律 5 是同一个坑：停用要 release）。
  try {
    ctx.on?.('dispose', () => {
      try { compactionClaim?.release?.() } catch { /* 释放失败靠 TTL 过期 */ }
    })
  } catch { /* 拿不到 dispose 钩子就靠 TTL */ }

  return { name: PACKAGE_NAME, version: VERSION, state, hostRegistration, compactionClaim }
}

export { PACKAGE_NAME, VERSION }
