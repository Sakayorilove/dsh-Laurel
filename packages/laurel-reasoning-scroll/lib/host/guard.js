/**
 * laurel-reasoning-scroll · 路由的越权栅栏
 *
 * ── 为什么这条小路由也要栅栏 ─────────────────────────────────────────────
 * 宿主 webServer 的 prefix 路由**不继承**认证：认证只包 /api 一个前缀。
 * 挂在别处的前缀必须自己把闸门放在 handler 的第一行 —— 在解析 URL、读 body、
 * 碰任何存储之前。这一条不是理论风险：同套件的 dsh-warden 评审时实测复现过
 * 「跨站 text/plain POST（CORS 简单请求，不触发预检）→ 200，配置被改并落盘」。
 *
 * 本模块的写入面很小（八个开关，不需要重启，不落盘路径以外的任何东西），
 * 但「任意网页能把你的思考窗关掉」这件事本身就不该存在。
 *
 * ── 判据（三层，与套件其它模块同一套语义，独立实现）───────────────────
 *   1. 组合里挂了 `connection` → 用它的 admit(req)，宿主拒我们就拒；
 *   2. 没有 connection → 只认本机回环：remoteAddress 与 Host 都要是回环；
 *   3. Origin / Referer 存在时，必须与 Host 同源（协议不参与比较）；
 *   4. 非 GET/HEAD 再要求：不带 `sec-fetch-site: cross-site`，且 Content-Type 是 JSON。
 *
 * 判据对齐宿主 `packages/client/connection/src/api-request-trust.ts` 的
 * isTrustedApiRequest（Host 栅栏治 DNS rebinding，Origin 存在就必须等于本机）。
 *
 * ── fail-open 的唯一口子 ────────────────────────────────────────────────
 * 既没有 Origin 也没有 Host 的请求（测试脚手架、进程内直调）按本地放行：
 * 真实 HTTP/1.1 一定带 Host，浏览器跨站一定带 Origin，攻击者拿不到这个形状。
 *
 * @module host/guard
 */

/** 同机调用方可能出现的 remoteAddress（含双栈 IPv4 映射）。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

/** 桌面壳不是 http(s) 来源，单独放行（由 Electron 侧产生）。 */
const DESKTOP_ORIGIN = /^dsh-app:\/\/app(\/|$)/i

/** 安全方法不需要第 4 层。 */
const SAFE = new Set(['GET', 'HEAD'])

/** 从 '127.0.0.1:53909' / '[::1]:80' 里拆主机名与端口。 */
function splitAuthority(authority) {
  const raw = String(authority ?? '').trim().toLowerCase()
  if (raw === '') return null
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end === -1) return null
    const rest = raw.slice(end + 1)
    return { hostname: raw.slice(1, end), port: rest.startsWith(':') ? rest.slice(1) : '' }
  }
  const at = raw.lastIndexOf(':')
  if (at === -1) return { hostname: raw, port: '' }
  return { hostname: raw.slice(0, at), port: raw.slice(at + 1) }
}

/** 解析绝对 URL；不合法返回 null（绝不抛）。 */
function parseUrl(value) {
  try {
    return new URL(String(value ?? '').trim())
  } catch {
    return null
  }
}

/** 缺省端口按协议补齐，避免 ':80' 与不写端口被判成两个来源。 */
function effectivePort(port, protocol) {
  const value = String(port ?? '')
  if (value !== '') return value
  return String(protocol ?? '').toLowerCase() === 'https:' ? '443' : '80'
}

/** Origin 的 authority 与 Host 头是否同源（协议不参与比较，可能挂在反代后面）。 */
function sameAuthority(originUrl, hostHeader) {
  const host = splitAuthority(hostHeader)
  if (host === null || host.hostname === '') return false
  const originHost = String(originUrl.hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (originHost !== host.hostname) return false
  const protocol = String(originUrl.protocol ?? '').toLowerCase()
  return effectivePort(originUrl.port, protocol) === effectivePort(host.port, protocol)
}

/** 从 req 上取一个头（Node 的 headers 全是小写）。 */
function headerOf(req, name) {
  const headers = req?.headers
  if (headers === undefined || headers === null) return ''
  const value = headers[name]
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}

/** 请求的远端地址。 */
function remoteOf(req) {
  const raw = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? ''
  return String(raw).toLowerCase()
}

/** 拒绝结论的统一出口。 */
function deny(status, reason, layer) {
  return { ok: false, status, reason, layer }
}

/**
 * 造一个闸门。
 *
 * @param {{getConnection?: () => any, log?: any}} [deps]
 * @returns {{check: (req: any) => {ok: true, degraded?: string} | {ok: false, status: number, reason: string, layer: string}}}
 */
export function createRequestGuard(deps = {}) {
  const log = deps.log ?? null
  let degraded = false

  /**
   * 第 1 层：宿主的 connection 服务（有就一切听它的）。
   *
   * ⚠ 宿主 admit() 的**成功**返回不是 true，而是 `{ peer: <身份> }`：
   *   放行 → { peer }        拒绝 → { rejection: 401 | 403 }
   * （见 dsh 的 packages/client/connection/src/rpc.ts 的 PeerAdmission）。
   * 旧实现只认 true / {ok:true}，于是真实宿主上每一次请求都被判成拒绝 ——
   * 设置页永远读不到配置、也永远写不进去，而单元测试用的是自己造的
   * { ok: true }，正好绕开了这个形状。2026-10-24 在 desktop 宿主上实测复现
   * （/laurel/reasoning-scroll/status 恒 403），据此按宿主的真实契约翻译。
   *
   * 未知形状一律拒（503）：这里没有安全的默认。
   */
  function admitByConnection(req) {
    if (typeof deps.getConnection !== 'function') return null
    let connection = null
    try {
      connection = deps.getConnection()
    } catch {
      connection = null
    }
    if (connection === null || connection === undefined) return null
    const admit = connection.admit
    if (typeof admit !== 'function') return null
    let verdict
    try {
      verdict = admit.call(connection, req)
    } catch (error) {
      // 宿主 judge 自己抛了：不猜它什么意思，按拒绝处理并记一条。
      try {
        log?.warn?.('connection.admit 抛异常，按拒绝处理：' + String(error?.message ?? error))
      } catch { /* 日志不许影响判定 */ }
      return { ok: false, status: 403, reason: 'connection-error', layer: 'connection' }
    }
    return connectionVerdict(verdict)
  }

  /** 把宿主的准入结论翻成本模块的栅栏结论。未知形状拒（503），不默认放行。 */
  function connectionVerdict(verdict) {
    if (verdict === true || verdict === undefined || verdict === null) return { ok: true }
    if (verdict === false) return deny(403, 'connection-denied', 'connection')
    if (typeof verdict === 'number') return deny(verdict, 'connection-rejected', 'connection')
    if (typeof verdict === 'object') {
      // 放行态：宿主认得这个请求，回给我们它已经建立的 peer 身份。
      if (verdict.peer !== undefined && verdict.peer !== null
        && verdict.rejection === undefined && verdict.status === undefined) return { ok: true }
      if (typeof verdict.rejection === 'number') return deny(verdict.rejection, 'connection-rejected', 'connection')
      if (typeof verdict.status === 'number') {
        return deny(verdict.status, typeof verdict.reason === 'string' ? verdict.reason : 'connection-rejected', 'connection')
      }
      if (verdict.ok === true) return { ok: true }
      if (verdict.ok === false) {
        return deny(Number(verdict.status) || 403, typeof verdict.reason === 'string' ? verdict.reason : 'connection-denied', 'connection')
      }
    }
    return deny(503, 'connection-unknown-decision', 'connection')
  }

  /** 第 2 层：本机回环（remoteAddress 与 Host 都必须是回环）。 */
  function judgeLoopback(req) {
    const host = splitAuthority(headerOf(req, 'host'))
    const remote = remoteOf(req)
    // 两边都没有 → 不是真实 HTTP 请求（见文件头 fail-open 那条），放行。
    if (host === null && remote === '') return { ok: true, degraded: 'no-host-no-remote' }
    if (host !== null && !LOOPBACK.has(host.hostname)) {
      return deny(403, 'host 不是回环（DNS rebinding）', 'loopback')
    }
    if (remote !== '' && !LOOPBACK.has(remote)) {
      // 反向代理后面 remoteAddress 可能是内网地址；只在 Host 也非回环时才拒。
      if (host === null || !LOOPBACK.has(host.hostname)) return deny(403, 'remoteAddress 不是回环', 'loopback')
    }
    return { ok: true }
  }

  /** 第 3 层：Origin / Referer 必须与 Host 同源。 */
  function judgeOrigin(req) {
    const host = headerOf(req, 'host')
    const origin = headerOf(req, 'origin')
    if (origin !== '' && origin !== 'null') {
      if (DESKTOP_ORIGIN.test(origin)) return { ok: true }
      const url = parseUrl(origin)
      if (url === null) return deny(403, 'Origin 无法解析', 'origin')
      if (host === '') return { ok: true, degraded: 'origin-without-host' }
      return sameAuthority(url, host) ? { ok: true } : deny(403, 'Origin 与 Host 不同源', 'origin')
    }
    const referer = headerOf(req, 'referer')
    if (referer !== '') {
      const url = parseUrl(referer)
      if (url === null) return deny(403, 'Referer 无法解析', 'origin')
      if (host === '') return { ok: true, degraded: 'referer-without-host' }
      return sameAuthority(url, host) ? { ok: true } : deny(403, 'Referer 与 Host 不同源', 'origin')
    }
    return { ok: true }
  }

  /** 第 4 层：写请求必须不是跨站、且是 JSON。 */
  function judgeWrite(req, method) {
    if (SAFE.has(method)) return { ok: true }
    if (String(headerOf(req, 'sec-fetch-site')).toLowerCase() === 'cross-site') {
      return deny(403, 'sec-fetch-site: cross-site', 'write')
    }
    const type = String(headerOf(req, 'content-type')).toLowerCase()
    if (!type.startsWith('application/json')) {
      // 简单请求（text/plain、表单）带不上 application/json，跨站发不出来。
      return deny(415, '写请求必须是 application/json', 'write')
    }
    return { ok: true }
  }

  return {
    /**
     * 判定一个请求。
     * @param {any} req
     */
    check(req) {
      const method = String(req?.method ?? 'GET').toUpperCase()
      const viaConnection = admitByConnection(req)
      if (viaConnection !== null) return viaConnection
      if (!degraded) {
        degraded = true
        try {
          log?.info?.('没有 connection 服务，路由闸门退化为「回环 + 同源 + 简单请求」三层')
        } catch { /* 日志不许影响判定 */ }
      }
      for (const step of [judgeLoopback, judgeOrigin, (r) => judgeWrite(r, method)]) {
        const verdict = step(req)
        if (verdict.ok !== true) return verdict
      }
      return { ok: true, degraded: 'no-connection-service' }
    },
  }
}