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

export { apply, inject, TEXT, SETTINGS_ID, fetchStatus }
