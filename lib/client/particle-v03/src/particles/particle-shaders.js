// Independent shaders. Crisp normal-blended cores + sparse additive halos.
// Halo gain/radius are this requested adaptation, not measured official values.
export const vertexShader = /* glsl */`
attribute vec4 seed;
attribute vec3 departure;
uniform float time,arrival,pointScale,pixelRatio,opacity,motion,gather,viewZoom;
uniform vec2 depthRange,viewport;
uniform float accentRatio,glowType,glowStrength,glowRadius,glowPass;
varying float strength,accent,phase,spriteScale,modelY;
void main(){
 float layer=floor(seed.z*3.);
 float delay=layer<.5?0.:(layer<1.5?1.386:2.197);
 float duration=layer<.5?3.:(layer<1.5?1.5:1.);
 float stage=clamp((arrival*3.2-delay)/duration,0.,1.);
 float ease=stage<.5?2.*stage*stage:1.-pow(-2.*stage+2.,2.)*.5;
 float sweep=mix(-1350.,1150.,ease)-(seed.y-.5)*170.;
 float local=mix(smoothstep(-75.,65.,sweep-position.y),1.,step(.999,arrival));
 vec3 pos=mix(departure,position,mix(1.,local,gather));
 float burst=step(5.5,mod(time,6.));
 float stripe=step(.92,sin(floor(position.y/22.)*13.7+floor(time*14.)));
 pos.x+=burst*stripe*sin(time*30.)*32.*motion;
 vec4 view=modelViewMatrix*vec4(pos,1.);
 gl_Position=projectionMatrix*view;
 float fade=1.-smoothstep(depthRange.x,depthRange.y,-view.z);
 float projectionScale=(viewport.y/pixelRatio/1080.)*(2000./max(400.,-view.z))*viewZoom;
 float diameter=(1.55+seed.x*1.2)*pointScale*projectionScale;
 float pixels=diameter*pixelRatio;
 accent=1.-step(accentRatio,seed.w);
 if(glowPass>.5&&(accent<.5||glowType<.5||glowStrength<=0.)){gl_PointSize=1.;gl_Position=vec4(2.,2.,2.,1.);return;}
 spriteScale=glowPass>.5?1.+glowRadius*(4.4+min(glowStrength,3.)*1.4):1.;
 gl_PointSize=clamp(max(1.6,pixels)*spriteScale,1.,96.*pixelRatio);
 strength=(.38+.4*seed.y)*opacity*fade*local*(1.-layer*.2)*min(1.,max(.35,pixels));
 phase=seed.x*48.7+seed.y*113.1;modelY=position.y;
}`;
export const fragmentShader = /* glsl */`
uniform vec2 viewport;
uniform float screenVignette,time,clarity,glowType,glowStrength,glowPass;
uniform vec3 baseColor,accentColor,secondaryColor;
varying float strength,accent,phase,spriteScale,modelY;
void main(){
 vec2 coord=(gl_PointCoord-.5)*2.*spriteScale;
 float r=length(coord);
 float envelope=1.;
 if(glowType>1.5&&glowType<2.5)envelope=.45+.55*(.5+.5*sin(time*2.2+phase));
 if(glowType>2.5&&glowType<3.5)envelope=.22+.78*pow(.5+.5*sin(time*3.3+phase),8.);
 if(glowType>3.5&&glowType<4.5)envelope=.12+.88*exp(-abs(modelY/950.-sin(time*.7))*7.);
 if(glowType>4.5&&glowType<5.5)envelope=.1+.9*step(.72,sin(floor(time*13.)+phase)*sin(floor(time*7.)+phase*.31));
 vec3 highlight=accentColor;
 if(glowType>5.5)highlight=mix(accentColor,secondaryColor,.5+.5*sin(time*1.8+phase));
 vec2 uv=gl_FragCoord.xy/viewport;
 float vignette=1.-smoothstep(.36,.55,length(vec2((uv.x-.4)*.67,uv.y-.5)));
 float alpha;
 vec3 color;
 if(glowPass>.5){
  if(accent<.5||glowType<.5||glowStrength<=0.||r>spriteScale)discard;
  float halo=(exp(-r*r*.21)*.62+exp(-r*r*.035)*.14);
  if(glowType>2.5&&glowType<3.5)halo+=exp(-min(abs(coord.x),abs(coord.y))*13.-r*.28)*1.2;
  halo*=1.-smoothstep(spriteScale*.65,spriteScale,r);
  alpha=halo*strength*glowStrength*envelope;
  color=highlight;
 }else{
  if(r>.92)discard;
  float feather=mix(.42,.09,clarity);
  alpha=(1.-smoothstep(.72-feather,.92,r))*strength;
  color=mix(baseColor,highlight,accent);
 }
 alpha*=mix(1.,vignette,screenVignette);
 if(alpha<.002)discard;
 gl_FragColor=vec4(color,alpha);
}`;
