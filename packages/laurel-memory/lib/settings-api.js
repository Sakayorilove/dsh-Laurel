/**
 * laurel-memory/settings-api —— 设置页的**写**通道（D143）
 *
 * 为什么以前不写：`docs/PLUGIN-CONTRACT.md` §5 与 host-data.js 头注都写着
 * 「webServer 的 prefix 不继承认证，挂写端点等于开无鉴权写口」。这个判断
 * 对**裸挂**成立，但宿主自己留了正规做法：`/api` 前缀后面是由 connection
 * 服务的 admission 把守的，而 webServer 是「最长前缀优先」——
 * 所以只要我们自己把同一道栅栏跑在最前面，这条路由并不比宿主更弱。
 * `dsh-our-free-model` 的设置页就是这么做的（src/trust.js），这里同构复刻，
 * 并额外要求一个自定义请求头（`x-laurel-ui`）：浏览器对带自定义头的
 * 跨站请求必须先过 CORS 预检，而我们不给任何跨站放行头 → 跨站写不进来。
 *
 * 两层栅栏，顺序与宿主一致：
 *   1. 组合里挂了 `connection` 服务 → 用它自己的 `admit(req)`（新内核）
 *      或 `requestRejection(req)`（旧内核），宿主拒我们就拒；
 *   2. 没挂 → 结构复刻：只认本机回环，且 Origin/Referer（若有）必须与 Host 同源。
 *
 * 读仍然走 `/laurel-memory`（只读、无副作用），写只在这个文件里，
 * 且写什么由调用方注入 —— 本模块不认识业务字段。
 *
 * @module settings-api
 */

/** 同机调用方可能使用的主机名。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/** 请求体上限：三个字段的设置，给 8KB 已经很宽松。 */
const MAX_BODY_BYTES = 8 * 1024

/** 桌面壳的中转 Referer（`dsh-app://app`）—— 它没有常规 authority，单独放行。 */
const DESKTOP_REFERER = /^dsh-app:\/\/app(\/|$)/i

/** 这个请求是不是从本机来的。 */
export function isLoopbackRequest(req) {
  const address = String(req?.socket?.remoteAddress ?? '')
  if (!address) return false
  if (address === '::1' || address === '127.0.0.1') return true
  // 双栈监听下 IPv4 会以 `::ffff:127.0.0.1` 出现
  if (/^::ffff:127\./i.test(address)) return true
  return false
}

/** 从 `Host: 127.0.0.1:53909` 这样的串里取主机名（去掉端口）。 */
function hostnameOf(authority) {
  const raw = String(authority ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end === -1 ? raw : raw.slice(0, end + 1)
  }
  return raw.split(':')[0]
}

/**
 * 结构复刻的栅栏：本机 + 同源。
 * @returns {number|undefined} 拒绝时返回 HTTP 状态码
 */
export function structuralRejection(req) {
  if (!isLoopbackRequest(req)) return 403
  const host = hostnameOf(req.headers?.host)
  if (!host || !LOOPBACK_NAMES.has(host)) return 403

  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin) {
    let parsed
    try { parsed = new URL(origin) } catch { return 403 }
    if (!LOOPBACK_NAMES.has(hostnameOf(parsed.host))) return 403
    if (parsed.host !== String(req.headers?.host ?? '').trim()) return 403
    return undefined
  }

  const referer = req.headers?.referer
  if (typeof referer === 'string' && referer) {
    if (DESKTOP_REFERER.test(referer)) return undefined
    let parsed
    try { parsed = new URL(referer) } catch { return 403 }
    if (!LOOPBACK_NAMES.has(hostnameOf(parsed.host))) return 403
    if (parsed.host !== String(req.headers?.host ?? '').trim()) return 403
  }
  return undefined
}

/**
 * 造一个「按请求现取」的 connection 视图：组合可能在我们加载之后才发布它。
 * @param {object|Function|undefined} source
 */
export function connectionAdmissionView(source) {
  return {
    get admit() {
      const service = typeof source === 'function' ? source() : source
      if (!service) return undefined
      if (typeof service.admit === 'function') return (req) => service.admit(req)
      if (typeof service.requestRejection === 'function') {
        return (req) => {
          const status = service.requestRejection(req)
          return status === undefined ? undefined : { rejection: status }
        }
      }
      return undefined
    },
  }
}

/**
 * 决定是否拒绝一个请求。
 *
 * 宿主的 `connection.admit` 有两套返回形状，必须都认（2026-10-21 隔离宿主实测）：
 *   - **放行** → `{ peer: <浏览器身份> }`：只有 peer 一个键，没有任何 rejection/status 字段；
 *   - **拒绝** → `{ rejection: 401 }`；老内核的 `requestRejection` 直接返回状态码。
 *
 * 以前只认 undefined / number / `{rejection}`，把放行态的 `{peer}` 当成未知形状一律 503。
 * 表现是「设置页整块显示未接数据」，而宿主其实早就认可了这个浏览器。
 * 放行必须显式识别；其余未知形状仍然拒（拒绝优于放行）。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object|undefined} connection
 * @returns {number|undefined}
 */
export function rejectionFor(req, connection) {
  const view = connectionAdmissionView(connection)
  const admit = view.admit
  if (typeof admit === 'function') {
    try {
      const decision = admit(req)
      if (decision === undefined || decision === null || decision === true) return undefined
      if (typeof decision === 'number') return decision
      if (decision && typeof decision === 'object') {
        if (typeof decision.rejection === 'number') return decision.rejection
        if (typeof decision.status === 'number') return decision.status
        // 放行态：宿主认得这个请求，并把已经建立的 peer 身份回给我们。
        // 必须同时满足「有 peer」且「没有任何 rejection/status 字段」。
        if (
          Object.hasOwn(decision, 'peer') &&
          decision.peer != null &&
          decision.rejection === undefined &&
          decision.status === undefined
        ) {
          return undefined
        }
      }
      // 有返回值但不是已知形状：按宿主的「拒绝」处理，绝不默认放行
      return 503
    } catch {
      return 503
    }
  }
  return structuralRejection(req)
}

/** 读一个不超过上限的 JSON 请求体。 */
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) {
      const error = new Error(`请求体超过 ${limit} 字节`)
      error.code = 'too-large'
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('请求体必须是 JSON 对象')
      error.code = 'bad-body'
      throw error
    }
    return parsed
  } catch (e) {
    if (e.code) throw e
    const error = new Error('请求体不是合法 JSON')
    error.code = 'bad-body'
    throw error
  }
}

/**
 * 造设置路由的 handler。
 *
 * @param {{
 *   read: () => object,
 *   write: (patch: object) => Promise<{ok: boolean, error?: string, data?: object}>,
 *   connection?: object|Function|undefined,
 *   log?: {warn?: Function},
 * }} deps
 * @returns {(req, res) => Promise<void>}
 */
export function createSettingsHandler({ read, write, connection, log = null }) {
  return async function handler(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      if (res.headersSent) return
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      // 明确不给跨站放行头：带自定义头的跨站请求会被预检挡下
      res.end(method === 'HEAD' ? undefined : JSON.stringify(payload))
    }

    const rejection = rejectionFor(req, typeof connection === 'function' ? connection() : connection)
    if (rejection !== undefined) {
      log?.warn?.(`设置写通道拒绝了请求：status=${rejection} method=${method}`)
      return send(rejection, { ok: false, error: rejection === 403 ? 'forbidden' : 'unauthorized' })
    }

    if (method === 'GET' || method === 'HEAD') {
      try {
        return send(200, { ok: true, data: await read() })
      } catch (e) {
        return send(500, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (method !== 'POST') {
      return send(405, { ok: false, error: '只支持 GET / POST' })
    }

    // 自定义头：这是一道 CSRF 栅栏而不是权限 —— 跨站请求带不上它
    if (String(req.headers?.['x-laurel-ui'] ?? '') !== '1') {
      return send(403, { ok: false, error: '缺少 x-laurel-ui 头（跨站请求会被拒绝）' })
    }
    const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      return send(415, { ok: false, error: 'Content-Type 必须是 application/json' })
    }

    let patch
    try {
      patch = await readJsonBody(req)
    } catch (e) {
      return send(e.code === 'too-large' ? 413 : 400, { ok: false, error: String(e.message ?? e) })
    }

    try {
      const result = await write(patch)
      if (!result || result.ok !== true) {
        return send(400, { ok: false, error: result?.error ?? '写入失败' })
      }
      return send(200, { ok: true, data: result.data ?? read() })
    } catch (e) {
      log?.warn?.(`设置写入异常：${String(e?.message ?? e)}`)
      return send(500, { ok: false, error: String(e?.message ?? e) })
    }
  }
}

/**
 * 把设置路由挂到宿主 webServer 上。
 *
 * @param {{register?: Function}} webServer
 * @param {{path: string, handler: Function}} options
 */
export function mountSettings(webServer, { path, handler }) {
  if (!webServer || typeof webServer.register !== 'function') {
    return { ok: false, reason: 'no-webserver', note: '宿主没有 webServer 服务，设置页保存按钮会显示「未接数据」' }
  }
  const dispose = webServer.register({ kind: 'prefix', path, handler })
  return { ok: true, path, dispose: typeof dispose === 'function' ? dispose : null }
}
