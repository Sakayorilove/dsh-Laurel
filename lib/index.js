/**
 * Laurel Center host: authenticated module store, profile-local switches and child fibers.
 * The standard package ships only Center; verified modules live in profile/.laurel-modules.
 * User data retains its existing DSH_HOME paths. Failures are reported without overwriting state.
 */

import { PACKAGE_NAME, VERSION } from './config.js'
import { SUB_PLUGINS } from './registry.js'
import {
  getService, listNative, readOverrides, setNative, setNativeAll, profileIdentityOf,
} from './host.js'
import {
  appendEvent, centerPaths, describe, isMigrationCompleted, loadMigrations, loadState, recordMigration,
} from './store.js'
import { completionState, itemCompletion, planMigration, REASONS } from './migrate.js'
import { envelope, newOperationId } from './result.js'
import { makeIdentity } from './identity.js'
import { mountPresentation } from './ui-preferences.js'
import { loadEnabled, modulesPath, mountModules } from './modules.js'
import { mountModuleSwitch } from './module-switch.js'
import { ModuleStore } from './module-store.js'
import { mountStoreApi } from './module-store-api.js'
import { readFileSync } from 'node:fs'

export { PACKAGE_NAME, VERSION }

/** cordis 的 Context 是受控代理：没写进 inject 的服务用 `ctx.X` 访问会直接抛。这里故意一个都不要。 */
export const inject = []

/** 三级日志。 */
function makeLogger(level = 'info') {
  const rank = { debug: 10, info: 20, warn: 30, error: 40 }
  const min = rank[level] ?? 20
  const make = (name, fn) => (...args) => {
    if ((rank[name] ?? 20) < min) return
    try { fn('[laurel-center]', ...args) } catch { /* 日志不许影响主流程 */ }
  }
  return {
    debug: make('debug', console.debug.bind(console)),
    info: make('info', console.info.bind(console)),
    warn: make('warn', console.warn.bind(console)),
    error: make('error', console.error.bind(console)),
  }
}

/** 没有宿主生命周期信号时的**有限**重试上限（不是靠延时猜，见 scheduleMigration）。 */
export const MAX_MIGRATION_ATTEMPTS = 4

/**
 * 一次性迁移：把旧 state.json 里「用户点过开」的意图写进用户层。
 *
 * 只读旧 state（不改它）；完成状态按 profile 记到 migrations.json。
 * 判不出归属 / 用户层读不了 / 原生没就绪 → 不写，也不打完成标记。
 *
 * @param {object} ctx
 * @param {object} paths
 * @param {object} log
 * @param {() => boolean} disposed 插件已卸载时返回 true，此后不得再写
 * @param {number} [attempt] 第几次尝试（0 起）
 */
export async function runMigration(ctx, paths, log, disposed = () => false, attempt = 0) {
  const saved = loadState(paths)
  const result = { attempt, savedUpdatedAt: saved.updatedAt, reason: null, items: [], writes: [], outcomes: {}, recorded: false, recordFailure: null, completed: false }

  if (saved.updatedAt === null || saved.updatedAt === undefined) {
    result.reason = REASONS.noSavedState
    return result
  }

  const migrations = loadMigrations(paths)
  const attribution = profileIdentityOf(ctx)
  // 只有 **completed** 才算「已迁移」；pending 记录不终结（第三轮 G1）。
  const alreadyDone = migrations.readOk && attribution.ok && isMigrationCompleted(migrations.profiles, attribution.key)
  if (alreadyDone) {
    result.reason = REASONS.alreadyMigrated
    result.profileKey = attribution.key
    return result
  }
  if (!migrations.readOk) log.warn('迁移完成记录读不了（%s），本次不打完成标记', migrations.reason)

  const read = readOverrides(ctx)
  const native = await listNative(ctx)
  const plan = planMigration(saved, native, {
    overrides: read.overrides,
    userLayerOk: read.ok,
    attribution,
    completed: false,
  })
  result.reason = plan.reason
  result.items = plan.items
  result.writes = plan.writes
  result.terminal = plan.terminal
  result.pending = plan.pending
  result.profileKey = attribution.key ?? null
  result.userLayer = { ok: read.ok, sources: read.sources }

  // 逐条写。卸载后立即停手 —— 不许在插件已经不在的时候继续改用户层。
  for (const id of plan.writes) {
    if (disposed()) {
      log.warn('迁移中止：插件已卸载，%s 不再写入', id)
      result.aborted = true
      break
    }
    const outcome = await setNative(ctx, id, true)
    result.outcomes[id] = { outcome: outcome.outcome, reason: outcome.reason, code: outcome.code, saved: outcome.saved }
  }

  const written = Object.keys(result.outcomes)
  const succeeded = written.filter((id) => itemCompletion(plan.items.find((i) => i.id === id)?.action, result.outcomes[id]))
  const failed = written.filter((id) => !succeeded.includes(id))

  if (succeeded.length > 0) {
    log.info('旧 state 迁移：%s', succeeded.join(', '))
    appendEvent({ kind: 'migrate', at: 'boot', attempt, migrated: succeeded, profile: attribution.key ?? null }, paths)
  }
  if (failed.length > 0) log.warn('迁移未完成：%o', failed.map((id) => ({ id, ...result.outcomes[id] })))

  // ── 完成记录与失败记录**分开**（G1）──────────────────────────────────
  // 只有每一项都确知完成（保存到目标 / 用户明确表态 / 无需处理）才写 completed；
  // 否则只写 pending —— 它**不**是终结标记，下次启动会重新核对用户层再处理。
  const state = completionState(plan, result.outcomes)
  result.completion = state
  if (state.noop) return result

  const base = {
    savedUpdatedAt: saved.updatedAt,
    userLayerSources: read.sources,
    items: plan.items,
    outcomes: result.outcomes,
  }
  if (state.complete) {
    const record = recordMigration(attribution.key, {
      ...base,
      completed: { at: new Date().toISOString(), reason: plan.reason },
      pending: null,
    }, paths)
    result.recorded = record.ok
    result.completed = record.ok
    if (!record.ok) {
      result.recordFailure = record.reason
      log.warn('迁移完成标记写入失败（%s），下次启动会重试', record.reason)
    } else {
      log.info('旧 state 迁移完成（profile=%s）', attribution.key)
    }
  } else {
    const previousAttempts = migrations.profiles?.[attribution.key]?.pending?.attempts ?? 0
    const record = recordMigration(attribution.key, {
      ...base,
      pending: {
        at: new Date().toISOString(),
        reason: plan.reason,
        attempts: previousAttempts + 1,
        incomplete: state.incomplete,
      },
    }, paths)
    result.recorded = false
    if (!record.ok) {
      result.recordFailure = record.reason
      log.warn('迁移进度记录写入失败（%s）', record.reason)
    }
    log.info('迁移本轮未完成（reason=%s incomplete=%o），下次启动重新核对用户层再处理', plan.reason, state.incomplete)
  }
  return result
}

/**
 * 挑一个「原生真的可用了」的时机跑迁移。
 *
 * 主路径是宿主自己的生命周期：`appReady.onReady()` —— 它在 loader 树挂载完成后
 * 才 commit（见 asar 里 `dsh/lib/profile-boot` 的 `createAppReady`：**已 commit 后
 * 再订阅会立刻回调**，所以插件被 HMR 重挂后照样能跑）。
 * 没有这个服务时退到**有限**重试，且次数很小：宁可留给下次启动重试，
 * 也不要靠不断加长延时去猜。
 *
 * @param {{ last: object, attempts?: object[] }} sink 每次尝试都留档，供只读诊断
 * @returns {() => void} 取消函数
 */
export function scheduleMigration(ctx, paths, log, disposed, sink = { last: { reason: 'not-run' }, attempts: [] }) {
  let cancelled = false
  let timer = null
  const attempt = async (round) => {
    if (cancelled || disposed()) return
    try {
      const result = await runMigration(ctx, paths, log, disposed, round)
      sink.last = result
      if (Array.isArray(sink.attempts)) sink.attempts.push({ round, reason: result.reason, aborted: result.aborted === true, recorded: result.recorded, completed: result.completed === true, outcomes: result.outcomes })
      // 只在「原生还没就绪」时在同一次启动里重试；**写入失败不在这里重试**
      // （不无限重试），留给下次启动或显式重试 —— 那时会重新核对用户层。
      if (!cancelled && !result.aborted && (result.pending?.length ?? 0) > 0 && round + 1 < MAX_MIGRATION_ATTEMPTS) {
        timer = setTimeout(() => { void attempt(round + 1) }, 300 * (round + 1))
      }
    } catch (error) {
      log.warn('迁移异常：%o', error)
      sink.last = { attempt: round, error: String(error?.message ?? error) }
      if (Array.isArray(sink.attempts)) sink.attempts.push({ round, error: String(error?.message ?? error) })
    }
  }

  const ready = getService(ctx, 'appReady')
  if (ready && typeof ready.onReady === 'function') {
    let cancelReady = null
    try {
      cancelReady = ready.onReady(() => { void attempt(0) })
    } catch (error) {
      log.warn('订阅 appReady 失败，退回有限重试：%o', error)
      void attempt(0)
    }
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      try { cancelReady?.() } catch { /* ignore */ }
    }
  }

  log.debug('宿主没有 appReady，用有限重试触发迁移')
  void attempt(0)
  return () => {
    cancelled = true
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * @param {any} ctx cordis 上下文
 * @param {Record<string, unknown>} config patch 里那份 config（仅用于 logLevel）
 */
export function apply(ctx, config = {}) {
  const paths = centerPaths()
  const log = makeLogger(typeof config.logLevel === 'string' ? config.logLevel : 'info')
  const identity = makeIdentity()
  let disposed = false

  // 卸载后异步工作不得继续写入：这是迁移的唯一写权限开关。
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => { disposed = true }, 'laurel-center: dispose guard')
    }
  } catch { /* effect 不可用就靠 cancelled 标志 */ }

  // ── 七个公开模块挂成子 fiber（1.5.0）────────────────────────────────────────
  // 不产生 Loader entry：Cordis 的子 fiber 挂在 laurel-center 这一条 entry 下，
  // 而宿主插件列表只遍历 ctx.loader.entries()，所以插件页只剩一张卡。
  // 首次对齐是异步的，不挡 apply()；逐个模块 try/catch，坏一个不连坐。
  let modules = null
  let moduleStore = null
  let modulePaths = paths
  try {
    // profileDir 必须传：模块包的裸包名要**从 profile 的 node_modules 解析**，
    // 不能靠本文件所在目录（那是仓库 realpath，看不到 profile 的链接）。
    // 拿不到 profileContext 时回落 null —— mountModules 会逐项报 no-profile-dir，
    // 而不是静默挂空。
    const profileDir = profileIdentityOf(ctx).dir
    let hostVersion = null
    try { hostVersion = JSON.parse(readFileSync(getService(ctx, 'profileContext')?.installAnchor, 'utf8')).version } catch { /* Unknown hosts cannot install code. */ }
    moduleStore = new ModuleStore({ profileDir, dataPaths: paths, specs: SUB_PLUGINS, hostVersion,
      getManager: () => getService(ctx, 'pluginManager'),
      isBusy: () => { const agents = getService(ctx, 'agents'); return !agents?.list || agents.list().some(a => a.status === 'running') },
    })
    modulePaths = moduleStore.paths
    const boot = moduleStore.adoptLegacy().then(() => {
      if (disposed) return
      const specs = () => moduleStore.specs()
      const saved = loadEnabled(modulePaths, specs())
      modules = mountModules(ctx, { log, profileDir, paths: modulePaths, getSpecs: specs, initiallyEnabled: saved.enabled,
        load: dir => moduleStore.resolvePlugin(dir), canChange: () => !moduleStore.activeJob && !disposed,
        withChange: fn => moduleStore.exclusive(fn),
      })
      moduleStore.modules = modules
      moduleStore.startChecks()
      return modules.ready()
    }).catch(error => { moduleStore.initializationError = '模块初始化失败：' + error.message; log.warn('%s',moduleStore.initializationError) })
    moduleStore.ready = () => boot
  } catch (error) {
    log.warn('模块挂载失败：%o', error)
  }
  // 卸载时先摘子 fiber：不许让子插件活过一个已经不存在的父 fiber。
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => async () => {
        moduleStore?.close()
        try { await modules?.disposeAll() } catch (error) { log.warn('卸载模块失败：%s', error?.message ?? error) }
      }, 'laurel-center: modules')
    }
  } catch { /* effect 不可用就靠 fiber 树自己收 */ }

  // ── 启动时只做一次性迁移（异步，不挡住激活）───────────────────────────
  try {
    mountPresentation(ctx, paths.dir, profileIdentityOf(ctx).key ?? getService(ctx, 'profileContext')?.dir ?? 'default')
  } catch (error) { log.warn('控制中心偏好通道未挂载：%s', error.message) }

  // ── 模块开关端点（唯一的写端点；鉴权与 presentation 同一套）────────────
  try {
    mountModuleSwitch(ctx, modulePaths, log, () => modules)
    mountStoreApi(ctx, () => moduleStore, log)
  } catch (error) { log.warn('模块开关端点未挂载：%s', error?.message ?? error) }
  const migrationSink = { last: { reason: 'not-run' }, attempts: [] }
  let cancelMigration = () => {}
  try {
    cancelMigration = scheduleMigration(ctx, paths, log, () => disposed, migrationSink)
  } catch (error) {
    log.warn('调度迁移失败：%o', error)
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => () => cancelMigration(), 'laurel-center: migration schedule')
  } catch { /* ignore */ }

  // ── 流水：宿主自己的变更事件就是最好的审计来源 ─────────────────────────
  try {
    ctx.on?.('plugin-manager/changed', (payload) => {
      appendEvent({ kind: 'host-change', reason: payload?.reason ?? null }, paths)
    })
  } catch { /* 事件订阅不可用就算了，流水不是核心功能 */ }

  // ── 宿主侧的只读诊断（给测试和其它插件用；前端走原生 RPC）──────────────
  const service = {
    /** 七个公开模块的清单（只认 lib/registry.js，不在这里重抄）。 */
    list: () => moduleStore?.snapshot().modules ?? SUB_PLUGINS.map((p) => ({ ...p })),
    store: () => moduleStore?.snapshot() ?? null,
    ready: () => moduleStore?.ready?.() ?? Promise.resolve(),
    /** 原生状态（含 entryId / fiberPhase / 冲突原因）。 */
    status: () => listNative(ctx),
    /** 原生诊断信息。 */
    describe: () => describe(paths),
    /** 当前运行实例的身份：version / buildHash / builtAt / startAt / instanceId（F7）。 */
    identity: () => ({ ...identity }),
    /** 最近一次迁移的结论（只读，供诊断核对）。 */
    migration: () => ({ last: { ...migrationSink.last }, attempts: [...(migrationSink.attempts ?? [])] }),
    /**
     * 显式重试一次迁移（G1：失败不终结，可以重来）。
     * 会**重新核对用户层**：期间用户明确关闭的项一律不迁。卸载后不写。
     */
    retryMigration: async () => {
      if (disposed) return { skipped: 'disposed' }
      const result = await runMigration(ctx, paths, log, () => disposed, migrationSink.last?.attempt ?? 0)
      migrationSink.last = result
      if (Array.isArray(migrationSink.attempts)) {
        migrationSink.attempts.push({ round: result.attempt, reason: result.reason, aborted: result.aborted === true, recorded: result.recorded, completed: result.completed === true, outcomes: result.outcomes, explicitRetry: true })
      }
      return result
    },
    /** 用户层显式条目（诊断用；不改任何东西）。 */
    overrides: () => readOverrides(ctx),

    // ── 1.5.0 的模块开关（子 fiber + modules.json）───────────────────────
    /**
     * 开关表 + 每个模块真实的挂载状态（只读）。
     * 开关从 modules.json 读，状态来自 mountModules() 的活对象 ——
     * 「磁盘上写着开」和「真的挂上了」是两件事，这里都如实给出。
     */
    modules: () => {
      const saved = loadEnabled(modulePaths, moduleStore?.specs())
      return {
        enabled: saved.enabled,
        updatedAt: saved.updatedAt,
        readOk: saved.readOk,
        readReason: saved.reason,
        mounted: modules === null ? [] : modules.list(),
        status: modules === null ? [] : modules.status(),
      }
    },
    /**
     * 开关一个模块。先写 modules.json 再热挂/热摘（见 lib/modules.js），
     * 所以调用返回时磁盘与运行态是一致的 —— 除非写盘失败，那时什么都不改。
     *
     * @returns {Promise<{ ok: boolean, id: string, enabled: boolean, applied: boolean, reason?: string }>}
     */
    setModule: async (id, enabled) => {
      if (disposed) return { ok: false, id, enabled: enabled === true, applied: false, reason: 'disposed' }
      if (modules === null) return { ok: false, id, enabled: enabled === true, applied: false, reason: 'modules-unavailable' }
      const item = await modules.setEnabled(id, enabled === true)
      appendEvent({
        kind: 'module-switch',
        source: 'service',
        id,
        enabled: enabled === true,
        applied: item?.applied === true,
        reason: item?.reason ?? null,
      }, paths)
      return item
    },
    /** 模块开关落在哪（诊断用：路径 + 当前是否存在）。 */
    moduleConfig: () => ({
      file: modulesPath(modulePaths),
      available: modules !== null,
      mounted: modules === null ? [] : modules.list(),
    }),

    // ── 旧通道（1.5.0 起保留但通常无效）─────────────────────────────────
    // 下面两个走的是宿主原生 pluginManager.setPluginEnabled(entryId)，
    // 它写的是 profile 的用户层 cordis.patch.yml。模块已经不是 loader 行了，
    // 所以**没有 loader 行时这是 no-op**：宿主找不到 entryId，返回失败项。
    // 保留是因为：① 老装法（七个公开模块各占一行）升级上来时还能用一次；
    // ② 有测试与外部脚本直接调它。等老装法彻底不作数再删。
    /**
     * 旧通道：逐项写 profile 的用户层 patch。无 loader 行时是 no-op。
     * @deprecated 用 setModule(id, enabled)（走 modules.json）
     */
    setOne: async (id, enabled) => {
      const operationId = newOperationId('op')
      const item = await setNative(ctx, id, enabled)
      const answer = envelope(operationId, [item])
      appendEvent({ kind: 'switch', source: 'service', operationId, id, enabled: enabled === true, outcome: answer.outcome, reason: item.reason }, paths)
      return answer
    },
    /**
     * 旧通道：一键全开/全关，逐项串行写用户层 patch。
     * 与 setOne 同理 —— 无 loader 行时是 no-op。
     * @deprecated 用 modules() + 逐个 setModule(id, enabled)
     */
    setAll: async (enabled) => {
      const operationId = newOperationId('bulk')
      const items = await setNativeAll(ctx, enabled)
      const answer = envelope(operationId, items)
      appendEvent({ kind: 'switch-bulk', source: 'service', operationId, enabled: enabled === true, outcome: answer.outcome, failed: answer.failed, partial: answer.partial, unknown: answer.unknown }, paths)
      return answer
    },
  }

  // ── R10：真实的 provide，而不是 ctx.set 一个不存在的服务 ────────────────
  // 旧版用 `ctx.set('laurelCenter', …)`，而 ctx.set 只能**更新已被 provide 的服务**，
  // 于是真实 Cordis 里 get('laurelCenter') 永远是 undefined，异常还被吞掉。
  // 现在用 ctx.provide 真正注册，并由 effect 在停用时清理。
  try {
    if (typeof ctx.provide === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const dispose = ctx.provide('laurelCenter', service)
        return () => { if (typeof dispose === 'function') dispose() }
      }, 'laurel-center: service')
    }
  } catch (error) {
    log.warn('注册 laurelCenter 服务失败：%o', error)
  }

  log.debug('已激活 v%s build=%s，数据目录 %s', identity.version, identity.buildHash ?? '(未确认)', paths.dir)
}

export { getService, listNative, setNative, setNativeAll, planMigration }
export { mountModules, loadEnabled, saveEnabled, modulesPath } from './modules.js'

