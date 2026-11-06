import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {createPresentationHandler,readPresentation} from '../lib/ui-preferences.js'
import {createPresentationClient} from '../lib/client/library-state.mjs'
import {EndfieldAudio} from '../lib/client/endfield-runtime.mjs'

test('shared preferences admit the new sound fields and persist them without changing business config',async()=>{
 const file=join(mkdtempSync(join(tmpdir(),'laurel-v05-')),'presentation.json')
 const handler=createPresentationHandler({file,connection:()=>({admit:()=>null})})
 const server=createServer((req,res)=>void handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port+'/api/laurel-center/presentation'
 const post=(patch,header=true)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(header?{'x-laurel-ui':'1'}:{})},body:JSON.stringify(patch)})
 try{
  assert.equal((await post({soundEffects:false,music:true,experienceRevision:5})).status,200)
  assert.equal(readPresentation(file).soundEffects,false);assert.equal(readPresentation(file).music,true)
  const before=readFileSync(file,'utf8')
  assert.equal((await post({soundEffects:'false'})).status,400)
  assert.equal((await post({experienceRevision:4})).status,400)
  assert.equal((await post({enabled:true})).status,400)
  assert.equal((await post({music:false},false)).status,403)
  assert.equal(readFileSync(file,'utf8'),before)
 }finally{await new Promise(r=>server.close(r))}
})

test('queued saves report the result of each transaction when an earlier write fails',async()=>{
 let n=0;const client=createPresentationClient({storage:()=>null,fetcher:async()=>{n++;return {ok:n!==1,json:async()=>n===1?{ok:false,error:'disk full'}:{ok:true,value:{music:false}}}}})
 const first=client.update({soundEffects:false}),second=client.update({music:false})
 assert.deepEqual(await first,{saved:false,error:'disk full'});assert.deepEqual(await second,{saved:true})
 assert.equal(client.getSnapshot().saved,true);assert.equal(client.getSnapshot().music,false);assert.equal(client.getSnapshot().soundEffects,false)
})

test('muting effects cancels sound waiting for bytes and leaves the music preference intact',async()=>{
 const old={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch}
 globalThis.document={hidden:false};globalThis.window={}
 let release,started=0;globalThis.fetch=()=>new Promise(r=>release=()=>r({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)}))
 const audio=new EndfieldAudio();audio.ready=async()=>{};audio.state=()=>{};audio.musicSync=async()=>{};audio.ctx={state:'running',decodeAudioData:async()=>({}),createBufferSource:()=>({connect(){},start(){started++},stop(){}}),suspend:async()=>{}}
 audio.prefs={sound:true,soundEffects:true,music:true};audio.unlock()
 try{const sound=audio.play('confirm');await new Promise(r=>setImmediate(r));audio.configure({...audio.prefs,soundEffects:false});release();await sound;assert.equal(started,0);assert.equal(audio.prefs.music,true)}finally{Object.assign(globalThis,old)}
})


test('restored Si presets and motion policy round-trip through authenticated storage without erasing other preferences',async()=>{
 const file=join(mkdtempSync(join(tmpdir(),'laurel-motion-repair-')),'presentation.json')
 const handler=createPresentationHandler({file,connection:()=>({admit:()=>null})})
 const server=createServer((req,res)=>void handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port+'/api/laurel-center/presentation'
 const post=patch=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-laurel-ui':'1'},body:JSON.stringify(patch)})
 try{
  await post({sound:false,musicVolume:.27,favorites:['laurel'],motion:true})
  for(const siTheme of ['si-flow-v03','si-paper-v01']){
   const response=await post({siTheme,followSystemMotion:true,siEnabled:false})
   assert.equal(response.status,200);const body=await response.json()
   assert.equal(body.value.siTheme,siTheme);assert.equal(body.value.followSystemMotion,true);assert.equal(body.value.siEnabled,false)
   assert.equal(body.value.sound,false);assert.equal(body.value.musicVolume,.27);assert.deepEqual(body.value.favorites,['laurel'])
  }
  const before=readFileSync(file,'utf8')
  for(const patch of [{siTheme:'removed-theme'},{followSystemMotion:'false'},{siEnabled:1}])assert.equal((await post(patch)).status,400)
  assert.equal(readFileSync(file,'utf8'),before)
  await post({motion:true,followSystemMotion:false,siEnabled:true})
  assert.equal(readPresentation(file).followSystemMotion,false)
 }finally{await new Promise(r=>server.close(r))}
})
