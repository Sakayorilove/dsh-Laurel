import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { ModuleStore, hash, unpackModule } from '../lib/module-store.js'
import { compareVersions, validateCatalog, compatibleRelease, fetchBytes } from '../lib/module-catalog.js'
import { mountModules, saveEnabled } from '../lib/modules.js'
import { createStoreHandler } from '../lib/module-store-api.js'
import { seedCatalog, moduleArchive } from '../scripts/build-module-release.mjs'
import { VERSION } from '../lib/config.js'

// 控制中心版本跟着源码走：写死版本号的测试只是在测「版本号没变」。
const NEXT_CENTER = (() => { const parts = VERSION.split('.').map(Number); return parts[0] + '.' + parts[1] + '.' + (parts[2] + 1) })()

const metadata = (id='sample',hidden=false) => ({id,dir:id,entry:id,settingsId:id,category:'experience',title:{zh:id,en:id},desc:{zh:'模块',en:'Module'},hidden,releases:[]})
async function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'laurel-store-')),profileDir=join(root,'profile'),dataPaths={dir:join(root,'data')},bundle=join(root,'node_modules/laurel-center'),assets=new Map()
  mkdirSync(bundle,{recursive:true});mkdirSync(dataPaths.dir,{recursive:true})
  const catalog={schema:1,center:seedCatalog().center,modules:[metadata(),metadata('core',true)]}
  const release=(id,version,{broken=false,dependency=false,script=false}={})=>{
    const row=catalog.modules.find(r=>r.id===id),files=[['package.json',JSON.stringify({name:id,version,type:'module',exports:{'.':'./lib/index.js','./client':'./lib/client.js'},...(script?{scripts:{postinstall:'bad'}}:{})})],['lib/index.js',broken?'throw Error("activation broke")':'export function apply(ctx){ctx.mark?.("'+version+'")};export const version="'+version+'"'],['lib/client.js','window.__ModuleLoader__.load({ id: "'+id+'", factory: () => ({ apply(ctx) { ctx.clientMark?.("'+version+'") } }) })']]
    const archive={schema:1,id,version,files:files.map(([p,s])=>({path:'packages/'+id+'/'+p,data:Buffer.from(s).toString('base64')}))},bytes=gzipSync(Buffer.from(JSON.stringify(archive)))
    const r={version,sha256:hash(bytes),bytes:bytes.length,url:'https://github.com/Sakayorilove/dsh-Laurel/releases/download/v1.8.5/'+id+'-'+version+'.lmod',hostVersions:['0.2.1-rc.5'],centerApi:1,dataSchema:1,published:true,dependencies:dependency?[{id:'core',version:'1.0.0'}]:[]}
    row.releases.unshift(r);assets.set(r.url,bytes);return {row,r,bytes,archive}
  }
  release('core','1.0.0');release('sample','1.0.0',{dependency:true})
  writeFileSync(join(bundle,'release-catalog.json'),JSON.stringify(catalog))
  let offline=false,slow=false,port
  const server=createServer((req,res)=>{if(offline){res.writeHead(503);res.end();return}const url=decodeURIComponent(req.url.slice(1));const bytes=url==='catalog'?Buffer.from(JSON.stringify(catalog)):assets.get(url);if(!bytes){res.writeHead(404);res.end();return}res.writeHead(200,{'content-length':bytes.length});if(slow)setTimeout(()=>res.end(bytes),80);else res.end(bytes)})
  await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port
  const make=()=>new ModuleStore({profileDir,dataPaths,specs:[metadata()],hostVersion:'0.2.1-rc.5',bundledRoot:bundle,catalogUrl:'https://catalog.invalid/feed',isBusy:()=>false,fetchImpl:(url,opts)=>fetch('http://127.0.0.1:'+port+'/'+encodeURIComponent(url==='https://catalog.invalid/feed'?'catalog':url),opts)})
  const store=make();t.after(async()=>{store.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true})})
  return {root,profileDir,dataPaths,bundle,catalog,assets,release,store,make,offline:value=>offline=value,slow:value=>slow=value}
}
test('release versions sort numerically, prereleases stay opt-in, catalog trust and compatibility fail closed',()=>{
  assert.equal(compareVersions('1.10.0','1.9.0'),1);assert.equal(compareVersions('1.0.0-rc.10','1.0.0-rc.2'),1);assert.equal(compareVersions('1.0.0','1.0.0-rc.9'),1)
  assert.throws(()=>compareVersions('1.0.0-01','1.0.0'))
  const catalog=seedCatalog();catalog.modules[0].releases=[{version:'1.0.0',bytes:12,sha256:'a'.repeat(64),url:'https://evil.invalid/code',hostVersions:['0.2.1-rc.5'],centerApi:1,published:true}]
  assert.throws(()=>validateCatalog(catalog),/官方发布源/)
  catalog.modules[0].releases[0].url='https://github.com/Sakayorilove/dsh-Laurel/releases/download/v1/x.lmod'
  const checked=validateCatalog(catalog);assert.equal(compatibleRelease(checked.modules[0],'0.2.1-rc.6'),null)
  checked.modules[0].releases[0].published=false;assert.equal(compatibleRelease(checked.modules[0],'0.2.1-rc.5'),null)
})
test('real HTTP installs dependencies into an immutable slot, survives restart, uninstalls without deleting settings or data',async t=>{
  const f=await fixture(t),s=f.store
  assert.equal(s.snapshot().modules[0].installAvailable,false)
  await s.check(true);await s.exclusive(()=>s.install('sample','1.0.0'))
  assert.equal(s.snapshot().modules[0].version,'1.0.0');assert.equal(s.snapshot().modules[0].enabled,false)
  const slot=join(s.root,'slots',s.state.installed.sample.slot);assert.ok(existsSync(join(slot,'packages/core/lib/index.js')))
  const config=join(f.dataPaths.dir,'settings.json');writeFileSync(config,'{"key":"preserve"}')
  const restarted=f.make();assert.equal(restarted.snapshot().modules[0].installed,true);assert.equal(restarted.checkedAt,null)
  await restarted.exclusive(()=>restarted.remove('sample'));assert.equal(restarted.snapshot().modules[0].installed,false);assert.equal(readFileSync(config,'utf8'),'{"key":"preserve"}')
  await restarted.check(true);await restarted.exclusive(()=>restarted.install('sample','1.0.0'));assert.notEqual(restarted.state.installed.sample.slot,s.state.installed.sample.slot);restarted.close()
})
test('enabled module update activates the new code, failed activation restores old code, and rollback preserves enabled state',async t=>{
  const f=await fixture(t),s=f.store,marks=[]
  await s.check(true);await s.exclusive(()=>s.install('sample','1.0.0'));saveEnabled({sample:true},s.paths,[metadata()])
  const ctx={plugin(plugin){let error;try{plugin.apply({mark:v=>marks.push(v)})}catch(e){error=e}return{state:error?3:2,await:async()=>{if(error)throw error},dispose:async()=>{marks.push('dispose')}}}}
  const modules=mountModules(ctx,{initiallyEnabled:{sample:true},paths:s.paths,getSpecs:()=>s.specs(),load:dir=>s.resolvePlugin(dir)});s.modules=modules;await modules.ready()
  f.release('sample','1.1.0');s.lastAttempt=0;await s.check(true);await s.exclusive(()=>s.install('sample','1.1.0'));assert.equal(s.state.installed.sample.version,'1.1.0');assert.equal(marks.at(-1),'1.1.0')
  f.release('sample','1.2.0',{broken:true});s.lastAttempt=0;await s.check(true)
  await assert.rejects(s.exclusive(()=>s.install('sample','1.2.0')),/activation broke/);assert.equal(s.state.installed.sample.version,'1.1.0');assert.equal(modules.list()[0],'sample');assert.equal(marks.at(-1),'1.1.0')
  await s.exclusive(()=>s.rollback('sample'));assert.equal(s.state.installed.sample.version,'1.0.0');assert.equal(modules.enabled('sample'),true)
  await modules.disposeAll()
})
test('tampered hashes, illegal paths and install scripts cannot replace a working installation',async t=>{
  const f=await fixture(t),s=f.store;await s.check(true);await s.exclusive(()=>s.install('sample','1.0.0'))
  const bad=f.release('sample','1.1.0');f.assets.set(bad.r.url,Buffer.alloc(bad.r.bytes,1));s.lastAttempt=0;await s.check(true)
  await assert.rejects(s.exclusive(()=>s.install('sample','1.1.0')),/校验/);assert.equal(s.state.installed.sample.version,'1.0.0')
  for(const path of ['packages/sample/../../escape','packages/sample/lib/CON.js','packages/sample/lib/a.js/../b.js']){
    const archive={...bad.archive,files:[...bad.archive.files,{path,data:'eA=='}]},bytes=gzipSync(Buffer.from(JSON.stringify(archive))),target=join(f.root,'unpack-'+hash(bytes).slice(0,8))
    assert.throws(()=>unpackModule(bytes,bad.row,{...bad.r,sha256:hash(bytes),bytes:bytes.length},target),/非法文件/)
  }
  const scripts=f.release('sample','1.3.0',{script:true});s.lastAttempt=0;await s.check(true);await assert.rejects(s.exclusive(()=>s.install('sample','1.3.0')),/声明/)
  assert.equal(existsSync(join(f.root,'escape')),false)
})
test('busy host, incompatible or unpublished feed, stale checks and concurrent transactions block mutations',async t=>{
  const f=await fixture(t),s=f.store;await s.check(true)
  s.isBusy=()=>true;s.start('install','sample','1.0.0');await s.activeJob;assert.equal(s.job.phase,'failed');assert.equal(s.snapshot().modules[0].installed,false)
  s.isBusy=()=>false
  let unlock;const held=s.exclusive(()=>new Promise(r=>unlock=r));await assert.rejects(s.exclusive(async()=>{}),/另一个/);unlock();await held
  f.offline(true);s.lastAttempt=0;await s.check(true);assert.ok(s.snapshot().stale);await assert.rejects(s.exclusive(()=>s.install('sample','1.0.0')),/先检查/)
  f.offline(false);s.lastAttempt=0;f.catalog.modules[0].releases[0].published=false;await s.check(true);assert.equal(s.snapshot().modules[0].installAvailable,false)
  await assert.rejects(s.exclusive(()=>s.install('sample','1.0.0')),/先检查/)
})
test('catalog removal retains the installed module and its uninstall controls; new IDs need no Center update',async t=>{
  const f=await fixture(t),s=f.store;await s.check(true);await s.exclusive(()=>s.install('sample','1.0.0'))
  f.catalog.modules=f.catalog.modules.filter(r=>r.id!=='sample');f.catalog.modules.push(metadata('new-module'));f.release('new-module','1.0.0');s.lastAttempt=0;await s.check(true)
  const rows=s.snapshot().modules;assert.equal(rows.find(r=>r.id==='sample').retired,true);assert.equal(rows.find(r=>r.id==='new-module').installAvailable,true)
  await s.exclusive(()=>s.remove('sample'));assert.equal(s.snapshot().modules.some(r=>r.id==='sample'),false)
})
test('native Center update verifies disk and running version, blocks ambiguous receipts, persists restart notice',async t=>{
  const f=await fixture(t),s=f.store,bytes=Buffer.from('native-tgz-fixture'),url='https://github.com/Sakayorilove/dsh-Laurel/releases/download/v'+NEXT_CENTER+'/laurel-center-'+NEXT_CENTER+'.tgz'
  f.assets.set(url,bytes);f.catalog.center.releases=[{version:NEXT_CENTER,url,sha256:hash(bytes),bytes:bytes.length,centerApi:1,dataSchema:1,hostVersions:['0.2.1-rc.5'],published:true}]
  let disk=VERSION,calls=0;s.getManager=()=>({listBundles:async()=>[{name:'laurel-center',version:disk,enabled:true,installed:true}],installBundle:async file=>{assert.equal(hash(readFileSync(file)),hash(bytes));calls++;disk=NEXT_CENTER;return{application:'restart-required',bundle:'laurel-center'}}})
  await s.check(true);await s.exclusive(()=>s.centerUpdate(NEXT_CENTER));assert.equal(calls,1);assert.equal(s.snapshot().job.phase,'restart-required');assert.equal(f.make().snapshot().job.phase,'restart-required')
  await assert.rejects(s.exclusive(()=>s.centerUpdate(NEXT_CENTER)),/磁盘版本/)
  s.job={phase:'failed',error:'later operation failed'};assert.equal(s.snapshot().job.phase,'failed');assert.equal(s.snapshot().center.restartRequired,true)
})
test('HTTP store checks admission, bounded mutation inputs, same-origin script access and disposal',async t=>{
  const f=await fixture(t),s=f.store;await s.check(true);await s.exclusive(()=>s.install('sample','1.0.0'))
  let disposed=false
  const handler=createStoreHandler({getStore:()=>s,connection:()=>({admit:req=>req.headers.cookie==='session=ok'?{peer:{}}:{rejection:401}}),disposed:()=>disposed})
  const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});const base='http://127.0.0.1:'+server.address().port
  assert.equal((await fetch(base+'/api/laurel-center/store')).status,403)
  assert.equal((await fetch(base+'/api/laurel-center/store',{headers:{'x-laurel-ui':'1'}})).status,401)
  const headers={'x-laurel-ui':'1',cookie:'session=ok'}
  assert.equal((await fetch(base+'/api/laurel-center/store',{headers})).status,200)
  assert.equal((await fetch(base+'/api/laurel-center/store',{method:'POST',headers,body:JSON.stringify({action:'install',unknown:1})})).status,400)
  assert.equal((await fetch(base+'/api/laurel-center/store',{method:'POST',headers,body:'x'.repeat(4100)})).status,413)
  const info=s.snapshot().modules[0].client,response=await fetch(base+info.url,{headers:{cookie:'session=ok','sec-fetch-site':'same-origin'}})
  assert.equal(response.status,200);assert.ok((await response.text()).includes(info.id))
  assert.equal((await fetch(base+info.url,{headers:{cookie:'session=ok','sec-fetch-site':'cross-site'}})).status,403)
  disposed=true;assert.equal((await fetch(base+'/api/laurel-center/store',{headers})).status,503)
})
test('release archive output is reproducible and carries independent module versions without install scripts',()=>{
  const row=seedCatalog().modules.find(r=>r.id==='memory-core'),a=moduleArchive(row),b=moduleArchive(row)
  assert.equal(hash(a.bytes),hash(b.bytes));assert.equal(a.version,'0.1.1');assert.deepEqual(a.dependencies,[{id:'laurel-core',version:'0.1.0'}])
  const root=mkdtempSync(join(tmpdir(),'laurel-artifact-'));try{const meta=unpackModule(a.bytes,row,{version:a.version,bytes:a.bytes.length,sha256:hash(a.bytes)},root);assert.equal(meta.scripts,undefined)}finally{rmSync(root,{recursive:true,force:true})}
})
test('migration adopts vendored modules exactly once and preserves old switch records',async t=>{
 const f=await fixture(t),s=f.store,row=f.catalog.modules[0],r=row.releases[0]
 unpackModule(f.assets.get(r.url),row,r,f.bundle)
 const legacy=join(f.dataPaths.dir,'modules.json'),saved=JSON.stringify({enabled:{sample:true},updatedAt:'2026-11-06'})
 writeFileSync(legacy,saved);await s.adoptLegacy();const slot=s.state.installed.sample.slot
 assert.equal(s.state.migrated,true);assert.equal(JSON.parse(readFileSync(join(s.root,'modules.json'))).enabled.sample,true)
 assert.ok(existsSync(join(s.root,'slots',slot,'packages/sample/package.json')));assert.equal((await s.resolvePlugin('sample')).ok,true)
 await s.adoptLegacy();assert.equal(s.state.installed.sample.slot,slot);assert.equal(readFileSync(legacy,'utf8'),saved)
})
test('crashed transaction locks recover, corrupt state fails closed, host upgrades cannot activate unchecked modules',async t=>{
 const f=await fixture(t),s=f.store;mkdirSync(join(s.root,'operation.lock'),{recursive:true});writeFileSync(join(s.root,'operation.lock/owner.json'),JSON.stringify({pid:2147483647}))
 await s.exclusive(async()=>{});assert.equal(existsSync(join(s.root,'operation.lock')),false)
 await s.check(true);await s.exclusive(()=>s.install('sample','1.0.0'));s.hostVersion='0.2.1-rc.6';assert.equal((await s.resolvePlugin('sample')).ok,false)
 writeFileSync(s.file,'{broken');assert.throws(()=>f.make());assert.equal(readFileSync(s.file,'utf8'),'{broken')
})
test('native inventory can clear a stale restart receipt after the user restores the running Center',async t=>{
 const f=await fixture(t),s=f.store;mkdirSync(s.root,{recursive:true});writeFileSync(join(s.root,'center-receipt.json'),JSON.stringify({version:NEXT_CENTER}))
 assert.equal(s.snapshot().job.phase,'restart-required');s.getManager=()=>({listBundles:async()=>[{name:'laurel-center',installed:true,version:VERSION}]})
 await s.syncCenterInventory();assert.equal(s.snapshot().job.phase,'idle');assert.equal(s.snapshot().center.diskVersion,VERSION)
})
