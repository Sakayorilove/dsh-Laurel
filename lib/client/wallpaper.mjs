/** Wallpaper lives below content; blur/opacity never touch text or controls. */
export function createLaurelWallpaper({ getPreferences, update, feedback }) {
  const layers=new Map(), sized=new ResizeObserver(()=>paint())
  let last, closed=false, upload=0
  const edgeShadows=new Map(), shadowTargets=new Set()
  const shadowSize=new ResizeObserver(()=>paint())
  const names={global:'全局壁纸',sidebar:'侧边栏壁纸',conversation:'会话区壁纸'}
  const field=(slot,title)=>`<fieldset data-lx-wallpaper-slot="${slot}"><legend>${title}</legend><div class="lx-wallpaper-preview" data-lx-wallpaper-preview="${slot}" aria-hidden="true"></div><p data-lx-wallpaper-name="${slot}">尚未选择图片</p><div class="lx-actions"><label class="lx-file-button">选择本机图片<input type="file" accept="image/png,image/jpeg,image/webp" data-lx-wallpaper-file="${slot}"></label><button type="button" data-lx-wallpaper-clear="${slot}">清除图片</button></div><label>铺放方式<select data-lx-wallpaper-fit="${slot}" aria-label="${title}铺放方式"><option value="cover">等比铺满（裁切边缘）</option><option value="fill">拉伸铺满</option><option value="contain">完整显示（模糊延展）</option><option value="tile">原图平铺</option></select></label>${[['blur','模糊',40,'px'],['opacity','图片不透明度',100,'%']].map(([key,label,max,unit])=>`<label>${label}<input type="range" min="0" max="${max}" step="1" data-lx-wallpaper-range="${slot}" data-lx-wallpaper-key="${key}" aria-label="${title}${label}"><output data-unit="${unit}"></output></label>`).join('')}</fieldset>`
  const html=()=>`<section data-lx-page="wallpaper"><h3 tabindex="-1">壁纸与阴影</h3><p>点击标题栏「悬浮调整」，拖动标题、拉伸窗口边缘，直接在 DSH 上实时调整。所有铺放方式均覆盖整个区域；完整显示用同图模糊延展补齐边缘。</p><p>图片仅保存在当前 profile 的本机 Laurel 目录。支持 PNG、JPEG、WebP；导入时优化为 WebP。模糊只作用于图片，文字与按钮保持清晰。</p><fieldset><legend>壁纸模式</legend><label>启用壁纸<input type="checkbox" id="lx-wallpaper-enabled"></label><label>设置方式<select id="lx-wallpaper-mode"><option value="global">全局 · 共用一张连续壁纸</option><option value="separate">分开 · 侧栏和会话独立设置</option></select></label><p>两种模式分别保留图片、模糊与不透明度；100% 完整显示图片，0% 隐藏图片。高对比图片建议降低不透明度。</p></fieldset>${field('global','全局壁纸')}${field('sidebar','侧边栏壁纸')}${field('conversation','会话区壁纸')}<fieldset><legend>界面阴影</legend><p>分别调整截图中的侧栏边缘、会话顶栏下沿和输入框。强度 0% 关闭阴影；距离控制阴影向外延伸的范围。</p>${[['sidebar','侧栏右边缘'],['header','会话顶栏下沿'],['composer','消息输入框']].map(([slot,label])=>`<div class="lx-shadow-row"><strong>${label}</strong>${slot==='sidebar'?'<label>阴影方向<select id="lx-shadow-sidebar-direction" aria-label="侧栏阴影方向"><option value="left">向左 · 当前效果</option><option value="right">向右 · 会话一侧</option></select></label>':''}${[['strength','阴影强度',60,'%'],['distance','阴影距离',32,'px']].map(([key,text,max,unit])=>`<label>${text}<input type="range" min="0" max="${max}" data-lx-shadow-range="${slot}" data-lx-shadow-key="${key}" aria-label="${label}${text}"><output data-unit="${unit}"></output></label>`).join('')}</div>`).join('')}<button type="button" id="lx-shadows-reset">关闭全部阴影</button></fieldset></section>`
  function style(node,key,value){if(node.style.getPropertyValue(key)!==value)node.style.setProperty(key,value)}
  // An oversized inset is clipped to a single edge. Other three box edges sit
  // outside the clip, retaining the accepted falloff without rectangular halos.
  function edgeShadow(target,kind,edge,v,active,observed) {
    if(!target||!v.strength)return
    observed.add(target)
    const r=target.getBoundingClientRect(),d=v.distance,blur=Math.max(2,d*1.5),reach=Math.ceil(d/2+blur*2+2)
    if(r.width<=1||r.height<=0)return
    const horizontal=edge==='down',left=horizontal?Math.max(0,r.left):edge==='left'?Math.max(r.left,r.right-reach):r.right
    const top=horizontal?r.bottom:Math.max(0,r.top)
    const width=horizontal?Math.min(innerWidth,r.right)-left:edge==='left'?r.right-left:Math.min(reach,innerWidth-left)
    const owner=horizontal?target.closest('.lx-conversation')?.getBoundingClientRect():null
    const height=horizontal?Math.min(reach,innerHeight-top,(owner?.bottom??innerHeight)-top):Math.min(innerHeight,r.bottom)-top
    if(left<0||top<0||width<=0||height<=0)return
    let layer=edgeShadows.get(target)
    if(!layer){layer=document.createElement('div');layer.className='lx-edge-shadow lx-'+kind+'-shadow';layer.setAttribute('aria-hidden','true');layer.inert=true;const ink=document.createElement('div');ink.className='lx-edge-shadow-ink';layer.append(ink);document.body.append(layer);edgeShadows.set(target,layer)}
    active.add(target);layer.dataset.edge=edge
    for(const [key,value]of Object.entries({left:left+'px',top:top+'px',width:width+'px',height:height+'px'}))style(layer,key,value)
    const far=-reach*2+'px',inset=horizontal?`0px ${far} ${far} ${far}`:edge==='left'?`${far} 0px ${far} ${far}`:`${far} ${far} ${far} 0px`
    style(layer.firstElementChild,'inset',inset)
    const x=edge==='left'?-d:edge==='right'?d:0,y=horizontal?d:0
    style(layer.firstElementChild,'box-shadow',`inset ${x}px ${y}px ${blur}px ${-d/2}px rgb(0 0 0 / ${v.strength/100})`)
  }
  function paint(value=last||getPreferences()) {
    if(closed)return
    last=value
    const w=normalizeWallpaper(value.wallpaper),sh=normalizeShadows(value.shadows),root=document.documentElement
    for(const [key,v] of Object.entries(sh)){
      const d=v.distance,blur=Math.max(2,d*1.5)
      style(root,'--lx-shadow-'+key,key==='composer'&&v.strength?`0 ${d}px ${blur}px rgb(0 0 0 / ${v.strength/100})`:'none')
    }
    for(const [el,layer] of layers)if(!el.isConnected){sized.unobserve(el);layer.remove();layers.delete(el)}
    const side=document.querySelector('.lx-sidebar-column')||document.querySelector('.lx-sidebar')
    const active=new Set(),observed=new Set()
    edgeShadow(side,'sidebar',sh.sidebar.direction,sh.sidebar,active,observed)
    for(const header of document.querySelectorAll('.lx-conversation-header'))edgeShadow(header,'header','down',sh.header,active,observed)
    for(const [target,layer]of edgeShadows)if(!active.has(target)){layer.remove();edgeShadows.delete(target)}
    for(const target of shadowTargets)if(!observed.has(target)){shadowSize.unobserve(target);shadowTargets.delete(target)}
    for(const target of observed)if(!shadowTargets.has(target)){shadowTargets.add(target);shadowSize.observe(target)}
    const targets=[...(side?[side]:[]),...document.querySelectorAll('.lx-conversation')]
    for(const el of targets){
      const slot=el===side?'sidebar':'conversation',settings=w[w.mode==='global'?'global':slot]
      let layer=layers.get(el)
      if(layer&&layer.parentElement!==el){layer.remove();layers.delete(el);sized.unobserve(el);layer=null}
      if(!w.enabled||!settings.image){if(layer){layer.remove();layers.delete(el);sized.unobserve(el)}el.classList.remove('lx-wallpaper-surface');continue}
      if(!layer){layer=document.createElement('div');layer.className='lx-wallpaper-layer';layer.setAttribute('aria-hidden','true');layer.inert=true;const img=document.createElement('img');img.alt='';img.draggable=false;img.onerror=()=>{layer.hidden=true};img.onload=()=>{layer.hidden=false};layer.append(img);el.prepend(layer);layers.set(el,layer);sized.observe(el)}
      el.classList.add('lx-wallpaper-surface')
      const img=layer.firstElementChild,url='/api/laurel-center/wallpapers/'+settings.image
      if(img.getAttribute('src')!==url)img.src=url
      const r=el.getBoundingClientRect(),margin=settings.blur*3
      img.style.objectFit=settings.fit==='fill'?'fill':settings.fit==='contain'?'contain':'cover'
      img.hidden=settings.fit==='tile'
      let extra=layer.querySelector('.lx-wallpaper-extra')
      if(['contain','tile'].includes(settings.fit)){
        if(!extra){extra=document.createElement('div');extra.className='lx-wallpaper-extra';layer.append(extra)}
        extra.style.backgroundImage=`url("${url}")`;extra.style.backgroundPosition='center';extra.style.backgroundRepeat=settings.fit==='tile'?'repeat':'no-repeat';extra.style.backgroundSize=settings.fit==='tile'?'auto':'cover'
        extra.style.filter=`blur(${settings.fit==='contain'?Math.max(20,settings.blur):settings.blur}px)`;extra.style.opacity=String(settings.opacity/100)
        const m=settings.fit==='contain'?Math.max(20,settings.blur)*3:margin
        extra.style.width=(w.mode==='global'?innerWidth+m*2:r.width+m*2)+'px';extra.style.height=(w.mode==='global'?innerHeight+m*2:r.height+m*2)+'px'
        extra.style.left=(-(w.mode==='global'?r.left:0)-m)+'px';extra.style.top=(-(w.mode==='global'?r.top:0)-m)+'px'
      }else extra?.remove()
      style(img,'opacity',String(settings.opacity/100));style(img,'filter',`blur(${settings.blur}px)`)
      style(img,'width',(w.mode==='global'?innerWidth+margin*2:r.width+margin*2)+'px');style(img,'height',(w.mode==='global'?innerHeight+margin*2:r.height+margin*2)+'px')
      style(img,'left',(-(w.mode==='global'?r.left:0)-margin)+'px');style(img,'top',(-(w.mode==='global'?r.top:0)-margin)+'px')
    }
    root.dataset.lxWallpaper=w.enabled?'on':'off'
  }
  function render(sheet){
    const p=getPreferences(),w=normalizeWallpaper(p.wallpaper),s=normalizeShadows(p.shadows)
    sheet.querySelector('#lx-shadow-sidebar-direction').value=s.sidebar.direction
    sheet.querySelector('#lx-wallpaper-enabled').checked=w.enabled
    sheet.querySelector('#lx-wallpaper-mode').value=w.mode
    for(const slot of Object.keys(names)){
      sheet.querySelector(`[data-lx-wallpaper-fit="${slot}"]`).value=w[slot].fit
      sheet.querySelector(`[data-lx-wallpaper-slot="${slot}"]`).hidden=w.mode==='global'?slot!=='global':slot==='global'
      const img=sheet.querySelector(`[data-lx-wallpaper-preview="${slot}"]`)
      img.style.backgroundImage=w[slot].image?`url("/api/laurel-center/wallpapers/${w[slot].image}")`:'none'
      sheet.querySelector(`[data-lx-wallpaper-name="${slot}"]`).textContent=w[slot].image?'已保存在本机 · '+w[slot].image.slice(0,12):'尚未选择图片'
      sheet.querySelector(`[data-lx-wallpaper-clear="${slot}"]`).disabled=!w[slot].image
    }
    for(const el of sheet.querySelectorAll('[data-lx-wallpaper-range],[data-lx-shadow-range]')){
      const slot=el.dataset.lxWallpaperRange||el.dataset.lxShadowRange,key=el.dataset.lxWallpaperKey||el.dataset.lxShadowKey,v=(el.dataset.lxWallpaperRange?w:s)[slot][key]
      if(el!==document.activeElement)el.value=v
      el.parentElement.querySelector('output').textContent=el.value+el.parentElement.querySelector('output').dataset.unit
    }
  }
  function patchRange(el){const p=getPreferences();if(el.dataset.lxWallpaperRange){const w=normalizeWallpaper(p.wallpaper);w[el.dataset.lxWallpaperRange][el.dataset.lxWallpaperKey]=+el.value;return {wallpaper:w}}if(el.dataset.lxShadowRange){const s=normalizeShadows(p.shadows);s[el.dataset.lxShadowRange][el.dataset.lxShadowKey]=+el.value;return {shadows:s}}return null}
  async function importFile(file,slot,sheet){
    if(!file)return
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>30*1024*1024)throw Error('请选择 30 MB 以内的 PNG、JPEG 或 WebP 图片')
    const id=++upload;feedback('正在优化并保存本机图片…',false)
    const bitmap=await createImageBitmap(file)
    let blob
    try {
      if(bitmap.width*bitmap.height>80000000)throw Error('图片尺寸过大，请使用 8000 万像素以内的图片')
      const scale=Math.min(1,2560/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height)
      blob=await new Promise(r=>canvas.toBlob(r,'image/webp',.88))
      if(!blob||blob.type!=='image/webp'||blob.size>3*1024*1024)throw Error('图片优化后仍超过 3 MB，请换一张较小的图片')
    }finally{bitmap.close()}
    const response=await fetch('/api/laurel-center/wallpapers',{method:'POST',credentials:'same-origin',headers:{'x-laurel-ui':'1','content-type':'image/webp'},body:blob,signal:AbortSignal.timeout(15000)}),body=await response.json()
    if(!response.ok||!body.ok)throw Error(body.error||'图片未能保存')
    if(closed||id!==upload)return
    const w=normalizeWallpaper(getPreferences().wallpaper);w[slot].image=body.image;w.enabled=true;await update({wallpaper:w});if(sheet.isConnected)render(sheet)
  }
  function attach(sheet){
    sheet.addEventListener('input',e=>{const patch=patchRange(e.target);if(patch){paint({...getPreferences(),...patch});const out=e.target.parentElement.querySelector('output');out.textContent=e.target.value+out.dataset.unit}})
    sheet.addEventListener('change',e=>{
      const el=e.target;let patch=patchRange(el)
      if(el.id==='lx-wallpaper-mode'||el.id==='lx-wallpaper-enabled'){const w=normalizeWallpaper(getPreferences().wallpaper);if(el.id==='lx-wallpaper-mode')w.mode=el.value;else w.enabled=el.checked;patch={wallpaper:w}}
      if(el.id==='lx-shadow-sidebar-direction'){const s=normalizeShadows(getPreferences().shadows);s.sidebar.direction=el.value;patch={shadows:s}}
      if(el.dataset.lxWallpaperFit){const w=normalizeWallpaper(getPreferences().wallpaper);w[el.dataset.lxWallpaperFit].fit=el.value;patch={wallpaper:w}}
      if(el.dataset.lxWallpaperFile){const file=el.files?.[0];el.value='';void importFile(file,el.dataset.lxWallpaperFile,sheet).catch(e=>feedback('未能导入：'+e.message));return}
      if(patch)void update(patch).catch(e=>feedback('未能保存：'+e.message))
    })
    sheet.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;let patch;if(b.dataset.lxWallpaperClear){upload++;const w=normalizeWallpaper(getPreferences().wallpaper);w[b.dataset.lxWallpaperClear].image='';patch={wallpaper:w}}if(b.id==='lx-shadows-reset')patch={shadows:normalizeShadows()};if(patch)void update(patch).catch(e=>feedback('未能保存：'+e.message))})
    sheet.addEventListener('close',()=>paint(getPreferences()),{once:true})
  }
  const resize=()=>paint();window.addEventListener('resize',resize)
  return {html,attach,render,apply:paint,dispose(){closed=true;upload++;sized.disconnect();shadowSize.disconnect();shadowTargets.clear();for(const layer of edgeShadows.values())layer.remove();edgeShadows.clear();window.removeEventListener('resize',resize);for(const [el,layer]of layers){layer.remove();el.classList.remove('lx-wallpaper-surface')}layers.clear();delete document.documentElement.dataset.lxWallpaper;for(const key of ['sidebar','header','composer'])document.documentElement.style.removeProperty('--lx-shadow-'+key)}}
}
