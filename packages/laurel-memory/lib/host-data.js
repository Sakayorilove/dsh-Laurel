/**
 * Laurel 系列 · 只读状态数据面（宿主半边）
 *
 * ── 为什么这两个模块需要 HTTP 数据面（D48）────────────────────────────────
 * 设置页（浏览器半边）原来只做了一件事：`ctx.get('remote')` 拿不到就显示
 * 「读取失败」。查过宿主之后确认：客户端能调的只有宿主官方预置的
 * `remote.*` 命名空间（`remote.pluginManager`、`remote.pluginInventory` …），
 * 那是**固定集合**；插件自己 `ctx.provide('laurel.memoryCore')` 出来的是
 * 宿主 cordis 服务，浏览器侧没有任何通道能摸到它。
 *
 * 所以「设置页显示真实状态」只有一条路：宿主半边把状态挂到 webServer 上，
 * 客户端 fetch 回来。这与 dsh-strata / dsh-warden 的做法是同一个范式
 * （只读数据用 prefix，写操作走远程 RPC）。
 *
 * ── 这里只放只读 GET ──────────────────────────────────────────────────────
 * 不注册任何写端点。理由见 `docs/PLUGIN-CONTRACT.md` §5：webServer 的 prefix
 * **不继承认证**，把管理动作挂上去等于开一个无鉴权写口。状态查询是只读的，
 * 泄露面只有「本机某个设置页能看见自己的档位」，可以接受；写入不可以。
 *
 * ── 拿不到 webServer 不许抛 ───────────────────────────────────────────────
 * 非 Web 组合（CLI / 无头）本来就没有 webServer。这种情况返回 null，
 * 调用方据此把 capabilities 标成 unsupported，而不是让加载失败。
 */

/**
 * 造一个只读 handler。
 *
 * @param {(url: URL) => {ok: boolean, data?: unknown, error?: string}} collect
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createReadOnlyHandler(collect) {
  return async function handler(req, res) {
    const method = req.method ?? 'GET'
    const send = (status, payload) => {
      if (res.headersSent) return
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(method === 'HEAD' ? undefined : JSON.stringify(payload))
    }
    // 只读：除 GET/HEAD 一律 405。这不是"权限检查"，而是"这里根本没有写的能力"。
    if (method !== 'GET' && method !== 'HEAD') {
      return send(405, { ok: false, error: '只读端点：不提供任何写操作' })
    }
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      return send(200, collect(url))
    } catch (error) {
      return send(500, { ok: false, error: String(error?.message ?? error) })
    }
  }
}

/**
 * 把一条只读数据面挂到宿主 webServer 上。
 *
 * 返回的 `dispose` 用来在插件停用时摘掉路由 —— 不摘会让热重载后的新实例
 * 注册到同一个 prefix 上，旧的那个还活着，读到的是旧值。
 *
 * @param {{register?: Function}} webServer
 * @param {{path: string, collect: Function}} options
 */
export function mountReadOnly(webServer, { path, collect }) {
  if (!webServer || typeof webServer.register !== 'function') {
    return { ok: false, reason: 'no-webserver', note: '宿主没有 webServer 服务（非 Web 组合），设置页改走「未接数据」文案' }
  }
  const dispose = webServer.register({ kind: 'prefix', path, handler: createReadOnlyHandler(collect) })
  return { ok: true, path, dispose: typeof dispose === 'function' ? dispose : null }
}
