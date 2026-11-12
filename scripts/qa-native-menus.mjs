/** Exact installed host components, synthetic rows/model directory, isolated browser. */
import {readFileSync,writeFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {chromium} from 'playwright'
import assert from 'node:assert/strict'
import {qaOutput} from './private-output.mjs'
import {presentationStoreFixture} from './qa-store-fixture.mjs'
import {createPresentationHandler,writePresentation} from '../lib/ui-preferences.js'
import {createMaterialsHandler} from '../lib/private-materials.js'
const host=process.env.LAUREL_QA_HOST;
if(!host)throw Error('Set LAUREL_QA_HOST to the installed host dsh directory (read-only)');
const out=qaOutput('native-menus'),checks=[],errors=[],sources=[];
const read=path=>{const content=readFileSync(path,'utf8');sources.push({path,sha256:createHash('sha256').update(content).digest('hex')});return content};
const hostPkg=name=>join(host,'node_modules/@deepseek-ai',name);
const dist=join(hostPkg('dsh-web-frontend'),'dist'),assets=join(dist,'assets');
const files=readdirSync(assets),index=files.find(f=>/^index-.*\.js$/.test(f));
const frontend=read(join(assets,index));
const seedMatch=/function (\w+)\(\)\{return\{react:[^}]+"@deepseek-ai\/dsh-client-ui-primitives"[^}]+\}\}/.exec(frontend);
assert.ok(seedMatch,'Installed frontend seed table is recognized');
const iconMap=/([\w$]+)=Object.freeze\(Object.fromEntries\(Object.entries\([^;]+?t\.svg\([^;]+?\)\)\)\)/.exec(frontend);
assert.ok(iconMap,'Installed SVG symbol registry is recognized');
const seeds=frontend.slice(0,seedMatch.index+seedMatch[0].length).replaceAll('./vendor-', '/assets/vendor-')+`;window.__seeds=${seedMatch[1]}();window.__iconMarkup=${iconMap[1]};`;
const workspace=read(join(hostPkg('dsh-client-ui-workspace'),'lib/client.js'));
const rowsStart=workspace.indexOf('const css$1 =');
const rowsEnd=workspace.indexOf('//#endregion',workspace.indexOf('function SessionNodeItem(',rowsStart));
assert.ok(rowsStart>0&&rowsEnd>rowsStart,'Installed session row fragment is recognized');
const rowFragment=workspace.slice(rowsStart,rowsEnd);
const model=read(join(hostPkg('dsh-client-ui-model-selection'),'lib/client.js'));
const modelStart=model.indexOf('const css ='),modelEnd=model.indexOf('function rowId(');
assert.ok(modelStart>0&&modelEnd>modelStart,'Installed model selector fragment is recognized');
const modelFragment=model.slice(modelStart,modelEnd);
const theme=read(join(hostPkg('dsh-client-ui-theme'),'lib/client.js'));
const hostCss=[...theme.matchAll(/(?:const|var) [\w$]+ = ("(?:[^"\\]|\\.)*");/g)].map(m=>{try{return JSON.parse(m[1])}catch{return''}}).filter(s=>s.includes('{')&&s.includes('--dsw-')).join('\n');
assert.ok(hostCss.includes('--dsw-menu-surface-fill'),'Installed theme CSS is recognized');
const bundle=read(process.env.LAUREL_QA_BUNDLE||new URL('../lib/client.js',import.meta.url)).replace('workbench.experience = experience','workbench.experience = experience;window.__experience=experience;window.__siFlow=siFlow;window.__workbench=workbench');
const pref=out+'/presentation.json';writePresentation(pref,{theme:'wuling-particle-v03',siTheme:'si-paper-v01',colorMode:'light',experienceRevision:5,motion:false,sound:false,music:false});
const presentation=createPresentationHandler({file:pref,connection:()=>({admit:()=>null})});
const materials=createMaterialsHandler({root:process.env.LAUREL_QA_MATERIALS||out+'/empty-materials'});
const server=createServer((req,res)=>{
 if(req.url.startsWith('/api/laurel-center/presentation'))return presentation(req,res);
 if(presentationStoreFixture(req,res))return;
 if(req.url.startsWith('/laurel-center/materials'))return materials.handler(req,res);
 if(req.url==='/plugin.js'){res.setHeader('content-type','text/javascript');return res.end(bundle)}
 if(req.url==='/seeds.js'){res.setHeader('content-type','text/javascript');return res.end(seeds)}
 if(req.url.startsWith('/assets/')){const name=req.url.slice(8);if(!files.includes(name)){res.statusCode=404;return res.end()}res.setHeader('content-type',name.endsWith('.css')?'text/css':'text/javascript');return res.end(readFileSync(join(assets,name)))}
 if(req.url==='/api/laurel-center/modules'){res.setHeader('content-type','application/json');return res.end('{"enabled":{},"status":[]}')}
 if(req.url.startsWith('/api/')){res.setHeader('content-type','application/json');return res.end('{"ok":true,"data":{},"items":[]}')}
 res.setHeader('content-type','text/html');res.end(`<!doctype html><html data-platform="win32"><head>${files.filter(f=>f.endsWith('.css')).map(f=>`<link rel="stylesheet" href="/assets/${f}">`).join('')}<style>${hostCss}</style><style>body{margin:0;font:14px/1.5 sans-serif}.qa-shell{display:flex;min-height:100vh}.qa-side{width:280px;padding:16px 12px;box-sizing:border-box;background:var(--dsw-specific-sidebar-fill);--dsh-sidebar-label-gap:6px;--dsh-sidebar-row-padding:8px;--dsh-sidebar-paint-inset:0px;--dsh-sidebar-label-font:14px/20px sans-serif}.qa-side nav{height:42px}.qa-side nav button{color:inherit;background:transparent;border:0}.qa-conversation{flex:1;position:relative;padding:24px}.qa-model-seat{position:absolute;bottom:32px;right:48px}#qa-menu-anchor{position:absolute;left:290px;top:95px}h1{font:500 20px sans-serif}</style></head><body><div id="qa"></div><script type="module" src="/seeds.js"></script></body></html>`)
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1100,height:720}});page.on('pageerror',e=>errors.push(e.stack||String(e)));
const record=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});console.log((pass?'PASS ':'FAIL ')+name)};
function contrast(a,b){const rgb=s=>s.match(/[0-9.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4});const lum=s=>rgb(s).reduce((n,c,i)=>n+c*[.2126,.7152,.0722][i],0);const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
try{
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.__seeds);
 await page.evaluate(({rowFragment,modelFragment})=>{
  const sprite=document.createElementNS('http://www.w3.org/2000/svg','svg');sprite.setAttribute('aria-hidden','true');sprite.style.display='none';for(const [id,markup] of Object.entries(__iconMarkup)){const source=new DOMParser().parseFromString(markup,'image/svg+xml').documentElement;const symbol=document.createElementNS(sprite.namespaceURI,'symbol');for(const a of source.attributes)symbol.setAttribute(a.name,a.value);symbol.id=id;symbol.innerHTML=source.innerHTML;sprite.append(symbol)}document.body.prepend(sprite);
  const react=__seeds.react,react_jsx_runtime=__seeds['react/jsx-runtime'],react_dom=__seeds['react-dom'],P=__seeds['@deepseek-ai/dsh-client-ui-primitives'],h=react.createElement;
  const clsx=(...xs)=>xs.flatMap(x=>typeof x==='string'?x:x&&typeof x==='object'?Object.keys(x).filter(k=>x[k]):[]).join(' ');
  const Row=Function('react','react_jsx_runtime','_deepseek_ai_dsh_client_ui_primitives','clsx','abbreviateHomePath','assertNever',rowFragment+';return SessionNodeItem;')(react,react_jsx_runtime,P,clsx,s=>s,x=>{throw Error(String(x))});
  const Model=Function('react','react_dom','react_jsx_runtime','_deepseek_ai_dsh_client_ui_primitives','clsx',modelFragment+';return ModelSelect;')(react,react_dom,react_jsx_runtime,P,clsx);
  const modelListeners=new Set();let modelState={status:'ready',failures:[],groups:[{id:'synthetic',name:'Synthetic provider',models:[{id:'one',name:'Example model',reasoning:{defaultEffort:'high',efforts:[{id:'high',name:'High'},{id:'low',name:'Low'}]}},{id:'two',name:'Another model'}]}],current:{provider:'synthetic',model:'one',reasoningEffort:'high'},pending:null,error:null,retainedEffort:null};
  window.__resetModel=()=>{modelState={...modelState,current:{provider:'synthetic',model:'one',reasoningEffort:'high'}};modelListeners.forEach(fn=>fn())};
  const directory={subscribe(fn){modelListeners.add(fn);return()=>modelListeners.delete(fn)},getSnapshot:()=>modelState};
  window.__events={opened:[],archived:[],models:[]};
  const labels={'actions.session.aria':'Session actions','actions.archiveSession':'Archive session','menu.archiveSession':'Archive session','menu.model':'Model','menu.effort':'Reasoning effort','trigger.aria':'Select model','pane.models':'Models','pane.effort':'Reasoning effort','provider.account':'Account','effort.providerDefault':'Default','row.back':'Back'};
  const t=(key)=>labels[key]||key;
  function Harness(){
   const [current,setCurrent]=react.useState('alpha'),[menu,setMenu]=react.useState(false);
   return h('div',{className:'qa-shell'},h('aside',{className:'qa-side','data-slot':'sidebar'},h('nav',{'aria-label':'Global panels'},h('button',{'aria-label':'Laurel 控制中心'},'Laurel')),h('h1',null,'Synthetic workspace'),...['alpha','beta'].map(id=>h(Row,{key:id,node:{id,title:id==='alpha'?'Example session Alpha':'Example session Beta',updatedAt:Date.now(),blank:false,archived:false,pinned:false},currentId:current,now:Date.now(),onOpen:id=>{setCurrent(id);__events.opened.push(id)},onRenameRequest(){},useSessionAccess:()=>true,useContextMenu:()=>({getTriggerProps:()=>({})}),useContextMenuTarget:fn=>fn(menu?{kind:'session',value:{sessionId:current}}:undefined),openSessionMenu:()=>setMenu(v=>!v),renderSlot:(name,{sessionId})=>name==='sidebar.workspaces.session.row.action'?h('button',{className:'wnFoaW_iconButton','aria-label':'Archive session',onClick:()=>__events.archived.push(sessionId)},h(P.IconArchiveOutlineRegular)):null,t}))),h('main',{className:'qa-conversation'},h('div',{'data-conversation-content':''},h('h1',null,'Native menu theme regression'),h('p',null,'Synthetic data · isolated profile')),h('div',{className:'qa-model-seat'},h(Model,{locked:false,available:true,directory,load(){},select:async selection=>{__events.models.push(selection);modelState={...modelState,current:selection};modelListeners.forEach(fn=>fn());return{ok:true}},resolveText:(x)=>String(x||''),t,renderSlot:(_name,_props,options)=>options?.fallback??null}))),h('div',{id:'qa-menu-anchor'},h(P.Menu,{open:menu,onClose:()=>setMenu(false),portal:true,autoFocus:true,anchor:h('span',null),items:[{id:'pin',label:'Pin session',icon:h(P.IconPinFillRegular)},{id:'copy',label:'Copy Session ID',icon:h(P.IconNewChatOutlineRegular),shortcut:{keys:['Ctrl','C']}},{id:'disabled',label:'Unavailable action',disabled:true},{id:'archive',label:'Archive session',icon:h(P.IconArchiveOutlineRegular)}],onSelect:id=>{__events.opened.push(id);setMenu(false)}})));
  }
  window.__reactRoot=__seeds['react-dom/client'].createRoot(document.querySelector('#qa'));__reactRoot.render(h(Harness));
  localStorage.setItem('laurel.harness-appearance.v03',JSON.stringify({theme:'si-paper-v01',colorMode:'light',motion:false,paperTone:65,paperGrain:62}));
  window.__factories={};window.__ModuleLoader__={load(o){__factories[o.id]=o.factory}};
 },{rowFragment,modelFragment});
 await page.addScriptTag({url:'http://127.0.0.1:'+server.address().port+'/plugin.js'});
 await page.evaluate(()=>{const clean=[],registrations=[];const panelInfo={getSnapshot:()=>({activePanelId:null}),subscribe:()=>()=>{}};const ctx={get:key=>key==='layout'?{selectPanel(){},panelInfo}:null,effect(fn){const off=fn();if(typeof off==='function')clean.push(off);return off},locale:{register:()=>()=>{},bind:()=>key=>key},remote:{$on:()=>()=>{}},slots:{inject(name,fn){return fn()},register(meta,component){registrations.push({...meta,component});return()=>{}},entries:()=>[]}};__factories['laurel-center'](key=>__seeds[key]).apply(ctx);window.__dispose=()=>{clean.reverse().forEach(fn=>fn());__reactRoot.unmount()}});
 await page.waitForFunction(()=>__experience?.snapshot().preferences.saved&&!__experience.snapshot().preferences.loading);await page.waitForTimeout(600);
 for(const round of [1,2])for(const variant of ['si-paper-v01','si-flow-v03','industrial'])for(const mode of ['light','dark']){
  const label=`${round}-${variant}-${mode}`;
  await page.evaluate(async({variant,mode,round})=>{document.body.toggleAttribute('data-ds-dark-theme',round===1?mode==='light':mode==='dark');await __experience.update({theme:variant==='industrial'?'particle-v03':'wuling-particle-v03',siTheme:variant==='industrial'?'si-paper-v01':variant,colorMode:mode,motion:false})},{variant,mode,round});
  await page.waitForTimeout(400);
  const row=page.locator('[data-row-key="session:alpha"]');await row.click();await row.hover();await page.waitForTimeout(80);
  const action=await row.locator('button').evaluateAll(es=>es.map(e=>({bg:getComputedStyle(e).backgroundColor,label:e.getAttribute('aria-label'),color:getComputedStyle(e).color,icon:getComputedStyle(e.querySelector('svg')).color,rect:{width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height},tone:e.closest('[data-row-key]').dataset.brushTone,html:e.outerHTML,palette:getComputedStyle(document.documentElement).getPropertyValue('--lx-selectedText')})));
  const selected=await row.evaluate(e=>({color:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor,tone:e.dataset.brushTone,canvas:!!e.querySelector('.flow-selection:not([hidden])')}));
  record(label+' selected actions inherit the visible row ink',action.every(a=>a.color===selected.color&&a.icon===selected.color),{action,selected});
  record(label+' brush edge actions keep a contrasting backing',selected.tone!=='light'||action.every(a=>a.bg.startsWith('rgb(')&&contrast(a.color,a.bg)>=4.5),action);
  record(label+' native SVG symbol definitions exist',await row.locator('svg[data-icon]').evaluateAll(es=>es.length===2&&es.every(e=>document.getElementById(e.dataset.icon)?.querySelector('path,rect,circle,polygon'))));
  record(label+' hover actions have a clickable rectangle',action.length===2&&action.every(a=>a.rect.width>=16&&a.rect.height>=16),action);
  if(round===1)await page.screenshot({path:out+'/'+label+'-actions.png'});
  await row.getByRole('button',{name:'Archive session',exact:true}).click();
  record(label+' quick archive delegates once',await page.evaluate(()=>__events.archived.at(-1)==='alpha'));
  await row.getByRole('button',{name:'Session actions',exact:true}).click();
  const menu=page.getByRole('menu').filter({has:page.getByRole('menuitem',{name:'Pin session',exact:true})});await menu.waitFor();
  const colors=await menu.evaluate(e=>{const material=e.querySelector('[class*="_material"]');return{bg:getComputedStyle(material||e).backgroundColor,rows:[...e.querySelectorAll('[role=menuitem]:not(:disabled)')].map(n=>({text:n.textContent,color:getComputedStyle(n).color,labels:[...n.querySelectorAll('span')].map(s=>getComputedStyle(s).color),icons:[...n.querySelectorAll('svg')].map(s=>getComputedStyle(s).color)}))}});
  record(label+' session menu uses an opaque readable palette',colors.bg.startsWith('rgb(')&&colors.rows.every(r=>contrast(r.color,colors.bg)>=4.5&&r.icons.every(c=>contrast(c,colors.bg)>=3)),colors);
  record(label+' disabled action remains disabled',await menu.getByRole('menuitem',{name:'Unavailable action'}).isDisabled());
  await menu.getByRole('menuitem',{name:'Copy Session ID'}).hover();const hover=await menu.getByRole('menuitem',{name:'Copy Session ID'}).evaluate(e=>({fg:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor}));const alpha=Number(hover.bg.match(/[0-9.]+/g)?.[3]??1);const base=colors.bg.match(/[0-9.]+/g).slice(0,3).map(Number),fill=hover.bg.match(/[0-9.]+/g).slice(0,3).map(Number);const composed='rgb('+base.map((v,i)=>Math.round(fill[i]*alpha+v*(1-alpha))).join(', ')+')';record(label+' menu hover contrast',contrast(hover.fg,composed)>=4.5,{...hover,composed});
  if(round===1)await page.screenshot({path:out+'/'+label+'-session.png'});
  await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
  const trigger=page.locator('.qa-model-seat button').first();await trigger.click();
  const modelMenu=page.getByRole('menu',{name:'menu.aria',exact:true});await modelMenu.waitFor();
  const modelColors=await modelMenu.evaluate(e=>{const material=e.querySelector('[class*="_material"]');return{bg:getComputedStyle(material||e).backgroundColor,rows:[...e.querySelectorAll('button')].map(n=>({text:n.textContent,color:getComputedStyle(n).color,labels:[...n.querySelectorAll('span')].map(s=>getComputedStyle(s).color),icons:[...n.querySelectorAll('svg')].map(s=>getComputedStyle(s).color)}))}});
  record(label+' actual model menu text and arrows contrast',modelColors.bg.startsWith('rgb(')&&modelColors.rows.every(r=>contrast(r.color,modelColors.bg)>=4.5&&r.icons.every(c=>contrast(c,modelColors.bg)>=3)&&(r.labels||[]).every(c=>contrast(c,modelColors.bg)>=4.5)),modelColors);
  if(round===1)await page.screenshot({path:out+'/'+label+'-model.png'});
  await modelMenu.getByRole('menuitem').filter({hasText:'Reasoning effort'}).click();await page.getByRole('menuitemradio',{name:'Low',exact:true}).click();record(label+' reasoning selection reaches the directory',await page.evaluate(()=>__events.models.at(-1)?.reasoningEffort==='low'));
  await page.getByRole('menuitemradio',{name:'Low',exact:true}).waitFor({state:'hidden'});await trigger.click();const reopened=page.getByRole('menu',{name:'menu.aria',exact:true});await reopened.waitFor();await reopened.getByRole('menuitem').filter({hasText:'Model'}).click();await page.getByRole('menuitemradio').filter({hasText:'Another model'}).click();record(label+' model selection reaches the directory',await page.evaluate(()=>__events.models.at(-1)?.model==='two'));
  await page.evaluate(()=>{window.__resetModel?.()});
  await page.locator('[data-row-key="session:beta"]').click();await page.waitForTimeout(100);await row.hover();
  const reset=await row.locator('button').evaluateAll(es=>es.map(e=>({fg:getComputedStyle(e).color,icon:getComputedStyle(e.querySelector('svg')).color,tone:e.closest('[data-row-key]').dataset.brushTone})));
  record(label+' old row drops brush action ink after selection moves',reset.every(x=>!x.tone&&x.fg===x.icon),reset);
 }
 await page.evaluate(async()=>{await __experience.update({theme:'wuling-particle-v03',siTheme:'si-paper-v01',colorMode:'light',motion:true});await __siFlow.appearance.update({paused:false})});
 await page.locator('[data-row-key="session:alpha"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-row-key="session:alpha"]')?.dataset.brushTone==='light');
 await page.locator('[data-row-key="session:beta"]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-row-key="session:alpha"]')?.dataset.brushTone&&document.querySelector('[data-row-key="session:beta"]')?.dataset.brushTone==='light');
 record('animated selection transfers action ink and backing',await page.locator('[data-row-key="session:beta"]').evaluate(e=>[...e.querySelectorAll('button')].every(b=>getComputedStyle(b).color===getComputedStyle(e).color&&getComputedStyle(b).backgroundColor==='rgb(7, 25, 35)')));
 await page.evaluate(()=>__experience.update({theme:'wuling-particle-v03',siEnabled:false,motion:false}));
 await page.waitForFunction(()=>document.documentElement.dataset.laurelShellPaint==='false'&&!document.documentElement.hasAttribute('data-si-flow'));
 record('disabling shell paint releases native menu tokens',await page.evaluate(()=>getComputedStyle(document.body).getPropertyValue('--dsw-menu-surface-fill').trim()!==getComputedStyle(document.documentElement).getPropertyValue('--lx-surface').trim()));
 await page.evaluate(()=>__dispose());record('no browser exceptions',errors.length===0,errors);
}finally{writeFileSync(out+'/browser-qa.json',JSON.stringify({scope:'Exact installed frontend primitives, session row and ModelSelect; built Laurel client; synthetic context/API and data. No daily profile or GUI cold-start acceptance.',sources,checks,errors},null,2));await browser.close();materials.dispose();await new Promise(r=>server.close(r));}
if(!process.env.LAUREL_QA_BASELINE)assert.ok(checks.every(c=>c.pass),'Native menu readability regression');
