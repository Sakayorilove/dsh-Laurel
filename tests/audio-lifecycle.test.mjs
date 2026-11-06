import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EndfieldAudio} from '../lib/client/endfield-runtime.mjs'
import {normalizePresentationValue} from '../lib/presentation-model.js'

test('control-center BGM lifecycle fades, cancels stale starts, and leaves no animation loop', async () => {
  const originals=Object.fromEntries(['document','Audio','requestAnimationFrame','cancelAnimationFrame','performance'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]))
  let time=0,id=0,created=0,pending=false,resolvePlay
  const frames=new Map()
  class Track {
    constructor(){created++;this.volume=1;this.paused=true}
    play(){this.paused=false;return pending?new Promise(r=>resolvePlay=r):Promise.resolve()}
    pause(){this.paused=true}
    removeAttribute(){} load(){}
  }
  const step=ms=>{time+=ms;const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn(time))}
  Object.defineProperties(globalThis,{
    document:{configurable:true,value:{hidden:false,body:{dataset:{}}}},
    Audio:{configurable:true,value:Track},
    performance:{configurable:true,value:{now:()=>time}},
    requestAnimationFrame:{configurable:true,value:fn=>{frames.set(++id,fn);return id}},
    cancelAnimationFrame:{configurable:true,value:i=>frames.delete(i)},
  })
  const a=new EndfieldAudio(),p=normalizePresentationValue({musicVolume:.4})
  try {
    a.configure(p);a.unlock();await Promise.resolve()
    assert.equal(created,0,'chat gestures never create/start BGM')
    a.setActive(true,{announce:false});await Promise.resolve()
    assert.equal(a.music.volume,0);assert.equal(a.music.paused,false)
    step(325);assert.ok(a.music.volume>0&&a.music.volume<.4)
    step(325);assert.equal(a.music.volume,.4);assert.equal(frames.size,0)
    a.setActive(false);assert.equal(a.music.paused,false)
    step(190);assert.ok(a.music.volume>0&&a.music.volume<.4)
    step(190);assert.equal(a.music.volume,0);assert.equal(a.music.paused,true);assert.equal(frames.size,0)
    pending=true;a.setActive(true,{announce:false});a.setActive(false);step(400);resolvePlay();await Promise.resolve()
    assert.equal(a.music.paused,true,'late play promise cannot restart music after exit')
    pending=false;a.setActive(true,{announce:false});await Promise.resolve();step(100)
    document.hidden=true;a.stop();assert.equal(frames.size,0);assert.equal(a.music.paused,true)
    document.hidden=false;await a.musicSync();step(650);assert.equal(a.music.volume,.4)
    a.configure({...p,sound:false});assert.equal(a.music.paused,true);assert.equal(frames.size,0)
    a.dispose();assert.equal(a.music,null)
  } finally {
    a.dispose();for(const[k,v]of Object.entries(originals)){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k]}
  }
})

test('V0.1 stays default; V0.2 themes, independent gains and bounded local markers round-trip',()=>{
  assert.equal(normalizePresentationValue({}).theme,'endfield')
  for(const theme of ['endfield','wuling','endfield-v02','wuling-v02'])assert.equal(normalizePresentationValue({theme}).theme,theme)
  const p=normalizePresentationValue({theme:'wuling-v02',navMode:'baker',musicVolume:.18,areaVolume:.9,rewardVolume:.95,workspaceMarkers:{one:{type:'emoji',text:'🌿',color:'#aabbcc'},two:{type:'image',image:'https://evil.example/a.png'}}})
  assert.equal(p.navMode,'baker');assert.equal(p.areaVolume,.9);assert.equal(p.rewardVolume,.95);assert.equal(p.musicVolume,.18)
  assert.equal(p.workspaceMarkers.one.text,'🌿');assert.equal(p.workspaceMarkers.two,undefined)
  assert.deepEqual(normalizePresentationValue(JSON.parse(JSON.stringify(p))),p)
})
