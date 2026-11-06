/**
 * dsh-warden · 宿主半边入口
 *
 * ── 这个插件做什么 ─────────────────────────────────────────────────────
 * 给 agent 装一副「缰绳」。它治的不是"模型不聪明"，而是**内耗**：
 *
 *   1. 子代理等待没有上限        → 干等几小时
 *   2. 子代理互相直接对话        → 读数互相污染，谁也说不清哪个数是谁测的
 *   3. 同一个文件改 31 次        → 返工吃掉大部分 token
 *   4. 上下文只涨不降            → 大输出直接进上下文，压缩阈值一次都没触发
 *   5. 几个子代理共用一个部署目录 → 「读数无法归属」
 *   6. 改文件匹配失败就原地重试  → 8 次 `old_string was not found`
 *   7. 护栏自己坏了却显示"已启用" → 用户无从判断到底生效没有
 *
 * ── 边界：warden 只做这些，不做另一套编排 ──────────────────────────────
 *   warden          观察 usage/进展、资源执行权、验收收据、可见状态、有理由的局部阻断
 *   官方 Basic+pruner  **唯一**的历史压缩 owner（warden 不裁历史）
 *   Strata          跨会话记忆召回（与 warden 的 evidence 台账不是一回事）
 *   外部计划工具     计划、阶段依赖与批准（warden 的阶段记录只补"验收齐不齐"）
 *   Laurel          通知与呈现
 *
 * 等待上限与水位提醒在套件里有两个模块都实现了（warden 与 strata）。
 * 谁执行由 `core/governance.js` 的**治理声明**决定，不看"目录在不在"。
 *
 * ── 五条纪律（每条都是踩过的）──────────────────────────────────────────
 *   1. **顶层 `inject` 留空**。cordis 的 Context 是受控代理，没写进 `inject`
 *      的服务用 `ctx.X` 访问会直接抛；用 `ctx.get(name)` + try/catch 更安全，
 *      非 Web 组合（CLI / 无头）也才能激活。
 *   2. **Web 路由走 `ctx.inject` + `effect`**，让 cordis 管等待、重建与清理。
 *   3. **家目录只认 `DSH_HOME`**，不从 profile 目录往上推（会推到错误位置）。
 *   4. **所有 IO 与钩子都吞异常，但降级必须可见**。护栏坏掉不许连带影响宿主里
 *      任何别的东西 —— 它在**每一次工具调用**的路径上；同时它**不许伪造
 *      自己的操作成功**，所以每次吞异常都要写进能力台账（R7）。
 *   5. **关掉总开关 = 全部钩子卸载 + 治理声明释放**，不留半个还在跑的监听器，
 *      也不留一条让别人误以为"warden 还在管"的声明。
 */

import {
  DEFAULT_CONFIG, PACKAGE_NAME, VERSION, normalizeConfig, pickKnown, pluginPaths, resolveDshHome,
} from './core/config.js'
import { Capabilities } from './core/capability.js'
import { systemClock } from './core/clock.js'
import { GovernanceClaim } from './core/governance.js'
import { ProgressWatch, StageLedger } from './core/progress.js'
import { Counters, EvidenceLedger, LockStore, appendEvent } from './core/store.js'
import { SessionTimeline } from './core/timeline.js'
import { loadSettings, saveSettings, verifyPersisted } from './core/settings.js'
import { UsageLedger, installUsageSampling } from './host/usage.js'
import { installWaitCap } from './host/wait.js'
import { installGuard } from './host/guard.js'
import { installAfter } from './host/after.js'
import { installInjection } from './host/inject.js'
import { createTools } from './host/tools.js'
import { createHandler } from './host/http.js'

/** 包名。也是客户端半边 `window.__ModuleLoader__.load({ id })` 用的 id，两处必须一致。 */
export { PACKAGE_NAME, VERSION }

/** 顶层 inject 故意留空。见上文纪律 1。 */
export const inject = []

/** 取服务：拿不到返回 null，不抛。 */
function requireService(ctx, name) {
  try {
    return ctx.get?.(name) ?? null
  } catch {
    return null
  }
}

/** 三级日志。 */
function makeLogger(level = 'info') {
  const rank = { debug: 10, info: 20, warn: 30, error: 40 }
  const min = rank[level] ?? 20
  const make = (name, fn) => (...args) => {
    if (rank[name] < min) return
    try { fn('[warden]', ...args) } catch { /* 日志不许影响主流程 */ }
  }
  return {
    debug: make('debug', console.debug.bind(console)),
    info: make('info', console.info.bind(console)),
    warn: make('warn', console.warn.bind(console)),
    error: make('error', console.error.bind(console)),
  }
}

/**
 * @param {any} ctx cordis 上下文
 * @param {Record<string, unknown>} config patch 里那份 config（当默认值用）
 * @param {{clock?: any}} [options] 测试用：注入时钟
 */
export function apply(ctx, config = {}, options = {}) {
  const home = resolveDshHome()
  const fromPatch = normalizeConfig(config, DEFAULT_CONFIG)
  const log = makeLogger(fromPatch.logLevel)
  const clock = options.clock ?? systemClock()

  const onEvent = (event) => {
    try { appendEvent(event, home, clock) } catch { /* 记账失败无所谓 */ }
  }

  /** 能力台账：supported / mounted / observed / degraded / standby（R7）。 */
  const capabilities = new Capabilities({ log, onEvent, clock })
  for (const [name, label] of Object.entries({
    waitCap: '子代理等待上限',
    sharedLock: '共享资源执行权',
    lockCoverageGap: '护栏覆盖不到的写入（明确记录）',
    usageSampling: '用量采样（session/event）',
    contextPressure: '当前上下文压力',
    waterLevelNudge: '水位提醒',
    costMeter: '花费统计与预算线',
    costByStep: '花费按步/按工具归因',
    subagentCost: '子代理花费记账',
    nudgeOnce: '提醒一次性判据',
    archiveByTool: '按工具分级归档',
    compactionFallback: '压缩兜底提醒',
    compactionNudge: '压缩兜底提醒执行权（跨模块治理）',
    selfReport: '收益自报表',
    rulesSection: '系统提示词规则段',
    rulesFallback: '规则消息注入兜底',
    archiveToolResults: '大输出归档与有界呈现',
    historyPruning: '历史压缩（warden 不做）',
    progressWatch: '无进展识别',
    capabilityPrecheck: '工具失败分型',
    evidenceLedger: '读数指纹台账',
    stageContract: '最小阶段合同',
    settingsPersistence: '设置持久化',
    httpRoutes: '设置页数据面',
    httpGuard: '数据面鉴权栅栏',
    modelTools: '模型侧工具',
    clientUi: '设置界面',
  })) capabilities.define(name, label)

  /** 生效配置：settings.json（设置页写的）盖在 patch 默认值上。 */
  let current = (() => {
    try {
      const stored = loadSettings(home)
      return stored.config ? normalizeConfig(stored.config, fromPatch) : fromPatch
    } catch {
      return fromPatch
    }
  })()

  /** 持久化状态。界面必须能区分"内存已生效"与"已落盘"（R7）。 */
  let persistence = { persisted: null, reason: '尚未写过设置', at: null }

  const getConfig = () => ({ ...current })

  /**
   * 改配置。
   *
   * @returns {{config: object, persisted: boolean|null, reason: string}}
   *   `persisted:false` 时内存里已经生效但**重启会丢**，界面必须照实说。
   */
  const setConfig = (patch) => {
    const candidate = normalizeConfig(patch, current)
    const saved = saveSettings(candidate, home, Object.keys(DEFAULT_CONFIG))
    if (saved.ok) {
      persistence = { persisted: true, reason: '已落盘', at: new Date(clock.now()).toISOString(), file: saved.file }
      capabilities.markObserved('settingsPersistence', `${saved.bytes} 字节 @${saved.file}`)
    } else {
      persistence = { persisted: false, reason: saved.reason, at: null }
      capabilities.markDegraded('settingsPersistence', `写盘失败：${saved.reason}`)
      log.warn(`配置写盘失败（内存里已生效，但重启会丢）：${saved.reason}`)
      onEvent({ kind: 'settings-save-failed', detail: saved.reason })
    }
    current = candidate
    // 总开关是热生效的：装上/卸下钩子，而不是等重启。
    reconcileHooks()
    return { config: getConfig(), persisted: persistence.persisted, reason: persistence.reason }
  }

  /* ---------------- 数据层 ---------------- */
  const locks = new LockStore(home, { clock, log, onEvent, capabilities })
  const evidence = new EvidenceLedger(home, { clock, log, onEvent, capabilities })
  const counters = new Counters()
  // 会话内位置（用户回合 / 步）：提醒节流与归档事件都要用（core/timeline.js）。
  const timeline = new SessionTimeline()
  const progress = new ProgressWatch({ clock, capabilities, onEvent, log })
  const stages = new StageLedger(home, { clock, log, capabilities, onEvent })
  const usageLedger = new UsageLedger({ clock })
  const governance = new GovernanceClaim({
    home,
    moduleId: PACKAGE_NAME,
    moduleVersion: VERSION,
    clock,
    log,
    onEvent,
  })
  const toolsRegistry = () => requireService(ctx, 'tools')

  const deps = {
    home,
    config: getConfig,
    locks,
    evidence,
    counters,
    timeline,
    progress,
    stages,
    ledger: usageLedger,
    governance,
    capabilities,
    clock,
    tools: toolsRegistry,
    log,
    onEvent,
  }

  /* ---------------- 钩子链 ---------------- */
  /** @type {Array<{name: string, off: () => void, stats?: object}>} */
  const mounted = []
  let heartbeatStop = null

  /**
   * 这项治理能力该不该由 warden 执行。
   *
   * 判据是**一条活着的治理声明**，不是"strata 的目录在不在"（K1 / R9-A）。
   * 抢不到就明确标 standby，界面上会说清"由 dsh-strata 执行"。
   */
  function claimGovernance(capability) {
    const result = governance.claim(capability)
    if (result.acquired) return { run: true, reason: result.reason }
    capabilities.markStandby(capability, result.owner, result.reason)
    return { run: false, reason: result.reason, owner: result.owner }
  }

  function mountHooks() {
    for (const [name, install] of [
      ['waitCap', () => {
        const claim = claimGovernance('waitCap')
        if (!claim.run) {
          log.info(`等待上限由 ${claim.owner ?? '其他模块'} 执行，warden 待命（${claim.reason}）`)
          return null
        }
        return installWaitCap(ctx, deps)
      }],
      ['sharedLock', () => installGuard(ctx, deps)],
      ['after', () => installAfter(ctx, deps)],
      ['usageSampling', () => installUsageSampling(ctx, deps)],
      ['inject', () => {
        // ── 2026-10-23 评审 P1-3 修复：两个能力各自独立仲裁，**互不嵌套** ──────
        //
        // 旧代码把 compactionNudge 的 claim 写在 `if (!wantsWaterLevel)` 的早退分支
        // **之后**，而三档预设的 waterLevelNudge 全是 false（2026-10-17 实测它零收益
        // 纯成本，默认关）。结果是：默认配置下**根本走不到**那次 claim，
        // 2026-10-23 刚合的「压缩提醒让位」在出厂配置下等于没上 —— 装了
        // laurel-context 的用户照样会收到两套话术。这是评审里最容易被忽略的一条。
        //
        // 现在的顺序：先各自决定「要不要 claim」，再挂注入，最后按结果设让位开关。
        // 水位提醒：默认关 → **不 claim**（占着 owner 却什么都不发会让别人误判成待命）。
        // 压缩兜底：只要 compactionFallbackRatio > 0 就 claim（它默认 0.3，是真的会发）。
        const cfg = getConfig()
        const wantsWaterLevel = cfg.waterLevelNudge !== false
        const wantsCompaction = (Number(cfg.compactionFallbackRatio) || 0) > 0

        const claim = wantsWaterLevel
          ? claimGovernance('waterLevelNudge')
          : { run: false, skipped: true, owner: '', reason: 'waterLevelNudge 关闭，本模块不占位' }
        // 让位判据：`laurel-context` 真能压缩，warden 只能提醒 —— 谁都能看出该谁让。
        const compactionClaim = wantsCompaction
          ? claimGovernance('compactionNudge')
          : { run: false, skipped: true, owner: '', reason: 'compactionFallbackRatio=0，本模块不占位' }

        const off = installInjection(ctx, deps)
        if (wantsWaterLevel && !claim.run && off) {
          // section 照常挂，但水位提醒关掉，避免两个模块都提醒。
          off.setWaterLevelOwned?.(false)
          log.info(`水位提醒由 ${claim.owner ?? '其他模块'} 执行，warden 待命（${claim.reason}）`)
        }
        if (wantsCompaction && !compactionClaim.run && off) {
          // 压缩兜底提醒让位：真能压的模块在跑，本模块不再发「该压缩了」。
          off.setCompactionNudgeOwned?.(false)
          log.info(`压缩兜底提醒由 ${compactionClaim.owner ?? '其他模块'} 执行，warden 待命（${compactionClaim.reason}）`)
        }
        // 把「本模块负责发压缩兜底提醒」这件事登记到能力台账，
        // 让状态页能区分「仲裁判给别人」和「压根没参与仲裁」。
        if (wantsCompaction && compactionClaim.run) {
          capabilities.markObserved?.('compactionNudge', `由 dsh-warden 执行（${compactionClaim.reason ?? '取得'}）`)
        }
        return off
      }],
    ]) {
      try {
        const off = install()
        if (typeof off === 'function') mounted.push({ name, off, stats: off.stats })
      } catch (error) {
        capabilities.markDegraded(name, `挂载异常：${error?.message ?? error}`)
        log.warn(`${name} 挂载失败：${error?.message ?? error}`)
      }
    }
    // ── 2026-10-23 评审 P1-5：心跳必须由 cordis 托管 ──────────────────────
    //
    // 旧代码是裸 `setInterval`。而 cordis 的 `isConstructor()` 只看「有没有 prototype」，
    // `export function apply()` 有 prototype → 被当**类构造器** `new` 掉
    // （vendor/cordis/src/fiber.ts:251-253），apply 返回的对象被吞，**宿主永远不调 dispose**。
    // 于是 `fiber.dispose()` 之后 setInterval 还在每 2 秒续声明，waitCap 归一个
    // 「已卸载的插件」所有，别的模块只能一直 standby —— 要重启宿主才能恢复。
    //
    // 用 ctx.effect 把定时器交给 cordis 的 effect 生命周期管：fiber 一销毁，
    // 它返回的 disposer 就会被调用，心跳随之停掉。
    // 停心跳的同时**必须释放治理声明**。
    // 只停心跳不够：`isStaleClaim` 要求「过期 且 pid 已死」，而卸载后进程还活着，
    // 声明永远不会被判陈旧 —— 别的模块会一直 standby 到进程重启。
    // releaseAll 自带幂等（先清 local 再按 local 算 held），重复调用安全。
    const startHeartbeatEffect = () => {
      const stop = governance.startHeartbeat()
      return () => {
        try { stop?.() } catch { /* 停表失败：下面 release 仍要试 */ }
        try { governance.releaseAll() } catch { /* 释放失败：TTL 之外还有 release 的兜底路径 */ }
      }
    }
    try {
      if (typeof ctx?.effect === 'function') {
        heartbeatStop = ctx.effect(startHeartbeatEffect, 'warden.governance.heartbeat')
      } else {
        // 非 cordis 组合（测试用的假 ctx）：退回直接启动，但把降级记出来。
        heartbeatStop = startHeartbeatEffect()
        capabilities.markDegraded('governanceHeartbeat', 'ctx.effect 不可用，心跳未交给宿主托管')
      }
    } catch (error) {
      // effect 注册失败不能让护栏挂不上：退回托管前行为，但必须可见。
      try { heartbeatStop = startHeartbeatEffect() } catch { heartbeatStop = null }
      capabilities.markDegraded('governanceHeartbeat', `ctx.effect 注册失败，退回裸定时器：${error?.message ?? error}`)
      log.warn(`治理心跳未能交给宿主托管：${error?.message ?? error}`)
    }
    return mounted.length
  }

  function unmountHooks() {
    while (mounted.length > 0) {
      const entry = mounted.pop()
      try { entry.off?.() } catch { /* 清理失败无所谓 */ }
    }
    heartbeatStop?.()
    heartbeatStop = null
    // 纪律 5：停用时要释放治理声明，否则别的模块会一直待命。
    governance.releaseAll()
  }

  /** 按总开关决定钩子在不在。改配置时会被调一次。 */
  function reconcileHooks() {
    const wanted = current.enabled !== false
    if (wanted && mounted.length === 0) {
      const count = mountHooks()
      log.info(`护栏已启用（挂上 ${count} 条钩子链）`)
    } else if (wanted && mounted.length > 0) {
      // 已经在跑：不重复挂载（R7 要求"总开关/重载不重复挂载"）。
      return
    } else if (!wanted && mounted.length > 0) {
      unmountHooks()
      log.info('护栏已停用（钩子已全部卸载，治理声明已释放）')
    }
  }

  reconcileHooks()

  /* ---------------- 工具 ---------------- */
  let toolsRegistered = 0
  const registerTools = (toolCtx) => {
    const tools = requireService(toolCtx, 'tools')
    if (!tools?.register) {
      capabilities.markUnsupported('modelTools', '取不到 tools 服务，无法注册模型侧工具')
      return
    }
    let registered = 0
    for (const definition of createTools(deps)) {
      try {
        tools.register(definition)
        registered++
      } catch (error) {
        // 单个工具注册失败不该拖垮其余工具，但要报出来。
        capabilities.markDegraded('modelTools', `工具 ${definition.name} 注册失败：${error?.message ?? error}`)
        log.warn(`工具 ${definition.name} 注册失败：${error?.message ?? error}`)
      }
    }
    toolsRegistered = registered
    capabilities.markSupported('modelTools', `已注册 ${registered} 个模型侧工具`)
    // clientUi（设置界面）本模块检测不到：客户端 bundle 是否加载只有客户端自己知道。
    // 明确标 unsupported 而不是留 unknown，免得界面显示一个永远不会变的状态。
    capabilities.markUnsupported('clientUi', '宿主侧检测不到客户端实体，需由客户端自报')
    // 0.3.0：收益自报表通过 warden_report 工具 + /warden/report 两条路走；
    // 只要工具注册成功，就至少有一条可用通道。
    if (registered > 0) capabilities.markSupported('selfReport', 'warden_report 工具已注册')
    log.info(`已注册 ${registered} 个工具`)
  }

  /* ---------------- HTTP ---------------- */
  const mountRoutes = (routeCtx) => {
    const webServer = requireService(routeCtx, 'webServer')
    if (!webServer?.register) {
      capabilities.markUnsupported('httpRoutes', '宿主没有 webServer 服务（非 Web 组合）')
      return
    }
    const disposers = []
    try {
      disposers.push(webServer.register({
        kind: 'prefix',
        path: '/warden',
        handler: createHandler({
          home,
          getConfig,
          setConfig,
          // 2026-10-23 评审 P0-1：数据面鉴权栅栏的 connection 服务来源。
          // 拿不到时 http-guard 退化为「回环 + 同源」两层，并在能力台账标 degraded
          // （绝不再静默变成不鉴权）。
          getConnection: () => requireService(routeCtx, 'connection'),
          getPersistence: () => ({ ...persistence }),
          verifyPersisted: () => verifyPersisted(current, home, Object.keys(DEFAULT_CONFIG)),
          locks,
          evidence,
          counters,
          progress,
          stages,
          ledger: usageLedger,
          governance,
          capabilities,
          clock,
          stats: () => mounted.map((entry) => ({ name: entry.name, stats: { ...(entry.stats ?? {}) } })),
          log,
        }),
      }))
      capabilities.markMounted('httpRoutes', disposers[disposers.length - 1], '/warden')
    } catch (error) {
      capabilities.markDegraded('httpRoutes', `路由注册失败：${error?.message ?? error}`)
      log.warn(`HTTP 路由挂载失败（设置页数据面不可用）：${error?.message ?? error}`)
    }
    return routeCtx.effect(() => () => {
      for (const dispose of disposers) { try { dispose?.() } catch { /* 清理失败无所谓 */ } }
      capabilities.markUnmounted('httpRoutes', '已卸载')
    }, 'warden.routes')
  }

  try {
    ctx.inject(['tools'], registerTools)
    ctx.inject(['webServer'], mountRoutes)
  } catch (error) {
    capabilities.markDegraded('httpRoutes', `服务订阅失败：${error?.message ?? error}`)
    log.warn(`服务订阅失败：${error?.message ?? error}`)
  }

  const paths = pluginPaths(home)
  const lockCount = Object.keys(locks.list(clock.now())).length
  const evidenceStats = evidence.stats()
  const degraded = capabilities.snapshot().filter((c) => c.state === 'degraded' || c.state === 'unsupported')
  appendEvent({
    kind: 'ready',
    detail: `host ${VERSION} · 档位=${current.preset} · 钩子=${mounted.length}`
      + ` · 锁=${lockCount} · 读数=${evidenceStats.total}`
      + ` · 降级=${degraded.length}${degraded.length > 0 ? `（${degraded.map((c) => c.name).join('、')}）` : ''}`,
  }, home, clock)

  log.info(`已挂载：档位=${current.preset}（${current.enabled ? '启用' : '停用'}）`
    + ` 等待上限=${current.waitCapMs > 0 ? `${current.waitCapMs}ms` : '不干预'}`
    + ` 归档=${current.archiveToolResults ? `≥${current.archiveThresholdChars}字符` : '关'}`
    + ` 星型=${current.starTopology} 无进展识别=${current.progressWatch}(${current.progressMode})`
    + ` 水位=${current.waterLevelNudge} 共享锁=${current.lockGuard} 读数台账=${current.evidenceLedger}`
    + ` 配置=${paths.settings}`)
  if (degraded.length > 0) {
    log.warn(`有 ${degraded.length} 项能力降级/不支持：${capabilities.summaryLine()}`)
  }

  return {
    /** 给宿主/测试看的只读快照。 */
    status: () => ({
      ok: true,
      data: {
        package: PACKAGE_NAME,
        version: VERSION,
        home,
        config: getConfig(),
        persistence: { ...persistence },
        capabilities: capabilities.snapshot(),
        governance: governance.snapshot(),
        locks: Object.values(locks.list(clock.now())),
        lockStats: locks.snapshot(),
        evidence: evidence.stats(),
        stages: stages.stats(),
        progress: progress.snapshot(),
        usage: usageLedger.list(),
        stats: mounted.map((entry) => ({ name: entry.name, stats: { ...(entry.stats ?? {}) } })),
        toolsRegistered,
        paths,
        defaults: pickKnown(DEFAULT_CONFIG),
      },
    }),
    /** 测试与隔离验收用的内部句柄。 */
    internals: {
      capabilities,
      governance,
      locks,
      evidence,
      counters,
      progress,
      stages,
      ledger: usageLedger,
      clock,
      setConfig,
      reconcileHooks,
    },
    dispose: () => {
      unmountHooks()
    },
  }
}
