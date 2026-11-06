import { presentationAdmission } from './ui-preferences.js'
export const STORE_PATH = '/api/laurel-center/store'
function send(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data)) }
export function createStoreHandler({ getStore, connection, disposed = () => false }) {
  return async (req, res) => {
    try {
      if (disposed()) return send(res, 503, { error: '更新服务已停止' })
      const path = new URL(req.url, 'http://laurel.invalid').pathname
      const asset = path.match(/^\/api\/laurel-center\/store\/client\/([a-z][a-z0-9-]{0,63})\/([a-f0-9]{64})\.js$/)
      // Script tags cannot attach the UI header. Native authentication still applies,
      // and cross-site script requests are refused before serving executable code.
      const checkReq = asset && req.method === 'GET' && !['cross-site','same-site'].includes(req.headers['sec-fetch-site']) ? new Proxy(req,{get(target,key){return key==='headers'?{...target.headers,'x-laurel-ui':'1'}:Reflect.get(target,key,target)}}) : req
      const rejection = presentationAdmission(checkReq, connection())
      if (rejection) return send(res, rejection, { error: '未通过身份或来源验证' })
      const store = getStore()
      if (!store) return send(res, 503, { error: '模块管理尚未就绪' })
      await store.ready()
      if (asset && req.method === 'GET') {
        const code = store.clientSource(asset[1], asset[2])
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' }); return res.end(code)
      }
      if (path !== STORE_PATH) return send(res, 404, { error: '接口不存在' })
      if (req.method === 'GET') { await store.syncCenterInventory(); return send(res, 200, store.snapshot()) }
      if (req.method !== 'POST') return send(res, 405, { error: '不支持的请求方法' })
      let size = 0; const chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > 4096) return send(res, 413, { error: '请求过大' }); chunks.push(chunk) }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(res, 400, { error: '请求格式无效' }) }
      if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(k => !['action', 'id', 'version'].includes(k))) return send(res, 400, { error: '请求字段无效' })
      if (body.action === 'check') { void store.check(true); return send(res, 202, store.snapshot()) }
      return send(res, 202, store.start(body.action, body.id, body.version))
    } catch (error) { return send(res, 409, { error: error.message || '模块操作失败' }) }
  }
}
export function mountStoreApi(ctx, getStore, log) {
  return ctx.inject?.(['webServer'], child => {
    let disposed = false
    const handler = createStoreHandler({ getStore, connection: () => { try { return child.get('connection') } catch { return null } }, disposed: () => disposed })
    child.effect(() => child.webServer.register({ kind: 'prefix', path: STORE_PATH, handler }))
    child.effect(() => () => { disposed = true })
    log?.debug?.('模块分发与更新通道已挂载')
  })
}
