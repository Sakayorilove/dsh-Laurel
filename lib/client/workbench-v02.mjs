/** Native DSH ownership remains intact. Only namespaced presentation hooks are added. */
export function createWorkbenchRuntime({ React, ctx }) {
  const pc = createPresentationClient(), audio = new EndfieldAudio(), subscribers = new Set(), tagged = new Map(), owned = new Set()
  let prefs = pc.getSnapshot(), shell, layout, observer, frame = 0, dead = false, offPrefs, offPanel, style, editor, bypassOptions = false, nativeOptions, areaAnimation, areaTimer, wasCenter = false, workspaceSource, offWorkspaces
  const root = () => document.documentElement
  const isV02 = () => /-v02$/.test(prefs.theme)
  const design = () => prefs.theme.startsWith('wuling') ? 'wuling' : 'aic'
  const color = () => prefs.colorMode === 'auto' ? document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light' : prefs.colorMode
  function tag(el, ...classes) { if (!el) return; let list = tagged.get(el); if (!list) tagged.set(el, list = new Set()); for (const name of classes) { const cls = 'lwb-' + name; if (!el.classList.contains(cls)) { el.classList.add(cls); list.add(cls) } } }
  function untags() { for (const [el,list] of tagged) { for (const cls of list) el.classList.remove(cls); for (const a of ['data-lwb-caption','data-lwb-detail','data-current']) el.removeAttribute(a); if (el.hasAttribute('data-lwb-marker-id')) { el.removeAttribute('role'); el.removeAttribute('tabindex'); el.removeAttribute('aria-label'); el.removeAttribute('data-lwb-marker-id');el.removeAttribute('data-lwb-marker-signature') } } tagged.clear(); for (const el of owned) el.remove(); owned.clear() }
  function notify() { for (const fn of subscribers) fn(prefs) }
  function syncTheme() {
    if (dead) return
    shell?.sync();if (!isV02()) { root().removeAttribute('data-laurel-workbench'); untags(); editor?.close(); return }
    root().dataset.laurelWorkbench = 'v02'; root().dataset.laurelDesign = design(); root().dataset.laurelColor = color(); root().dataset.laurelNav = prefs.navMode; root().dataset.laurelMotion = prefs.motion ? 'on' : 'off'; schedule()
  }
  function workspaceSnapshot(){try{return workspaceSource?.getSnapshot?.()}catch{return undefined}}
  function activeWorkspace(){const id=document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session');return workspaceSnapshot()?.items?.find(w=>w.sessionIds.includes(id))}
  function workspaceRows() { return [...document.querySelectorAll('[data-row-key^="workspace:"]')] }
  function workspaces() { return workspaceRows().map(el => { const id = el.getAttribute('data-row-key').slice(10), title = el.querySelector('.lwb-workspace-title')?.textContent || el.children[2]?.textContent || '工作区';return {id,name:title.trim(),marker:prefs.workspaceMarkers[id]||{type:'letter',text:[...title.trim()][0]||'组',color:design()==='wuling'?'#b9d6b5':'#eff500'}} }) }
  function paintMarker(el,id,title) {
    tag(el,'workspace-avatar');el.dataset.lwbMarkerId=id;el.setAttribute('role','button');el.tabIndex=0;el.setAttribute('aria-label','自定义'+title+'标记')
    const marker = prefs.workspaceMarkers[id] || {type:'letter',text:[...title][0]||'组',color:design()==='wuling'?'#b9d6b5':'#eff500'}, signature=JSON.stringify(marker)
    if (el.dataset.lwbMarkerSignature === signature && el.querySelector('[data-lwb-owned]')) return
    el.querySelectorAll('[data-lwb-owned]').forEach(n=>n.remove());const face=workbenchMarkerFace(marker);face.dataset.lwbOwned='';el.append(face);owned.add(face);el.dataset.lwbMarkerSignature=signature
  }
  function project() {
    frame=0;if(dead||!isV02())return;attachLayout()
    for (const el of owned) if(!el.isConnected)owned.delete(el)
    for (const el of tagged.keys()) if(!el.isConnected)tagged.delete(el)
    const nav=[...document.querySelectorAll('nav')].find(n=>n.querySelector('button[aria-label="Laurel 控制中心"]')), side=nav?.parentElement
    if(side){
      tag(side,'sidebar');tag(nav,'primary-nav');nav.querySelectorAll(':scope > button').forEach(el=>tag(el,'nav-item'))
      tag(side.querySelector('[class*="logoRow"]'),'identity');tag(side.querySelector('[class*="brandName"]'),'dsh-wordmark');tag(side.querySelector('[class*="brandMark"]'),'brand-mark')
      tag(side.querySelector('button[class*="newSession"]'),'new-session','cut');tag(side.querySelector('[class*="regionArea"]'),'region');tag(side.querySelector('[class*="footArea"]'),'sidebar-bottom')
      const browser=side.querySelector('[class*="sectionHeader"]')?.parentElement;if(browser){tag(browser,'browser');tag(browser.querySelector('[class*="sectionHeader"]'),'workspace-caption');tag(browser.querySelector('[class*="listArea"]'),'list-area');tag(browser.querySelector('[class$="_list"]'),'workspace-tree')}
      browser?.querySelectorAll('[class*="sectionHeader"] button').forEach(el=>{tag(el,'icon-button');if(/视图|查看选项|View options/i.test(el.getAttribute('aria-label')||''))nativeOptions=el})
    }
    shell?.project();
    for(const row of workspaceRows()){
      if(row.children.length<3)continue;const id=row.getAttribute('data-row-key').slice(10),label=row.children[2]?.querySelector('span')||row.children[2],title=label?.textContent?.trim()||'工作区'
      tag(row,'workspace-row','workspace-toggle');const group=row.closest('[class*=groupSection]')||row.parentElement;tag(group,'workspace-group');if(group!==row.parentElement)tag(row.parentElement,'workspace-seat');group.dataset.current=String(activeWorkspace()?.workspaceId===id||!!group.querySelector('[data-row-key^="session:"][aria-selected=true]'))
      tag(label,'workspace-title');tag(row.children[2],'project-text');const data=workspaceSnapshot(),workspace=data?.items?.find(w=>w.workspaceId===id);row.children[2].dataset.lwbCaption='// BAKER · '+(workspace?workspace.sessionIds.filter(s=>!data.archivedSessionIds?.includes(s)).length+' 个会话':'会话分组')+' ━ ▪▪▪'
      tag(row.children[1],'group-chevron');tag(row.children[3],'native-actions');paintMarker(row.children[0],id,title)
    }
    for(const row of document.querySelectorAll('[data-row-key^="session:"]')){
      const children=[...row.children].filter(el=>!el.hasAttribute('data-lwb-owned'));tag(row,'session');const selected=row.getAttribute('aria-selected')==='true';if(selected)tagged.get(row).add('lwb-current');else tagged.get(row).delete('lwb-current');row.classList.toggle('lwb-current',selected);const time=row.querySelector(':scope > [class*="_time"]');tag(children[0],'session-slot');tag(children[1],'session-title');tag(time,'session-time');tag(row.querySelector(':scope > [class*=rowActions]'),'native-actions');row.dataset.lwbDetail=time?.textContent?'最近 · '+time.textContent:'会话记录'
      if(children[0]&&!children[0].querySelector('.lwb-baker-chat-icon')){const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('class','lwb-baker-chat-icon');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');icon.dataset.lwbOwned='';icon.innerHTML='<path d="M3 4h18v13H9l-6 4Z"/><path d="M7 8h10M7 12h7"/>';children[0].append(icon);owned.add(icon)}
      if(!row.querySelector(':scope > .lwb-branch-wire')){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','lwb-branch-wire');svg.setAttribute('viewBox','0 0 32 44');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');svg.dataset.lwbOwned='';row.prepend(svg);owned.add(svg)}
      const svg=row.querySelector(':scope > .lwb-branch-wire'),route=design()==='wuling'?'M8 0V14Q8 22 16 22H29':'M8 0V15L15 22H29';if(svg.dataset.route!==route){svg.innerHTML='<path class="lwb-branch-stem" d="M8 0V44"/><path class="lwb-branch-route" d="'+route+'"/><path class="lwb-branch-route-active" pathLength="1" d="'+route+'"/>'+(design()==='wuling'?'<path class="lwb-branch-terminal" d="m28 19 3 3-3 3-3-3Z"/>':'<rect class="lwb-branch-terminal" x="26" y="20" width="4" height="4"/>');svg.dataset.route=route}
    }
    for(const content of document.querySelectorAll('[data-conversation-content]')){
      let art=content.querySelector(':scope > .lwb-world-art');if(!art){const template=document.createElement('template');template.innerHTML=WORKBENCH_WORLD[design()];art=template.content.firstElementChild;art.dataset.lwbOwned='';art.dataset.design=design();content.append(art);owned.add(art)}else if(art.dataset.design!==design()){const template=document.createElement('template');template.innerHTML=WORKBENCH_WORLD[design()];const next=template.content.firstElementChild;next.dataset.lwbOwned='';next.dataset.design=design();art.replaceWith(next);owned.delete(art);owned.add(next)}
    }
  }
  function schedule(){if(!frame&&!dead&&isV02())frame=requestAnimationFrame(project)}
  function toast(message){editor?.toast(message)}
  function areaIntro(){
    clearTimeout(areaTimer);areaAnimation?.cancel();document.querySelector('#lwb-area-intro')?.remove();if(!isV02()||!prefs.motion||matchMedia('(prefers-reduced-motion:reduce)').matches)return
    const template=document.createElement('template');template.innerHTML=WORKBENCH_AREA;const el=template.content.firstElementChild;el.hidden=false;el.dataset.lwbOwned='';document.body.append(el);owned.add(el)
    const target=document.querySelector('#laurel-center-accepted')?.getBoundingClientRect();if(target){el.style.left=target.left+target.width/2+'px';el.style.top=target.top+target.height/2+'px'}
    areaAnimation=el.animate([{opacity:0,clipPath:'inset(48% 45% 48% 0)'},{opacity:1,clipPath:'inset(0)',offset:.23},{opacity:1,offset:.76},{opacity:0,transform:'translate(-50%,-54%)'}],{duration:1150,easing:'cubic-bezier(.2,.7,.2,1)'});areaTimer=setTimeout(()=>{el.remove();owned.delete(el)},1160)
  }
  function attachLayout(){
    try{const source=ctx.get?.('workspaces')?.list;if(source?.getSnapshot&&source?.subscribe&&source!==workspaceSource){offWorkspaces?.();workspaceSource=source;offWorkspaces=source.subscribe(schedule)}}catch{}

    let next;try{next=ctx.get?.('layout')}catch{}
    if(!next?.panelInfo?.getSnapshot||!next?.panelInfo?.subscribe)return
    if(layout===next&&offPanel)return
    offPanel?.();layout=next;offPanel=layout.panelInfo.subscribe(panelSync);panelSync()
  }
  function panelSync(){const center=layout?.panelInfo?.getSnapshot?.()?.activePanelId==='laurel-center';audio.setActive(center,{announce:false});if(center&&!wasCenter)requestAnimationFrame(areaIntro);if(!center){areaAnimation?.cancel();document.querySelector('#lwb-area-intro')?.remove()}wasCenter=center}
  function onClick(e){if(!isV02()||!(e.target instanceof Element))return;const marker=e.target.closest('[data-lwb-marker-id]');if(marker){e.preventDefault();e.stopPropagation();editor?.openMarker(marker.dataset.lwbMarkerId);return}if(nativeOptions?.contains(e.target)){if(bypassOptions){bypassOptions=false;return}e.preventDefault();e.stopPropagation();editor?.openAppearance();return}const session=e.target.closest('[data-row-key^="session:"]');if(session){const id=session.getAttribute('data-row-key').slice(8);if(layout?.panelInfo?.getSnapshot?.()?.activePanelId&&!workspaceSnapshot()?.archivedSessionIds?.includes(id))layout.selectPanel?.(null);void audio.play('select');if(prefs.motion&&!matchMedia('(prefers-reduced-motion:reduce)').matches)session.animate([{transform:'translateX(0)'},{transform:'translateX(5px)',offset:.35},{transform:'translateX(0)'}],{duration:320,easing:'cubic-bezier(.18,.75,.22,1)'})}}
  function onKey(e){if(!(e.target instanceof Element))return;if(['Enter',' '].includes(e.key)&&e.target.hasAttribute('data-lwb-marker-id')){e.preventDefault();e.stopPropagation();editor?.openMarker(e.target.dataset.lwbMarkerId)}}
  const api={pc,audio,getSnapshot:()=>prefs,subscribe(fn){subscribers.add(fn);return()=>subscribers.delete(fn)},activeWorkspace,isV02,workspaces,project,schedule,toast,attachLayout,
    nativeViewOptions(){editor?.close();if(nativeOptions){bypassOptions=true;nativeOptions.click()}},
    openAppearance(){editor?.openAppearance()},openTheme(){shell?.openTheme()},openAudioSettings(){if(api.experience){api.experience.open('audio');return}try{layout?.selectPanel?.('laurel-center');requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent('laurel:open-theme-settings')))}catch{}},
    start(){
      if(typeof document==='undefined'||!document.body?.append||!document.head?.append)return()=>{dead=true;audio.dispose();pc.stop()}
      style=document.createElement('style');style.dataset.laurelWorkbenchStyle='v02';style.textContent=WORKBENCH_V02_CSS;document.head.append(style)
      editor=createWorkbenchEditor(api);shell=createWorkbenchShell({React,ctx,api,tag});offPrefs=pc.subscribe(next=>{prefs=next;audio.configure(next);attachLayout();syncTheme();notify()});attachLayout()
      const gesture=()=>audio.unlock(),visible=()=>document.hidden?audio.stop():audio.musicSync();document.addEventListener('pointerdown',gesture,true);document.addEventListener('keydown',gesture,true);document.addEventListener('visibilitychange',visible);document.addEventListener('click',onClick,true);document.addEventListener('keydown',onKey,true)
      observer=new MutationObserver(records=>{if(records.some(r=>r.target===document.body&&r.attributeName==='data-ds-dark-theme'))syncTheme();if(records.some(r=>r.attributeName==='class'?!!tagged.get(r.target)&&[...tagged.get(r.target)].some(c=>!r.target.classList.contains(c)):!(r.target instanceof Element)||!r.target.closest('[data-chat-flow],[data-composer-input],#lwb-dialog-root,[data-lwb-owned]')))schedule()});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-selected','aria-expanded','data-ds-dark-theme','class']})
      audio.configure(prefs);syncTheme();panelSync();void pc.load()
      return()=>{dead=true;offPrefs?.();offPanel?.();offWorkspaces?.();observer.disconnect();cancelAnimationFrame(frame);clearTimeout(areaTimer);areaAnimation?.cancel();document.removeEventListener('pointerdown',gesture,true);document.removeEventListener('keydown',gesture,true);document.removeEventListener('visibilitychange',visible);document.removeEventListener('click',onClick,true);document.removeEventListener('keydown',onKey,true);shell?.dispose();editor.dispose();untags();for(const attr of ['data-laurel-workbench','data-laurel-design','data-laurel-color','data-laurel-nav','data-laurel-motion'])root().removeAttribute(attr);style.remove();audio.dispose();pc.stop();subscribers.clear()}
    }
  };return api
}

function workbenchMarkerFace(marker){
  const m=marker||{},type=['letter','emoji','image'].includes(m.type)?m.type:'letter',color=/^#[0-9a-f]{6}$/i.test(m.color||'')?m.color:'#b9d6b5';const el=document.createElement('span');el.className='lwb-marker-face';el.dataset.type=type;el.style.setProperty('--marker-color',color)
  const rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);el.style.setProperty('--marker-ink',rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>.31?'#15251b':'#f5f7ee')
  if(type==='image'&&/^data:image\/(webp|png|jpeg);base64,/.test(m.image||'')){const img=new Image();img.src=m.image;img.alt='';el.append(img)}else{const text=document.createElement('span');text.className='lwb-marker-letter';text.textContent=m.text||'◇';el.append(text)}return el
}

function createWorkbenchEditor(api){
  const host=document.createElement('div');host.id='lwb-dialog-root';host.innerHTML=WORKBENCH_DIALOGS.replace('设置只保存到本地 HTML 预览，不修改正在运行的 DSH。','外观设置保存在本机当前配置中。');document.body.append(host)
  const $=s=>host.querySelector(s),$$=s=>[...host.querySelectorAll(s)],clone=o=>JSON.parse(JSON.stringify(o)),face=workbenchMarkerFace,sound=key=>void api.audio.play(key)
  let state={workspaces:[]},draft=null,crop=null,drawFrame=0,loadToken=0,toastTimer,busy=false
  const hint=document.createElement('div');hint.className='lwb-toast';hint.hidden=true;hint.setAttribute('role','status');host.append(hint)
  function toast(text){hint.textContent=text;hint.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>hint.hidden=true,3200)}
  const workspace=id=>state.workspaces.find(w=>w.id===id)
  function render(){api.schedule();const select=$('#workspace-customize-select'),id=select.value;state.workspaces=api.workspaces();select.replaceChildren(...state.workspaces.map(w=>new Option(w.name,w.id)));if(state.workspaces.some(w=>w.id===id))select.value=id;$$('[data-nav-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.navMode===api.getSnapshot().navMode)));$('#inspector-option').closest('.lwb-appearance-section').hidden=true}
  async function save(next){const markers={...api.getSnapshot().workspaceMarkers};for(const w of next.workspaces)markers[w.id]=w.marker;await api.pc.update({workspaceMarkers:markers});const result=api.getSnapshot();if(result.error||!result.saved){toast('工作区标记没有保存成功，请重试。');return false}return true}
   const segmenter=new Intl.Segmenter('zh',{granularity:'grapheme'});
 const graphemes=s=>[...segmenter.segment(s.trim())].map(x=>x.segment);
 function disposeCrop(){loadToken++;if(crop?.url)URL.revokeObjectURL(crop.url);crop=null;cancelAnimationFrame(drawFrame);drawFrame=0;$('#marker-file').value=''}
 function cropMetrics(size){const scale=Math.max(size/crop.image.naturalWidth,size/crop.image.naturalHeight)*crop.zoom,w=crop.image.naturalWidth*scale,h=crop.image.naturalHeight*scale;return {w,h,x:(size-w)/2+crop.x*(w-size)/2,y:(size-h)/2+crop.y*(h-size)/2}}
 function paintCrop(canvas){const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);if(!crop)return;const {w,h,x,y}=cropMetrics(canvas.width);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(crop.image,x,y,w,h)}
 function updatePreview(){if(!draft)return;const m={...draft.marker,text:$('#marker-text').value,color:$('#marker-color').value};const preview=$('#marker-live-preview');preview.replaceChildren();const el=face(m);if(m.type==='image'&&crop){el.replaceChildren();const c=document.createElement('canvas');c.width=c.height=176;c.style.cssText='width:100%;height:100%;display:block';paintCrop(c);el.append(c)}preview.append(el)}
 function draw(){drawFrame=0;if(!crop)return;paintCrop($('#crop-canvas'));$('#crop-zoom').value=String(Math.round(crop.zoom*100));$('#crop-zoom-value').textContent=Math.round(crop.zoom*100)+'%';$('#crop-x').value=String(Math.round(crop.x*100));$('#crop-y').value=String(Math.round(crop.y*100));updatePreview()}
 function scheduleDraw(){if(!drawFrame)drawFrame=requestAnimationFrame(draw)}
 function setMarkerType(type){if(!draft)return;draft.marker.type=type;$$('[data-marker-type]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.markerType===type)));$('#marker-text-controls').hidden=type==='image';$('#marker-image-controls').hidden=type!=='image';$('#crop-section').hidden=type!=='image'||!crop;$('#marker-text-label').textContent=type==='emoji'?'输入一个 Emoji':'输入一个字';$('#marker-text-hint').textContent=type==='emoji'?'支持组合 Emoji，如 👩‍💻。':'输入一个字、数字或字母，以粗笔画和角标显示。';$('#marker-error').textContent='';updatePreview()}
 async function loadImage(src,url=null){const token=++loadToken;try{const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=src});if(token!==loadToken){if(url)URL.revokeObjectURL(url);return}if(!img.naturalWidth||!img.naturalHeight)throw Error();if(crop?.url)URL.revokeObjectURL(crop.url);crop={image:img,url,zoom:1,x:0,y:0};$('#crop-source-info').textContent=img.naturalWidth+' × '+img.naturalHeight+' · 本地裁剪';$('#crop-section').hidden=draft?.marker.type!=='image';draw()}catch{if(url)URL.revokeObjectURL(url);if(token===loadToken)$('#marker-error').textContent='无法解码这张图片，请选择 PNG、JPEG、WebP 等浏览器支持的图片。'}}
 function openMarker(id){const w=workspace(id);if(!w)return;disposeCrop();draft={id,marker:clone(w.marker||{type:'letter',text:'桂',color:'#b9d6b5'})};$('#marker-workspace-label').textContent=w.name;$('#marker-text').value=draft.marker.text||'桂';$('#marker-color').value=/^#[0-9a-f]{6}$/i.test(draft.marker.color||'')?draft.marker.color:'#b9d6b5';setMarkerType(draft.marker.type);$('#marker-editor').showModal();sound('pageOpen');if(draft.marker.type==='image'&&draft.marker.image)loadImage(draft.marker.image)}
 async function applyMarker(){if(!draft)return;const m={type:draft.marker.type,color:$('#marker-color').value};if(m.type==='image'){if(!crop){$('#marker-error').textContent='请先选择要裁剪的图片。';return}const output=document.createElement('canvas');output.width=output.height=256;paintCrop(output);m.image=output.toDataURL('image/webp',.9);m.text=''}else{const segments=graphemes($('#marker-text').value);if(segments.length!==1){$('#marker-error').textContent=m.type==='emoji'?'请输入一个完整 Emoji 或符号。':'请输入一个字、数字或字母。';$('#marker-text').focus();return}if(m.type==='letter'&&/\p{Extended_Pictographic}/u.test(segments[0])){$('#marker-error').textContent='这是 Emoji，请切换到 Emoji 类型。';return}m.text=segments[0]}
  const next=clone(state);next.workspaces.find(w=>w.id===draft.id).marker=m;if(await save(next)){render();$('#marker-editor').close();toast('工作区标记已保存。');sound('confirm')}else $('#marker-error').textContent='未能保存，请重试；当前预览尚未写入宿主。';
 }
 $('#marker-editor').addEventListener('close',()=>{if(!$('#marker-editor').open){disposeCrop();draft=null}});
 $('#marker-file').addEventListener('change',e=>{const file=e.target.files?.[0];if(!file)return;if(!/^image\/(png|jpeg|webp|avif|gif|bmp)$/.test(file.type)){$('#marker-error').textContent='请选择支持的位图格式。';return}$('#marker-error').textContent='';const url=URL.createObjectURL(file);loadImage(url,url)});
 for(const id of ['marker-text','marker-color'])$('#'+id).addEventListener('input',()=>{$('#marker-error').textContent='';updatePreview()});
 for(const [id,prop,divisor] of [['crop-zoom','zoom',100],['crop-x','x',100],['crop-y','y',100]])$('#'+id).addEventListener('input',e=>{if(crop){crop[prop]=Number(e.target.value)/divisor;scheduleDraw()}});
 const canvas=$('#crop-canvas');let drag=null;
 canvas.addEventListener('pointerdown',e=>{if(!crop||e.button!==0)return;canvas.focus();canvas.setPointerCapture(e.pointerId);drag={id:e.pointerId,x:e.clientX,y:e.clientY,panX:crop.x,panY:crop.y};e.preventDefault()});
 canvas.addEventListener('pointermove',e=>{if(!crop||!drag||e.pointerId!==drag.id)return;const size=canvas.getBoundingClientRect().width,{w,h}=cropMetrics(size);crop.x=w>size?Math.max(-1,Math.min(1,drag.panX+2*(e.clientX-drag.x)/(w-size))):0;crop.y=h>size?Math.max(-1,Math.min(1,drag.panY+2*(e.clientY-drag.y)/(h-size))):0;scheduleDraw()});
 for(const evt of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(evt,()=>drag=null);
 canvas.addEventListener('wheel',e=>{if(!crop)return;e.preventDefault();crop.zoom=Math.max(1,Math.min(4,crop.zoom-e.deltaY*.002));scheduleDraw()},{passive:false});
 canvas.addEventListener('keydown',e=>{if(!crop)return;const step=e.shiftKey?.15:.03;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();if(e.key==='ArrowLeft')crop.x-=step;if(e.key==='ArrowRight')crop.x+=step;if(e.key==='ArrowUp')crop.y-=step;if(e.key==='ArrowDown')crop.y+=step;crop.x=Math.max(-1,Math.min(1,crop.x));crop.y=Math.max(-1,Math.min(1,crop.y));scheduleDraw()}});

  function openAppearance(){render();$('#workspace-appearance').showModal();sound('pageOpen')}
  function close(){for(const d of $$('dialog[open]'))d.close()}
  const native=document.createElement('button');native.className='lwb-plain-button';native.type='button';native.textContent='宿主分组、排序与归档选项';native.onclick=()=>api.nativeViewOptions();$('#workspace-appearance').append(native)
  host.addEventListener('click',async e=>{if(!(e.target instanceof Element))return;
    const mode=e.target.closest('button[data-nav-mode]');if(mode){await api.pc.update({navMode:mode.dataset.navMode});render();sound('select');return}
    const type=e.target.closest('[data-marker-type]');if(type){setMarkerType(type.dataset.markerType);sound('select');return}
    const color=e.target.closest('[data-marker-color]');if(color){$('#marker-color').value=color.dataset.markerColor;updatePreview();sound('select');return}
    const closeButton=e.target.closest('[data-close]');if(closeButton){closeButton.closest('dialog').close();sound('pageClose');return}
    const action=e.target.closest('[data-shell-action]')?.dataset.shellAction;
    if(action==='edit-selected-marker')openMarker($('#workspace-customize-select').value)
    if(action==='choose-marker-image')$('#marker-file').click()
    if(action==='crop-reset'&&crop){crop.zoom=1;crop.x=crop.y=0;draw()}
    if(action==='marker-cancel'){$('#marker-editor').close();sound('pageClose')}
    if(action==='marker-apply'&&!busy){busy=true;e.target.closest('button').disabled=true;try{await applyMarker()}finally{busy=false;$('#marker-editor [data-shell-action=marker-apply]').disabled=false}}
  })
  for(const d of $$('dialog'))d.addEventListener('click',e=>{if(e.target!==d)return;const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()})
  return {toast,openAppearance,openMarker(id){render();openMarker(id)},close,dispose(){close();disposeCrop();clearTimeout(toastTimer);host.remove()}}
}

/** Structural presentation mirrors the accepted shell; every action delegates to its native owner. */
function createWorkbenchShell({React,ctx,api,tag}){
  let offName,offMark,more,moreButton,themeDialog,topMore,bypassTop=false,bypass=false,dead=false
  const added=new Set(),hidden=new Set(),h=React.createElement
  const own=el=>{el.dataset.lwbOwned='shell';added.add(el);return el}
  const family=()=>api.getSnapshot().theme.startsWith('wuling')?'WULING':'AIC'
  function Brand(){const p=React.useSyncExternalStore(api.pc.subscribe,api.pc.getSnapshot);return h('span',{className:'lwb-brand-copy'},h('b',{className:'lwb-dsh-wordmark'},'deepseek ',h('em',null,'HARNESS')),h('small',null,(p.theme.startsWith('wuling')?'WULING':'AIC')+' / Laurel 工作台'))}
  function Mark(){return h('span',{className:'lwb-mark','aria-hidden':true},'DS')}
  function clear(){themeDialog?.remove();themeDialog=null;offName?.();offMark?.();offName=offMark=null;more?.remove();more=null;for(const e of added)e.remove();added.clear();for(const e of hidden)e.classList.remove('lwb-nav-overflow');hidden.clear();if(moreButton)moreButton.classList.remove('lwb-overflow-active');moreButton=null}
  function sync(){if(dead)return;if(!api.isV02()){clear();return}if(!offName&&typeof ctx.slots?.inject==='function'){
    offName=ctx.slots.inject('sidebar.brand.name',()=>ctx.slots.register({name:'sidebar.brand.name',priority:-20},Brand))
    offMark=ctx.slots.inject('sidebar.brand.mark',()=>ctx.slots.register({name:'sidebar.brand.mark',priority:-20},Mark))
  }}
  function label(el){return el.getAttribute('aria-label')||el.textContent.trim()}
  function items(){const side=document.querySelector('.lwb-sidebar');if(!side)return[];return [...hidden].filter(b=>b.isConnected)}
  function openMore(){
    more?.remove();more=own(document.createElement('dialog'));more.className='lwb-native-more lwb-simple-dialog';more.setAttribute('aria-label','更多面板与功能')
    const head=document.createElement('div');head.className='lwb-dialog-header';const title=document.createElement('b');title.textContent='更多面板与功能';const close=document.createElement('button');close.type='button';close.className='lwb-icon-button';close.textContent='×';close.setAttribute('aria-label','关闭更多面板');close.onclick=()=>more.close();head.append(title,close);more.append(head)
    for(const original of items()){const b=document.createElement('button');b.type='button';b.className='lwb-more-entry';b.textContent=label(original);b.onclick=()=>{more.close();original.click()};more.append(b)}
    if(moreButton){const b=document.createElement('button');b.type='button';b.className='lwb-more-entry';b.textContent='宿主更多选项';b.onclick=()=>{more.close();bypass=true;moreButton.click()};more.append(b)}
    document.body.append(more);more.showModal()
  }
  function openTheme(){
    themeDialog?.remove();const temp=document.createElement('template');temp.innerHTML=WORKBENCH_THEME_DIALOG;themeDialog=own(temp.content.firstElementChild)
    themeDialog.querySelector('[data-close]').onclick=()=>themeDialog.close()
    themeDialog.querySelectorAll('.lwb-theme-option').forEach((el,i)=>{el.href='#';el.onclick=e=>{e.preventDefault();void api.pc.update({theme:i===0?'endfield-v02':'wuling-v02'});themeDialog.close()}})
    themeDialog.querySelector('[data-action=dark]').onclick=()=>{const p=api.getSnapshot();void api.pc.update({colorMode:document.documentElement.dataset.laurelColor==='dark'?'light':'dark'})}
    themeDialog.querySelector('[data-shell-action=appearance]').onclick=()=>{themeDialog.close();api.openAppearance()}
    themeDialog.querySelector('.lwb-compare-link')?.remove()
    if(topMore){const b=document.createElement('button');b.type='button';b.className='lwb-plain-button';b.textContent='宿主会话更多操作';b.onclick=()=>{themeDialog.close();bypassTop=true;topMore.click()};themeDialog.append(b)}
    const views=document.querySelector('.lwb-topbar [data-conversation-tabs]');if(views){const row=document.createElement('div');row.className='lwb-theme-legacy';const title=document.createElement('span');title.textContent='会话视图';row.append(title);for(const original of views.querySelectorAll('button')){const b=document.createElement('button');b.type='button';b.className='lwb-plain-button';b.textContent=label(original);b.setAttribute('aria-pressed',String(original.getAttribute('aria-selected')==='true'));b.onclick=()=>{themeDialog.close();original.click()};row.append(b)}themeDialog.append(row)}
    const old=document.createElement('div');old.className='lwb-theme-legacy';const label=document.createElement('span');label.textContent='V0.1 · 原客户端主题';old.append(label)
    for(const [theme,name]of [['endfield','集成工业 AIC'],['wuling','武陵城']]){const b=document.createElement('button');b.type='button';b.className='lwb-plain-button';b.textContent=name;b.onclick=()=>{themeDialog.close();void api.pc.update({theme})};old.append(b)}themeDialog.append(old)
    document.body.append(themeDialog);themeDialog.showModal()
  }
  function frame(){
    const content=document.querySelector('[data-conversation-content]');if(!content)return
    const root=content.closest('[data-phase]'),header=root?.querySelector('header');if(root)tag(root,'conversation-root')
    if(header){tag(header,'topbar');tag(header.querySelector('[class*=titleRow]'),'session-head');tag(header.querySelector('[class*=titleCluster]'),'native-title-cluster');tag(header.querySelector('[class*=headerActions]'),'native-header-actions');tag(header.querySelector('[class*=headerUtilities]'),'native-header-utilities');tag(header.querySelector('[data-conversation-header-corner]'),'top-actions');topMore=[...header.querySelectorAll('button')].find(b=>/^(更多操作|More actions)$/i.test(label(b)))}
    if(root&&!root.querySelector(':scope>.lwb-shell-status')){const bar=own(document.createElement('footer'));bar.className='lwb-statusbar lwb-shell-status';const ready=document.createElement('span');ready.className='lwb-status-ready';ready.textContent=family()==='WULING'?'画中工作台就绪':'集成工作台就绪';bar.append(ready)
      for(const [key,title]of [['motion','动效'],['sound','原声']]){const b=document.createElement('button');b.type='button';b.dataset.lwbPref=key;b.onclick=()=>void api.pc.update({[key]:!api.getSnapshot()[key]});bar.append(b)}const audio=document.createElement('button');audio.type='button';audio.textContent='音量设置';audio.onclick=()=>api.openAudioSettings();bar.append(audio);root.append(bar)}
    if(root){const ready=root.querySelector('.lwb-status-ready');if(ready)ready.textContent=family()==='WULING'?'画中工作台就绪':'集成工作台就绪';for(const b of root.querySelectorAll('[data-lwb-pref]')){const key=b.dataset.lwbPref,on=api.getSnapshot()[key];b.textContent=(key==='motion'?'动效':'原声')+'：'+(on?'开':'关');b.setAttribute('aria-pressed',String(on))}}
    const flow=content.querySelector('[data-chat-flow]');if(flow)tag(flow.parentElement,'chat-scroll-wrap');
    const card=content.querySelector('[data-composer-card]'),seat=content.querySelector('[data-composer-seat]')
    if(card){tag(card.parentElement,'input-root');tag(card.querySelector('[class$=_row]'),'composer-actions');tag(card.querySelector('[class$=_tools]'),'composer-tools');tag(card.querySelector('[class$=_trailing]'),'composer-trailing');if(card.nextElementSibling)tag(card.nextElementSibling,'input-dock')
      if(!card.querySelector(':scope>.lwb-composer-context')){const line=own(document.createElement('div'));line.className='lwb-composer-context';const name=document.createElement('span');name.className='lwb-context-workspace';line.append(name);card.prepend(line)}
      const name=card.querySelector('.lwb-context-workspace'),workspace=document.querySelector('.lwb-workspace-group[data-current=true] .lwb-workspace-title');if(name)name.textContent=api.activeWorkspace()?.title||workspace?.textContent||'选择工作区'
    }
    if(seat&&!seat.querySelector(':scope>.lwb-input-note')){const note=own(document.createElement('div'));note.className='lwb-input-note';note.textContent='Enter 发送 / Shift Enter 换行';seat.append(note)}
    if(root&&!content.querySelector(':scope>.lwb-conversation-label')){const line=own(document.createElement('div'));line.className='lwb-conversation-label';const flag=document.createElement('span');flag.className='lwb-section-flag';flag.textContent=family()==='WULING'?'武陵 · 画中工作台':'AIC · 集成工作台';const title=document.createElement('span');title.textContent='会话记录';line.append(flag,title);content.prepend(line)}
    const flag=content.querySelector(':scope>.lwb-conversation-label .lwb-section-flag');if(flag)flag.textContent=family()==='WULING'?'武陵 · 画中工作台':'AIC · 集成工作台'
  }
  function onClick(e){if(api.isV02()&&topMore?.contains(e.target)){if(bypassTop){bypassTop=false;return}e.preventDefault();e.stopPropagation();openTheme();return}if(!api.isV02()||!moreButton?.contains(e.target)||!items().length)return;if(bypass){bypass=false;return}e.preventDefault();e.stopPropagation();openMore()}
  document.addEventListener('click',onClick,true)
  function project(){
    if(dead||!api.isV02())return
    for(const e of added)if(!e.isConnected)added.delete(e);for(const e of hidden)if(!e.isConnected)hidden.delete(e)
    frame();const side=document.querySelector('.lwb-sidebar'),nav=side?.querySelector('.lwb-primary-nav');if(!side||!nav)return
    const buttons=[...nav.querySelectorAll('button')];buttons.forEach(b=>tag(b,'nav-item'));moreButton=buttons.find(b=>/^(更多|More)$/i.test(label(b)))
    if(moreButton){tag(moreButton.parentElement,'more-anchor');for(const b of buttons){const keep=/^(插件|Plugins|Laurel\s*控制中心|自动化任务|Automations|更多|More)$/i.test(label(b));b.classList.toggle('lwb-nav-overflow',!keep);if(!keep)hidden.add(b)}}
    if(moreButton)moreButton.classList.toggle('lwb-overflow-active',[...hidden].some(b=>b.getAttribute('aria-current')==='page'));
    const foot=side.querySelector('.lwb-sidebar-bottom');if(foot){
      if(!foot.querySelector(':scope>.lwb-shell-appearance')){const b=own(document.createElement('button'));b.type='button';b.className='lwb-nav-item lwb-shell-appearance';b.setAttribute('aria-label','外观设置');b.innerHTML='<span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 3h6l1 4 4 2v6l-4 2-1 4H9l-1-4-4-2V9l4-2Z"/><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0"/></svg></span><span>外观设置</span><span aria-hidden="true">↗</span>';b.onclick=()=>api.openTheme();foot.prepend(b)}
      if(moreButton)for(const b of foot.querySelectorAll('button')){if(b.classList.contains('lwb-shell-appearance')||/账号菜单|账户|Account/i.test(label(b)))continue;b.classList.add('lwb-nav-overflow');hidden.add(b)}
    }
  }
  return{sync,project,openTheme,dispose(){dead=true;document.removeEventListener('click',onClick,true);clear()}}
}
