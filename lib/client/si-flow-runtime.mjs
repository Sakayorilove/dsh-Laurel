/** Si 0.3 decorates native rc.5 elements; native state, events and editor remain authoritative. */
export function createSiFlowRuntime({ ctx, appearance = createHarnessAppearanceClient() }) {
  const pc = appearance;
  const html = document.documentElement, owned = new Set(), tags = new Map(), surfaces = new Map();
  const privateFooters = new Map(), selectionTracks = new Map(), rings = new Map();
  const ringSelector = ':is(.lsf-sidebar,.lsf-conversation) [data-state=ongoing], [data-chat-running] .lsf-running-ring';
  function dropRing(el, ring) {
    rings.delete(el); ringIntersection?.unobserve(el);
    el.style.removeProperty('--lsf-ring-phase');
  }
  function paintRings() {
    // An inherited property on <html> invalidates the whole document every frame.
    // Keep the identical pigment clock, scoped to actual visible consumers.
    const phase = (((engine?.time || 0) / 2.1 * 360) % 360).toFixed(3) + 'deg';
    for (const [el, ring] of rings) {
      if (!el.isConnected) { dropRing(el, ring); continue; }
      if (!ring.visible || el.style.getPropertyValue('--lsf-ring-phase') === phase) continue;
      el.style.setProperty('--lsf-ring-phase', phase);
      ring.style = el.style.cssText;
    }
  }
  function projectRings() {
    const next = new Set(document.querySelectorAll(ringSelector));
    for (const [el, ring] of rings) if (!next.has(el)) dropRing(el, ring);
    for (const el of next) if (!rings.has(el)) {
      rings.set(el, { visible: true });
      ringIntersection?.observe(el);
    }
    paintRings();
  }
  let footerPanelSource, footerSettingsSource, offFooterPanel, offFooterSettings;
  function nativeSettingsStore() {
    // rc.5 deliberately shares this instance with the native settings owner.
    return ctx?.slots?.entries?.('sidebar.settings')?.[0]?.store?.create?.();
  }
  function watchPrivateFooterState() {
    const panel = service('layout')?.panelInfo, settings = nativeSettingsStore();
    if (footerPanelSource !== panel) {
      offFooterPanel?.(); footerPanelSource = panel;
      offFooterPanel = panel?.subscribe?.(schedule);
    }
    if (footerSettingsSource !== settings) {
      offFooterSettings?.(); footerSettingsSource = settings;
      offFooterSettings = settings?.subscribe?.(schedule);
    }
  }
  let selectionCurrent, selectionWanted, selectionPending = false, selectionSeen = false, selectionIdentity, offClock;
  const brushPrefs = () => ({ reduced: preferences.motion === false, paused: preferences.paused === true, speed: preferences.speed || 1 });
  const selectionItem = row => { const r = row.getBoundingClientRect(); return { key: row.dataset.rowKey, element: row, rect: { x: 0, y: 0, w: r.width, h: r.height } }; };
  function dropTrack(row, track) {
    track.dispose(); row.removeAttribute('data-brush-tone'); resizeObserver?.unobserve(row);
    owned.delete(track.canvas); selectionTracks.delete(row);
    if (selectionCurrent === track) selectionCurrent = undefined;
  }
  function getTrack(row) {
    let track = selectionTracks.get(row);
    if (!track) {
      track = createSiFlowBrushTrack({ parent: row, kind: 'native', source: () => surfaces.get(row)?.get('selected') });
      track.canvas.classList.add('lsf-brush', 'lsf-brush-selected'); own(track.canvas);
      track.rowKey = row.dataset.rowKey; track.configure(brushPrefs()); selectionTracks.set(row, track); resizeObserver?.observe(row);
    }
    return track;
  }
  function paintWanted(settle = false) {
    const row = selectionWanted;
    selectionPending = false;
    if (!row?.isConnected || row.getAttribute('aria-selected') !== 'true') { selectionCurrent = undefined; return; }
    selectionCurrent = getTrack(row); selectionCurrent.select(selectionItem(row));
    if (settle) selectionCurrent.finish();
    selectionCurrent.render();
  }
  function projectSelection(sidebar) {
    for (const [row, track] of selectionTracks) {
      if (!row.isConnected || !sidebar?.contains(row) || track.rowKey !== row.dataset.rowKey) { dropTrack(row, track); continue; }
      if (track.current) track.current.rect = selectionItem(row).rect;
      if (track.wanted) track.wanted.rect = selectionItem(row).rect;
      track.render();
    }
    const row = sidebar?.querySelector('.lsf-session[aria-selected=true]') || null;
    const identity = row && row.dataset.rowKey;
    if (selectionWanted === row && selectionIdentity === identity && (selectionCurrent || !row)) return;
    selectionWanted = row; selectionIdentity = identity; selectionPending = true;
    if (preferences.motion === false) {
      for (const track of selectionTracks.values()) { track.select(null); track.finish(); track.render(); }
      paintWanted(true);
    } else if (!selectionCurrent?.current) paintWanted(!selectionSeen);
    else { selectionCurrent.select(null); selectionCurrent.render(); }
    selectionSeen = selectionSeen || !!row;
  }
  function selectionFrame(dt) {
    for (const track of selectionTracks.values()) track.update(dt);
    if (selectionPending && (!selectionCurrent?.current || selectionCurrent.phase === 'idle')) paintWanted();
    for (const [row, track] of selectionTracks) if (!track.current && !track.wanted && row !== selectionWanted) dropTrack(row, track);
    paintRings();
  }
  let chromeSignal, chromeMode, paperLayer;
  let engine, offPrefs, observer, resizeObserver, intersection, ringIntersection, style, preferences = pc.getSnapshot();
  let frame = 0, disposed = false, enabled = false, lastTheme, pending = Promise.resolve(), settings;
  let materialsReady = false;
  const active = () => materialsReady && ['si-flow-v03', 'si-paper-v01'].includes(preferences.theme);
  const color = () => preferences.colorMode === 'auto' ? document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light' : preferences.colorMode;
  function tag(el, name) {
    if (!el) return;
    const cls = 'lsf-' + name;
    if (!el.classList.contains(cls)) { el.classList.add(cls); if (!tags.has(el)) tags.set(el, new Set()); tags.get(el).add(cls); }
  }
  function own(el) { el.dataset.siFlowOwned = ''; owned.add(el); return el; }
  function brush(el, kind, name = kind) {
    if (!el) return;
    let row = surfaces.get(el);
    if (!row) { row = new Map(); surfaces.set(el, row); }
    let canvas = row.get(name);
    if (!canvas || canvas.parentElement !== el) {
      if (canvas) { intersection?.unobserve(canvas); owned.delete(canvas); }
      canvas = own(document.createElement('canvas')); canvas.dataset.ink = kind;
      canvas.className = 'lsf-brush lsf-brush-' + name;
      canvas.setAttribute('aria-hidden', 'true'); canvas.style.pointerEvents = 'none';
      // Keep Lexical-managed input descendants untouched.
      el.append(canvas); row.set(name, canvas); intersection?.observe(canvas);
    }
    if (getComputedStyle(el).position === 'static') tag(el, 'ink-static');
    tag(el, 'ink-seat'); return canvas;
  }
  function edgeBrush(el, kind) {
    const canvas = brush(el, kind);
    // An absolute child is anchored to the padding edge, the native rule to
    // the border centre. Keep the original border width and align both centres.
    const height = kind === 'header' ? 4 : 5;
    const bottom = -(height / 2 + (parseFloat(getComputedStyle(el).borderBottomWidth) || 0) / 2) + 'px';
    if (canvas.style.bottom !== bottom) canvas.style.bottom = bottom;
  }
  function service(name) { try { return ctx?.get?.(name); } catch { return undefined; } }
  function nativeSettings() {
    // rc.5 stores are top-level fields of the render-erased SlotEntry, not
    // entry.options. The settings owner deliberately shares one instance.
    const actions = nativeSettingsStore()?.actions;
    // Open a non-account page so this privacy shortcut cannot reveal identity.
    if (typeof actions?.openSection === 'function') actions.openSection('general');
    else if (typeof actions?.open === 'function') actions.open();
    else throw new Error('Harness 设置入口暂不可用');
  }
  function removePrivateFooter(row) {
    row.control.remove();
    row.seat.classList.remove('lsf-private-seat');
    row.button.classList.remove('lsf-private-original');
    for (const [key, value] of Object.entries(row.attributes)) {
      if (value === null) row.button.removeAttribute(key); else row.button.setAttribute(key, value);
    }
  }
  function projectPrivateFooter(sidebar) {
    for (const [button, row] of privateFooters) if (!button.isConnected || !row.control.isConnected) {
      removePrivateFooter(row); privateFooters.delete(button);
    }
    const button = sidebar?.querySelector('[class*="_settingsArea"] [class*="_triggerRow"] button[aria-haspopup]');
    if (!button) return;
    let row = privateFooters.get(button);
    if (!row) {
      const seat = button.parentElement, control = document.createElement('div');
      control.className = 'lsf-private-controls'; control.dataset.laurelPrivateFooterControl = '';
      control.setAttribute('role', 'group'); control.setAttribute('aria-label', 'Laurel 和设置');
      control.innerHTML = '<span class="lsf-private-thumb" aria-hidden="true"></span><button type="button" data-footer-action="laurel" title="左键打开控制中心，右键打开 Laurel 设置" aria-label="打开 Laurel 控制中心，右键打开设置">Laurel</button><button type="button" data-footer-action="settings" aria-label="打开 Harness 设置">设置</button>';
      row = { button, seat, control, attributes: { 'aria-hidden': button.getAttribute('aria-hidden'), tabindex: button.getAttribute('tabindex') } };
      const choose = action => {
        try {
          if (action === 'settings') nativeSettings();
          else {
            const layout = service('layout');
            if (typeof layout?.selectPanel !== 'function') throw new Error('Laurel 控制中心入口暂不可用');
            layout.selectPanel('laurel-center');
          }
          control.removeAttribute('title'); schedule();
        } catch (error) { control.title = String(error?.message || error); showError(error); }
      };
      control.addEventListener('contextmenu', event => {
        if (!event.target.closest('[data-footer-action="laurel"]')) return;
        event.preventDefault();event.stopPropagation();
        window.dispatchEvent(new CustomEvent('laurel:open-settings',{detail:{section:'appearance'}}));
      });
      let drag, suppressClick = 0;
      const at = x => x < control.getBoundingClientRect().left + control.clientWidth / 2 ? 'laurel' : 'settings';
      control.addEventListener('click', event => {
        if (event.detail > 0 && performance.now() < suppressClick) { event.preventDefault(); return; }
        const action = event.target.closest('[data-footer-action]')?.dataset.footerAction;
        if (action) choose(action);
      });
      control.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        drag = { id: event.pointerId, x: event.clientX, moved: false };
      });
      control.addEventListener('pointermove', event => {
        if (!drag || drag.id !== event.pointerId) return;
        if (Math.abs(event.clientX - drag.x) > 10) {
          drag.moved = true; control.setPointerCapture(event.pointerId);
          control.dataset.preview = at(event.clientX);
        }
      });
      control.addEventListener('pointerup', event => {
        if (!drag || drag.id !== event.pointerId) return;
        if (drag.moved) { event.preventDefault(); suppressClick = performance.now() + 300; choose(at(event.clientX)); }
        drag = undefined; delete control.dataset.preview;
      });
      control.addEventListener('pointercancel', () => { drag = undefined; delete control.dataset.preview; });
      control.addEventListener('keydown', event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault();
        const action = ['ArrowLeft','Home'].includes(event.key) ? 'laurel' : 'settings';
        control.querySelector('[data-footer-action="' + action + '"]')?.focus();
      });
      seat.classList.add('lsf-private-seat'); seat.append(control); privateFooters.set(button, row);
    }
    if (!button.classList.contains('lsf-private-original')) button.classList.add('lsf-private-original');
    if (button.getAttribute('aria-hidden') !== 'true') button.setAttribute('aria-hidden', 'true');
    if (button.getAttribute('tabindex') !== '-1') button.setAttribute('tabindex', '-1');
    const collapsed = button.dataset.collapsed === 'true';
    if (row.control.dataset.collapsed !== String(collapsed)) row.control.dataset.collapsed = String(collapsed);
    const font = getComputedStyle(button);
    for (const prop of ['fontFamily','fontSize','fontWeight','lineHeight']) if (row.control.style[prop] !== font[prop]) row.control.style[prop] = font[prop];
    const settingsState = footerSettingsSource?.getSnapshot?.();
    const settingsOpen = typeof settingsState?.open === 'boolean' ? settingsState.open
      : [...document.querySelectorAll('[role="dialog"][data-shortcut-modal="settings"]')].some(e => e.getClientRects().length);
    const panel = footerPanelSource?.getSnapshot?.().activePanelId;
    const active = settingsOpen ? 'settings' : panel === 'laurel-center' ? 'laurel' : 'none';
    if (row.control.dataset.active !== active) row.control.dataset.active = active;
    // Keep one thumb mounted and translate it between the two equal seats.
    // Closing a panel hides it immediately; no remembered click implies selection.
    if (active !== 'none' && row.control.dataset.position !== active) row.control.dataset.position = active;
    const reduced = preferences.motion === false;
    if (row.control.dataset.reduced !== String(reduced)) row.control.dataset.reduced = String(reduced);
    for (const action of row.control.querySelectorAll('[data-footer-action]')) {
      const pressed = String(action.dataset.footerAction === active);
      if (action.getAttribute('aria-pressed') !== pressed) action.setAttribute('aria-pressed', pressed);
    }
  }
  function syncChrome() {
    const mode = enabled ? [preferences.theme, color(), preferences.paperTone].join(':') : 'native';
    if (chromeMode === mode) return;
    chromeMode = mode;
    // The actual desktop preload observes head characterData to recompute
    // its caption probe. Notify it after our CSS mode changes, without IPC.
    if (chromeSignal) chromeSignal.data = 'Laurel appearance: ' + mode;
  }
  function schedule() { if (!frame && !disposed) frame = requestAnimationFrame(project); }
  function project() {
    frame = 0; if (disposed) return;
    const nav = document.querySelector('[data-slot="sidebar"] nav,nav[aria-label="Global panels"],nav[aria-label="全局面板"],nav[class*="_panelList"]') || [...document.querySelectorAll('nav')].find(n => [...n.querySelectorAll('button')].some(b => /Laurel/i.test(b.getAttribute('aria-label') || '')));
    const sidebar = nav?.parentElement;
    watchPrivateFooterState();
    projectPrivateFooter(sidebar);
    if (!enabled) return;
    projectPaper();
    for (const [el, row] of surfaces) if (!el.isConnected) { for (const c of row.values()) { intersection?.unobserve(c); owned.delete(c); c.remove(); } surfaces.delete(el); }
    for (const el of tags.keys()) if (!el.isConnected) tags.delete(el);

    if (sidebar) {
      tag(sidebar, 'sidebar'); tag(sidebar.closest('[class*="_sidebarCol"]'), 'sidebar-column');
      const nativeFrame = sidebar.closest('[class*="_frame"]'); tag(nativeFrame, 'shell-frame');
      tag(nav, 'nav');
      tag(sidebar.querySelector('[class*="_logoRow"]'), 'brand-row');
      const newButton = sidebar.querySelector('button[class*="_newSession"]');
      tag(newButton, 'new-chat'); brush(newButton, 'new-chat', 'new');
      tag(sidebar.querySelector('[class*="_regionArea"]'), 'workspace-region');
      tag(sidebar.querySelector('[class*="_sectionHeader"]'), 'workspace-heading');
      tag(sidebar.querySelector('[class*="_footArea"]'), 'sidebar-footer');
      for (const b of nav.querySelectorAll(':scope > button')) tag(b, 'nav-item');
      for (const r of sidebar.querySelectorAll('[data-row-key^="session:"]')) {
        tag(r, 'session');
        if (r.getAttribute('aria-selected') === 'true') brush(r, 'selected');
        const c = surfaces.get(r)?.get('selected'); if (c) c.hidden = r.getAttribute('aria-selected') !== 'true';
        // StateDot publishes its actual state; never infer it from a label or colour.
        for (const status of r.querySelectorAll('[data-state]')) tag(status, 'session-state');
      }
      for (const r of sidebar.querySelectorAll('[data-row-key^="workspace:"]')) tag(r, 'workspace');

    }
    projectSelection(sidebar);
    for (const e of document.querySelectorAll('[data-conversation-content]')) {
      const root = e.parentElement; tag(root, 'conversation');
      const head = root.querySelector('header'); tag(head, 'header');
      const tabs = root.querySelector('[data-conversation-tabs]');
      if (head) edgeBrush(head, 'header');
      if (tabs) {
        tag(tabs.parentElement, 'tabs-row');
        for (const b of tabs.querySelectorAll('[role="tab"]')) {
          if (b.getAttribute('aria-selected') === 'true') brush(b, 'tab');
          const c = surfaces.get(b)?.get('tab'); if (c) c.hidden = b.getAttribute('aria-selected') !== 'true';
        }
      }
    }
    for (const bubble of document.querySelectorAll('[data-chat-flow-kind="user"] [class*="_bubble"], [data-chat-flow-kind="steering"] [class*="_bubble"]')) {
      tag(bubble, 'user-bubble'); brush(bubble, 'message');
    }
    for (const card of document.querySelectorAll('[data-composer-card]')) { tag(card, 'composer'); brush(card, 'composer'); }
    for (const progress of document.querySelectorAll('[data-turn-process]')) {
      tag(progress, 'progress'); edgeBrush(progress, 'progress');
    }
    for (const running of document.querySelectorAll('[data-chat-running]')) {
      tag(running, 'running');
      const divider = running.querySelector('[class*="_runningDivider"]');
      if (divider) { tag(divider, 'divider'); brush(divider, 'progress'); }
      tag(running.querySelector('[class*="_runningIcon"]'), 'running-ring');
    }
    projectRings();
    for (const popup of document.querySelectorAll('[data-trigger-menu],[role=menu],[role=listbox]')) tag(popup, 'popup');
    pending = pending.then(async () => { if (enabled && !disposed && engine) await engine.mount(); }).catch(showError);
  }
  function showError(error) { console.error('Laurel Si flow:', error); html.dataset.siFlowError = String(error?.message || error); }
  function clearPaper() {
    if (paperLayer) { owned.delete(paperLayer); paperLayer.remove(); paperLayer = undefined; }
    html.removeAttribute('data-si-paper');
    for (const name of ['paper','side','dialog','plate','grain']) html.style.removeProperty('--pp-' + name);
  }
  function projectPaper() {
    if (preferences.theme !== 'si-paper-v01') { clearPaper(); return; }
    if (!paperLayer) {
      paperLayer = own(document.createElement('div'));
      paperLayer.className = 'lsf-paper-fibre'; paperLayer.setAttribute('aria-hidden', 'true');
      document.body.append(paperLayer);
    }
    // The paper belongs to the native shell. Exclude visible Laurel frame
    // rectangles so the center's own two themes retain their original pixels.
    let path = `M 0 0 H ${innerWidth} V ${innerHeight} H 0 Z`;
    for (const el of document.querySelectorAll('[data-laurel-center] iframe')) {
      if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) path += ` M ${r.left} ${r.top} H ${r.right} V ${r.bottom} H ${r.left} Z`;
    }
    const clip = `path(evenodd, "${path}")`;
    if (paperLayer.style.clipPath !== clip) paperLayer.style.clipPath = clip;
  }
  function syncPaper() {
    if (preferences.theme !== 'si-paper-v01') { clearPaper(); return; }
    html.dataset.siPaper = '0.1';
    for (const [name, value] of Object.entries(getSiPaperPalette(color(), preferences.paperTone))) html.style.setProperty('--pp-' + name, value);
    html.style.setProperty('--pp-grain', String(preferences.paperGrain / 100));
    projectPaper();
  }
  function removePresentation() {
    cancelAnimationFrame(frame); frame = 0; enabled = false;
    offClock?.(); offClock = undefined;
    for (const [el, ring] of rings) dropRing(el, ring);
    for (const [row, track] of selectionTracks) dropTrack(row, track);
    selectionCurrent = selectionWanted = selectionIdentity = undefined; selectionPending = selectionSeen = false;
    engine?.dispose(); engine = undefined; lastTheme = undefined; clearPaper();
    for (const el of owned) el.remove(); owned.clear(); surfaces.clear(); intersection?.disconnect();
    for (const [el, names] of tags) { for (const name of names) el.classList.remove(name); if (names.has('lsf-shell-frame')) { el.style.removeProperty('--lsf-right-template'); el.style.removeProperty('--lsf-side-width'); } } tags.clear();
    for (const name of ['data-si-flow', 'data-si-flow-mode', 'data-si-flow-motion', 'data-si-flow-paused', 'data-si-flow-error']) html.removeAttribute(name);
    html.style.removeProperty('--lsf-ring-duration'); html.style.removeProperty('--lsf-ring-phase');
    syncChrome();
  }
  function sync() {
    if (disposed) return;
    preferences = pc.getSnapshot();
    renderSettings();
    if (!active()) { if (enabled) removePresentation(); schedule(); return; }
    if (!enabled) { enabled = true; engine = createSiFlowEngine(); offClock = engine.onFrame(selectionFrame); }
    html.dataset.siFlow = '0.5'; html.dataset.siFlowMode = color();
    syncPaper();
    html.dataset.siFlowMotion = preferences.motion === false ? 'off' : 'on';
    html.dataset.siFlowPaused = String(preferences.paused === true);
    html.style.setProperty('--lsf-ring-duration', (2.1 / (preferences.speed || 1)) + 's');
    for (const track of selectionTracks.values()) track.configure(brushPrefs());
    if (preferences.motion === false && selectionPending) paintWanted(true);
    engine.configure({ ...brushPrefs(), fps: preferences.fps || 60, canvasMode: preferences.canvasMode || 'fit' });
    if (lastTheme !== color()) {
      lastTheme = color(); const mode = lastTheme;
      pending = pending.then(async () => { if (enabled && !disposed && engine) await engine.setTheme(mode); }).catch(showError);
    }
    syncChrome(); schedule();
  }
  function renderSettings() {
    if (!settings) return;
    settings.dataset.mode = color();
    settings.dataset.family = preferences.theme;
    const q = id => settings.querySelector('#lsf-' + id);
    q('enabled').checked = active();
    q('auto').checked = preferences.colorMode === 'auto';
    for (const b of settings.querySelectorAll('[data-lsf-theme]')) b.setAttribute('aria-pressed', String(active() && color() === b.dataset.lsfTheme && preferences.theme === b.dataset.lsfFamily));
    q('pause').textContent = preferences.paused ? '继续流动' : '暂停流动';
    q('pause').setAttribute('aria-pressed', String(preferences.paused === true));
    q('speed').value = String(preferences.speed || 1);
    q('fps').value = String(preferences.fps || 60);
    q('reduced').checked = preferences.motion === false;
    q('canvas').value = preferences.canvasMode || 'fit';
    q('motion-controls').disabled = !active();
    q('paper-controls').disabled = preferences.theme !== 'si-paper-v01';
    for (const name of ['tone', 'grain']) {
      const value = preferences[name === 'tone' ? 'paperTone' : 'paperGrain'];
      q('paper-' + name).value = String(value);
      q('paper-' + name + '-value').textContent = value + '%';
    }
    q('state').textContent = !active() ? (materialsReady ? '当前使用 Harness 原生外观' : '未安装本机外观素材，使用 Harness 原生外观') : preferences.motion === false ? '减少动态已开启 · 墨迹静止' : preferences.paused ? '墨迹已暂停' : '墨迹正在流动 · ' + (preferences.speed || 1) + '× · ' + (preferences.fps || 60) + ' FPS';
  }
  function openSettings(opener = document.activeElement) {
    if (disposed) return;
    if (settings?.open) { settings.focus(); return; }
    const dialog = document.createElement('dialog'); settings = dialog;
    dialog.className = 'lsf-settings'; dialog.setAttribute('aria-labelledby', 'lsf-title');
    dialog.innerHTML = `
      <header class="lsf-settings-head"><div><small>LAUREL / HARNESS</small><h2 id="lsf-title">Harness 界面主题</h2></div><button type="button" data-lsf-close aria-label="关闭 Harness 界面主题设置">关闭</button></header>
      <p class="lsf-note">画纸与流墨，沿用 Harness 的字号和功能布局。</p>
      <fieldset class="lsf-theme-field"><legend>界面主题</legend><div class="lsf-theme-grid">
        <button type="button" class="lsf-theme-card" data-lsf-family="si-flow-v03" data-lsf-theme="light"><span class="lsf-theme-sample lsf-sample-light" aria-hidden="true"></span><strong>月白 · 一笔流墨</strong><small>月白画纸 / 青碧墨色</small></button>
        <button type="button" class="lsf-theme-card" data-lsf-family="si-flow-v03" data-lsf-theme="dark"><span class="lsf-theme-sample lsf-sample-dark" aria-hidden="true"></span><strong>玄墨 · 一笔流碧</strong><small>玄墨画纸 / 碧流金线</small></button>
        <button type="button" class="lsf-theme-card" data-lsf-family="si-paper-v01" data-lsf-theme="light"><span class="lsf-theme-sample lsf-sample-light lsf-sample-paper" aria-hidden="true"></span><strong>画纸 · 丹青</strong><small>暖灰纸白 / 丹青细金丝</small></button>
        <button type="button" class="lsf-theme-card" data-lsf-family="si-paper-v01" data-lsf-theme="dark"><span class="lsf-theme-sample lsf-sample-dark lsf-sample-paper-dark" aria-hidden="true"></span><strong>玄墨 · 金丝</strong><small>青灰深纸 / 碧墨金丝</small></button>
      </div></fieldset>
      <fieldset id="lsf-paper-controls"><legend>画纸材质</legend>
        <label class="lsf-setting-row lsf-paper-setting"><span>纸色<small>纸白 → 暖灰原纸</small></span><input id="lsf-paper-tone" type="range" min="0" max="100" step="1"><output id="lsf-paper-tone-value" for="lsf-paper-tone">65%</output></label>
        <label class="lsf-setting-row lsf-paper-setting"><span>纸纹<small>调节纸张纤维的可见程度</small></span><input id="lsf-paper-grain" type="range" min="0" max="100" step="1"><output id="lsf-paper-grain-value" for="lsf-paper-grain">62%</output></label>
        <div class="lsf-paper-actions"><small>用于画纸 · 丹青与玄墨 · 金丝，切换主题后保留。</small><button type="button" id="lsf-paper-reset">恢复默认纸色与纸纹</button></div>
      </fieldset>
      <label class="lsf-setting-row"><span>启用 DSH 流墨主题</span><input id="lsf-enabled" type="checkbox"></label>
      <label class="lsf-setting-row"><span>跟随 Harness 明暗</span><input id="lsf-auto" type="checkbox"></label>
      <fieldset id="lsf-motion-controls"><legend>流墨动效与画布</legend>
        <div class="lsf-setting-row"><span id="lsf-state" role="status"></span><button id="lsf-pause" type="button">暂停流动</button></div>
        <label class="lsf-setting-row"><span>流动速度</span><select id="lsf-speed"><option value="0.5">0.5×</option><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="2.5">2.5×</option><option value="3">3×</option></select></label>
        <label class="lsf-setting-row"><span>流动帧率<small>统一控制笔触、颜料流动与进行中圆环</small></span><select id="lsf-fps"><option value="30">30 FPS</option><option value="60">60 FPS</option><option value="90">90 FPS</option><option value="120">120 FPS</option></select></label>
        <p class="lsf-note">会话选中时先从左向右擦淡旧墨，擦空后在新会话从左向右一笔画出。高帧率受屏幕刷新率与设备性能限制。</p>
        <label class="lsf-setting-row"><span>减少动态效果<small>默认关闭；开启后保留静态笔触</small></span><input id="lsf-reduced" type="checkbox"></label>
        <label class="lsf-setting-row"><span>画布显示精度</span><select id="lsf-canvas"><option value="fit">适应窗口</option><option value="actual">100% 原稿精度</option></select></label>
        <p class="lsf-note">仅调整墨迹画布的采样精度；文字、控件和墨迹覆盖范围保持原尺寸。</p>
      </fieldset>
      <p id="lsf-feedback" class="lsf-feedback" role="status" aria-live="polite"></p>
      <footer class="lsf-settings-foot"><button type="button" id="lsf-reset">恢复默认动态效果</button><button type="button" data-lsf-close>完成</button></footer>`;
    const q = id => dialog.querySelector('#lsf-' + id);
    let writes = Promise.resolve();
    const update = patch => {
      writes = writes.then(async () => {
        try { await pc.update(patch); preferences = pc.getSnapshot(); renderSettings(); q('feedback').textContent = '已保存，立即生效'; q('feedback').removeAttribute('data-error'); }
        catch (error) { renderSettings(); q('feedback').textContent = '保存失败：' + String(error?.message || error); q('feedback').dataset.error = ''; }
      });
    };
    for (const b of dialog.querySelectorAll('[data-lsf-theme]')) b.onclick = () => update({ theme: b.dataset.lsfFamily, colorMode: b.dataset.lsfTheme });
    q('enabled').onchange = () => update({ theme: q('enabled').checked ? preferences.lastTheme : 'native' });
    q('paper-tone').oninput = () => update({ paperTone: Number(q('paper-tone').value) });
    q('paper-grain').oninput = () => update({ paperGrain: Number(q('paper-grain').value) });
    q('paper-reset').onclick = () => update({ paperTone: 65, paperGrain: 62 });
    q('auto').onchange = () => update({ colorMode: q('auto').checked ? 'auto' : color() });
    q('pause').onclick = () => update({ paused: !preferences.paused });
    q('speed').onchange = () => update({ speed: Number(q('speed').value) });
    q('fps').onchange = () => update({ fps: Number(q('fps').value) });
    q('reduced').onchange = () => update({ motion: !q('reduced').checked });
    q('canvas').onchange = () => update({ canvasMode: q('canvas').value });
    q('reset').onclick = () => update({ paused: false, speed: 1, fps: 60, motion: true, canvasMode: 'fit' });
    for (const b of dialog.querySelectorAll('[data-lsf-close]')) b.onclick = () => dialog.close();
    dialog.addEventListener('close', () => { dialog.remove(); if (settings === dialog) settings = undefined; if (!disposed && opener?.isConnected) opener.focus({ preventScroll: true }); }, { once: true });
    renderSettings(); document.body.append(dialog); dialog.showModal();
  }

  return {
    start() {
      style = document.createElement('style'); style.dataset.siFlowStyles = '0.3'; style.textContent = SI_FLOW_CSS + createSiPaperCss() + SI_FLOW_SELECTION_CSS; document.head.append(style);
      html.dataset.laurelPrivateFooter = '';
      chromeSignal = document.createComment('Laurel appearance'); document.head.append(chromeSignal);
      resizeObserver = new ResizeObserver(schedule);
      intersection = new IntersectionObserver(entries => { for (const e of entries) { const selected = e.target.dataset.ink === 'selected' && e.target.parentElement?.getAttribute('aria-selected') !== 'true'; const tab = e.target.dataset.ink === 'tab' && e.target.parentElement?.getAttribute('aria-selected') !== 'true'; e.target.dataset.siFlowOffscreen = String(!e.isIntersecting); e.target.hidden = selected || tab; } }, { rootMargin: '100px' });
      ringIntersection = new IntersectionObserver(entries => {
        for (const entry of entries) { const ring = rings.get(entry.target); if (ring) ring.visible = entry.isIntersecting; }
        paintRings();
      });
      observer = new MutationObserver(records => {
        // Our local clock writes must not trigger project()/engine.mount() again.
        records = records.filter(r => !(r.attributeName === 'style' && rings.get(r.target)?.style === r.target.style.cssText));
        if (records.some(r => r.target === document.body && r.attributeName === 'data-ds-dark-theme')) sync();
        if (records.some(r => r.attributeName === 'class' ? privateFooters.has(r.target) || (tags.has(r.target) && [...tags.get(r.target)].some(c => !r.target.classList.contains(c))) : r.type === 'childList' ? [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1) : !r.target.hasAttribute?.('data-si-flow-owned'))) schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'data-row-key', 'data-ds-dark-theme', 'data-chat-running', 'data-state', 'data-collapsed', 'data-shortcut-modal', 'style', 'class'] });
      window.addEventListener('resize', schedule);
      offPrefs = pc.subscribe(sync); sync();
      void fetch('/laurel-center/materials/status.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(value => { if (!disposed) { materialsReady = value?.available === true; sync(); } }).catch(() => {});
      return () => { disposed = true; window.removeEventListener('resize', schedule); offPrefs?.(); offFooterPanel?.(); offFooterSettings?.(); observer?.disconnect(); resizeObserver?.disconnect(); ringIntersection?.disconnect(); removePresentation(); settings?.remove(); settings = undefined; pc.stop?.(); style?.remove(); for (const row of privateFooters.values()) removePrivateFooter(row); privateFooters.clear(); html.removeAttribute('data-laurel-private-footer'); chromeSignal?.remove(); };
    },
    snapshot: () => ({ preferences: { ...preferences }, active: enabled, theme: color(), motion: preferences.motion, surfaces: surfaces.size, rings: rings.size, selection: { pending: selectionPending, wanted: selectionWanted?.dataset.rowKey, tracks: [...selectionTracks.values()].map(t => t.snapshot()) }, engine: engine?.snapshot() }),
    setTime(time) { engine?.setTime(time); },
    appearance: pc,
    openSettings,
  };
}

/** Native-origin storage is independent from every Laurel center preference. */
export function createHarnessAppearanceClient({ storage = () => globalThis.localStorage } = {}) {
  const key = 'laurel.harness-appearance.v03', listeners = new Set();
  const families = ['si-flow-v03', 'si-paper-v01'];
  const percent = (n, fallback) => typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : fallback;
  const normalize = value => ({
    theme: [...families, 'native'].includes(value?.theme) ? value.theme : 'si-flow-v03',
    lastTheme: families.includes(value?.theme) ? value.theme : families.includes(value?.lastTheme) ? value.lastTheme : 'si-flow-v03',
    colorMode: ['auto','dark','light'].includes(value?.colorMode) ? value.colorMode : 'light',
    motion: value?.motion !== false, paused: value?.paused === true,
    speed: [0.5,1,1.5,2,2.5,3].includes(value?.speed) ? value.speed : 1,
    fps: [30,60,90,120].includes(value?.fps) ? value.fps : 60,
    canvasMode: value?.canvasMode === 'actual' ? 'actual' : 'fit',
    paperTone: percent(value?.paperTone, 65), paperGrain: percent(value?.paperGrain, 62),
  });
  let value = normalize();
  try { value = normalize(JSON.parse(storage()?.getItem(key) || '{}')); } catch {}
  return {
    getSnapshot: () => ({ ...value }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async update(patch) {
      const next = normalize({ ...value, ...patch }), target = storage();
      if (!target) throw new Error('界面设置存储不可用');
      target.setItem(key, JSON.stringify(next));
      value = next;
      for (const fn of listeners) fn(); return value;
    },
    stop() { listeners.clear(); },
  };
}

/** Exact RGB interpolation from the user-accepted paper preview 0.1. */
export function getSiPaperPalette(mode = 'light', tone = 65) {
  const mix = (a,b,t) => '#' + [0,1,2].map(i => Math.round(parseInt(a.slice(i*2+1,i*2+3),16)*(1-t)+parseInt(b.slice(i*2+1,i*2+3),16)*t).toString(16).padStart(2,'0')).join('');
  const dark = mode === 'dark', t = tone / 100;
  const palettes = dark
    ? { paper:['#1c292b','#30332f'], side:['#172427','#292e28'], dialog:['#253236','#363c34'], plate:['#304045','#3b4440'] }
    : { paper:['#f4f3ed','#e2d9cb'], side:['#e8ebe5','#d7cfbf'], dialog:['#f8f7f1','#e9e0d3'], plate:['#e5ece7','#d6d9cb'] };
  const originalPaper = { paper:'#c1b5af', side:'#b8b2a6', dialog:'#d4c8bd', plate:'#bcc4b6' };
  return Object.fromEntries(Object.entries(palettes).map(([name,p]) => [name, dark ? mix(p[0],p[1],t) : t <= .65 ? mix(p[0],mix(p[0],p[1],.65),t/.65) : mix(mix(p[0],p[1],.65),originalPaper[name],(t-.65)/.35)]));
}

/** Accepted paper CSS and embedded original fibre asset; source ledger in si-flow/paper-ledger.json. */
export function createSiPaperCss() { return "/* Measured paper crop and attached teal/gold reference. Palette lightness is an adaptation for reading. Native geometry and type remain inherited. */\n:root[data-si-flow][data-si-paper]{\n --lsf-paper:var(--pp-paper,#e8e2d7)!important;--lsf-side-paper:var(--pp-side,#ddd8cc)!important;\n --lsf-ink:#263e3e!important;--lsf-muted:#58645e!important;--lsf-teal:#256d71!important;--lsf-gold:#9c7e3f!important;\n --lsf-dialog:var(--pp-dialog,#eee9df)!important;--lsf-plate:var(--pp-plate,#dbdfd5)!important;--lsf-line:#b8bbae!important;\n --lsf-hover:#264f4a0d!important;--lsf-selected:#264f4a12!important;\n --lsf-paper-image:none!important;--lsf-side-paper-image:none!important;\n}\n:root[data-si-flow][data-si-paper][data-si-flow-mode=dark]{\n --lsf-paper:var(--pp-paper,#25312f)!important;--lsf-side-paper:var(--pp-side,#202b29)!important;\n --lsf-ink:#ebe6d9!important;--lsf-muted:#b6c1b8!important;--lsf-teal:#8cc7c5!important;--lsf-gold:#d0ba7a!important;\n --lsf-dialog:var(--pp-dialog,#2c3834)!important;--lsf-plate:var(--pp-plate,#34433b)!important;--lsf-line:#52605a!important;\n --lsf-hover:#c6ddd312!important;--lsf-selected:#c6ddd318!important;\n}\n:root[data-si-paper] .lsf-root,:root[data-si-paper] .lsf-sidebar,:root[data-si-paper] .lsf-shell-frame,:root[data-si-paper] .lsf-conversation{background-image:none!important}\n.lsf-paper-fibre{position:fixed;inset:0;pointer-events:none;z-index:100000;background-image:url('/laurel-center/materials/7bbcfd3f035ac737858cc5e2ab70f67cc07937567397e11311828993d6c9e1d3.png');background-size:420px 744px;opacity:var(--pp-grain,.62);mix-blend-mode:multiply}\n:root[data-si-flow-mode=dark] .lsf-paper-fibre{mix-blend-mode:soft-light;filter:invert(1);opacity:calc(var(--pp-grain,.62)*.65)}\n:root:not([data-si-paper]) .lsf-paper-fibre{display:none}\n:root[data-si-paper] .lsf-input{background-color:var(--lsf-dialog)!important}\n:root[data-si-paper] .lsf-code,:root[data-si-paper] pre{background-color:var(--lsf-dialog)!important}\n:root[data-si-paper] .lsf-richtext strong{color:var(--lsf-teal)!important}\n:root[data-si-paper] :focus-visible{outline-color:var(--lsf-teal)!important}\n\n/* Own settings only. Native Harness metrics are unchanged. */\n.lsf-settings[data-family=si-paper-v01]{--panel:var(--lsf-dialog);--text:var(--lsf-ink);--muted:var(--lsf-muted);--line:var(--lsf-line);--accent:var(--lsf-teal)}\n.lsf-settings .lsf-sample-paper{background-color:#ddd8cc}\n.lsf-settings .lsf-sample-paper-dark{background-color:#232b28}\n.lsf-settings input[type=range]{width:100%;height:20px;min-width:0;cursor:pointer}\n.lsf-settings .lsf-paper-setting{display:grid;grid-template-columns:minmax(116px,1fr) minmax(60px,1fr) 42px;gap:12px}\n.lsf-paper-setting output{text-align:right;font-variant-numeric:tabular-nums}\n.lsf-paper-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px}\n.lsf-paper-actions button{font-size:12px;flex-shrink:0}\n@media(max-width:480px){.lsf-paper-actions{align-items:flex-start;flex-direction:column}.lsf-settings .lsf-paper-setting{grid-template-columns:minmax(100px,1fr) minmax(40px,1fr) 36px;gap:8px}}\n"; }


/** Same visible selection layer as accepted native-add.js; native events stay authoritative. */
const SI_FLOW_SELECTION_CSS = `
:root[data-si-flow] .lsf-session>canvas[data-ink=selected]{opacity:0!important}
:root[data-si-flow] .flow-selection{position:absolute;pointer-events:none;z-index:-1}
:root[data-si-flow] .flow-selection[hidden]{display:none!important}
:root[data-si-flow] .lsf-session[data-brush-tone=light]{--dsw-alias-label-primary:#eaf5f4;--dsw-alias-label-secondary:#d2eceb;--dsw-alias-label-tertiary:#d2eceb;--dsw-alias-label-caption:#d2eceb;color:#eaf5f4!important}
:root[data-si-flow] .lsf-session[data-brush-tone=light] [class*=_time]{color:#d2eceb!important}
:root[data-si-flow] .lsf-session:not([data-brush-tone=light]){--dsw-alias-label-primary:var(--lsf-ink);--dsw-alias-label-secondary:var(--lsf-muted);--dsw-alias-label-tertiary:var(--lsf-muted);--dsw-alias-label-caption:var(--lsf-muted);color:var(--lsf-ink)!important}
:root[data-si-flow] .lsf-session:not([data-brush-tone=light]) [class*=_time]{color:var(--lsf-muted)!important;text-shadow:none!important}
:root[data-si-flow] :is(.lsf-sidebar,.lsf-conversation) [data-state=ongoing],
:root[data-si-flow] .lsf-running-ring{animation:none!important;--lsf-ring-angle:var(--lsf-ring-phase,0deg)!important}
`;
