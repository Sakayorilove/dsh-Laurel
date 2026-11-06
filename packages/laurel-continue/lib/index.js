/**
 * laurel-continue · 宿主半边入口
 *
 * 这个模块干什么：会话因为**非人为中断**停下之后，替人发一句「继续」；
 * 只在你配置的时段里生效；能自动选中带推荐项的提问；并且**遇到别人已经
 * 处理过的情况主动让位**（上下文压缩、等待截断）。
 *
 * ── 四条纪律（每条都是踩过的）──────────────────────────────────────────
 *   1. **顶层 `inject` 留空**。cordis 的 Context 是受控代理，没写进 inject
 *      的服务用 `ctx.X` 访问会直接抛；用 `ctx.get(name)` + try/catch 更安全，
 *      非 Web 组合（CLI / 无头）也才能激活。Web 路由走 `ctx.inject(['webServer'])`
 *      让 cordis 管等待、重建与清理。
 *   2. **配置三层归一化**：出厂默认 → patch config → settings.json（设置页写的）。
 *      每一层都过同一个 `normalizeConfig`，任何一层写坏都不会让引擎带着
 *      `NaN` 去干活。
 *   3. **家目录只认 `DSH_HOME`**，不从 profile 目录往上推。
 *   4. **所有 IO 与钩子都吞异常，但降级必须可见**：坏掉不许连带影响宿主里
 *      别的东西，同时每次吞异常都要写进事件日志 —— 否则「让位生效了」这件事
 *      事后无从核对。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

import { CONFIG_KEYS, DEFAULT_CONFIG, normalizeConfig, pickKnown } from './core/config.js'
import { resolveDshHome, pluginPaths } from './core/home.js'
import { createEventLog, createStats } from './core/stats.js'
import { describeSchedule, isScheduleActive } from './core/schedule.js'
import { createEngine } from './host/engine.js'
import { installAnswers } from './host/answers.js'
import { createHandler, ROUTE_PREFIX } from './host/routes.js'

/** 包名。与 package.json 的 name 一致。 */
export const PACKAGE_NAME = 'laurel-continue'

/** 版本。与 package.json 的 version 保持一致（对外端点会带出去）。 */
export const VERSION = '0.1.0'

/** 顶层 inject 故意留空。见上文纪律 1。 */
export const inject = []

/** 取服务：拿不到返回 null，不抛。 */
function requireService(ctx, name) {
  try {
    return ctx?.get?.(name) ?? null
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
    try { fn('[laurel-continue]', ...args) } catch { /* 日志不许影响主流程 */ }
  }
  return {
    debug: make('debug', console.debug.bind(console)),
    info: make('info', console.info.bind(console)),
    warn: make('warn', console.warn.bind(console)),
    error: make('error', console.error.bind(console)),
  }
}

/**
 * 读设置页写的那份配置。读不出来一律当作「没有这份文件」，绝不抛 ——
 * 配置读不出来不该让插件起不来。
 */
export function loadSettings(home) {
  try {
    const raw = readFileSync(pluginPaths(home).settings, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed
  } catch { /* 没有 / 坏了都当没有 */ }
  return {}
}

/**
 * 原子写设置。
 *
 * 先写临时文件、确认字节数、再 rename：避免把半份配置换上去。
 *
 * @returns {{ok: true, persisted: true, file: string, bytes: number}
 *          |{ok: false, persisted: false, reason: string}}
 */
export function saveSettings(config, home) {
  const file = pluginPaths(home).settings
  const payload = {}
  for (const key of CONFIG_KEYS) payload[key] = config[key]
  const body = JSON.stringify({ config: payload, at: new Date().toISOString() }, null, 2) + '\n'
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, body, 'utf8')
    const written = statSync(tmp).size
    const expected = Buffer.byteLength(body, 'utf8')
    if (written !== expected) {
      throw new Error('临时文件只写了 ' + written + ' 字节，应为 ' + expected)
    }
    renameSync(tmp, file)
    return { ok: true, persisted: true, file, bytes: written }
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* 清不掉就算了 */ }
    return { ok: false, persisted: false, reason: String(error?.message ?? error) }
  }
}

/**
 * @param {any} ctx cordis 上下文
 * @param {Record<string, unknown>} config patch 里那份 config（当默认值用）
 * @param {{clock?: {now?: () => number}, home?: string}} [options] 测试注入
 */
export function apply(ctx, config = {}, options = {}) {
  const home = typeof options.home === 'string' && options.home.length > 0
    ? options.home
    : resolveDshHome()
  const now = typeof options.clock?.now === 'function' ? () => options.clock.now() : () => Date.now()

  /** 第一层：出厂默认；第二层：patch config。 */
  const fromPatch = normalizeConfig(config, DEFAULT_CONFIG)
  const log = makeLogger(fromPatch.logLevel)

  /** 第三层：settings.json（设置页写的）盖在 patch 默认值上。 */
  const stored = loadSettings(home)
  let current = stored.config
    ? normalizeConfig(stored.config, fromPatch)
    : { ...fromPatch }

  const getConfig = () => ({ ...current })

  /** 持久化状态：界面必须能区分「内存已生效」与「已落盘」。 */
  let persistence = { persisted: null, reason: '尚未写过设置', at: null }

  const events = createEventLog()
  const stats = createStats(now())

  const onEvent = (event) => {
    try { events.append(event, home) } catch { /* 记账失败无所谓 */ }
  }

  /** 引擎。deliver 默认走 agent.steer()，测试可注入。 */
  const engine = createEngine({
    config: getConfig,
    home,
    now,
    events,
    stats,
    log,
    ctx,
    version: VERSION,
    deliver: options.deliver,
    getAgent: (id) => requireService(ctx, 'agents')?.get?.(id) ?? null,
  })

  /** 自动应答的挂载句柄。 */
  let answersHandle = null
  /** 已挂的监听卸载函数。 */
  const engineOffs = []

  /**
   * 改配置：归一化 → 落盘 → 返回生效值。
   *
   * 写盘失败**必须照实说**：内存里已经生效但重启会丢，
   * 界面不能只看「POST 成功」就显示已保存。
   */
  const setConfig = (patch) => {
    const candidate = normalizeConfig(patch, current)
    const saved = saveSettings(candidate, home)
    if (saved.ok) {
      persistence = { persisted: true, reason: '已落盘', at: new Date(now()).toISOString(), file: saved.file }
    } else {
      persistence = { persisted: false, reason: saved.reason, at: null }
      log.warn('配置写盘失败（内存里已生效，但重启会丢）：' + saved.reason)
      onEvent({ at: now(), kind: 'error', detail: '配置写盘失败：' + saved.reason })
    }
    current = candidate
    reconcile()
    return getConfig()
  }

  /* ---------------- 挂载 / 卸载 ---------------- */

  function mountEngine() {
    const mounted = engine.start()
    if (mounted.mounted > 0) engineOffs.push(() => engine.dispose())
    return mounted.mounted
  }

  function mountAnswers() {
    try {
      answersHandle = installAnswers(ctx, {
        config: getConfig,
        log,
        events,
        onEvent,
        home,
      })
      return answersHandle
    } catch (error) {
      log.warn('自动应答挂载失败（其余功能正常）：' + String(error?.message ?? error))
      onEvent({ at: now(), kind: 'error', detail: '自动应答挂载失败：' + String(error?.message ?? error) })
      return null
    }
  }

  function unmountAnswers() {
    if (!answersHandle) return 0
    let count = 0
    try {
      const result = answersHandle.dispose()
      count = Number.isFinite(result?.mounted) ? result.mounted : 0
    } catch { /* 清理失败无所谓 */ }
    answersHandle = null
    return count
  }

  /** 按总开关决定钩子在不在（热生效，不用重启）。 */
  function reconcile() {
    const wanted = current.enabled !== false
    if (wanted) {
      if (engineOffs.length === 0) {
        const count = mountEngine()
        if (count > 0) log.info('已挂上 ' + count + ' 个宿主监听')
      }
      if (current.autoAnswer !== false && answersHandle === null) mountAnswers()
      if (current.autoAnswer === false) unmountAnswers()
    } else {
      while (engineOffs.length > 0) {
        const off = engineOffs.pop()
        try { off() } catch { /* 清理失败无所谓 */ }
      }
      unmountAnswers()
    }
  }

  reconcile()

  /* ---------------- HTTP ---------------- */

  const mountRoutes = (routeCtx) => {
    const webServer = requireService(routeCtx, 'webServer')
    if (!webServer?.register) {
      log.info('宿主没有 webServer 服务（非 Web 组合），设置页数据面不可用')
      return
    }
    const disposers = []
    try {
      disposers.push(webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createHandler({
          getConfig,
          setConfig,
          engine,
          events,
          home,
          defaults: pickKnown(DEFAULT_CONFIG),
          log,
          version: VERSION,
        }),
      }))
    } catch (error) {
      log.warn('HTTP 路由挂载失败（设置页数据面不可用）：' + String(error?.message ?? error))
      onEvent({ at: now(), kind: 'error', detail: 'HTTP 路由挂载失败：' + String(error?.message ?? error) })
    }
    // ctx.effect：服务重建/插件卸载时自动收掉路由，不留悬挂注册。
    return routeCtx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* 清理失败无所谓 */ }
      }
    }, 'laurel-continue.routes')
  }

  try {
    ctx.inject(['webServer'], mountRoutes)
  } catch (error) {
    log.warn('webServer 订阅失败（设置页与配置读取不可用）：' + String(error?.message ?? error))
  }

  /* ---------------- 就绪 ---------------- */

  const paths = pluginPaths(home)
  onEvent({
    at: now(),
    kind: 'fire',
    detail: 'host ' + VERSION + ' 就绪：时段=' + describeSchedule(current)
      + '（' + (isScheduleActive(current, now()) ? '当前生效' : '当前不生效') + '）'
      + ' 自动应答=' + (current.autoAnswer ? '开' : '关')
      + ' 自主循环=' + (current.loopAfterCompleted ? '开' : '关'),
  })

  log.info('已挂载：' + (current.enabled ? '启用' : '停用')
    + ' 时段=' + describeSchedule(current)
    + ' 宽限=' + current.graceMs + 'ms 冷却=' + current.cooldownMs + 'ms'
    + ' 连续上限=' + current.maxConsecutive
    + ' 自动应答=' + (current.autoAnswer ? '开' : '关')
    + ' 自主循环=' + (current.loopAfterCompleted
      ? '开（' + current.loopMaxRounds + ' 轮 / ' + Math.round(current.loopMaxDurationMs / 60000) + ' 分钟）'
      : '关')
    + ' 配置=' + paths.settings)

  return {
    /** 给宿主/测试看的只读快照。 */
    status: () => {
      const status = engine.getStatus()
      return {
        ok: true,
        data: {
          ...status.data,
          version: VERSION,
          persistence: { ...persistence },
          answers: answersHandle?.stats ?? null,
          paths,
          defaults: pickKnown(DEFAULT_CONFIG),
        },
      }
    },
    /** 测试与隔离验收用的内部句柄。 */
    internals: {
      engine,
      events,
      stats,
      getConfig,
      setConfig,
      reconcile,
      home,
    },
    /**
     * 全量清理：卸载监听、取消全部定时器、卸下自动应答。**可重复调用**。
     *
     * 返回值不是给界面看的，是给「卸载到底干不干净」这件事留证据的 ——
     * 定时器没取消干净时，进程会被一个看不见的 setTimeout 拽住。
     *
     * @returns {{listeners: number, answersMounted: number, timers: number}}
     */
    dispose: () => {
      let listeners = 0
      while (engineOffs.length > 0) {
        const off = engineOffs.pop()
        try { off() } catch { /* 清理失败无所谓 */ }
        listeners += 1
      }
      const answersResult = unmountAnswers()
      let timers = 0
      try {
        const result = engine.dispose()
        timers = Number.isFinite(result?.timers) ? result.timers : 0
      } catch { /* 清理失败无所谓 */ }
      return { listeners, answersMounted: answersResult, timers }
    },
  }
}
