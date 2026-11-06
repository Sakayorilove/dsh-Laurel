/**
 * laurel-reasoning-scroll · 宿主半边入口
 *
 * 这个模块的宿主半边**没有引擎、没有钩子、没有定时器**。它只做三件事：
 *   1. 把配置归一化并落盘（`$DSH_HOME/laurel-reasoning-scroll/settings.json`）；
 *   2. 挂一条前缀路由给浏览器半边读写这八个开关；
 *   3. 记一份可核对的状态快照（版本、路径、落盘状态）。
 *
 * ── 为什么开关不放在宿主的 settings 文档里 ──────────────────────────────
 * 宿主那份文档只收**声明了 Config（schemastery）**的入口，命名空间取自 loader
 * 行 id；而套件的 loader 行 id 是短名 `reasoning-scroll`，包名却是
 * `laurel-reasoning-scroll`。两者一旦漂开，`configForms.get()` 拿到的是
 * unavailable —— 不报错，只是设置页永远写不进去。套件里九个子包全都走
 * 「自己的 settings.json + 一条前缀路由」，这一条也照办。
 *
 * ── 三条纪律（与同套件模块一致，每条都踩过）────────────────────────────
 *   1. **顶层 inject 留空**。cordis 的 Context 是受控代理，没写进 inject 的
 *      服务用 `ctx.X` 访问会直接抛；用 `ctx.get(name)` + try/catch 更安全，
 *      非 Web 组合（CLI / 无头）也才能激活。
 *   2. **三层归一化**：出厂默认 → loader 行 config → settings.json。
 *   3. **所有 IO 吞异常，但降级必须可见**：读不到配置就用上一层，同时把
 *      原因记进状态快照 —— 界面要能区分「没配置」和「配置坏了」。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { CONFIG_KEYS, DEFAULT_CONFIG, normalizeConfig, pickKnown } from './core/config.js'
import { pluginPaths, resolveDshHome } from './core/home.js'
import { createHandler, ROUTE_PREFIX } from './host/routes.js'

/** 包名。与 package.json 的 name 一致。 */
export const PACKAGE_NAME = 'laurel-reasoning-scroll'

/** 版本。与 package.json 的 version 一致（对外端点会带出去）。 */
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
    try { fn('[laurel-reasoning-scroll]', ...args) } catch { /* 日志不许影响主流程 */ }
  }
  return {
    debug: make('debug', console.debug.bind(console)),
    info: make('info', console.info.bind(console)),
    warn: make('warn', console.warn.bind(console)),
    error: make('error', console.error.bind(console)),
  }
}

/**
 * 读设置页写的那份配置。读不出来一律当作「没有这份文件」，绝不抛。
 * 返回值带上读失败的原因，让状态快照能说清是「没有」还是「坏了」。
 */
export function loadSettings(home) {
  const file = pluginPaths(home).settings
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // 两种写法都认：{ config: {...} }（本模块写的）与扁平的 {...}（手改的）。
      const config = parsed.config && typeof parsed.config === 'object' && !Array.isArray(parsed.config)
        ? parsed.config
        : parsed
      return { config, problem: null, file }
    }
    return { config: {}, problem: '设置文件不是一个 JSON 对象', file }
  } catch (error) {
    const code = String(error?.code ?? '')
    // ENOENT 是正常情况（从没打开过设置页），不当问题报。
    return { config: {}, problem: code === 'ENOENT' ? null : String(error?.message ?? error), file }
  }
}

/**
 * 原子写设置：先写临时文件、核对字节数、再 rename。
 * 半份配置被换上去的后果是「重启后一半设置回默认」，比写失败难查得多。
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
 * 回读核对：盘上那份与内存这份是否一致。
 *
 * 只信「我刚写成功」这一个证据链太短 —— 权限、杀软、另一个进程覆盖都可能让
 * 写调用返回成功而盘上是别的。这里逐字段比对，结论写进端点响应。
 */
export function verifyPersisted(config, home) {
  const { config: onDisk, problem, file } = loadSettings(home)
  if (problem !== null) return { exists: false, matches: false, reason: problem, file }
  const keys = CONFIG_KEYS
  const missing = keys.filter((k) => onDisk[k] === undefined)
  if (missing.length === keys.length) return { exists: false, matches: false, reason: '盘上没有这份配置', file }
  const diff = keys.filter((k) => onDisk[k] !== undefined && onDisk[k] !== config[k])
  return {
    exists: true,
    matches: diff.length === 0,
    reason: diff.length === 0 ? '盘上与内存一致' : '盘上与内存不一致：' + diff.join(','),
    file,
    differs: diff,
  }
}

/**
 * @param {any} ctx cordis 上下文
 * @param {Record<string, unknown>} config loader 行里那份 config（当默认值用）
 * @param {{home?: string}} [options] 测试注入
 */
export function apply(ctx, config = {}, options = {}) {
  const home = typeof options.home === 'string' && options.home.length > 0
    ? options.home
    : resolveDshHome()

  /** 第一层：出厂默认；第二层：loader 行 config。 */
  const fromPatch = normalizeConfig(config, DEFAULT_CONFIG)
  const log = makeLogger(fromPatch.logLevel ?? 'info')

  /** 第三层：settings.json 盖在 patch 默认值上。 */
  const stored = loadSettings(home)
  let current = stored.config && Object.keys(stored.config).length > 0
    ? normalizeConfig(stored.config, fromPatch)
    : { ...fromPatch }

  const getConfig = () => ({ ...current })

  /** 持久化状态：界面必须能区分「内存已生效」与「已落盘」。 */
  let persistence = stored.problem === null
    ? { persisted: null, reason: '尚未写过设置', at: null }
    : { persisted: false, reason: '设置文件读不出来（用的是上一层）：' + stored.problem, at: null }

  /**
   * 改配置：归一化 → 落盘 → 回读核对 → 返回生效值。
   *
   * 写盘失败**必须照实说**：内存里已经生效但重启会丢，
   * 界面不能只看「POST 成功」就显示已保存。
   */
  const setConfig = (patch) => {
    const candidate = normalizeConfig(patch, current)
    const saved = saveSettings(candidate, home)
    if (saved.ok) {
      persistence = { persisted: true, reason: '已落盘', at: new Date().toISOString(), file: saved.file }
    } else {
      persistence = { persisted: false, reason: saved.reason, at: null }
      log.warn('配置写盘失败（内存里已生效，但重启会丢）：' + saved.reason)
    }
    current = candidate
    return { ok: saved.ok === true, persisted: saved.ok === true, reason: persistence.reason, config: getConfig() }
  }

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
          getPersistence: () => ({ ...persistence }),
          verifyPersisted: () => verifyPersisted(current, home),
          paths: pluginPaths(home),
          getConnection: () => requireService(routeCtx, 'connection'),
          version: VERSION,
          log,
        }),
      }))
    } catch (error) {
      log.warn('HTTP 路由挂载失败（设置页数据面不可用）：' + String(error?.message ?? error))
    }
    // ctx.effect：服务重建/插件卸载时自动收掉路由，不留悬挂注册。
    return routeCtx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* 清理失败无所谓 */ }
      }
    }, 'laurel-reasoning-scroll.routes')
  }

  try {
    ctx.inject(['webServer'], mountRoutes)
  } catch (error) {
    log.warn('webServer 订阅失败（设置页与配置读取不可用）：' + String(error?.message ?? error))
  }

  /* ---------------- 就绪 ---------------- */

  const paths = pluginPaths(home)
  if (stored.problem !== null) log.warn('设置文件读不出来，已退回上一层默认值：' + stored.problem)
  log.info('已挂载：' + (current.enabled ? '启用' : '停用')
    + ' 限高=' + current.maxHeight + 'px'
    + ' 渐变=' + (current.gradientText ? '开' : '关')
    + ' 工具过程并入=' + (current.includeToolCalls ? '开' : '关')
    + ' 配置=' + paths.settings)

  return {
    /** 给宿主/测试看的只读快照。 */
    status: () => ({
      ok: true,
      data: {
        package: PACKAGE_NAME,
        version: VERSION,
        config: getConfig(),
        defaults: pickKnown(DEFAULT_CONFIG),
        keys: [...CONFIG_KEYS],
        persistence: { ...persistence },
        verified: verifyPersisted(current, home),
        paths,
        route: ROUTE_PREFIX,
      },
    }),
    /** 测试与隔离验收用的内部句柄。 */
    internals: { getConfig, setConfig, home, paths },
    /** 全量清理。**可重复调用**。本模块没有定时器与监听，所以恒为 0。 */
    dispose: () => ({ listeners: 0, timers: 0 }),
  }
}
