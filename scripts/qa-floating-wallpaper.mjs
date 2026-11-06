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
const out=qaOutput('floating-wallpaper')
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
 await page.locator('[data-footer-action="laurel"]').click({button:'right'})
 await page.waitForSelector('.lx-settings[open]')
 check('footer contextmenu opens Laurel settings',await page.locator('[data-lx-page="appearance"]').isVisible())
 await page.locator('[data-lx-tab="wallpaper"]').click()
 await page.waitForSelector('#lx-wallpaper-mode')
 check('native select options have explicit paired surfaces',await page.locator('[data-lx-wallpaper-fit="global"] option').first().evaluate(e=>getComputedStyle(e).backgroundColor!=='rgba(0, 0, 0, 0)'))
 check('wallpaper tab and independent shadow controls',await page.locator('[data-lx-shadow-range]').count()===6)
 await page.screenshot({path:out+'/settings-empty.png'})
 const file=out+'/wallpaper-probe.png'
 writeFileSync(file,Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1600;c.height=1000;const x=c.getContext('2d');for(const [color,left,top]of [['#8bb8ad',0,0],['#cfb085',800,0],['#8f9ebd',0,500],['#c18c8c',800,500]]){x.fillStyle=color;x.fillRect(left,top,800,500)}return c.toDataURL('image/png').split(',')[1]}),'base64'))
 await page.locator('[data-lx-wallpaper-file="global"]').setInputFiles(file)
 await page.waitForFunction(()=>__experience.snapshot().preferences.wallpaper.global.image)
 await page.waitForFunction(()=>[...document.querySelectorAll('.lx-wallpaper-layer img')].every(i=>i.complete&&i.naturalWidth>0))
 let p=await page.evaluate(()=>__experience.snapshot().preferences)
 check('local PNG imported, converted, persisted and enabled',p.wallpaper.enabled&&/^[a-f0-9]{64}\.webp$/.test(p.wallpaper.global.image)&&readFileSync(out+'/qa-presentation.json','utf8').includes(p.wallpaper.global.image))
 const hash=p.wallpaper.global.image
 check('composer outer seat exposes wallpaper without changing card',await page.evaluate(()=>{const e=document.querySelector('[class*="_composerSeat"]');return e&&getComputedStyle(e).backgroundImage==='none'&&getComputedStyle(e).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(document.querySelector('[data-composer-card]')).backgroundColor!=='rgba(0, 0, 0, 0)'}))
 await page.locator('[data-lx-window-toggle]').click()
 check('floating settings is modeless and underlying host is interactive',await page.evaluate(()=>{const d=document.querySelector('.lx-settings');const b=document.querySelector('[data-footer-action="laurel"]');const r=b.getBoundingClientRect();return d.open&&!d.matches(':modal')&&!document.body.inert&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b}))
 let bounds=await page.locator('.lx-settings').boundingBox()
 await page.mouse.move(bounds.x+65,bounds.y+30);await page.mouse.down();await page.mouse.move(bounds.x-190,bounds.y+90,{steps:15});await page.mouse.up()
 let moved=await page.locator('.lx-settings').boundingBox()
 check('title drag moves actual settings',moved.x<bounds.x-150&&moved.y>bounds.y+40)
 await page.mouse.move(moved.x+moved.width-3,moved.y+moved.height-3);await page.mouse.down();await page.mouse.move(moved.x+moved.width+130,moved.y+moved.height+70,{steps:15});await page.mouse.up()
 const resized=await page.locator('.lx-settings').boundingBox()
 check('corner resize changes window and retains scrolling body',resized.width>moved.width+100&&resized.height>moved.height+40&&await page.locator('.lx-body').evaluate(e=>e.scrollHeight>e.clientHeight))
 const realBody=page.locator('[data-lx-wallpaper-range="global"][data-lx-wallpaper-key="blur"]')
 await realBody.fill('9');await realBody.dispatchEvent('input')
 check('floating adjustment previews on real host during input',await page.locator('.lx-wallpaper-layer img').first().evaluate(e=>getComputedStyle(e).filter==='blur(9px)'))
 await realBody.dispatchEvent('change')
 await page.screenshot({path:out+'/floating-live.png'})
 for(const fit of ['cover','fill','contain','tile']){
   await page.locator('[data-lx-wallpaper-fit="global"]').selectOption(fit)
   await page.waitForFunction(fit=>__experience.snapshot().preferences.wallpaper.global.fit===fit,fit)
   check('placement '+fit+' fills both region layers',await page.evaluate(fit=>[...document.querySelectorAll('.lx-wallpaper-layer')].every(l=>{const i=l.firstElementChild,e=l.querySelector('.lx-wallpaper-extra'),r=l.getBoundingClientRect(),v=(fit==='tile'?e:i).getBoundingClientRect();return v.left<=r.left&&v.top<=r.top&&v.right>=r.right&&v.bottom>=r.bottom&&(fit!=='contain'||getComputedStyle(e).backgroundSize==='cover')&&(fit!=='tile'||getComputedStyle(e).backgroundRepeat==='repeat')}),fit))
   await page.screenshot({path:out+'/placement-'+fit+'.png'})
 }
 const portrait=out+'/portrait-probe.png'
 writeFileSync(portrait,Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=360;c.height=1200;const x=c.getContext('2d');x.fillStyle='#af815f';x.fillRect(0,0,360,1200);x.fillStyle='#72aba1';x.fillRect(0,0,180,1200);return c.toDataURL('image/png').split(',')[1]}),'base64'))
 await page.locator('[data-lx-wallpaper-file="global"]').setInputFiles(portrait)
 await page.waitForFunction(()=>document.querySelector('.lx-wallpaper-layer img')?.naturalHeight>1000)
 for(const fit of ['cover','fill','contain','tile']){await page.locator('[data-lx-wallpaper-fit="global"]').selectOption(fit);await page.waitForFunction(fit=>__experience.snapshot().preferences.wallpaper.global.fit===fit,fit);await page.screenshot({path:out+'/portrait-'+fit+'.png'});check('portrait '+fit+' no empty layer',await page.locator('.lx-wallpaper-layer').count()>=2)}
 await page.locator('[data-lx-wallpaper-file="global"]').setInputFiles(file)
 await page.waitForFunction(()=>document.querySelector('.lx-wallpaper-layer img')?.naturalWidth===1600)
 await page.locator('[data-lx-wallpaper-fit="global"]').selectOption('cover')
 for(let n=0;n<3;n++){await page.locator('[data-lx-window-toggle]').click();check('return modal '+n,await page.locator('.lx-settings').evaluate(e=>e.matches(':modal')));await page.locator('[data-lx-window-toggle]').click()}
 await page.locator('[data-lx-window-reset]').click()
 check('reset keeps floating window within viewport',await page.locator('.lx-settings').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=8&&r.top>=8&&r.right<=innerWidth-8&&r.bottom<=innerHeight-8}))
 await page.keyboard.press('Escape');await page.waitForSelector('.lx-settings',{state:'detached'})
 await page.locator('[data-footer-action="laurel"]').click({button:'right'})
 check('reopen retains floating mode with one sheet',await page.locator('.lx-settings').count()===1&&await page.locator('.lx-settings').evaluate(e=>!e.matches(':modal')))
 await page.locator('[data-lx-tab="wallpaper"]').click()
 await page.locator('[data-lx-window-toggle]').click()
 check('native composer and conversation remain visible',await page.locator('[data-composer-card]').first().isVisible()&&await page.locator('[data-conversation-content]').first().isVisible())
 check('global wallpaper reaches native sidebar and conversation',await page.locator('.lx-wallpaper-layer').count()>=2)
 check('native conversation paint exposes wallpaper',await page.evaluate(()=>getComputedStyle(document.querySelector('[data-conversation-content]')).backgroundColor==='rgba(0, 0, 0, 0)'))
 await page.locator('[data-lx-wallpaper-range="global"][data-lx-wallpaper-key="blur"]').fill('14');await page.locator('[data-lx-wallpaper-range="global"][data-lx-wallpaper-key="blur"]').dispatchEvent('change')
 await page.locator('[data-lx-wallpaper-range="global"][data-lx-wallpaper-key="opacity"]').fill('36');await page.locator('[data-lx-wallpaper-range="global"][data-lx-wallpaper-key="opacity"]').dispatchEvent('change')
 await page.waitForFunction(()=>__experience.snapshot().preferences.saved)
 check('blur and opacity apply only to images',await page.evaluate(()=>[...document.querySelectorAll('.lx-wallpaper-layer img')].every(i=>getComputedStyle(i).filter==='blur(14px)'&&getComputedStyle(i).opacity==='0.36')&&getComputedStyle(document.querySelector('[data-conversation-content]')).filter==='none'))
 await page.locator('#lx-wallpaper-mode').selectOption('separate')
 check('separate empty slots do not borrow global image',await page.locator('.lx-wallpaper-layer').count()===0)
 await page.locator('[data-lx-wallpaper-file="sidebar"]').setInputFiles(file)
 await page.waitForFunction(()=>__experience.snapshot().preferences.wallpaper.sidebar.image)
 check('sidebar image independently enabled',await page.locator('.lx-wallpaper-layer').count()===1)
 await page.locator('[data-lx-wallpaper-file="conversation"]').setInputFiles(file)
 await page.waitForFunction(()=>__experience.snapshot().preferences.wallpaper.conversation.image)
 await page.locator('[data-lx-shadow-range="sidebar"][data-lx-shadow-key="strength"]').fill('35');await page.locator('[data-lx-shadow-range="sidebar"][data-lx-shadow-key="strength"]').dispatchEvent('change')
 await page.locator('[data-lx-shadow-range="composer"][data-lx-shadow-key="distance"]').fill('20');await page.locator('[data-lx-shadow-range="composer"][data-lx-shadow-key="distance"]').dispatchEvent('change')
 await page.locator('[data-lx-shadow-range="composer"][data-lx-shadow-key="strength"]').fill('30');await page.locator('[data-lx-shadow-range="composer"][data-lx-shadow-key="strength"]').dispatchEvent('change')
 await page.locator('[data-lx-shadow-range="header"][data-lx-shadow-key="strength"]').fill('25');await page.locator('[data-lx-shadow-range="header"][data-lx-shadow-key="strength"]').dispatchEvent('change')
 check('three shadow properties and composer distance',await page.evaluate(()=>getComputedStyle(document.querySelector('[data-composer-card]')).boxShadow.includes('20px')&&getComputedStyle(document.querySelector('.lx-header-shadow .lx-edge-shadow-ink')).boxShadow.includes('0.25')&&getComputedStyle(document.querySelector('.lx-sidebar-shadow .lx-edge-shadow-ink')).boxShadow.includes('0.35')))
 await page.locator('#lx-wallpaper-mode').selectOption('global')
 check('global configuration retained after switching modes',await page.evaluate(()=>{const w=__experience.snapshot().preferences.wallpaper;return w.global.blur===14&&w.global.opacity===36&&w.sidebar.image&&w.conversation.image}))
 await page.screenshot({path:out+'/settings-configured.png'})
 await page.evaluate(()=>document.querySelector('.lx-settings').close())
 for(const theme of ['si-paper-v01','si-flow-v03'])for(const colorMode of ['light','dark']){
  await page.evaluate(async p=>{await __experience.update({theme:'wuling-particle-v03',siTheme:p.theme,colorMode:p.colorMode});}, {theme,colorMode});await page.waitForTimeout(250)
  const values=await page.evaluate(()=>{const composer=document.querySelector('[data-composer-card]');return {floating:getComputedStyle(document.body).getPropertyValue('--dsw-alias-button-floating-fill'),selector:getComputedStyle(document.body).getPropertyValue('--dsw-specific-selector'),ink:getComputedStyle(document.body).getPropertyValue('--dsw-alias-label-primary'),layers:[...document.querySelectorAll('.lx-wallpaper-layer')].map(e=>({rect:e.getBoundingClientRect().toJSON(),filter:getComputedStyle(e.firstElementChild).filter})),composerFilter:getComputedStyle(composer).filter}})
  check(theme+' '+colorMode+' keeps wallpaper and paired button colors',values.layers.length>=2&&values.selector&&values.floating&&values.ink&&values.composerFilter==='none',values)
  const native=await page.evaluate(()=>[...document.querySelectorAll('button')].filter(e=>e.className.includes('_add')||e.className.includes('_toBottom')).map(e=>({label:e.getAttribute('aria-label'),color:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor})))
  check(theme+' '+colorMode+' native buttons have solid matching surfaces',native.length>=1&&native.every(b=>b.bg!=='rgb(51, 51, 51)'),native)
  await page.screenshot({path:out+'/'+theme+'-'+colorMode+'.png'})
 }
 await page.setViewportSize({width:720,height:760});await page.waitForTimeout(100)
 check('global image resizes with viewport',await page.evaluate(()=>[...document.querySelectorAll('.lx-wallpaper-layer img')].every(i=>i.style.width==='804px')))
 await page.evaluate(()=>__experience.open('wallpaper'));await page.screenshot({path:out+'/narrow-settings.png'})
 await page.locator('#lx-wallpaper-enabled').uncheck()
 check('disable removes image layers',await page.locator('.lx-wallpaper-layer').count()===0)
 await page.locator('#lx-wallpaper-enabled').check()
 check('enable restores saved image',await page.locator('.lx-wallpaper-layer').count()>=2)
 await page.evaluate(()=>document.querySelector('.lx-settings').close())
 await page.waitForFunction(()=>__experience.snapshot().preferences.saved)
 await page.evaluate(()=>__dispose())
 await mount();await page.evaluate(()=>{__togglePanel(false);document.querySelector('#qa-mount').style.display='none';document.body.classList.remove('qa-center')})
 check('wallpaper and shadows restored from host after a fresh page',await page.evaluate(()=>{const p=__experience.snapshot().preferences;return p.wallpaper.enabled&&p.wallpaper.global.blur===14&&p.shadows.composer.distance===20&&p.shadows.composer.strength===30}))
 await page.evaluate(()=>__dispose())
 check('unload removes layers and variables',await page.evaluate(()=>!document.querySelector('.lx-wallpaper-layer')&&!document.documentElement.hasAttribute('data-lx-wallpaper')&&!document.documentElement.style.getPropertyValue('--lx-shadow-header')))
 check('zero browser exceptions',errors.length===0,errors)
}finally{writeFileSync(out+'/qa.json',JSON.stringify({checks,errors},null,2));await browser.close();await new Promise(r=>server.close(r))}
