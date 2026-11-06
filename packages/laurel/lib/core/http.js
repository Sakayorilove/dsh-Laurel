/**
 * Laurel 系列 · HTTP 数据面
 *
 * 每个插件都在 `webServer.register({ kind:'prefix', path:'/<插件名>' })` 上挂一组
 * 同源端点，给浏览器半边读配置、回传事件、取设置页需要的东西。
 *
 * 这里只抽**协议层**（前缀剥离、方法分派、响应形状、请求体读取），
 * 端点本身由插件定义 —— 因为端点形状天然是插件自己的事。
 *
 * 两条纪律：
 *   1. **响应形状统一是 `{ ok: true, data }` / `{ ok: false, error }`。**
 *      浏览器半边只认这一种形状，所以由 core 保证，不给插件走样的机会。
 *   2. **handler 里任何异常都转成 500，不让它冒到宿主。**
 *      webServer 是共享服务，一个插件抛异常不该影响别的插件的路由。
 */

/** 读请求体（带字节上限）。不是合法 JSON 就返回 `null`，不抛。 */
export function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve(null)
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * 统一响应。HEAD 只发头不发体（内容是空的但 content-type 仍正确），
 * 这样 `curl -I` 能用来探活，又不用把整个事件列表序列化一遍。
 */
export function send(res, status, payload, method = 'GET') {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(method === 'HEAD' ? undefined : JSON.stringify(payload))
}

/** `{ ok: true, data }` 的成功响应。 */
export const ok = (res, data, method) => send(res, 200, { ok: true, data }, method)

/** `{ ok: false, error }` 的失败响应。 */
export const fail = (res, status, error, method) => send(res, status, { ok: false, error }, method)

/**
 * 造前缀路由 handler。
 *
 * 路由表形状 —— 一个键支持多个方法，值为 `(ctx) => ...`：
 * ```js
 * createRouter({
 *   prefix: '/laurel',
 *   routes: {
 *     '/config': {
 *       GET: ({ home }) => ok(res, {...}),
 *       POST: ({ res, body, home }) => ok(res, {...}),
 *     },
 *     '/status': ({ home, res }) => ok(res, {...}),   // 简写 = GET/HEAD
 *   },
 *   log,
 * })
 * ```
 * `ctx` 里给的东西：`{ req, res, method, url, route, body, home, log }`。
 * 只有 handler 用到的才需要声明；`body` 是惰性读取的，GET 路由不会白读一次流。
 *
 * @param {{ prefix: string, routes: Record<string, any>, log?: any, home?: string }} options
 */
export function createRouter({ prefix, routes, log, home }) {
  // 预先把简写展开成方法表，省得每次请求都判断一遍。
  const table = new Map()
  for (const [route, spec] of Object.entries(routes)) {
    table.set(route, typeof spec === 'function' ? { GET: spec, HEAD: spec } : spec)
  }

  return async function handler(req, res) {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://localhost')
    // 剥掉前缀再收掉尾部斜杠，于是 '/laurel/' 和 '/laurel' 都归到 '/'。
    const route = url.pathname.replace(new RegExp(`^${prefix}`), '').replace(/\/+$/, '') || '/'
    try {
      const spec = table.get(route)
      const fn = spec?.[method]
      if (typeof fn !== 'function') {
        // 路由存在但这个方法不支持 → 405；路由根本不存在 → 404。分开报，排错快得多。
        if (spec) return fail(res, 405, `不支持的方法：${method} ${prefix}${route}`)
        return fail(res, 404, `未知端点：${method} ${prefix}${route}`)
      }
      // 惰性读体：只有方法不是 GET/HEAD 且 handler 声明了 body 才读。
      const wantsBody = method !== 'GET' && method !== 'HEAD' && fn.length > 0 && spec.body !== false
      const body = wantsBody ? await readJsonBody(req) : undefined
      return await fn({ req, res, method, url, route, body, home, log })
    } catch (error) {
      const message = String(error?.message ?? error)
      try { log?.error?.(`HTTP 处理出错（${method} ${prefix}${route}）：${message}`) } catch { /* 日志不许影响响应 */ }
      return fail(res, 500, message)
    }
  }
}
