/** 0.5 owns one theme transaction across the shell and the live center iframe. */
export const LAUREL_EXPERIENCE_REVISION = '0.5'
export function experiencePalette(family, mode, paperTone = 65, siTheme = 'si-paper-v01') {
  if (family === 'si') {
    const p = siTheme === 'si-flow-v03' ? (mode === 'dark' ? { paper:'#121f28',side:'#0d171e',dialog:'#162730',plate:'#162730' } : { paper:'#f2f2f0',side:'#e4e8e7',dialog:'#f5f7f4',plate:'#e8eeec' }) : getSiPaperPalette(mode, paperTone)
    if(siTheme === 'si-flow-v03') return { bg:p.paper,side:p.side,surface:p.dialog,plate:p.plate,text:mode==='dark'?'#eff5f6':'#102630',muted:mode==='dark'?'#a3c2d0':'#465d69',line:mode==='dark'?'#263d47':'#cbd5d4',accent:mode==='dark'?'#3dd8e4':'#1c8791',accentText:mode==='dark'?'#102630':'#f4f4ec',selected:mode==='dark'?'#20383c':'#c6d6ca',selectedText:mode==='dark'?'#eff5f6':'#102630' }
    return { bg: p.paper, side: p.side, surface: p.dialog, plate: p.plate,
      text: mode === 'dark' ? '#ebe6d9' : '#263e3e', muted: mode === 'dark' ? '#b6c1b8' : '#58645e',
      line: mode === 'dark' ? '#52605a' : '#b8bbae', accent: mode === 'dark' ? '#d0ba7a' : '#256d71',
      accentText: mode === 'dark' ? '#202b27' : '#f4f4ec', selected: mode === 'dark' ? '#3a4b47' : '#c6d6ca', selectedText: mode === 'dark' ? '#ebe6d9' : '#263e3e' }
  }
  // Existing accepted AIC graphite/alloy palette, with an independently legible day variant.
  return mode === 'dark'
    ? { bg: '#141313', side: '#1c1c1b', surface: '#242423', plate: '#302f2f', text: '#eeecec', muted: '#b5b5ae', line: '#555650', accent: '#fffd0e', accentText: '#181916', selected: '#e2e2d8', selectedText: '#181916' }
    : { bg: '#eeecec', side: '#e3e3dc', surface: '#f6f5ef', plate: '#d7d8ce', text: '#242622', muted: '#5d6258', line: '#9b9f92', accent: '#626600', accentText: '#fffef5', selected: '#e9e998', selectedText: '#20221a' }
}

/** Captures each live document, including nested canvas/frame pixels, without executing its scripts. */
export function createExperienceTransition() {
  let ticket = 0, active, native, nativeStyle, raf = 0, resolveFrame, phase = 'idle', kind = null

  const W=384,H=224,arrival=new Float32Array(W*H)
  const smooth=n=>n*n*(3-2*n)
  function rand(x,y){let n=Math.imul(x,374761393)^Math.imul(y,668265263);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295}
  function valueNoise(x,y){const ix=Math.floor(x),iy=Math.floor(y),fx=smooth(x-ix),fy=smooth(y-iy);return (rand(ix,iy)*(1-fx)+rand(ix+1,iy)*fx)*(1-fy)+(rand(ix,iy+1)*(1-fx)+rand(ix+1,iy+1)*fx)*fy}
  const texture=new Image(),grain=document.createElement('canvas');grain.width=W;grain.height=H
  // Precompute a continuous diagonal stroke. Bristles follow the existing real
  // selection brush; no trigonometry or pixel readback occurs in the frame loop.
  function prepare(pigment){
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const nx=x/(W-1),ny=y/(H-1),cross=(nx-ny+1)*.5
      const fibre=pigment?pigment[(Math.floor(cross*(H-1))*W+Math.floor((.55+Math.sin(cross*9)*.12)*(W-1)))*4+3]/255:.6
      const curl=Math.sin(cross*8)*.032+Math.sin(cross*29)*.009
      arrival[y*W+x]=nx*.58+ny*.42+curl+(valueNoise(x*.055,y*.055)-.5)*.052+(1-fibre)*.055
    }
  }
  prepare()
  texture.onload=()=>{try{const gc=grain.getContext('2d',{willReadFrequently:true});gc.drawImage(texture,0,0,W,H);prepare(gc.getImageData(0,0,W,H).data)}catch{}}
  texture.src='/laurel-center/materials/a32f965fe38bef175df25e2b29bcfe7a28111688980dd8d1fe6cd09e8c195db0.png'

  const capture = (doc, depth = 0) => {
    try { doc.defaultView?.laurelParticleControl?.prepareCapture?.() } catch {}
    const copy = doc.documentElement.cloneNode(true)
    const realCanvases = [...doc.querySelectorAll('canvas')]
    copy.querySelectorAll('canvas').forEach((c, i) => {
      try { const img = doc.createElement('img'); for (const a of c.attributes) img.setAttribute(a.name, a.value); img.src = realCanvases[i].toDataURL(); c.replaceWith(img) } catch { c.remove() }
    })
    const realFrames = [...doc.querySelectorAll('iframe')]
    copy.querySelectorAll('iframe').forEach((f, i) => {
      try { if (depth < 2 && realFrames[i].contentDocument?.documentElement) { f.removeAttribute('src'); f.srcdoc = capture(realFrames[i].contentDocument, depth + 1) } } catch { /* Cross-origin frames keep their existing source. */ }
    })
    copy.querySelectorAll('script,[data-lx-transition],dialog,.lx-settings').forEach(n => n.remove())
    const freeze = doc.createElement('style'); freeze.textContent = '*{animation:none!important;transition:none!important;caret-color:transparent!important}html,body{pointer-events:none!important}'
    copy.querySelector('head')?.append(freeze)
    return '<!doctype html>' + copy.outerHTML
  }
  const stop = () => { cancelAnimationFrame(raf); raf = 0; resolveFrame?.(); resolveFrame = null; native?.skipTransition(); native = null; nativeStyle?.remove(); nativeStyle=null; document.documentElement.style.removeProperty('--lx-wash-mask'); active?.remove(); active = null; phase = 'idle' }
  async function run({ commit, kind: style = 'industrial', reduced = false, speed = 1, fps = 60 }) {
    const id = ++ticket; stop(); kind = style
    if (reduced || document.hidden) { await commit(); return }
    phase = 'preparing'
    const visual = document.createElement('div'); visual.dataset.lxTransition = style; visual.setAttribute('aria-hidden', 'true'); visual.inert = true
    visual.setAttribute('popover', 'manual'); visual.style.cssText = 'position:fixed;inset:0;margin:0;padding:0;border:0;width:100vw;height:100vh;max-width:none;max-height:none;overflow:hidden;pointer-events:none;background:transparent;z-index:2147483646;mask-size:100% 100%;mask-repeat:no-repeat;'
    let commitPromise, nativeReady
    if (style === 'ink' && typeof document.startViewTransition === 'function') {
      // Browser snapshots retain the exact live pixels, canvas, scroll and font
      // state. Rebuilding a cloned iframe used to cause a visible preparation hitch.
      nativeStyle=document.createElement('style')
      nativeStyle.textContent='@keyframes lx-snapshot-hold{from{opacity:1}to{opacity:1}}::view-transition-group(root){animation-duration:60s}::view-transition-old(root),::view-transition-new(root){animation:none;mix-blend-mode:normal}::view-transition-old(root){animation:lx-snapshot-hold 60s linear both;z-index:2;mask-image:var(--lx-wash-mask,linear-gradient(#fff,#fff));mask-size:100% 100%;mask-repeat:no-repeat}::view-transition-new(root){z-index:1}'
      document.head.append(nativeStyle)
      document.body.append(visual); active=visual
      native=document.startViewTransition(()=>commitPromise=Promise.resolve().then(()=>commit(true)))
      native.finished.catch(()=>{})
      nativeReady=native.ready
    } else {
      const seat = document.createElement('iframe'); seat.tabIndex = -1; seat.setAttribute('sandbox', 'allow-same-origin'); seat.style.cssText = 'display:block;width:100%;height:100%;border:0;pointer-events:none;'
      let timeout
      const ready = new Promise(resolve => { seat.onload = () => {clearTimeout(timeout);resolve()}; timeout=setTimeout(resolve,700) })
      seat.srcdoc = capture(document); visual.append(seat); document.body.append(visual); active = visual
      try { visual.showPopover?.() } catch {}
      await ready
    }
    if (id !== ticket) { visual.remove(); return }
    const mask = document.createElement('canvas'); mask.width = 384; mask.height = 224
    const cx = mask.getContext('2d'), pixels = cx.createImageData(mask.width, mask.height)
    const matte = p => {
      if (style === 'industrial') {
        // Three staggered machining shutters; hard registration edges use no pigment.
        cx.clearRect(0, 0, W, H); cx.fillStyle = '#fff'
        for (let band = 0; band < 3; band++) {
          const q = Math.max(0, Math.min(1, (p - band * .07) / .82)), y = band * H / 3, h = H / 3 + 1, x = (-.12 + q * 1.24) * W
          cx.beginPath(); cx.moveTo(x, y); cx.lineTo(W, y); cx.lineTo(W, y + h); cx.lineTo(x - 12, y + h); cx.closePath(); cx.fill()
        }
        visual.style.maskImage = `url("${mask.toDataURL()}")`
      } else {
        const front=-.12+p*1.3
        for(let i=0;i<arrival.length;i++){
          const k=i*4,d=(front-arrival[i]+.018)/.058
          const a=d<=0?0:d>=1?1:smooth(d)
          pixels.data[k]=pixels.data[k+1]=pixels.data[k+2]=255;pixels.data[k+3]=Math.round((1-a)*255)
        }
        cx.putImageData(pixels, 0, 0)
        const url=`url("${mask.toDataURL()}")`
        if(native) document.documentElement.style.setProperty('--lx-wash-mask',url)
        visual.style.maskImage=url
      }
    }
    try {
      if(nativeReady){
        // A skipped browser transition still runs its update callback once.
        try { await nativeReady } catch { await commitPromise }
        await commitPromise
      } else await commit()
      if (id !== ticket) return
      phase = 'revealing'; let previous = 0, elapsed = 0, due = 0
      await new Promise(resolve => {
        resolveFrame = resolve
        const frame = now => {
          if (id !== ticket) return resolve()
          // Preserve visible shutter/wash stages when a theme repaint stalls a frame.
          if(previous) elapsed += Math.min(80,now-previous); previous=now
          const p = Math.min(1, elapsed * Math.max(.5, speed) / (style === 'ink' ? 1250 : 650))
          if (now >= due || p === 1) { matte(p * p * (3 - 2 * p)); due = now + 1000 / fps }
          if (p === 1) resolve(); else raf = requestAnimationFrame(frame)
        }; raf = requestAnimationFrame(frame)
      })
    } finally { if (id === ticket) stop(); else visual.remove() }
  }
  return { run, cancel() { ticket++; stop() }, snapshot: () => ({ phase, kind, active: !!active }), dispose() { ticket++; stop() } }
}

export function createLaurelExperience({ ctx, workbench, siFlow, controllerFactory }) {
  const pc = workbench.pc, appearance = siFlow?.appearance, originalMode = siFlow?.appearance?.getSnapshot().colorMode, originalSiTheme = siFlow?.appearance?.getSnapshot().lastTheme
  const transition = createExperienceTransition(), frames = new Set(), listeners = new Set(), tagged = new Map()
  let chromeObserver, nativeChromeSignal, nativeChromePaint, chromeFrame=0, moduleController, offModules, stopModules
  const tag=(el,name)=>{if(!el)return;const cls="lx-"+name;if(!el.classList.contains(cls)){el.classList.add(cls);if(!tagged.has(el))tagged.set(el,new Set());tagged.get(el).add(cls)}}
  function projectChrome(){chromeFrame=0;if(dead)return;const nav=document.querySelector('[data-slot="sidebar"] nav')||document.querySelector('nav[aria-label="Global panels"],nav[aria-label="全局面板"],nav[class*="_panelList"]');const sidebar=nav?.parentElement;tag(sidebar,"sidebar");tag(sidebar?.closest('[class*="_sidebarCol"]'),"sidebar-column");for(const e of document.querySelectorAll("[data-conversation-content]")){tag(e.parentElement,"conversation");tag(e.parentElement?.querySelector("header"),"conversation-header")}for(const e of document.querySelectorAll('[data-chat-flow-kind="user"] [class*="_bubble"], [data-chat-flow-kind="steering"] [class*="_bubble"]'))tag(e,"user-bubble");for(const e of document.querySelectorAll('[data-conversation-content] pre'))tag(e,"code");for(const [e] of tagged)if(!e.isConnected)tagged.delete(e);wallpaper.apply(prefs)}
  function scheduleChrome(){if(!chromeFrame&&!dead)chromeFrame=requestAnimationFrame(projectChrome)}
  let prefs = pc.getSnapshot(), modules = [], sheet, opener, section = 'appearance', pendingModule, dead = false, migrating = false, off, observer, system, legacyOpen
  let settingsWindow; const settingsWindowState={floating:false,rect:null}
  let shown, materialState = 'checking', offAppearance, audioState = 'paused', operation = 0, pendingPatch = {}
  const wallpaper = createLaurelWallpaper({ getPreferences:()=>prefs, update, feedback })
  const family = () => prefs.theme.startsWith('wuling') ? 'si' : 'industrial'
  const mode = () => prefs.colorMode === 'auto' ? document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light' : prefs.colorMode
  const reducedMotion = () => prefs.motion === false || (prefs.followSystemMotion === true && matchMedia('(prefers-reduced-motion:reduce)').matches)
  const state = () => ({ revision: LAUREL_EXPERIENCE_REVISION, family: family(), mode: mode(), preferences: { ...prefs }, reducedMotion: reducedMotion(), harness: appearance?.getSnapshot(), palette: experiencePalette(family(), mode(), appearance?.getSnapshot().paperTone, prefs.siTheme), audioState, materialState, transition: transition.snapshot() })
  function apply() {
    if (dead) return
    const s = state(), root = document.documentElement
    root.dataset.laurelShellPaint = String(s.family==='industrial'||prefs.siEnabled); root.dataset.laurelExperience = s.family; root.dataset.laurelColor = s.mode; root.dataset.laurelRevision = '0.5'
    for (const [k, v] of Object.entries(s.palette)) root.style.setProperty('--lx-' + k, v)
    const paint=JSON.stringify([s.family,s.mode,prefs.siEnabled,s.palette.side,s.palette.text]);if(nativeChromeSignal&&paint!==nativeChromePaint){nativeChromePaint=paint;nativeChromeSignal.data='Laurel shell paint: '+paint}
    if (appearance) {
      const h = appearance.getSnapshot(), next = { theme: s.family === 'si' && prefs.siEnabled ? prefs.siTheme : 'native', colorMode: s.mode, motion: !s.reducedMotion }
      if (Object.keys(next).some(k => h[k] !== next[k])) void appearance.update(next).catch(e => feedback('外观保存失败：' + e.message))
    }
    shown = { family: s.family, mode: s.mode }
    for (const frame of frames) { try { frame(s) } catch { /* A frame may have just unmounted. */ } }
    for (const fn of listeners) fn(s)
    wallpaper.apply(prefs)
    render()
  }
  function feedback(message, error = true) { const el = sheet?.querySelector('#lx-feedback'); if (el) { el.textContent = message; el.dataset.error = String(error) } }
  async function update(patch) {
    const result = await pc.update(patch)
    const current = pc.getSnapshot()
    if (result?.saved === false || current.error) throw Error(result?.error || current.error)
    feedback('已保存，立即生效', false)
  }
  async function change(patch) {
    pendingPatch = { ...pendingPatch, ...patch }
    const effective = { ...pendingPatch }, id = ++operation, old = family(), next = effective.theme ? effective.theme.startsWith('wuling') ? 'si' : 'industrial' : old
    workbench.audio.unlock()
    let saved
    await transition.run({ kind: next === 'si' ? 'ink' : 'industrial', reduced: reducedMotion(), speed: appearance?.getSnapshot().speed || 1, fps: appearance?.getSnapshot().fps || 60,
      commit: async (nativeSnapshot = false) => { if (id === operation) pendingPatch = {}; saved = update(effective); await saved; if(!nativeSnapshot) await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))) } })
    await saved
    if (id === operation && old !== 'industrial' && next === 'industrial') void workbench.audio.play('aicArea', { announce: true })
  }
  function activate(tab) { section = tab; render(); sheet?.querySelector('[data-lx-page]:not([hidden]) h3')?.focus({ preventScroll: true }) }
  const run = fn => Promise.resolve().then(fn).catch(e => feedback('未能保存：' + String(e.message)))
  function open(tab = 'appearance', field) {
    if (dead) return
    if (!sheet) {
      opener = document.activeElement; sheet = document.createElement('dialog'); sheet.className = 'lx-settings'; sheet.setAttribute('aria-labelledby', 'lx-title'); sheet.dataset.laurelSettings = '0.5'
      sheet.innerHTML = `<header class="lx-header"><div><small>LAUREL / 0.5</small><h2 id="lx-title">Laurel 设置</h2></div><div class="lx-window-actions"><button type="button" data-lx-window-toggle>悬浮调整</button><button type="button" data-lx-window-reset hidden>复位位置</button><button type="button" data-lx-close aria-label="关闭 Laurel 设置">关闭</button></div></header>
        <nav class="lx-nav" aria-label="设置分类"><button type="button" data-lx-tab="appearance">外观与动效</button><button type="button" data-lx-tab="wallpaper">壁纸与阴影</button><button type="button" data-lx-tab="audio">声音与提醒</button><button type="button" data-lx-tab="diagnostics">诊断与关于</button></nav>
        <div class="lx-body">
        <section data-lx-page="appearance"><h3 tabindex="-1">外观与动效</h3><p>主题与日夜模式同时作用于控制中心、侧边栏、会话与设置。沿用 Harness 原生字号和布局。</p>
          <fieldset><legend>整体主题 · 0.5</legend><div class="lx-theme-grid"><button type="button" data-lx-family="si">祀<small>画纸 · 丹青 / 玄墨 · 金丝</small></button><button type="button" data-lx-family="industrial">原初工业<small>合金日间 / 石墨夜间</small></button></div><label>日夜模式<select id="lx-mode"><option value="auto">跟随 Harness</option><option value="light">日间</option><option value="dark">夜间</option></select></label><button type="button" id="lx-daynight">切换日夜</button></fieldset>
          <fieldset><legend>整体动态策略</legend><label>减少动态效果<input type="checkbox" id="lx-reduced"></label><label>跟随系统减少动态<input type="checkbox" id="lx-follow-system"></label><p id="lx-motion-status" role="status"></p><p>默认沿用应用内动态设置。进入祀或切换祀日夜时，以大笔从角落冲刷全界面；进入原初工业使用工业遮板与 AIC 区域语音。</p><button type="button" id="lx-motion-reset">恢复全部动态效果</button></fieldset>
          <fieldset id="lx-si-themes"><legend>祀 · 四套流墨主题</legend><div class="lx-theme-grid">${[['si-flow-v03','light','月白 · 一笔流墨','月白画纸 / 青碧墨色'],['si-flow-v03','dark','玄墨 · 一笔流碧','玄墨画纸 / 碧流金线'],['si-paper-v01','light','画纸 · 丹青','暖灰纸白 / 丹青细金丝'],['si-paper-v01','dark','玄墨 · 金丝','青灰深纸 / 碧墨金丝']].map(([theme,color,label,note])=>`<button type="button" data-lx-si-theme="${theme}" data-lx-si-mode="${color}">${label}<small>${note}</small></button>`).join('')}</div><label>启用 DSH 流墨主题<input type="checkbox" id="lx-si-enabled"></label><p>四套主题均同步控制中心与 DSH；关闭时保留 Harness 原生外壳。切换到原初工业后保留本项选择。</p></fieldset><fieldset><legend>Harness 笔触与纸张</legend><label>笔触速度<select id="lx-speed">${[.5,1,1.5,2,2.5,3].map(n => `<option value="${n}">${n}×</option>`).join('')}</select></label><label>帧率上限<select id="lx-fps">${[30,60,90,120].map(n => `<option value="${n}">${n} FPS</option>`).join('')}</select></label><label>暂停笔触<input type="checkbox" id="lx-paused"></label><label>画布显示精度<select id="lx-canvas"><option value="fit">适应窗口</option><option value="actual">100% 原稿精度</option></select></label><label>纸色<input id="lx-paper-tone" type="range" min="0" max="100"><output data-lx-output="paperTone"></output></label><label>纸纹<input id="lx-paper-grain" type="range" min="0" max="100"><output data-lx-output="paperGrain"></output></label><button type="button" id="lx-paper-reset">恢复纸张默认值</button></fieldset>
          <fieldset><legend>控制中心粒子</legend><p>粒子模型、光晕和旋转保留独立设置；整体主题与动态策略由上方统一控制。</p><button type="button" id="lx-scene">打开粒子细节</button></fieldset></section>
        ${wallpaper.html()}<section data-lx-page="audio"><h3 tabindex="-1">声音与提醒</h3><p>本页即时保存。界面静音不改变系统通知渠道。</p><fieldset><legend>界面音频</legend><label>总声音<input type="checkbox" id="lx-sound"></label><label>界面音效<input type="checkbox" id="lx-soundEffects"></label><label>背景音乐<input type="checkbox" id="lx-music"></label>${[['volume','界面音量'],['areaVolume','AIC 区域语音'],['rewardVolume','完成反馈音量'],['musicVolume','音乐音量']].map(([key,label]) => `<label>${label}<input type="range" id="lx-${key}" min="0" max="100"><output data-lx-output="${key}"></output></label>`).join('')}<div class="lx-actions"><button type="button" id="lx-test-sound">试听音效</button><button type="button" id="lx-test-area">试听 AIC 区域语音</button></div><p id="lx-audio-status" role="status"></p></fieldset><fieldset><legend>任务通知</legend><p>提问、审批和完成通知使用「Laurel 通知」的同一份配置。</p><button type="button" id="lx-notifications">打开通知设置</button></fieldset></section>
        <section data-lx-page="diagnostics"><h3 tabindex="-1">诊断与关于</h3><dl id="lx-diagnostics"></dl><p>私人素材不随公开代码分发；缺少素材时保留可用的纯色界面与静音回退。</p></section></div><footer class="lx-foot"><span id="lx-feedback" role="status" aria-live="polite">设置逐项即时保存</span><button type="button" data-lx-close>完成</button></footer>`
      document.body.append(sheet)
      wallpaper.attach(sheet)
      sheet.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return
        if (b.hasAttribute('data-lx-close')) return sheet.close()
        if (b.dataset.lxTab) return activate(b.dataset.lxTab)
        if (b.dataset.lxSiTheme) return run(() => change({ theme:'wuling-particle-v03', siTheme:b.dataset.lxSiTheme, colorMode:b.dataset.lxSiMode, siEnabled:true }))
        if (b.id === 'lx-motion-reset') return run(async () => { await appearance.update({ paused:false,speed:1,fps:60,canvasMode:'fit' }); await update({motion:true,followSystemMotion:false}); window.dispatchEvent(new CustomEvent('laurel:v05-resume-motion')); feedback('全部动态效果已恢复',false) })
        if (b.dataset.lxFamily) return run(() => change({ theme: b.dataset.lxFamily === 'si' ? 'wuling-particle-v03' : 'particle-v03' }))
        if (b.dataset.lxModule) return openModule(b.dataset.lxModule)
        if (b.id === 'lx-daynight') return run(() => change({ colorMode: mode() === 'light' ? 'dark' : 'light' }))
        if (b.id === 'lx-paper-reset') return run(() => appearance.update({ paperTone: 65, paperGrain: 62 }).then(() => { apply(); feedback('纸张默认值已保存', false) }))
        if (b.id === 'lx-scene') { sheet.close(); window.dispatchEvent(new CustomEvent('laurel:v05-scene')); return }
        if (b.id === 'lx-notifications') return openModule('laurel')
        if (b.id === 'lx-test-sound' || b.id === 'lx-test-area') { workbench.audio.unlock(); void workbench.audio.play(b.id === 'lx-test-area' ? 'aicArea' : 'confirm', { announce: true }) }
      })
      sheet.addEventListener('change', e => {
        const el = e.target, key = el.id.replace('lx-', '')
        if (key === 'mode') return run(() => change({ colorMode: el.value }))
        if (key === 'follow-system') return run(() => update({ followSystemMotion:el.checked }))
        if (key === 'si-enabled') return run(() => update({ siEnabled:el.checked }))
        if (key === 'reduced') return run(() => update({ motion: !el.checked }))
        if (['sound','soundEffects','music'].includes(key)) return run(() => update({ [key]: el.checked }))
        if (['volume','areaVolume','rewardVolume','musicVolume'].includes(key)) return run(() => update({ [key]: +el.value / 100 }))
        const hkey = { speed:'speed',fps:'fps',paused:'paused',canvas:'canvasMode','paper-tone':'paperTone','paper-grain':'paperGrain' }[key]
        if (hkey) return run(async () => { await appearance.update({ [hkey]: key === 'paused' ? el.checked : key === 'canvas' ? el.value : +el.value }); apply(); feedback('已保存，立即生效', false) })
      })
      sheet.addEventListener('input', e => { const out = e.target.parentElement.querySelector('output'); if (out) out.textContent = e.target.value + (out.dataset.unit || '%') })
      const current=sheet
      settingsWindow=createSettingsWindow(current,settingsWindowState,()=>{
        if(sheet!==current)return
        sheet=null;settingsWindow=null;current.remove();opener?.isConnected&&opener.focus({preventScroll:true})
      })
      settingsWindow.show()
    }
    activate(tab)
    if (field) sheet.querySelector('#lx-' + field)?.focus({ preventScroll: true })
  }
  function render() {
    if (!sheet) return
    wallpaper.render(sheet)
    for (const b of sheet.querySelectorAll('[data-lx-tab]')) b.setAttribute('aria-current', b.dataset.lxTab === section ? 'page' : 'false')
    for (const page of sheet.querySelectorAll('[data-lx-page]')) page.hidden = page.dataset.lxPage !== section
    for (const b of sheet.querySelectorAll('[data-lx-family]')) b.setAttribute('aria-pressed', String(b.dataset.lxFamily === family()))
    const h = appearance?.getSnapshot() || {}
    for (const b of sheet.querySelectorAll('[data-lx-si-theme]')) b.setAttribute('aria-pressed',String(family()==='si' && prefs.siTheme===b.dataset.lxSiTheme && mode()===b.dataset.lxSiMode))
    sheet.querySelector('#lx-motion-status').textContent = reducedMotion() ? (prefs.motion === false ? '应用内减少动态已开启' : '正在跟随系统减少动态') : '全部动态开启：聚集、自转、笔触、选框与整页过渡'
    const value = { mode:prefs.colorMode,reduced:!prefs.motion,'follow-system':prefs.followSystemMotion,'si-enabled':prefs.siEnabled,canvas:h.canvasMode,speed:h.speed,fps:h.fps,paused:h.paused,'paper-tone':h.paperTone,'paper-grain':h.paperGrain,...prefs }
    for (const key of ['mode','reduced','follow-system','si-enabled','canvas','speed','fps','paused','paper-tone','paper-grain','sound','soundEffects','music','volume','areaVolume','rewardVolume','musicVolume']) {
      const el = sheet.querySelector('#lx-' + key); if (!el || el === document.activeElement) continue
      if (el.type === 'checkbox') el.checked = !!value[key]
      else el.value = ['volume','areaVolume','rewardVolume','musicVolume'].includes(key) ? Math.round(value[key] * 100) : value[key] ?? ''
      const out = el.parentElement.querySelector('output'); if (out) out.textContent = el.value + '%'
    }
    for (const id of ['paper-tone','paper-grain','paper-reset']) sheet.querySelector('#lx-' + id).disabled = family() !== 'si' || prefs.siTheme !== 'si-paper-v01'
    sheet.querySelector('#lx-daynight').textContent = mode() === 'light' ? '切换到夜间' : '切换到日间'
    sheet.querySelector('#lx-audio-status').textContent = !prefs.sound ? '总声音已关闭' : '播放器：' + audioState + ' · 素材：' + materialState
    const dl = sheet.querySelector('#lx-diagnostics'); dl.replaceChildren()
    for (const [k,v] of [['界面修订','0.5'],['插件包','1.8.5'],['当前外观',(family() === 'si' ? '祀' : '原初工业') + ' / ' + (mode() === 'dark' ? '夜间' : '日间')],['保存状态',prefs.error ? '保存失败：' + prefs.error : prefs.saving ? '保存中' : prefs.saved ? '已保存' : '未确认'],['本机素材',materialState],['音频',audioState]]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; dl.append(dt,dd)
    }
  }
  function openModule(id) {
    pendingModule = id; sheet?.close(); try { ctx.get?.('layout')?.selectPanel?.('laurel-center') } catch {}
    window.dispatchEvent(new CustomEvent('laurel:v05-module', { detail: { id } }))
  }
  const onAudio = e => { audioState = e.detail?.state || 'unavailable'; render() }
  const onVisibility = () => { if (document.hidden) { transition.cancel(); if (Object.keys(pendingPatch).length) { const patch=pendingPatch;pendingPatch={};void update(patch).catch(e=>feedback('未能保存：'+e.message)) } } }
  const onOpen = e => open(e.detail?.section || 'appearance', e.detail?.field)
  return {
    start() {
      dead = false; const style = document.createElement('style'); style.dataset.laurelExperienceStyle = '0.5'; style.textContent = LAUREL_EXPERIENCE_CSS; document.head.append(style);nativeChromeSignal=document.createComment('Laurel shell paint');document.head.append(nativeChromeSignal)
      off = pc.subscribe(value => {
        prefs = value; apply()
        if (!value.loading && !value.error && value.experienceRevision !== 5 && !migrating) {
          migrating = true; void update({ experienceRevision: 5, siTheme: originalSiTheme || 'si-paper-v01', theme: value.theme.startsWith('wuling') ? 'wuling-particle-v03' : 'particle-v03', colorMode: value.theme.startsWith('wuling') ? originalMode || value.colorMode : value.colorMode }).catch(() => {}).finally(() => { migrating = false })
        }
      })
      observer = new MutationObserver(() => {
        if (prefs.colorMode !== 'auto' || shown?.mode === mode()) return
        void transition.run({ kind: family() === 'si' ? 'ink' : 'industrial', reduced: reducedMotion(), commit: apply })
      }); observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      system = matchMedia('(prefers-reduced-motion:reduce)'); const onSystem = () => { if (reducedMotion()) transition.cancel(); apply() }; system.addEventListener('change', onSystem)
      window.addEventListener('laurel:audio-state', onAudio); window.addEventListener('laurel:open-settings', onOpen)
      legacyOpen = siFlow?.openSettings; if (siFlow) siFlow.openSettings = () => open('appearance')
      if(controllerFactory){moduleController=controllerFactory();offModules=moduleController.subscribe(value=>{modules=value.rows;render()});stopModules=moduleController.start()}
      document.addEventListener('visibilitychange',onVisibility)
      chromeObserver=new MutationObserver(records=>{if(records.some(r=>r.type==='childList'||r.attributeName==='aria-label'||(r.attributeName==='class'&&tagged.has(r.target)&&[...tagged.get(r.target)].some(cls=>!r.target.classList.contains(cls)))))scheduleChrome()});chromeObserver.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','aria-label']});projectChrome()
      offAppearance = appearance?.subscribe(() => { if (!dead) apply() }); apply()
      void fetch('/laurel-center/materials/status.json', { cache:'no-store' }).then(r => r.ok ? r.json() : null).then(v => { materialState = v?.available ? 'available' : 'unavailable'; render() }).catch(() => { materialState = 'unavailable'; render() })
      return () => { dead = true; transition.dispose(); wallpaper.dispose(); off?.(); offAppearance?.(); chromeObserver?.disconnect();document.removeEventListener('visibilitychange',onVisibility);offModules?.();stopModules?.();moduleController?.stop();cancelAnimationFrame(chromeFrame);for(const [el,classes] of tagged)for(const cls of classes)el.classList.remove(cls);tagged.clear(); observer.disconnect(); system.removeEventListener('change', onSystem); window.removeEventListener('laurel:audio-state', onAudio); window.removeEventListener('laurel:open-settings', onOpen); settingsWindow?.dispose();settingsWindow=null;sheet?.remove(); sheet = null; frames.clear(); listeners.clear(); if (siFlow) siFlow.openSettings = legacyOpen; style.remove();nativeChromeSignal?.remove(); for (const k of Object.keys(experiencePalette('industrial','dark'))) document.documentElement.style.removeProperty('--lx-' + k); for (const a of ['data-laurel-experience','data-laurel-color','data-laurel-revision','data-laurel-shell-paint']) document.documentElement.removeAttribute(a) }
    },
    open, change, update, snapshot: state, apply,
    subscribeFrame(fn) { frames.add(fn); fn(state()); return () => frames.delete(fn) },
    setModules(rows) { modules = rows; render() },
    takePendingModule() { const id = pendingModule; pendingModule = null; return id },
  }
}
