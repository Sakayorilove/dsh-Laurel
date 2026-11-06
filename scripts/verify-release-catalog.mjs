#!/usr/bin/env node
/** Read-only remote verification. Never pushes or publishes a release. */
import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {validateCatalog,fetchBytes} from '../lib/module-catalog.js'
import {hash} from '../lib/module-store.js'
export async function verifyPublication(input,{fetchImpl=globalThis.fetch}={}){
 const catalog=validateCatalog(input)
 for(const row of [catalog.center,...catalog.modules])for(const r of row.releases){
   if(r.published)continue
   const bytes=await fetchBytes(r.url,{fetchImpl,limit:32*1024*1024,expectedBytes:r.bytes,asset:true})
   if(hash(bytes)!==r.sha256)throw Error('Remote artifact hash does not match: '+row.id+'@'+r.version)
   r.published=true
 }
 return catalog
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1]
 if(!args.includes('--input')||!args.includes('--output'))throw Error('Use --input <candidate catalog> --output <verified catalog>')
 const catalog=await verifyPublication(JSON.parse(readFileSync(value('--input'),'utf8')))
 writeFileSync(value('--output'),JSON.stringify(catalog,null,2)+'\n',{flag:'wx'})
 console.log('Verified remote assets; catalog saved. Publishing it remains a separate step.')
}
