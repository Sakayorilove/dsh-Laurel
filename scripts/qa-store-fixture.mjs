import { SUB_PLUGINS } from '../lib/registry.js'
// Presentation regressions use an explicitly installed catalog. Store workflows
// are exercised separately against the real ModuleStore and HTTP handlers.
export function presentationStoreFixture(req,res){
  if(!req.url.startsWith('/api/laurel-center/store'))return false
  res.writeHead(200,{'content-type':'application/json'})
  res.end(JSON.stringify({schema:1,hostVersion:'0.2.1-rc.5',checkedAt:Date.now(),checking:false,updates:0,center:{version:'1.8.5',updateAvailable:false},job:{phase:'idle'},modules:SUB_PLUGINS.map(p=>({...p,installed:true,enabled:true,mounted:true,version:'0.1.0',client:null}))}))
  return true
}
