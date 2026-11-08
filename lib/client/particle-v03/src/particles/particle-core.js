import * as THREE from 'three';

// Independently written renderer. No original website JavaScript is imported.
import {vertexShader,fragmentShader} from './particle-shaders.js';
import {createParticleRing} from './particle-ring.js';
const lineVertex = /* glsl */`
attribute float alpha;
varying float a;
void main() { a = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }
`;
const lineFragment = /* glsl */`
varying float a;
void main() { gl_FragColor = vec4(.87,.89,.92,a); }
`;
export const presets = {
  spaceship: {scale:.75, offset:[400,150,0], pivot:[-800,0,0], pointSize:1, flow:'ceiling'},
  anchor: {scale:2, offset:[-550,0,0], pivot:[-5,0,10], pointSize:1.5, flow:'radial',depth:[1800,2300]},
  factory: {scale:1.25, offset:[-550,300,-300], pivot:[-50,0,0], pointSize:1, flow:'ceiling'},
  pile: {scale:1.2, offset:[-350,200,0], pivot:[-220,0,40], pointSize:1, flow:'ceiling'},
  trinity: {scale:1.25, offset:[-550,-400,-200], pivot:[0,0,0], pointSize:1.25, flow:'radial'},
  enemy: {scale:1, offset:[-600,-200,-400], pivot:[200,0,400], pointSize:1, flow:'ceiling'}
};
function randomGenerator(seed=9625) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let n = Math.imul(seed ^ seed >>> 15, 1 | seed); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}
export function normalizePointCloud(input) {
  let raw;
  if(input instanceof Float32Array) raw = input;
  else if(input instanceof ArrayBuffer) raw = new Float32Array(input);
  else throw new TypeError('Point cloud must be a Float32Array or ArrayBuffer');
  if(!raw.length || raw.length % 3) throw new Error('Point cloud must contain nonempty XYZ triples');
  const min=[Infinity,Infinity,Infinity], max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<raw.length;i++) { if(!Number.isFinite(raw[i]))throw new Error('Nonfinite point coordinate'); const k=i%3; min[k]=Math.min(min[k],raw[i]); max[k]=Math.max(max[k],raw[i]); }
  if(max[1]-min[1]<1e-8)throw new Error('Point cloud has no vertical extent');
  const scale=1900/(max[1]-min[1]), center=min.map((v,i)=>(v+max[i])/2), points=new Float32Array(raw.length);
  for(let i=0;i<raw.length;i++)points[i]=(raw[i]-center[i%3])*scale;
  return points;
}
// Original parametric shapes for reuse when game reference models are unavailable.
// These are deliberately named as alternatives, never passed off as official models.
export function createProceduralCloud(kind,count=40000) {
  const rand=randomGenerator(173+Object.keys(presets).indexOf(kind)), out=new Float32Array(count*3);
  for(let i=0;i<count;i++){
    let x=0,y=0,z=0; const a=rand()*Math.PI*2,b=rand(),c=rand(),side=rand();
    if(kind==='spaceship') { x=(b-.5)*5.2; y=(side>.45?1:-1)*(.18+.1*Math.cos(x*2)); z=(c-.5)*1.3; if(side<.12){x=(b-.5)*1.3;y=.25+c*.8;z=(rand()-.5)*.7;} }
    else if(kind==='anchor'){y=b*2.4-1.2;const r=.06+.19*Math.pow(1-Math.abs(y)/1.2,2);x=Math.cos(a)*r;z=Math.sin(a)*r; if(side<.15){x=(rand()-.5)*.5;y=-.75+(c-.5)*.08;z=(rand()-.5)*.5;}}
    else if(kind==='factory'){ const tower=Math.floor(rand()*6),cx=(tower%3-1)*.8,cz=(Math.floor(tower/3)-.5)*.9; y=b*1.4-.7;x=cx+(side>.5?(c-.5)*.64:(side>.25?-.32:.32));z=cz+(side>.5?(rand()>.5?-.32:.32):(c-.5)*.64); }
    else if(kind==='pile'){y=b*2.8-1.4;const r=.12+.09*Math.pow(Math.sin(y*8),6)+(Math.abs(y)>.9?.18:0);x=Math.cos(a)*r;z=Math.sin(a)*r;}
    else if(kind==='trinity'){const r=.38+.3*c;y=Math.cos(b*Math.PI)*r;x=Math.sin(b*Math.PI)*Math.cos(a)*r;z=Math.sin(b*Math.PI)*Math.sin(a)*r;if(side<.3){x=Math.cos(a)*1.0;y=.5+Math.sin(a)*.22;z=Math.sin(a)*.35;}}
    else {y=b*2.6-1.3;let r=y>.5?.25:(y>-.35?.4:.16);x=Math.cos(a)*r+(y<-.35?(c>.5?.28:-.28):0);z=Math.sin(a)*r;if(side<.2){x=(c>.5?1:-1)*(.45+rand()*.3);y=(b-.5)*1.4;z=(rand()-.5)*.25;}}
    out.set([x,y,z],i*3);
  }
  return out;
}
export class LoreParticles {
  constructor(container, options={}) {
    if(!container?.appendChild)throw new TypeError('A container element is required');
    this.container=container; this.options=options;this.layout=options.layout==='object'?'object':'lore';this.disposed=false;this.generation=0;this.actors=[];this.index=0;
    this.settings={pointScale:1,flow:1,speed:1,rotate:true,gather:true,quality:1,clarity:.9,rotationSpeed:1,accentRatio:.045,baseColor:'#e9edf3',accentColor:'#ffe45a',secondaryColor:'#73d9ff',glowType:1,glowStrength:1.1,glowRadius:1,ring:false,ringSpeed:1,...options.settings};
    this.zoom=1;this.userPaused=false;this.active=options.active!==false;this.intersecting=true;this.clock=0;this.realClock=0;this.ringAngle=0;this.rotation=0;this.rotationTarget=0;this.frameCount=0;
    this.scene=new THREE.Scene();this.camera=new THREE.PerspectiveCamera(75,1,.1,10000);this.camera.position.set(0,300,2000);
    this.renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'high-performance'});
    this.renderer.setClearColor(0,0);this.renderer.setPixelRatio(Math.min(options.pixelRatio||devicePixelRatio||1,3));
    this.canvas=this.renderer.domElement;this.canvas.setAttribute('aria-label','可拖动旋转的实时粒子场景');this.canvas.setAttribute('role','img');this.canvas.style.cssText='display:block;width:100%;height:100%;touch-action:pan-y;cursor:grab;';this.canvas.tabIndex=0;this.canvas.setAttribute('aria-label','实时粒子场景，拖动旋转，滚轮或加减键缩放，0 恢复适配');container.appendChild(this.canvas);
    this.motionQuery=matchMedia('(prefers-reduced-motion: reduce)');this.motionPreference=typeof options.reducedMotion==='boolean'?options.reducedMotion:null;this.reduced=this.motionPreference??this.motionQuery.matches;
    this.rayLimit=options.rayLimit||1200;this.rays=[];
    this.linePositions=new Float32Array(this.rayLimit*6);this.lineAlphas=new Float32Array(this.rayLimit*2);
    this.lineGeometry=new THREE.BufferGeometry();this.lineGeometry.setAttribute('position',new THREE.BufferAttribute(this.linePositions,3).setUsage(THREE.DynamicDrawUsage));this.lineGeometry.setAttribute('alpha',new THREE.BufferAttribute(this.lineAlphas,1).setUsage(THREE.DynamicDrawUsage));
    this.lineMaterial=new THREE.ShaderMaterial({vertexShader:lineVertex,fragmentShader:lineFragment,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending});
    this.lines=new THREE.LineSegments(this.lineGeometry,this.lineMaterial);this.lines.frustumCulled=false;this.scene.add(this.lines);
    this.rand=randomGenerator(options.seed||6925);this.abort=new AbortController();this.cache=new Map();
    this.listeners=[];const on=(el,type,fn,opts)=>{el.addEventListener(type,fn,opts);this.listeners.push(()=>el.removeEventListener(type,fn,opts));};
    on(this.canvas,'pointerdown',e=>{if(e.button!==0)return;this.drag={x:e.clientX,id:e.pointerId};this.canvas.setPointerCapture(e.pointerId);this.canvas.style.cursor='grabbing';});
    on(this.canvas,'pointermove',e=>{if(!this.drag)return;this.rotationTarget+=(e.clientX-this.drag.x)*.01;this.drag.x=e.clientX;if(this.reduced||this.userPaused){const previous=this.rotation;this.rotation=this.rotationTarget;this.ringAngle+=(this.rotation-previous)*this.settings.ringSpeed;for(const actor of this.actors)actor.group.rotation.y=this.rotation;this.syncRing();this.render();}});
    const release=()=>{this.drag=null;this.canvas.style.cursor='grab';};on(this.canvas,'pointerup',release);on(this.canvas,'pointercancel',release);on(this.canvas,'lostpointercapture',release);
    on(this.canvas,'wheel',e=>{if(e.ctrlKey||e.metaKey)return;const unit=e.deltaMode===1?16:e.deltaMode===2?this.height:1;if(!Number.isFinite(e.deltaY)||e.deltaY===0)return;e.preventDefault();this.setZoom(this.zoom*Math.exp(-Math.max(-600,Math.min(600,e.deltaY*unit))*.0015));},{passive:false});
    on(this.canvas,'keydown',e=>{if(e.ctrlKey||e.metaKey||e.altKey)return;if(['+','=','-','_','0'].includes(e.key)){e.preventDefault();this.setZoom(e.key==='0'?1:this.zoom*(e.key==='-'||e.key==='_'?1/1.15:1.15));}});
    on(document,'visibilitychange',()=>this.schedule());on(this.motionQuery,'change',()=>this.setReducedMotion(this.motionPreference));
    on(this.canvas,'webglcontextlost',e=>{e.preventDefault();this.contextLost=true;this.schedule();this.options.onError?.(new Error('WebGL context lost'));});
    on(this.canvas,'webglcontextrestored',()=>{this.contextLost=false;this.schedule();});
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);
    this.intersectionObserver=new IntersectionObserver(entries=>{this.intersecting=entries[0].isIntersecting;this.schedule();});this.intersectionObserver.observe(container);
    this.tick=stamp=>{this.raf=0;if(!this.shouldAnimate())return;const dt=Math.min((stamp-(this.lastStamp||stamp))/1000,.05);this.lastStamp=stamp;this.clock+=dt*this.settings.speed;this.realClock+=dt;this.update(dt);this.render();this.schedule();};
    this.resize();this.schedule();
  }
  shouldAnimate(){return this.active&&!this.disposed&&!this.userPaused&&!this.reduced&&!document.hidden&&this.intersecting&&!this.contextLost;}
  schedule(){if(!this.shouldAnimate()){if(this.raf)cancelAnimationFrame(this.raf);this.raf=0;this.lastStamp=0;return;}if(!this.raf)this.raf=requestAnimationFrame(this.tick);}
  resize(){if(this.disposed)return;const {width,height}=this.container.getBoundingClientRect();this.width=Math.max(1,width);this.height=Math.max(1,height);this.camera.aspect=this.width/this.height;if(this.layout==='object')this.frameObject();else this.camera.lookAt(this.width<this.height?-550:0,0,0);this.camera.updateProjectionMatrix();this.renderer.setSize(this.width,this.height,false);this.syncRing();for(const a of this.actors)a.material.uniforms.viewport.value.set(this.width*this.renderer.getPixelRatio(),this.height*this.renderer.getPixelRatio());this.render();}
  frameObject(){
    const radius=this.actor?.radius||1000;
    const vertical=THREE.MathUtils.degToRad(this.camera.fov)/2;
    const horizontal=Math.atan(Math.tan(vertical)*this.camera.aspect);
    let distance=radius/Math.sin(Math.min(vertical,horizontal));
    if(this.actor){let horizontalRadius=0,verticalDistance=0;const scale=Math.abs(this.actor.preset.scale||1),cloud=this.actor.cloud;for(let i=0;i<cloud.length;i+=3){const r=Math.hypot(cloud[i],cloud[i+2])*scale;horizontalRadius=Math.max(horizontalRadius,r);verticalDistance=Math.max(verticalDistance,r+Math.abs(cloud[i+1])*scale/Math.tan(vertical));}distance=Math.max(horizontalRadius/Math.sin(horizontal),verticalDistance);}
    distance*=1.08;
    this.camera.position.set(0,0,distance);this.camera.lookAt(0,0,0);
    this.camera.far=Math.max(10000,distance+radius*4);this.camera.updateProjectionMatrix();
    for(const a of this.actors)a.material.uniforms.depthRange.value.set(distance-radius*.1,distance+radius*1.8);this.syncRing();
  }
  setZoom(value){
    if(this.disposed||!Number.isFinite(Number(value)))return this.zoom;
    this.zoom=Math.max(.55,Math.min(2.4,Number(value)));this.camera.zoom=this.zoom;this.camera.updateProjectionMatrix();
    for(const a of this.actors)a.material.uniforms.viewZoom.value=this.zoom;
    this.syncRing();this.render();this.options.onZoomChange?.(this.zoom);return this.zoom;
  }
  async getCloud(model){
    if(model.points)return normalizePointCloud(model.points);
    if(!model.url)return normalizePointCloud(createProceduralCloud(model.id));
    if(this.cache.has(model.url))return this.cache.get(model.url);
    const promise=(async()=>{const response=await fetch(model.url,{signal:this.abort.signal});if(!response.ok)throw Error(`模型加载失败 (${response.status})`);return normalizePointCloud(await response.arrayBuffer());})();
    this.cache.set(model.url,promise);try{return await promise;}catch(e){this.cache.delete(model.url);throw e;}
  }
  async setModel(model,{immediate=false}={}){
    if(this.disposed)throw new Error('Renderer disposed');const generation=++this.generation;
    const cloud=await this.getCloud(model);if(this.disposed||generation!==this.generation)return false;
    const preset={...presets[model.id],...(this.layout==='object'?{scale:1,offset:[0,0,0],pivot:[0,0,0]}:{}),...model.preset};let radius=1;for(let k=0;k<cloud.length;k+=3)radius=Math.max(radius,Math.hypot(cloud[k],cloud[k+1],cloud[k+2]));radius*=Math.abs(preset.scale||1);const geometry=new THREE.BufferGeometry(),random=randomGenerator(841+cloud.length),seeds=new Float32Array(cloud.length/3*4),departures=new Float32Array(cloud.length);
    for(let i=0;i<cloud.length/3;i++){const a=random()*Math.PI*2,r=this.layout==='object'?radius*(2.3+random()*3):2200+random()*3000;seeds.set([random(),random(),random(),random()],i*4);departures.set([Math.cos(a)*r,cloud[i*3+1]*.2+Math.sin(a)*r,(random()-.5)*(this.layout==='object'?radius*3:2800)],i*3);}
    geometry.setAttribute('position',new THREE.BufferAttribute(cloud,3));geometry.setAttribute('seed',new THREE.BufferAttribute(seeds,4));geometry.setAttribute('departure',new THREE.BufferAttribute(departures,3));
    const material=new THREE.ShaderMaterial({vertexShader,fragmentShader,uniforms:{screenVignette:{value:this.layout==='object'?0:1},depthRange:{value:new THREE.Vector2(...(preset.depth||[500,3500]))},viewport:{value:new THREE.Vector2(this.width*this.renderer.getPixelRatio(),this.height*this.renderer.getPixelRatio())},time:{value:this.realClock},clarity:{value:this.settings.clarity},accentRatio:{value:this.settings.accentRatio},accentColor:{value:new THREE.Color(this.settings.accentColor)},secondaryColor:{value:new THREE.Color(this.settings.secondaryColor)},baseColor:{value:new THREE.Color(this.settings.baseColor)},glowType:{value:this.settings.glowType},glowStrength:{value:this.settings.glowStrength},glowRadius:{value:this.settings.glowRadius},glowPass:{value:0},viewZoom:{value:this.zoom},arrival:{value:immediate||this.reduced?1:0},pointScale:{value:(preset.pointSize||1)*this.settings.pointScale},pixelRatio:{value:this.renderer.getPixelRatio()},opacity:{value:1},motion:{value:this.reduced?0:1},gather:{value:this.settings.gather?1:0}},transparent:true,depthWrite:false,blending:THREE.NormalBlending});
    const mesh=new THREE.Points(geometry,material);mesh.frustumCulled=false;const group=new THREE.Group();group.scale.setScalar(preset.scale||1);const pivot=preset.pivot||[0,0,0],offset=preset.offset||[-550,0,0];group.position.set(...offset.map((v,i)=>v+pivot[i]));mesh.position.set(...pivot.map(v=>-v));const haloMaterial=new THREE.ShaderMaterial({vertexShader,fragmentShader,uniforms:{...material.uniforms,glowPass:{value:1}},transparent:true,depthWrite:false,depthTest:false,blending:THREE.AdditiveBlending});
    const halo=new THREE.Points(geometry,haloMaterial);halo.frustumCulled=false;halo.position.copy(mesh.position);halo.renderOrder=1;mesh.renderOrder=2;group.add(halo,mesh);group.rotation.y=this.rotation;this.scene.add(group);
    // Bound transition lifetime and retained GPU resources even under rapid changes.
    for(const old of this.actors.filter(x=>x.retiring))this.releaseActor(old);
    this.actors=this.actors.filter(x=>!x.retiring);
    for(const old of this.actors){old.retiring=true;old.retireAt=this.clock;}
    const actor={id:model.id,radius,group,mesh,halo,haloMaterial,geometry,material,preset,cloud,born:this.clock,retiring:false,immediate:immediate||this.reduced};this.actor=actor;this.actors.push(actor);if(this.layout==='object')this.frameObject();this.index++;this.rays=[];geometry.setDrawRange(0,Math.floor(cloud.length/3*this.settings.quality));
    if(this.reduced||this.userPaused){this.finishTransitions();this.render();}else this.schedule();
    this.options.onModelChange?.({id:model.id,points:cloud.length/3});return true;
  }
  releaseActor(actor){this.scene.remove(actor.group);actor.geometry.dispose();actor.material.dispose();actor.haloMaterial.dispose();}
  finishTransitions(){for(const actor of this.actors){actor.material.uniforms.arrival.value=1;actor.immediate=true;}for(const actor of this.actors.filter(x=>x.retiring))this.releaseActor(actor);this.actors=this.actors.filter(x=>!x.retiring);this.rays=[];this.lineGeometry.setDrawRange(0,0);this.render();}
  spawnRay(actor,boost){
    const rand=this.rand,n=actor.cloud.length/3,elapsed=this.clock-actor.born;
    const layer=rand()>.72?1:0,delay=layer?1.386:0,duration=layer?1.5:3;
    const t=Math.min(1,Math.max(0,(elapsed-delay)/duration));
    if(t<=0||t>=1)return;
    const eased=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2,sweep=-1350+eased*2500;
    let at=-1;
    for(let attempt=0;attempt<90;attempt++){const candidate=Math.floor(rand()*n)*3;if(Math.abs(actor.cloud[candidate+1]-sweep)<55){at=candidate;break;}}
    if(at<0)return;
    const local=new THREE.Vector3(actor.cloud[at],actor.cloud[at+1],actor.cloud[at+2]).add(actor.mesh.position);
    const target=actor.group.localToWorld(local.clone());
    let src;
    if(actor.preset.flow==='ceiling')src=new THREE.Vector3(target.x,2400,target.z);
    else src=new THREE.Vector3([-3200,400,3200][Math.floor(rand()*3)],2200,(rand()-.5)*500);

    if(this.layout==='object'){
      const halfHeight=Math.tan(THREE.MathUtils.degToRad(this.camera.fov)/2)*this.camera.position.z/this.zoom;
      const halfWidth=halfHeight*this.camera.aspect;
      src=actor.preset.flow==='ceiling'?new THREE.Vector3(target.x,halfHeight*1.25,target.z):new THREE.Vector3([-1.25,.15,1.25][Math.floor(rand()*3)]*halfWidth,halfHeight*1.25,(rand()-.5)*actor.radius*.5);
    }
    this.rays.push({src,target,actor,local,born:this.clock,duration:.25+rand()*.6,life:.3+rand()*.55,alpha:(.05+rand()*.16)*this.settings.flow,noise:rand()*10});
  }
  update(dt){
    this.frameCount++;if(this.settings.rotate&&!this.drag)this.rotationTarget+=dt*.3*this.settings.rotationSpeed;
    const previous=this.rotation;this.rotation+=(this.rotationTarget-this.rotation)*(1-Math.exp(-dt*6.32163));this.ringAngle+=(this.rotation-previous)*this.settings.ringSpeed;this.syncRing();
    for(const actor of this.actors){actor.group.rotation.y=this.rotation;const uniforms=actor.material.uniforms;uniforms.time.value=this.realClock;uniforms.motion.value=this.reduced?0:1;uniforms.arrival.value=actor.immediate?1:Math.min(1,(this.clock-actor.born)/3.2);if(actor.retiring)uniforms.opacity.value=Math.max(0,1-(this.clock-actor.retireAt)/1.6);}
    for(const actor of this.actors.filter(x=>x.retiring&&this.clock-x.retireAt>1.6))this.releaseActor(actor);
    this.actors=this.actors.filter(x=>!x.retiring||this.clock-x.retireAt<=1.6);
    if(this.actor&&this.settings.flow>0&&!this.actor.immediate&&this.clock-this.actor.born<3.3){this.actor.group.updateMatrixWorld(true);const boost=this.clock-this.actor.born<3.3;const rate=1000*this.settings.flow;this.rayRemainder=(this.rayRemainder||0)+dt*rate;const count=Math.min(70,Math.floor(this.rayRemainder));this.rayRemainder-=count;for(let i=0;i<count&&this.rays.length<this.rayLimit;i++)this.spawnRay(this.actor,boost);}
    this.updateRays();
  }
  updateRays(){
    this.rays=this.rays.filter(r=>this.clock-r.born<r.duration+r.life&&this.actors.includes(r.actor));let offset=0;
    for(const ray of this.rays){const age=this.clock-ray.born,progress=Math.min(1,age/ray.duration),fade=age>ray.duration?1-(age-ray.duration)/ray.life:1;
      const target=ray.actor.group.localToWorld(ray.local.clone());const end=ray.src.clone().lerp(target,1-Math.pow(1-progress,2));
      this.linePositions.set(ray.src.toArray(),offset*6);this.linePositions.set(end.toArray(),offset*6+3);this.lineAlphas[offset*2]=0;this.lineAlphas[offset*2+1]=ray.alpha*fade*(.65+.35*Math.sin(ray.noise+age*18));offset++;
    }
    this.lineGeometry.setDrawRange(0,offset*2);this.lineGeometry.attributes.position.needsUpdate=true;this.lineGeometry.attributes.alpha.needsUpdate=true;
  }
  syncRing(){
    if(this.disposed)return;if(!this.ring&&!this.settings.ring)return;
    if(!this.ring){this.ring=createParticleRing();this.scene.add(this.ring);}
    this.ring.visible=this.settings.ring;
    const z=this.layout==='object'?-(this.actor?.radius||1000)*.5:0;
    const radius=(this.camera.position.z-z)*Math.tan(THREE.MathUtils.degToRad(this.camera.fov)/2)*.77*Math.min(1,this.camera.aspect)/this.zoom;
    this.ring.position.set(this.layout==='object'?0:-550,0,z);this.ring.scale.setScalar(radius);
    if(this.settings.ringSpeed===1)this.ringAngle=this.rotation;
    this.ring.rotation.z=-this.ringAngle;
  }
  render(){if(this.disposed||this.contextLost)return;this.renderer.render(this.scene,this.camera);this.options.onRotation?.(this.rotation);}
  replay(){if(!this.actor||this.disposed)return;this.actor.born=this.clock;this.actor.immediate=this.reduced;this.rays=[];this.actor.material.uniforms.arrival.value=this.reduced?1:0;if(this.userPaused)this.finishTransitions();this.render();this.schedule();}
  setReducedMotion(value=null){
    if(this.disposed)return;
    if(value!==null&&typeof value!=='boolean')throw new TypeError('Reduced motion must be true, false or null');
    this.motionPreference=value;this.reduced=value??this.motionQuery.matches;
    if(this.reduced)this.finishTransitions();
    this.options.onMotionChange?.({reduced:this.reduced,systemReduced:this.motionQuery.matches,preference:this.motionPreference});
    this.render();this.schedule();
  }
  setActive(value){this.active=value!==false;this.schedule();}
  pause(){this.userPaused=true;this.schedule();}
  resume(){this.userPaused=false;this.schedule();}
  setSettings(patch){
    const finite=(v,lo,hi)=>Number.isFinite(Number(v))?Math.min(hi,Math.max(lo,Number(v))):null;
    for(const key of ['pointScale','flow','speed','quality'])if(key in patch){const v=finite(patch[key],key==='quality'?.1:0,key==='quality'?1:3);if(v!==null)this.settings[key]=v;}
    for(const key of ['rotate','gather','ring'])if(key in patch)this.settings[key]=!!patch[key];
    const ranges={clarity:[0,1],rotationSpeed:[0,3],accentRatio:[0,.3],glowType:[0,6],glowStrength:[0,3],glowRadius:[.5,2.4],ringSpeed:[0,3]};for(const [key,[lo,hi]] of Object.entries(ranges))if(key in patch){const v=finite(patch[key],lo,hi);if(v!==null)this.settings[key]=key==='glowType'?Math.round(v):v;}for(const key of ['baseColor','accentColor','secondaryColor'])if(/^#[\da-f]{6}$/i.test(patch[key]||''))this.settings[key]=patch[key];
    for(const actor of this.actors){const u=actor.material.uniforms;for(const key of ['clarity','accentRatio','glowType','glowStrength','glowRadius'])u[key].value=this.settings[key];for(const key of ['baseColor','accentColor','secondaryColor'])u[key].value.set(this.settings[key]);actor.material.uniforms.pointScale.value=(actor.preset.pointSize||1)*this.settings.pointScale;actor.material.uniforms.gather.value=this.settings.gather?1:0;actor.geometry.setDrawRange(0,Math.floor(actor.cloud.length/3*this.settings.quality));}
    if(this.settings.flow===0){this.rays=[];this.lineGeometry.setDrawRange(0,0);}this.syncRing();this.render();
  }
  stats(){return{zoom:this.zoom,cameraZoom:this.camera.zoom,glowStrength:this.settings.glowStrength,glowRadius:this.settings.glowRadius,haloPasses:this.actors.length,layout:this.layout,disposed:this.disposed,id:this.actor?.id,arrival:this.actor?.material.uniforms.arrival.value??null,sourcePoints:this.actor?.cloud.length/3||0,drawPoints:this.actor?.geometry.drawRange.count||0,actors:this.actors.length,rays:this.rays.length,frames:this.frameCount,clock:this.clock,rotation:this.rotation,paused:this.userPaused,active:this.active,reducedMotion:this.reduced,raf:!!this.raf,memory:{...this.renderer.info.memory}};}
  dispose(){if(this.disposed)return;this.disposed=true;++this.generation;this.abort.abort();if(this.raf)cancelAnimationFrame(this.raf);this.raf=0;this.resizeObserver.disconnect();this.intersectionObserver.disconnect();for(const remove of this.listeners)remove();this.listeners=[];for(const actor of this.actors)this.releaseActor(actor);this.actors=[];this.rays=[];this.cache.clear();if(this.ring){this.scene.remove(this.ring);this.ring.dispose();this.ring=null;}this.lineGeometry.dispose();this.lineMaterial.dispose();this.renderer.dispose();this.renderer.forceContextLoss();this.canvas.remove();}
}
export function createLoreParticles(container,options){return new LoreParticles(container,options);}
