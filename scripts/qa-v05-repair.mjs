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
const out=qaOutput('v05-repair')
const file=out+'/qa-presentation.json';writePresentation(file,{theme:'wuling-v02',colorMode:'dark',experienceRevision:0,sound:false,music:false,volume:.21})
const handler=createPresentationHandler({file,connection:()=>({admit:()=>null})}),materials=createMaterialsHandler({root:process.env.LAUREL_QA_MATERIALS||out+'/empty-materials'})
const root=readFileSync(new URL('../lib/client.js',import.meta.url),'utf8').replace('workbench.experience = experience','workbench.experience = experience;window.__experience=experience;window.__workbench=workbench;window.__siFlow=siFlow')
const reactBase=reference+'/source/node_modules/.pnpm/'
const boot=await build({stdin:{contents:`import React from '${reactBase}react@18.3.1/node_modules/react/index.js';import * as dom from '${reactBase}react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js';import {createPortal} from '${reactBase}react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js';window.__react=React;window.__dom={...dom,createPortal};`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'})
let failSave=false,missing=false;const audioRequests=[]
const server=createServer(async(req,res)=>{
 try{
 if(req.url.startsWith('/api/laurel-center/presentation')){if(failSave&&req.method==='POST'){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"QA disk unavailable"}');return}return handler(req,res)}
 if(req.url.startsWith('/api/laurel-center/modules')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({enabled:Object.fromEntries(SUB_PLUGINS.map(p=>[p.id,true])),status:SUB_PLUGINS.map(p=>({id:p.id,mounted:true}))}));return}
 if(req.url.startsWith('/laurel-center/art/audio/'))audioRequests.push(req.url)
 if(req.url.startsWith('/laurel-center/materials')||req.url.startsWith('/laurel-center/art')){if(missing){res.writeHead(404);res.end();return}return req.url.startsWith('/laurel-center/art')?materials.legacy(req,res):materials.handler(req,res)}
 if(req.url==='/boot.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(boot.outputFiles[0].text);return}
 if(req.url==='/plugin.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(root);return}
 res.writeHead(200,{'content-type':'text/html'});res.end(readFileSync(reference+'/evidence/native-rich-fixture.html'))
 }catch(e){res.writeHead(500);res.end(String(e))}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({headless:true,args:['--disable-web-security','--autoplay-policy=no-user-gesture-required','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']})
const checks=[],errors=[];const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});console.log((pass?'PASS ':'FAIL ')+name);assert.ok(pass,name)}
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

try {
 await page.emulateMedia({reducedMotion:'reduce'});
 await mount();
 const frame=center();
 await frame.waitForFunction(()=>laurelParticleControl.snapshot().scene?.sourcePoints>0,{timeout:30000});
 const snap=await frame.evaluate(()=>laurelParticleControl.snapshot());
 check('explicit full motion survives an OS reduce preference',snap.reduced===false&&snap.scene.reducedMotion===false,snap);
 if(!process.env.QA_UI_ONLY){
 const before=await frame.evaluate(()=>laurelParticleControl.snapshot().scene);
 await page.waitForTimeout(400);
 const after=await frame.evaluate(()=>laurelParticleControl.snapshot().scene);
 check('real WebGL frame clock and automatic rotation advance',after.frames>before.frames&&after.rotation!==before.rotation,{before,after});
 await frame.locator('#scene-style').click();await frame.locator('[data-model=factory]').click();await frame.locator('#scene-form button[type=submit]').click();await frame.waitForFunction(()=>!document.querySelector('#scene-dialog').open);
 await frame.locator('#replay').click();
 await frame.waitForFunction(()=>{const s=laurelParticleControl.snapshot().scene;return s.arrival<1&&s.rays>0});
 const forming=await frame.evaluate(()=>laurelParticleControl.snapshot().scene);
 check('replay starts peripheral gathering with an incomplete object',forming.arrival<1&&forming.rays>0,forming);
 await frame.waitForFunction(()=>laurelParticleControl.snapshot().scene.arrival===1);
 const formed=await frame.evaluate(()=>laurelParticleControl.snapshot().scene);
 check('gathering completes into the model while rotation continues',formed.arrival===1&&formed.rotation!==forming.rotation,formed);
 }
 // Pause only the already-verified particle model while measuring shell/UI animation on software WebGL.
 await frame.locator('#pause').click();
 await frame.locator('#pause').blur();
 await page.waitForFunction(()=>document.querySelector('nav[class*="_panelList"]')?.parentElement.classList.contains('lx-sidebar'));
 const localized=await page.evaluate(()=>{const nav=document.querySelector('nav[class*="_panelList"]');if(!nav)return{navs:[...document.querySelectorAll('nav')].map(e=>e.outerHTML.slice(0,200))};nav.setAttribute('aria-label','全局面板');return{label:nav.getAttribute('aria-label'),parent:nav.parentElement.className,paint:getComputedStyle(nav.parentElement).backgroundColor}});
 check('localized Chinese sidebar receives shared shell styling',localized.label==='全局面板'&&localized.parent.includes('lx-sidebar'),localized);
 await page.evaluate(()=>__experience.open('appearance'));
 check('settings removes only the redundant Functions tab',await page.locator('[data-lx-tab=functions]').count()===0&&await page.locator('[data-lx-tab]').count()===3);
 for(const width of [1600,480]){
  await page.setViewportSize({width,height:width===480?800:1000});
  const bounds=await page.locator('.lx-settings').evaluate(e=>{const r=e.getBoundingClientRect(),f=e.querySelector('.lx-foot').getBoundingClientRect(),b=e.querySelector('.lx-body');return{bottom:r.bottom,footBottom:f.bottom,view:innerHeight,scroll:b.scrollHeight>b.clientHeight}});
  check('restored settings keep actions visible at width '+width,bounds.bottom<=bounds.view&&bounds.footBottom<=bounds.bottom&&bounds.scroll,bounds);
 }
 await page.setViewportSize({width:1600,height:1000});
 check('all four original Si presets and precision/reset controls restored',await page.locator('[data-lx-si-theme]').count()===4&&await page.locator('#lx-canvas').count()===1&&await page.locator('#lx-motion-reset').count()===1);
 for(const [family,mode] of [['si-flow-v03','light'],['si-flow-v03','dark'],['si-paper-v01','light'],['si-paper-v01','dark']]){
  await page.locator(`[data-lx-si-theme="${family}"][data-lx-si-mode="${mode}"]`).click();
  await page.waitForFunction(({family,mode})=>__experience.snapshot().preferences.siTheme===family&&__experience.snapshot().mode===mode&&!__experience.snapshot().transition.active,{family,mode});
  const shell=await page.evaluate(()=>__experience.snapshot());
  check('restored preset persists and projects '+family+' '+mode,shell.harness.theme===family&&shell.harness.colorMode===mode,shell);
  const caption=await page.evaluate(()=>{const p=document.createElement('span');p.style.cssText='background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary)';document.body.append(p);const c=getComputedStyle(p);const result={bg:c.backgroundColor,text:c.color,signal:[...document.head.childNodes].some(n=>n.nodeType===8&&n.data.startsWith('Laurel shell paint:'))};p.style.backgroundColor='var(--lx-side)';p.style.color='var(--lx-text)';result.expectedBg=getComputedStyle(p).backgroundColor;result.expectedText=getComputedStyle(p).color;p.remove();return result});
  check('native caption probe shares '+family+' '+mode,caption.signal&&caption.bg===caption.expectedBg&&caption.text===caption.expectedText,caption);

  await page.screenshot({path:out+'/'+family+'-'+mode+'-settings.png'});
 }
 await page.locator('#lx-canvas').selectOption('actual');
 await page.waitForFunction(()=>__experience.snapshot().harness.canvasMode==='actual');
 await page.locator('[data-lx-close]').first().click();
 // Sample real animation masks at two distinct progress points, not just overlay presence.
 async function transitionCheck(patch,kind,label){
  const result=await page.evaluate(async patch=>{
   const samples=[];let source='',actualKind,display,rect;
   const observer=new MutationObserver(()=>{const e=document.querySelector('[data-lx-transition]');if(!e)return;const mask=e.style.maskImage;if(mask&&samples.at(-1)!==mask)samples.push(mask);source ||= e.querySelector('iframe')?.srcdoc||'';actualKind=e.dataset.lxTransition;display=getComputedStyle(e).display;const r=e.getBoundingClientRect();rect={width:r.width,height:r.height};});
   observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['style']});
   await __experience.change(patch);observer.disconnect();return{samples:samples.length,source,kind:actualKind,display,rect};
  },patch);
  check(label+' advances its actual mask over the whole shell',result.kind===kind&&result.samples>=3&&result.source.includes('data-laurel-particle-frame')&&result.source.includes('data-row-key')&&result.display!=='none'&&result.rect.width===1600,{...result,source:result.source.length});
  await page.screenshot({path:out+'/'+label+'-settled.png'});
 }
 await transitionCheck({colorMode:'light'},'ink','si-full-shell-wash');
 await transitionCheck({theme:'particle-v03',colorMode:'dark'},'industrial','industrial-full-shell-shutter');
 // Category position and selected row move with measured Web Animations, without ink.
 await frame.locator('[data-category=execution]').click();
 const horizontal=await frame.locator('.tab-indicator').evaluate(e=>e.getAnimations().map(a=>a.effect.getKeyframes()));
 check('industrial category selector animates horizontally',horizontal.some(frames=>frames.some(f=>String(f.transform).includes('translateX'))),horizontal);
 await page.waitForTimeout(360);
 const rows=await frame.locator('[data-select]').all();
 await rows[1].click();
 const vertical=await frame.locator('.industrial-row-indicator').evaluate(e=>e.getAnimations().map(a=>a.effect.getKeyframes()));
 check('industrial row selector animates vertically',vertical.some(frames=>frames.some(f=>String(f.transform).includes('translateY'))),vertical);
 check('industrial selection never uses ink',await frame.locator('.flow-selection').evaluateAll(es=>es.every(e=>getComputedStyle(e).display==='none')));
 await page.waitForTimeout(380);await page.screenshot({path:out+'/industrial-dark-selection.png'});
 await frame.locator('[data-open=warden]').click();
 await frame.waitForSelector('#detail-dialog[open]');
 const switchPaint=await frame.locator('#detail-enabled').evaluate(e=>({track:getComputedStyle(e).backgroundColor,thumb:getComputedStyle(e,'::before').backgroundColor,border:getComputedStyle(e).borderTopColor}));
 function lum(rgb){return rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0)}
 const track=lum(switchPaint.track),thumb=lum(switchPaint.thumb),contrast=(Math.max(track,thumb)+.05)/(Math.min(track,thumb)+.05);
 check('night module switch thumb and track have at least 3:1 contrast',contrast>=3,{...switchPaint,contrast});
 await page.screenshot({path:out+'/industrial-dark-switch.png'});
 await frame.locator('[data-close=detail-dialog]').first().click();await page.waitForTimeout(250);
 await frame.locator('#pause').click();
 await page.evaluate(()=>__experience.update({followSystemMotion:true}));
 await frame.waitForFunction(()=>laurelParticleControl.snapshot().reduced===true);
 const stopped=await frame.evaluate(()=>laurelParticleControl.snapshot().scene.frames);await page.waitForTimeout(180);
 check('optional follow-system reduces both DOM and WebGL',await frame.evaluate(stopped=>laurelParticleControl.snapshot().scene.frames===stopped,stopped));
 await page.evaluate(()=>__experience.open('appearance'));
 await page.locator('#lx-motion-reset').click();await frame.waitForFunction(()=>laurelParticleControl.snapshot().reduced===false&&laurelParticleControl.snapshot().scene.paused===false);
 check('one reset restores gathering, rotation and effects without OS changes',await page.evaluate(()=>__experience.snapshot().preferences.motion&&!__experience.snapshot().preferences.followSystemMotion&&!__experience.snapshot().harness.paused));
 await page.locator('[data-lx-close]').first().click();
 await mount();
 check('settings survive reload without reintroducing static mode',await page.evaluate(()=>!__experience.snapshot().reducedMotion&&__experience.snapshot().preferences.siTheme==='si-paper-v01'&&__experience.snapshot().harness.canvasMode==='fit'));
 check('no browser exceptions',errors.length===0,errors);
} finally {
 writeFileSync(out+'/repair-qa.json',JSON.stringify({scope:'Actual built bundle, React and real WebGL/canvas/WAAPI on retained rc.5 native fixture; real presentation/material handlers, controlled module/layout boundaries. Not desktop GUI acceptance.',checks,errors},null,2));
 await browser.close();materials.dispose();await new Promise(r=>server.close(r));
}
console.log(JSON.stringify({checks:checks.length,errors}));
