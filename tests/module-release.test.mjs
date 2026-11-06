import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildRelease,seedCatalog} from '../scripts/build-module-release.mjs'
import {verifyPublication} from '../scripts/verify-release-catalog.mjs'

function source(t){
 const root=mkdtempSync(join(tmpdir(),'laurel-publish-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 writeFileSync(join(root,'package.json'),JSON.stringify({version:'1.8.5'}))
 for(const row of seedCatalog().modules){const dir=join(root,'packages',row.dir);mkdirSync(join(dir,'lib'),{recursive:true});writeFileSync(join(dir,'package.json'),JSON.stringify({name:row.entry,version:'1.0.0',type:'module'}));writeFileSync(join(dir,'lib/index.js'),'export function apply() {}')}
 const center=join(root,'center.tgz');writeFileSync(center,'center-fixture')
 return {root,center}
}
test('module-only releases keep verified Center and old assets, reject changed version bytes, retain retired entries',t=>{
 const {root,center}=source(t),previous=buildRelease(join(root,'first'),{root,centerFile:center,published:true})
 previous.modules.push({...seedCatalog().modules[0],id:'retired-sample',dir:'retired-sample',entry:'retired-sample',settingsId:'retired-sample',releases:[]})
 const path=join(root,'packages/laurel/lib/index.js');writeFileSync(path,'export function apply() { return 1 }')
 assert.throws(()=>buildRelease(join(root,'bad'),{root,previousCatalog:previous,tag:'modules-next'}),/bump its independent version/)
 const pkg=join(root,'packages/laurel/package.json'),meta=JSON.parse(readFileSync(pkg));meta.version='1.0.1';writeFileSync(pkg,JSON.stringify(meta))
 const next=buildRelease(join(root,'next'),{root,previousCatalog:previous,tag:'modules-next'})
 assert.deepEqual(next.center.releases,previous.center.releases)
 const row=next.modules.find(r=>r.id==='laurel');assert.deepEqual(row.releases.map(r=>r.version),['1.0.1','1.0.0']);assert.equal(row.releases[0].published,false);assert.ok(row.releases[1].url.includes('/v1.8.5/'))
 assert.equal(next.modules.find(r=>r.id==='retired-sample').retired,true)
 assert.throws(()=>buildRelease(join(root,'tag'),{root,tag:'../bad'}),/Invalid release tag/)
})
test('publication promotion checks remote bytes before returning a new verified catalog',async t=>{
 const {root,center}=source(t),out=join(root,'release'),candidate=buildRelease(out,{root,centerFile:center})
 const original=JSON.stringify(candidate),fetchImpl=async url=>new Response(readFileSync(join(out,new URL(url).pathname.split('/').pop())))
 const verified=await verifyPublication(candidate,{fetchImpl});assert.ok([verified.center,...verified.modules].every(row=>row.releases.every(r=>r.published)));assert.equal(JSON.stringify(candidate),original)
 await assert.rejects(verifyPublication(candidate,{fetchImpl:async url=>{const bytes=readFileSync(join(out,new URL(url).pathname.split('/').pop()));return new Response(Buffer.alloc(bytes.length,1))}}),/hash does not match/)
 assert.equal(JSON.stringify(candidate),original)
 await assert.rejects(verifyPublication(candidate,{fetchImpl:async()=>new Response('missing',{status:404})}),/HTTP 404/)
})
