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
const out=process.env.LAUREL_QA_OUTPUT||new URL('../evidence/shadow-edge/',import.meta.url).pathname;mkdirSync(out,{recursive:true})
const file=out+'/qa-presentation.json';writePresentation(file,{theme:'wuling-v02',colorMode:'dark',experienceRevision:0,wallpaper:{},shadows:{},sound:false,music:false,volume:.21})
const handler=createPresentationHandler({file,connection:()=>({admit:()=>null})}),materials=createMaterialsHandler({root:process.env.LAUREL_QA_MATERIALS||out+'/empty-materials'})
const wallpaperHandler=createWallpaperHandler({root:out+'/images',admit:()=>null})
const root=readFileSync(process.env.LAUREL_QA_BUNDLE||new URL('../lib/client.js',import.meta.url),'utf8').replace('workbench.experience = experience','workbench.experience = experience;window.__experience=experience;window.__workbench=workbench;window.__siFlow=siFlow')
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
 await page.evaluate(async()=>{await __experience.update({theme:'particle-v03',colorMode:'light',motion:false,wallpaper:{enabled:false},shadows:{sidebar:{strength:0,distance:32,direction:'right'},header:{strength:0,distance:32},composer:{strength:0}}})})
 const plain=await page.addStyleTag({content:':root[data-laurel-experience]{--lx-bg:#eee!important;--lx-side:#eee!important}:root[data-laurel-experience] :is(.lx-sidebar,.lx-sidebar-column,.lx-conversation,.lx-conversation-header){background:#eee!important}:root[data-laurel-experience] :is(.lx-sidebar,.lx-conversation-header)>*,[data-conversation-content],[data-composer-card]{visibility:hidden!important}.lx-conversation{margin-top:24px!important}'})
 async function geometry(){return page.evaluate(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};return {side:rect(document.querySelector('.lx-sidebar-column')||document.querySelector('.lx-sidebar')),header:rect(document.querySelector('.lx-conversation-header'))}})}
 async function capture(){return [...await page.screenshot()]}
 async function differences(before,after,regions){return page.evaluate(async({before,after,regions})=>{async function pixels(bytes){const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'})),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();return ctx}const a=await pixels(before),b=await pixels(after);return Object.fromEntries(Object.entries(regions).map(([key,r])=>{const [x,y,w,h]=r.map(Math.round),aa=a.getImageData(x,y,w,h).data,bb=b.getImageData(x,y,w,h).data;let n=0,max=0;for(let i=0;i<aa.length;i+=4){const d=(aa[i]+aa[i+1]+aa[i+2]-bb[i]-bb[i+1]-bb[i+2])/3;n+=d;max=Math.max(max,Math.abs(d))}return[key,{darkening:n/(aa.length/4),maxDifference:max}]}))},{before,after,regions})}
 async function shadows(sidebar,header=0){await page.evaluate(async({sidebar,header})=>{const s=__experience.snapshot().preferences.shadows;await __experience.update({shadows:{...s,sidebar:{...s.sidebar,...sidebar},header:{...s.header,strength:header,distance:32}}})},{sidebar,header});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))}
 let g=await geometry(),zero=await capture();const seam=g.side.right,y=Math.max(140,g.header.bottom+80)
 await shadows({strength:60,distance:32,direction:'right'})
 let right=await capture(),diff=await differences(zero,right,{edge:[seam+2,y,8,80],topCap:[seam+72,g.side.top+2,6,8],farEdge:[seam+105,y,6,80],left:[seam-12,y,6,80]})
 check('right shadow affects only its seam, without top cap or far vertical edge',diff.edge.darkening>20&&diff.topCap.maxDifference<=1&&diff.farEdge.maxDifference<=1&&diff.left.maxDifference<=1,diff)
 check('shadow cannot intercept host controls',await page.evaluate(()=>[...document.querySelectorAll('.lx-edge-shadow')].every(e=>getComputedStyle(e).pointerEvents==='none'&&e.inert)))
 await page.screenshot({path:out+'/right-single-edge.png'})
 await shadows({direction:'left'})
 let left=await capture();diff=await differences(zero,left,{edge:[seam-10,y,8,80],topCap:[seam-72,g.side.top+2,6,8],bottomCap:[seam-72,g.side.bottom-10,6,8],right:[seam+3,y,6,80]})
 check('accepted left falloff remains, without top or bottom caps',diff.edge.darkening>20&&diff.topCap.maxDifference<=1&&diff.bottomCap.maxDifference<=1&&diff.right.maxDifference<=1,diff)
 await page.screenshot({path:out+'/left-single-edge.png'})
 await shadows({strength:0},60)
 let down=await capture(),h=g.header;diff=await differences(zero,down,{below:[h.left+140,h.bottom+2,80,8],top:[h.left+140,h.top+1,80,6],insideBottom:[h.left+140,h.bottom-8,80,6],left:[h.left+2,h.top+12,6,20],outsideTop:[h.left+140,h.top-7,80,6]})
 check('header casts down below tabs, leaving top, left and text area untouched',diff.below.darkening>20&&diff.top.maxDifference<=1&&diff.insideBottom.maxDifference<=1&&diff.left.maxDifference<=1&&diff.outsideTop.maxDifference<=1,diff)
 await page.screenshot({path:out+'/header-single-edge.png'})
 await shadows({strength:0},0)
 const resize=await page.evaluate(()=>{const side=document.querySelector('.lx-sidebar-column')||document.querySelector('.lx-sidebar');window.__shadowSide=side;window.__oldSide=side.getAttribute('style');side.style.boxSizing='border-box';side.style.width='56px';side.style.minWidth='56px';side.style.maxWidth='56px';side.style.flex='0 0 56px';const conversation=document.querySelector('.lx-conversation');Object.assign(conversation.style,{position:'fixed',left:side.getBoundingClientRect().right+'px',right:'0px',width:'auto',top:'0px',bottom:'0px'});return side.getBoundingClientRect().width})
 check('collapsed-width host geometry is actually exercised',Math.abs(resize-56)<1,{width:resize})
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
 zero=await capture();g=await geometry();await shadows({strength:60,direction:'right'},60)
 right=await capture();h=g.header;diff=await differences(zero,right,{doubleEdge:[g.side.right+54,200,6,40],sidebarCap:[g.side.right+72,2,6,8],headerTop:[h.left+140,h.top+1,80,6],headerBelow:[h.left+140,h.bottom+2,80,8]})
 check('56px sidebar produces no false opposite edge or top/header halo',diff.doubleEdge.darkening<8&&diff.sidebarCap.maxDifference<=1&&diff.headerTop.maxDifference<=1&&diff.headerBelow.darkening>20,diff)
 check('shadow geometry follows actual sidebar resize and header movement',await page.evaluate(()=>{const r=__shadowSide.getBoundingClientRect(),s=document.querySelector('.lx-sidebar-shadow').getBoundingClientRect(),h=document.querySelector('.lx-conversation-header').getBoundingClientRect(),d=document.querySelector('.lx-header-shadow').getBoundingClientRect();return Math.abs(s.left-r.right)<1&&Math.abs(d.top-h.bottom)<1&&Math.abs(d.left-h.left)<1&&Math.abs(h.left-r.right)<1}))
 await plain.evaluate(e=>e.remove())
 await page.screenshot({path:out+'/collapsed-light.png'})
 await page.evaluate(async()=>{await __experience.update({colorMode:'dark'})});await page.screenshot({path:out+'/collapsed-dark.png'})
 await page.evaluate(()=>__experience.open('wallpaper'));await page.locator('[data-lx-window-toggle]').click()
 await page.locator('[data-lx-shadow-range="sidebar"][data-lx-shadow-key="strength"]').fill('0');await page.locator('[data-lx-shadow-range="sidebar"][data-lx-shadow-key="strength"]').dispatchEvent('input')
 check('live zero strength removes sidebar edge only',await page.locator('.lx-sidebar-shadow').count()===0&&await page.locator('.lx-header-shadow').count()===1)
 await page.locator('[data-lx-shadow-range="sidebar"][data-lx-shadow-key="strength"]').fill('60');await page.locator('[data-lx-shadow-range="sidebar"][data-lx-shadow-key="strength"]').dispatchEvent('change');await page.waitForSelector('.lx-sidebar-shadow')
 await page.evaluate(()=>{document.querySelector('.lx-settings').close();__shadowSide.style.display='none';document.querySelector('.lx-conversation-header').style.display='none'})
 await page.waitForSelector('.lx-edge-shadow',{state:'detached'})
 check('hidden host targets leave no detached shadows',await page.locator('.lx-edge-shadow').count()===0)
 await page.evaluate(()=>{__shadowSide.style.display='';document.querySelector('.lx-conversation-header').style.display=''})
 await page.waitForFunction(()=>document.querySelectorAll('.lx-edge-shadow').length===2)
 await page.evaluate(()=>__dispose());check('unload removes every shadow layer',await page.locator('.lx-edge-shadow').count()===0)
 await mount();await page.evaluate(()=>{__togglePanel(false);document.querySelector('#qa-mount').style.display='none';document.body.classList.remove('qa-center')})
 await page.waitForFunction(()=>document.querySelectorAll('.lx-edge-shadow').length===2)
 check('fresh load preserves right direction and header strength',await page.evaluate(()=>{const s=__experience.snapshot().preferences.shadows;return s.sidebar.direction==='right'&&s.sidebar.strength===60&&s.header.strength===60}))
 await page.evaluate(()=>__experience.open('wallpaper'));await page.locator('#lx-shadows-reset').click();await page.waitForSelector('.lx-edge-shadow',{state:'detached'})
 check('reset disables both edges',await page.locator('.lx-edge-shadow').count()===0)
 await page.evaluate(()=>__dispose());check('no browser exceptions',errors.length===0,errors)
}finally{writeFileSync(out+'/qa.json',JSON.stringify({checks,errors},null,2));await browser.close();await new Promise(r=>server.close(r))}
