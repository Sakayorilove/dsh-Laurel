/** One settings surface: modal for focus, non-modal for adjusting the real host. */
export function createSettingsWindow(sheet, state, onClose) {
  const head=sheet.querySelector('.lx-header'),toggle=sheet.querySelector('[data-lx-window-toggle]'),reset=sheet.querySelector('[data-lx-window-reset]')
  let internalCloses=0,gesture,disposed=false
  const grips=[]
  const limits=()=>({width:Math.max(1,innerWidth-16),height:Math.max(1,innerHeight-16)})
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n))
  function fit(rect){
    const max=limits(),width=clamp(rect.width,Math.min(340,max.width),max.width),height=clamp(rect.height,Math.min(280,max.height),max.height)
    return {left:clamp(rect.left,8,Math.max(8,innerWidth-width-8)),top:clamp(rect.top,8,Math.max(8,innerHeight-height-8)),width,height}
  }
  function place(rect){
    const r=fit(rect);state.rect=r
    for(const [k,v]of Object.entries(r))sheet.style[k]=v+'px'
  }
  function defaults(){const max=limits();return {width:Math.min(440,max.width),height:Math.min(740,max.height),left:innerWidth-Math.min(440,max.width)-20,top:Math.min(64,Math.max(8,(innerHeight-Math.min(740,max.height))/2))}}
  function paint(){
    sheet.dataset.floating=String(state.floating)
    sheet.setAttribute('aria-modal',String(!state.floating))
    toggle.textContent=state.floating?'居中显示':'悬浮调整';toggle.setAttribute('aria-pressed',String(state.floating))
    toggle.title=state.floating?'返回居中设置窗口':'移开设置窗口，直接预览 DSH；拖动标题栏、拉伸边缘调整窗口'
    reset.hidden=!state.floating;head.tabIndex=state.floating?0:-1
    head.setAttribute('aria-label',state.floating?'Laurel 设置标题栏，拖动或用方向键移动':'Laurel 设置')
    if(state.floating)place(state.rect||defaults());else for(const k of ['left','top','width','height'])sheet.style.removeProperty(k)
  }
  function finish(){gesture=undefined;delete sheet.dataset.manipulating}
  function setFloating(value){
    if(disposed||value===state.floating)return
    finish();const focus=sheet.contains(document.activeElement)?document.activeElement:null
    internalCloses++;sheet.close();state.floating=value;paint()
    if(value)sheet.show();else sheet.showModal()
    focus?.focus({preventScroll:true})
  }
  const closed=()=>{if(internalCloses){internalCloses--;return}dispose();onClose()}
  function down(e){
    if(!state.floating||e.button!==0)return
    const edge=e.target.closest('[data-lx-resize]')?.dataset.lxResize
    if(!edge&&(!head.contains(e.target)||e.target.closest('button,input,select,a')))return
    const r=sheet.getBoundingClientRect();gesture={id:e.pointerId,x:e.clientX,y:e.clientY,edge,rect:{left:r.left,top:r.top,width:r.width,height:r.height}}
    sheet.setPointerCapture(e.pointerId);sheet.dataset.manipulating='true';e.preventDefault()
  }
  function move(e){
    if(!gesture||gesture.id!==e.pointerId)return
    const {x,y,edge,rect:r}=gesture,dx=e.clientX-x,dy=e.clientY-y,next={...r},max=limits()
    if(!edge){next.left+=dx;next.top+=dy}
    else {
      if(edge.includes('e'))next.width=clamp(r.width+dx,Math.min(340,max.width),innerWidth-r.left-8)
      if(edge.includes('s'))next.height=clamp(r.height+dy,Math.min(280,max.height),innerHeight-r.top-8)
      if(edge.includes('w')){next.width=clamp(r.width-dx,Math.min(340,max.width),r.left+r.width-8);next.left=r.left+r.width-next.width}
      if(edge.includes('n')){next.height=clamp(r.height-dy,Math.min(280,max.height),r.top+r.height-8);next.top=r.top+r.height-next.height}
    }
    place(next)
  }
  function key(e){
    if(!state.floating)return
    if(e.key==='Escape'){e.preventDefault();sheet.close();return}
    const resize=e.target.dataset.lxResize==='se'
    if((e.target!==head&&!resize)||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return
    e.preventDefault();const r={...state.rect},n=e.shiftKey?24:8,horizontal=['ArrowLeft','ArrowRight'].includes(e.key),delta=['ArrowLeft','ArrowUp'].includes(e.key)?-n:n
    r[resize?(horizontal?'width':'height'):(horizontal?'left':'top')]+=delta;place(r)
  }
  function resize(){if(state.floating)place(state.rect||defaults())}
  const click=e=>{if(e.target.closest('[data-lx-window-toggle]'))setFloating(!state.floating);if(e.target.closest('[data-lx-window-reset]'))place(defaults())}
  for(const edge of ['n','e','s','w','ne','nw','se','sw']){
    const grip=document.createElement('span');grip.dataset.lxResize=edge;grip.className='lx-resize-grip'
    if(edge==='se'){grip.tabIndex=0;grip.setAttribute('role','button');grip.setAttribute('aria-label','调整悬浮窗大小，使用方向键')}else grip.setAttribute('aria-hidden','true')
    sheet.append(grip);grips.push(grip)
  }
  sheet.addEventListener('click',click);sheet.addEventListener('pointerdown',down);sheet.addEventListener('pointermove',move)
  sheet.addEventListener('pointerup',finish);sheet.addEventListener('pointercancel',finish);sheet.addEventListener('lostpointercapture',finish)
  sheet.addEventListener('keydown',key);sheet.addEventListener('close',closed);window.addEventListener('resize',resize)
  function dispose(){
    if(disposed)return;disposed=true;finish();window.removeEventListener('resize',resize)
    sheet.removeEventListener('click',click);sheet.removeEventListener('pointerdown',down);sheet.removeEventListener('pointermove',move)
    sheet.removeEventListener('pointerup',finish);sheet.removeEventListener('pointercancel',finish);sheet.removeEventListener('lostpointercapture',finish)
    sheet.removeEventListener('keydown',key);sheet.removeEventListener('close',closed);grips.forEach(g=>g.remove())
  }
  paint()
  return {show(){if(state.floating)sheet.show();else sheet.showModal()},dispose}
}
