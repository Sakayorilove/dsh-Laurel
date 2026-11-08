// The iframe owns the approved viewport, CSS, font bytes and WebGL lifecycle.
// Native settings remain real slot registrations, rendered through a portal.
export function createParticleThemePanel(options) {
  const { React, ctx, t, controllerFactory, windowState, phaseKey, formatNotice, workbench, createPortal, siFlow } = options
  const h = React.createElement, Legacy = createAcceptedPanel(options)
  const themes = [['endfield','0.1 · 集成工业 AIC'],['wuling','0.1 · 武陵城'],['endfield-v02','0.2 · AIC 集成工业'],['wuling-v02','0.2 · 武陵 丹青入境'],['particle-v03','0.5 · 原初工业'],['wuling-particle-v03','0.5 · 祀']]
  function ParticlePanel({ renderSlot, pc, preferences }) {
    const nativeObserver = React.useRef(null), frameOff = React.useRef(null)
    const activity = React.useRef({ sync() {} })
    const frame = React.useRef(null), bridge = React.useRef(null), nativeRoot = React.useRef(null), styleObserver = React.useRef(null), savedRevision = React.useRef(0)
    const [ctrl] = React.useState(controllerFactory), [state, setState] = React.useState(ctrl.getSnapshot()), [detail, setDetail] = React.useState(null), [target, setTarget] = React.useState(null), [loaded, setLoaded] = React.useState(false)
    const live = React.useRef({});live.current = {state,preferences}
    const [initialDocument] = React.useState(() => {
      const s = workbench.experience.snapshot()
      const tokens = Object.entries(s.palette).map(([key,value]) => '--lx-'+key+':'+value).join(';')
      return PARTICLE_V03_DOCUMENT.replace(/<html[^>]*>/, '<html lang="zh-CN" data-initial-theme="'+s.family+'" data-theme="'+s.family+'" data-color="'+s.mode+'" data-revision="0.5" data-laurel-active="false" style="color-scheme:'+s.mode+';'+tokens+'">').replace('content="dark"', 'content="'+s.mode+'"')
    })
    const pack = () => { const s = ctrl.getSnapshot();return {...s,busy:s.busy||['checking','downloading','applying'].includes(s.store?.job?.phase),message:s.problem ? '状态读取失败：'+s.problem.text : formatNotice(s.notice,t)} }
    React.useEffect(() => {const off=ctrl.subscribe(setState),stop=ctrl.start();return()=>{off();stop?.();ctrl.stop()}},[ctrl])
    React.useEffect(() => {bridge.current?.sync(pack());workbench?.experience?.setModules(state.rows)},[state])
    React.useEffect(() => {
      const open=()=>workbench?.experience?.open('appearance');const scene=()=>bridge.current?.openScene();const resume=()=>bridge.current?.resumeMotion();window.addEventListener('laurel:v05-resume-motion',resume);const module=e=>bridge.current?.openModule(e.detail.id);window.addEventListener('laurel:v05-scene',scene);window.addEventListener('laurel:v05-module',module);window.addEventListener('laurel:open-theme-settings',open)
      const saved=e=>{if(e.detail?.persisted===true){savedRevision.current++;bridge.current?.saved(e.detail.id)}}
      window.addEventListener('laurel:configuration-saved',saved)
      return()=>{window.removeEventListener('laurel:v05-resume-motion',resume);frameOff.current?.();window.removeEventListener('laurel:v05-scene',scene);window.removeEventListener('laurel:v05-module',module);nativeObserver.current?.disconnect();window.removeEventListener('laurel:open-theme-settings',open);window.removeEventListener('laurel:configuration-saved',saved);styleObserver.current?.disconnect();bridge.current?.dispose();bridge.current=null}
    },[])
    React.useEffect(() => {
      const info = ctx.get?.('layout')?.panelInfo;
      let intersecting = false;
      const sync = () => {
        const panel = info?.getSnapshot?.();
        const selected = !panel || panel.activePanelId === 'laurel-center';
        bridge.current?.setActive(selected && intersecting && !document.hidden);
      };
      activity.current = { sync };
      const observer = new IntersectionObserver(entries => { intersecting = entries[0]?.isIntersecting === true; sync(); });
      if (frame.current) observer.observe(frame.current);
      const off = info?.subscribe?.(sync);
      document.addEventListener('visibilitychange', sync);
      sync();
      return () => { off?.(); observer.disconnect(); document.removeEventListener('visibilitychange', sync); bridge.current?.setActive(false); activity.current = { sync() {} }; };
    }, []);
    function locateField(id,root,field,api){
      let attempts=0
      const normalize=s=>String(s||'').replace(/[\s（()）:：]/g,'').toLowerCase()
      const locate=()=>{
        if(nativeRoot.current!==root)return
        window.dispatchEvent(new CustomEvent('laurel:locate-setting',{detail:{id,...field}}))
        for(const node of root.querySelectorAll('details'))node.open=true
        const selectors={tier:'#laurel-memory-tier',modelSource:'#laurel-memory-source',baseUrl:'#laurel-memory-endpoint',provider:'#laurel-memory-provider',model:'#laurel-memory-model'}
        let target=root.querySelector('[data-setting-key="'+field.key+'"],[data-common-setting="'+field.key+'"],[data-lrs-switch="'+field.key+'"]')
        if(!target&&id==='reasoning-scroll'&&field.key==='maxHeight')target=root.querySelector('[data-lrs-num]')
        if(!target&&id==='memory-core')target=root.querySelector(selectors[field.key]||':not(*)')
        if(!target){const names=[field.label,field.en].filter(Boolean).map(normalize);target=[...root.querySelectorAll('input,select,textarea')].find(node=>{const label=normalize(node.getAttribute('aria-label')||[...(node.labels||[])].map(l=>l.textContent).join(' ')||node.closest('label')?.textContent);return names.some(name=>label&&name&&(label===name||label.startsWith(name)))})}
        if(target&&target.getClientRects().length){const control=target.matches('input,select,textarea,button')?target:target.querySelector('input,select,textarea,button');target.scrollIntoView({block:'center',behavior:'instant'});control?.focus({preventScroll:true});target.style.outline='2px solid var(--signal)';setTimeout(()=>{target.style.outline=''},2400);api.located(id,field,true);return}
        if(++attempts<35)setTimeout(locate,60);else api.located(id,field,false)
      }
      setTimeout(locate,30)
    }
    function connect(){
      const win=frame.current?.contentWindow,api=win?.laurelParticleControl;if(!api)return
      bridge.current=api;setLoaded(true);activity.current.sync()
      api.connect({
        theme:live.current.preferences.theme==='wuling-particle-v03'?'si':'industrial',favorites:live.current.preferences.favorites,
        snapshot:pack,toggle:(id,on)=>ctrl.toggle(id,on),bulk:(on,ids)=>ctrl.bulk(on,ids),
        storeAction:(action,id,version)=>ctrl.storeAction(action,id,version),openStore:()=>window.dispatchEvent(new Event('laurel:open-module-store')),
        changeTheme:id=>workbench.experience.change({theme:id==='si'?'wuling-particle-v03':'particle-v03'}),changeMode:colorMode=>workbench.experience.change({colorMode}).catch(()=>{}),openSettings:(tab,field)=>workbench.experience.open(tab,field),unlockAudio:()=>workbench.audio.unlock(),playAudio:key=>workbench.audio.play(key),
        selectVersion:theme=>workbench.experience.change({theme}),themes,
        favoritesChanged:favorites=>{if(JSON.stringify(favorites)!==JSON.stringify(live.current.preferences.favorites))void pc.update({favorites})},
        openDetail(id,el,field){
          setDetail(id);styleObserver.current?.disconnect();nativeObserver.current?.disconnect();el.replaceChildren();
          const shadow=el.shadowRoot||el.attachShadow?.({mode:'open'})
          // detail-fields is reused between modules. Its shadow root is stable.
          const mount=shadow||el,styles=win.document.createElement('div'),content=win.document.createElement('div')
          content.className='lc-panel ef accepted-control-center';content.id='laurel-center-accepted';content.dataset.themeRevision='v02';content.dataset.design=live.current.preferences.theme.startsWith('wuling')?'wuling':'aic';content.dataset.theme=workbench.experience.snapshot().mode;content.style.cssText='height:auto;min-height:0;min-width:0;overflow:visible;background:transparent;color:inherit;padding:0;--ef-ink:var(--lx-text);--ef-ink-2:var(--lx-muted);--ef-paper:var(--lx-surface);--ef-panel:var(--lx-surface);--ef-rule:var(--lx-line);--ef-trace:var(--lx-line);--ef-chip:var(--lx-plate);--ef-signal:var(--lx-accent);--ink:var(--lx-text);--paper:var(--lx-surface);--muted:var(--lx-muted);--signal:var(--lx-accent);--line-dark:var(--lx-line);'
          const refreshStyles=()=>{styles.replaceChildren(...[...document.querySelectorAll('style,link[rel=stylesheet]')].map(n=>n.cloneNode(true)));const fix=win.document.createElement('style');fix.textContent=':host{display:block;font:inherit;color:inherit} .actual-settings{font-family:inherit!important} .actual-settings form{margin:0} .actual-settings .lc-root{max-width:none}';fix.textContent+=` .switch{appearance:none!important;background:var(--lx-line)!important;border:1px solid var(--lx-muted)!important}.switch:before{background:var(--lx-bg)!important}.switch:checked{background:var(--lx-accent)!important;border-color:var(--lx-accent)!important}.switch:checked:before{background:var(--lx-accentText)!important}`;styles.append(fix)}
          const native=win.document.createElement('div');native.className='actual-settings';content.append(native);
          const previewStyle=win.document.createElement('style');previewStyle.textContent=win.document.head.querySelector('style').textContent;
          const align=win.document.createElement('style');align.textContent=':host{display:block;font:inherit;color:var(--ink)} .lc-panel{font:inherit!important;color:var(--ink)!important} .laurel-panel{padding:0!important} .laurel-panel>h3,.laurel-panel>.laurel-desc{display:none} .laurel-row{align-items:center} .actual-settings .lc-embedded-heading,.actual-settings .lc-embedded-description{display:none!important} .actual-settings button{font-family:inherit} .actual-settings button[role=tab][aria-selected=true],.actual-settings button[aria-pressed=true]{border-color:var(--signal)!important;box-shadow:inset 0 -2px 0 var(--signal);font-weight:700} .actual-settings input:not([type=checkbox]),.actual-settings select,.actual-settings textarea{font-family:inherit;color:var(--ink)!important;background:transparent!important;border-color:var(--line-dark)!important} .actual-settings .primary-action{color:var(--lx-accentText)!important;background:var(--lx-accent)!important} .actual-settings .secondary-action{color:var(--ink)!important;background:transparent!important;border:1px solid var(--line-dark)!important}';
          refreshStyles();mount.replaceChildren(styles,previewStyle,align,content);nativeRoot.current=native;setTarget(native)
          const decorate=()=>{for(const row of native.querySelectorAll('.laurel-row'))row.classList.add('setting-row');for(const input of native.querySelectorAll('input[type=checkbox]'))input.classList.add('switch');for(const b of native.querySelectorAll('button')){b.classList.add(/^(保存|应用|Save|Apply)/.test(b.textContent.trim())?'primary-action':'secondary-action');for(const key of ['padding','borderRadius','background','color','border','font','boxShadow'])b.style[key]=''}};
          decorate();nativeObserver.current=new MutationObserver(decorate);nativeObserver.current.observe(native,{childList:true,subtree:true});
          styleObserver.current=new MutationObserver(refreshStyles);styleObserver.current.observe(document.head,{childList:true,subtree:true,characterData:true})
          if(field)locateField(id,native,field,api);
          void pc.update({recent:[id,...live.current.preferences.recent.filter(x=>x!==id)].slice(0,30)})
        },
        openHarnessField(field){const ids={theme:'si-themes',canvasMode:'canvas',colorMode:'mode',paperTone:'paper-tone',paperGrain:'paper-grain',paused:'paused',speed:'speed',fps:'fps',motion:'reduced'};workbench.experience.open('appearance',ids[field.key]);},
        closeDetail(){setTarget(null);setDetail(null);nativeObserver.current?.disconnect();styleObserver.current?.disconnect();nativeRoot.current=null}
      })
      frameOff.current?.();frameOff.current=workbench.experience.subscribeFrame(s=>{api.applyExperience(s);const content=nativeRoot.current?.closest('.lc-panel');if(content){content.dataset.theme=s.mode;content.dataset.design=s.family==='si'?'wuling':'aic'}});workbench.experience.setModules(ctrl.getSnapshot().rows);const pending=workbench.experience.takePendingModule();if(pending)api.openModule(pending);
      const harnessButton=win.document.querySelector('#dsh-interface-01')
      if(harnessButton)harnessButton.onclick=()=>siFlow?.openSettings(harnessButton)
      const brand=win.document.querySelector('#theme-library')
      brand?.addEventListener('click',e=>{e.preventDefault();workbench.experience.open('diagnostics')})
      win.document.querySelectorAll('[data-version]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.version===live.current.preferences.theme));b.onclick=()=>{void workbench.experience.change({theme:b.dataset.version}).catch(()=>{});win.document.querySelector('#theme-library-dialog')?.close()}})
    }
    const row=state.rows.find(r=>r.id===detail)
    const settings=target&&detail&&createPortal(h('div', {className:'lc-modules',key:detail},renderSlot && row?.settingsId ? renderSlot(MODULE_SLOT,{controlCenter:true},{only:row?.settingsId,fallback:h('p',{role:'status'},row?.enabled?'等待模块设置加载。':'启用模块后可调整选项。')}) : h('p',{role:'alert'},'模块插槽不可用，请重新加载客户端。')),target)
    return h('div',{'data-laurel-center':'','data-theme-revision':'v05',style:{display:'flex',width:'100%',height:'100%',minHeight:0,minWidth:0,flex:'1 1 auto',overflow:'hidden'}},h('iframe',{ref:frame,title:'Laurel 控制中心 · 0.5',srcDoc:initialDocument,onLoad:connect,style:{display:'block',width:'100%',height:'100%',minHeight:0,flex:'1 1 auto',border:0,visibility:loaded?'visible':'hidden',background:'var(--lx-side)'},'data-laurel-particle-frame':''}),settings)
  }
  return function ThemePanel(props){
    const [pc]=React.useState(()=>workbench?.pc||createPresentationClient()),[preferences,setPreferences]=React.useState(pc.getSnapshot())
    React.useEffect(()=>{const off=pc.subscribe(setPreferences);if(!workbench)void pc.load();return()=>{off();if(!workbench)pc.stop()}},[pc])
    return /particle-v03$/.test(preferences.theme)?h(ParticlePanel,{...props,pc,preferences}):h(Legacy,props)
  }
}
