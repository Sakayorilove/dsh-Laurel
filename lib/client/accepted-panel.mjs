// The approved HTML is the rendering contract. Its AST, styles and assets are reused.
export function createAcceptedPanel({ React, ctx, t, controllerFactory, windowState, phaseKey, formatNotice, workbench, siFlow }) {
  const h = React.createElement
  const icon = (name, size = 20) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.55, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, (ACCEPTED_ICON_PATHS[name] || ACCEPTED_ICON_PATHS.gear).map((d, i) => h('path', { key: i, d })))
  function Dropdown({ id, label, value, options, onChange, audio }) {
    const [open, setOpen] = React.useState(false), root = React.useRef(null), trigger = React.useRef(null)
    const close = (restore = false) => { if (!open) return; setOpen(false); void audio.play('dropdownClose'); if (restore) trigger.current?.focus() }
    React.useEffect(() => { if (!open) return; const onOutside = e => { if (!root.current?.contains(e.target)) close() }; document.addEventListener('pointerdown', onOutside, true); document.addEventListener('focusin', onOutside); const selected = root.current?.querySelector('[aria-selected=true]'); selected?.focus(); return () => { document.removeEventListener('pointerdown', onOutside, true); document.removeEventListener('focusin', onOutside) } }, [open])
    return h('div', { ref: root, className: 'game-select', onKeyDown: e => {
      if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(true) }
      if (e.key === 'Tab') close()
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); if (!open) { setOpen(true); void audio.play('dropdownOpen'); return } const nodes = [...root.current.querySelectorAll('[role=option]')], at = nodes.indexOf(document.activeElement), next = e.key === 'Home' ? 0 : e.key === 'End' ? nodes.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length; nodes[next]?.focus() }
    } }, h('select', { id, hidden: true, value, onChange: e => onChange(e.target.value), 'aria-label': label }, options.map(([v, name]) => h('option', { value: v, key: v }, name))),
      h('button', { type: 'button', ref: trigger, className: 'select-trigger', role: 'combobox', 'aria-label': label, 'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-controls': id + '-options', onClick: () => { if (open) close(true); else { setOpen(true); void audio.play('dropdownOpen') } } }, options.find(o => o[0] === value)?.[1]),
      h('div', { className: 'select-options', id: id + '-options', role: 'listbox', 'aria-label': label, hidden: !open }, options.map(([v, name]) => h('button', { key: v, type: 'button', role: 'option', tabIndex: -1, 'data-value': v, 'aria-selected': v === value, onClick: () => { onChange(v); close(true) } }, name))))
  }
  return function AcceptedPanel({ renderSlot }) {
    const [ctrl] = React.useState(controllerFactory), [state, setState] = React.useState(ctrl.getSnapshot())
    const [pc] = React.useState(() => workbench?.pc || createPresentationClient()), [prefs, setPrefs] = React.useState(pc.getSnapshot()), [audio] = React.useState(() => workbench?.audio || new EndfieldAudio())
    const [query, setQuery] = React.useState(''), [category, setCategory] = React.useState('all'), [collection, setCollection] = React.useState('library')
    const [checked, setChecked] = React.useState(() => new Set()), [selection, setSelection] = React.useState(null), [visited, setVisited] = React.useState(() => new Set())
    const [experience, setExperience] = React.useState(false), [receipt, setReceipt] = React.useState(null), [activeTree, setActiveTree] = React.useState(null), [systemDark, setSystemDark] = React.useState(() => typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme'))
    const hoverAt = React.useRef(0)
    const root = React.useRef(null), detail = React.useRef(null), settings = React.useRef(null), success = React.useRef(null), returnFocus = React.useRef(null), seen = React.useRef(null), motionJobs = React.useRef(new Map())
    const revision = /-v02$/.test(prefs.theme) ? 'v02' : 'v01', design = prefs.theme.startsWith('wuling') ? 'wuling' : 'aic', color = prefs.colorMode === 'auto' ? systemDark ? 'dark' : 'light' : prefs.colorMode
    const native = new Map(state.rows.map(r => [r.id, r])), rows = PLUGINS.map(p => ({ ...p, ...(native.get(p.id) || { state: 'loading', enabled: false, fiberPhase: 'pending' }) }))
    const modules = functionalLibraryRows(rows).sort((a, b) => (a.order ?? 999) - (b.order ?? 999)), current = rows.find(r => r.id === selection)
    const nameOf = r => r.title?.zh || r.id, summaryOf = r => r.summary?.zh || r.desc?.zh || '', catName = c => ({ continuity: '记忆与上下文', execution: '执行与协作', experience: '通知与交互' }[c] || c)
    const visible = filterLibraryRows(modules, { query, category, section: collection, preferences: prefs, nameOf, descOf: summaryOf })
    React.useEffect(() => { root.current?.querySelectorAll('.scene-art [data-members]').forEach(el => el.classList.toggle('selected', !!activeTree && el.dataset.members.split(' ').includes(activeTree))) }, [activeTree, design, modules.map(r => r.id).join(' ')])
    const selected = modules.filter(r => checked.has(r.id)), targets = selected.length ? selected : visible, hidden = selected.filter(r => !visible.some(v => v.id === r.id)).length
    const actionable = (r, on) => state.ready && !state.busy && r.state === 'ready' && r.enabled !== on && !(on === false && r.id === 'context-compress' && r.enabled)
    const motion = () => prefs.motion && !window.matchMedia('(prefers-reduced-motion:reduce)').matches
    const animate = (el, frames, duration) => { if (!el || !motion() || !el.animate) return null; return el.animate(frames, { duration, easing: 'cubic-bezier(.16,1,.3,1)' }) }
    React.useEffect(() => { const off = ctrl.subscribe(setState), stop = ctrl.start(), poff = pc.subscribe(setPrefs); if (!workbench) void pc.load(); return () => { off(); stop?.(); ctrl.stop(); poff(); if (!workbench) pc.stop() } }, [ctrl, pc])
    React.useEffect(() => { audio.configure(prefs) }, [prefs, audio])
    React.useEffect(() => { workbench?.attachLayout?.(); audio.dead = false; if (!workbench) audio.setActive(true, { announce: false }); const onVisibility = () => { if (!workbench) document.hidden ? audio.stop() : audio.musicSync() }, observer = new MutationObserver(() => setSystemDark(document.body.hasAttribute('data-ds-dark-theme'))); observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] }); document.addEventListener('visibilitychange', onVisibility); return () => { observer.disconnect(); document.removeEventListener('visibilitychange', onVisibility); for (const job of motionJobs.current.values()) job.cancel(); if (!workbench) audio.dispose() } }, [audio])
    React.useEffect(() => { const openTheme = () => setExperience(true); window.addEventListener('laurel:open-theme-settings', openTheme); return () => window.removeEventListener('laurel:open-theme-settings', openTheme) }, [])
    const update = patch => { void pc.update(patch) }
    function closeDialog(ref, done) {
      const el = ref.current; if (!el?.open || motionJobs.current.has(el)) return
      const animation = animate(el.querySelector('.dialog-body') || el, [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(14px)' }], 140)
      const finish = () => { motionJobs.current.delete(el); el.close(); done?.() }
      if (animation) { motionJobs.current.set(el, animation); animation.finished.then(finish, () => {}) } else finish()
      void audio.play('pageClose')
    }
    const closeDetail = () => closeDialog(detail, () => { setSelection(null); returnFocus.current?.focus({ preventScroll: true }) })
    const closeSettings = () => closeDialog(settings, () => { setExperience(false); root.current?.querySelector('#experience-button')?.focus() })
    const closeReceipt = () => { success.current?.close(); setReceipt(null); returnFocus.current?.focus?.({ preventScroll: true }) }
    const choose = id => { returnFocus.current = document.activeElement; setSelection(id); setVisited(v => new Set([...v, id])); setActiveTree(id); ctrl.clearNotice(); update({ recent: [id, ...prefs.recent.filter(x => x !== id)].slice(0, 30) }); void audio.play('pageOpen') }
    React.useEffect(() => {
      if (!selection || !detail.current) return
      const el = detail.current; el.showModal(); el.classList.remove('is-opening'); void el.offsetWidth; el.classList.add('is-opening')
      animate(el.querySelector('.dialog-body'), [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0)' }], 320)
    }, [selection])
    React.useEffect(() => { if (!experience) return; settings.current?.showModal(); animate(settings.current?.querySelector('.dialog-body'), [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0)' }], 280) }, [experience])
    React.useEffect(() => { if (receipt) { success.current?.showModal(); success.current?.focus(); void audio.play('reward') } }, [receipt])
    React.useEffect(() => {
      const n = state.notice; if (!n || n.pending || !n.readbackOk || seen.current === n) return; seen.current = n
      const items = n.items.filter(i => i.saved === true && i.applied === true && i.outcome === 'success' && i.changed !== false).map(i => ({ id: i.id, name: nameOf(rows.find(r => r.id === i.id) || i), message: rows.find(r => r.id === i.id)?.enabled ? '已启用' : '已关闭' }))
      if (items.length) { returnFocus.current = document.activeElement; setReceipt({ title: n.outcome === 'success' ? '操作完成' : '部分操作已完成', summary: n.outcome === 'success' ? items.length + ' 个模块已由宿主应用' : items.length + ' 项已应用；其余结果见状态提示', items }) }
    }, [state.notice])
    React.useEffect(() => { const saved = e => { if (e.detail?.id !== selection || e.detail?.persisted !== true) return; const row = rows.find(r => r.id === e.detail.id); if (row) { returnFocus.current = document.activeElement; setReceipt({ title: '配置保存成功', summary: 'CONFIGURATION / SAVED', items: [{ id: row.id, name: nameOf(row), message: '保存成功' }] }) } }; window.addEventListener('laurel:configuration-saved', saved); return () => window.removeEventListener('laurel:configuration-saved', saved) }, [selection])
    React.useEffect(() => { const key = e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && root.current?.contains(document.activeElement)) { e.preventDefault(); root.current.querySelector('#module-search')?.focus() } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key) }, [])
    const togglePick = id => setChecked(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next })
    const categoryOptions = [['all', '全部分类'], ...[...new Set(modules.map(r => r.category || 'other'))].map(id => [id, catName(id)])]
    const message = state.problem ? '状态读取失败：' + state.problem.text : formatNotice(state.notice, t)
    const fieldKeys = { 'lab-area-volume': 'areaVolume', 'lab-hover': 'hover', 'lab-sound': 'sound', 'lab-motion': 'motion', 'lab-music': 'music', 'lab-volume': 'volume', 'lab-music-volume': 'musicVolume', 'lab-reward-volume': 'rewardVolume' }
    function act(action, el) {
      if (action === 'detail-close') return closeDetail()
      if (action === 'experience-close') return closeSettings()
      if (action === 'experience') { setExperience(true); void audio.play('pageOpen'); return }
      if (action === 'mute') { update({ sound: !prefs.sound }); void audio.play('switchOn'); return }
      if (action === 'display') { update({ colorMode: color === 'dark' ? 'light' : 'dark' }); void audio.play('select'); return }
      if (action === 'collection') { setCollection(el.dataset.collection === 'favorites' ? 'favorites' : 'library'); void audio.play('select'); return }
      if (action === 'clear-selection') { setChecked(new Set()); void audio.play('common'); return }
      if (action === 'clear') { setQuery(''); setCategory('all'); setCollection('library'); return }
      if (action === 'enable-visible' || action === 'disable-visible') { returnFocus.current = document.activeElement; void ctrl.bulk(action === 'enable-visible', targets.map(r => r.id)); return }
      if (action === 'music') { update({ music: !prefs.music }); return }
      if (action === 'sound') { const key = ({ click: 'select', open: 'pageOpen', close: 'pageClose' })[el.dataset.sound] || el.dataset.sound; void audio.play(key) }
    }
    const moduleRows = visible.map((row, index) => h('article', { key: row.id, className: 'module' + (selection === row.id ? ' selected' : '') + (checked.has(row.id) ? ' is-picked' : ''), 'data-id': row.id, 'data-enabled': row.enabled === true, 'data-reveal': index < 8 ? 'yes' : 'no', style: { '--delay': Math.min(index, 7) * 38 + 'ms' }, onPointerEnter: () => { setActiveTree(row.id); if (prefs.hover && Date.now() - hoverAt.current > 100) { hoverAt.current = Date.now(); void audio.play('common') } }, onFocus: () => setActiveTree(row.id) },
      h('label', { className: 'module-choice' }, h('input', { type: 'checkbox', checked: checked.has(row.id), 'aria-label': '选择' + nameOf(row), onChange: e => { togglePick(row.id); void audio.play(e.target.checked ? 'switchOn' : 'switchOff') } })), h('span', { className: 'row-number', 'aria-hidden': true }, String(modules.indexOf(row) + 1).padStart(2, '0')), h('span', { className: 'module-symbol', 'aria-hidden': true }, icon(row.id)),
      h('button', { type: 'button', className: 'module-main', 'aria-label': '打开' + nameOf(row), onClick: () => choose(row.id) }, h('strong', null, nameOf(row)), h('span', { className: 'summary' }, summaryOf(row))),
      h('div', { className: 'module-meta' }, h('span', { className: 'module-category', title: catName(row.category) }, row.state !== 'ready' ? t('issue') : row.fiberPhase === 'active' ? '运行中' : row.enabled ? t(phaseKey(row)) : catName(row.category)), h('button', { type: 'button', className: 'module-state', role: 'switch', 'aria-checked': row.enabled === true, 'aria-label': (row.enabled ? '关闭' : '启用') + nameOf(row), disabled: !actionable(row, !row.enabled), title: row.id === 'context-compress' && row.enabled ? 'Agent 预设依赖，禁止直接停用' : row.state !== 'ready' ? '状态未确认' : '点击' + (row.enabled ? '关闭' : '启用') + '模块', onClick: () => { returnFocus.current = document.activeElement; void ctrl.toggle(row.id, !row.enabled) } }, h('i', { 'aria-hidden': true }), row.state !== 'ready' ? '未确认' : row.enabled ? '已启用' : '未启用')),
      h('button', { type: 'button', className: 'favorite', 'aria-pressed': prefs.favorites.includes(row.id), 'aria-label': (prefs.favorites.includes(row.id) ? '取消常用' : '设为常用') + nameOf(row), onClick: () => { update({ favorites: prefs.favorites.includes(row.id) ? prefs.favorites.filter(x => x !== row.id) : [...prefs.favorites, row.id] }); void audio.play('common') } }, icon('star', 18)), h('button', { type: 'button', className: 'module-open', 'aria-label': '展开' + nameOf(row), onClick: () => choose(row.id) }, icon('arrow', 19))))
    const renderedModules = h('div', { className: 'lc-modules' }, rows.filter(r => visited.has(r.id)).map(row => h('div', { className: 'lc-module accepted-module', key: row.id, hidden: selection !== row.id }, renderSlot ? renderSlot(MODULE_SLOT, { controlCenter: true }, { only: row.settingsId, fallback: h('p', null, row.enabled ? '等待模块设置加载，请刷新状态。' : '启用模块后可调整选项。') }) : h('p', { role: 'alert' }, '模块插槽不可用，请重新加载客户端。'))))
    const attrMap = { class: 'className', for: 'htmlFor', tabindex: 'tabIndex', autofocus: 'autoFocus', viewbox: 'viewBox', pathlength: 'pathLength', readonly: 'readOnly', maxlength: 'maxLength' }
    function render(node, key) {
      if (typeof node === 'string') return ({'试听接入反馈，体验本页配置。':'通过宿主原生接口启停模块。','首次操作后播放；页面隐藏时暂停。':'仅在控制中心内播放；进入淡入，离开淡出。'})[node] || node
      const a = node.attrs, id = a.id, cls = a.class || '', p = { key }
      for (const [name, value] of Object.entries(a)) { if (/^on/i.test(name) || name === 'style') continue; const prop = attrMap[name] || (name.startsWith('data-') || name.startsWith('aria-') ? name : name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())); p[prop] = ['hidden', 'disabled', 'checked', 'autofocus', 'readonly'].includes(name) ? true : value === null ? '' : value }
      if (a.style) p.style = Object.fromEntries(a.style.split(';').filter(Boolean).map(x => { const i = x.indexOf(':'); return [x.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase()), x.slice(i + 1).trim()] }))
      let children = node.children.map((n, i) => render(n, key + ':' + i))
      if (cls === 'scene-art') return h('div', { key, className: cls, dangerouslySetInnerHTML: { __html: acceptedTreeMarkup(modules, design === 'wuling', null) } })
      if (a['data-icon']) children = icon(a['data-icon'])
      if (a['data-members']) p.className = cls + (activeTree && a['data-members'].split(' ').includes(activeTree) ? ' selected' : '')
      if (cls === 'tree-caption-name') children = modules.find(r => r.id === activeTree)?.title?.zh || '模块树 / 右侧悬停联动'
      if (cls === 'tree-caption-detail') children = activeTree ? catName(modules.find(r => r.id === activeTree)?.category) : '按功能分层 · 选中节点抬起'
      if (cls === 'library-counts') children = ['continuity', 'execution', 'experience'].map(cat => h('div', { key: cat }, h('b', null, String(modules.filter(r => r.category === cat).length).padStart(2, '0')), h('small', null, catName(cat))))
      if (node.tag === 'header' && cls === 'command') children.push(h('button', { key: 'dsh-interface-01', type: 'button', className: 'ef-btn', 'aria-haspopup': 'dialog', onClick: e => siFlow?.openSettings(e.currentTarget) }, 'Harness 界面主题'))
      if (cls === 'command-note') children = '本机控制中心 / v' + BUNDLE_VERSION
      if (cls === 'brand') { p.href = '#'; p['aria-label'] = '打开主题界面'; p.onClick = e => { e.preventDefault(); if(workbench?.isV02())workbench.openTheme();else setExperience(true); void audio.play('pageOpen') } }
      if (node.tag === 'a' && a.href === 'index.html' && cls !== 'brand') { p.href = '#'; p['aria-label'] = '返回控制中心'; children = '返回控制中心'; p.onClick = e => { e.preventDefault(); closeSettings() } }
      if (node.tag === 'a' && cls === 'ef-btn') { p.href = '#'; p.onClick = e => { e.preventDefault(); update({ theme: (design === 'aic' ? 'wuling' : 'endfield') + (revision === 'v02' ? '-v02' : '') }); void audio.play('select') } }
      if (a['data-action']) p.onClick = e => act(a['data-action'], e.currentTarget)
      if (id === 'sound-toggle') p['aria-pressed'] = prefs.sound
      if (cls === 'sound-label') children = prefs.sound ? '原声开' : '原声关'
      if (id === 'display-toggle') p['aria-pressed'] = color === 'dark'
      if (id === 'module-search') { p.value = query; p.onChange = e => setQuery(e.target.value) }
      if (id === 'category') return h(Dropdown, { key, id, label: '模块分类', value: category, options: categoryOptions, onChange: setCategory, audio })
      if (id === 'visible-count') children = String(visible.length).padStart(2, '0')
      if (id === 'total-count') children = String(modules.length).padStart(2, '0')
      if (id === 'favorite-count') children = String(modules.filter(r => prefs.favorites.includes(r.id)).length).padStart(2, '0')
      if (id === 'enabled-summary') children = '已启用 ' + modules.filter(r => r.enabled).length + ' / ' + modules.length
      if (a['data-action'] === 'collection') p['aria-pressed'] = a['data-collection'] === 'favorites' ? collection === 'favorites' : collection === 'library'
      if (id === 'select-visible') { const all = visible.length > 0 && visible.every(r => checked.has(r.id)), mixed = !all && visible.some(r => checked.has(r.id)); p.checked = all; p.disabled = !visible.length; p['aria-checked'] = mixed ? 'mixed' : String(all); p.ref = el => { if (el) el.indeterminate = mixed }; p.onChange = () => { setChecked(prev => { const next = new Set(prev); for (const row of visible) all ? next.delete(row.id) : next.add(row.id); return next }); void audio.play('select') } }
      if (id === 'batch-scope') { children = selected.length ? '已选 ' + selected.length + ' 项' + (hidden ? ' · 筛选外 ' + hidden + ' 项' : '') : '当前结果 ' + visible.length + ' 项'; p.title = selected.length ? selected.map(nameOf).join('、') : '未勾选时操作当前筛选结果' }
      if (id === 'clear-selection') p.disabled = !selected.length
      if (['enable-visible', 'disable-visible'].includes(a['data-action'])) { const on = a['data-action'] === 'enable-visible', count = targets.filter(r => actionable(r, on)).length; children = (on ? '启用' : '关闭') + (selected.length ? '所选 ' : '当前 ') + count; p.disabled = !count; p.title = !on && targets.some(r => r.id === 'context-compress' && r.enabled) ? '上下文压缩为预设必需服务，将保留开启' : undefined }
      if (id === 'module-grid') children = moduleRows.length ? moduleRows : h('div', { className: 'empty' }, h('span', null, '没有找到匹配的模块，请更换关键词或分类。'), h('br'), h('button', { type: 'button', className: 'ef-btn', onClick: () => { setQuery(''); setCategory('all'); setCollection('library') } }, '显示全部模块'))
      if (cls === 'catalogue-footer') children = [h('span', { key: 'enabled' }, h('b', { id: 'enabled-summary' }, '已启用 ' + modules.filter(r => r.enabled).length + ' / ' + modules.length)), h('span', { key: 'note' }, '滚动查看更多 / 可搜索与收藏')]
      if (cls === 'catalogue-header' && message) children.push(h('p', { key: 'notice', role: 'status', className: 'accepted-feedback' }, message))
      if (id === 'detail') { p.ref = detail; p.onCancel = e => { e.preventDefault(); closeDetail() }; p.onClick = e => { if (e.target === e.currentTarget) closeDetail() } }
      if (id === 'detail-glyph') children = icon(current?.id)
      if (id === 'detail-title') children = current ? nameOf(current) : '模块详情'
      if (id === 'detail-category') children = current ? catName(current.category) : ''
      if (id === 'detail-scope') children = current?.scope?.zh || ''
      if (cls === 'preview-chip') children = '本机'
      if (id === 'detail-enabled') { p.checked = current?.enabled === true; p.disabled = !current || !actionable(current, !current.enabled); p.onChange = e => { returnFocus.current = e.currentTarget; void ctrl.toggle(current.id, e.target.checked) } }
      if (id === 'detail-fields') { delete p.onSubmit; return h('div', { ...p, className: 'actual-settings' }, h('details', { className: 'runtime-details' }, h('summary', null, '运行诊断'), h('p', null, current ? '宿主：' + (current.state === 'ready' ? t(phaseKey(current)) : '需处理') + ' · ' + t(({ loaded: 'win.loaded', 'not-loaded': 'win.notLoaded', failed: 'win.failed', unavailable: 'win.unavailable', error: 'win.error' })[windowState(ctx, current)] || 'win.unknown') : ''), h('button', { type: 'button', className: 'ef-btn', disabled: state.busy, onClick: () => ctrl.refresh() }, '刷新状态')), renderedModules) }
      if (cls === 'dialog-actions' && node.children.some(n => typeof n === 'object' && n.attrs['data-action'] === 'save')) return null
      if (id === 'draft-note') children = '配置由各模块独立保存；成功回执只在真实保存完成后显示。'
      if (id === 'experience') { p.ref = settings; p.onCancel = e => { e.preventDefault(); closeSettings() }; p.onClick = e => { if (e.target === e.currentTarget) closeSettings() } }
      if (id === 'lab-hover') p.disabled = !prefs.sound
      if (fieldKeys[id]) { const field = fieldKeys[id], range = a.type === 'range'; delete p.value; if (range) { p.value = Math.round(prefs[field] * 100); p.disabled = !prefs.sound || (field === 'musicVolume' && !prefs.music); p.onChange = e => { pc.preview({ [field]: Number(e.target.value) / 100 }); void audio.play('slider') }; const commit = e => { update({ [field]: Number(e.target.value) / 100 }); if (field === 'rewardVolume') void audio.play('reward') }; p.onPointerUp = commit; p.onKeyUp = commit; p.onBlur = () => { if (!prefs.saved) update({ [field]: prefs[field] }) } } else { p.checked = prefs[field]; p.onChange = e => { update({ [field]: e.target.checked }); void audio.play(e.target.checked ? 'switchOn' : 'switchOff') } } }
      if (id === 'volume-value') children = Math.round(prefs.volume * 100) + '%'
      if (id === 'music-volume-value') children = Math.round(prefs.musicVolume * 100) + '%'
      if (id === 'area-volume-value') children = Math.round(prefs.areaVolume * 100) + '%'
      if (id === 'reward-volume-value') children = Math.round(prefs.rewardVolume * 100) + '%'
      if (id === 'sound-status') children = prefs.error ? '偏好未保存到宿主，请重试：' + prefs.error : prefs.saving ? '偏好保存中…' : '终末地原声已就绪；首次操作后解锁。'
      if (id === 'music-status') children = prefs.sound && prefs.music ? '寻访界面 BGM · 仅控制中心内播放' : '寻访 BGM 已暂停'
      if (id === 'experience' && children.length) children = children.map(child => child?.props?.className === 'dialog-body' ? h('div', { ...child.props, key: 'body' }, h('section', { className: 'accepted-theme-settings' }, h('h3', null, '控制中心与工作台主题'), ...[
        ['经典主题 · 0.1', [['endfield','集成工业 AIC'],['wuling','武陵城']]],
        ['平面主题 · 0.2', [['endfield-v02','AIC · 集成工业'],['wuling-v02','武陵 · 丹青入境']]],
        ['粒子主题 · 0.3', [['particle-v03','原初工业 · 粒子'],['wuling-particle-v03','武陵·祀 · 粒子']]],
      ].map(([heading,choices])=>h('div',{key:heading,className:'accepted-theme-version'},h('h4',null,heading),h('div',{className:'collections'},choices.map(([value,title])=>h('button',{key:value,type:'button',className:'ef-btn','aria-pressed':prefs.theme===value,onClick:()=>update({theme:value})},title))))), revision === 'v02' ? h('button',{className:'ef-btn',type:'button',onClick:()=>workbench?.openAppearance()},'工作区外观与自定义标记') : null), ...React.Children.toArray(child.props.children)) : child)
      if (id === 'save-success') { p.ref = success; p.onClick = closeReceipt; p.onCancel = e => { e.preventDefault(); closeReceipt() }; p.onKeyDown = e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); closeReceipt() } } }
      if (id === 'success-title') children = receipt?.title || '配置保存成功'
      if (id === 'success-summary') children = receipt?.summary || ''
      if (id === 'success-items') children = receipt?.items.map((item, index) => h('div', { className: 'success-receipt', key: item.id, style: { '--receipt-delay': 180 + Math.min(index, 10) * 48 + 'ms' } }, h('div', { className: 'success-icon' }, icon(item.id, 51)), h('span', { className: 'success-seal' }, '✓'), h('strong', null, item.name), h('small', null, item.message))) || []
      if (id === 'toast') return null
      if (node.tag === 'input') return h(node.tag, p)
      return h(node.tag, p, ...Array.isArray(children) ? children : [children])
    }
    return h('div', { ref: root, id: 'laurel-center-accepted', className: 'lc-panel ef accepted-control-center', 'data-laurel-center': '', 'data-theme-revision': revision, 'data-design': design, 'data-theme': color, 'data-ef-accent': design === 'wuling' ? 'jade' : 'yellow', 'data-ef-paper': design === 'wuling' ? 'warm' : 'neutral', 'data-ef-cut': 'standard', 'data-ef-ground': design === 'wuling' ? 'plain' : 'contours', 'data-ef-density': 'compact', 'data-ef-motion': 'full', 'data-motion': prefs.motion ? 'on' : 'off', onPointerDownCapture: e => { audio.unlock(); if (e.target.matches('.actual-settings select')) void audio.play('dropdownOpen') }, onKeyDownCapture: e => { audio.unlock(); if (e.target.matches('.actual-settings select') && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) void audio.play('dropdownOpen'); if (e.target.matches('.actual-settings select') && e.key === 'Escape') void audio.play('dropdownClose') }, onChangeCapture: e => { if (e.target.matches('.actual-settings select')) void audio.play('dropdownClose') }, onClickCapture: e => { const el = e.target.closest('.actual-settings button,.actual-settings input,.actual-settings summary'); if (!el || el.disabled || el.matches('input[type=range]') || /保存|应用|save|apply/i.test(el.textContent || '')) return; void audio.play(nativeControlAudio({ type: el.type, role: el.getAttribute('role'), checked: el.checked, ariaChecked: el.getAttribute('aria-checked'), tab: el.getAttribute('role') === 'tab' || !!el.closest('nav') })) }, onInputCapture: e => { if (e.target.closest('.actual-settings') && e.target.matches('input[type=range]')) void audio.play('slider') } }, (revision === 'v02' ? ACCEPTED_V02_TEMPLATES : ACCEPTED_TEMPLATES)[design].map((node, i) => render(node, String(i))))
  }
}
