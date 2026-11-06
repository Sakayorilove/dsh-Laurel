import {presentationStoreFixture} from './qa-store-fixture.mjs'
import {qaOutput} from './private-output.mjs'
import {chromium} from 'playwright'
import {build} from 'esbuild'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createServer} from 'node:http'
import assert from 'node:assert/strict'
import {createPresentationHandler,writePresentation} from '../lib/ui-preferences.js'
import {createMaterialsHandler} from '../lib/private-materials.js'
import {SUB_PLUGINS} from '../lib/registry.js'
const reference=process.env.LAUREL_QA_REFERENCE;if(!reference)throw Error('Set LAUREL_QA_REFERENCE to the preserved rc.5 native fixture project');
const out=qaOutput('v05')
const file=out+'/qa-presentation.json';writePresentation(file,{theme:'wuling-v02',colorMode:'dark',experienceRevision:0,sound:false,music:false,volume:.21})
const handler=createPresentationHandler({file,connection:()=>({admit:()=>null})}),materials=createMaterialsHandler({root:process.env.LAUREL_QA_MATERIALS||out+'/empty-materials'})
const root=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8').replace('workbench.experience = experience','workbench.experience = experience;window.__experience=experience;window.__workbench=workbench;window.__siFlow=siFlow')
const reactBase=reference+'/source/node_modules/.pnpm/'
const boot=await build({stdin:{contents:`import React from '${reactBase}react@18.3.1/node_modules/react/index.js';import * as dom from '${reactBase}react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js';import {createPortal} from '${reactBase}react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js';window.__react=React;window.__dom={...dom,createPortal};`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'})
let failSave=false,missing=false;const audioRequests=[]
const server=createServer(async(req,res)=>{
 try{
 if(req.url.startsWith('/api/laurel-center/presentation')){if(failSave&&req.method==='POST'){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"QA disk unavailable"}');return}return handler(req,res)}
 if(presentationStoreFixture(req,res))return;
 if(req.url.startsWith('/api/laurel-center/modules')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({enabled:Object.fromEntries(SUB_PLUGINS.map(p=>[p.id,true])),status:SUB_PLUGINS.map(p=>({id:p.id,mounted:true}))}));return}
 if(req.url.startsWith('/laurel-center/art/audio/'))audioRequests.push(req.url)
 if(req.url.startsWith('/laurel-center/materials')||req.url.startsWith('/laurel-center/art')){if(missing){res.writeHead(404);res.end();return}return req.url.startsWith('/laurel-center/art')?materials.legacy(req,res):materials.handler(req,res)}
 if(req.url==='/boot.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(boot.outputFiles[0].text);return}
 if(req.url==='/plugin.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(root);return}
 res.writeHead(200,{'content-type':'text/html'});res.end(readFileSync(reference+'/evidence/native-rich-fixture.html'))
 }catch(e){res.writeHead(500);res.end(String(e))}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({headless:true,args:['--disable-web-security','--autoplay-policy=no-user-gesture-required']})
const checks=[],errors=[];const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});assert.ok(pass,name)}
const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',e=>errors.push(e.stack||String(e)))
await page.addInitScript(()=>{window.__qaNative={fetch:window.fetch.bind(window),Audio:window.Audio,AudioContext:window.AudioContext};if(!localStorage.getItem('laurel.harness-appearance.v03'))localStorage.setItem('laurel.harness-appearance.v03',JSON.stringify({colorMode:'light',theme:'si-paper-v01'}))})
async function mount(){
 await page.goto(url);await page.waitForFunction(()=>window.laurelNativePreview);await page.evaluate(()=>{laurelNativePreview.setOriginal(true);laurelNativePreview.dispose();for(const s of document.head.querySelectorAll('style'))if(s.textContent.includes('Laurel 0.3 applied to the unmodified')||s.textContent.includes('Palette: evidence/previous-color-samples'))s.remove();window.fetch=__qaNative.fetch;window.Audio=__qaNative.Audio;window.AudioContext=__qaNative.AudioContext;document.body.classList.add('qa-center')})
 await page.addStyleTag({content:'#preview-trigger,#preview-panel,.laurel-ambient,.native-preview-controls{display:none!important}body.qa-center [data-conversation-content],body.qa-center [data-composer-card]{visibility:hidden!important}#qa-mount{position:fixed;left:260px;top:40px;right:0;bottom:0;z-index:100000;background:var(--lx-side);display:flex;min-width:0}'})
 await page.addScriptTag({url:url+'/boot.js'})
 await page.evaluate(()=>{if(!sessionStorage.getItem('qa-legacy-seeded')){localStorage.setItem('laurel.harness-appearance.v03',JSON.stringify({colorMode:'light',theme:'si-paper-v01'}));localStorage.removeItem('laurel-center.presentation.v1');sessionStorage.setItem('qa-legacy-seeded','1')}})
 await page.evaluate(()=>{window.__factories={};window.__ModuleLoader__={load(o){__factories[o.id]=o.factory}}})
 await page.addScriptTag({url:url+'/plugin.js'})
 await page.evaluate(()=>{window.__geometryBefore=[...document.querySelectorAll('[data-row-key], [data-composer-card], nav[aria-label="Global panels"]')].map(e=>{const r=e.getBoundingClientRect();return[e.getAttribute('data-row-key')||e.tagName,r.x,r.y,r.width,r.height,getComputedStyle(e).font]})})
 await page.evaluate(()=>{
  const exports={},React=__react,h=React.createElement,clean=[],registrations=[],panelListeners=new Set();
  const layout={selectPanel(){},panelInfo:{getSnapshot:()=>({activePanelId:'laurel-center'}),subscribe(fn){panelListeners.add(fn);return()=>panelListeners.delete(fn)}}};
  const ctx={effect(fn){const off=fn();if(typeof off==='function')clean.push(off);return off},get(key){return key==='layout'?layout:null},locale:{register(){return()=>{}},bind(){return key=>key}},remote:{$on(){return()=>{}}},slots:{inject(name,fn){return fn()},register(meta,component){registrations.push({...meta,component});return()=>{} }}};
  const plugin=__factories['laurel-center'](key=>key==='react'?React:key==='react-dom'?__dom:null);plugin.apply(ctx);
  window.__registrations=registrations;const mount=document.createElement('div');mount.id='qa-mount';document.body.append(mount);
  const Panel=registrations.find(x=>x.name==='main').component;const reactRoot=__dom.createRoot(mount);reactRoot.render(h(Panel,{renderSlot:()=>h('p',null,'QA native slot boundary')}));
  window.__dispose=()=>{reactRoot.unmount();clean.reverse().forEach(fn=>fn());mount.remove()};
 });await page.waitForFunction(()=>document.querySelector('iframe[data-laurel-particle-frame]')?.contentWindow?.laurelParticleControl?.snapshot().modules.length===7).catch(async e=>{writeFileSync(out+'/mount-diagnostic.json',JSON.stringify(await page.evaluate(()=>({registrations:__registrations.map(x=>({name:x.name,key:x.key,id:x.id})),experience:__experience.snapshot(),frames:[...document.querySelectorAll('iframe')].map(f=>({title:f.title,text:f.contentDocument?.body?.innerText.slice(0,1000),snapshot:f.contentWindow?.laurelParticleControl?.snapshot()})),root:document.querySelector('#qa-mount').innerHTML.slice(0,2500)})),null,2));throw e})
 await page.waitForTimeout(450)
}
const center=()=>page.frames().find(f=>f!==page.mainFrame()&&f.url()==='about:srcdoc'&&f.parentFrame()===page.mainFrame())
try{
 await mount()
 await page.waitForFunction(()=>__experience.snapshot().preferences.experienceRevision===5&&!__experience.snapshot().preferences.saving)
 const migrated=JSON.parse(readFileSync(file,'utf8'))
 check('legacy migration preserves Harness mode and audio values',migrated.theme==='wuling-particle-v03'&&migrated.colorMode==='light'&&migrated.sound===false&&migrated.music===false&&migrated.volume===.21,migrated)
 await page.evaluate(()=>__experience.update({sound:true}))
 await page.evaluate(()=>{window.__aicEntries=0;const play=__workbench.audio.play.bind(__workbench.audio);__workbench.audio.play=(key,options)=>{if(key==='aicArea'&&options?.announce)__aicEntries++;return play(key,options)}})
 check('single Laurel settings registration',await page.evaluate(()=>__registrations.filter(r=>r.name==='settings.section').length===1&&__registrations.find(r=>r.name==='settings.section').id==='laurel-center'))
 check('seven real registry modules without research',await center().evaluate(()=>laurelParticleControl.snapshot().modules.length===7&&!laurelParticleControl.snapshot().modules.some(m=>m.id==='deep-research')))
 for(const family of ['si','industrial'])for(const mode of ['light','dark']){
  await page.evaluate(async({family,mode})=>{await __experience.change({theme:family==='si'?'wuling-particle-v03':'particle-v03',colorMode:mode,motion:false})},{family,mode})
  await page.waitForTimeout(150)
  const evidence=await page.evaluate(()=>{const r=document.documentElement,w=document.querySelector('[data-laurel-particle-frame]').contentDocument;return{family:r.dataset.laurelExperience,mode:r.dataset.laurelColor,rootSide:getComputedStyle(r).getPropertyValue('--lx-side'),frameSide:getComputedStyle(w.documentElement).getPropertyValue('--lx-side'),frameBg:getComputedStyle(w.body).backgroundColor,frameColor:w.documentElement.dataset.color,ink:[...w.querySelectorAll('.flow-selection')].map(e=>getComputedStyle(e).display),engine:w.defaultView.selectionFlow?.snapshot?.()}})
  check('shared '+family+' '+mode,evidence.family===family&&evidence.mode===mode&&evidence.frameColor===mode&&evidence.rootSide===evidence.frameSide,evidence)
  if(family==='industrial')check('industrial ink invisible '+mode,evidence.ink.every(d=>d==='none'),evidence.ink)
  if(family==='industrial')check('industrial ink engine paused '+mode,evidence.engine.paused===true)
  check('native geometry and type preserved '+family+' '+mode,await page.evaluate(()=>JSON.stringify(__geometryBefore)===JSON.stringify([...document.querySelectorAll('[data-row-key], [data-composer-card], nav[aria-label="Global panels"]')].map(e=>{const r=e.getBoundingClientRect();return[e.getAttribute('data-row-key')||e.tagName,r.x,r.y,r.width,r.height,getComputedStyle(e).font]}))))

  const caption=await page.evaluate(()=>{const e=document.createElement('span');e.style.cssText='background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary)';document.body.append(e);const bg=getComputedStyle(e).backgroundColor,text=getComputedStyle(e).color;e.style.backgroundColor='var(--lx-side)';e.style.color='var(--lx-text)';const expectedBg=getComputedStyle(e).backgroundColor,expectedText=getComputedStyle(e).color;e.remove();return{bg,text,expectedBg,expectedText,signal:[...document.head.childNodes].some(n=>n.nodeType===8&&n.data.startsWith('Laurel shell paint:'))}});
  check('native caption sync '+family+' '+mode,caption.signal&&caption.bg===caption.expectedBg&&caption.text===caption.expectedText,caption)
  await page.screenshot({path:out+'/'+family+'-'+mode+'.png'})
  if(process.env.QA_VISUAL&&family==='industrial'&&mode==='light')writeFileSync(out+'/footer-diagnostic.json',JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('.lx-sidebar *')].flatMap(e=>{const r=e.getBoundingClientRect();if(r.y<880)return[];return[{class:e.className,tag:e.tagName,html:e.outerHTML.slice(0,350),style:['','::before','::after'].map(p=>{const s=getComputedStyle(e,p||null);return{pseudo:p,bg:s.background,image:s.backgroundImage,content:s.content,shadow:s.boxShadow,filter:s.filter}})}]})),null,2))
  await page.evaluate(()=>{document.body.classList.remove('qa-center');document.querySelector('#qa-mount').style.display='none'});await page.screenshot({path:out+'/'+family+'-'+mode+'-shell.png'});await page.evaluate(()=>{document.body.classList.add('qa-center');document.querySelector('#qa-mount').style.display='flex'})
 }
 check('AIC entry announces once and not again on industrial day/night',await page.evaluate(()=>__aicEntries===1))
 if(process.env.QA_VISUAL){writeFileSync(out+'/visual-diagnostic.json',JSON.stringify(await page.evaluate(()=>({navs:[...document.querySelectorAll('nav')].slice(0,4).map(n=>({tag:n.outerHTML.slice(0,350),parents:[n,n.parentElement,n.parentElement?.parentElement,n.parentElement?.parentElement?.parentElement].filter(Boolean).map(e=>({class:e.className,bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color}))})),prefs:__experience.snapshot()})),null,2));await browser.close();materials.dispose();server.close();process.exit(0)}
 await center().locator('#experience').click();check('center shortcut opens shared settings',await page.locator('.lx-settings[open]').count()===1)
 await page.locator('[data-lx-tab=audio]').click();await page.locator('#lx-soundEffects').uncheck();check('effects preference persisted',JSON.parse(readFileSync(file,'utf8')).soundEffects===false)
 check('music independent of effects',JSON.parse(readFileSync(file,'utf8')).music===false)
 await page.locator('#lx-soundEffects').check();await page.waitForFunction(()=>__workbench.pc.getSnapshot().saved)
 await page.locator('#lx-test-area').click();await page.waitForTimeout(300);check('AIC preview routes actual allowlisted audio',audioRequests.some(s=>s.includes('aic-area')))
 await page.locator('[data-lx-tab=appearance]').click();await page.screenshot({path:out+'/settings-desktop.png'})
 await page.setViewportSize({width:480,height:800});await page.screenshot({path:out+'/settings-narrow.png'});check('settings contained at 480px',await page.locator('.lx-settings').evaluate(e=>e.scrollWidth<=e.clientWidth&&e.getBoundingClientRect().right<=480))
 await page.setViewportSize({width:1600,height:1000});await page.locator('[data-lx-close]').first().click()
 await page.evaluate(()=>__experience.update({motion:true}));
 // Snapshot must contain the native shell and a real nested center, with scripts stripped.
 await page.evaluate(()=>{window.__qaViewTransition=document.startViewTransition;document.startViewTransition=undefined})
 const pending=page.evaluate(()=>__experience.change({theme:'wuling-particle-v03',colorMode:'light'}));await page.waitForSelector('[data-lx-transition]')
 const captured=await page.locator('[data-lx-transition] iframe').first().getAttribute('srcdoc');check('full-shell inert snapshot includes sidebar and center',captured.includes('data-row-key')&&captured.includes('data-laurel-particle-frame')&&!captured.includes('<script'))
 check('transition snapshot cannot execute embedded scripts',await page.locator('[data-lx-transition] iframe').first().getAttribute('sandbox')==='allow-same-origin')
 await pending
 await page.evaluate(()=>{document.startViewTransition=window.__qaViewTransition})
 const wash=page.evaluate(()=>__experience.change({colorMode:'dark'}));await page.waitForFunction(()=>__experience.snapshot().transition.phase==='revealing');check('Si day/night uses ink wash',await page.evaluate(()=>__experience.snapshot().transition.kind==='ink'))
 await page.screenshot({path:out+'/si-wash-mid.png'});await wash
 await page.evaluate(()=>Promise.all([__experience.change({colorMode:'light'}),__experience.change({theme:'particle-v03',colorMode:'dark'}),__experience.change({colorMode:'light'})]));
 check('rapid switches keep latest theme intent and clean overlay',await page.evaluate(()=>__experience.snapshot().family==='industrial'&&__experience.snapshot().mode==='light'&&!document.querySelector('[data-lx-transition]')))
 await page.evaluate(()=>__experience.update({followSystemMotion:true}));await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>__experience.change({colorMode:'dark'}));check('system reduced motion bypasses transition',await page.locator('[data-lx-transition]').count()===0);await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>__experience.update({followSystemMotion:false}))
 failSave=true;await center().locator('#experience').click();await page.locator('#lx-mode').selectOption('light');await page.waitForFunction(()=>document.querySelector('#lx-feedback')?.dataset.error==='true');check('failed save shows explicit error',await page.locator('#lx-feedback').innerText().then(s=>s.includes('QA disk unavailable')));failSave=false
 await page.locator('#lx-mode').selectOption('dark');await page.waitForFunction(()=>__workbench.pc.getSnapshot().saved)
 await mount();const reloaded=await page.evaluate(()=>__experience.snapshot());check('theme and mode survive reload',reloaded.family==='industrial'&&reloaded.mode==='dark',{reloaded,disk:JSON.parse(readFileSync(file,'utf8'))})
 await page.evaluate(()=>__dispose());check('unload removes settings, transition, palette and iframe',await page.evaluate(()=>!document.querySelector('[data-lx-transition],.lx-settings,[data-laurel-particle-frame]')&&!document.documentElement.hasAttribute('data-laurel-experience')))
 missing=true;await mount();check('missing private material pack keeps seven module controls',await center().locator('[data-toggle]').count()===7);await page.screenshot({path:out+'/missing-materials.png'})
 check('no browser exceptions',errors.length===0,errors)
}finally{writeFileSync(out+'/browser-qa.json',JSON.stringify({scope:'Actual public built bundle and React 18 on preserved rc.5 native component fixture. Actual presentation admission/storage and private materials handlers. Mocked module state and slot/layout boundaries; not client GUI acceptance.',checks,errors,audioRequests},null,2));await browser.close();materials.dispose();await new Promise(r=>server.close(r))}
console.log(JSON.stringify({checks:checks.length,errors}));
