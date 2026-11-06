// Two stationary strokes: erase old left-to-right, then paint new left-to-right.
// A canvas changes position only while completely empty. No travel transforms.
(() => {
 const clamp=x=>Math.max(0,Math.min(1,x));
 class BrushTrack {
  constructor({parent,kind,source}){
   Object.assign(this,{parent,kind,source,current:null,wanted:null,phase:'idle',elapsed:0,progress:1,oldPaint:1,reduced:false,paused:false,speed:1,paintMs:650,eraseMs:410});
   this.canvas=document.createElement('canvas');this.canvas.className='flow-selection';this.canvas.dataset.brushKind=kind;this.canvas.setAttribute('aria-hidden','true');this.canvas.hidden=true;parent.append(this.canvas);
   this.context=this.canvas.getContext('2d');this.pigment=document.createElement('canvas');this.pc=this.pigment.getContext('2d');this.mask=document.createElement('canvas');this.mc=this.mask.getContext('2d');
  }
  tone(item,on){on=on&&document.documentElement.dataset.theme!=='industrial';if(item?.element?.isConnected){if(on){if(item.element.dataset.brushTone!=='light')item.element.dataset.brushTone='light';}else if(item.element.dataset.brushTone)delete item.element.dataset.brushTone;}}
  select(item){
   this.wanted=item;
   if(this.current?.key===item?.key&&this.phase!=='erase'){this.current=item?{...this.current,...item}:null;return;}
   if(this.reduced){this.finish();return;}if(this.phase==='erase')return;
   if(this.current){this.oldPaint=this.phase==='paint'?this.progress:1;this.elapsed=0;this.phase='erase';this.progress=0;}
   else this.beginPaint();
  }
  beginPaint(){this.tone(this.current,false);this.current=this.wanted?{...this.wanted}:null;this.elapsed=0;this.progress=0;if(!this.current){this.phase='idle';this.canvas.hidden=true;return;}this.phase='paint';this.place();this.canvas.hidden=false;}
  place(){
   if(!this.current)return;const r=this.current.rect,key=[r.x,r.y,r.w,r.h,devicePixelRatio].join(',');if(key===this.placed)return;this.placed=key;this.canvas.style.cssText=`left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;`;
   const ratio=Math.min(devicePixelRatio||1,1.5),w=Math.max(1,Math.round(r.w*ratio)),h=Math.max(1,Math.round(r.h*ratio));
   for(const c of [this.canvas,this.pigment,this.mask])if(c.width!==w||c.height!==h){c.width=w;c.height=h;}
  }
  front(p,mode){
   if(p>=1){if(mode==='destination-out')this.context.clearRect(0,0,this.canvas.width,this.canvas.height);return;}
   if(p<=0){if(mode==='destination-in')this.context.clearRect(0,0,this.canvas.width,this.canvas.height);return;}
   const w=this.mask.width,h=this.mask.height,c=this.mc,front=(-.12+1.24*p)*w,key=mode+':'+w+':'+h;
   this.frontCache??=new Map();let strip=this.frontCache.get(key);
   if(!strip){
    strip=document.createElement('canvas');strip.width=w*3;strip.height=h;const sc=strip.getContext('2d'),feather=mode==='destination-out'?Math.max(14,w*.052):Math.max(7,w*.022);
    for(let y=0;y<h;y++){
     const yy=y/h,bristle=(Math.sin(yy*24.1)+Math.sin(yy*62.9)*.44+Math.sin(yy*131.7)*.2)*Math.min(9,w*.022),edge=w+bristle;
     const gradient=sc.createLinearGradient(edge-feather,0,edge+feather,0);gradient.addColorStop(0,'#fff');gradient.addColorStop(1,'#fff0');sc.fillStyle=gradient;sc.fillRect(0,y,strip.width,1);
    }if(this.frontCache.size>3)this.frontCache.clear();this.frontCache.set(key,strip);
   }
   c.clearRect(0,0,w,h);c.drawImage(strip,w-front,0,w,h,0,0,w,h);
   this.context.globalCompositeOperation=mode;this.context.drawImage(this.mask,0,0);this.context.globalCompositeOperation='source-over';
  }
  update(dt){
   if(this.reduced)this.finish();
   else if(!this.paused&&this.phase!=='idle'){
    this.elapsed+=dt*this.speed;this.progress=clamp(this.elapsed/(this.phase==='erase'?this.eraseMs:this.paintMs));
    if(this.phase==='erase'&&this.progress>=1)this.beginPaint();
    else if(this.phase==='paint'&&this.progress>=1){this.phase='idle';this.progress=1;this.tone(this.current,true);}
   }
   this.render();
  }
  render(){
   if(document.documentElement.dataset.theme==='industrial'){this.tone(this.current,false);this.canvas.hidden=true;return;}
   if(!this.current){this.canvas.hidden=true;return;}this.canvas.hidden=false;this.place();const c=this.context,w=this.canvas.width,h=this.canvas.height;
   if(this.phase!=='erase'){const donor=this.source(this.current);if(donor?.width){this.pc.clearRect(0,0,w,h);this.pc.drawImage(donor,0,0,w,h);

   }}
   c.clearRect(0,0,w,h);c.drawImage(this.pigment,0,0);
   if(this.phase==='paint'){this.front(this.progress,'destination-in');this.tone(this.current,this.progress>(this.kind==='tab'?.49:.31));}
   else if(this.phase==='erase'){this.front(this.oldPaint,'destination-in');this.front(this.progress,'destination-out');this.tone(this.current,this.progress<(this.kind==='tab'?.49:.31));}
   else this.tone(this.current,true);
   this.canvas.dataset.phase=this.phase;this.canvas.dataset.progress=this.progress.toFixed(3);this.canvas.dataset.brushKey=this.current.key;
  }
  finish(){this.tone(this.current,false);this.current=this.wanted?{...this.wanted}:null;this.phase='idle';this.elapsed=0;this.progress=1;this.oldPaint=1;}
  configure(p){Object.assign(this,p);if(this.reduced)this.finish();this.render();}
  snapshot(){return{kind:this.kind,phase:this.phase,progress:this.progress,current:this.current?.key,wanted:this.wanted?.key,rect:this.current?.rect,transform:getComputedStyle(this.canvas).transform};}
  dispose(){this.tone(this.current,false);this.canvas.remove();}
 }
 window.InkBrushTrack=BrushTrack;
})();
