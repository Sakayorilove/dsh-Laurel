/** Profile-local wallpaper bytes. Independently implemented; no remote image URLs. */
import { mkdir, readFile, readdir, stat, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
export const WALLPAPER_PATH = '/api/laurel-center/wallpapers'
const NAME = /^[a-f0-9]{64}\.webp$/
const MAX = 3 * 1024 * 1024
export function createWallpaperHandler({ root, admit, disposed = () => false }) {
  let writes = Promise.resolve()
  return async (req,res) => {
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value))}
    if(disposed())return send(503,{error:'disposed'})
    const denied=admit(req);if(denied)return send(denied,{error:'not-authorized'})
    const path=String(req.url).split('?')[0]
    if(path===WALLPAPER_PATH && req.method==='POST'){
      try {
        const chunks=[];let size=0
        for await(const chunk of req){size+=chunk.length;if(size>MAX)return send(413,{error:'图片超过 3 MB'});chunks.push(chunk)}
        const bytes=Buffer.concat(chunks)
        if(bytes.length<20||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP'||bytes.readUInt32LE(4)+8!==bytes.length)return send(415,{error:'需要有效的 WebP 图片'})
        const name=createHash('sha256').update(bytes).digest('hex')+'.webp'
        const save=async()=>{
          if(disposed())throw Error('disposed')
          await mkdir(root,{recursive:true})
          const names=(await readdir(root)).filter(n=>NAME.test(n))
          if(!names.includes(name)){
            let total=bytes.length
            for(const n of names)total+=(await stat(join(root,n))).size
            if(names.length>=100||total>128*1024*1024)throw Error('本机壁纸库已满（100 张 / 128 MB）')
            const temp=join(root,randomUUID()+'.tmp')
            try {await writeFile(temp,bytes,{mode:0o600});await rename(temp,join(root,name))}finally{await rm(temp,{force:true})}
          }
        }
        const saving=writes.then(save);writes=saving.catch(()=>{});await saving
        return send(200,{ok:true,image:name})
      }catch(e){return send(500,{error:e.message||'wallpaper-storage-failed'})}
    }
    const name=path.startsWith(WALLPAPER_PATH+'/')?path.slice(WALLPAPER_PATH.length+1):''
    if(!NAME.test(name))return send(404,{error:'not-found'})
    if(!['GET','HEAD'].includes(req.method))return send(405,{error:'method-not-allowed'})
    try {
      const bytes=await readFile(join(root,name))
      res.writeHead(200,{'content-type':'image/webp','content-length':bytes.length,'cache-control':'private, max-age=31536000, immutable','x-content-type-options':'nosniff'})
      res.end(req.method==='HEAD'?undefined:bytes)
    }catch{return send(404,{error:'wallpaper-not-found'})}
  }
}
