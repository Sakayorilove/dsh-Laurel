/**
 * Laurel 系列 · 三级日志
 *
 * 两个刻意的设计：
 *   1. **日志永远不许影响主流程。** 每次输出都包在 try 里 —— 插件坏掉不能连累宿主
 *      里的任何别的东西，这是一条纪律，不是保险。
 *   2. 级别过滤在**调用点**完成，所以 `debug` 关掉时连参数拼串都不做。
 */

/** 级别 → 权重。数字越大越严重。 */
const RANK = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * 造一个带前缀的 logger。
 * @param {string} prefix 每条日志的前缀，例如 `[laurel]`
 * @param {string} [level] debug / info / warn / error，默认 info
 */
export function makeLogger(prefix, level = 'info') {
  const min = RANK[level] ?? 20
  const make = (name, fn) => (...args) => {
    if (RANK[name] < min) return
    try { fn(prefix, ...args) } catch { /* 日志不许影响主流程 */ }
  }
  return {
    debug: make('debug', console.debug.bind(console)),
    info: make('info', console.info.bind(console)),
    warn: make('warn', console.warn.bind(console)),
    error: make('error', console.error.bind(console)),
  }
}

/** 校验一个 logLevel 字面量是否合法。 */
export function isLogLevel(value) {
  return typeof value === 'string' && Object.hasOwn(RANK, value)
}
