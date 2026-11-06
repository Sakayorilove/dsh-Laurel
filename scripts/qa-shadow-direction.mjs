import {qaOutput} from './private-output.mjs'
import {chromium} from 'playwright'
import {build} from 'esbuild'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createServer} from 'node:http'
import assert from 'node:assert/strict'
import {createPresentationHandler,writePresentation} from '../lib/ui-preferences.js'
import {createMaterialsHandler} from '../lib/private-materials.js'
import {createWallpaperHandler} from '../lib/wallpaper-store.js'
import {SUB_PLUGINS} from '../lib/registry.js'
const reference=process.env.LAUREL_QA_REFERENCE;if(!reference)throw Error('Set LAUREL_QA_REFERENCE to the preserved rc.5 native fixture project');
const out=qaOutput('shadow-direction')
const file=out+'/qa-presentation.json';writePresentation(file,{theme:'wuling-v02',colorMode:'dark',experienceRevision:0,wallpaper:{},shadows:{},sound:false,music:false,volume:.21})
const handler=createPresentationHandler({file,connection:()=>({admit:()=>null})}),materials=createMaterialsHandler({root:process.env.LAUREL_QA_MATERIALS||out+'/empty-materials'})
const wallpaperHandler=createWallpaperHandler({root:out+'/images',admit:()=>null})
const root=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8').replace('workbench.experience = experience','workbench.experience = experience;window.__experience=experience;window.__workbench=workbench;window.__siFlow=siFlow')
const reactBase=reference+'/source/node_modules/.pnpm/'
const boot=await build({stdin:{contents:`import React from '${reactBase}react@18.3.1/node_modules/react/index.js';import * as dom from '${reactBase}react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js';import {createPortal} from '${reactBase}react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js';window.__react=React;window.__dom={...dom,createPortal};`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'})
let failSave=false,missing=false;const audioRequests=[]
const server=createServer(async(req,res)=>{
 try{
 if(req.url.startsWith('/api/laurel-center/wallpapers'))return wallpaperHandler(req,res)
 if(req.url.startsWith('/api/laurel-center/presentation')){if(failSave&&req.method==='POST'){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"QA disk unavailable"}');return}return handler(req,res)}
 if(req.url.startsWith('/api/laurel-center/modules')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({enabled:Object.fromEntries(SUB_PLUGINS.map(p=>[p.id,true])),status:SUB_PLUGINS.map(p=>({id:p.id,mounted:true}))}));return}
 if(req.url.startsWith('/laurel-center/art/audio/'))audioRequests.push(req.url)
 if(req.url.startsWith('/laurel-center/materials')||req.url.startsWith('/laurel-center/art')){if(missing){res.writeHead(404);res.end();return}return req.url.startsWith('/laurel-center/art')?materials.legacy(req,res):materials.handler(req,res)}
 if(req.url==='/boot.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(boot.outputFiles[0].text);return}
 if(req.url==='/plugin.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(root);return}
 res.writeHead(200,{'content-type':'text/html'});res.end(readFileSync(reference+'/evidence/native-rich-fixture.html','utf8').replace("Object.defineProperty(window,'localStorage',{value:","Object.defineProperty(window,'localStorage',{configurable:true,writable:true,value:"))
 }catch(e){res.writeHead(500);res.end(String(e))}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({headless:true,args:['--disable-web-security','--autoplay-policy=no-user-gesture-required']})
const checks=[],errors=[];const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});console.log((pass?'PASS ':'FAIL ')+name);assert.ok(pass,name)}
const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',e=>errors.push(e.stack||String(e)))
await page.addInitScript(()=>{window.__qaNative={fetch:window.fetch.bind(window),Audio:window.Audio,AudioContext:window.AudioContext};if(!localStorage.getItem('laurel.harness-appearance.v03'))localStorage.setItem('laurel.harness-appearance.v03',JSON.stringify({colorMode:'light',theme:'si-paper-v01'}))})
async function mount(){
 await page.goto(url);await page.waitForFunction(()=>window.laurelNativePreview);await page.evaluate(()=>{laurelNativePreview.setOriginal(true);laurelNativePreview.dispose();for(const s of document.head.querySelectorAll('style'))if(s.textContent.includes('Laurel 0.3 applied to the unmodified')||s.textContent.includes('Palette: evidence/previous-color-samples'))s.remove();window.localStorage=window.__PREVIEW_STORAGE__;window.fetch=__qaNative.fetch;window.Audio=__qaNative.Audio;window.AudioContext=__qaNative.AudioContext;document.body.classList.add('qa-center')})
 await page.addStyleTag({content:'#preview-trigger,#preview-panel,.laurel-ambient,.native-preview-controls{display:none!important}body.qa-center [data-conversation-content],body.qa-center [data-composer-card]{visibility:hidden!important}.lx-wallpaper-layer{visibility:visible!important}#qa-mount{position:fixed;left:260px;top:40px;right:0;bottom:0;z-index:100000;background:var(--lx-side);display:flex;min-width:0}'})
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
  const Panel=registrations.find(x=>x.name==='main').component;const reactRoot=__dom.createRoot(mount);window.__togglePanel=on=>reactRoot.render(on?h(Panel,{renderSlot:()=>h('p',null,'QA native slot boundary')}):null);__togglePanel(true);
  window.__dispose=()=>{reactRoot.unmount();clean.reverse().forEach(fn=>fn());mount.remove()};
 });await page.waitForFunction(()=>document.querySelector('iframe[data-laurel-particle-frame]')?.contentWindow?.laurelParticleControl?.snapshot().modules.length===7).catch(async e=>{writeFileSync(out+'/mount-diagnostic.json',JSON.stringify(await page.evaluate(()=>({registrations:__registrations.map(x=>({name:x.name,key:x.key,id:x.id})),experience:__experience.snapshot(),frames:[...document.querySelectorAll('iframe')].map(f=>({title:f.title,text:f.contentDocument?.body?.innerText.slice(0,1000),snapshot:f.contentWindow?.laurelParticleControl?.snapshot()})),root:document.querySelector('#qa-mount').innerHTML.slice(0,2500)})),null,2));throw e})
 await page.waitForTimeout(450)
}
const center=()=>page.frames().find(f=>f!==page.mainFrame()&&f.url()==='about:srcdoc'&&f.parentFrame()===page.mainFrame())
try {
 await mount()
 await page.evaluate(()=>{__togglePanel(false);document.querySelector('#qa-mount').style.display='none';document.body.classList.remove('qa-center')})
 await page.addStyleTag({content:'body [data-conversation-content],body [data-composer-card]{visibility:visible!important}'})
 await page.evaluate(async()=>{await __experience.update({theme:'particle-v03',colorMode:'light',motion:false,wallpaper:{enabled:false},shadows:{sidebar:{strength:55,distance:24}}});__experience.open('wallpaper')})
 check('old configuration keeps original left direction',await page.locator('#lx-shadow-sidebar-direction').inputValue()==='left'&&await page.locator('.lx-sidebar-shadow[data-edge=left]').count()===1)
 await page.locator('[data-lx-window-toggle]').click()
 await page.locator('#lx-shadow-sidebar-direction').selectOption('right')
 await page.waitForSelector('.lx-sidebar-shadow')
 check('right direction persists without altering strength or distance',await page.evaluate(()=>{const s=__experience.snapshot().preferences.shadows.sidebar;return s.direction==='right'&&s.strength===55&&s.distance===24}))
 check('right shadow crosses the same boundary and cannot intercept input',await page.evaluate(()=>{const side=document.querySelector('.lx-sidebar-column')||document.querySelector('.lx-sidebar'),r=side.getBoundingClientRect(),s=document.querySelector('.lx-sidebar-shadow'),b=s.getBoundingClientRect();return Math.abs(b.left-r.right)<1&&Math.abs(b.top-r.top)<1&&Math.abs(b.height-r.height)<1&&getComputedStyle(s).pointerEvents==='none'&&document.elementFromPoint(b.left+2,b.top+100)!==s&&getComputedStyle(document.querySelector('.lx-sidebar')).boxShadow==='none'}))
 await page.evaluate(()=>document.querySelector('.lx-settings').close());await page.waitForSelector('.lx-settings',{state:'detached'})
 const plain=await page.addStyleTag({content:':root[data-laurel-experience]{--lx-bg:#eee!important;--lx-side:#eee!important}:root[data-laurel-experience] :is(.lx-sidebar,.lx-sidebar-column,.lx-conversation){background:#eee!important}:root[data-laurel-experience] :is(.lx-sidebar,.lx-conversation)>*{visibility:hidden!important}'})
 async function pixels(){const seam=await page.evaluate(()=>Math.round((document.querySelector('.lx-sidebar-column')||document.querySelector('.lx-sidebar')).getBoundingClientRect().right));const bytes=[...await page.screenshot()];return page.evaluate(async({bytes,seam})=>{const image=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'})),c=document.createElement('canvas');c.width=image.width;c.height=image.height;const x=c.getContext('2d');x.drawImage(image,0,0);image.close();const sample=dx=>{const a=x.getImageData(seam+dx,450,3,30).data;let n=0;for(let i=0;i<a.length;i+=4)n+=(a[i]+a[i+1]+a[i+2])/3;return n/(a.length/4)};return {left:sample(-9),right:sample(7),farLeft:sample(-80),farRight:sample(80),seam}},{bytes,seam})}
 const right=await pixels();await page.screenshot({path:out+'/right-proof.png'})
 await page.evaluate(async()=>{const s=__experience.snapshot().preferences.shadows;await __experience.update({shadows:{...s,sidebar:{...s.sidebar,direction:'left'}}})})
 const left=await pixels();await page.screenshot({path:out+'/left-proof.png'})
 check('rendered pixels confirm mirrored shadow across seam',right.right<right.left-12&&left.left<left.right-12&&Math.abs(right.left-left.right)<6,{right,left})
 await plain.evaluate(e=>e.remove())
 await page.evaluate(()=>__experience.open('wallpaper'))
 await page.locator('#lx-shadow-sidebar-direction').selectOption('right');await page.waitForSelector('.lx-sidebar-shadow')
 await page.evaluate(()=>document.querySelector('.lx-settings').close());await page.waitForSelector('.lx-settings',{state:'detached'})
 await page.screenshot({path:out+'/right-light.png'})
 await page.evaluate(async()=>{await __experience.update({colorMode:'dark'})});await page.screenshot({path:out+'/right-dark.png'})
 const widths=await page.evaluate(()=>{const e=document.querySelector('.lx-sidebar-column')||document.querySelector('.lx-sidebar');window.__shadowSide=e;window.__oldSideWidth=e.style.width;const r=e.getBoundingClientRect();e.style.width=(r.width-50)+'px';return r.width})
 await page.waitForFunction(()=>{const r=__shadowSide.getBoundingClientRect(),s=document.querySelector('.lx-sidebar-shadow').getBoundingClientRect();return Math.abs(r.right-s.left)<1})
 check('right shadow follows sidebar resize',await page.evaluate(()=>Math.abs(document.querySelector('.lx-sidebar-shadow').getBoundingClientRect().left-__shadowSide.getBoundingClientRect().right)<1))
 await page.evaluate(()=>{__shadowSide.style.display='none'})
 await page.waitForSelector('.lx-sidebar-shadow',{state:'detached'})
 check('collapsed sidebar leaves no floating shadow',await page.locator('.lx-sidebar-shadow').count()===0)
 await page.evaluate(()=>{__shadowSide.style.display='';__shadowSide.style.width=__oldSideWidth})
 await page.waitForSelector('.lx-sidebar-shadow')
 await page.evaluate(()=>__experience.open('wallpaper'))
 await page.locator('[data-lx-shadow-range="sidebar"][data-lx-shadow-key="strength"]').fill('0');await page.locator('[data-lx-shadow-range="sidebar"][data-lx-shadow-key="strength"]').dispatchEvent('input')
 check('zero strength removes right shadow immediately during input',await page.locator('.lx-sidebar-shadow').count()===0)
 await page.locator('[data-lx-shadow-range="sidebar"][data-lx-shadow-key="strength"]').fill('55');await page.locator('[data-lx-shadow-range="sidebar"][data-lx-shadow-key="strength"]').dispatchEvent('change')
 await page.waitForSelector('.lx-sidebar-shadow')
 await page.evaluate(()=>document.querySelector('.lx-settings').close());await page.waitForSelector('.lx-settings',{state:'detached'})
 await page.evaluate(()=>__dispose());check('unload removes shadow overlay',await page.locator('.lx-sidebar-shadow').count()===0)
 await mount();await page.evaluate(()=>{__togglePanel(false);document.querySelector('#qa-mount').style.display='none';document.body.classList.remove('qa-center')})
 await page.waitForSelector('.lx-sidebar-shadow')
 check('right direction restores on a fresh page',await page.evaluate(()=>__experience.snapshot().preferences.shadows.sidebar.direction==='right'))
 await page.evaluate(()=>__experience.open('wallpaper'))
 await page.locator('#lx-shadows-reset').click();await page.waitForSelector('.lx-sidebar-shadow',{state:'detached'})
 check('reset disables all shadows and restores current default left',await page.evaluate(()=>{const s=__experience.snapshot().preferences.shadows;return s.sidebar.direction==='left'&&Object.values(s).every(x=>x.strength===0)}))
 await page.evaluate(()=>__dispose());check('no browser exceptions',errors.length===0,errors)
}finally{writeFileSync(out+'/qa.json',JSON.stringify({checks,errors},null,2));await browser.close();await new Promise(r=>server.close(r))}
