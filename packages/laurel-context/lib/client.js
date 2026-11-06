/**
 * laurel-context · 客户端半边（由 scripts/build-client.mjs 生成，不要直接改这个文件）
 *
 * 改源码请改：
 *   - lib/client-kit.js
 *   - packages/laurel-context/lib/client/index.mjs
 * 然后跑 `npm run build`。
 */

window.__ModuleLoader__.load({
  id: "laurel-context",
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const CLIENT_BUNDLE_VERSION = "0.1.1"

    /* ===== 以下为内联源码。kit 与插件代码共享同一个作用域， ===== */
    /* ===== 所以 kit 导出的符号在插件代码里可以直接用。      ===== */

    /* ---------- lib/client-kit.js ---------- */
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
    const CLIENT_KIT_VERSION = 1

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
    async function requestJSON(api, path, options = {}) {
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
    async function loadConfig(api, log) {
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
    async function reportEvent(api, event, log) {
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
    function probeEnvironment(NotificationCtor) {
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
    async function ensurePermission(NotificationCtor) {
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
    function createThrottle(now, throttleSeconds, globalFloorMs = 2000) {
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
    function pickText(table, language) {
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
    function truncateBody(text, maxChars) {
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
    function toMap(value) {
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
    function registerSettingsSection(ctx, options) {
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


    /* ---------- packages/laurel-context/lib/client/index.mjs ---------- */
    /**

     * laurel-context · 客户端半边：设置页（上下文压缩）。

     *

     * 与记忆核心**完全独立**：这一页不依赖 memory-core 是否启用。

     * 界面要能看出：引擎选择、当前压力、回读入口、对照结果，

     * 以及费用口径（不把别人的调用算进 Laurel 的零档里）。

     *

     * 2026-10-19（D45）：与 laurel-memory 同样的问题与同样改法 ——

     * 只 inject 真正用到的 `slots`；注册走 `slots.inject('settings.section', ...)`；

     * 拿不到 slots 就安静跳过；激活异常先 console.error 带标记再抛出，

     * 让宿主 crash 日志的 renderer console 段能直接看到原因。

     *

     * 2026-10-19（D48）：原来这页同样是静态占位（引擎字段写死，

     * 压力恒为 null）。现在 fetch 宿主半边的只读端点，并且区分

     * 「未接数据」（宿主没这个路由，属正常）/「读取失败」（挂上了但没读成）/「有数据」。

     * 特别地：这一页必须能看出**谁在压缩**（owner）——宿主在压和 Laurel 在压

     * 是两个完全不同的事实，糊成一个"引擎"会让用户以为开关生效了。

     */

    const inject = ['slots']

    /** 只读状态端点。必须与 lib/index.js 的 DATA_PATH 一致。 */
    const DATA_API = '/laurel-context'
    const FETCH_TIMEOUT_MS = 8000
    /** 网络层失败后的一次有界重试间隔。总时长仍受 FETCH_TIMEOUT_MS 约束。 */
    const RETRY_DELAY_MS = 250

    const TEXT = {
      zh: {
        label: '上下文压缩',
        heading: '上下文压缩',
        desc: '长对话瘦身：大结果外置成稳定引用、按需回读原文、分级摘要。独立启停。',
        engineLabel: '引擎',
        engines: { 'laurel-native': 'Laurel 原生轻量' },
        pressureLabel: '当前压力',
        ownerLabel: '谁在压缩',
        // 键名必须与 lib/owner.mjs 的 OWNERS 完全一致，否则会退化成裸值

        owners: { host: '宿主自带压缩', laurel: 'Laurel 原生', off: '没有人（未启用）' },
        statsLabel: '累计',
        hostCompactionLabel: '接管宿主压缩',
        // 键名与 lib/host-compaction.mjs 的 reason 一一对应。漏一个就会把英文 reason

        // 直接摊给用户看（'isolated-sibling' 这种），所以要给 unknown 兜底。

        hostCompaction: {
          ok: '已接管',
          'not-requested': '未请求接管',
          occupied: '宿主已占用（需改组合层）',
          'isolated-sibling': '宿主在隔离分组里自己压（接管需改组合层）',
          'provide-failed': '注册被拒',
          'unsupported-shape': '宿主没有这个服务',
          'no-ctx': '拿不到宿主上下文',
          unknown: '未注册',
        },
        readback: '回读原文',
        comparison: '对照结果',
        noData: '还没有压缩记录。',
        readFailed: '读取失败（不是"没有压缩"）',
        unreachable: '暂时读不到宿主状态（这次没连上，不是压缩没生效）。稍后会自动重试。',
        notWired: '未接数据：宿主没有提供只读状态端点（非 Web 组合，或数据面没挂上）。',
        disabled: '未启用',
        enabled: '已启用',
      },
      en: {
        label: 'Context Compression',
        heading: 'Context Compression',
        desc: 'Shrink long conversations: stable refs, on-demand original readback, tiered summaries.',
        engineLabel: 'Engine',
        engines: { 'laurel-native': 'Laurel native lightweight' },
        pressureLabel: 'Pressure',
        ownerLabel: 'Compressor',
        owners: { host: 'Host built-in', laurel: 'Laurel native', off: 'Nobody (disabled)' },
        statsLabel: 'Totals',
        hostCompactionLabel: 'Host compaction takeover',
        hostCompaction: {
          ok: 'Taken over',
          'not-requested': 'Not requested',
          occupied: 'Host occupied it (edit composition)',
          'isolated-sibling': 'Host compacts in an isolated group (edit composition)',
          'provide-failed': 'Registration rejected',
          'unsupported-shape': 'Host has no such service',
          'no-ctx': 'No host context',
          unknown: 'Not registered',
        },
        readback: 'Read original',
        comparison: 'Comparison',
        noData: 'No compression records yet.',
        readFailed: 'Read failed (not "no compression")',
        unreachable: 'Host status temporarily unreachable (a failed connection, not "no compression"). It will retry.',
        notWired: 'Not connected: the host exposes no read-only status endpoint.',
        disabled: 'Disabled',
        enabled: 'Enabled',
      },
    }

    const SETTINGS_ID = 'context-compress'
    /**

     * 插槽名**不在这里写死**：交给 kit 的 `registerSettingsSection` 做两路选择

     *   总控在   → 'laurel-center.module'（内容进「Laurel 控制中心」的模块卡片）

     *   总控不在 → 'settings.section'（独立一条设置页导航）

     * 这里写死任何一个都会漏掉另一条路（D66 就是这么来的）。

     */
    const LABEL = '上下文压缩'

    function slotsOf(ctx) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const viaGet = ctx.get('slots')
          if (viaGet) return viaGet
        }
      } catch (e) { /* 某些版本 ctx.get 会抛，不当致命 */ }
      return (ctx && ctx.slots) || null
    }

    /**

     * 这次请求到底"连没连上宿主"。四档语义与 laurel-memory 侧完全一致：

     *

     *   live        读到了（端点回了、ok、数据面已挂）

     *   detached    端点根本没挂 —— 404，或 data.dataPlane.mounted === false（正常状态）

     *   unreachable **网络层**失败 —— fetch 直接抛（Failed to fetch / NetworkError /

     *               超时 AbortError）。语义是"这次没连上宿主"，是中性事实，

     *               绝不能被渲染成"读取失败"让用户以为压缩引擎坏了。

     *   wired       端点回了但结果不对 —— HTTP 非 2xx，或 body.ok !== true。真错误。

     *

     * 2026-10-20：原来这里把网络层失败和真读取错误一起归成 wired，于是

     * 宿主 web 服务刚起还没监听时的 `TypeError: Failed to fetch`、页面刚加载时

     * 的一次瞬时断连，全被渲染成「读取失败（不是"没有压缩"）」。

     */
    const NETWORK_ERROR_RE = /failed to fetch|networkerror|network error|network request failed|load failed|fetch failed|terminated/i

    /** 判断一个抛出来的异常是不是"网络层"失败（而不是端点返回了错误结果）。 */
    function isNetworkFailure(e) {
      if (!e) return false
      const name = String(e.name || '')
      // AbortError：被超时定时器打断；TimeoutError：某些实现的超时名

      if (name === 'AbortError' || name === 'TimeoutError') return true
      if (name === 'NetworkError') return true
      const msg = String((e && e.message) || e)
      if (name === 'TypeError' && NETWORK_ERROR_RE.test(msg)) return true
      return NETWORK_ERROR_RE.test(msg)
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    /** 单次尝试。网络层失败返回 kind:'unreachable'，其余直接给出最终结果。 */
    async function fetchStatusOnce(signal) {
      try {
        const res = await fetch(DATA_API, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal,
        })
        if (res.status === 404) return { kind: 'detached' }
        const body = await res.json().catch(() => null)
        if (!res.ok || !body || body.ok !== true) {
          return { kind: 'wired', reason: (body && body.error) || `HTTP ${res.status}` }
        }
        const data = body.data || {}
        if (data.dataPlane && data.dataPlane.mounted === false) return { kind: 'detached', data }
        return { kind: 'live', data }
      } catch (e) {
        if (isNetworkFailure(e)) {
          const reason = e && e.name === 'AbortError' ? `超时 ${FETCH_TIMEOUT_MS}ms` : String((e && e.message) || e)
          return { kind: 'unreachable', reason }
        }
        // fetch 抛了但不像网络层原因 —— 保守当成真错误，宁可显示"读取失败"

        return { kind: 'wired', reason: String((e && e.message) || e) }
      }
    }

    /**

     * 从只读端点拿真实状态。

     *

     * 网络层失败做**一次有界重试**：等 RETRY_DELAY_MS 再试一次，整体仍由

     * 同一个 FETCH_TIMEOUT_MS 定时器兜底（总时间不因重试而翻倍）。

     * 第二次还是网络层失败才返回 unreachable；第二次成功就按成功结果返回。

     */
    async function fetchStatus() {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null
      try {
        const signal = controller ? controller.signal : undefined
        const first = await fetchStatusOnce(signal)
        if (first.kind !== 'unreachable') return first
        await delay(RETRY_DELAY_MS)
        // 预算已经烧完（定时器把 signal 打断）就不再多打一次请求

        if (controller && controller.signal.aborted) return first
        return await fetchStatusOnce(signal)
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    /**

     * 注册上下文压缩的设置面板。

     *

     * 2026-10-19（D66）：这里原来是本文件自己实现的一份「单路注册」——

     * 只 `slots.inject('settings.section', ...)`。而总控（Laurel 控制中心）

     * 渲染的是聚合插槽 `laurel-center.module`，两边插槽名压根不相等，

     * 于是装了总控的宿主里面板永远显示「等待模块设置加载」。

     *

     * 更隐蔽的是：本文件原来那个函数**也叫 `registerSettingsSection`**，

     * 而 scripts/build-client.mjs 的 composeBundle() 把清单所有文件拼进

     * 同一个 IIFE 作用域；kit（lib/client-kit.js）里的同名函数排在前面，

     * 本文件这份排在后面 → **静默覆盖** kit 的两路注册，不报错不警告。

     *

     * 现在：本地函数改名，注册交给 kit 的 `registerSettingsSection` 做两路选择

     * （总控在 → laurel-center.module；不在 → 退回 settings.section）。

     * 与 laurel-memory 侧的同一次修改对称。

     */
    /**

     * 「接管宿主压缩」这一行显示什么。

     *

     * 曾经是 `d.hostCompaction.ok ? 'ok' : String(reason)` —— 把内部 reason 原样摊给用户，

     * 于是界面上出现 `isolated-sibling` 这种英文标识符。它其实是最重要的一条信息

     * （"宿主在隔离分组里自己压，接管得改组合层"），却被降级成不可读的字符串。

     *

     * 现在：查表 + 兜底。表里没有的新 reason 显示"未注册"而不是裸标识符，

     * 但把原值放在 title 里，排查时仍拿得到。

     */
    function hostCompactionText(hc, t) {
      const map = t.hostCompaction || {}
      if (!hc) return '—'
      const key = hc.ok === true ? 'ok' : String(hc.reason || 'unknown')
      return map[key] || map.unknown || key
    }

    function registerCompressSettings(ctx, React) {
      const h = React.createElement
      function Panel() {
        const [state, setState] = React.useState({ loading: true, mode: 'live', error: null, data: null })
        React.useEffect(() => {
          let alive = true
          const load = async () => {
            const r = await fetchStatus()
            if (!alive) return
            if (r.kind === 'live') { setState({ loading: false, mode: 'live', error: null, data: r.data }); return }
            if (r.kind === 'detached') { setState({ loading: false, mode: 'detached', error: null, data: r.data || null }); return }
            // 网络层失败：中性提示，绝不落到 wired（那会显示"读取失败"）

            if (r.kind === 'unreachable') { setState({ loading: false, mode: 'unreachable', error: r.reason, data: null }); return }
            setState({ loading: false, mode: 'wired', error: r.reason, data: null })
          }
          load()
          return () => { alive = false }
        }, [])

        const t = TEXT.zh
        if (state.loading) return h('div', { className: 'laurel-panel' }, h('p', null, '…'))
        if (state.mode === 'detached') {
          return h('div', { className: 'laurel-panel' },
            h('h3', null, t.heading),
            h('p', { className: 'laurel-desc' }, t.desc),
            h('p', { className: 'laurel-hint' }, t.notWired),
          )
        }
        if (state.mode === 'wired') {
          return h('div', { className: 'laurel-panel' },
            h('h3', null, t.heading),
            h('p', { className: 'laurel-error' }, t.readFailed),
            h('p', { className: 'laurel-hint' }, String(state.error)),
          )
        }
        // 网络层失败：中性提示（laurel-hint），不是 laurel-error ——

        // "这次没连上宿主"和"压缩引擎坏了"是两件事，颜色不能一样。

        if (state.mode === 'unreachable') {
          return h('div', { className: 'laurel-panel' },
            h('h3', null, t.heading),
            h('p', { className: 'laurel-hint' }, t.unreachable),
            h('p', { className: 'laurel-hint' }, String(state.error)),
          )
        }
        const d = state.data || {}
        // 压力：engine.pressure() 给的是 0~1 的比例，没引擎时为 null。

        // 显示成百分比比裸小数好读，且 0 和"没有"必须区分（0 是真实测量值）。

        const ratio = d.pressure && typeof d.pressure.ratio === 'number' ? d.pressure.ratio : null
        const owner = d.owner && d.owner.owner ? d.owner.owner : 'off'
        return h('div', { className: 'laurel-panel' },
          h('h3', null, t.heading),
          h('p', { className: 'laurel-desc' }, t.desc),
          d.enabled ? null : h('p', { className: 'laurel-error' }, `${t.disabled}：${d.error || '未知原因'}`),
          // 谁在压缩：这条是这页最重要的一行。开关开着但宿主仍在压缩，

          // 与"没有人在压缩"是完全不同的状态，不能糊成一个"引擎"字段。

          h('div', { className: 'laurel-row' },
            h('span', null, t.ownerLabel),
            h('span', null, t.owners[owner] || owner),
          ),
          h('div', { className: 'laurel-row' },
            h('span', null, t.engineLabel),
            h('span', null, t.engines[d.engine] || d.engine || '—'),
          ),
          h('div', { className: 'laurel-row' },
            h('span', null, t.pressureLabel),
            h('span', null, ratio == null ? t.noData : `${Math.round(ratio * 100)}%`),
          ),
          h('div', { className: 'laurel-row' },
            h('span', null, t.hostCompactionLabel),
            h('span', { title: d.hostCompaction ? String(d.hostCompaction.reason ?? 'ok') : '' },
              hostCompactionText(d.hostCompaction, t)),
          ),
          h('div', { className: 'laurel-row' },
            h('span', null, t.statsLabel),
            h('span', null, d.stats ? `${d.stats.compactions ?? 0} 次压缩 / ${d.stats.refs ?? 0} 份外置原文` : '—'),
          ),
          // 仲裁说明：告诉用户"为什么是它在压"，而不是只给一个结论

          d.owner && d.owner.reason ? h('p', { className: 'laurel-hint' }, String(d.owner.reason)) : null,
          // 引擎说明：告诉用户当前引擎为什么是这个状态，不是让他猜

          d.engineNote ? h('p', { className: 'laurel-hint' }, String(d.engineNote)) : null,
        )
      }

      const slots = slotsOf(ctx)
      if (!slots || typeof slots.register !== 'function') {
        console.error('[laurel-context] 没有 slots.register，设置页不注册（不抛，避免 web boot 整体失败）')
        return null
      }
      // 走 kit 的两路注册：总控在就收进聚合插槽，不在就退回独立设置页。

      // 不自己写 inject —— 那样会漏掉 `laurel-center.module` 那一路（D66）。

      return registerSettingsSection(ctx, {
        id: SETTINGS_ID,
        order: 22,
        label: () => LABEL,
        component: Panel,
        slots,
      })
    }

    function apply(ctx) {
      const React = require('react')
      try {
        ctx.effect(() => registerCompressSettings(ctx, React), 'laurel-context: settings')
      } catch (e) {
        console.error('[laurel-context] 客户端激活失败：', (e && (e.stack || e.message)) || String(e))
        throw e
      }
    }



    module.exports.apply = apply
    if (typeof inject !== 'undefined') module.exports.inject = inject
    return module.exports
  },
})
