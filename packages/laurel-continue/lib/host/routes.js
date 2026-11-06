/**
 * laurel-continue · HTTP 数据面
 *
 * 给浏览器半边（设置页与会话区开关）读配置、看状态、翻事件、下指令。
 *
 * 前缀 `/laurel/continue`。它与 laurel 通知模块的 `/laurel` 不冲突：
 * 宿主的路由是「**最长前缀优先**」，所以 `/laurel/continue/*` 会先命中这里，
 * 其余 `/laurel/*` 照旧归通知模块 —— 两个模块同时装着也不会互相抢请求。
 *
 * 响应形状只有两种（契约 §5.2）：
 *   { ok: true,  data: ... }
 *   { ok: false, error: '<文本>' }
 * 未声明路径 404、方法不符 405、handler 抛异常转 500。
 * **异常绝不许穿透到宿主** —— webServer 是共享服务，一个插件抛异常
 * 不该影响别的插件的路由。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

/** 路由前缀。 */
export const ROUTE_PREFIX = '/laurel/continue'

/** action 端点的合法取值（契约 §5.2）。 */
export const ACTIONS = Object.freeze([
  'resume-now',
  'pause',
  'unpause',
  'reset-stats',
  'loop-reset',
])

/** 请求体字节上限。 */
const BODY_LIMIT = 64 * 1024

/** 读请求体。不是合法 JSON 就返回 null，不抛。 */
function readJsonBody(req, limit = BODY_LIMIT) {
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

/** 统一响应。HEAD 只发头不发体。 */
export function send(res, status, payload, method = 'GET') {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(method === 'HEAD' ? undefined : JSON.stringify(payload))
}

/** `{ ok: true, data }`。 */
export const ok = (res, data, method) => send(res, 200, { ok: true, data }, method)

/** `{ ok: false, error }`。 */
export const fail = (res, status, error, method) => send(res, status, { ok: false, error }, method)

/**
 * 造一个前缀路由 handler。
 *
 * @param {{getConfig: Function, setConfig?: Function, engine: object,
 *          defaults?: object, log?: any, version?: string}} deps
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createHandler(deps = {}) {
  const log = deps.log ?? null
  const engine = deps.engine ?? null
  const getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => ({})
  const setConfig = typeof deps.setConfig === 'function' ? deps.setConfig : null
  const defaults = deps.defaults && typeof deps.defaults === 'object' ? deps.defaults : {}

  /** 路由表：一个键支持多个方法；函数简写 = GET/HEAD。 */
  const routes = {
    '/config': {
      GET: ({ res, method }) => ok(res, { config: getConfig(), defaults }, method),
      POST: async ({ req, res, method }) => {
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object') {
          return fail(res, 400, '请求体不是合法 JSON 对象', method)
        }
        if (!setConfig) return fail(res, 500, '这个版本没有配置写入能力', method)
        const patch = body.config && typeof body.config === 'object' ? body.config : body
        try {
          const config = setConfig(patch)
          return ok(res, { config }, method)
        } catch (error) {
          return fail(res, 500, '配置写入失败：' + String(error?.message ?? error), method)
        }
      },
    },

    '/status': ({ res, method }) => {
      if (!engine || typeof engine.getStatus !== 'function') {
        return fail(res, 500, '引擎未就绪', method)
      }
      const status = engine.getStatus()
      return send(res, 200, status, method)
    },

    '/events': ({ res, method, url }) => {
      const raw = Number(url?.searchParams?.get('limit'))
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(200, Math.round(raw)) : 50
      const events = deps.events && typeof deps.events.read === 'function'
        ? deps.events.read(limit, deps.home)
        : []
      return ok(res, { events }, method)
    },

    '/action': {
      POST: async ({ req, res, method }) => {
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object') {
          return fail(res, 400, '请求体不是合法 JSON 对象', method)
        }
        const action = typeof body.action === 'string' ? body.action : ''
        if (!ACTIONS.includes(action)) {
          return fail(res, 400, '未知 action：' + (action || '(空)') + '，合法值：' + ACTIONS.join(' / '), method)
        }
        if (!engine) return fail(res, 500, '引擎未就绪', method)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''

        try {
          switch (action) {
            case 'resume-now': {
              if (!sessionId) return fail(res, 400, 'resume-now 需要 sessionId', method)
              if (typeof engine.handleTurnEnd !== 'function') {
                return fail(res, 500, '引擎未就绪', method)
              }
              const outcome = engine.handleTurnEnd({
                sessionId,
                // 手动"立刻继续"= 用户明确要求，所以给一个可恢复的原因走同一套闸门；
                // 冷却与时段照样生效，避免按钮被连点成刷屏。
                reason: { kind: 'max-tokens' },
              })
              return ok(res, { outcome }, method)
            }
            case 'pause': {
              if (!sessionId) return fail(res, 400, 'pause 需要 sessionId', method)
              const until = Number.isFinite(body.until) ? body.until : undefined
              return ok(res, engine.pause(sessionId, until), method)
            }
            case 'unpause': {
              if (!sessionId) return fail(res, 400, 'unpause 需要 sessionId', method)
              return ok(res, engine.unpause(sessionId), method)
            }
            case 'reset-stats': {
              engine.resetStats()
              return ok(res, {}, method)
            }
            case 'loop-reset': {
              engine.resetLoop()
              return ok(res, {}, method)
            }
            default:
              return fail(res, 400, '未知 action：' + action, method)
          }
        } catch (error) {
          return fail(res, 500, '动作执行失败：' + String(error?.message ?? error), method)
        }
      },
    },
  };

  // 预先展开函数简写。
  //
  // 顺带补一条别处容易漏的规则：**HEAD 应当与 GET 同样可读**。
  // 只读端点（/config、/status、/events）声明 GET 时自动获得 HEAD，
  // 否则 `curl -I` 会拿到 405 —— 而 405 会让探活脚本误以为端点根本不存在。
  // POST-only 的端点（/action）不该有 HEAD，那里保持 405 是对的。
  const table = new Map()
  for (const [route, spec] of Object.entries(routes)) {
    if (typeof spec === 'function') {
      table.set(route, { GET: spec, HEAD: spec })
      continue
    }
    const expanded = { ...spec }
    if (typeof expanded.GET === 'function' && typeof expanded.HEAD !== 'function') {
      expanded.HEAD = expanded.GET
    }
    table.set(route, expanded)
  }

  return async function handler(req, res) {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://localhost')
    // 剥掉前缀，收掉尾部斜杠：'/laurel/continue' 与 '/laurel/continue/' 都归到 '/'。
    const route = url.pathname.replace(new RegExp('^' + ROUTE_PREFIX), '').replace(/\/+$/, '') || '/'
    try {
      const spec = table.get(route)
      const fn = spec?.[method]
      if (typeof fn !== 'function') {
        // 路由存在但不支持这个方法 → 405；路由根本不存在 → 404。
        // 分开报，排错快得多。
        if (spec) return fail(res, 405, '不支持的方法：' + method + ' ' + ROUTE_PREFIX + route)
        return fail(res, 404, '未知端点：' + method + ' ' + ROUTE_PREFIX + route)
      }
      return await fn({ req, res, method, url, route })
    } catch (error) {
      // ★ 异常绝不穿透：webServer 是共享服务。
      const message = String(error?.message ?? error)
      try { log?.error?.('HTTP 处理出错（' + method + ' ' + ROUTE_PREFIX + route + '）：' + message) } catch { /* 日志不许影响响应 */ }
      return fail(res, 500, message)
    }
  }
}

/** 本模块的路由清单（文档/测试用）。 */
export const ROUTE_TABLE = Object.freeze([
  { method: 'GET', path: ROUTE_PREFIX + '/config' },
  { method: 'POST', path: ROUTE_PREFIX + '/config' },
  { method: 'GET', path: ROUTE_PREFIX + '/status' },
  { method: 'GET', path: ROUTE_PREFIX + '/events' },
  { method: 'POST', path: ROUTE_PREFIX + '/action' },
])
