/**
 * Dynamic module switches and Cordis child lifecycles.
 * Code is resolved from immutable profile-local slots; enable state is stored beside installed.json.
 * Await activation and disposal; serialize changes with the ModuleStore transaction lock.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { SUB_PLUGINS } from './registry.js'
import { centerPaths } from './store.js'

/** 模块开关文件。与 state.json 分开：state.json 是旧迁移的**只读输入**。 */
export function modulesPath(paths = centerPaths()) {
  return join(paths.dir, 'modules.json')
}

/** 默认开关表：直接取注册表的 defaultOn，不在这里重抄第二份。 */
export function defaultEnabled(specs = SUB_PLUGINS) {
  const out = {}
  for (const p of specs) out[p.id] = p.defaultOn === true
  return out
}

/**
 * 读开关表。文件不存在 / 坏掉 / 字段不认识 → 逐项回落默认值。
 * @returns {{ enabled: Record<string, boolean>, updatedAt: string | null, readOk: boolean, reason: string | null }}
 */
export function loadEnabled(paths = centerPaths(), specs = SUB_PLUGINS) {
  const defaults = defaultEnabled(specs)
  const file = modulesPath(paths)
  try {
    if (!existsSync(file)) return { enabled: defaults, updatedAt: null, readOk: true, reason: 'no-file' }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const enabled = { ...defaults }
    const saved = raw?.enabled
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const p of specs) {
        if (typeof saved[p.id] === 'boolean') enabled[p.id] = saved[p.id]
      }
    }
    return {
      enabled,
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
      readOk: true,
      reason: null,
    }
  } catch (error) {
    return { enabled: defaults, updatedAt: null, readOk: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 原子写开关表。先写临时文件再改名，避免半截文件。
 * @returns {{ ok: boolean, enabled?: Record<string, boolean>, reason?: string }}
 */
export function saveEnabled(enabled, paths = centerPaths(), specs = SUB_PLUGINS) {
  const defaults = defaultEnabled(specs)
  const next = { ...defaults }
  for (const p of specs) {
    if (typeof enabled?.[p.id] === 'boolean') next[p.id] = enabled[p.id]
  }
  const file = modulesPath(paths)
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, JSON.stringify({ enabled: next, updatedAt: new Date().toISOString() }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
    return { ok: true, enabled: next }
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* 清理失败不重要 */ }
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/** 取一个包名到模块 id 的映射（挂载失败时回填用）。 */
function byId(id) {
  return SUB_PLUGINS.find((p) => p.id === id) ?? null
}

/**
 * 把一个模块包解析成可交给 \`ctx.plugin()\` 的东西。
 *
 * 宿主侧模块都是 ESM，`export function apply(ctx, config)` + `export const inject`。
 * Cordis 接受「带 apply 的对象」作为插件（vendor/cordis/src/registry.ts 的 isApplicable），
 * 所以这里把模块命名空间原样返回，不需要包装。
 *
 * @param {string} dir 注册表里的 dir（packages/<dir>）
 * @returns {Promise<{ ok: true, plugin: any } | { ok: false, reason: string }>}
 */
/** dir → 包名（注册表的 entry 字段就是纯包名）。 */
export function packageNameOf(dir) {
  const spec = SUB_PLUGINS.find((p) => p.dir === dir)
  return spec === undefined ? null : spec.entry
}

/**
 * 从 profile 目录解析一个模块包的宿主半边。
 *
 * ── 为什么不能直接 import(name) ────────────────────────────────────────
 * 这个文件实际住在包目录里（profile 的 node_modules 只是链接）。
 * ESM 裸包名解析按 realpath 往上层走，于是从 <包目录>\\lib\\
 * 一路往上找 node_modules，根本看不到 profile 的 node_modules —— 实测报
 * "Cannot find package 'laurel' imported from …\\laurel-center\\lib\\modules.js"。
 *
 * 所以显式用 profile 目录构造 createRequire 锚点：宿主 loader 解析那九行时
 * 走的就是这条路（baseUrl = profile 的 cordis.yml）。
 *
 * @param {string} dir 注册表里的 dir（packages/<dir>）
 * @param {{ profileDir?: string | null, importModule?: (url: string) => Promise<any> }} [options]
 * @returns {Promise<{ ok: true, plugin: any } | { ok: false, reason: string }>}
 */
export async function resolveModulePlugin(dir, { profileDir = null, importModule = (url) => import(url) } = {}) {
  try {
    const name = packageNameOf(dir)
    if (name === null) return { ok: false, reason: 'not-in-registry' }
    if (typeof profileDir !== 'string' || profileDir.length === 0) return { ok: false, reason: 'no-profile-dir' }
    // A collection always loads its own vendored module, never an older
    // same-named package left in the user's profile.
    const root = new URL('../packages/' + dir + '/', import.meta.url)
    const meta = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
    const entry = meta.exports?.['.'] || meta.main
    if (typeof entry !== 'string' || !entry.startsWith('./')) return { ok: false, reason: 'invalid-bundled-entry' }
    const url = new URL(entry, root)
    if (!url.href.startsWith(root.href)) return { ok: false, reason: 'invalid-bundled-entry' }
    return { ok: true, plugin: await importModule(url.href) }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 按开关表把模块挂成 laurel-center 的子插件。
 *
 * **不产生 Loader entry**：Cordis 的子 fiber 挂在当前 entry 下，
 * 而宿主插件列表只遍历 `ctx.loader.entries()`（见 host/plugin-inventory）。
 * 所以 DSH 原生「插件」页只会看到 laurel-center 一张卡。
 *
 * @param {any} ctx laurel-center 的上下文
 * @param {{ log: any, initiallyEnabled?: Record<string, boolean>, load?: Function }} options
 * @returns {{ setEnabled: Function, list: Function, disposeAll: Function, status: Function }}
 */
export function mountModules(ctx, { log, profileDir = null, initiallyEnabled = defaultEnabled(), load = null, paths = centerPaths(), getSpecs = () => SUB_PLUGINS, canChange = () => true, withChange = fn => fn() } = {}) {
  let closed = false
  let tail = Promise.resolve()
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result }
  const lookup = id => getSpecs().find(p => p.id === id) || null
  /** id → { fiber, plugin } */
  const mounted = new Map()
  /** id → 最近一次挂载失败原因（诊断用，不影响别人） */
  const failures = new Map()

  const unmount = async (id) => {
    const item = mounted.get(id)
    if (item === undefined) return false
    try { await item.fiber?.dispose?.() } catch (error) { throw Error('卸载 ' + id + ' 失败：' + error.message) }
    mounted.delete(id)
    return true
  }

  const mount = async (id) => {
    if (mounted.has(id)) return { ok: true, already: true }
    if (closed) return { ok: false, reason: 'disposed' }
    const spec = lookup(id)
    if (spec === null) return { ok: false, reason: 'unknown-module' }
    const resolved = load === null ? await resolveModulePlugin(spec.dir, { profileDir }) : await load(spec.dir)
    if (resolved.ok !== true) {
      failures.set(id, resolved.reason)
      return { ok: false, reason: resolved.reason }
    }
    failures.delete(id)
    try {
      if (closed) return { ok: false, reason: 'disposed' }
      const fiber = ctx.plugin(resolved.plugin)
      try {
        if (typeof fiber.await === 'function') {
          let timer
          try { await Promise.race([fiber.await(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('模块启动超时')), 10000) })]) }
          finally { clearTimeout(timer) }
          if (fiber.state !== 2) throw Error('模块等待依赖，尚未激活')
        }
        if (closed) throw Error('disposed')
      } catch (error) { await fiber.dispose?.(); throw error }
      mounted.set(id, { fiber, plugin: resolved.plugin })
      return { ok: true, created: true }
    } catch (error) {
      const reason = String(error?.message ?? error)
      failures.set(id, reason)
      return { ok: false, reason }
    }
  }

  /** 按当前开关表对齐：该开的挂上、该关的摘掉。逐项隔离，互不连坐。 */
  const reconcile = async (enabled) => {
    const result = { mounted: [], unmounted: [], failed: [] }
    for (const spec of getSpecs()) {
      const want = enabled[spec.id] === true
      const has = mounted.has(spec.id)
      if (want && !has) {
        const item = await mount(spec.id)
        if (item.ok) result.mounted.push(spec.id)
        else result.failed.push({ id: spec.id, reason: item.reason })
      } else if (!want && has) {
        if (await unmount(spec.id)) result.unmounted.push(spec.id)
      }
    }
    return result
  }

  // 首次对齐：异步，不挡住 apply()。
  const bootstrap = serial(() => reconcile(initiallyEnabled)).catch((error) => {
    log?.warn?.('模块初始加载异常：%s', String(error?.message ?? error))
    return null
  })

  return {
    /** 等首轮对齐结束（测试与端点用）。 */
    ready: () => bootstrap,
    /** 当前真正挂着的模块 id。 */
    list: () => [...mounted.keys()],
    /** 诊断：每个模块的挂载状态与最近失败原因。 */
    specs: () => getSpecs(),
    enabled: id => loadEnabled(paths, getSpecs()).enabled[id] === true,
    forget: id => {
      const current = loadEnabled(paths, getSpecs())
      if (!current.readOk) throw Error('模块开关记录损坏')
      const saved = saveEnabled({ ...current.enabled, [id]: false }, paths, getSpecs())
      if (!saved.ok) throw Error(saved.reason)
    },
    remember: id => {
      const current = loadEnabled(paths,getSpecs()), saved = current.readOk && saveEnabled({...current.enabled,[id]:true},paths,getSpecs())
      if (!saved?.ok) throw Error('无法恢复模块开关')
    },
    suspend: id => serial(() => unmount(id)),
    resume: id => serial(() => mount(id)),
    status: () => getSpecs().map((p) => ({
      id: p.id,
      mounted: mounted.has(p.id),
      reason: failures.get(p.id) ?? null,
    })),
    /**
     * 开关一个模块。**先写盘再热挂**：写失败就不改运行态，
     * 免得「界面上是开的、磁盘上是关的」。
     *
     * @returns {Promise<{ ok: boolean, id: string, enabled: boolean, applied: boolean, reason?: string, restartHelps?: boolean }>}
     */
    setEnabled: (id, enabled) => serial(() => withChange(async () => {
      if (closed || !canChange()) return { ok: false, id, enabled, applied: false, reason: '安装事务正在进行或服务已停止' }
      const spec = lookup(id)
      if (spec === null) return { ok: false, id, enabled, applied: false, reason: 'unknown-module' }
      const current = loadEnabled(paths, getSpecs())
      if (!current.readOk) return { ok: false, id, enabled, applied: false, reason: '模块开关记录损坏，未覆盖原记录' }
      const next = { ...current.enabled, [id]: enabled === true }
      const saved = saveEnabled(next, paths, getSpecs())
      if (saved.ok !== true) return { ok: false, id, enabled, applied: false, reason: saved.reason }
      const item = await reconcile(next)
      const applied = enabled === true
        ? item.mounted.includes(id) || mounted.has(id)
        : item.unmounted.includes(id) || !mounted.has(id)
      const failure = item.failed.find((f) => f.id === id)
      return {
        ok: applied,
        id,
        enabled: enabled === true,
        applied,
        ...(failure === undefined ? {} : { reason: failure.reason }),
        restartHelps: false,
      }
    })),
    /** 全部关闭（卸载时清理用；也供「一键全关」）。 */
    disposeAll: () => {
      closed = true
      return serial(async () => { for (const id of [...mounted.keys()]) await unmount(id) })
    },
  }
}
