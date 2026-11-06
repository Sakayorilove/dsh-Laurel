/**
 * dsh-warden · HTTP 越权栅栏（P0-1）
 *
 * ── 它治的是什么 ───────────────────────────────────────────────────────
 * 宿主 webServer 的 prefix 路由**不继承认证**：认证栅栏只包 /api 一个前缀，
 * 别的插件挂上去的写端点必须自己先把同一道栅栏跑在最前面。旧版 createHandler
 * 第一件事就是 new URL(...)，前面什么都没有，于是（评审已实测复现）：
 *
 *   - 跨站 text/plain POST（CORS 简单请求，不触发预检）→ 200，配置被改并落盘；
 *   - 伪 Host（DNS rebinding）→ 200，/events 吐出工作区绝对路径与会话 id。
 *
 * 「护栏能被同机任意网页关掉」这一条本身就否定了护栏的前提，所以栅栏必须放在
 * handler 的第一行 —— 在解析 URL、读 body、碰任何存储之前。
 *
 * ── 设计来源（重要）────────────────────────────────────────────────────
 * **设计参考自 dsh-tool-batch/lib/guard.mjs 的四层思路，独立实现**：
 *
 *   1. 组合里挂了 connection 服务 → 用它的 admit(req)，宿主拒我们就拒；
 *   2. 没有 connection → 结构复刻：只认本机回环（remoteAddress + Host）；
 *   3. Origin / Referer（若有）必须与 Host 同源（协议不参与比较，
 *      主机名 + 有效端口一致）；
 *   4. 非 GET/HEAD 再上一层「简单请求带不上」的约束：跨站标记、非 JSON 类型、
 *      （可选）自定义头。
 *
 * 判定语义另外对齐宿主自己的 packages/client/connection/src/api-request-trust.ts
 * 的 isTrustedApiRequest：Host 栅栏是 DNS rebinding 的主防线，sec-fetch-site:
 * cross-site 出现即拒，Origin 存在就必须等于本监听者自己的 authority。
 *
 * ⚠ 本文件**不是** guard.mjs 的复制品：没有拷任何一行源码，只提炼判据后重写。
 * 两者差异（都是我们更严或必须更宽的地方）写在各层注释里。
 *
 * ── 降级必须可见 ───────────────────────────────────────────────────────
 * 没有 connection 服务时退化成第 2/3/4 层，并在结论里带
 * degraded: 'no-connection-service'，由 http.js 写进能力台账。
 * **绝不允许静默变成不鉴权**。
 *
 * ── fail-open 的唯一口子（刻意开放的边界）──────────────────────────────
 * 测试与本地工具调用造出来的假 req **既没有 Origin 也没有 Host**，真实 HTTP/1.1
 * 请求不可能长这样（Node 一定带 Host）。这类「既无 Origin 又无可判定的来源」的
 * 调用按本地放行 —— 攻击者拿不到这个形状：浏览器一定带 Host，跨站一定带 Origin。
 * 这条口子写在 judgeLoopback / judgeOrigin 的注释里，改动前先读那里。
 *
 * @module core/http-guard
 */

/** 同机调用方可能出现的 remoteAddress（含双栈 IPv4 映射）。 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

/** 同机调用方可能使用的 Host 主机名（已去端口、去方括号）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

/** 桌面壳的中转 Origin —— 它没有常规 authority，单独放行（由 Electron 侧产生）。 */
const DESKTOP_ORIGIN = /^dsh-app:\/\/app(\/|$)/i

/** 不要求第 4 层的「安全方法」。 */
const SAFE_METHODS = new Set(['GET', 'HEAD'])

/** 不透明来源字面量（沙箱 iframe / file: 页面）。 */
const NULL_ORIGIN = 'null'

/** 「这个 connection 服务没有可用的准入方法」—— 与「准入后放行」区分开。 */
const NO_CONNECTION = Symbol('warden.no-connection')

/** 默认的自定义头名。与 Laurel 系列其它插件同名，便于网关统一放行。 */
const DEFAULT_CUSTOM_HEADER = 'x-laurel-ui'

/** 同一条拒绝在日志/事件里的最小间隔（毫秒）—— 被扫时不刷爆 events.log。 */
const DENY_NOTE_INTERVAL_MS = 60_000

/** 拒绝结论的统一出口。 */
function deny(status, reason, layer) {
  return { ok: false, status, reason, layer }
}

function textOf(error) {
  return String(error?.message ?? error)
}

/** 从 '127.0.0.1:53909' / '[::1]:80' 这类串里拆出主机名与端口。 */
function splitAuthority(authority) {
  const raw = String(authority ?? '').trim().toLowerCase()
  if (!raw) return null
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

/** 解析一个绝对 URL；不合法返回 null（绝不抛）。 */
function parseUrl(value) {
  try {
    return new URL(String(value ?? '').trim())
  } catch {
    return null
  }
}

/** URL 里的主机名（IPv6 会带方括号，统一去掉）。 */
function urlHostname(url) {
  return String(url?.hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
}

/** 缺省端口按协议补齐，避免 ':80' 与不写端口被判成两个来源。 */
function effectivePort(port, protocol) {
  const value = String(port ?? '')
  if (value) return value
  return String(protocol ?? '').toLowerCase() === 'https:' ? '443' : '80'
}

/**
 * Origin 的 authority 与 Host 头是否同源。
 * 协议不参与比较（可能挂在反向代理后面）；端口按协议补默认值后比较。
 */
function sameAuthority(originUrl, hostHeader) {
  const host = splitAuthority(hostHeader)
  if (!host || !host.hostname) return false
  if (urlHostname(originUrl) !== host.hostname) return false
  const protocol = String(originUrl?.protocol ?? '').toLowerCase()
  return effectivePort(originUrl?.port, protocol) === effectivePort(host.port, protocol)
}

/** 把 allowedOrigins 归一成小写集合。 */
function originSet(list) {
  const out = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue
    const raw = item.trim().toLowerCase()
    if (raw) out.add(raw)
  }
  return out
}

/** 把 allowedHosts 归一成小写集合（可写 host 或 host:port）。 */
function hostSet(list) {
  const out = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue
    const raw = item.trim().toLowerCase()
    if (raw) out.add(raw)
  }
  return out
}

/** 取一个请求头（Node 已小写化；这里再兜一层，防手写的假 req）。 */
function header(req, name) {
  const headers = req?.headers
  if (!headers || typeof headers !== 'object') return ''
  const value = headers[name] ?? headers[String(name).toUpperCase()]
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/** 请求方法（拿不到按 GET 处理：安全方法不会因为缺字段被误升成写方法）。 */
function methodOf(req) {
  return String(req?.method ?? 'GET').toUpperCase()
}

/**
 * 第 1 层：把宿主 connection 的准入结论翻成栅栏结论。
 *
 * 实测契约（与 tool-batch 同源，隔离宿主 2026-10-21 核对过）：
 *   - 放行 → { peer: <身份> }（只有 peer 一个键）
 *   - 拒绝 → { rejection: 401 | 403 }
 * 老内核的 requestRejection 直接返回状态码或 undefined。
 * **未知形状一律拒**（503），绝不默认放行。
 */
function judgeConnection(connection, req) {
  if (!connection || (typeof connection !== 'object' && typeof connection !== 'function')) {
    return NO_CONNECTION
  }

  if (typeof connection.admit === 'function') {
    let decision
    try {
      decision = connection.admit(req)
    } catch (error) {
      return deny(503, 'connection-admit-error: ' + textOf(error), 'connection')
    }
    return connectionVerdict(decision)
  }

  if (typeof connection.requestRejection === 'function') {
    let status
    try {
      status = connection.requestRejection(req)
    } catch (error) {
      return deny(503, 'connection-rejection-error: ' + textOf(error), 'connection')
    }
    if (status === undefined || status === null || status === false) return { ok: true }
    return connectionVerdict(status)
  }

  return NO_CONNECTION
}

function connectionVerdict(decision) {
  if (decision === undefined || decision === null || decision === true) return { ok: true }
  if (decision === false) return deny(403, 'connection-denied', 'connection')
  if (typeof decision === 'number') return deny(decision, 'connection-rejected', 'connection')
  if (typeof decision === 'object') {
    if (typeof decision.status === 'number') {
      return deny(decision.status, String(decision.reason ?? 'connection-rejected'), 'connection')
    }
    if (typeof decision.rejection === 'number') return deny(decision.rejection, 'connection-rejected', 'connection')
    if (decision.rejection && typeof decision.rejection === 'object') {
      const nested = connectionVerdict(decision.rejection)
      if (nested.ok === false) return nested
    }
    // 放行态：宿主认得这个请求，回给我们它已经建立的 peer 身份。
    if (decision.peer !== undefined && decision.peer !== null
      && decision.rejection === undefined && decision.status === undefined) {
      return { ok: true }
    }
  }
  return deny(503, 'connection-unknown-decision', 'connection')
}

/**
 * 第 2 层：结构复刻 —— 只认本机回环。
 *
 * ⚠ fail-open 的口子：**Host 缺失**时放行。真实 Node HTTP 请求一定带 Host，
 * 缺 Host 的只有测试/工具的合成 req（tests/smoke.mjs 的 httpCall 就是）。
 * 反过来，DNS rebinding 攻击**一定**带 Host（浏览器用自己以为的域名填），
 * 所以「有 Host 且不是回环 → 拒」就够挡住它，不需要对缺 Host 的调用开杀。
 */
function judgeLoopback(req, allowedHosts, note) {
  const address = String(
    req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? '',
  ).trim().toLowerCase()
  if (address) {
    if (!LOOPBACK_ADDRESSES.has(address) && !/^::ffff:127\./.test(address)) {
      return deny(403, 'remote-not-loopback', 'loopback')
    }
    note('remote:' + address)
  } else {
    // 拿不到来源地址（合成 req / 中间层剥掉了）——只能靠 Host 与 Origin 判。
    note('remote-unknown')
  }

  const rawHost = header(req, 'host')
  if (!rawHost) {
    note('host-absent')
    return null
  }
  const host = splitAuthority(rawHost)
  if (!host || !host.hostname) return deny(403, 'host-unparsable', 'loopback')
  const authority = host.port ? host.hostname + ':' + host.port : host.hostname
  if (!LOOPBACK_HOSTS.has(host.hostname) && !allowedHosts.has(authority) && !allowedHosts.has(host.hostname)) {
    return deny(403, 'host-not-loopback', 'loopback')
  }
  note('host:' + host.hostname)
  return null
}

/**
 * 第 3 层：Origin（缺了退回 Referer）必须与 Host 同源。
 *
 * 与参考实现的差异（两处，都是更严）：
 *   - 'Origin: null'（沙箱 iframe / file: 页面）**拒绝**，不是放行 ——
 *     宿主自己的 isTrustedApiRequest 也拒绝它，跟着宿主走；
 *   - Origin 在但 Host 缺（不可能同时出现在真实浏览器里）**拒绝**，
 *     因为这时无从做同源比较，放行等于把第 3 层关掉。
 */
function judgeOrigin(req, allowedOrigins, note) {
  const rawOrigin = header(req, 'origin')
  const rawReferer = header(req, 'referer')
  const rawHost = header(req, 'host')

  if (rawOrigin) {
    const lowered = rawOrigin.toLowerCase()
    if (lowered === NULL_ORIGIN) return deny(403, 'origin-opaque-null', 'origin')
    if (DESKTOP_ORIGIN.test(rawOrigin)) { note('origin-desktop'); return null }
    if (allowedOrigins.has(lowered)) { note('origin-allowlisted'); return null }
    const parsed = parseUrl(rawOrigin)
    if (!parsed) return deny(403, 'origin-unparsable', 'origin')
    if (!rawHost) return deny(403, 'origin-without-host', 'origin')
    if (!sameAuthority(parsed, rawHost)) return deny(403, 'origin-mismatch', 'origin')
    note('origin-same')
    return null
  }

  if (rawReferer) {
    if (DESKTOP_ORIGIN.test(rawReferer)) { note('referer-desktop'); return null }
    const parsed = parseUrl(rawReferer)
    if (!parsed) return deny(403, 'referer-unparsable', 'origin')
    const derived = String(parsed.protocol).toLowerCase() + '//' + String(parsed.host).toLowerCase()
    if (allowedOrigins.has(derived)) { note('referer-allowlisted'); return null }
    if (!rawHost) return deny(403, 'referer-without-host', 'origin')
    if (!sameAuthority(parsed, rawHost)) return deny(403, 'referer-mismatch', 'origin')
    note('referer-same')
    return null
  }

  // 既无 Origin 也无 Referer：非浏览器调用（本地工具 / 桌面壳中转已剥头）。
  // 第 2 层的 Host 栅栏已经把「哪些请求能走到这里」限死了，这里不再加码。
  note('no-origin')
  return null
}

/**
 * 第 4 层：简单请求带不上的约束（CSRF）。
 *
 * GET/HEAD 跳过。其余方法：
 *   - sec-fetch-site: cross-site → 拒（现代浏览器每个 fetch 都带，最便宜的一刀）；
 *   - content-type 有但不是 JSON → 拒（跨站 text/plain POST 正是 P0 的复现路径；
 *     表单类 application/x-www-form-urlencoded 同理）；
 *   - requireCustomHeader 为真时还要求自定义头为 '1'。
 *
 * ⚠ 自定义头**默认不强制**：正道客户端 lib/client-kit.js 的 requestJSON 不发它，
 * 而 client-kit 不在本车道写域内。强行要求会让设置页所有写操作 401。
 * 「content-type 必须是 JSON + 跨站标记必拒」已经封死了 P0 的复现路径
 * （cross-origin 的 application/json POST 会触发预检，宿主同源策略接管）。
 * 要打开自定义头，需同时改 client-kit —— 已记进 RESULT.md 的后续项。
 */
function judgeSimpleRequest(req, options, note) {
  const method = methodOf(req)
  if (SAFE_METHODS.has(method)) return null

  if (header(req, 'sec-fetch-site').toLowerCase() === 'cross-site') {
    return deny(403, 'cross-site-fetch', 'csrf')
  }

  /**
   * 真实 HTTP 请求（Node 一定填 Host）里，写方法**必须**声明 JSON 类型。
   * 跨站 text/plain POST 正是 P0 的复现路径；表单类型同理拒掉。
   *
   * 合成 req（测试/本地工具的假对象，没有 Host）不强制 —— 那是 fail-open 的
   * 同一处口子，见 judgeLoopback 的注释。这条口子不削弱防护：真实浏览器发出的
   * 跨站 POST **一定**带 Origin（第 3 层已拦）与 content-type。
   */
  const realRequest = header(req, 'host') !== ''
  const contentType = header(req, 'content-type').toLowerCase()
  if (contentType) {
    if (!options.jsonTypes.some((type) => contentType.includes(type))) {
      return deny(415, 'content-type-not-json', 'csrf')
    }
  } else if (realRequest) {
    return deny(415, 'content-type-missing', 'csrf')
  }

  if (options.requireCustomHeader) {
    if (header(req, options.customHeader) !== '1') {
      return deny(403, 'missing-custom-header', 'csrf')
    }
    note('custom-header')
  }
  return null
}

/**
 * 造一个请求栅栏。
 *
 * @param {{
 *   getConnection?: () => any,
 *   allowedOrigins?: string[],
 *   allowedHosts?: string[],
 *   requireCustomHeader?: boolean,
 *   customHeader?: string,
 *   jsonTypes?: string[],
 *   log?: any,
 *   onEvent?: (event: object) => void,
 * }} [options]
 * @returns {(req: any) => {ok: true, degraded?: string} | {ok: false, status: number, reason: string, layer: string}}
 */
export function createHttpGuard(options = {}) {
  const getConnection = typeof options?.getConnection === 'function' ? options.getConnection : null
  const allowedOrigins = originSet(options?.allowedOrigins)
  const allowedHosts = hostSet(options?.allowedHosts)
  const customHeader = String(options?.customHeader ?? DEFAULT_CUSTOM_HEADER).toLowerCase()
  const jsonTypes = Array.isArray(options?.jsonTypes) && options.jsonTypes.length > 0
    ? options.jsonTypes.map((type) => String(type).toLowerCase())
    : ['application/json']
  const policies = {
    requireCustomHeader: options?.requireCustomHeader === true,
    customHeader,
    jsonTypes,
  }
  const log = options?.log ?? null
  const onEvent = typeof options?.onEvent === 'function' ? options.onEvent : null

  const stats = { checked: 0, denied: 0, byReason: {} }
  const info = {
    /** 实际生效的层（按顺序）。排障时一眼看出这台机器上哪几层在跑。 */
    layers: getConnection ? ['connection', 'origin', 'csrf'] : ['loopback', 'origin', 'csrf'],
    hasConnection: getConnection !== null,
    /** 当前降级标记；null = 四层齐全。 */
    degraded: getConnection ? null : 'no-connection-service',
  }

  let lastNoteAt = 0

  /** 拒绝要留痕，但被扫时不能把 events.log 刷爆。 */
  function noteDenial(verdict) {
    stats.denied += 1
    stats.byReason[verdict.reason] = (stats.byReason[verdict.reason] ?? 0) + 1
    const now = Date.now()
    if (lastNoteAt !== 0 && now - lastNoteAt < DENY_NOTE_INTERVAL_MS) return
    lastNoteAt = now
    try {
      log?.warn?.('[warden] 拒了一次 /warden 请求：层 ' + verdict.layer + ' / ' + verdict.reason + '（HTTP ' + verdict.status + '）')
    } catch { /* 日志不许影响判定 */ }
    try {
      onEvent?.({ kind: 'http-guard-denied', layer: verdict.layer, reason: verdict.reason, status: verdict.status })
    } catch { /* 记账失败也不许影响判定 */ }
  }

  function guard(req) {
    stats.checked += 1
    try {
      const notes = []
      const note = (reason) => { if (notes.length < 8) notes.push(String(reason)) }

      let degraded = null
      let admitted = false

      // ── 第 1 层：宿主 connection 准入 ──
      if (getConnection) {
        let connection
        try {
          connection = getConnection()
        } catch (error) {
          // 拿不到 connection 时**宁可拒绝**：这里没有一个「安全的默认」。
          const verdict = deny(503, 'connection-error: ' + textOf(error), 'connection')
          noteDenial(verdict)
          return verdict
        }
        const decision = judgeConnection(connection, req)
        if (decision !== NO_CONNECTION && decision.ok === false) {
          noteDenial(decision)
          return decision
        }
        if (decision === NO_CONNECTION) {
          // 组合里没有真正可用的 connection：退化成结构复刻，但**标记降级**。
          degraded = 'no-connection-service'
          info.degraded = degraded
          info.layers = ['loopback', 'origin', 'csrf']
        } else {
          admitted = true
          note('connection:admit')
        }
      } else {
        degraded = 'no-connection-service'
      }

      // ── 第 2 层：结构复刻（只在第 1 层没给出「宿主已认」时才跑）──
      if (!admitted) {
        const structural = judgeLoopback(req, allowedHosts, note)
        if (structural !== null) {
          noteDenial(structural)
          return structural
        }
      }

      // ── 第 3 层：Origin / Referer 同源 ──
      const origin = judgeOrigin(req, allowedOrigins, note)
      if (origin !== null) {
        noteDenial(origin)
        return origin
      }

      // ── 第 4 层：简单请求约束 ──
      const simple = judgeSimpleRequest(req, policies, note)
      if (simple !== null) {
        noteDenial(simple)
        return simple
      }

      // 放行。把判定过程挂在 req 上（不改变返回形状，便于探针/排障）。
      try {
        req[Symbol.for('dsh-warden.http-guard')] = { notes: notes.join(','), degraded }
      } catch { /* 冻住的 req 不影响放行 */ }

      return degraded === null ? { ok: true } : { ok: true, degraded }
    } catch (error) {
      const verdict = deny(500, 'guard-error: ' + textOf(error), 'guard')
      noteDenial(verdict)
      return verdict
    }
  }

  guard.info = info
  guard.stats = stats
  return guard
}

/* ------------------------------------------------------------------ *
 * 脱敏：绝对路径 → basename
 * ------------------------------------------------------------------ */

/** 路径片段的尾部字符集（不含空白与常见分隔符，避免把整句话吞进来）。 */
const TAIL = '[^\\s"\'<>|?*,;()\\[\\]{}]*'

/** Windows 盘符路径：D:\a\b / D:/a/b。 */
const WINDOWS_PATH = new RegExp('[A-Za-z]:[\\\\/]' + TAIL, 'g')

/** UNC 路径：\\server\share\a。 */
const UNC_PATH = new RegExp('\\\\\\\\' + TAIL, 'g')

/** 常见 POSIX 绝对根（只认这些根，避免把 1/2 之类的普通文本当成路径）。 */
const POSIX_PATH = new RegExp(
  '/(?:home|Users|mnt|root|tmp|var|opt|srv|private|Volumes|projects)/' + TAIL,
  'g',
)

/** 绝对路径 → 最后一段（D:\客户\机密项目\源码 → 源码）。 */
export function basenameOf(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/')
  const parts = normalized.split('/').filter((segment) => segment.length > 0)
  if (parts.length === 0) return ''
  return parts[parts.length - 1]
}

/** 末尾标点单独保留，别把（...）里的路径连同标点一起吃掉。 */
function trailingPunctuation(value) {
  const match = /[.,;:!?)\]}，。；：、）】》]+$/u.exec(value)
  return match ? match[0] : ''
}

/** 单段命中 → basename（保留末尾标点）。 */
function redactMatch(matched) {
  const tail = trailingPunctuation(matched)
  const core = tail ? matched.slice(0, matched.length - tail.length) : matched
  const base = basenameOf(core)
  if (!base) return matched
  return base + tail
}

/**
 * 把文本里的绝对路径换成 basename。
 *
 * 只动「值」，不动结构 —— 前端读的是字段名与 kind/at，这些一概不碰。
 * 覆盖三类：Windows 盘符路径、UNC 路径、常见 POSIX 根下的路径。
 * 已经是 basename 的输入原样返回（幂等），所以可以对同一份数据重复调用。
 *
 * @param {string} text
 * @returns {string}
 */
export function redactWorkspace(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  return text
    .replace(UNC_PATH, (matched) => redactMatch(matched))
    .replace(WINDOWS_PATH, (matched) => redactMatch(matched))
    .replace(POSIX_PATH, (matched) => redactMatch(matched))
}

/**
 * 事件列表脱敏：workspace 换成 basename，detail 里的绝对路径也换掉。
 *
 * **字段名一个都不改**（前端在读 e.kind / e.at / e.detail）；
 * 只改值的形态，所以事件列表的可用性不变。
 *
 * @param {any[]} events
 * @returns {any[]}
 */
export function redactEvents(events) {
  if (!Array.isArray(events)) return events
  return events.map((row) => {
    if (!row || typeof row !== 'object') return row
    const out = { ...row }
    if (typeof out.workspace === 'string' && out.workspace.length > 0) {
      out.workspace = basenameOf(out.workspace)
    }
    if (typeof out.detail === 'string' && out.detail.length > 0) {
      out.detail = redactWorkspace(out.detail)
    }
    return out
  })
}
