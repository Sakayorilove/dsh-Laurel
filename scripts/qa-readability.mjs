import {presentationStoreFixture} from './qa-store-fixture.mjs'
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
const out=qaOutput('readability')
const file=out+'/qa-presentation.json';writePresentation(file,{theme:'wuling-v02',colorMode:'dark',experienceRevision:0,wallpaper:{},shadows:{},sound:false,music:false,volume:.21})
const handler=createPresentationHandler({file,connection:()=>({admit:()=>null})}),materials=createMaterialsHandler({root:process.env.LAUREL_QA_MATERIALS||out+'/empty-materials'})
const wallpaperHandler=createWallpaperHandler({root:out+'/images',admit:()=>null})
const root=readFileSync(process.env.LAUREL_QA_BUNDLE||new URL('../lib/client.js',import.meta.url),'utf8').replace('workbench.experience = experience','workbench.experience = experience;window.__experience=experience;window.__workbench=workbench;window.__siFlow=siFlow')
const reactBase=reference+'/source/node_modules/.pnpm/'
const boot=await build({stdin:{contents:`import React from '${reactBase}react@18.3.1/node_modules/react/index.js';import * as jsx from '${reactBase}react@18.3.1/node_modules/react/jsx-runtime.js';import * as dom from '${reactBase}react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js';import {createPortal} from '${reactBase}react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js';window.__react=React;window.__jsx=jsx;window.__dom={...dom,createPortal};`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'})
// The caller supplies the installed host source outside the public repository.
// Render its actual SettingsPanel and CSS; only modal focus management and slot data are synthetic.
const settingsSource=process.env.LAUREL_QA_SETTINGS_SOURCE?readFileSync(process.env.LAUREL_QA_SETTINGS_SOURCE,'utf8'):null;
const settingsFragment=settingsSource?settingsSource.slice(settingsSource.indexOf('const css$7 ='),settingsSource.indexOf('//#endregion',settingsSource.indexOf('const css$7 =')))+'\n'+settingsSource.slice(settingsSource.indexOf('function navIcon('),settingsSource.indexOf('function SettingsRoot(')):null;
let failSave=false,missing=false;const audioRequests=[]
const server=createServer(async(req,res)=>{
 try{
 if(req.url.startsWith('/api/laurel-center/wallpapers'))return wallpaperHandler(req,res)
 if(req.url.startsWith('/api/laurel-center/presentation')){if(failSave&&req.method==='POST'){res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"QA disk unavailable"}');return}return handler(req,res)}
 if(presentationStoreFixture(req,res))return;
 if(req.url.startsWith('/api/laurel-center/modules')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({enabled:Object.fromEntries(SUB_PLUGINS.map(p=>[p.id,true])),status:SUB_PLUGINS.map(p=>({id:p.id,mounted:true}))}));return}
 if(req.url.startsWith('/laurel-center/art/audio/'))audioRequests.push(req.url)
 if(req.url.startsWith('/laurel-center/materials')||req.url.startsWith('/laurel-center/art')){if(missing){res.writeHead(404);res.end();return}return req.url.startsWith('/laurel-center/art')?materials.legacy(req,res):materials.handler(req,res)}
 if(req.url.startsWith('/api/laurel-memory')||req.url.startsWith('/laurel-memory')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,data:{enabled:true,tier:'zero',modelSource:'none',coreId:'synthetic-core',journalSeq:120,stats:{total:120,today:2,byKind:{fact:50,experience:70}},today:2,total:120,writable:false}}));return}
 if(req.url==='/memory.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(readFileSync(new URL('../packages/laurel-memory/lib/client.js',import.meta.url),'utf8'));return}
 if(req.url==='/boot.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(boot.outputFiles[0].text);return}
 if(req.url==='/plugin.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(root);return}
 res.writeHead(200,{'content-type':'text/html'});res.end(readFileSync(reference+'/evidence/native-rich-fixture.html','utf8').replace("Object.defineProperty(window,'localStorage',{value:","Object.defineProperty(window,'localStorage',{configurable:true,writable:true,value:"))
 }catch(e){res.writeHead(500);res.end(String(e))}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port
const browser=await chromium.launch({headless:true,args:['--disable-web-security','--autoplay-policy=no-user-gesture-required','--use-angle=swiftshader','--enable-unsafe-swiftshader']})
const checks=[],errors=[];const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});console.log((pass?'PASS ':'FAIL ')+name);assert.ok(pass,name)}
const page=await browser.newPage({viewport:{width:1600,height:1000}});page.on('pageerror',e=>errors.push(e.stack||String(e)))
await page.addInitScript(()=>{window.__qaNative={fetch:window.fetch.bind(window),Audio:window.Audio,AudioContext:window.AudioContext};if(!localStorage.getItem('laurel.harness-appearance.v03'))localStorage.setItem('laurel.harness-appearance.v03',JSON.stringify({colorMode:'light',theme:'si-paper-v01'}))})
async function mount(){
 await page.goto(url);await page.waitForFunction(()=>window.laurelNativePreview);await page.evaluate(()=>{laurelNativePreview.setOriginal(true);laurelNativePreview.dispose();for(const s of document.head.querySelectorAll('style'))if(s.textContent.includes('Laurel 0.3 applied to the unmodified')||s.textContent.includes('Palette: evidence/previous-color-samples'))s.remove();window.localStorage=window.__PREVIEW_STORAGE__;window.fetch=__qaNative.fetch;window.Audio=__qaNative.Audio;window.AudioContext=__qaNative.AudioContext;document.body.classList.add('qa-center')})
 await page.addStyleTag({content:'#preview-trigger,#preview-panel,.laurel-ambient,.native-preview-controls{display:none!important}body.qa-center [data-conversation-content],body.qa-center [data-composer-card]{visibility:hidden!important}.lx-wallpaper-layer{visibility:visible!important}#qa-mount{position:fixed;left:260px;top:40px;right:0;bottom:0;z-index:100000;background:var(--lx-side);display:flex;min-width:0}'})
 await page.addScriptTag({url:url+'/boot.js'})
 await page.evaluate(()=>{if(!sessionStorage.getItem('qa-legacy-seeded')){localStorage.setItem('laurel.harness-appearance.v03',JSON.stringify({colorMode:'light',theme:'si-paper-v01'}));localStorage.removeItem('laurel-center.presentation.v1');sessionStorage.setItem('qa-legacy-seeded','1')}})
 await page.evaluate(()=>{window.__factories={};window.__ModuleLoader__={load(o){__factories[o.id]=o.factory}}})
 await page.addScriptTag({url:url+'/plugin.js'});await page.addScriptTag({url:url+'/memory.js'})
 await page.evaluate(()=>{window.__geometryBefore=[...document.querySelectorAll('[data-row-key], [data-composer-card], nav[aria-label="Global panels"]')].map(e=>{const r=e.getBoundingClientRect();return[e.getAttribute('data-row-key')||e.tagName,r.x,r.y,r.width,r.height,getComputedStyle(e).font]})})
 await page.evaluate(()=>{
  const exports={},React=__react,h=React.createElement,clean=[],registrations=[],panelListeners=new Set();
  const layout={selectPanel(){},panelInfo:{getSnapshot:()=>({activePanelId:'laurel-center'}),subscribe(fn){panelListeners.add(fn);return()=>panelListeners.delete(fn)}}};
  const ctx={effect(fn){const off=fn();if(typeof off==='function')clean.push(off);return off},get(key){return key==='layout'?layout:null},locale:{register(){return()=>{}},bind(){return key=>key}},remote:{$on(){return()=>{}}},slots:{inject(name,fn){return fn()},register(meta,component){registrations.push({...meta,component});return()=>{} }}};
  const plugin=__factories['laurel-center'](key=>key==='react'?React:key==='react-dom'?__dom:null);plugin.apply(ctx);__factories['laurel-memory'](key=>key==='react'?React:null).apply(ctx);
  window.__registrations=registrations;const mount=document.createElement('div');mount.id='qa-mount';document.body.append(mount);
  const Panel=registrations.find(x=>x.name==='main').component;const reactRoot=__dom.createRoot(mount);window.__togglePanel=on=>reactRoot.render(on?h(Panel,{renderSlot:(_,props,options)=>{const registration=registrations.find(x=>x.name==='laurel-center.module'&&x.id===options.only);return registration?h(registration.component,{controlCenter:true}):h('p',null,'Unregistered synthetic boundary')}}):null);__togglePanel(true);
  window.__dispose=()=>{reactRoot.unmount();clean.reverse().forEach(fn=>fn());mount.remove()};
 });await page.waitForFunction(()=>document.querySelector('iframe[data-laurel-particle-frame]')?.contentWindow?.laurelParticleControl?.snapshot().modules.length===7).catch(async e=>{writeFileSync(out+'/mount-diagnostic.json',JSON.stringify(await page.evaluate(()=>({registrations:__registrations.map(x=>({name:x.name,key:x.key,id:x.id})),experience:__experience.snapshot(),frames:[...document.querySelectorAll('iframe')].map(f=>({title:f.title,text:f.contentDocument?.body?.innerText.slice(0,1000),snapshot:f.contentWindow?.laurelParticleControl?.snapshot()})),root:document.querySelector('#qa-mount').innerHTML.slice(0,2500)})),null,2));throw e})
 await page.waitForTimeout(450)
}
const center=()=>page.frames().find(f=>f!==page.mainFrame()&&f.url()==='about:srcdoc'&&f.parentFrame()===page.mainFrame())

const observations=[];
function contrast(a,b){const rgb=s=>s.match(/[0-9.]+/g).slice(0,3).map(Number).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4});const lum=s=>rgb(s).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
const record=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});console.log((pass?'PASS ':'FAIL ')+name)};
try{
 await mount();
 if(settingsFragment)await page.evaluate(fragment=>{
  const react=__react,react_dom=__dom,react_jsx_runtime=__jsx;
  const nativeGlyph=document.querySelector('nav button svg').innerHTML;
  const Glyph=props=>react.createElement('svg',{...props,width:props.size,height:props.size,viewBox:'0 0 16 16',fill:'none',stroke:'currentColor',dangerouslySetInnerHTML:{__html:nativeGlyph}});
  const primitives=new Proxy({useModalLayer(){}},{get:(target,key)=>target[key]||Glyph});
  const Panel=Function('react','react_dom','react_jsx_runtime','_deepseek_ai_dsh_client_ui_primitives','clsx',fragment+';return SettingsPanel;')(react,react_dom,react_jsx_runtime,primitives,(...classes)=>classes.filter(Boolean).join(' '));
  const mount=document.createElement('div');document.body.append(mount);const root=__dom.createRoot(mount);
  function Harness(){const [activeId,onSelect]=react.useState('models');return react.createElement(Panel,{rows:[{id:'general',label:'通用设置'},{id:'models',label:'模型'},{id:'agent-presets',label:'内置插件'}],activeId,onSelect,onClose:()=>root.render(null),renderSlot:name=>name==='settings.header'?'设置':name==='settings.close'?'关闭':'本地合成设置内容'});}
  window.__openNativeSettings=()=>root.render(react.createElement(Harness));
 },settingsFragment);
 for(const round of [1,2])for(const family of ['si','industrial'])for(const mode of ['light','dark']){
  const label=`${round}-${family}-${mode}`;
  await page.evaluate(({family,mode})=>__experience.update({theme:family==='si'?'wuling-particle-v03':'particle-v03',colorMode:mode,motion:true}),{family,mode});
  await center().waitForFunction(({family,mode})=>document.documentElement.dataset.theme===family&&document.documentElement.dataset.color===mode,{family,mode});
  await center().locator('.module-row').nth(1).locator('.module-main').click();
  await page.waitForTimeout(1300);
  const rows=await center().locator('.module-row').evaluateAll(es=>es.slice(0,3).map(e=>{const s=n=>({color:getComputedStyle(n).color,bg:getComputedStyle(n).backgroundColor,shadow:getComputedStyle(n).textShadow});return{id:e.dataset.id,selected:e.classList.contains('selected'),brush:e.dataset.brushTone,title:s(e.querySelector('strong')),summary:s(e.querySelector('small')),state:s(e.querySelector('.row-state')),favorite:s(e.querySelector('.row-favorite')),open:s(e.querySelector('.row-open')),side:getComputedStyle(document.documentElement).getPropertyValue('--lx-side'),text:getComputedStyle(document.documentElement).getPropertyValue('--lx-text'),muted:getComputedStyle(document.documentElement).getPropertyValue('--lx-muted'),selectedBg:getComputedStyle(document.documentElement).getPropertyValue('--lx-selected'),industrialIndicator:getComputedStyle(document.querySelector('.industrial-row-indicator')).backgroundColor}}));
  const colors=await center().evaluate(()=>{const r=document.documentElement,c=getComputedStyle(r),probe=document.createElement('div');document.body.append(probe);const resolve=n=>{probe.style.color=c.getPropertyValue(n);return getComputedStyle(probe).color};const values={side:resolve('--lx-side'),selected:resolve('--lx-selected'),muted:resolve('--lx-muted')};probe.remove();return values});
  record(label+' state and actions remain legible',rows.every(r=>contrast(r.state.color,family==='industrial'&&r.selected?colors.selected:colors.side)>=4.5),{rows,colors});
  if(family==='si')record(label+' brush leaves actions outside its paint',await center().evaluate(()=>{const stroke=document.querySelector('.flow-selection[data-brush-kind=row]').getBoundingClientRect(),action=document.querySelector('.module-row.selected .row-favorite').getBoundingClientRect();return stroke.right<=action.left+.5}));
  if(family==='industrial'){
   record(label+' has no stale brush text tint',rows.every(r=>!r.brush&&r.title.shadow==='none'&&r.summary.shadow==='none'),rows);
   record(label+' title and description contrast',rows.every(r=>[r.title,r.summary].every(s=>contrast(s.color,r.selected?colors.selected:colors.side)>=4.5)),{rows,colors});
  }
  await center().locator('.module-row').first().hover();await page.waitForTimeout(120);
  await page.screenshot({path:out+'/'+label+'-rows.png'});
  await center().locator('.module-row').nth(1).locator('.row-open').click();
  const native=center().locator('#detail-fields').locator('.actual-settings');
  await native.locator('details').waitFor();await page.waitForTimeout(120);
  const details=await native.evaluate(e=>{const root=e.closest('.lc-panel'),nodes=[e.querySelector('details summary'),...e.querySelectorAll('button')].filter(Boolean);const background=n=>{for(let p=n;p;p=p.parentElement||p.getRootNode()?.host){const c=getComputedStyle(p).backgroundColor;if(c!=='rgba(0, 0, 0, 0)'&&c!=='transparent')return c}return getComputedStyle(document.querySelector('#detail-dialog')).backgroundColor};return{design:root.dataset.design,mode:root.dataset.theme,colors:nodes.map(n=>({text:n.textContent,color:getComputedStyle(n).color,bg:background(n)})),rootColor:getComputedStyle(root).color,ink:getComputedStyle(root).getPropertyValue('--ink')}});
  record(label+' real memory settings text contrast',details.colors.every(n=>contrast(n.color,n.bg)>=4.5),details);
  const heading=await center().locator('#detail-dialog .dialog-heading .eyebrow').evaluate(e=>({color:getComputedStyle(e).color,bg:getComputedStyle(document.querySelector('#detail-dialog')).backgroundColor}));
  record(label+' dialog breadcrumb contrast',contrast(heading.color,heading.bg)>=4.5,heading);
  observations.push({label,rows,colors,details});await page.screenshot({path:out+'/'+label+'-memory.png'});
  await center().getByRole('button',{name:'返回模块目录'}).click();await center().locator('#detail-dialog').waitFor({state:'hidden'});
  if(settingsFragment){
   await page.evaluate(()=>{document.querySelector('#qa-mount').style.zIndex='1';__openNativeSettings()});
   const settings=page.locator('[data-shortcut-modal="settings"]');await settings.waitFor();
   const cells=settings.locator('button[class*="_navCell"]');
   const read=cell=>cell.evaluate(e=>({label:e.textContent,current:e.getAttribute('aria-current'),color:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor,children:[...e.querySelectorAll('svg,span')].map(n=>({color:getComputedStyle(n).color})),rect:(()=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()}));
   const selected=cells.filter({hasText:'模型'});await selected.hover();
   const current=await read(selected);record(label+' native settings selected hover text and icon contrast',current.current==='true'&&[current,...current.children].every(n=>contrast(n.color,current.bg)>=4.5),current);
   const general=cells.filter({hasText:'通用设置'});await general.hover();
   const hovered=await read(general);record(label+' native settings inactive hover contrast',[hovered,...hovered.children].every(n=>contrast(n.color,hovered.bg)>=4.5),hovered);
   await general.click();await selected.hover();
   const changed=await read(general);record(label+' native settings selection follows navigation',changed.current==='true'&&[changed,...changed.children].every(n=>contrast(n.color,changed.bg)>=4.5),changed);
   await page.screenshot({path:out+'/'+label+'-native-settings.png'});
   await settings.getByRole('button',{name:'关闭',exact:true}).click();await settings.waitFor({state:'hidden'});await page.evaluate(()=>document.querySelector('#qa-mount').style.zIndex='100000');
  }
 }
 await page.evaluate(()=>__experience.update({theme:'particle-v03',colorMode:'light',motion:true}));await page.waitForTimeout(100);
 const nav=page.locator('nav[aria-label="Global panels"],nav[aria-label="全局面板"]');
 const buttons=nav.locator('button');
 const navBefore=await buttons.evaluateAll(es=>es.map(e=>({html:e.outerHTML.slice(0,700),color:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor})));
 observations.push({navBefore});
 for(let i=0;i<Math.min(3,await buttons.count());i++){
  await buttons.nth(i).hover();await page.waitForTimeout(150);
  const data=await buttons.nth(i).evaluate(e=>({text:e.textContent,color:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor,html:e.outerHTML.slice(0,700)}));
  record('industrial day sidebar hover '+i+' contrast',contrast(data.color,data.bg)>=4.5,data);
 }
 await page.screenshot({path:out+'/industrial-day-sidebar.png'});
 await buttons.first().click();await page.waitForTimeout(100);
 const active=nav.locator('button[class*="_panelActive"]');
 const selected=await active.evaluate(e=>({text:e.textContent,color:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor}));
 record('industrial day sidebar selected contrast',contrast(selected.color,selected.bg)>=4.5,selected);
 record('no browser exceptions',errors.length===0,errors);
}finally{
 writeFileSync(out+'/browser-qa.json',JSON.stringify({scope:'Built bundle, preserved native rc.5 sidebar, actual memory component in real shadow portal; synthetic local API only',checks,errors,observations},null,2));
 await browser.close();materials.dispose();await new Promise(r=>server.close(r));
}
if(!process.env.LAUREL_QA_BASELINE)assert.ok(checks.every(c=>c.pass),'Readability checks failed');

