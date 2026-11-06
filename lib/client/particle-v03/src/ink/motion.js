import {INK_PIGMENT} from './assets.js';
// Original preview implementation. Pigment comes from the existing approved RGBA brush.
// This is a bounded compositing effect, not a Navier–Stokes simulation or a PV reconstruction.
(() => {
 const root=document.documentElement;
 let reduced=false,paused=false,speed=1,fps=60,ticket=0,active=null,raf=0,phase='idle',lastMask=null,finishFrame=null;
 const layers=new Set(),mask=document.createElement('canvas'),ctx=mask.getContext('2d');
 mask.width=384;mask.height=224;
 const W=mask.width,H=mask.height,data=ctx.createImageData(W,H),noise=new Float32Array(W*H);
 // Actual source pigment is sampled as a second density field. Shape is transported over time.
 const grain=document.createElement('canvas');grain.width=W;grain.height=H;
 const gc=grain.getContext('2d',{willReadFrequently:true});let pigment=null;
 const texture=new Image();texture.onload=()=>{gc.drawImage(texture,0,0,W,H);pigment=gc.getImageData(0,0,W,H).data;};texture.src=INK_PIGMENT;
 function rand(x,y){let n=Math.imul(x,374761393)^Math.imul(y,668265263);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295;}
 function smooth(n){return n*n*(3-2*n);}
 function valueNoise(x,y){const ix=Math.floor(x),iy=Math.floor(y),fx=smooth(x-ix),fy=smooth(y-iy);return (rand(ix,iy)*(1-fx)+rand(ix+1,iy)*fx)*(1-fy)+(rand(ix,iy+1)*(1-fx)+rand(ix+1,iy+1)*fx)*fy;}
 for(let y=0;y<H;y++)for(let x=0;x<W;x++)noise[y*W+x]=valueNoise(x*.024,y*.024)*.58+valueNoise(x*.063,y*.063)*.28+valueNoise(x*.17,y*.17)*.14;
 function matte(p,reverse){
  const t=p*Math.PI*2,front=-.4+p*1.8;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
   const i=y*W+x,k=i*4,n=noise[i],nx=reverse?x/W:1-x/W,ny=y/H;
   // Three broad currents and two smaller eddies deform the advancing wet edge.
   const u=nx*.74+ny*.26;
   const curl=Math.sin(ny*10.5+nx*3.2-t*.55)*.095+Math.sin(ny*24-nx*9+t*.8)*.037+Math.sin(nx*19+ny*11-t)*.026;
   const fibres=pigment?(pigment[((y+Math.floor(p*67))%H*W+(x+Math.floor(p*43))%W)*4+3]/255-.55)*.045:0;
   const d=front-u+curl+(n-.5)*.3+fibres;
   let a=smooth(Math.max(0,Math.min(1,(d+.024)/.06)));
   // Separated semi-transparent pigment fingers run ahead, then join the main body.
   const wake=Math.exp(-Math.pow((d+.075)/.046,2))*.4*Math.pow(Math.max(0,Math.sin(ny*39+nx*13-t*1.6)+n-.5),2);
   a=Math.min(1,a+wake);if(p<.015)a*=p/.015;if(p>.94)a+=(1-a)*(p-.94)/.06;
   data.data[k]=data.data[k+1]=data.data[k+2]=255;data.data[k+3]=Math.round((1-a)*255);
  }
  ctx.putImageData(data,0,0);lastMask=mask.toDataURL('image/png');if(active)active.style.maskImage=`url("${lastMask}")`;
 }
 function stop(){cancelAnimationFrame(raf);raf=0;finishFrame?.();finishFrame=null;active?.remove();active=null;phase='idle';}
 async function snapshot(){
  // A temporary, inert DOM visual copy works inside srcdoc/file:// as well as normal pages.
  // Canvas images are copied individually; normal text and controls remain HTML in the live page.
  const copy=root.cloneNode(true);copy.querySelectorAll('script,.ink-page-snapshot').forEach(n=>n.remove());
  const originals=[...root.querySelectorAll('canvas')],clones=[...copy.querySelectorAll('canvas')];
  clones.forEach((c,i)=>{try{const im=document.createElement('img');im.src=originals[i].toDataURL();im.style.cssText=c.style.cssText;im.className=c.className;im.width=c.width;im.height=c.height;for(const a of [...c.attributes])if(a.name!=='style'&&a.name!=='class')im.setAttribute(a.name,a.value);c.replaceWith(im);}catch{c.remove();}});
  const freeze=document.createElement('style');freeze.textContent='*{animation:none!important;transition:none!important;caret-color:transparent!important}';copy.querySelector('head').append(freeze);
  const seat=document.createElement('iframe');seat.className='ink-page-snapshot';seat.setAttribute('aria-hidden','true');seat.inert=true;seat.tabIndex=-1;seat.style.cssText='position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483000;pointer-events:none;mask-size:100% 100%;mask-repeat:no-repeat;';
  const ready=new Promise(r=>{seat.onload=r;});seat.srcdoc='<!doctype html>'+copy.outerHTML;document.body.append(seat);await ready;return seat;
 }
 async function transition(commit,{reverse=false,duration=1450}={}){
  const id=++ticket;stop();
  if(reduced){await commit();return;}
  phase='preparing';const visual=await snapshot();if(id!==ticket){visual.remove();return;}active=visual;matte(0,reverse);
  await commit();if(id!==ticket)return;phase='flowing';let last=0,elapsed=0,due=0;
  await new Promise(resolve=>{finishFrame=resolve;
   function frame(now){
    if(id!==ticket){resolve();return;}
    if(!last)last=now;const dt=Math.min(60,now-last);last=now;
    if(!paused)elapsed+=dt*speed;
    const p=Math.min(1,elapsed/duration),e=p*p*(3-2*p);if(now+.3>=due||p===1){matte(e,reverse);due+=1000/fps;if(due<now-1000/fps)due=now+1000/fps;}
    if(p===1){resolve();return;}raf=requestAnimationFrame(frame);
   }raf=requestAnimationFrame(frame);
  });
  if(id===ticket)stop();
 }
 function configure(patch){
  if('reduced'in patch)reduced=patch.reduced;
  if('paused'in patch)paused=patch.paused;
  if('speed'in patch)speed=patch.speed;
  if('fps'in patch)fps=[30,60,90,120].includes(+patch.fps)?+patch.fps:60;
  if(reduced){ticket++;stop();}
  for(const f of layers)f({reduced,paused,speed,fps});
 }
 window.InkMotion={transition,configure,cancel(){ticket++;stop();},register(fn){layers.add(fn);fn({reduced,paused,speed,fps});return()=>layers.delete(fn)},snapshot:()=>({phase,reduced,paused,speed,fps,active:!!active,mask:lastMask?.length||0}),capture:p=>matte(p,false)};
 addEventListener('pagehide',()=>{ticket++;stop();layers.clear()});
})();
