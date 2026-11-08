import {createSiFlowEngine} from './engine.js';
import './motion.js';
import './brush-track.js';
(() => {
 const nav=document.querySelector('.category-nav'),shell=document.querySelector('.list-shell'),list=document.querySelector('#module-list');
 const donors=document.createElement('div');donors.style.cssText='position:fixed;left:-2000px;top:0;visibility:hidden;pointer-events:none;';document.body.append(donors);
 const donor={};for(const [name,kind]of [['tab','selected'],['row','module']]){const c=document.createElement('canvas');c.dataset.ink=kind;c.style.cssText=`width:${kind==='module'?640:342}px;height:80px`;donors.append(c);donor[name]=c;}
 const engine=createSiFlowEngine();window.selectionFlow=engine;
 const tracks={tab:new InkBrushTrack({parent:nav,kind:'tab',source:()=>donor.tab}),row:new InkBrushTrack({parent:shell,kind:'row',source:()=>donor.row})};
 let clock=0,lastPrefs={},panelActive=document.documentElement.dataset.laurelActive!=='false';
 const alloy=document.createElement('div');alloy.className='industrial-row-indicator';alloy.setAttribute('aria-hidden','true');shell.append(alloy);let alloyReady=false;
 window.syncIndustrialSelection=()=>{if(!industrial()){alloy.hidden=true;alloyReady=false;return}const row=list.querySelector('.selected');if(!row){alloy.hidden=true;return}const r=row.getBoundingClientRect(),p=shell.getBoundingClientRect(),before=alloy.getBoundingClientRect();const top=Math.max(r.top,p.top),bottom=Math.min(r.bottom,list.getBoundingClientRect().bottom);alloy.hidden=bottom<=top;alloy.getAnimations().forEach(a=>a.cancel());alloy.style.cssText=`left:${r.left-p.left}px;top:${top-p.top}px;width:${r.width}px;height:${Math.max(0,bottom-top)}px;`;if(alloyReady&&!lastPrefs.reduced&&!alloy.hidden&&Math.abs(before.top-top)>.5)alloy.animate([{transform:`translateY(${before.top-top}px)`},{transform:'translateY(0)'}],{duration:330,easing:'cubic-bezier(.22,.75,.24,1)'});alloyReady=true;};const industrial=()=>document.documentElement.dataset.theme==='industrial';engine.onFrame(dt=>{clock+=dt;draw(dt);});
 const target=(e,parent,key)=>{if(!e)return null;const r=e.getBoundingClientRect(),p=parent.getBoundingClientRect();return{key,element:e,rect:{x:r.x-p.x,y:r.y-p.y,w:parent===shell?Math.max(1,e.querySelector('.module-main').getBoundingClientRect().right-r.left):r.width,h:r.height}};};
 function measure(){window.syncIndustrialSelection();if(industrial())return;const t=nav.querySelector('[aria-selected=true]'),r=list.querySelector('.selected');tracks.tab.select(target(t,nav,t?.dataset.category));tracks.row.select(target(r,shell,r?.dataset.id));draw(0);}
 function draw(dt){if(industrial())return;tracks.tab.update(dt);tracks.row.update(dt);}

 function syncActivity(){engine.configure({...lastPrefs,paused:lastPrefs.paused||industrial()||!panelActive});}
 const onActivity=event=>{panelActive=event.detail===true;syncActivity();};
 window.addEventListener('laurel:panel-activity',onActivity);
 const observer=new MutationObserver(()=>measure());observer.observe(list,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});observer.observe(nav,{attributes:true,subtree:true,attributeFilter:['aria-selected']});
 const resize=new ResizeObserver(measure);resize.observe(nav);resize.observe(shell);list.addEventListener('scroll',measure,{passive:true});
 const offMotion=window.InkMotion.register(p=>{lastPrefs=p;const next={...p,paused:p.paused||industrial()||!panelActive};for(const t of Object.values(tracks))t.configure(next);engine.configure(next);});
 window.syncSelectionTheme=async()=>{syncActivity();window.syncIndustrialSelection();if(industrial()){for(const n of document.querySelectorAll('[data-brush-tone]'))n.removeAttribute('data-brush-tone');return}await engine.setTheme(document.documentElement.dataset.color==='light'?'light':'dark');measure();draw(0);};
 window.brushPreview={snapshot:()=>({clock,tracks:Object.fromEntries(Object.entries(tracks).map(([k,v])=>[k,v.snapshot()]))}),finish:()=>{for(const t of Object.values(tracks))t.finish();draw(0);},replay:()=>{for(const t of Object.values(tracks)){t.tone(t.current,false);t.current=null;t.beginPaint();}}};
 engine.mount().then(async()=>{await window.syncSelectionTheme();measure();for(const t of Object.values(tracks))t.finish();draw(0);window.selectionReady=true;});
 let disposed=false;
 window.disposeSelectionFlow=()=>{if(disposed)return;disposed=true;window.removeEventListener('laurel:panel-activity',onActivity);offMotion();observer.disconnect();resize.disconnect();list.removeEventListener('scroll',measure);engine.dispose();for(const t of Object.values(tracks))t.dispose();donors.remove();alloy.remove();};
 addEventListener('pagehide',()=>window.disposeSelectionFlow(),{once:true});

})();
