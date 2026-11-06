import {SI_FLOW_ASSETS} from './assets.js';
export function createSiFlowEngine() {
const ASSETS = SI_FLOW_ASSETS;
// Real pigment transport: source RGBA is advected along each measured brush.
// Moving alpha and displaced fibre edges are intentional; text stays in DOM.
const imageCache=new Map(),materialCache=new Map();
function imageOf(name){if(!imageCache.has(name))imageCache.set(name,new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('笔触素材读取失败：'+name));image.src=ASSETS[name];}));return imageCache.get(name);}
class Material{
 constructor(canvas,engine){
  this.canvas=canvas;this.kind=canvas.dataset.ink;this.engine=engine;this.context=canvas.getContext('2d');this.frames=0;this.data=null;this.rect=null;
  // Pigment simulation keeps its measured source resolution. Presentation is
  // fitted separately to the native control; transparent asset margins must
  // never determine the size of the visible selection or composer frame.
  this.texture=document.createElement('canvas');this.textureContext=this.texture.getContext('2d');
  this.resize=new ResizeObserver(()=>{this.rect=null;if(this.data)this.present();});this.resize.observe(canvas);
 }
 present(){
  if(!this.data||!this.canvas.isConnected)return;
  const rect=this.rect||(this.rect=this.canvas.getBoundingClientRect()),ratio=Math.min(devicePixelRatio||1,1.5);
  const original=this.engine.canvasMode==='actual';
  const w=Math.max(1,Math.round(rect.width*ratio),original?this.data.crop[2]:0),h=Math.max(1,Math.round(rect.height*ratio),original?this.data.crop[3]:0);
  const rx=w/Math.max(1,rect.width),ry=h/Math.max(1,rect.height);
  if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
  const c=this.context;c.clearRect(0,0,w,h);c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';
  const {w:sw,h:sh,crop}=this.data;
  if(this.kind==='composer'||this.kind==='message'){
   // Measured stroke centre-lines, not the outer PNG rectangle. Nine regions
   // keep the corner curvature stable as a native editor grows taller.
   const dark=this.engine.themeName==='dark';
   const frame=this.kind==='composer'?(dark?[28,27,1093,173]:[18,21,1105,164]):(dark?[22,15,485,88]:[17,10,483,82]);
   const [l,t,r,b]=frame;
   const nativeRadius=Math.min(this.kind==='composer'?22:14,rect.height*.32,rect.width*.18);
   const radiusX=nativeRadius*rx,radiusY=nativeRadius*ry,insetX=2*rx,insetY=2*ry,cutX=Math.min(68,(r-l)*.18),cutY=Math.min(32,(b-t)*.3);
   const xs=[0,l+cutX,r-cutX,sw],ys=[0,t+cutY,b-cutY,sh];
   const sx=radiusX/cutX,sy=radiusY/cutY;
   const xd=[insetX-l*sx,insetX+radiusX,w-insetX-radiusX,w-insetX+(sw-r)*sx];
   const yd=[insetY-t*sy,insetY+radiusY,h-insetY-radiusY,h-insetY+(sh-b)*sy];
   for(let y=0;y<3;y++)for(let x=0;x<3;x++)c.drawImage(this.texture,xs[x],ys[y],xs[x+1]-xs[x],ys[y+1]-ys[y],xd[x],yd[y],xd[x+1]-xd[x],yd[y+1]-yd[y]);
  }else{
   const [x,y,cw,ch]=crop;c.drawImage(this.texture,x,y,cw,ch,0,0,w,h);
  }
 }
 dispose(){this.resize.disconnect();this.data=null;}

 async theme(theme){
  const key=theme+'-'+this.kind;
  if(!materialCache.has(key))materialCache.set(key,(async()=>{
   const [im,fm]=await Promise.all([imageOf(key+'.png'),imageOf(key+'-flow.png')]);
   const w=im.width,h=im.height,temp=document.createElement('canvas');temp.width=w;temp.height=h;const ctx=temp.getContext('2d',{willReadFrequently:true});ctx.drawImage(im,0,0);const source=ctx.getImageData(0,0,w,h);ctx.clearRect(0,0,w,h);ctx.drawImage(fm,0,0);const f=ctx.getImageData(0,0,w,h).data;
   // Dilated support lets the actual ink silhouette move, including faint
   // feathered pixels. The previous engine pinned alpha to the original image.
   const reach=this.kind==='header'?1:this.kind==='tab'?2:this.kind==='progress'?3:6,coverage=new Uint8Array(w*h);
   for(let y=0;y<h;y++)for(let x=0;x<w;x++){if(source.data[(y*w+x)*4+3]<3)continue;for(let dy=-reach;dy<=reach;dy++){const yy=y+dy;if(yy<0||yy>=h)continue;for(let dx=-reach;dx<=reach;dx++){const xx=x+dx;if(xx>=0&&xx<w)coverage[yy*w+xx]=1;}}}
   const entries=[];
   for(let p=0;p<w*h;p++){
    if(!coverage[p])continue;const i=p*4,x=p%w,y=Math.floor(p/w);
    const s=(f[i]*256+f[i+1])/65535,angle=f[i+2]/255*Math.PI*2,tx=Math.cos(angle),ty=Math.sin(angle);
    // Both phases travel in one direction. Per-pixel phases preserve organic
    // striation; there is no moving rectangular sheen or animated text layer.
    const a=s*Math.PI*2*4+y*.014,b=s*Math.PI*2*9+y*.065;
    let belly=0;if(this.kind==='module'){const u=x/w,v=y/h;belly=Math.max(0,Math.min(1,(u-.04)/.04,(.56-u)/.08,(v-.07)/.1,(.93-v)/.1));belly=belly*belly*(3-2*belly);}entries.push({i,x,y,tx,ty,sa:Math.sin(a),ca:Math.cos(a),sb:Math.sin(b),cb:Math.cos(b),belly});
   }
   // Selection artwork contains an 18px empty bottom margin. Fit its actual
   // pigment support to the native row instead of scaling that margin too.
   let minX=w,minY=h,maxX=0,maxY=0;
   const threshold=this.kind==='new-chat'?40:3;
   for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(source.data[(y*w+x)*4+3]>=threshold){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x+1);maxY=Math.max(maxY,y+1);}
   const crop=maxX>minX?[minX,minY,maxX-minX,maxY-minY]:[0,0,w,h];
   return {w,h,crop,source:source.data,original:source,entries,out:new ImageData(w,h)};
  })());
  this.data=await materialCache.get(key);this.texture.width=this.data.w;this.texture.height=this.data.h;this.draw(this.engine.time);return this;
 }
 draw(time){
  if(!this.data||!this.context)return;const {w,h,source,original,entries,out}=this.data;
  if(this.engine.reduced){this.textureContext.putImageData(original,0,0);this.present();this.record(original.data);return;}
  const result=out.data,p=(time%8)/8*Math.PI*2,cp=Math.cos(p),sp=Math.sin(p),c2=Math.cos(2*p),s2=Math.sin(2*p);
  const normal=this.kind==='header'?.45:this.kind==='tab'?.8:this.kind==='progress'?1.2:this.kind==='selected'?2.6:3.0;
  const tangent=this.kind==='header'?10:this.kind==='progress'?20:this.kind==='selected'?22:18;
  for(const e of entries){
   const wave=e.sa*cp-e.ca*sp,eddy=e.sb*c2-e.cb*s2;
   const advance=wave*tangent+eddy*7,across=(wave*.72+eddy*.28)*normal;
   const x=Math.max(0,Math.min(w-1.001,e.x-e.tx*advance+e.ty*across)),y=Math.max(0,Math.min(h-1.001,e.y-e.ty*advance-e.tx*across));
   const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,a=(iy*w+ix)*4,b=a+4,c=a+w*4,d=c+4;
   // Premultiplied bilinear sampling avoids black halos on transparent fibres.
   const wa=(1-fx)*(1-fy)*source[a+3],wb=fx*(1-fy)*source[b+3],wc=(1-fx)*fy*source[c+3],wd=fx*fy*source[d+3],sa=wa+wb+wc+wd;
   const base=source[e.i+3],moving=sa*.84,anchor=base*.16,alpha=moving+anchor;
   const density=1+wave*.20+eddy*.10;
   for(let ch=0;ch<3;ch++){
    const movingPigment=sa>.01?(source[a+ch]*wa+source[b+ch]*wb+source[c+ch]*wc+source[d+ch]*wd)/sa:0;
    result[e.i+ch]=alpha>.01?(movingPigment*moving+source[e.i+ch]*anchor)/alpha:0;
   }
   let finalAlpha=Math.min(255,alpha*density);if(e.belly&&finalAlpha>150)finalAlpha+=Math.max(0,244-finalAlpha)*e.belly;result[e.i+3]=finalAlpha;
  }
  this.textureContext.putImageData(out,0,0);this.present();this.record(result);
 }
 record(result){this.frames++;if(this.frames%8===0){let hash=0;for(let i=0;i<result.length;i+=37)hash=(Math.imul(hash,31)+result[i])|0;this.canvas.setAttribute('data-frame',String(this.frames));this.canvas.setAttribute('data-pixel-hash',String(hash));}}
 snapshot(){return{kind:this.kind,frames:this.frames,pixels:this.data?.entries.length??0,visible:this.canvas.getClientRects().length>0};}
}
class FlowEngine{
 constructor(){this.materials=[];this.time=0;this.themeName='light';this.speed=1;this.canvasMode='fit';this.paused=false;this.reduced=false;this.raf=0;this.last=0;this.disposed=false;this.drawn=0;this.loading=0;this.targetFPS=60;this.listeners=new Set();this.drawMs=0;this.framesSample=0;this.sampleAt=0;this.measuredFPS=0;this.visibleHandler=()=>{this.stop();this.start();};document.addEventListener('visibilitychange',this.visibleHandler);document.documentElement.dataset.flowBuild='rgba-advection-native-fit-r4';}
 async mount(){
  this.materials=this.materials.filter(m=>{if(m.canvas.isConnected)return true;m.dispose();return false;});
  const nodes=[...document.querySelectorAll('canvas[data-ink]')].filter(c=>!this.materials.some(m=>m.canvas===c));
  const fresh=nodes.map(c=>new Material(c,this));this.materials.push(...fresh);await Promise.all(fresh.map(m=>m.theme(this.themeName)));this.draw();this.start();
 }
 async setTheme(theme){this.stop();const id=++this.loading;this.themeName=theme;await Promise.all(this.materials.map(m=>m.theme(theme)));if(id!==this.loading)return;this.draw();this.start();}
 draw(){const started=performance.now(),time=this.time;for(const m of this.materials){if(m.canvas.isConnected&&m.canvas.dataset.siFlowOffscreen!=='true'&&m.canvas.getClientRects().length&&!m.canvas.closest('[hidden]'))m.draw(time);}this.drawMs=performance.now()-started;this.drawn++;for(const fn of this.listeners)fn(this.frameDelta||0);if(this.drawn%8===0){document.documentElement.setAttribute('data-motion-time',time.toFixed(2));document.documentElement.setAttribute('data-draw-ms',(performance.now()-started).toFixed(1));}}
 canRun(){return !this.disposed&&!this.paused&&!this.reduced&&!document.hidden;}
 start(){
  if(this.raf||!this.canRun())return;let previous=0,due=0,lastPaint=0;
  const tick=now=>{this.raf=0;if(!this.canRun())return;
   if(!previous){previous=now;lastPaint=now;due=now;}const dt=Math.max(0,Math.min(250,now-previous));previous=now;this.time+=dt*.001*this.speed;
   const interval=1000/this.targetFPS;
   if(now+.3>=due){this.frameDelta=now-lastPaint;lastPaint=now;this.draw();due+=interval;if(due<now-interval)due=now+interval;
    if(!this.sampleAt)this.sampleAt=now;this.framesSample++;if(now-this.sampleAt>=500){this.measuredFPS=this.framesSample*1000/(now-this.sampleAt);this.framesSample=0;this.sampleAt=now;}
   }this.raf=requestAnimationFrame(tick);
  };this.raf=requestAnimationFrame(tick);
 }
 stop(){if(this.raf)cancelAnimationFrame(this.raf);this.raf=0;this.last=0;this.frameDelta=0;}
 configure(patch){const {fps,...rest}=patch;Object.assign(this,rest);if(fps!==undefined)this.targetFPS=[30,60,90,120].includes(+fps)?+fps:60;this.stop();this.draw();this.start();}
 onFrame(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}

 setTime(time){this.time=time;this.draw();}
 dispose(){this.disposed=true;this.stop();document.removeEventListener('visibilitychange',this.visibleHandler);for(const m of this.materials)m.dispose();this.materials=[];this.listeners.clear();materialCache.clear();}
 snapshot(){return{targetFPS:this.targetFPS,measuredFPS:this.measuredFPS,drawMs:this.drawMs,renderer:'canvas2d',build:'rgba-advection-native-fit-r4',time:this.time,paused:this.paused,reduced:this.reduced,speed:this.speed,canvasMode:this.canvasMode,raf:!!this.raf,drawn:this.drawn,materials:this.materials.map(m=>m.snapshot()),disposed:this.disposed};}
}

return new FlowEngine();
}
