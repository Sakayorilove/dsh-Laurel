/**
 * laurel-sample · 客户端半边入口（骨架示例）
 *
 * ⚠️ 这个文件**不是 laurel 插件正在用的客户端**。
 *    laurel 的客户端是 `lib/client.js`（package.json 的 exports["./client"] 与
 *    dsh.client 都指向它，手写、由 ModuleLoader 直接加载）。
 *    本文件只是「下一款插件」的起手模板；build:client 用它生成
 *    library/laurel-sample/client.js 当示例产物。
 *    改这个文件**不会**改变 laurel 的行为（D70）。
 *
 *
 * ── 这个文件是什么 ──────────────────────────────────────────────────────
 * 它是**下一个 Laurel 系列插件的起手模板**，也是这套 kit 的活证明：
 * 从这里开始写，打包出来的 bundle 就是一个能装、能注册设置页、能订阅
 * 会话状态、能落事件日志的完整客户端插件。
 *
 * ── 写客户端插件的四条硬约束（踩一条就白屏）────────────────────────────
 *   1. 不许 `import` / `export default` / 动态 `import()`。
 *      产物是 classic script 里的 CJS factory，出现 ESM 语法会被当 ESM 解析而崩。
 *      （`export function` 这种命名导出可以写 —— 打包器会剥掉修饰符。）
 *   2. 只能 `require('react')` 这类 **platform seed 表**里的东西。
 *      想用别的包 → 只能**打包时内联**（kit 就是这么进来的），或在
 *      `dsh.client.external` 里点名、由另一个 client 插件行提供。
 *   3. 必须 `export function apply(ctx)`。没有它插件不会被激活。
 *   4. `exports.inject` 里写的服务名，其**供给方包**要同时在 package.json 的
 *      `dsh.client.inject` 里声明，否则 boot graph 里没有顺序边
 *      —— 插槽可能还没注册你就去用了（这是"设置页有时不出现"的根因）。
 *
 * ── kit 提供的符号（同作用域，直接用）──────────────────────────────────
 *   requestJSON / loadConfig / reportEvent
 *   probeEnvironment / ensurePermission
 *   createThrottle / pickText / truncateBody / toMap
 *   registerSettingsSection
 */

/** 宿主半边注册的端点前缀。要和 cordis.patch.yml、lib/index.js 三处一致。 */
const API = '/laurel-sample'

/** 需要哪些客户端服务。它们的供给方要写进 package.json 的 dsh.client.inject。 */
const inject = ['slots', 'uiSession']

/** 内置默认值。没连上宿主时也照常工作，不能因为读不到配置就整个哑掉。 */
const FALLBACK = { enabled: true, throttleSeconds: 30, language: 'auto' }

const TEXT = {
  zh: {
    label: '示例',
    heading: 'Laurel 示例插件',
    intro: '这是一块由 kit 渲染出来的设置区。改本文件（模板）即可。',
    enabled: '启用',
    enabledHint: '关掉之后不再做任何事（但仍然能打开这个设置页）。',
    throttle: '同一会话最小间隔（秒）',
    test: '打个招呼',
    statusHeading: '运行状态',
    origin: '页面来源',
    supported: '通知 API',
    permission: '通知权限',
    sessions: '会话数',
  },
  en: {
    label: 'Sample',
    heading: 'Laurel sample plugin',
    intro: 'A settings block rendered by the kit. Edit this template file to change it.',
    enabled: 'Enabled',
    enabledHint: 'Nothing happens while off (this settings page still works).',
    throttle: 'Per-session minimum interval (s)',
    test: 'Say hello',
    statusHeading: 'Runtime status',
    origin: 'Page origin',
    supported: 'Notification API',
    permission: 'Permission',
    sessions: 'Sessions',
  },
}

/**
 * 订阅会话状态并做点事。
 *
 * ── 关键：`uiSession.sessionStatus` 是**可观察对象**，不是 Map ────────────
 * 官方 `ui-conversation` 的用法（vendor/dsh/ui-conversation/lib/client.js）：
 *
 *     uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction
 *     uiSession.sessionStatus.subscribe(changed)
 *
 * 它**不是** Map，也**没有** `uiSession/session-status` 这种事件名。
 * 早期版本按 Map + 事件名写，结果是"永远不触发"——
 * 而且不报错，只是安静地什么都不做，最难查。
 *
 * 两代快照要做 diff，才能分出新出现的交互；对每个新交互再叠一层节流。
 */
function watchSessions(ctx, state) {
  // 第三个参数是全局下限：多个会话同时冒出来时也只放行一次。
  const throttle = createThrottle(() => Date.now(), 30, 2000)

  function install() {
    const source = ctx.uiSession?.sessionStatus
    if (!source || typeof source.getSnapshot !== 'function') return () => {}

    let previous = new Map()
    const react = () => {
      // 必须用 kit 的 toMap，**不能**写 `snapshot instanceof Map` ——
      // bundle 与宿主跨 realm 时 instanceof 恒为 false，会把有内容的
      // Map 换成空 Map，然后安静地什么都不做（这个坑真踩过，
      // tests/kit-client.mjs 里有它的回归测试）。
      const current = toMap(source.getSnapshot())
      state.sessions = current.size

      for (const [sessionId, value] of current) {
        const pendingNow = value?.pendingInteraction != null
        // 只在"从没有变成有"的那一刻动手，而不是每次快照都动。
        if (pendingNow && !previous.get(sessionId)?.pendingInteraction) {
          const verdict = throttle.check(sessionId)
          if (verdict.allowed) {
            throttle.mark(sessionId)
            reportEvent(API, {
              kind: 'fire',
              sessionId,
              title: value?.title ?? null,
              detail: '示例插件：检测到等待中的交互',
              ...probeEnvironment(typeof Notification !== 'undefined' ? Notification : null),
            })
          } else {
            reportEvent(API, { kind: 'warn', sessionId, detail: `示例插件：被节流挡住（${verdict.reason}）` })
          }
        }
      }
      previous = current
    }

    react()
    const stop = typeof source.subscribe === 'function' ? source.subscribe(react) : null
    return () => { if (typeof stop === 'function') stop() }
  }

  // cordis 的写法：effect 的回调返回清理函数，而且**惰性**——服务推迟就绪也跟得上。
  if (typeof ctx.effect === 'function') return ctx.effect(install, 'laurel-sample.watch')
  return install()
}

/**
 * 插件入口。DSH 客户端 boot 时会调用它。
 * @param {object} ctx cordis 客户端上下文
 */
export function apply(ctx) {
  const React = require('react')
  const h = React.createElement

  const state = {
    config: { ...FALLBACK },
    sessions: 0,
    environment: probeEnvironment(typeof Notification !== 'undefined' ? Notification : null),
    problem: null,
  }

  // 先按内置默认值把界面立起来，再去读宿主配置 —— 宿主不通也不该是一片空白。
  loadConfig(API, (kind, message) => reportEvent(API, { kind: 'error', detail: `${kind}: ${message}` }))
    .then((config) => { if (config) state.config = { ...FALLBACK, ...config } })

  watchSessions(ctx, state)

  /** 一行"标签 + 值"，设置页里反复用。 */
  const Row = (label, value) => h('div',
    { style: { display: 'flex', gap: '12px', padding: '3px 0', fontSize: 12, opacity: 0.85 } },
    h('span', { style: { minWidth: 96, opacity: 0.7 } }, label),
    h('span', { style: { wordBreak: 'break-all' } }, String(value ?? '—')))

  /** 一个开关。 */
  const Toggle = (label, checked, onChange, hint) => h('label',
    { style: { display: 'block', padding: '6px 0', cursor: 'pointer' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }),
      h('span', null, label)),
    hint ? h('div', { style: { fontSize: 11, opacity: 0.6, paddingLeft: 22 } }, hint) : null)

  /** 设置区组件。 */
  function SampleSettings() {
    const config = state.config
    const t = pickText(TEXT, config.language)
    const [, bump] = React.useState(0)
    const refresh = () => bump((n) => n + 1)

    const save = (patch) => {
      state.config = { ...state.config, ...patch }
      refresh()
      // 写失败不该把界面卡住：本地先生效，落盘失败由事件日志留痕。
      requestJSON(API, '/config', { method: 'POST', body: { config: patch } })
        .catch((error) => reportEvent(API, { kind: 'error', detail: `保存失败：${error.message}` }))
    }

    return h('div', { style: { padding: '4px 2px 24px', fontSize: 13 } },
      h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, t.heading),
      h('div', { style: { opacity: 0.7, marginBottom: 12 } }, t.intro),

      Toggle(t.enabled, config.enabled !== false, (v) => save({ enabled: v }), t.enabledHint),

      h('div', { style: { padding: '6px 0' } },
        h('div', null, t.throttle),
        h('input', {
          type: 'number',
          min: 0,
          max: 3600,
          value: Number(config.throttleSeconds ?? 30),
          onChange: (e) => save({ throttleSeconds: Number(e.target.value) }),
          style: { width: 90, marginTop: 4 },
        })),

      h('button', {
        type: 'button',
        onClick: async () => {
          // 「测试」类按钮必须直接调一次真实动作，而不是只改状态 ——
          // 顺便也是一次真实用户手势，可用于申请通知权限。
          const permission = await ensurePermission(typeof Notification !== 'undefined' ? Notification : null)
          state.environment = { ...probeEnvironment(typeof Notification !== 'undefined' ? Notification : null), permission }
          refresh()
          reportEvent(API, { kind: 'test', detail: '示例插件：测试按钮被点', permission })
        },
        style: { marginTop: 4, padding: '4px 12px', cursor: 'pointer' },
      }, t.test),

      h('div', { style: { marginTop: 20, fontSize: 13, fontWeight: 600 } }, t.statusHeading),
      Row(t.origin, state.environment.origin),
      Row(t.supported, state.environment.supported ? 'yes' : 'no'),
      Row(t.permission, state.environment.permission),
      Row(t.sessions, state.sessions),
    )
  }

  try {
    registerSettingsSection(ctx, {
      id: 'laurel-sample',
      order: 56,
      label: () => pickText(TEXT, state.config.language).label,
      component: SampleSettings,
      slots: ctx.slots,
    })
  } catch (error) {
    // 设置页注册失败**不影响**插件的实际功能 —— 降级成装不上 UI，而不是整个哑掉。
    reportEvent(API, { kind: 'error', detail: `设置页注册失败：${error?.message ?? error}` })
  }
}
