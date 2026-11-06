/**
 * Laurel 系列 · 浏览器半边 kit（源码，不是产物）
 *
 * ── 为什么这个文件是 ESM，而不是直接就是 bundle ──────────────────────────
 * 客户端半边**不能** `require` 任意包。官方模块系统的解析顺序写死了：
 *
 *   platform seed 表（React / Cordis / 静态 UI 库）
 *   → 已物化的模块 → boot graph 的行 → 已注册的 factory
 *   其余一律抛 `require("x") missed the module table`。
 *
 * （出处：`@deepseek-ai/dsh-client-modules` 的 README「Sharing modules」与
 *  `lib/client.js` 的 resolution 实现。）
 *
 * 所以客户端代码**没法靠 npm 依赖共享**，只能在打包时把 kit **内联**进各自的
 * bundle。这就是本文件存在的理由：它是源码，由 `scripts/build-client.mjs`
 * 拼进 `lib/client.js`，运行时零依赖、跨包零依赖。
 *
 * ── kit 里为什么一个顶层 import 都没有 ──────────────────────────────────
 * 拼接出来的产物必须是一个自包含的 CJS factory 闭包，不能出现 ESM 语法
 * （`import`/`export` 会被当成 ESM 解析而崩）。所以：
 *   - 本文件用 ESM 写只是为了给编辑器/Node 看；
 *   - 它 export 的每个函数都**只讲闭包内可见的东西**（不 import 任何模块）；
 *   - 构建脚本会把 `export ` 关键字剥掉再拼进 factory。
 * 这个约定靠 `tests/verify-plugin.mjs` 的「kit 无顶层 import」断言守住。
 */

/**
 * kit 的版本。产物里会带一行注释，出问题时一眼能看出用的是哪版 kit。
 * 改 kit 就动这里，方便事后对版本。
 */
export const CLIENT_KIT_VERSION = 1

/* ------------------------------------------------------------------ *
 * 1. 与宿主数据面通讯
 * ------------------------------------------------------------------ */

/**
 * 调宿主端点。**统一处理 `{ ok, data }` / `{ ok, error }` 形状**，
 * 失败时抛出真正的 Error（带上后端给的 error 文本），而不是让调用方
 * 自己去判断 `res.ok` —— 那是每个插件都会写错一次的地方。
 *
 * @param {string} api 端点前缀，例如 '/laurel'
 * @param {string} path 子路径，例如 '/config'
 * @param {{ method?: string, body?: unknown, timeoutMs?: number }} [options]
 */
export async function requestJSON(api, path, options = {}) {
  const method = options.method ?? 'GET'
  const init = { method, headers: {} }
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  // 超时是必须的：宿主端点不通时不要把这个 Promise 永远挂着。
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  if (controller) init.signal = controller.signal
  const timer = controller
    ? setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
    : null
  try {
    const response = await fetch(`${api}${path}`, init)
    const payload = await response.json().catch(() => null)
    if (!payload || payload.ok !== true) {
      throw new Error(payload?.error ? String(payload.error) : `HTTP ${response.status}`)
    }
    return payload.data
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 读一次生效配置。读不到**不抛**，返回 null，让调用方退回内置默认值继续工作。
 * 通知这类插件"配置读不到就整个哑掉"是最糟的失败模式。
 */
export async function loadConfig(api, log) {
  try {
    const data = await requestJSON(api, '/config')
    return data?.config ?? null
  } catch (error) {
    log?.('config-load-failed', error?.message ?? String(error))
    return null
  }
}

/**
 * 落一条事件到宿主。**永不抛** —— 记日志失败不许影响插件主流程。
 * @returns {Promise<boolean>} 是否成功送达
 */
export async function reportEvent(api, event, log) {
  try {
    await requestJSON(api, '/event', { method: 'POST', body: event })
    return true
  } catch (error) {
    log?.('event-report-failed', error?.message ?? String(error))
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 2. 运行环境探测（设置页的「运行状态」那一块全靠它）
 * ------------------------------------------------------------------ */

/**
 * 探测当前环境能力。设置页要显示"页面来源 / 通知权限 / 订阅挂上没"，
 * 排错时这几项是最先要看的 —— 所以做成一个现成的快照函数。
 */
export function probeEnvironment(NotificationCtor) {
  const origin = (() => {
    try { return typeof location !== 'undefined' ? String(location.origin) : null } catch { return null }
  })()
  const supported = typeof NotificationCtor === 'function'
  let permission = null
  try { permission = supported ? String(NotificationCtor.permission) : null } catch { /* 拿不到就算了 */ }
  let visibility = null
  let focused = null
  try {
    if (typeof document !== 'undefined') {
      visibility = String(document.visibilityState ?? '')
      focused = typeof document.hasFocus === 'function' ? document.hasFocus() : null
    }
  } catch { /* 拿不到就算了 */ }
  return { origin, supported, permission, visibility, focused }
}

/**
 * 申请通知权限。**必须由一次真实用户手势触发**，浏览器才认
 * （权限默认是 'default'，程序主动申请会被拒）。
 * 桌面壳一律放行，不用管。
 */
export async function ensurePermission(NotificationCtor) {
  try {
    if (typeof NotificationCtor !== 'function') return 'unsupported'
    if (NotificationCtor.permission === 'granted') return 'granted'
    if (typeof NotificationCtor.requestPermission !== 'function') return NotificationCtor.permission
    return String(await NotificationCtor.requestPermission())
  } catch {
    return 'error'
  }
}

/* ------------------------------------------------------------------ *
 * 3. 小工具：节流（通知类插件一定会用到）
 * ------------------------------------------------------------------ */

/**
 * 造一个"每个 key 各自计时"的节流闸门。
 *
 * 除了每条 key 的最小间隔，还叠了一条**全局底线**：防止一串不同会话
 * 的事件在同一瞬间连着响成一片。两者都要满足才放行。
 *
 * @param {() => number} now 取当前时间（毫秒）。注入进来是为了测试能控制时间。
 * @param {number} throttleSeconds 每个 key 的最小间隔（秒）
 * @param {number} globalFloorMs 全局底线（毫秒）
 */
export function createThrottle(now, throttleSeconds, globalFloorMs = 2000) {
  const lastPerKey = new Map()
  let lastAny = -Infinity
  return {
    /**
     * @param {string} key 节流键（会话 id）
     * @returns {{ allowed: true } | { allowed: false, reason: string, retryInMs: number }}
     */
    check(key) {
      const t = now()
      const since = t - lastAny
      if (since < globalFloorMs) {
        return { allowed: false, reason: 'global', retryInMs: globalFloorMs - since }
      }
      const prev = lastPerKey.get(key)
      const gap = (throttleSeconds > 0 ? throttleSeconds : 0) * 1000
      if (prev !== undefined && t - prev < gap) {
        return { allowed: false, reason: 'per-key', retryInMs: gap - (t - prev) }
      }
      return { allowed: true }
    },
    /** 放行之后调用，记账。 */
    mark(key) {
      const t = now()
      lastPerKey.set(key, t)
      lastAny = t
    },
    reset() {
      lastPerKey.clear()
      lastAny = -Infinity
    },
  }
}

/* ------------------------------------------------------------------ *
 * 4. 文案（双语的最小骨架）
 * ------------------------------------------------------------------ */

/**
 * 挑一份文案。`language: 'auto'` 时看浏览器语言，**中文才算 zh**，
 * 其它一律落到 en —— 比"猜一门最像的"更好predictable。
 *
 * @param {{ zh: object, en: object }} table
 * @param {string} language 'auto' | 'zh' | 'en'
 */
export function pickText(table, language) {
  if (language === 'zh') return table.zh
  if (language === 'en') return table.en
  let langs = []
  try {
    langs = [navigator.language, ...(navigator.languages ?? [])]
  } catch { /* 非浏览器环境 */ }
  const isZh = langs.some((tag) => typeof tag === 'string' && tag.toLowerCase().startsWith('zh'))
  return isZh ? table.zh : table.en
}

/**
 * 正文截断。先按字符数砍，再补省略号 —— 且**省略号算在长度里**，
 * 免得"限 140 字"最后出来 141 个字。
 */
export function truncateBody(text, maxChars) {
  const s = typeof text === 'string' ? text : ''
  const max = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 140
  if (s.length <= max) return s
  if (max <= 1) return s.slice(0, max)
  return `${s.slice(0, max - 1)}…`
}

/* ------------------------------------------------------------------ *
 * 4.5 跨 realm 安全的容器读取（这是个真踩过的坑，别删）
 * ------------------------------------------------------------------ */

/**
 * 把「一个 Map 或者一个普通对象」统一读成 Map。
 *
 * ── 为什么不能用 `x instanceof Map` ─────────────────────────────────────
 * 客户端 bundle 与宿主跑在**不同的 realm**（iframe / vm / 不同 window），
 * 跨 realm 拿到的 Map `instanceof Map` 是 **false**：
 *
 *     Object.prototype.toString.call(m) === '[object Map]'   // 真的
 *     m.size === 3                                          // 真的
 *     m instanceof Map                                      // false ← 陷阱
 *
 * 于是 `snapshot instanceof Map ? snapshot : new Map(Object.entries(snapshot))`
 * 会走进 else 分支，把**一个有内容的 Map 换成空 Map** —— 不报错，
 * 只是永远什么都不发生。这类"安静地不工作"最难查。
 *
 * 好在这个坑有安全的探测方式：Map 的 `forEach` 回调签名是 `(value, key, map)`，
 * 而普通对象的 `forEach` 来自 Array.prototype，签名是 `(value, index, array)`。
 * 两者靠 `arguments.length` 区分不可靠，但**鸭子类型 + toString 标签**很可靠。
 */
export function toMap(value) {
  if (value === null || value === undefined) return new Map()
  // 同 realm、以及大部分跨 realm 的 Map 都走这条快路：
  // Map 的实例方法（get/size/forEach）在跨 realm 时仍然可用，只是 instanceof 失效。
  if (typeof value.get === 'function' && typeof value.forEach === 'function' && typeof value.size === 'number') {
    return value
  }
  // 只剩一种可能：普通对象（形如 { sessionId: status }）。
  if (typeof value === 'object') return new Map(Object.entries(value))
  return new Map()
}

/* ------------------------------------------------------------------ *
 * 5. 设置页
 * ------------------------------------------------------------------ */

/**
 * 注册一块设置区。
 *
 * 设置页是**插槽**，不是独立路由 —— 这是 DSH 客户端的约定。
 * 用 `ctx.effect` 包起来，这样插件被停用时这块 UI 会跟着干净地撤掉。
 *
 * ── 两路注册（2026-10-13 起）────────────────────────────────────────────
 * 默认是「先聚合、再兜底」：
 *   • 装载机在  → 注册进 `laurel-center.module`。设置内容出现在「Laurel总控」
 *                 里对应的那张模块卡片下，不再单独占一条设置页导航；
 *   • 装载机不在 → 照旧注册进 `settings.section`，自己单独一条，行为跟以前一样。
 *
 * 为什么必须两路都在：插槽系统里「声明即独占渲染权」—— 只有声明某个 key 的
 * 条目才能渲染它。聚合插槽是**装载机**声明的，所以只要用户没装装载机、
 * 只单独装了某个模块，聚合那条路永远等不到声明；只留它，设置页就整块消失。
 *
 * 为什么不用「等几百毫秒看看父级在不在」那种定时器：装载机和模块谁先加载是
 * 宿主决定的，猜时间必然有一头是错的。这里两个 `inject` 同时挂着 —— 谁先成立
 * 谁生效，聚合一旦成立就把独立那份**撤掉**（否则会同时出现在两处）。
 * 于是加载顺序怎么排都收敛到同一个结果。
 *
 * 依赖的客户端服务必须同时在 `package.json` 的 `dsh.client.inject` 里声明
 * （至少要有 `@deepseek-ai/dsh-client-ui-settings`），否则 boot graph 里
 * 没有顺序边，插槽可能还没注册就被调用。
 *
 * @param {object} ctx cordis 客户端上下文
 * @param {object} options
 * @param {string} options.id 设置页条目 id（模块自己定的那个，如 'warden'）
 * @param {number} [options.order] 同一插槽内的排序
 * @param {() => string} options.label 标题；函数形式，这样能跟着当前语言走
 * @param {any} options.component 设置页组件
 * @param {any} options.slots `ctx.slots`
 * @param {string} [options.slot] 显式指定注册到哪个插槽。给了就**只走这一路**，
 *        不做聚合/兜底的自动选择 —— 装载机自己用它注册到 `settings.section`。
 * @param {object} [options.children] 注册时一并声明的子插槽表。
 *        只有插槽的**声明者**用得上（装载机用它把 `laurel-center.module` 声明出来）。
 */
export function registerSettingsSection(ctx, options) {
  const { id, order = 50, label, component, slots, slot, children } = options
  if (!slots?.inject || !slots?.register) {
    throw new Error(`laurel-kit: 拿不到 slots 服务，无法注册设置页（${id}）`)
  }

  /** 聚合插槽名。由装载机声明；模块注册进来后，总控台负责渲染。 */
  const GROUP = 'laurel-center.module'
  const extra = children === undefined ? {} : { children }
  const put = (name) => slots.register({ name, id, order, label, ...extra }, component)

  // 显式指定了插槽：单路注册，不猜。
  if (slot !== undefined) {
    return ctx.effect(() => slots.inject(slot, () => put(slot)), `${id}.settings-section`)
  }

  // 默认：优先聚合进「Laurel总控」，父级不在就退回独立设置页。
  return ctx.effect(() => {
    let grouped = null
    let standalone = null
    // 装载机声明了聚合插槽 → 收进去，并把独立那份撤掉（否则会同时出现在两处）。
    const offGroup = slots.inject(GROUP, () => {
      if (grouped) return () => {}
      if (standalone) { standalone(); standalone = null }
      grouped = put(GROUP)
      return () => { grouped?.(); grouped = null }
    })
    // 兜底：没有装载机时，照旧自己占一条设置页导航。
    const offStandalone = slots.inject('settings.section', () => {
      if (grouped) return () => {}   // 已经聚合了，别再占一条
      if (standalone) return () => {}
      standalone = put('settings.section')
      return () => { standalone?.(); standalone = null }
    })
    // `?.()`：`slots.inject` 的契约是返回一个 disposer，但测试替身和更早的宿主
    // 未必给。卸载时抛一句「offGroup is not a function」会把整个卸载流程带塌，
    // 而这里本来就没有必须成功的副作用。
    return () => { offGroup?.(); offStandalone?.() }
  }, `${id}.settings-section`)
}
