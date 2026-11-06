import {qaOutput} from './private-output.mjs'
import {chromium} from 'playwright'
import {build} from 'esbuild'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createServer} from 'node:http'
import {gzipSync} from 'node:zlib'
import assert from 'node:assert/strict'
import {ModuleStore,hash} from '../lib/module-store.js'
import {mountModules} from '../lib/modules.js'
import {createStoreHandler} from '../lib/module-store-api.js'
import {createModuleSwitchHandler} from '../lib/module-switch.js'
import {createPresentationHandler,writePresentation} from '../lib/ui-preferences.js'
import {createMaterialsHandler} from '../lib/private-materials.js'
import {seedCatalog} from './build-module-release.mjs'

const reference=process.env.LAUREL_QA_REFERENCE,runtime=process.env.LAUREL_DSH_RUNTIME
if(!reference||!runtime)throw Error('Set LAUREL_QA_REFERENCE and LAUREL_DSH_RUNTIME to preserved exact-version native fixtures')
const native=join(runtime,'node_modules/@deepseek-ai'),nativeVersion=JSON.parse(readFileSync(join(runtime,'package.json'),'utf8')).version
assert.equal(nativeVersion,'0.2.1-rc.5')
const {Context}=await import(pathToFileURL(join(native,'cordis/lib/index.js')).href)
const out=qaOutput('module-store'),bundle=join(out,'seed'),profileDir=join(out,'isolated-node-profile'),dataPaths={dir:join(out,'isolated-data')}
mkdirSync(bundle,{recursive:true});mkdirSync(dataPaths.dir,{recursive:true})
const home=join(out,'isolated-home');process.env.DSH_HOME=home
const spec=id=>({id,dir:id,entry:id,settingsId:id,category:'experience',title:{zh:id==='sample'?'独立模块':'新增模块',en:id},desc:{zh:'验证按需安装与独立更新。',en:'Independent lifecycle fixture.'},releases:[]})
const catalog={schema:1,center:seedCatalog().center,modules:[spec('sample')]},assets=new Map()
function release(id,version,{broken=false}={}){
 const row=catalog.modules.find(r=>r.id===id),pkg={name:id,version,type:'module',exports:{'.':'./lib/index.js','./client':'./lib/client.js'}}
 const host=`export function apply(ctx){${broken?'throw Error("QA activation rejected")':`ctx.effect(()=>{globalThis.__laurelHostMounts=(globalThis.__laurelHostMounts||0)+1;return()=>{globalThis.__laurelHostDisposals=(globalThis.__laurelHostDisposals||0)+1}})`}}`
 const client=`window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory:()=>({apply(ctx){ctx.effect(()=>{window.__moduleVersions||=[];window.__moduleVersions.push(${JSON.stringify(version)});return()=>{window.__moduleDisposals=(window.__moduleDisposals||0)+1}})}})})`
 const files=[['package.json',JSON.stringify(pkg)],['lib/index.js',host],['lib/client.js',client]].map(([p,s])=>({path:'packages/'+id+'/'+p,data:Buffer.from(s).toString('base64')})),bytes=gzipSync(Buffer.from(JSON.stringify({schema:1,id,version,files})))
 const url='https://github.com/Sakayorilove/dsh-Laurel/releases/download/v1.8.5/'+id+'-'+version+'.lmod'
 row.releases.unshift({version,url,sha256:hash(bytes),bytes:bytes.length,centerApi:1,hostVersions:[nativeVersion],dataSchema:1,published:true});assets.set(url,bytes)
}
release('sample','1.0.0');writeFileSync(join(bundle,'release-catalog.json'),JSON.stringify(catalog))
let origin,offline=false
const store=new ModuleStore({profileDir,dataPaths,specs:[],hostVersion:nativeVersion,bundledRoot:bundle,catalogUrl:'https://catalog.invalid',isBusy:()=>false,fetchImpl:(url,opts)=>fetch(origin+'/__release/'+encodeURIComponent(url),opts)})
const hostContext=new Context(),modules=mountModules(hostContext,{initiallyEnabled:{},paths:store.paths,getSpecs:()=>store.specs(),load:dir=>store.resolvePlugin(dir),canChange:()=>!store.activeJob,withChange:fn=>store.exclusive(fn)});store.modules=modules
const connection=()=>({admit:()=>({peer:{}})}),storeApi=createStoreHandler({getStore:()=>store,connection}),switchApi=createModuleSwitchHandler({getModules:()=>modules,paths:store.paths,connection})
const pref=join(out,'presentation.json');writePresentation(pref,{theme:'particle-v03',experienceRevision:5,colorMode:'light',sound:false,music:false,motion:false})
const presentation=createPresentationHandler({file:pref,connection}),materials=createMaterialsHandler({root:process.env.LAUREL_QA_MATERIALS||join(out,'empty-materials')})
const base=join(reference,'source/node_modules/.pnpm')
const boot=await build({stdin:{contents:`import React from '${base}/react@18.3.1/node_modules/react/index.js';import * as dom from '${base}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js';import {createPortal} from '${base}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js';import {Context} from '${native}/cordis/lib/index.js';window.__react=React;window.__dom={...dom,createPortal};window.__Context=Context;`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'})
const root=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8').replace('workbench.experience = experience','workbench.experience = experience;window.__experience=experience').replaceAll('const managed = createManagedModulesRuntime(ctx)','const managed = createManagedModulesRuntime(ctx);window.__storeRuntime=managed')
const server=createServer(async(req,res)=>{try{
 if(req.url.startsWith('/__release/')){if(offline){res.writeHead(503);res.end();return}const key=decodeURIComponent(req.url.slice(11)),bytes=key==='https://catalog.invalid'?Buffer.from(JSON.stringify(catalog)):assets.get(key);res.writeHead(bytes?200:404);res.end(bytes||'missing');return}
 if(req.url.startsWith('/api/laurel-center/store'))return storeApi(req,res)
 if(req.url.startsWith('/api/laurel-center/modules'))return switchApi(req,res)
 if(req.url.startsWith('/api/laurel-center/presentation'))return presentation(req,res)
 if(req.url.startsWith('/laurel-center/art'))return materials.legacy(req,res)
 if(req.url.startsWith('/laurel-center/materials'))return materials.handler(req,res)
 if(req.url==='/boot.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(boot.outputFiles[0].text);return}
 if(req.url==='/native-modules.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(readFileSync(join(native,'dsh-client-modules/lib/client.js')));return}
 if(req.url==='/plugin.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(root);return}
 res.writeHead(200,{'content-type':'text/html'});res.end(readFileSync(join(reference,'evidence/native-rich-fixture.html')))
}catch(e){res.writeHead(500);res.end(String(e))}})
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port
await store.check(true)
const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']}),page=await browser.newPage({viewport:{width:1440,height:980}}),errors=[],checks=[]
page.on('pageerror',e=>errors.push(e.stack||String(e)))
const check=(name,result)=>{assert.ok(result,name);checks.push({name,pass:true})}
await page.addInitScript(()=>{window.__realFetch=fetch.bind(window)})
const center=()=>page.frames().find(f=>f.parentFrame()===page.mainFrame()&&f.url()==='about:srcdoc')
async function waitJob(){await page.waitForFunction(()=>!['checking','downloading','applying'].includes(window.__storeRuntime?.getSnapshot()?.job?.phase));await page.waitForTimeout(150)}
async function refresh(){await page.evaluate(()=>__storeRuntime.refresh());await page.waitForTimeout(200)}
async function install(id){await center().locator('[data-store-install="'+id+'"]').click();await page.waitForFunction(id=>__storeRuntime.getSnapshot()?.modules.find(r=>r.id===id)?.installed,id);await refresh()}
try{
 await page.goto(origin);await page.waitForFunction(()=>window.laurelNativePreview);await page.evaluate(()=>{laurelNativePreview.dispose();fetch=__realFetch})
 await page.addScriptTag({url:origin+'/boot.js'});await page.evaluate(()=>{window.__ModuleLoader__={mode:'queue',pendingQueue:[],load(row){this.pendingQueue.push(row)}}})
 await page.addScriptTag({url:origin+'/native-modules.js'})
 await page.evaluate(()=>{const target=__ModuleLoader__,boot=target.pendingQueue.shift(),nativeExports=boot.factory(()=>{});window.__nativeModules=new nativeExports.ClientModuleSystem({manifest:{rev:'qa',modules:[],batches:[]},staticModules:{react:__react,'react-dom':__dom},registrationTarget:target,bootstrapModule:{id:boot.id,exports:nativeExports}})})
 await page.addScriptTag({url:origin+'/plugin.js'})
 await page.evaluate(async()=>{window.__mountCenter=async()=>{
  const ctx=new __Context(),registrations=[],slots={inject(name,fn){return fn()},register(meta,component){const row={...meta,component};registrations.push(row);return()=>registrations.splice(registrations.indexOf(row),1)}}
  const layout={selectPanel(){},panelInfo:{getSnapshot:()=>({activePanelId:'laurel-center'}),subscribe(){return()=>{}}}}
  for(const [key,value] of Object.entries({modules:__nativeModules,slots,layout,locale:{register(){return()=>{}},bind(){return key=>key}},remote:{$on(){return()=>{}}}}))ctx.provide(key,value)
  const plugin=await __nativeModules.import('laurel-center');window.__rootFiber=ctx.plugin(plugin);await __rootFiber.await();if(__rootFiber.state!==2)throw Error('Center did not activate')
  const mount=document.createElement('div');mount.id='qa-mount';mount.style.cssText='position:fixed;left:240px;top:40px;right:0;bottom:0;display:flex;z-index:100001;background:var(--lx-side)';document.body.append(mount)
  const Panel=registrations.find(r=>r.name==='main').component;window.__root=__dom.createRoot(mount);__root.render(__react.createElement(Panel,{renderSlot:()=>__react.createElement('p',null,'Native settings boundary')}));window.__ctx=ctx
 };await __mountCenter()})
 // The production runtime is exposed only in this QA copy, never in shipped code.
 await page.waitForFunction(()=>document.querySelector('iframe[data-laurel-particle-frame]')?.contentWindow?.laurelParticleControl?.snapshot().modules.length===1)
 await page.waitForFunction(()=>window.__storeRuntime)
 check('Center boots on real rc.5 Cordis with no installed module',!store.snapshot().modules[0].installed&&globalThis.__laurelHostMounts===undefined)
 await install('sample');check('download button installs only the requested module',store.snapshot().modules[0].installed&&!store.snapshot().modules[0].enabled)
 await center().locator('[data-toggle="sample"]').click();await page.waitForFunction(()=>window.__moduleVersions?.includes('1.0.0'));check('enabled module materializes through real rc.5 ClientModuleSystem',globalThis.__laurelHostMounts===1)
 release('sample','1.1.0');store.lastAttempt=0;await store.check(true);await refresh();await page.waitForSelector('[data-laurel-update-notice]:not([hidden])');check('new release produces a persistent update prompt',await page.locator('[data-laurel-update-notice]').innerText().then(s=>s.includes('1 项更新')))
 await page.locator('[data-open-module-store]').click();await page.locator('[data-store-module=sample]').getByRole('button',{name:'更新至 v1.1.0'}).click();await page.waitForFunction(()=>window.__moduleVersions?.includes('1.1.0'));check('updating enabled module disposes the old client and host',globalThis.__laurelHostDisposals===1&&await page.evaluate(()=>__moduleDisposals===1))
 await page.screenshot({path:join(out,'store-installed.png')})
 await page.locator('[data-store-module=sample]').getByRole('button',{name:'回退上个版本'}).click();await page.waitForFunction(()=>window.__moduleVersions?.length===3);check('rollback reuses registered factory without duplicate registration',await page.evaluate(()=>__moduleVersions.at(-1)==='1.0.0'))
 await page.evaluate(async()=>{__root.unmount();await __rootFiber.dispose();await __ctx.fiber.dispose();document.querySelector('#qa-mount')?.remove();__nativeModules.invalidate('laurel-center','qa-center-hmr')})
 await page.addScriptTag({url:origin+'/plugin.js'});await page.evaluate(()=>__mountCenter());await page.waitForFunction(()=>window.__moduleVersions?.length===4)
 check('Center-only HMR reuses module registrations and remounts their clients',await page.evaluate(()=>__moduleVersions.at(-1)==='1.0.0'&&__moduleDisposals===3))
 await page.locator('[data-open-module-store]').click()
 const data=join(dataPaths.dir,'saved.json');writeFileSync(data,'{"preserve":true}')
 await page.locator('[data-store-module=sample]').getByRole('button',{name:'卸载（保留数据）'}).click();await page.waitForFunction(()=>__storeRuntime.getSnapshot()?.modules[0].installed===false);await refresh();check('uninstall removes active clients and retains user data',readFileSync(data,'utf8')==='{"preserve":true}'&&await page.evaluate(()=>__moduleDisposals===4))
 catalog.modules.push(spec('new-module'));release('new-module','1.0.0');store.lastAttempt=0;await store.check(true);await refresh();check('a new catalog module appears without replacing Center',await center().locator('[data-store-install="new-module"]').count()===1)
 await page.setViewportSize({width:480,height:800});await page.screenshot({path:join(out,'store-narrow.png')});check('store dialog fits narrow viewport',await page.locator('dialog[open]').evaluate(el=>el.getBoundingClientRect().right<=480&&el.scrollWidth<=el.clientWidth))
 offline=true;store.lastAttempt=0;await store.check(true);await refresh();check('offline update checks show an explicit failure',await page.locator('[data-laurel-store]').innerText().then(s=>s.includes('暂时无法检查更新')))
 await page.evaluate(async()=>{__root.unmount();await __rootFiber.dispose();await __ctx.fiber.dispose()});check('Center unload removes update notices and module clients',await page.locator('[data-laurel-update-notice]').count()===0)
 check('no browser errors',errors.length===0)
}finally{
 writeFileSync(join(out,'module-store-qa.json'),JSON.stringify({scope:'Actual downloaded archives and HTTP handlers; actual rc.5 Cordis on host/browser and ClientModuleSystem. Sample modules exercise version replacement; shell layout/slots and authentication peer are controlled boundaries. This is not desktop GUI acceptance.',nativeVersion,checks,errors,hostMounts:globalThis.__laurelHostMounts,hostDisposals:globalThis.__laurelHostDisposals},null,2))
 store.close();await modules.disposeAll();await hostContext.fiber.dispose();await browser.close();materials.dispose();server.closeAllConnections();await new Promise(r=>server.close(r))
}
console.log(JSON.stringify({checks:checks.length,errors}))
