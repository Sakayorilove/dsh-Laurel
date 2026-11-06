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
const out=qaOutput('ui-repair3')
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
 res.writeHead(200,{'content-type':'text/html'});res.end(readFileSync(reference+'/evidence/native-rich-fixture.html','utf8').replace("Object.defineProperty(window,'localStorage',{value:","Object.defineProperty(window,'localStorage',{configurable:true,writable:true,value:"))
 }catch(e){res.writeHead(500);res.end(String(e))}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({headless:true,args:['--disable-web-security','--autoplay-policy=no-user-gesture-required']})
const checks=[],errors=[];const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});console.log((pass?'PASS ':'FAIL ')+name);assert.ok(pass,name)}
const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',e=>errors.push(e.stack||String(e)))
await page.addInitScript(()=>{window.__qaNative={fetch:window.fetch.bind(window),Audio:window.Audio,AudioContext:window.AudioContext};if(!localStorage.getItem('laurel.harness-appearance.v03'))localStorage.setItem('laurel.harness-appearance.v03',JSON.stringify({colorMode:'light',theme:'si-paper-v01'}))})
async function mount(){
 await page.goto(url);await page.waitForFunction(()=>window.laurelNativePreview);await page.evaluate(()=>{laurelNativePreview.setOriginal(true);laurelNativePreview.dispose();for(const s of document.head.querySelectorAll('style'))if(s.textContent.includes('Laurel 0.3 applied to the unmodified')||s.textContent.includes('Palette: evidence/previous-color-samples'))s.remove();window.localStorage=window.__PREVIEW_STORAGE__;window.fetch=__qaNative.fetch;window.Audio=__qaNative.Audio;window.AudioContext=__qaNative.AudioContext;document.body.classList.add('qa-center')})
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
  const Panel=registrations.find(x=>x.name==='main').component;const reactRoot=__dom.createRoot(mount);window.__togglePanel=on=>reactRoot.render(on?h(Panel,{renderSlot:()=>h('p',null,'QA native slot boundary')}):null);__togglePanel(true);
  window.__dispose=()=>{reactRoot.unmount();clean.reverse().forEach(fn=>fn());mount.remove()};
 });await page.waitForFunction(()=>document.querySelector('iframe[data-laurel-particle-frame]')?.contentWindow?.laurelParticleControl?.snapshot().modules.length===7).catch(async e=>{writeFileSync(out+'/mount-diagnostic.json',JSON.stringify(await page.evaluate(()=>({registrations:__registrations.map(x=>({name:x.name,key:x.key,id:x.id})),experience:__experience.snapshot(),frames:[...document.querySelectorAll('iframe')].map(f=>({title:f.title,text:f.contentDocument?.body?.innerText.slice(0,1000),snapshot:f.contentWindow?.laurelParticleControl?.snapshot()})),root:document.querySelector('#qa-mount').innerHTML.slice(0,2500)})),null,2));throw e})
 await page.waitForTimeout(450)
}
const center=()=>page.frames().find(f=>f!==page.mainFrame()&&f.url()==='about:srcdoc'&&f.parentFrame()===page.mainFrame())
try {
 await page.addInitScript(()=>{
   if(window.top===window){window.__paints=[];return}
   const record=()=>{try{if(window.frameElement?.hasAttribute('data-laurel-particle-frame'))window.top.__paints.push({theme:document.documentElement.dataset.theme,color:document.documentElement.dataset.color,revision:document.documentElement.dataset.revision,visible:getComputedStyle(window.frameElement).visibility,bg:getComputedStyle(document.body).backgroundColor})}catch{}};
   let frames=0;const trace=()=>{if(document.body)record();if(++frames<90)requestAnimationFrame(trace)};requestAnimationFrame(trace)
 });
 await mount();await page.waitForFunction(()=>__experience.snapshot().preferences.experienceRevision===5);
 await page.evaluate(()=>__experience.update({theme:'wuling-particle-v03',colorMode:'light',motion:false}));
 await center().locator('#pause').evaluate(e=>{if(!e.disabled&&e.getAttribute('aria-pressed')!=='true')e.click()});
 for(let i=0;i<3;i++){
   await page.evaluate(()=>{__togglePanel(false);__paints=[]});await page.waitForTimeout(80);
   await page.evaluate(()=>__togglePanel(true));
   await page.waitForFunction(()=>document.querySelector('[data-laurel-particle-frame]')?.contentWindow?.laurelParticleControl?.snapshot().modules.length===7);
   await page.waitForTimeout(100);
   const paints=await page.evaluate(()=>({source:document.querySelector('[data-laurel-particle-frame]').srcdoc.slice(0,900),paints:__paints,theme:document.querySelector('[data-laurel-particle-frame]').contentWindow.laurelParticleControl.snapshot().theme}));
   check('Si day center opens without a dark or industrial frame #'+i,paints.source.includes('data-initial-theme="si"')&&paints.source.includes('data-color="light"')&&paints.paints.length>0&&paints.paints.every(p=>p.visible==='hidden'||p.theme==='si'&&p.color==='light')&&paints.theme.mode==='light',paints);
   await center().locator('#pause').evaluate(e=>{if(!e.disabled&&e.getAttribute('aria-pressed')!=='true')e.click()});
 }
 // Restore actual native conversation after the fixture's center visibility guard.
 await page.addStyleTag({content:'body.qa-center [data-conversation-content]{visibility:visible!important}'});
 await page.evaluate(()=>{
   const flow=document.querySelector('[data-conversation-content]');
   const region=document.createElement('section');region.id='readability-samples';
   region.innerHTML='<div class="LOmM4q_fileCard"><div class="LOmM4q_fileName">meta.md</div><div class="LOmM4q_fileMeta">版本时间线 / 配队 / 素材分配表</div></div><div class="_block_7gxqk_4"><div class="_header_1pq26_10">代码块</div><pre><code>&lt;workspace&gt;/.dsh-research/ledger.jsonl    证据台账（唯一真相）</code></pre></div>';
   flow.append(region);
 });
 function contrast(a,b){const rgb=s=>s.match(/[0-9.]+/g).slice(0,3).map(Number).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4});const lum=s=>rgb(s).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
 for(const siTheme of ['si-paper-v01','si-flow-v03']){
   await page.evaluate(siTheme=>__experience.update({siTheme}),siTheme);await page.waitForTimeout(80);
   const colors=await page.locator('#readability-samples').evaluate(e=>{const card=e.firstElementChild,pre=e.querySelector('pre'),block=pre.parentElement;return{card:getComputedStyle(card).backgroundColor,title:getComputedStyle(card.firstElementChild).color,meta:getComputedStyle(card.lastElementChild).color,pre:getComputedStyle(pre).backgroundColor,code:getComputedStyle(pre.querySelector('code')).color,block:getComputedStyle(block).backgroundColor}});
   const ratios={title:contrast(colors.title,colors.card),meta:contrast(colors.meta,colors.card),code:contrast(colors.code,colors.pre),block:contrast(colors.code,colors.block)};
   check(siTheme+' day file title, metadata and code have 4.5:1 contrast',Object.values(ratios).every(v=>v>=4.5),{colors,ratios});
 }
 await page.evaluate(()=>{__togglePanel(false);document.querySelector('#qa-mount').style.display='none'});await page.screenshot({path:out+'/day-readability.png'});
 await page.evaluate(()=>{document.querySelector('#qa-mount').style.display='flex';__togglePanel(true)});await page.waitForFunction(()=>document.querySelector('[data-laurel-particle-frame]')?.contentWindow?.laurelParticleControl?.snapshot().modules.length===7);await center().locator('#pause').evaluate(e=>{if(!e.disabled&&e.getAttribute('aria-pressed')!=='true')e.click()});
 await page.evaluate(()=>__experience.update({theme:'particle-v03',colorMode:'dark',motion:true}));
 async function sampleTransition(patch,label,nativeExpected){
   const pending=page.evaluate(async patch=>{
     let count=0;const masks=new Set(),frames=[],corners=[];let last=0;
     const watch=()=>{const e=document.querySelector('[data-lx-transition]');if(e){count++;if(e.style.maskImage)masks.add(e.style.maskImage);if(last)frames.push(performance.now()-last);last=performance.now()}request=requestAnimationFrame(watch)};let request=requestAnimationFrame(watch);
     const started=performance.now();await __experience.change(patch);cancelAnimationFrame(request);
     return{kind:__experience.snapshot().transition.kind,masks:masks.size,count,frames,ms:performance.now()-started,native:typeof document.startViewTransition==='function',active:!!document.querySelector('[data-lx-transition]'),nativeStyle:!!document.querySelector('style[data-wash]')};
   },patch);
   await page.waitForFunction(()=>__experience.snapshot().transition.phase==='revealing');
   await page.waitForTimeout(220);
   if(nativeExpected){const held=await page.evaluate(()=>document.getAnimations().some(a=>a.animationName==='lx-snapshot-hold'&&a.playState==='running'));check(label+' keeps the browser snapshot alive during the brush',held);}
   await page.screenshot({path:out+'/'+label.replaceAll(' ','-').replaceAll('/','-')+'-mid.png'});
   const result=await pending;
   check(label+' reveals multiple continuous brush stages and cleans up',result.kind==='ink'&&result.masks>=3&&!result.active&&result.count>=3,result);
   check(label+' uses native live-pixel capture when available',nativeExpected===result.native,result);
 }
 await sampleTransition({theme:'wuling-particle-v03',colorMode:'light'},'industrial to Si corner stroke',true);
 await sampleTransition({colorMode:'dark'},'Si day/night corner stroke',true);
 await page.evaluate(()=>{document.startViewTransition=undefined});
 await sampleTransition({colorMode:'light'},'older browser snapshot fallback',false);
 await page.evaluate(()=>Promise.all([__experience.change({colorMode:'dark'}),__experience.change({colorMode:'light'})]));
 check('rapid switches retain the final day intent and remove overlays',await page.evaluate(()=>__experience.snapshot().mode==='light'&&!document.querySelector('[data-lx-transition]')));
 await page.evaluate(()=>{__togglePanel(false);document.querySelector('#qa-mount').style.display='none'});
 const research=readFileSync(process.env.LAUREL_QA_RESEARCH+'/lib/client.js','utf8');await page.addScriptTag({content:research});
 await page.evaluate(()=>{
   const regs=[],cleanup=[];window.__researchCommands=0;
   const ctx={effect(fn){const c=fn();if(typeof c==='function')cleanup.push(c)},slots:{inject(name,fn){return fn()},register(meta,component){regs.push({...meta,component});return()=>{}}},remote:{commands:{execute(){__researchCommands++;return Promise.resolve()}}}};
   __factories['dsh-deep-research'](key=>key==='react'?__react:null).apply(ctx);
   const Monitor=regs.find(r=>r.id==='dsh-deep-research:monitor').component,Settings=regs.find(r=>r.id==='deep-research').component;
   const div=document.createElement('div');div.id='research-qa';div.style.cssText='position:fixed;inset:50px 60px;background:var(--lx-bg);z-index:999999;overflow:auto';document.body.append(div);const rr=__dom.createRoot(div);
   const render=()=>rr.render(__react.createElement(__react.Fragment,null,__react.createElement(Monitor),__react.createElement(Settings)));render();window.__researchRender=render;
   window.__researchDispose=()=>{rr.unmount();div.remove();cleanup.reverse().forEach(f=>f())};
 });
 const monitor=page.getByTestId('deep-research-monitor'),toggle=page.getByRole('switch',{name:'显示深度科研悬浮窗'});
 await monitor.waitFor();await toggle.uncheck();await page.waitForTimeout(80);
 check('settings switch hides the actual research monitor immediately',await monitor.count()===0);
 check('hide persists and never toggles research mode',await page.evaluate(()=>localStorage.getItem('dsh-deep-research:monitor-visible')==='false'&&__researchCommands===0));
 await toggle.check();await monitor.waitFor();check('settings switch restores the actual research monitor',await monitor.count()===1);
 await page.getByRole('button',{name:'隐藏深度科研悬浮窗'}).click();await page.waitForTimeout(50);
 check('monitor close button updates the same settings switch',await monitor.count()===0&&!(await toggle.isChecked()));
 await page.screenshot({path:out+'/research-hidden-setting.png'});
 await page.evaluate(()=>{__researchDispose();__dispose()});await page.reload();await page.waitForFunction(()=>window.laurelNativePreview);await page.evaluate(()=>{laurelNativePreview.dispose();window.localStorage=window.__PREVIEW_STORAGE__});await page.addScriptTag({url:url+'/boot.js'});await page.evaluate(()=>{window.__factories={};window.__ModuleLoader__={load(o){__factories[o.id]=o.factory}}});await page.addScriptTag({content:research});
 const reload=await page.evaluate(()=>{const regs=[];__factories['dsh-deep-research'](key=>key==='react'?__react:null).apply({effect:f=>f(),remote:{commands:{execute(){throw Error('Unexpected research command')}}},slots:{inject:(_,fn)=>fn(),register:(meta,component)=>regs.push({...meta,component})}});const div=document.createElement('div');document.body.append(div);__dom.createRoot(div).render(__react.createElement(regs.find(r=>r.id==='dsh-deep-research:monitor').component));return localStorage.getItem('dsh-deep-research:monitor-visible')});await page.waitForTimeout(150);
 check('a full document reload keeps the monitor hidden',reload==='false'&&await page.getByTestId('deep-research-monitor').count()===0,{reload,monitors:await page.getByTestId('deep-research-monitor').evaluateAll(es=>es.map(e=>e.outerHTML.slice(0,500)))});
 check('no browser exceptions',errors.length===0,errors);
} finally {
 writeFileSync(out+'/qa.json',JSON.stringify({scope:'Real built public/private client bundles, React 18 and preserved native rc.5 components; isolated local API and mocked slot boundary; no real profile or research task.',checks,errors},null,2));
 await browser.close();materials.dispose();await new Promise(r=>server.close(r));
}
console.log(JSON.stringify({checks:checks.length,errors}));
