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
const out=qaOutput('scene-paper')
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
 if(presentationStoreFixture(req,res))return;
 if(req.url.startsWith('/api/laurel-center/modules')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({enabled:Object.fromEntries(SUB_PLUGINS.map(p=>[p.id,true])),status:SUB_PLUGINS.map(p=>({id:p.id,mounted:true}))}));return}
 if(req.url.startsWith('/laurel-center/art/audio/'))audioRequests.push(req.url)
 if(req.url.startsWith('/laurel-center/materials')||req.url.startsWith('/laurel-center/art')){if(missing){res.writeHead(404);res.end();return}return req.url.startsWith('/laurel-center/art')?materials.legacy(req,res):materials.handler(req,res)}
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

async function setBrightness(n){await center().locator('#paper-brightness').evaluate((e,n)=>{e.value=n;e.dispatchEvent(new Event('input',{bubbles:true}))},n)}
async function paperState(){return center().evaluate(()=>{const s=document.querySelector('.scene'),c=getComputedStyle(s),a=getComputedStyle(s,':after'),b=getComputedStyle(s,':before');return {enabled:s.hasAttribute('data-paper-stage'),bg:a.backgroundColor,color:c.color,texture:b.backgroundImage,opacity:b.opacity,side:getComputedStyle(document.documentElement).getPropertyValue('--lx-side'),prefs:laurelParticleControl.snapshot().prefs,palette:laurelParticleControl.snapshot().effectivePalette,scene:laurelParticleControl.snapshot().scene}})}
try{
 await mount();await page.evaluate(()=>__experience.change({theme:'wuling-particle-v03',colorMode:'light',motion:true}));
 await center().waitForFunction(()=>laurelParticleControl.snapshot().scene?.sourcePoints>0);
 const original=await paperState();check('existing users keep original background',!original.enabled&&original.prefs.paperEnabled===false,original);
 check('actual WebGL scene loaded',original.scene?.sourcePoints>0,original.scene);
 await center().locator('#scene-style').click();check('paper slider visibly labelled and opt-in',await center().getByRole('slider',{name:/纸色明暗/}).isDisabled());
 await center().locator('#paper-enabled').check();await setBrightness(0);const dark=await paperState();
 check('deep paper and light particles preview immediately',dark.enabled&&dark.bg==='rgb(48, 51, 47)'&&dark.palette.base==='#ebe6d9',dark);
 check('same optional fibre texture behind canvas',dark.texture.includes('7bbcfd3f')&&dark.opacity==='0.62',dark);
 check('canvas stays interactive and unfiltered',await center().locator('#particle-stage canvas').evaluate(e=>getComputedStyle(e).filter==='none'&&getComputedStyle(e).pointerEvents!=='none'));
 await center().locator('[data-close="scene-dialog"]').last().click();await center().waitForFunction(()=>!document.querySelector('#scene-dialog').open);
 check('cancel restores original prefs and background',!(await paperState()).enabled);
 await center().locator('#scene-style').click();await center().locator('#paper-enabled').check();
 for(const n of [100,65,30,0]){await setBrightness(n);const p=await paperState();check('brightness '+n+' has matching preview and output',p.prefs.paperBrightness===n&&(await center().locator('#paper-brightness-value').innerText())===n+'%',p);await page.screenshot({path:out+'/settings-'+n+'.png'})}
 await center().locator('#paper-brightness').focus();await page.keyboard.press('ArrowRight');check('native keyboard range increments',await center().locator('#paper-brightness').inputValue()==='1');
 await setBrightness(30);await center().locator('#scene-form button[type=submit]').click();await center().waitForFunction(()=>!document.querySelector('#scene-dialog').open);
 check('apply writes both preferences',await center().evaluate(()=>{const p=JSON.parse(localStorage.getItem('laurel-particle-v03-01')).prefs;return p.paperEnabled===true&&p.paperBrightness===30}));
 await page.screenshot({path:out+'/scene-paper-30.png'});
 await page.evaluate(()=>__togglePanel(false));await page.waitForFunction(()=>!document.querySelector('[data-laurel-particle-frame]'));await page.evaluate(()=>__togglePanel(true));await page.waitForFunction(()=>document.querySelector('[data-laurel-particle-frame]')?.contentWindow?.laurelParticleControl?.snapshot().scene?.sourcePoints>0);
 check('paper preferences survive center remount',(await paperState()).enabled&&(await paperState()).prefs.paperBrightness===30);
 for(const [theme,colorMode] of [['wuling-particle-v03','dark'],['particle-v03','light'],['particle-v03','dark']]){await page.evaluate(p=>__experience.change({...p,motion:false}),{theme,colorMode});check(theme+' '+colorMode+' unaffected',!(await paperState()).enabled)}
 await page.evaluate(()=>__experience.change({theme:'wuling-particle-v03',colorMode:'light',motion:true}));check('return to Si day restores chosen paper',(await paperState()).enabled);
 await center().locator('#scene-style').click();await setBrightness(80);await page.keyboard.press('Escape');await center().waitForFunction(()=>!document.querySelector('#scene-dialog').open);check('Escape reverts draft brightness',(await paperState()).prefs.paperBrightness===30);
 await center().locator('#scene-style').click();await center().locator('#paper-enabled').uncheck();await center().locator('#scene-form button[type=submit]').click();await center().waitForFunction(()=>!document.querySelector('#scene-dialog').open);check('switch off restores exact theme side',(await paperState()).bg===original.bg);
 await center().locator('#module-search').fill('纸色明暗');await center().getByRole('button',{name:/纸色明暗/}).click();check('settings search locates disabled slider and focuses its enabling switch',await center().locator('#paper-enabled').evaluate(e=>document.activeElement===e));
 await center().locator('#paper-enabled').check();await setBrightness(0);await center().locator('#scene-form button[type=submit]').click();await center().waitForFunction(()=>!document.querySelector('#scene-dialog').open);await center().locator('#module-search').fill('');
 await center().locator('#replay').hover();check('paper-stage hover keeps icon distinct from button fill',await center().locator('#replay').evaluate(e=>{const c=getComputedStyle(e);return c.color!==c.backgroundColor}));await center().locator('#replay').click();await page.mouse.move(1500,980);await page.waitForTimeout(300);await page.screenshot({path:out+'/gather-early.png'});await page.waitForTimeout(1300);await page.screenshot({path:out+'/gather-mid.png'});await page.waitForTimeout(2400);await page.screenshot({path:out+'/gather-settled.png'});
 await center().locator('#pause').click();check('replay and pause remain operable',await center().locator('#pause').getAttribute('aria-pressed')==='true');
 await page.setViewportSize({width:720,height:900});await center().locator('#scene-style').click();await center().locator('#paper-stage-settings').scrollIntoViewIfNeeded();check('narrow paper controls fit viewport',await center().locator('#paper-stage-settings').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}));await page.screenshot({path:out+'/paper-narrow.png'});
 check('no browser exceptions',errors.length===0,errors);
}finally{writeFileSync(out+'/browser-qa.json',JSON.stringify({scope:'Built public client bundle + React + preserved rc.5 native fixture, actual WebGL, presentation/material handlers. Controlled module/slot boundaries; not installed desktop GUI acceptance.',checks,errors},null,2));await browser.close();materials.dispose();await new Promise(r=>server.close(r))}
console.log(JSON.stringify({checks:checks.length,errors}));
