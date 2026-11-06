// Classic CJS factory source. Only React is supplied by the host module table.
//
// Laurel-Center · 客户端半边（Laurel 总控）
//
// 一行「Laurel 控制中心」整页面板：列出套件里全部子插件，每个一个开关 + 它的可调选项。
// 各模块的设置页**不再各自占一条设置页导航** —— 它们注册进本页声明的聚合插槽
// `laurel-center.module`（见 lib/client-kit.js 的 registerSettingsSection），
// 由这里渲染进对应模块的详情页。
//
// 聚合插槽是本页注册 `main`（整页面板）时**顺带声明**的。插槽系统里「声明即独占
// 渲染权」：只有声明某个 key 的条目能渲染它 —— 所以这个声明只能在这里做，而且
// 少一次声明，各模块的设置内容就整块看不见（模块那边有兜底，见 kit 注释）。
//
// ── 2026-10-21 形态变更：浮窗 → 整页 ────────────────────────────────────
// 旧版把面板注册在 `shell.overlay`，靠自绘标题栏 + 拖拽/八向缩放 + 最大化来当窗口。
// 那是拿模态弹窗当地址：尺寸由插件自己维护，与宿主窗口无关，于是「拉伸不缩放」
// 且要多跳几层才摸到东西。现在改用宿主公开契约：
//   · `main`（keyed）注册 key `laurel-center` → 宿主网格决定尺寸，页面天然随窗口走
//   · 底部 Laurel 入口通过 `layout.selectPanel('laurel-center')` 打开页面
// 2026-11-01：底部隐私入口已经常驻，移除 sidebar.panellist 的重复导航行。
// 原生设置内的分区保留，用于从设置前往控制中心。
// `layout` 是软依赖（`ctx.get`），不进下面的 inject 硬名单，免得缺它的宿主整片起不来。
//
// ── 2026-10-11 重写要点 ────────────────────────────────────────────────
//   R2（2026-10-26 再改）开关与状态**不再**走宿主原生插件管理 RPC。
//      1.4.x 之后九个模块不再是九个 loader 行，而是 laurel-center 一个 entry 下的
//      ctx.plugin 子插件 —— 没有 loader entry，就没有 `disabled` 可写，
//      `pluginManager.setPluginEnabled(entryId)` 对它们只剩 no-op。
//      现在走 Laurel 自己的端点（与 presentation 同一套鉴权：`x-laurel-ui: 1`）：
//        GET  /api/laurel-center/modules → { enabled:{id:bool}, status:[{id,mounted,reason}] }
//        POST /api/laurel-center/modules { id, enabled } → { ok, id, enabled, applied, reason? }
//      `ctx.remote.$on('plugin-manager/changed')` 仍然保留：它只是**刷新触发器**，
//      安装/卸载别的插件时顺手重读一次状态，不写任何东西。
//      旧版 `POST /laurel-center/toggle` 无凭据也能改真实开关，已随宿主半边一起删除。
//   R3 分三层显示：**设置意图 / 宿主运行状态 / 本窗口加载状态**。宿主状态来自
//      fiberPhase；本窗口加载状态由 `windowStateSafe()` 判成**四态**：
//      loaded / not-loaded / unavailable（宿主没暴露 modules 诊断服务 → 无法判定）/
//      error（有服务但读失败）。拿不到诊断接口时不再说「未确认」——
//      那会让用户以为界面没接上，而真实原因是宿主没给这个读法。
//   R9 每个组件实例自带 controller（不再共用一个模块级 bump）；请求带 generation 与
//      AbortController，旧响应不覆盖新操作；不做无界轮询，靠宿主事件刷新；
//      刷新失败会撤销过期可操作态；不成功就不追加「已生效」；文案走宿主 locale。
//   R10 不再向宿主 set 一个并不存在的服务；宿主半边改用真正的 provide。
//   R11（2026-10-12）开关调用一律带等待上限。当时宿主 `setPluginEnabled` 要拿 profile
//      的写锁，而任何插件安装都握着同一把锁（pnpm 11.x 还有「装完不退出」的已知缺陷，
//      宿主靠 10 分钟空闲看门狗兜底）→ 那段时间里开关一个回执都拿不到，界面只会一直
//      busy，表现为「打开就卡死」。**换成本插件的 HTTP 端点后这条纪律照样成立**（见
//      RPC_SLOW_MS 上方那段：端点也要写盘 + 热挂模块，装载期一样会被占住），
//      到点就停止等待并**如实**报「结果未确认」。
//
// ── 为什么是 React 而不是别的 ──────────────────────────────────────────
// DSH 客户端模块的 platform seed 表里只有 React（以及静态 UI 库）。见
// docs/PLUGIN-CONTRACT.md §3.2。

const NS = 'laurel-center'

/**
 * 本窗口客户端 bundle 的版本。由 `scripts/build-client.mjs` 在打包时从 package.json
 * 注入（构建期常量），不靠人手抄一份 —— 手抄的那份必然会漂（曾有一个前端版本号
 * 就是这样卡在旧值上）。
 */
const BUNDLE_VERSION = typeof CLIENT_BUNDLE_VERSION === 'string' ? CLIENT_BUNDLE_VERSION : 'unknown'

// ── 这份 inject 是「服务名」，不是「包名」，而且必须真的存在 ──────────────
// 对应 package.json 里 dsh.client.inject 的**另一半**：
//   • package.json  dsh.client.inject → 包名，只影响 boot graph 的加载先后
//   • 本文件        exports.inject    → 服务名，是这一行 fiber 的**等待依赖**
// 名单里只要有一个 ctx 里 provide 不出来的名字，这一行就永远停在 pending，
// 整个 web boot 直接失败：`web boot: 1 entry did not activate`。
//
// 这三个都是官方客户端插件实际在用的服务名：
//   slots / locale           —— dsh-client-locale、dsh-client-ui-slots
//   remote                   —— dsh-api-remotes
// 2026-10-26 去掉了 `remote.pluginManager` / `remote.pluginInventory`：
// 它们只服务旧通道（按 loader entryId 开关 + fiberPhase 状态）。九个模块现在是
// laurel-center 的子插件（见 lib/modules.js），既没有 entryId 也没有 fiber 相位可读，
// 这两个服务在本页已经无人调用 —— 少两个硬依赖，就少两个「宿主没 provide 就整条
// fiber 起不来、整台前端白屏」的失败面。
// 曾经误写过 `uiSettings`（那是**包名** dsh-client-ui-settings 的误抄），
// 客户端上下文里没有这个服务名，于是整台前端起不来。别再犯。
const inject = ['slots', 'locale', 'remote']

/**
 * 客户端那份模块清单 —— **不在这里手抄**。
 *
 * `SUB_PLUGINS` 来自 `lib/registry.js`（宿主注册表，唯一真相），由
 * `scripts/build-client.mjs` 在打包时把那个文件内联进本 bundle。
 * 这里曾经是第二份手写副本：加一个模块要改注册表、patch、locale，还有这里；
 * 漏了这处就是「界面少一行、开关点了没反应」，而且**不报任何错**。
 * id 与宿主 cordis.patch.yml 里的 patch id 是同一个值，同源才保证一致。
 */
// settingsId 是「这个模块的设置页在聚合插槽里的条目 id」，同样来自注册表（唯一真相），
// 客户端**不**另抄一份映射表。它跟 id / clientId 都不是一个值（laurel 的设置页 id 是
// 'laurel-sample'），手抄必然漂；漂了的症状是「卡片能展开、里面却空的」，不报错。
const PLUGINS = SUB_PLUGINS.map(spec => ({ ...spec }))

/** 本页声明的聚合插槽：各模块的设置页注册到这里，由本页渲染（当前 8 个）。 */
const MODULE_SLOT = 'laurel-center.module'

/** 宿主 fiber 相位 → 显示键。 */
const PHASE_KEY = {
  pending: 'phase.pending',
  loading: 'phase.loading',
  active: 'phase.active',
  failed: 'phase.failed',
  unloading: 'phase.unloading',
}

/**
 * 模块开关端点 —— **Laurel 自己的**，不是宿主原生插件通道。
 *
 * 九个模块不再是九个 loader 行（见 lib/modules.js），没有 entry 可写、没有 fiber 相位
 * 可读，所以开关改成这个端点。契约（宿主 lib/module-switch.js，两边同一份，不许自创字段）：
 *   GET                      → 200 { enabled: { <id>: boolean }, status: [{ id, mounted, reason }] }
 *   POST { id, enabled }     → 200 { ok, id, enabled, applied, reason? }
 *   非法 id / body 400 · 鉴权失败 403 · 端点已卸载 503
 *
 * 鉴权与 presentation 端点同一套：带 `x-laurel-ui: 1`。那是**同源自定义头**，
 * 跨站请求带不上来，等于一道 CSRF 栅栏；不带它宿主直接 403。
 */
const MODULES_ENDPOINT = '/api/laurel-center/modules'
const MODULES_HEADER = { 'x-laurel-ui': '1' }

/**
 * 一次模块端点调用。GET 不传 payload，POST 传 { id, enabled }。
 * 非 2xx 抛带 `status` / `code` 的 Error，交给上层按「传输失败」如实上报 ——
 * 绝不把 4xx/5xx 当成「开关成功」。
 */
async function modulesRequest(method, payload, signal) {
  if (typeof fetch !== 'function') throw new Error('fetch is not available')
  const headers = payload === undefined ? { ...MODULES_HEADER } : { ...MODULES_HEADER, 'content-type': 'application/json' }
  const response = await fetch(MODULES_ENDPOINT, {
    method,
    credentials: 'same-origin',
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    ...(signal === undefined || signal === null ? {} : { signal }),
  })
  if (!response.ok) {
    const error = new Error(`modules ${method} failed: HTTP ${response.status}`)
    error.status = response.status
    error.code = response.status === 403 ? 'not-authorized' : response.status === 503 ? 'disposed' : 'http-' + response.status
    throw error
  }
  const body = await response.json().catch((error) => {
    throw new Error(`modules ${method} failed: ${String(error?.message ?? error)}`)
  })
  if (!body || typeof body !== 'object') throw new Error(`modules ${method} failed: empty body`)
  return body
}

// ── 开关的等待上限（2026-10-12 实测的真事故；2026-10-26 改走端点后保留）───────
// 旧通道 `setPluginEnabled` 要拿 profile 写锁，会被安装事务占住。新通道虽然是本插件
// 自己的 HTTP 端点（lib/module-switch.js），但同样压在宿主的单线程上：
//   · POST 先同步写 modules.json，再 await reconcile()（import 模块包 + `ctx.plugin`），
//     模块多、包大时本来就不是毫秒级；
//   · 而**任何**插件安装（installBundle）整个 pnpm 运行都占着 profile 的写锁与事件循环。
//     更糟的是 pnpm 11.x 有已知缺陷：打完 `Done in Xs` 之后进程**不退出**
//     （上游 pnpm/pnpm#12297、#13617），宿主只能靠 10 分钟空闲看门狗兜底强杀 ——
//     这段窗口里 HTTP 请求一样拿不到回执。
//
// 实测症状：点开关 → 界面一直 busy、一个字都不变 → 表现为「打开就卡死」。
//
// 所以每次开关/读状态调用都带上限，并分两档：
//   RPC_SLOW_MS    到了先报「可能正忙…仍在等待回执」（证明界面没死）
//   RPC_TIMEOUT_MS 到了就**停止等待**，如实报「结果未确认」
// 两档措辞必须一眼能分开：等待档是**推测**（「可能正忙」），
// 终态档才是**确认**（「宿主正忙」+ 等了多久 + 未确认）。别把两者写成同一句。
// 停止等待 ≠ 操作失败：宿主可能仍在执行，忙完会发 plugin-manager/changed
// （那条事件我们**仍然订阅**，此时只当刷新触发器用，不写任何东西），面板自己会刷新。
// 绝不把「没等到」写成「成功了」或「失败了」。
const RPC_SLOW_MS = 6000
const RPC_TIMEOUT_MS = 30000
// 读状态走的是本插件的 GET 端点：读 modules.json + 内存里的挂载表，无锁、毫秒级。
// 超过这个时间基本就说明宿主被安装/重载占住了，继续等没有意义。
const REFRESH_TIMEOUT_MS = 10000

/**
 * 端点回执 → 共用解释器认得的结果封套。
 *
 * 只做**字段搬运**，不给结论：结论继续由 lib/change-result.js 统一给出，
 * 宿主半边与客户端半边仍然翻同一份矩阵（第二轮 F2 的教训）。
 * 字段缺失 / 类型不符一律折成 'unknown'，宁可让用户看到「未确认」。
 *
 * @param {any} answer POST /api/laurel-center/modules 的响应体（或 null）
 */
function endpointEnvelope(answer) {
  if (answer === null || answer === undefined || typeof answer !== 'object') return undefined
  const ok = answer.ok
  const applied = answer.applied
  // `applied` 是唯一能自证的字段：模块真的挂上/摘掉了才为 true。
  // `ok` 不独立当作「保存成功」的证据 —— 宿主那侧它的含义是「整体成功」，
  // 写盘失败和挂载失败都会落到 false，从载荷上分不开。所以：
  //   applied === true          → applied（真挂上了）
  //   applied === false, ok 否   → failed（没成，reason 带原文）
  //   applied === false, ok 真   → unknown（存疑：不冒充保存成功，也不冒充失败）
  // 三种之外一律 unknown。**绝不**给 restart-required：重启对这个模块没有意义
  // （模块是 laurel-center 的子插件，重启读的仍是同一份 modules.json）。
  const application = applied === true ? 'applied' : (ok === false ? 'failed' : 'unknown')
  return {
    application,
    changed: applied === true,
    // 端点把「为什么没挂上」放在 reason（例如 import 模块包失败）。
    // 解释器读的是 raw.error.diagnostic，这里原样搬过去，界面那行括号才有内容。
    ...(typeof answer.reason === 'string' && answer.reason !== '' ? { error: { diagnostic: answer.reason } } : {}),
  }
}

/** 极简对象判定（bundle 里不引外部依赖）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 给一个 promise 加等待上限。超时抛 `code === 'rpc-timeout'` 的 Error。
 * 超时后原 promise 仍会 settle，所以额外挂一个空 catch，免得留下未处理拒绝。
 */
function withDeadline(promise, ms, what) {
  if (!(ms > 0)) return promise
  let timer = null
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${what} 超过 ${Math.round(ms / 1000)} 秒没有回执`)
      error.code = 'rpc-timeout'
      error.waitedMs = ms
      reject(error)
    }, ms)
  })
  promise.catch(() => { /* 已经不等它了，但拒绝事件仍会发生 */ })
  return Promise.race([promise, timeout]).finally(() => { if (timer !== null) clearTimeout(timer) })
}

function createController(ctx) {
  const managed = createManagedModulesRuntime(ctx)
  const currentSpecs = () => managed.getSnapshot()?.modules || PLUGINS
  let state = {
    ready: false,
    busy: false,
    problem: null,       // { text, at }
    notice: null,        // { outcome, text, at }
    rows: [],
    confirmedAt: null,
    windowId: null,
  }
  const listeners = new Set()
  let generation = 0
  let inflight = null
  let disposed = false

  const emit = () => { for (const l of [...listeners]) l(state) }
  const set = (patch) => { state = { ...state, ...patch }; emit() }

  /**
   * 把模块端点的快照映射成 UI 行。**行形状与旧版逐字一致**（面板一行都不用改）：
   * state / enabled / fiberPhase / meta 都保留，只换数据来源。
   *
   * 状态取值（与 control-center.mjs、library-state.mjs 已消费的集合对齐，**不自创新态**）：
   *   'ready'    —— 端点认这个 id（enabled 表里有它），可开可关
   *   'missing'  —— 端点不认识这个 id：注册表与端点已经漂了，开关必然无效
   *
   * ⚠ 这里刻意**没有**再由「正在运行」推出来的 'read-only' / 'name-mismatch' / 'ambiguous'
   * 三个态：它们都建立在「按 loader entry 精确匹配」之上，而那套匹配随九个 loader 行
   * 一起消失了。运行态现在只落在 `mounted`（布尔）上，**不**下沉成 disable 理由 ——
   * 否则用户会看到一个永远点不动的开关，而实际上端点完全能热挂它。
   *
   * fiberPhase 仍按面板既有词表喂，模块子插件能落到的只有三种：
   *   挂着 → 'active'；该开却没挂上且端点给了原因 → 'failed'；其余（含已关闭）→ 'idle'。
   */
  const mapRows = (moduleRows) => currentSpecs().map((spec) => {
    if (spec.installed === false) return { ...spec, state: 'missing', enabled:false, fiberPhase:'idle' }
    const known = (moduleRows ?? []).filter((r) => r && r.id === spec.id)
    if (known.length === 0) return { ...spec, state: 'missing' }
    const row = known[0]
    const enabled = row.enabled === true
    const mountedNow = row.mounted === true
    const reason = row.reason === undefined || row.reason === null ? null : String(row.reason)
    const fiberPhase = mountedNow ? 'active' : (enabled && reason !== null ? 'failed' : 'idle')
    return {
      ...spec,
      state: 'ready',
      enabled,
      fiberPhase,
      // 端点没有 entryId，也没有模块自带的展示 meta（那条 meta 来自宿主原生插件页，
      // 随 loader 行一起没了）。两个字段都保留形状、值为空，面板照旧回退到注册表的
      // title/desc 与内置图标表 —— 这本来就是它读不到 meta 时的既定行为。
      entryId: undefined,
      meta: undefined,
      mounted: mountedNow,
      mountReason: reason,
    }
  })

  /**
   * 端点载荷 → 逐项行快照。
   *
   * GET 契约是 `{ enabled: { id: bool }, status: [{ id, mounted, reason }] }`，
   * 而 UI 与 `callNative` 要的是**一张按注册表 id 对齐的行表**。
   * 这里把两张表按 id 左右连接成一张，后面 mapRows 就只认这一种形状。
   * 契约外的字段一个都不用（不自创）。
   */
  const snapshotRows = (payload) => {
    const enabledMap = payload?.enabled && typeof payload.enabled === 'object' && !Array.isArray(payload.enabled)
      ? payload.enabled
      : null
    const statusRows = Array.isArray(payload?.status) ? payload.status : []
    if (enabledMap === null && statusRows.length === 0) return []
    const merged = new Map()
    for (const spec of currentSpecs()) merged.set(spec.id, { id: spec.id })
    if (enabledMap !== null) {
      for (const [id, value] of Object.entries(enabledMap)) {
        merged.set(id, { ...(merged.get(id) ?? { id }), enabled: value === true })
      }
    }
    for (const row of statusRows) {
      if (!row || typeof row.id !== 'string') continue
      const next = { ...(merged.get(row.id) ?? { id: row.id }) }
      if (row.mounted !== undefined) next.mounted = row.mounted === true
      if (row.reason !== undefined) next.reason = row.reason
      merged.set(row.id, next)
    }
    return [...merged.values()]
  }

  /**
   * 本窗口是否真的挂上了这个子插件的客户端半边。
   *
   * 直接转发给模块级的 `windowStateSafe`：这两个函数原来是两份逐字同构的副本，
   * 改一处漏一处就会让「面板里的行」和「设置页里的行」说不同的话。现在只有一份实现。
   */
  const windowState = (spec) => windowStateSafe(ctx, spec)

  const refresh = async () => {
    if (disposed) return null
    const g = ++generation
    try { inflight?.abort?.() } catch { /* 旧请求取消失败不影响新请求 */ }
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    inflight = controller
    try {
      // 先取模块端点：GET 一次同时给出「开关表」和「挂载状态」，原来是两条通道。
      const payload = await withDeadline(
        modulesRequest('GET', undefined, controller?.signal),
        REFRESH_TIMEOUT_MS,
        'modules',
      )
      await managed.refresh()
      if (g !== generation || disposed) return null   // 旧响应不许覆盖新操作
      if (!isPlainObject(payload) || !(isPlainObject(payload.enabled) || Array.isArray(payload.status))) {
        throw new Error('modules GET failed: unexpected payload')
      }
      const rows = snapshotRows(payload)
      set({
        ready: true,
        problem: null,
        rows: mapRows(rows),
        store: managed.getSnapshot(),
        confirmedAt: new Date().toISOString(),
        windowId: state.windowId ?? Math.random().toString(36).slice(2, 10),
      })
      return rows
    } catch (error) {
      if (g !== generation || disposed) return null
      // 刷新失败 → 撤销过期可操作态：ready 置回 false，开关不可点（R9）
      // kind 交给界面选文案（控制器不碰 locale）；超时要和「读失败」分开说。
      set({
        ready: false,
        problem: {
          kind: error?.code === 'rpc-timeout' ? 'host-busy' : 'read-failed',
          text: String(error?.message ?? error),
          at: new Date().toISOString(),
        },
      })
      return null
    } finally {
      if (inflight === controller) inflight = null
    }
  }

  const run = async (fn) => {
    if (state.busy || disposed) return null
    set({ busy: true, notice: null })
    // 界面没有进度条也没有转圈：等久了必须给一行字，否则看起来就是死了（实测反馈）。
    const slow = setTimeout(() => {
      if (!disposed) set({ notice: { pending: true, at: new Date().toISOString() } })
    }, RPC_SLOW_MS)
    try {
      return await fn()
    } catch (error) {
      set({ problem: { kind: 'operation-failed', text: String(error?.message ?? error), at: new Date().toISOString() } })
      return null
    } finally {
      clearTimeout(slow)
      if (!disposed) set({ busy: false })
    }
  }

  /**
   * 操作之后的回读。**失败不等于操作没发生** —— 回执已经收到了。
   * 返回 true 表示当前状态确认过；false 表示只能报「未确认」。
   */
  const refreshAfterOperation = async () => {
    const rows = await refresh()
    return rows !== null
  }

  /** 把共用解释器（lib/change-result.js，已内联）的结果裁成 UI 逐项形状。 */
  const pick = (interpreted) => ({
    outcome: interpreted.outcome,
    reason: interpreted.reason,
    saved: interpreted.saved,
    applied: interpreted.applied,
    application: interpreted.application,
    changed: interpreted.changed,
    restartHelps: interpreted.restartHelps,
    code: interpreted.code,
    diagnostic: interpreted.diagnostic,
  })

  /**
   * 走模块端点开/关一项；返回逐项结果（不回读）。
   *
   * 端点只回 `{ ok, id, enabled, applied, reason? }`，没有宿主原生那套
   * `application/changed/error`。这里**只在传输层做一次搬运**，把契约字段原样映射成
   * 共用解释器能读的形状，结论仍旧由 lib/change-result.js 统一给出 —— 不在客户端
   * 另翻一套（那正是第二轮 F2 修掉的坑）：
   *     applied:true                    → application:'applied'  → success
   *     applied:false + ok:false        → application:'failed'   → failure，reason 带端点原文
   *     applied:false + ok 不是 false   → application:'unknown'  → unknown（存疑，不当成功）
   *     applied 缺失 / 不是布尔          → application:'unknown'  → unknown（不当成功）
   * 刻意**没有** restart-required 这一档：模块是 laurel-center 的子插件，重启读的仍是
   * 同一份 modules.json，重启救不了 import 失败的模块 —— 给「重启后生效」就是撒谎。
   */
  const callNative = async (spec, on) => {
    const row = state.rows.find((r) => r.id === spec.id)
    if (!row || row.state !== 'ready') {
      return { id: spec.id, outcome: 'failure', reason: 'unaddressable', saved: false, applied: false, application: 'unknown', changed: false, restartHelps: false, code: row?.state ?? 'missing', diagnostic: null }
    }
    // ⚠ 保留：context-compress 是 agent 预设的依赖，关掉会让预设失效。这条特判是**产品
    // 约束**，与开关走哪条通道无关 —— 换端点后它照样成立（端点也拦不住，只能在这里拦）。
    // 判断依据仍是 row.enabled（来自端点 enabled 表），不是 loader 行。
    if (on === false && spec.id === 'context-compress' && row.enabled) return { id: spec.id, outcome: 'failure', saved: false, applied: false, application: 'unknown', changed: false, restartHelps: false, reason: 'required-by-presets', code: 'required-by-presets' }
    let answer = null
    let transportError = null
    try {
      answer = await withDeadline(
        modulesRequest('POST', { id: spec.id, enabled: on === true }),
        RPC_TIMEOUT_MS,
        'modules',
      )
    } catch (error) {
      // 没等到回执 ≠ 操作失败：宿主可能仍在执行（安装/重载把它占住了）。
      // 如实报「未确认」，并带上 host-busy 让界面说清楚是在等宿主。
      if (error?.code === 'rpc-timeout') {
        return { id: spec.id, ...pick(interpretRpcTimeout({ waitedMs: error.waitedMs })) }
      }
      transportError = String(error?.message ?? error)
    }
    // 端点回执 → 解释器输入（只搬字段，不下结论）。
    // 目标值确认走端点自己回的 enabled：它写完盘才回话，所以 enabled === requested
    // 就等于「目标值确实到位了」（confirmTarget 那一层要的正是这个事实）。
    return { id: spec.id, ...pick(interpretChangeResult(endpointEnvelope(answer), { requested: on === true, transportError })) }
  }

  /**
   * 落一条 notice。**任何一项 partial/unknown 都不许折成 success**（F2 第 1 条）；
   * `hostBusy` 时 outcome 固定 unknown —— 连回执都没拿到，不能编结果。
   */
  const publish = (items, { hostBusy = false, readbackOk = false } = {}) => {
    const summary = summarizeChange(items)
    set({
      notice: {
        hostBusy,
        outcome: hostBusy || !readbackOk ? 'unknown' : summary.outcome,
        items,
        summary,
        readbackOk: hostBusy ? false : readbackOk,
        waitedSeconds: Math.round(RPC_TIMEOUT_MS / 1000),
        at: new Date().toISOString(),
      },
    })
  }

  return {
    getSnapshot: () => state,
    clearNotice: () => set({ notice: null }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    start() {
      disposed = false
      void refresh()
      const disposers = []
      disposers.push(managed.subscribe(value => { if (!disposed && value) set({store:value,rows:mapRows(value.modules)}) }))
      try {
        disposers.push(ctx.remote.$on('plugin-manager/changed', () => { void refresh() }))
        disposers.push(ctx.remote.$on('connection/reset', () => { void refresh() }))
      } catch { /* 事件不可用就只靠手动刷新 */ }
      return () => { for (const d of disposers) { try { d?.() } catch { /* ignore */ } } }
    },
    stop() {
      disposed = true
      generation += 1
      try { inflight?.abort?.() } catch { /* ignore */ }
      inflight = null
      listeners.clear()
    },
    refresh: () => run(refresh),
    storeAction: (action,id,version) => run(async () => { await managed.action(action,id,version);await refresh() }),
    toggle: (id, on) => run(async () => {
      const spec = currentSpecs().find((p) => p.id === id)
      const item = await callNative(spec ?? { id }, on)
      // 宿主被占住时不做回读：读回来也是旧值，还白白把等待时间翻倍。
      if (item.code === 'host-busy') return publish([item], { hostBusy: true })
      publish([item], { readbackOk: await refreshAfterOperation() })
    }),
    bulk: (on, ids) => run(async () => {
      const requested = ids === undefined ? currentSpecs().filter(p => p.installed !== false).map(p => p.id) : Array.isArray(ids) ? ids : []
      const targets = currentSpecs().filter(p => requested.includes(p.id)).filter(p => { const row = state.rows.find(r => r.id === p.id); return row?.state === 'ready' && row.enabled !== (on === true) && !(on === false && p.id === 'context-compress' && row.enabled) })
      const items = []
      // 逐项串行调用原生能力：一个失败不影响其余，逐项原因照实回传
      for (const spec of targets) {
        const item = await callNative(spec, on)
        items.push(item)
        // 第一项就没拿到回执 → 宿主被占住了，后面每一项都会一样地等到超时。
        // 不把总等待翻 4 倍；剩下的如实标成「未执行」（既不是失败也不是成功）。
        if (item.code === 'host-busy') {
          for (const rest of targets.slice(items.length)) items.push({ id: rest.id, ...pick(interpretNotAttempted()) })
          break
        }
      }
      if (items.some((i) => i.code === 'host-busy')) return publish(items, { hostBusy: true })
      publish(items, { readbackOk: await refreshAfterOperation() })
    }),
  }
}

/**
 * 模块文案：**从注册表派生，不在这里另抄一份**。
 *
 * 面板与宿主原生页（服务端 readPluginMeta）描述的是同一个模块，如果各写一份就会漂：
 * 这两处手抄过一轮，同一模块的面板名称与注册表曾不一致：
 * 用户看到两个名字，而没有任何东西报错。
 *
 * 现在的链条是单向的：包里的 `locale/{zh,en}.json`（宿主读的那份）
 *   → `lib/registry.js` 的 title/desc（逐字相同，由 scripts/module.mjs check 比对）
 *   → 这里用 `plugin.<id>` / `plugin.<id>.desc` 两个键拼出来。
 * 改模块文案因此不必碰这个文件；想让某一处「只改面板」也做不到，这正是要的效果。
 */
const pluginText = (lang) => SUB_PLUGINS.reduce((dict, p) => {
  dict['plugin.' + p.id] = p.title[lang]
  dict['plugin.' + p.id + '.desc'] = p.desc[lang]
  return dict
}, {})

export function apply(ctx) {
  const React = require('react')
  const createPortal = (...args) => require('react-dom').createPortal(...args)
  const h = React.createElement
  const managed = createManagedModulesRuntime(ctx)

  ctx.effect(() => ctx.locale.register(NS, {
    zh: {
      ...pluginText('zh'),
      'section.title': 'Laurel 控制中心',
      'page.lede': '整台套件的开关与选项都在这一页。点任意模块进去调整，左上角返回。',
      'intro': '装载机把套件里的插件连同源码装在一个项目里。每个模块的开关和它自己的选项都收在这一页；开关走宿主原生插件管理，改的是 profile 的用户层配置，重启后保持。',
      'options': '选项',
      'optionsHide': '收起选项',
      'optionsEmpty': '这个模块当前没有可调选项（可能还没开启）。',
      'summary': '设置开启 {on}/{total} · 运行确认 {running}/{total} · 需处理 {issues}',
      'enableAll': '一键全部打开',
      'disableAll': '一键全部关闭',
      'refresh': '刷新状态',
      'loading': '正在读取状态…',
      'off': '已关闭',
      'phase.pending': '等待依赖',
      'phase.loading': '启动中',
      'phase.active': '运行中',
      'phase.failed': '启动失败',
      'phase.unloading': '停止中',
      'phase.idle': '未运行',
      'win.loaded': '本窗口已加载',
      'win.notLoaded': '本窗口未加载',
      // 五态的其余三态，措辞必须区分开 —— 「宿主没给读法」不等于「模块没接上」，
      // 更不等于「未确认」；「载入失败」也跟「没发给本页」是两回事。
      'win.failed': '本窗口：载入失败',
      'win.unavailable': '本窗口：宿主未提供模块清单，无法判定',
      'win.error': '本窗口：读取加载状态失败',
      // 兜底：非 ready 的行（loading / missing…）仍会落到这里，正常路径已走不到。
      // 保留是因为界面按「五态之外的任何值」兜底时需要一个键，删掉会让 t() 拿到裸键名。
      'win.unknown': '本窗口：未确认',
      'bundleVersion': '本窗口客户端 v{v}',
      'problemPrefix': '状态读取失败',
      'confirmed': '状态确认于 {time}',
      'notice.success': '已生效。',
      'notice.partial': '配置已保存，宿主尚未应用（重启后生效）。',
      'notice.partialHeader': '部分完成：',
      'notice.failure': '操作未成功：{detail}',
      'notice.unconfirmed': '操作回执已收到，当前状态未确认（读取失败）。',
      // 宿主把**任何非预期异常**都兜底成 operation-error，真实原因只放在 diagnostic 里
      // （上面那行已经把它带出来了）。这一条是「怎么办」—— 实测里它 100% 是同一个原因。
      'notice.operationErrorHint': '宿主在执行这一步时报错了（原因见上面括号）。如果这个模块是刚加进套件的，多半是它还没装进 profile —— 先完全退出 DSH（右下角托盘也退掉），在套件目录跑一次安装事务，再重启。',
      'code.packageMissing': '这个包还没装进 profile —— 先完全退出 DSH，在套件目录跑一次安装事务，再重启',
      'notice.busyWaiting': '宿主可能正忙（正在安装或重载插件），仍在等待回执…',
      'notice.hostBusy': '宿主正忙（可能正在安装或重载插件）：等了 {seconds} 秒仍没有回执，{names}的结果未确认。宿主忙完会自动刷新。',
      'notice.notAttempted': '（{names} 未执行）',
      'problem.hostBusy': '状态读取超时（宿主正忙）',
      'reason.hostBusy': '宿主正忙，结果未确认',
      'reason.notAttempted': '未执行（前一项就没拿到回执）',
      'notice.bulkPartial': '完成，但 {n} 项未成功：{ids}',
      'reason.restartRequired': '配置已保存，宿主尚未应用（重启后生效）',
      'reason.overridden': '配置已保存，但有更高优先级的覆盖压着它；重启不保证生效',
      'reason.reloadFailed': '配置已保存，但宿主重新加载失败，本次没有生效',
      'reason.applicationUnknown': '配置已保存，但宿主的应用结果无法确认',
      'reason.unconfirmed': '结果无法确认',
      'reason.writeFailed': '没有保存成功',
      'reason.cancelled': '被取消',
      'reason.unaddressable': '在插件树里定位不到',
      'missingHint': '{names} 当前在插件树里定位不到（patch 行缺失或重复），开关不会生效。',
      'issue': '需处理',
    },
    en: {
      ...pluginText('en'),
      'section.title': 'Laurel control center',
      'page.lede': 'Every switch and option for the suite lives on this page. Open a module to adjust it; go back with the button top left.',
      'intro': 'The launcher carries the suite\'s plugins (sources included) in one project. Each module\'s switch and its own options live on this page; switches go through the host plugin manager and write the profile user layer, so they survive restarts.',
      'options': 'Options',
      'optionsHide': 'Hide options',
      'optionsEmpty': 'This module has no options right now (it may be off).',
      'summary': '{on}/{total} enabled · {running}/{total} running · {issues} need attention',
      'enableAll': 'Enable all',
      'disableAll': 'Disable all',
      'refresh': 'Refresh',
      'loading': 'Loading…',
      'off': 'off',
      'phase.pending': 'waiting for deps',
      'phase.loading': 'starting',
      'phase.active': 'running',
      'phase.failed': 'failed',
      'phase.unloading': 'stopping',
      'phase.idle': 'not running',
      'win.loaded': 'loaded in this window',
      'win.notLoaded': 'not loaded in this window',
      'win.failed': 'this window: failed to load',
      'win.unavailable': 'this window: host exposes no module roster (undeterminable)',
      'win.error': 'this window: failed to read load state',
      // Fallback only; the five-state path above never reaches it.
      'win.unknown': 'this window: unconfirmed',
      'bundleVersion': 'client bundle v{v}',
      'problemPrefix': 'Cannot read status',
      'confirmed': 'Confirmed at {time}',
      'notice.success': 'Applied.',
      'notice.partial': 'Saved; the host has not applied it yet (takes effect after restart).',
      'notice.partialHeader': 'Partly done:',
      'notice.failure': 'Did not succeed: {detail}',
      'notice.unconfirmed': 'The operation was acknowledged, but the current state is unconfirmed (readback failed).',
      'notice.operationErrorHint': 'The host errored while running this step (reason in the parentheses above). If this module was just added to the suite, it is most likely not installed in the profile yet — quit DSH completely (including the tray icon), run the suite install transaction in the suite directory, then restart.',
      'code.packageMissing': 'this package is not installed in the profile — quit DSH completely, run the suite install transaction, then restart',
      'notice.busyWaiting': 'The host may be busy (installing or reloading a plugin); still waiting…',
      'notice.hostBusy': 'The host is busy (installing or reloading a plugin): no answer after {seconds}s, so the result for {names} is unconfirmed. The panel refreshes once it is done.',
      'notice.notAttempted': '({names} not attempted)',
      'problem.hostBusy': 'Timed out reading status (the host is busy)',
      'reason.hostBusy': 'the host is busy, so the result is unconfirmed',
      'reason.notAttempted': 'not attempted (the previous item got no answer)',
      'notice.bulkPartial': 'Done, but {n} item(s) failed: {ids}',
      'reason.restartRequired': 'saved; the host has not applied it yet (takes effect after restart)',
      'reason.overridden': 'saved, but a higher-priority override is in force; a restart does not guarantee it',
      'reason.reloadFailed': 'saved, but the host reload failed, so it is not in effect',
      'reason.applicationUnknown': 'saved, but the host\'s application result cannot be confirmed',
      'reason.unconfirmed': 'the result cannot be confirmed',
      'reason.writeFailed': 'not saved',
      'reason.cancelled': 'cancelled',
      'reason.unaddressable': 'not locatable in the plugin tree',
      'missingHint': '{names} cannot be located in the plugin tree (missing or duplicated patch rows); toggling will not work.',
      'issue': 'needs attention',
    },
  }), NS + ': dictionaries')

  const t = ctx.locale.bind(NS)

  // The footer and settings launcher open this registered main panel by key.
  const PANEL_ID = 'laurel-center'
  const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
  const openPanel = () => {
    if (!layout || typeof layout.selectPanel !== 'function') return false
    try { layout.selectPanel(PANEL_ID); return true } catch { return false }
  }

  const workbench = createWorkbenchRuntime({ React, ctx })
  ctx.effect(() => workbench.start(), 'laurel-center.workbench')
  const siFlow = typeof document !== 'undefined' && typeof MutationObserver === 'function' ? createSiFlowRuntime({ ctx }) : null
  ctx.effect(() => siFlow?.start(), 'laurel-center.si-flow')
  const experience = createLaurelExperience({ ctx, workbench, siFlow, controllerFactory: () => createController(ctx) })
  workbench.experience = experience
  ctx.effect(() => experience.start(), 'laurel-center.experience-v05')
  const views = createControlCenterUI({
    workbench, createPortal, siFlow,
    React, ctx, t,
    controllerFactory: () => createController(ctx),
    windowState: windowStateSafe,
    phaseKey: row => PHASE_KEY[row.fiberPhase] ?? 'phase.idle',
    formatNotice,
    openPanel,
  })
  const StoreView = createModuleStoreView(React,managed)
  function StorePanel(props) {
    const [value,setValue] = React.useState(managed.getSnapshot()), dialog = React.useRef(null)
    React.useEffect(()=>managed.subscribe(setValue),[])
    const open=()=>dialog.current?.showModal()
    React.useEffect(()=>{window.addEventListener('laurel:open-module-store',open);return()=>window.removeEventListener('laurel:open-module-store',open)},[])
    return h('div',{style:{display:'flex',flexDirection:'column',flex:1,minHeight:0,minWidth:0,height:'100%'}},
      h('div',{style:{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,padding:'8px 16px',fontSize:12,color:'var(--lx-text, inherit)',background:'var(--lx-side, transparent)',borderBottom:'1px solid var(--lx-line, currentColor)'}},h('span',{role:'status'},value?.center?.restartRequired||value?.job?.phase==='restart-required'?'控制中心已更新 · 请重启 DSH':value?.updates?'发现 '+value.updates+' 项更新':value?.error?'检查更新暂不可用':value?.checkedAt?'官方模块目录已检查':'正在检查模块更新…'),h('button',{'data-open-module-store':'',type:'button',onClick:open,style:{background:'transparent',color:'inherit',border:'1px solid currentColor',padding:'5px 12px',font:'inherit'}},'模块商店与更新'+(value?.updates?' · '+value.updates:''))),
      h(views.Panel,props),h('dialog',{ref:dialog,'aria-label':'Laurel 模块商店与更新',style:{width:'min(780px,94vw)',maxHeight:'88vh',padding:0,border:'1px solid var(--lx-line, currentColor)',color:'var(--lx-text, inherit)',background:'var(--lx-bg, Canvas)'}},h('form',{method:'dialog',style:{display:'flex',justifyContent:'flex-end',padding:8}},h('button',{type:'submit',style:{color:'inherit',background:'transparent',font:'inherit',border:'1px solid currentColor',padding:'4px 12px'}},'关闭')),h(StoreView)))
  }
  ctx.effect(()=>{
    const notice=document.createElement('button');notice.type='button';notice.dataset.laurelUpdateNotice='';notice.style.cssText='position:fixed;right:18px;bottom:20px;z-index:2000;padding:10px 16px;border:1px solid var(--lx-line,currentColor);color:var(--lx-text,CanvasText);background:var(--lx-surface,Canvas);font:inherit;font-size:13px;box-shadow:0 3px 16px #0002;max-width:calc(100vw - 36px)';notice.hidden=true
    notice.onclick=()=>{openPanel();setTimeout(()=>window.dispatchEvent(new Event('laurel:open-module-store')),100)}
    const off=managed.subscribe(value=>{const restart=value?.center?.restartRequired||value?.job?.phase==='restart-required';notice.hidden=!value?.updates&&!restart;notice.textContent=restart?'Laurel 控制中心已更新 · 请重启 DSH':'Laurel 发现 '+value?.updates+' 项更新 · 查看'})
    document.body.append(notice);return()=>{off();notice.remove()}
  },'laurel-center.update-notice')
  ctx.effect(() => {
    if (typeof document === 'undefined') return
    const style = document.createElement('style')
    style.dataset.laurelControlCenterStyle = ''
    style.textContent = CONTROL_CENTER_CSS + '\n' + ACCEPTED_PREVIEW_CSS + '\n' + ACCEPTED_V02_CSS
    document.head.appendChild(style)
    return () => { views.dispose(); style.remove() }
  }, 'laurel-center.styles')
  // ── 整页面板 ──────────────────────────────────────────────────────────
  // 2026-10-21：从 shell.overlay 浮动窗改成 main 面板 —— 与插件市场用的是同一套
  // 公开契约（`main` 的 keyed 注册，由底部 Laurel 入口打开）。
  // 页面尺寸由宿主布局网格决定，所以窗口怎么拉伸页面就怎么变，插件不再自己维护几何。
  //
  // `layout` 服务取的是**软依赖**：宿主没提供时入口禁用，而不是让整条 fiber 挂住。
  // 注意它不能进文件顶部的 `inject` 硬依赖名单 —— 那会让缺 layout 的宿主整片 web boot 失败。
  // 只有本插件声明的聚合插槽能渲染它（SlotCore「声明即独占渲染权」）。
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL_ID,
    children: { [MODULE_SLOT]: { kind: 'list', scope: 'root' } },
  }, StorePanel)), 'laurel-center.panel')
  // The private footer owns the sidebar shortcut. Keep the main registration
  // for layout.selectPanel(), without a second row in sidebar.panellist.
  // 卸载时如果正停在本页，回到会话页，别把用户留在一个已经没主的 key 上。
  ctx.effect(() => () => {
    try {
      if (layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID) layout.selectPanel(null)
    } catch { /* 宿主已经松开了这个服务，无事可做。 */ }
  }, 'laurel-center.panel-exit')
  registerSettingsSection(ctx, {
    id: 'laurel-center', order: 15, label: () => 'Laurel',
    component: () => h(React.Fragment,null,h(views.SettingsLauncher),h(StoreView)), slots: ctx.slots, slot: 'settings.section',
  })
}

/**
 * 把各种「模块清单」形状归一成一个 id 数组；认不出来就返回 null。
 * 只做形状判断，不调用任何会写状态的方法。
 */
function rosterIds(value) {
  if (!value || typeof value !== 'object') return null
  const rows = Array.isArray(value) ? value : (Array.isArray(value.modules) ? value.modules : (Array.isArray(value.entries) ? value.entries : null))
  if (!rows) return null
  const ids = []
  for (const row of rows) {
    if (typeof row === 'string') ids.push(row)
    else if (row && typeof row === 'object' && typeof row.id === 'string') ids.push(row.id)
  }
  return ids
}

/**
 * 本窗口加载状态 —— **五态**，每个状态对应一句实话：
 *
 *   'loaded'       本窗口的模块清单里有这个 clientId，且没有载入失败记录
 *   'failed'       清单里有它，但载入失败（ClientEntries 的 failures 里有这个 id）
 *   'not-loaded'   读得到清单，但里面没有它（宿主没把它发给本页）
 *   'unavailable'  **读不到任何清单** —— 宿主既没暴露 `modules` 服务，页面也没有
 *                  `__DSH_BOOT__`。这是「无法判定」，功能可能是好的，只是没给读法。
 *   'error'        有清单入口，但读的过程抛了 / 结构认不出来
 *
 * ── 真实 API（2026-10-20 在真宿主 + 真 Chromium 里实测，别再猜）────────────────
 * 旧实现读 `ctx.get('modules').graph()`。**`graph()` 根本不存在**，所以每一行都
 * 落进 'error'，界面显示「本窗口：读取加载状态失败」。实测到的真实形状：
 *
 *   ctx.get('modules')  →  ClientModuleSystem
 *      .manifest.modules   →  [{ id, rev, inject, external }]   ← 宿主发给本页的清单
 *      .entries            →  ClientEntries
 *         .state.getSnapshot()  →  { syncing, failures: [{ id, ... }] }
 *   window.__DSH_BOOT__  →  { rev, release, entries, batches }
 *      .entries            →  [{ id, url, rev, inject }]        ← 本页启动清单（77 条）
 *   window.__ModuleLoader__ → { mode:'live', pendingQueue:[] }
 *
 * 清单在 `modules` 服务上优先读；服务缺失时退回页面自己的 `__DSH_BOOT__`。
 * 两者都没有才是 'unavailable'，绝不把「没给读法」说成「读失败」。
 */
function windowStateSafe(ctx, spec) {
  const managed = managedRuntimes.get(ctx)
  if (managed?.getSnapshot()) return managed.clientState(spec?.id)
  const clientId = spec && spec.clientId
  if (typeof clientId !== 'string' || clientId === '') return 'unavailable'

  let mods = null
  let modsThrew = false
  try {
    mods = ctx.get?.('modules') ?? null
  } catch { modsThrew = true }

  // 优先：宿主暴露的 modules 服务
  if (mods) {
    let ids = null
    try { ids = rosterIds(mods.manifest) } catch { return 'error' }
    if (ids) {
      try {
        let failed = false
        const failures = mods.entries?.state?.getSnapshot?.()?.failures
        if (Array.isArray(failures)) failed = failures.some((f) => f && f.id === clientId)
        if (failed) return 'failed'
      } catch { /* failures 读不到不影响清单结论，按已加载处理 */ }
      return ids.includes(clientId) ? 'loaded' : 'not-loaded'
    }
  }

  // 退回：页面启动清单
  let boot = null
  let bootThrew = false
  try { boot = typeof window === 'undefined' ? null : (window.__DSH_BOOT__ ?? null) } catch { bootThrew = true }
  if (boot) {
    let ids = null
    try { ids = rosterIds(boot) } catch { return 'error' }
    if (ids) return ids.includes(clientId) ? 'loaded' : 'not-loaded'
  }

  // 有清单入口但认不出结构（或读取本身抛了）→ 读失败；
  // 两条入口都根本不存在 → 宿主没给读法，也就是无法判定。
  return (mods || modsThrew || boot || bootThrew) ? 'error' : 'unavailable'
}
