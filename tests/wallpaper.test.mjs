import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {normalizePresentation,writePresentation,readPresentation,presentationFile,createPresentationHandler} from '../lib/ui-preferences.js'
import {createWallpaperHandler} from '../lib/wallpaper-store.js'
const image='a'.repeat(64)+'.webp'
test('wallpaper modes retain independent settings across durable writes and reject path/URL references',()=>{
 const root=mkdtempSync(join(tmpdir(),'laurel-wallpaper-prefs-'));try{
  const file=presentationFile(root,'one')
  const w={enabled:true,mode:'global',global:{fit:'cover',image,blur:8,opacity:25},sidebar:{fit:'tile',image,blur:18,opacity:40},conversation:{fit:'contain',image,blur:0,opacity:18}}
  writePresentation(file,{wallpaper:w,shadows:{sidebar:{strength:22,distance:14,direction:'right'}}})
  writePresentation(file,{wallpaper:{...w,mode:'separate'}})
  writePresentation(file,{colorMode:'light'})
  const value=readPresentation(file);assert.deepEqual(value.wallpaper,{...w,mode:'separate'});assert.equal(value.shadows.sidebar.strength,22);assert.equal(value.shadows.sidebar.direction,'right');assert.equal(normalizePresentation({shadows:{sidebar:{direction:'bad'}}}).shadows.sidebar.direction,'left');assert.equal(normalizePresentation({}).shadows.sidebar.direction,'left')
  assert.equal(readPresentation(presentationFile(root,'two')).wallpaper.enabled,false)
  const invalid=normalizePresentation({wallpaper:{global:{image:'https://x/a.png',blur:Infinity,opacity:-20},sidebar:{image:'../../x'}},shadows:{composer:{strength:900,distance:-8}}})
  assert.equal(invalid.wallpaper.global.fit,'cover');assert.equal(normalizePresentation({wallpaper:{global:{fit:'bogus'}}}).wallpaper.global.fit,'cover');assert.equal(normalizePresentation({wallpaper:{global:{fit:'fill'}}}).wallpaper.global.fit,'fill');assert.equal(invalid.wallpaper.global.image,'');assert.equal(invalid.wallpaper.sidebar.image,'');assert.equal(invalid.wallpaper.global.blur,0);assert.equal(invalid.wallpaper.global.opacity,0);assert.equal(invalid.shadows.composer.strength,60);assert.equal(invalid.shadows.composer.distance,0)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('real image HTTP storage admits, bounds, deduplicates concurrent uploads and serves immutable local bytes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'laurel-wallpaper-http-'));let disposed=false
 const handler=createWallpaperHandler({root,admit:req=>req.headers['x-qa']==='1'?null:403,disposed:()=>disposed})
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port+'/api/laurel-center/wallpapers'
 const headers={'x-qa':'1','content-type':'image/webp'},bytes=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64')
 try{
  assert.equal((await fetch(url,{method:'POST',body:bytes})).status,403)
  assert.equal((await fetch(url,{method:'POST',headers,body:'not image'})).status,415)
  assert.equal((await fetch(url,{method:'POST',headers,body:Buffer.alloc(3*1024*1024+1)})).status,413)
  const responses=await Promise.all([1,2,3].map(()=>fetch(url,{method:'POST',headers,body:bytes})));for(const r of responses)assert.equal(r.status,200)
  const values=await Promise.all(responses.map(r=>r.json()));assert.equal(values[0].image,values[2].image);assert.match(values[0].image,/^[a-f0-9]{64}\.webp$/)
  assert.equal(readdirSync(root).length,1)
  const img=url+'/'+values[0].image,res=await fetch(img,{headers});assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),bytes);assert.match(res.headers.get('cache-control'),/immutable/)
  assert.equal((await fetch(img,{headers,method:'HEAD'})).headers.get('content-length'),String(bytes.length))
  assert.equal((await fetch(url+'/%2e%2e%2fsecret',{headers})).status,404)
  assert.equal((await fetch(img,{headers,method:'DELETE'})).status,405)
  disposed=true;assert.equal((await fetch(img,{headers})).status,503)
 }finally{await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true})}
})
