import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync,symlinkSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createServer} from 'node:http'
import {gzipSync,gunzipSync} from 'node:zlib'
import {qaOutput} from './private-output.mjs'
import {CATALOG_URL} from '../lib/module-catalog.js'
import {hash} from '../lib/module-store.js'

const runtime=process.env.LAUREL_DSH_RUNTIME,releaseDir=process.env.LAUREL_QA_RELEASE
if(!runtime||!releaseDir)throw Error('Set LAUREL_DSH_RUNTIME (exact rc.5 runtime) and LAUREL_QA_RELEASE (built candidate)')
const restarting=process.argv.includes('--verify-restart'),migration=process.argv.includes('--verify-migration')
const out=qaOutput(migration?'native-migration':'native-module-store'),home=join(out,'isolated-home'),profileDir=join(home,'profiles','laurel-node-qa'),anchor=join(runtime,'package.json')
assert.equal(JSON.parse(readFileSync(anchor,'utf8')).version,'0.2.1-rc.5');process.env.DSH_HOME=home
const native=join(runtime,'node_modules/@deepseek-ai'),{boot,PluginPackages,createRuntimeResolution,loadProfileDirectory}=await import(pathToFileURL(join(native,'dsh-app-boot/lib/index.js')).href)
const assets=new Map(),catalog=JSON.parse(readFileSync(join(releaseDir,'release-catalog.json'),'utf8'))
for(const row of [catalog.center,...catalog.modules])for(const r of row.releases){r.published=true;assets.set(r.url,readFileSync(join(releaseDir,new URL(r.url).pathname.split('/').pop())))}
const checks=[],check=(name,pass)=>{assert.ok(pass,name);checks.push({name,pass:true})}
function unpack(tgz,target){mkdirSync(target,{recursive:true});const p=spawnSync('tar',['-xzf',tgz,'--strip-components=1','-C',target],{encoding:'utf8'});if(p.status)throw Error(p.stderr)}
const initial=migration?join(releaseDir,'migration/laurel-center-migration-1.8.5.tgz'):join(releaseDir,'laurel-center-1.8.5.tgz')
const config=join(profileDir,'cordis.yml')
if(!restarting){
mkdirSync(join(profileDir,'node_modules'),{recursive:true});symlinkSync(join(runtime,'node_modules/@deepseek-ai'),join(profileDir,'node_modules/@deepseek-ai'),'dir')
unpack(initial,join(profileDir,'node_modules/laurel-center'))
writeFileSync(join(profileDir,'package.json'),JSON.stringify({name:'isolated-laurel-node-qa',private:true,type:'module',dependencies:{'laurel-center':'file:'+initial},dsh:{profile:{bundles:['laurel-center']}}},null,2))
writeFileSync(join(profileDir,'cordis.patch.yml'),'[]\n')
writeFileSync(config,JSON.stringify([{id:'server',name:pathToFileURL(join(native,'dsh-host-webserver/lib/index.js')).href,config:{host:'127.0.0.1',port:0}},{id:'plugin-manager',name:pathToFileURL(join(native,'dsh-plugin-manager/lib/index.js')).href,config:{idleTimeoutMs:20000}},{id:'laurel-center',name:'laurel-center',config:{logLevel:'error'}}],null,2))
if(migration){mkdirSync(join(home,'laurel-center'),{recursive:true});writeFileSync(join(home,'laurel-center/modules.json'),JSON.stringify({enabled:{'reasoning-scroll':true}}));mkdirSync(join(home,'laurel-reasoning-scroll'),{recursive:true});writeFileSync(join(home,'laurel-reasoning-scroll/settings.json'),JSON.stringify({maxHeight:357}))}
}
const feed=createServer((req,res)=>{const key=decodeURIComponent(req.url.slice(1)),bytes=key===CATALOG_URL?Buffer.from(JSON.stringify(catalog)):assets.get(key);res.writeHead(bytes?200:404);res.end(bytes||'missing')});await new Promise(r=>feed.listen(0,'127.0.0.1',r))
const fetchOriginal=globalThis.fetch,feedOrigin='http://127.0.0.1:'+feed.address().port
globalThis.fetch=(url,options)=>url===CATALOG_URL||assets.has(String(url))?fetchOriginal(feedOrigin+'/'+encodeURIComponent(url),options):fetchOriginal(url,options)
let ctx,origin
async function start(){
 const resolution=await createRuntimeResolution({installAnchor:anchor,home,profile:loadProfileDirectory('laurel-native-qa',profileDir,anchor)})
 ctx=await boot('laurel-native-qa',config,[],async root=>{
  root.provide('profileContext',{name:'laurel-node-qa',dir:profileDir,home,patchPath:join(profileDir,'cordis.patch.yml'),installAnchor:anchor,startedBundles:['laurel-center'],overlays:[],packageManager:{command:'pnpm'}})
  // Controlled peer and idle boundary. Loader, WebServer, PluginManager and all
  // package activation/HTTP/settings operations below are the actual rc.5 code.
  root.provide('connection',{admit:req=>req.headers['x-qa-peer']==='local'?{peer:{}}:{rejection:401}})
  root.provide('agents',{list:()=>[]})
  await root.plugin(PluginPackages,{resolution})
 },pathToFileURL(join(profileDir,'package.json')).href)
 await ctx.get('laurelCenter').ready();origin=ctx.get('webServer').getOrigin()
}
async function request(path,body){const r=await fetchOriginal(origin+path,{headers:{'x-laurel-ui':'1','x-qa-peer':'local','content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});const raw=await r.text();assert.ok(r.ok,path+': HTTP '+r.status+' '+raw.slice(0,300));return JSON.parse(raw)}
async function settle(){for(let i=0;i<500;i++){const s=await request('/api/laurel-center/store');if(!['checking','downloading','applying'].includes(s.job.phase)){assert.notEqual(s.job.phase,'failed',s.job.error);return s}await new Promise(r=>setTimeout(r,50))}throw Error('Native operation timed out')}
async function action(action,id,version){await request('/api/laurel-center/store',{action,id,...(version?{version}:{})});return settle()}
try{
 if(restarting){
  await start();check('new Node process loads installed Center version and preserves module configuration',ctx.get('laurelCenter').identity().version==='1.8.6'&&(await request('/laurel/reasoning-scroll/config')).data.config.maxHeight===333)
  check('new process clears the stale Center restart prompt',!(await request('/api/laurel-center/store')).center.restartRequired)
 }else if(migration){
  await start();const status=await request('/api/laurel-center/store');writeFileSync(join(out,'migration-initial-status.json'),JSON.stringify(status,null,2));check('final migration package adopts all seven production modules',status.modules.length===7&&status.modules.every(r=>r.installed)&&!status.error)
  check('final migration package retains enabled state and existing module settings',status.modules.find(r=>r.id==='reasoning-scroll').enabled&&(await request('/laurel/reasoning-scroll/config')).data.config.maxHeight===357)
  const records=JSON.parse(readFileSync(join(profileDir,'.laurel-modules/installed.json'))).installed
  for(const id of ['memory-core','context-compress']){const row=records[id],module=await import(pathToFileURL(join(profileDir,'.laurel-modules/slots',row.slot,'packages',row.dir,'lib/index.js')).href);check(id+' resolves its production shared-core dependency from the migration slot',typeof module.apply==='function')}
  check('migration preserves the original legacy switch file',readFileSync(join(home,'laurel-center/modules.json'),'utf8')===JSON.stringify({enabled:{'reasoning-scroll':true}}))
  await ctx.fiber.dispose();await start();check('migration is idempotent across a second boot',JSON.stringify(JSON.parse(readFileSync(join(profileDir,'.laurel-modules/installed.json'))).installed)===JSON.stringify(records))
 }else{
 await start();let status=await request('/api/laurel-center/store');check('slim archive cold-boots with zero installed modules',status.modules.every(r=>!r.installed))
 check('native admission rejects an absent peer',(await fetchOriginal(origin+'/api/laurel-center/store',{headers:{'x-laurel-ui':'1'}})).status===401)
 await action('install','reasoning-scroll','0.1.0');const enabled=await request('/api/laurel-center/modules',{id:'reasoning-scroll',enabled:true});check('real production module installs and activates on native Loader',enabled.applied)
 const saved=await request('/laurel/reasoning-scroll/config',{maxHeight:333});check('real module settings HTTP write is verified',saved.ok&&saved.data.persisted&&saved.data.verified.matches)
 await ctx.fiber.dispose();await start();const restored=await request('/laurel/reasoning-scroll/config');check('cold boot restores installed module, enabled state and configuration',restored.data.config.maxHeight===333)
 const moduleRow=catalog.modules.find(r=>r.id==='reasoning-scroll'),old=moduleRow.releases[0],archive=JSON.parse(gunzipSync(assets.get(old.url)))
 archive.version='0.1.1'
 for(const f of archive.files){if(f.path.endsWith('/package.json')){const p=JSON.parse(Buffer.from(f.data,'base64'));p.version='0.1.1';f.data=Buffer.from(JSON.stringify(p)).toString('base64')}if(f.path.endsWith('/lib/index.js'))f.data=Buffer.from(Buffer.from(f.data,'base64').toString().replace("VERSION = '0.1.0'","VERSION = '0.1.1'")).toString('base64')}
 const newer=gzipSync(Buffer.from(JSON.stringify(archive))),url=old.url.replace('0.1.0','0.1.1');assets.set(url,newer);moduleRow.releases.unshift({...old,version:'0.1.1',url,bytes:newer.length,sha256:hash(newer)})
 // A fresh process removes the manual-check cooldown without changing production policy.
 await ctx.fiber.dispose();await start();const updated=await action('update','reasoning-scroll','0.1.1');check('production host module updates independently and keeps configuration',updated.modules.find(r=>r.id==='reasoning-scroll').version==='0.1.1'&&(await request('/laurel/reasoning-scroll/config')).data.config.maxHeight===333)
 await action('rollback','reasoning-scroll');check('production module rollback restores previous runtime',(await request('/laurel/reasoning-scroll/status')).data.version==='0.1.0')
 await action('remove','reasoning-scroll');check('uninstall unregisters its real native HTTP route',(await fetchOriginal(origin+'/laurel/reasoning-scroll/config')).status===404)
 await action('install','reasoning-scroll','0.1.1');await request('/api/laurel-center/modules',{id:'reasoning-scroll',enabled:true});check('reinstall preserves existing user settings',(await request('/laurel/reasoning-scroll/config')).data.config.maxHeight===333)
 const nextSource=join(out,'next-center-fixture');unpack(initial,nextSource)
 const meta=JSON.parse(readFileSync(join(nextSource,'package.json'),'utf8'));meta.version='1.8.6';writeFileSync(join(nextSource,'package.json'),JSON.stringify(meta,null,2));const conf=join(nextSource,'lib/config.js');writeFileSync(conf,readFileSync(conf,'utf8').replace("VERSION = '1.8.5'","VERSION = '1.8.6'"))
 const packed=join(out,'next');mkdirSync(packed);const pack=spawnSync('pnpm',['pack','--pack-destination',packed,'--skip-manifest-obfuscation'],{cwd:nextSource,encoding:'utf8'});assert.equal(pack.status,0,pack.stderr)
 const nextBytes=readFileSync(join(packed,'laurel-center-1.8.6.tgz')),nextUrl='https://github.com/Sakayorilove/dsh-Laurel/releases/download/v1.8.6/laurel-center-1.8.6.tgz';assets.set(nextUrl,nextBytes);catalog.center.releases.unshift({...catalog.center.releases[0],version:'1.8.6',url:nextUrl,bytes:nextBytes.length,sha256:hash(nextBytes)})
 await ctx.fiber.dispose();await start();const next=await action('center-update','laurel-center','1.8.6');check('native PluginManager installs verified Center tarball and reports restart',next.job.phase==='restart-required'&&next.center.version==='1.8.5')
 writeFileSync(join(out,'center-install-inventory.json'),JSON.stringify(await ctx.get('pluginManager').listBundles(),null,2))
 await ctx.fiber.dispose();ctx=null
 const restarted=spawnSync(process.execPath,[new URL(import.meta.url).pathname,'--verify-restart'],{encoding:'utf8',env:process.env,timeout:60000})
 writeFileSync(join(out,'restart-process.log'),restarted.stdout+'\n'+restarted.stderr)
 check('a fresh process after native Center update loads new code and keeps independently installed modules',restarted.status===0)
 }
}finally{
 if(ctx)await ctx.fiber.dispose();globalThis.fetch=fetchOriginal;feed.closeAllConnections();await new Promise(r=>feed.close(r))
 writeFileSync(join(out,restarting?'native-restart-qa.json':'native-store-qa.json'),JSON.stringify({nativeVersion:'0.2.1-rc.5',scope:'Isolated pure Node profile; actual DSH boot/Loader, WebServer, PluginManager and production module archives. Peer and idle boundary are controlled. No daily desktop or Web profile touched. Center 1.8.6 is a private test fixture.',checks},null,2))
}
console.log(JSON.stringify({checks:checks.length,out}))
