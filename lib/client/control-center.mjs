// UI only. Module lifecycle and configuration remain owned by the native host.
//
// ── 2026-10-21：从「shell.overlay 浮动窗」改成「main 整页」 ────────────────
// 旧的浮动窗自己画标题栏、自己算几何、自己实现拖动/八向缩放/最大化，还得靠
// container query 在窄屏硬切成手机版 —— 实测反馈是不能随窗口拉伸而缩放，
// 操作方式也不像原生界面。真正的问题不是缩放写没写，而是**拿模态弹窗当地址**：
// 弹窗尺寸由插件自己维护，与宿主窗口无关，永远慢半拍。
//
// 现在这块面板注册成宿主 `main` 的一个 key（与插件市场同一套公开契约），
// 由宿主布局网格决定尺寸：窗口怎么变，页面就怎么变，不需要任何 JS 几何。
// 侧栏入口由宿主自己画（`sidebar.panellist`），标题栏、关闭、返回都是宿主的。
// 所以本文件只剩一件事：把「模块列表 / 模块详情」画成一页文档流。
export function createControlCenterUI({ React, ctx, t, controllerFactory, windowState, phaseKey, formatNotice, openPanel, workbench, createPortal, siFlow }) {
  const h = React.createElement
  const text = (zh, en) => /^en\b/i.test(typeof navigator === 'undefined' ? '' : navigator.language) ? en : zh
  const icons = {
    star: ['m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z'],
    clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 7v5l4 2'],
    list: ['M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1'],
    leaf: ['M20 3C7 3 3 8 5 15c6 4 13 0 15-12Z', 'M3 21 16 8'],
    overview: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
    laurel: ['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9', 'M10 21h4'],
    'memory-core': ['M9 3a3 3 0 0 0-3 3 3 3 0 0 0-1 5 3 3 0 0 0 2 4 3 3 0 0 0 5 1V4a3 3 0 0 0-3-1Z',
                    'M15 3a3 3 0 0 1 3 3 3 3 0 0 1 1 5 3 3 0 0 1-2 4 3 3 0 0 1-5 1V4a3 3 0 0 1 3-1Z'],
    'context-compress': ['M3 12h6M6 9l-3 3 3 3', 'M21 12h-6M18 9l3 3-3 3'],
    warden: ['M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7Z', 'm8 12 3 3 5-6'],
    'auto-continue': ['M20.5 12a8.5 8.5 0 1 1-2.6-6.1', 'M20 3v5h-5'],
    'reasoning-scroll': ['M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M8 9h8M8 12h8M8 15h5'],
    search: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14', 'm15 15 6 6'],
    about: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'M12 11v6M12 7v.01'],
    back: ['M20 12H4m6-6-6 6 6 6'],
    refresh: ['M20 7a9 9 0 1 0 1 8', 'M20 2v6h-6'], chevron: ['m9 5 7 7-7 7'],
  }
  const Icon = ({ name, size = 21 }) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, (icons[name] || icons.overview).map((d, i) => h('path', { d, key: i })))

  /**
   * 一行模块的图标：优先用模块自己声明的那个（宿主按 package.json 的 icon 读成 data: URL
   * 后随 listPlugins 的行一起送来），读不到、格式不认识、解码失败时才退回下面这张内置表。
   *
   * 退回是**逐个模块**的，不是整表：给一个模块补了图标，不该让别的模块跟着换样子；
   * 内置表也因此不必删 —— 它是离线兜底，不是重复真相。
   */
  const metaIcon = (row) => {
    const src = row && row.meta && typeof row.meta.icon === 'string' ? row.meta.icon : ''
    return /^data:image\/(?:svg\+xml|png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : ''
  }
  const ModuleIcon = ({ row, size = 27 }) => {
    const src = metaIcon(row)
    return src === ''
      ? h(Icon, { name: row && row.id, size })
      : h('img', { className: 'lc-row-icon', src, width: size, height: size, alt: '', 'aria-hidden': true, draggable: false, onError: (e) => { e.currentTarget.style.display = 'none' } })
  }

  // Small, original vector diagrams express each module's job. Pure decoration:
  // no canvas, pointer tracking, animation timer or additional asset request.
  const diagrams = {
    'memory-core': ['M60 8 92 26v36L60 80 28 62V26Z', 'M60 20 82 33v22L60 68 38 55V33Z', 'M60 8v12M28 26l10 7M92 26l-10 7M60 68v12M28 62l10-7M92 62l-10-7'],
    'auto-continue': ['M36 20a32 32 0 1 1-8 40M36 20H18V4', 'm55 30 20 14-20 14Z', 'M18 76h18'],
    'context-compress': ['M32 12h56v14H32zM38 36h44v14H38zM44 60h32v14H44z', 'M18 16v52m-6-6 6 6 6-6M102 68V16m-6 6 6-6 6 6'],
    warden: ['M60 8 92 22v25c0 16-32 33-32 33S28 63 28 47V22Z', 'M60 18 82 28v18c0 11-22 24-22 24S38 57 38 46V28Z', 'm48 43 9 9 17-18'],
    laurel: ['M44 58h32M50 67h20M32 51c8-5 8-11 8-20a20 20 0 0 1 40 0c0 9 0 15 8 20Z', 'M25 22a40 40 0 0 0 0 26M95 22a40 40 0 0 1 0 26M14 16a54 54 0 0 0 0 38M106 16a54 54 0 0 1 0 38'],
    'reasoning-scroll': ['M34 14h52v18H34zM34 40h52v18H34zM34 66h34v18H34z', 'M24 23h4M24 49h4M24 75h4M96 32v44m-5-5 5 5 5-5'],
  }
  function ModuleArt({ id }) {
    return h('svg', { className: 'lc-module-art', viewBox: '0 0 120 88', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, 'aria-hidden': true },
      h('path', { className: 'lc-art-grid', d: 'M0 22h120M0 44h120M0 66h120M30 0v88M60 0v88M90 0v88' }),
      (diagrams[id] || ['M60 12 94 44 60 76 26 44Z', 'M44 44h32M60 28v32']).map((d, i) => h('path', { d, key: i })))
  }

  // 侧栏那一行只画图标：按钮、选中态、label 全由宿主 sidebar 自己拥有。
  const NavIcon = (owner = {}) => h(Icon, { name: 'leaf', size: owner.size ?? 16 })

  /**
   * 打开整页面板。宿主没提供 `layout` 服务时返回 false —— 入口据此禁用，
   * 而不是假装跳转成功（旧版把「弹窗打开」当成目的地，就是这种假装）。
   */
  const open = () => (typeof openPanel === 'function' ? openPanel() === true : false)

  function SettingsLauncher({ close: closeSettings } = {}) {
    const [failed, setFailed] = React.useState(false)
    return h('div', { className: 'lc-settings-entry' },
      h(Icon, { name: 'leaf', size: 36 }), h('h2', null, t('section.title')),
      h('p', null, t('page.lede')),
      h('button', {type:'button',className:'lc-launch',onClick:()=>{closeSettings?.();workbench.experience.open('appearance')}}, '外观、声音与设置 · 0.5'),
      h('button', {
        type: 'button', className: 'lc-launch', onClick: () => { if (open()) closeSettings?.(); else setFailed(true) },
      }, h(Icon, { name: 'leaf' }), h('span', null, text('打开控制中心', 'Open the control center'))),
      failed ? h('p', { role: 'alert' }, text('宿主页面入口暂不可用，请重新加载客户端后重试。', 'The host page is unavailable. Reload the client and retry.')) : null,
      h('p', { className: 'lc-entry-note' }, text('模块选项已经整页化，不再是浮在会话上的弹窗；左侧侧栏里那个 Laurel 图标可以直接进来。', 'The panel is a host page now, not a dialog floating over the conversation — the Laurel icon in the sidebar opens it directly.')))
  }

  function Toggle({ row, state, ctrl, label }) {
    return h('button', {
      type: 'button', role: 'switch', 'aria-checked': row.enabled === true, 'aria-label': label ?? t('plugin.' + row.id),
      disabled: state.busy || !state.ready || row.state !== 'ready' || (row.id === 'context-compress' && row.enabled),
      title: row.id === 'context-compress' && row.enabled ? text('Agent 预设依赖该服务，禁止直接停用。', 'Required by agent presets; direct disable is protected.') : undefined,
      onClick: () => ctrl.toggle(row.id, !row.enabled), className: 'lc-switch',
    }, h('span'))
  }

  /**
   * 本窗口加载状态 → 文案键。五态各有各的说法，别合并：
   *   loaded / not-loaded            —— 真的读到了清单，结论确定
   *   failed                         —— 清单里有，但载入失败（宿主 side failures）
   *   unavailable                    —— 宿主没给任何清单，**无法判定**
   *   error                          —— 有清单入口但读失败
   * 其余值（非 ready 行传进来的 'unknown' 等）兜底到 win.unknown。
   *
   * 这五句话现在只出现在「运行诊断」折叠区里：首屏只留一个圆点和一句人话。
   */
  const WIN_KEY = {
    loaded: 'win.loaded',
    'not-loaded': 'win.notLoaded',
    failed: 'win.failed',
    unavailable: 'win.unavailable',
    error: 'win.error',
  }
  function Diagnostics({ row }) {
    const win = row.state === 'ready' ? windowState(ctx, row) : 'unknown'
    return h('div', { className: 'lc-status' },
      h('span', { 'data-tone': row.fiberPhase === 'active' ? 'success' : 'neutral' }, text('宿主：', 'Host: '), row.state === 'ready' ? t(phaseKey(row)) : t('issue')),
      h('span', null, t(WIN_KEY[win] ?? 'win.unknown')))
  }

  /** 一行只有一个人话状态：运行中 / 未运行 / 需处理。细节进诊断折叠区。 */
  const rowTone = (row) => row.state !== 'ready' ? 'warn' : (row.fiberPhase === 'active' ? 'success' : 'neutral')
  const rowState = (row) => row.state !== 'ready' ? t('issue') : (row.fiberPhase === 'active' ? t('phase.active') : t(phaseKey(row)))

  return { Panel: createParticleThemePanel({ React, ctx, t, controllerFactory, windowState, phaseKey, formatNotice, workbench, createPortal, siFlow }), NavIcon, SettingsLauncher, dispose: () => { /* 没有全局监听需要清；保留导出位以兼容旧调用方。 */ } }
}
