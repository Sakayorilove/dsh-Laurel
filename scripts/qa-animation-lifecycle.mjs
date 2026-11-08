import {chromium} from 'playwright'
import {build} from 'esbuild'
import {readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {createServer} from 'node:http'
import assert from 'node:assert/strict'
import {qaOutput} from './private-output.mjs'
import {createMaterialsHandler} from '../lib/private-materials.js'

// Published client entry, real React, native DOM and renderers. HTTP and layout
// are controlled boundaries; this is not daily-profile desktop acceptance.
const reactRoot=process.env.LAUREL_QA_REACT_ROOT
const materialRoot=process.env.LAUREL_QA_MATERIALS
if(!reactRoot||!materialRoot)throw Error('Set LAUREL_QA_REACT_ROOT and LAUREL_QA_MATERIALS')
const out=qaOutput('animation-lifecycle'),checks=[],errors=[],samples=[]
const boot=await build({stdin:{contents:`import React from '${reactRoot}/react@18.3.1/node_modules/react/index.js';import * as dom from '${reactRoot}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js';import {createPortal} from '${reactRoot}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js';window.__react=React;window.__dom={...dom,createPortal};`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'})
const original=readFileSync(process.env.LAUREL_QA_BUNDLE||new URL('../lib/client.js',import.meta.url),'utf8')
assert.ok(original.includes('workbench.experience = experience'))
const bundle=original.replace('workbench.experience = experience','workbench.experience = experience;window.__siFlow=siFlow;window.__experience=experience')
const materials=createMaterialsHandler({root:materialRoot})
assert.ok(materials.available(),'Optional private assets are required for this performance test')
let presentation={theme:'wuling-particle-v03',siTheme:'si-paper-v01',siEnabled:true,colorMode:'light',experienceRevision:5,sound:false,music:false,motion:true}
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/boot.js'||req.url==='/plugin.js'){res.setHeader('content-type','text/javascript');return res.end(req.url==='/boot.js'?boot.outputFiles[0].text:bundle)}
  if(req.url.startsWith('/laurel-center/materials/'))return materials.handler(req,res)
  if(req.url.startsWith('/laurel-center/art/'))return materials.legacy(req,res)
  res.setHeader('content-type','application/json')
  if(req.url.startsWith('/api/laurel-center/presentation')){
   if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;presentation={...presentation,...JSON.parse(body)}}
   return res.end(JSON.stringify({ok:true,value:presentation}))
  }
  if(req.url.startsWith('/api/laurel-center/store'))return res.end(JSON.stringify({schema:1,hostVersion:'0.2.2-rc.1',modules:[],updates:0,center:{version:'1.9.3'},job:{phase:'idle'}}))
  if(req.url.startsWith('/api/laurel-center/modules'))return res.end('{"enabled":{},"status":[]}')
  if(req.url.startsWith('/api/'))return res.end('{}')
  if(req.url!=='/'){res.writeHead(404);return res.end()}
  res.setHeader('content-type','text/html; charset=utf-8')
  res.end(`<!doctype html><html><head><meta charset="utf-8"><style>
   body{margin:0;font:14px sans-serif}.fixture-frame{display:flex;height:900px}
   aside{width:240px;overflow:auto;flex-shrink:0}nav{height:32px}button{height:32px}
   [data-row-key]{height:30px;position:relative;isolation:isolate}
   .conversation{flex:1;position:relative;min-width:0}header{height:35px}
   #center{position:fixed;left:240px;right:0;top:60px;bottom:0;display:flex;z-index:5}
   [data-state],._runningIcon{display:inline-block;width:16px;height:16px;border:2px dashed #256d71;border-radius:50%;transform:rotate(var(--lsf-ring-angle,0deg))}
   </style></head><body><div class="fixture-frame _frame"><aside class="_sidebarCol"><nav aria-label="Global panels"><button aria-label="Laurel">Laurel</button></nav><button class="_newSession">New session</button><div id="rows">${Array.from({length:2000},(_,i)=>`<div data-row-key="session:synthetic-${i}" aria-selected="${i===0}"><span>Session ${i}</span><i data-state="idle"></i></div>`).join('')}</div></aside><main class="conversation"><header>Conversation</header><section data-conversation-content><div id="running"></div></section><div data-composer-card style="width:600px;height:80px">Composer</div></main></div><div id="center"></div></body></html>`)
 }catch(e){res.writeHead(500);res.end(String(e))}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader','--disable-dev-shm-usage']})
const page=await browser.newPage({viewport:{width:1440,height:900}})
page.on('pageerror',e=>errors.push(String(e)))
const cdp=await page.context().newCDPSession(page)
const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});console.log(JSON.stringify({check:name,pass:!!pass}));assert.ok(pass,name)}
const center=()=>page.frames().find(f=>f!==page.mainFrame()&&f.parentFrame()===page.mainFrame()&&f.url()==='about:srcdoc')
async function ringSample(){return page.evaluate(()=>({root:document.documentElement.style.getPropertyValue('--lsf-ring-phase'),rings:__siFlow.snapshot().rings,expected:((__siFlow.snapshot().engine.time/2.1*360)%360).toFixed(3)+'deg',angles:[...document.querySelectorAll('.lsf-session [data-state=ongoing],.lsf-running-ring')].map(e=>({phase:e.style.getPropertyValue('--lsf-ring-phase'),angle:getComputedStyle(e).getPropertyValue('--lsf-ring-angle').trim()})),writes:{...__phaseWrites}}))}
async function state(){return center().evaluate(()=>({scene:laurelParticleControl.snapshot().scene,prefs:laurelParticleControl.snapshot().prefs,active:laurelParticleControl.snapshot().panelActive,ink:selectionFlow.snapshot(),selection:brushPreview.snapshot()}))}
async function frozen(name,action){
 await action();await page.waitForTimeout(150);const a=await state();await page.waitForTimeout(500);const b=await state()
 check(name,!b.active&&!b.scene.raf&&!b.ink.raf&&a.scene.frames===b.scene.frames&&a.scene.rotation===b.scene.rotation&&a.ink.time===b.ink.time,{a,b})
}
async function resumed(name,action){
 await action();await page.waitForTimeout(120);const a=await state();await page.waitForTimeout(350);const b=await state()
 check(name,b.active&&b.scene.raf&&b.ink.raf&&b.scene.frames>a.scene.frames&&b.scene.rotation!==a.scene.rotation&&b.ink.time>a.ink.time,{a,b})
}
try{
 await page.addInitScript(()=>{
  localStorage.setItem('laurel.harness-appearance.v03',JSON.stringify({theme:'si-paper-v01',colorMode:'light',paused:true,motion:true,speed:1,fps:60}))
  const set=CSSStyleDeclaration.prototype.setProperty
  window.__phaseWrites={root:0,local:0}
  CSSStyleDeclaration.prototype.setProperty=function(name,...args){if(name==='--lsf-ring-phase')__phaseWrites[this===document.documentElement.style?'root':'local']++;return set.call(this,name,...args)}
 })
 await page.goto('http://127.0.0.1:'+server.address().port)
 await page.addScriptTag({url:'/boot.js'})
 await page.evaluate(()=>{window.__factories={};window.__ModuleLoader__={load(x){__factories[x.id]=x.factory}}})
 await page.addScriptTag({url:'/plugin.js'})
 await page.evaluate(()=>{
  const clean=[],entries=[],listeners=new Set(),React=__react,h=React.createElement
  let selected=null,reactRoot=null
  const layout={selectPanel(id){selected=id;for(const f of listeners)f()},panelInfo:{getSnapshot:()=>({activePanelId:selected}),subscribe(f){listeners.add(f);return()=>listeners.delete(f)}}}
  const ctx={effect(fn){const off=fn();if(typeof off==='function')clean.push(off)},get(key){return key==='layout'?layout:null},locale:{register(){return()=>{}},bind(){return key=>key}},remote:{$on(){return()=>{}}},slots:{entries(){return[]},inject(name,fn){return fn()},register(meta,component){entries.push({...meta,component});return()=>{}}}}
  __factories['laurel-center'](key=>key==='react'?React:key==='react-dom'?__dom:null).apply(ctx)
  window.__qa={select:id=>layout.selectPanel(id),mount(){reactRoot=__dom.createRoot(document.querySelector('#center'));const Panel=entries.find(e=>e.name==='main').component;reactRoot.render(h(Panel,{renderSlot:()=>null}))},unmount(){reactRoot?.unmount();reactRoot=null},dispose(){this.unmount();clean.reverse().forEach(f=>f())}}
 })
 await page.waitForFunction(()=>__siFlow.snapshot().active&&__siFlow.snapshot().engine.materials.length>=2,{},{timeout:10000}).catch(async e=>{writeFileSync(join(out,'mount.json'),JSON.stringify(await page.evaluate(()=>({si:__siFlow.snapshot(),experience:__experience.snapshot(),error:document.documentElement.dataset.siFlowError,canvases:document.querySelectorAll('canvas').length,body:document.body.innerText.slice(0,200)})),null,2));throw e})
 await page.waitForTimeout(250)
 await page.evaluate(()=>__siFlow.setTime(1.05))
 const empty=await ringSample();check('no consumers: zero phase writes, including root',empty.root===''&&empty.rings===0&&empty.writes.root===0&&empty.writes.local===0,empty)
 await page.evaluate(()=>{document.querySelector('[data-row-key] [data-state]').dataset.state='ongoing';document.querySelector('#running').outerHTML='<div id="running" data-chat-running><span class="_runningIcon"></span></div>'})
 await page.waitForFunction(()=>__siFlow.snapshot().rings===2)
 for(const time of [0,.175,.525,1.05,1.575,2.1,7.5]){
  await page.evaluate(t=>__siFlow.setTime(t),time);const s=await ringSample()
  check('local ring angles retain original clock at '+time,s.root===''&&s.angles.length===2&&s.angles.every(r=>r.phase===s.expected&&Math.abs(parseFloat(r.angle)-parseFloat(s.expected))<.001),s)
 }
 await page.evaluate(()=>__siFlow.setTime(.525));await page.screenshot({path:join(out,'native-rings.png')})
 await page.evaluate(()=>{window.__oldRings=[...document.querySelectorAll('.lsf-session [data-state=ongoing],.lsf-running-ring')];__oldRings[0].dataset.state='done';document.querySelector('#running').removeAttribute('data-chat-running')})
 await page.waitForFunction(()=>__siFlow.snapshot().rings===0)
 check('completed and stopped consumers release local properties',await page.evaluate(()=>__oldRings.every(e=>!e.style.getPropertyValue('--lsf-ring-phase'))))
 await page.evaluate(()=>{const old=document.querySelector('[data-row-key] i');old.dataset.state='ongoing';window.__detachedRing=old})
 await page.waitForFunction(()=>__siFlow.snapshot().rings===1)
 await page.evaluate(()=>{const el=__detachedRing.cloneNode();__detachedRing.replaceWith(el)})
 await page.waitForFunction(()=>__siFlow.snapshot().rings===1&&!__detachedRing.style.getPropertyValue('--lsf-ring-phase'))
 check('DOM replacement releases detached consumer',true)
 await page.evaluate(()=>__siFlow.appearance.update({paused:false,speed:1.5,fps:30}));await page.waitForTimeout(450)
 const moving=await ringSample();check('custom speed and FPS preserved',await page.evaluate(()=>{const e=__siFlow.snapshot().engine;return e.speed===1.5&&e.targetFPS===30&&e.raf}),moving)
 await page.evaluate(()=>__siFlow.appearance.update({paused:true}));const p1=await ringSample();await page.waitForTimeout(250);const p2=await ringSample();check('user pause freezes ring phase',p1.expected===p2.expected,{p1,p2})
 await page.evaluate(()=>__experience.update({siEnabled:false}));await page.waitForFunction(()=>!__siFlow.snapshot().active)
 check('theme off removes phase ownership',await page.evaluate(()=>document.querySelectorAll('[style*="--lsf-ring-phase"]').length===0))
 await page.evaluate(async()=>{await __experience.update({siEnabled:true});await __siFlow.appearance.update({paused:false,speed:1,fps:60});__qa.mount()})
 await page.waitForFunction(()=>document.querySelector('iframe[data-laurel-particle-frame]')?.contentWindow?.laurelParticleControl?.snapshot().scene?.sourcePoints>0)
 await center().waitForFunction(()=>window.selectionReady)
 await frozen('mounted but not selected: particles and ink stopped',()=>page.evaluate(()=>__qa.select(null)))
 await resumed('select control center: full particles and ink resume',()=>page.evaluate(()=>__qa.select('laurel-center')))
 const visible=await state();check('full point count and original visual parameters retained',visible.scene.drawPoints===visible.scene.sourcePoints&&visible.scene.glowStrength===1.1&&visible.scene.glowRadius===1,visible)
 await page.screenshot({path:join(out,'center-visible.png')})
 await frozen('leave control center with iframe retained: no hidden clocks',()=>page.evaluate(()=>__qa.select(null)))
 await resumed('return to retained control center',()=>page.evaluate(()=>__qa.select('laurel-center')))
 await frozen('CSS-hidden center suspends both clocks',()=>page.evaluate(()=>document.querySelector('#center').style.display='none'))
 await resumed('show center restores both clocks',()=>page.evaluate(()=>document.querySelector('#center').style.display='flex'))
 await frozen('offscreen center suspends both clocks',()=>page.evaluate(()=>document.querySelector('#center').style.transform='translateX(200vw)'))
 await resumed('onscreen center restores both clocks',()=>page.evaluate(()=>document.querySelector('#center').style.transform=''))
 // CDP does not expose a portable visibility toggle. A controlled document.hidden
 // accessor exercises the real visibility listeners without claiming OS minimization.
 await frozen('document-hidden event suspends both clocks',()=>page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))}))
 await resumed('document-visible event restores both clocks',()=>page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))}))
 await center().locator('#pause').click();await page.evaluate(()=>__siFlow.appearance.update({paused:true}))
 await page.evaluate(()=>__qa.select(null));await page.evaluate(()=>__qa.select('laurel-center'));await page.waitForTimeout(150)
 const paused=await state();check('activity does not override user particle or ink pause',paused.active&&paused.scene.paused&&!paused.scene.raf&&paused.ink.paused&&!paused.ink.raf,paused)
 await center().locator('#pause').click();await page.evaluate(()=>__siFlow.appearance.update({paused:false}))
 await page.evaluate(()=>__qa.select(null));await page.waitForTimeout(100)
 // Long run uses the packaged candidate with large native DOM and one ongoing ring.
 // No forced GC during the measured interval; store native dumps at each endpoint.
 async function memoryDump(name){
  const events=[];const onData=e=>events.push(...e.value);let finish
  const completed=new Promise(r=>finish=r);cdp.on('Tracing.dataCollected',onData);cdp.once('Tracing.tracingComplete',()=>finish())
  await cdp.send('Tracing.start',{traceConfig:{recordMode:'recordUntilFull',includedCategories:['disabled-by-default-memory-infra'],excludedCategories:['*'],memoryDumpConfig:{triggers:[]}},transferMode:'ReportEvents'})
  await cdp.send('Tracing.requestMemoryDump',{levelOfDetail:'detailed'});await cdp.send('Tracing.end');await completed;cdp.off('Tracing.dataCollected',onData)
  writeFileSync(join(out,name+'.json'),JSON.stringify({events}));return events
 }
 const seconds=Number(process.env.LAUREL_QA_STABILITY_SECONDS||0)
 if(seconds>0){
  await memoryDump('native-start');const begin=Date.now()
  do{await page.waitForTimeout(Math.min(10000,seconds*1000));const heap=await cdp.send('Runtime.getHeapUsage');const native=await page.evaluate(()=>({rootPhase:document.documentElement.style.getPropertyValue('--lsf-ring-phase'),writes:__phaseWrites,snapshot:__siFlow.snapshot()}));samples.push({seconds:(Date.now()-begin)/1000,heap,native});writeFileSync(join(out,'stability.json'),JSON.stringify(samples,null,2));console.log(JSON.stringify({seconds:samples.at(-1).seconds,heap,rings:native.snapshot.rings,rootWrites:native.writes.root}))}while(Date.now()-begin<seconds*1000)
  await memoryDump('native-end')
  check('stability interval never broadcasts root phase',samples.every(s=>s.native.rootPhase===''&&s.native.writes.root===0))
 }
 await page.evaluate(()=>{window.__retiredCenter=document.querySelector('iframe[data-laurel-particle-frame]').contentWindow;__qa.unmount()})
 check('unmount disposes particle and ink engines',await page.evaluate(()=>__retiredCenter.laurelParticleControl.snapshot().disposed&&__retiredCenter.selectionFlow.snapshot().disposed&&!document.querySelector('[data-laurel-particle-frame]')))
 await page.evaluate(()=>{__qa.select('laurel-center');__qa.mount()})
 await page.waitForFunction(()=>document.querySelector('iframe[data-laurel-particle-frame]')?.contentWindow?.laurelParticleControl?.snapshot().scene?.sourcePoints>0)
 await center().waitForFunction(()=>window.selectionReady)
 await resumed('reopen after unmount creates a working center',()=>Promise.resolve())
 await page.evaluate(()=>__qa.dispose());check('plugin disposal removes native local phase',await page.evaluate(()=>!document.querySelector('[style*="--lsf-ring-phase"]')))
 check('no browser exceptions',errors.length===0,errors)
}finally{
 writeFileSync(join(out,'results.json'),JSON.stringify({scope:'Production client bundle in Chromium, actual renderers and optional local assets, synthetic large native DOM; controlled layout/HTTP, visibility event simulated; not daily desktop GUI acceptance.',checks,errors,samples},null,2))
 await browser.close();materials.dispose();server.closeAllConnections();await new Promise(r=>server.close(r))
}
console.log(JSON.stringify({checks:checks.length,errors,out}))
