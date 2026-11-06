/**
 * Laurel · 宿主半边
 *
 * 这个包真正干活的是浏览器半边（`lib/client.js`）：它订阅 DSH 客户端已有的会话状态，
 * 在"agent 需要你"的时候弹一条系统通知。宿主这里只做三件事：
 *
 *   1. **配置的权威来源** —— patch 默认值 + `$DSH_HOME/laurel/settings.json` 覆盖，
 *      浏览器半边通过 HTTP 读它；
 *   2. **事件回收站** —— 浏览器半边把"弹了/点了/失败了"回传上来落盘，
 *      事后（包括让 agent 自己）能核对到底响没响、为什么没响；
 *   3. 不干别的。**不注入提示词、不注册工具、不说话。**
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────
 *   1. 顶层 `inject` 留空；Web 路由用子插件等待 `webServer` 就绪后挂载。
 *      非 Web 组合仍可激活，Web 服务晚到或重建时也不会丢失设置接口。
 *   2. 家目录只认 `DSH_HOME`（见 store.js 的注释），不从 profile 目录推。
 *   3. 所有 IO 都吞异常：通知功能坏掉，不许连带影响宿主里的任何别的东西。
 */

import { PACKAGE_NAME, VERSION, DEFAULT_CONFIG, normalizeConfig, pickKnown, pluginPaths, resolveDshHome, loadSettings, saveSettings, createHandler, appendEvent, ensureSoundsDir } from './store.js'

/** cordis 的 Context 是受控代理：没写进 inject 的服务用 `ctx.X` 访问会直接抛。这里故意一个都不要。 */
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
    try { fn('[laurel]', ...args) } catch { /* 日志不许影响主流程 */ }
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
 * @param {Record<string, unknown>} config patch 里那份 config（默认值）
 */
export function apply(ctx, config = {}) {
  const home = resolveDshHome()
  /** patch 给的是默认值。 */
  const fromPatch = normalizeConfig(config, DEFAULT_CONFIG)
  const log = makeLogger(fromPatch.logLevel)

  /** 生效配置：settings.json（设置页写的）盖在 patch 默认值上。 */
  let current = (() => {
    const stored = loadSettings(home)
    return stored.config ? normalizeConfig(stored.config, fromPatch) : fromPatch
  })()

  const getConfig = () => ({ ...current })

  /** 写配置：归一化 → 落盘 → 返回生效值。返回值就是浏览器半边拿到的权威结果。 */
  const setConfig = (patch) => {
    current = normalizeConfig(patch, current)
    try {
      saveSettings(current, home)
    } catch (error) {
      log.warn(`配置落盘失败（本次改动只在内存里生效）：${error?.message ?? error}`)
    }
    return getConfig()
  }

  const mountRoutes = (routeCtx) => {
    const webServer = requireService(routeCtx, 'webServer')
    if (!webServer?.register) return
    return routeCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/laurel',
      handler: createHandler({ home, getConfig, setConfig, log }),
    }), 'laurel.routes')
  }

  try {
    // ctx.get() 只看当前已激活的服务，不会等待异步启动中的 webServer。
    // 子插件让 Cordis 管理等待、服务重建和路由清理，顶层仍不强制依赖 Web。
    ctx.inject(['webServer'], mountRoutes)
  } catch (error) {
    log.warn(`路由订阅失败（设置页与配置读取不可用）：${error?.message ?? error}`)
  }

  const paths = pluginPaths(home)
  ensureSoundsDir(home)
  appendEvent({ kind: 'ready', detail: `host ${VERSION}` }, home)

  log.info(`已挂载：提问=${current.notifyOnQuestion} 审批=${current.notifyOnApproval} 完成=${current.notifyOnCompletion}`
    + ` 只在没看窗口时=${current.onlyWhenUnfocused} 节流=${current.throttleSeconds}s`
    + ` 提示音=${current.sound === false ? '静音' : (current.soundFile || '系统通知音')}`
    + ` 配置=${paths.settings}`)

  return {
    /** 给宿主/测试看的只读快照。 */
    status: () => ({
      ok: true,
      data: {
        package: PACKAGE_NAME,
        version: VERSION,
        home,
        config: getConfig(),
        paths,
        defaults: pickKnown(DEFAULT_CONFIG),
      },
    }),
  }
}
