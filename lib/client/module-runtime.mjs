// A single lifetime per Center: module clients also run while its panel is closed.
const managedRuntimes = new WeakMap()
// Registration survives a Center-only HMR replacement in the native loader.
const loadedManagedScripts = typeof window === 'undefined' ? new Map() : (window[Symbol.for('laurel.managed-scripts.v1')] ||= new Map())
function createManagedModulesRuntime(ctx) {
  if (managedRuntimes.has(ctx)) return managedRuntimes.get(ctx)
  let snapshot = null, dead = false, pending = null, timer = null, revision = 0, applying = Promise.resolve()
  const listeners = new Set(), clients = new Map(), errors = new Map(), abort = new AbortController()
  const emit = () => { for (const fn of listeners) fn(snapshot) }
  async function request(payload) {
    const response = await fetch('/api/laurel-center/store', { method:payload?'POST':'GET', credentials:'same-origin', headers:{'x-laurel-ui':'1',...(payload?{'content-type':'application/json'}:{})}, ...(payload?{body:JSON.stringify(payload)}:{}), signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15000)]) })
    const body = await response.json()
    if (!response.ok) throw Error(body.error || '模块管理请求失败 HTTP '+response.status)
    if (body.schema!==1 || !Array.isArray(body.modules)) throw Error('模块目录响应无效')
    return body
  }
  async function script(client) {
    if (!loadedManagedScripts.has(client.id)) {
      const loading = new Promise((resolve,reject)=>{
        const node=document.createElement('script');let timeout
        const end=error=>{clearTimeout(timeout);abort.signal.removeEventListener('abort',cancel);node.remove();error?reject(error):resolve()}
        const cancel=()=>end(Error('模块加载已取消'))
        node.src=client.url;node.async=true;node.onload=()=>end();node.onerror=()=>end(Error('模块客户端下载失败'))
        timeout=setTimeout(()=>end(Error('模块客户端加载超时')),15000);abort.signal.addEventListener('abort',cancel,{once:true});document.head.append(node)
      }).catch(error=>{loadedManagedScripts.delete(client.id);throw error})
      loadedManagedScripts.set(client.id,loading)
    }
    await loadedManagedScripts.get(client.id)
  }
  async function reconcile(value, rev) {
    const wanted = new Map(value.modules.filter(row=>row.installed&&row.enabled&&row.mounted&&row.client).map(row=>[row.id,row.client]))
    for (const [id,current] of clients) if (!wanted.has(id)||wanted.get(id).id!==current.id) { await current.fiber.dispose?.();clients.delete(id);errors.delete(id) }
    for (const [id,client] of wanted) {
      if (dead||rev!==revision) return
      if (clients.has(id)) continue
      let fiber
      try {
        const modules=ctx.get?.('modules');if(!modules?.import)throw Error('宿主客户端模块服务尚未就绪')
        await script(client)
        if (dead||rev!==revision)return
        const exported=await modules['import'](client.id)
        if(typeof exported?.apply!=='function')throw Error('模块客户端没有 apply 入口')
        fiber=ctx.plugin(exported)
        if(typeof fiber.await==='function'){let timeout;try{await Promise.race([fiber.await(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('模块客户端等待依赖超时')),10000)})])}finally{clearTimeout(timeout)}if(fiber.state!==2)throw Error('模块客户端等待依赖')}
        if(dead||rev!==revision){await fiber.dispose?.();return}
        clients.set(id,{id:client.id,fiber});errors.delete(id)
      } catch(error){if(fiber)await fiber.dispose?.();errors.set(id,error.message)}
    }
    if(!dead)emit()
  }
  async function refresh() {
    if(dead)return null
    if(pending)return pending
    pending=request().then(value=>{
      if(dead)return null
      snapshot=value;const rev=++revision
      applying=applying.catch(()=>{}).then(()=>reconcile(value,rev)).catch(error=>{errors.set('_runtime',error.message);emit()})
      emit();return value
    }).finally(()=>{pending=null})
    return pending
  }
  async function poll(){try{await refresh()}catch(error){if(!dead){snapshot={...(snapshot||{schema:1,modules:[]}),error:error.message};emit()}}finally{if(!dead)timer=setTimeout(poll,snapshot?.checking||['checking','downloading','applying'].includes(snapshot?.job?.phase)?1000:15000)}}
  const runtime={getSnapshot:()=>snapshot,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},refresh,
    clientState:id=>errors.has(id)?'failed':clients.has(id)?'loaded':'not-loaded',clientError:id=>errors.get(id),
    async action(action,id,version){const value=await request({action,...(id?{id}:{}),...(version?{version}:{})});if(!dead){snapshot=value;emit()}await refresh();return value},
    stop(){if(dead)return;dead=true;revision++;abort.abort();clearTimeout(timer);listeners.clear();return applying.finally(async()=>{for(const {fiber} of clients.values())await fiber.dispose?.();clients.clear()})}}
  managedRuntimes.set(ctx,runtime)
  ctx.effect(()=>{void poll();return()=>{managedRuntimes.delete(ctx);return runtime.stop()}},'laurel-center.module-runtime')
  return runtime
}

// All themes get a visible store and update prompt through the same native panel.
function createModuleStoreView(React, runtime) {
  const h=React.createElement
  return function ModuleStoreView(){
    const [value,setValue]=React.useState(runtime.getSnapshot()),[error,setError]=React.useState(''),[pending,setPending]=React.useState(false)
    React.useEffect(()=>runtime.subscribe(setValue),[])
    const job=value?.job||{},busy=pending||value?.checking||['checking','downloading','applying'].includes(job.phase)
    const action=async(a,id,version)=>{setPending(true);setError('');try{await runtime.action(a,id,version)}catch(e){setError(e.message)}finally{setPending(false)}}
    const button=(label,a,id,version,disabled=false)=>h('button',{type:'button',disabled:busy||disabled,onClick:()=>action(a,id,version),style:{padding:'6px 10px',border:'1px solid currentColor',background:'transparent',color:'inherit',font:'inherit',cursor:'pointer'}},label)
    const stateText={checking:'正在检查…',downloading:'正在下载并校验…',applying:'正在应用…',completed:'操作已完成；模块配置与数据已保留。',failed:'操作未完成：'+(job.error||''),'restart-required':'控制中心 v'+job.targetVersion+' 已安装，请完全退出并重新打开 DSH。'}[job.phase]
    return h('section',{'data-laurel-store':'',style:{padding:16,border:'1px solid var(--lx-line, currentColor)',background:'var(--lx-surface, transparent)',color:'var(--lx-text, inherit)',fontSize:13,lineHeight:1.6}},
      h('div',{style:{display:'flex',gap:12,alignItems:'center',justifyContent:'space-between',flexWrap:'wrap'}},h('strong',null,'模块商店与更新'),button('检查更新','check')),
      h('p',{role:'status','aria-live':'polite'},value?.updates?'检测到 '+value.updates+' 项更新，可分别更新控制中心与模块。':value?.checkedAt?'已检查官方目录；当前没有可用更新。':'正在获取官方目录；首次安装只包含控制中心。'),
      h('p',null,'DSH '+(value?.hostVersion||'版本未确认')+' · '+(value?.checkedAt?'检查于 '+new Date(value.checkedAt).toLocaleString():'尚未成功检查')),
      (error||value?.error)&&h('p',{role:'alert'},error||value.error),stateText&&h('p',{role:job.phase==='failed'?'alert':'status'},stateText),
      value?.center?.restartRequired&&job.phase!=='restart-required'&&h('p',{role:'status'},'磁盘控制中心 v'+value.center.diskVersion+' 等待完全退出并重新打开 DSH。'),
      value?.center&&h('div',{style:{borderTop:'1px solid currentColor',padding:'10px 0'}},h('strong',null,'控制中心 v'+value.center.version),value.center.updateAvailable&&h('span',null,' → v'+value.center.latestVersion+' '),value.center.updateAvailable&&button('更新控制中心','center-update','laurel-center',value.center.latestVersion,value.center.restartRequired)),
      button('更新已安装模块','update-all',null,null,!value?.modules.some(r=>r.installed&&r.updateAvailable)),
      h('div',{style:{display:'grid',gap:8,marginTop:12}},(value?.modules||[]).map(row=>h('article',{key:row.id,'data-store-module':row.id,style:{borderTop:'1px solid currentColor',padding:'10px 0'}},
        h('strong',null,row.title?.zh||row.id),h('span',null,' · '+(row.installed?'已安装 v'+row.version:'未安装')+(row.retired?' · 已从目录下架':'')+(row.incompatible?' · 当前 DSH 不兼容':'')),
        h('p',null,row.summary?.zh||row.desc?.zh),row.notes&&h('p',null,row.notes),
        h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},!row.installed&&button('下载并安装','install',row.id,row.latestVersion,!row.installAvailable),row.installed&&row.updateAvailable&&button('更新至 v'+row.latestVersion,'update',row.id,row.latestVersion),row.installed&&button('卸载（保留数据）','remove',row.id),row.rollbackAvailable&&button('回退上个版本','rollback',row.id)),
        runtime.clientError(row.id)&&h('p',{role:'alert'},'本窗口加载失败：'+runtime.clientError(row.id)))))
    )
  }
}
