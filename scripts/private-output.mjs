import { mkdtempSync, mkdirSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, relative, isAbsolute, sep, dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=realpathSync(fileURLToPath(new URL('../',import.meta.url)))
function canonical(path) {
  let head=resolve(path);const rest=[]
  while(!existsSync(head)){rest.unshift(basename(head));head=dirname(head)}
  return join(realpathSync(head),...rest)
}
export function qaOutput(name) {
  if(!/^[a-z0-9-]+$/.test(name))throw Error('Invalid QA scenario')
  const base=process.env.LAUREL_QA_OUTPUT ? canonical(process.env.LAUREL_QA_OUTPUT) : mkdtempSync(join(tmpdir(),'laurel-qa-'))
  const out=externalOutput(join(base,name))
  mkdirSync(out,{recursive:true});return out
}
export function externalOutput(path) {
  const out=canonical(path),rel=relative(root,out)
  if(!rel || (rel!=='..' && !rel.startsWith('..'+sep) && !isAbsolute(rel)))throw Error('LAUREL_QA_OUTPUT must be outside the source repository')
  return out
}
