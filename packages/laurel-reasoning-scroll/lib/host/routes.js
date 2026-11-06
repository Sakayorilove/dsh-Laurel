/**
 * laurel-reasoning-scroll · HTTP 数据面
 *
 * 给浏览器半边读配置、写配置、看落盘状态。只有三个端点 —— 这个模块没有引擎、
 * 没有台账、没有定时器，它的全部状态就是那八个开关。
 *
 * 响应形状只有两种（与套件其它模块同一套约定）：
 *   { ok: true,  data: ... }
 *   { ok: false, error: '<文本>' }
 * 未声明路径 404、方法不符 405、handler 抛异常转 500。
 * **异常绝不许穿透到宿主** —— webServer 是共享服务，一个插件抛异常不该
 * 影响别的插件的路由。
 *
 * ── 写成功不能只看「我 POST 出去了」─────────────────────────────────────
 * 写盘失败时必须照实说：内存里已经生效、重启就没了，界面不能显示「已保存」。
 * 所以 POST /config 的响应里带 persisted 与 reason，并且落盘之后**回读一次**
 * 盘上那份与内存这份是否一致（verified）—— 只信自己刚写的那次调用，
 * 等于让「写成功了」这句话没有第二个证据。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

import { CONFIG_KEYS, DEFAULT_CONFIG, pickKnown } from '../core/config.js'
import { createRequestGuard } from './guard.js'

/** 路由前缀。与 lib/index.js、lib/client/index.mjs 三处必须一致。 */
export const ROUTE_PREFIX = '/laurel/reasoning-scroll'

/** 请求体字节上限。八个开关用不到 64KB。 */
const BODY_LIMIT = 64 * 1024

/** 读请求体。不是合法 JSON 对象就返回 null，不抛。 */
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
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        resolve(null)
      }
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

/** 成功封套。 */
export const ok = (res, data, method) => send(res, 200, { ok: true, data }, method)

/** 失败封套。 */
export const fail = (res, status, error, method) => send(res, status, { ok: false, error }, method)/** 去掉尾部斜杠。不用正则：这个文件里已经有一个 RegExp，多一个没必要。 */
function stripTrailingSlashes(pathname) {
  let out = pathname
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/**
 * 造一个前缀路由 handler。
 *
 * @param {object} deps getConfig / setConfig / getPersistence / verifyPersisted / paths / version / log
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createHandler(deps) {
  const guard = createRequestGuard({ getConnection: deps.getConnection, log: deps.log })
  const log = deps.log ?? null

  /** 状态快照：设置页与排障共用这一份。 */
  const statusPayload = () => ({
    package: 'laurel-reasoning-scroll',
    version: deps.version,
    config: deps.getConfig(),
    defaults: pickKnown(DEFAULT_CONFIG),
    keys: [...CONFIG_KEYS],
    persistence: typeof deps.getPersistence === 'function' ? deps.getPersistence() : null,
    verified: typeof deps.verifyPersisted === 'function' ? deps.verifyPersisted() : null,
    paths: deps.paths ?? null,
  })

  const routes = {
    '/config': {
      GET: ({ res, method }) => ok(res, {
        config: deps.getConfig(),
        defaults: pickKnown(DEFAULT_CONFIG),
        keys: [...CONFIG_KEYS],
        persistence: typeof deps.getPersistence === 'function' ? deps.getPersistence() : null,
      }, method),
      POST: async ({ req, res, method }) => {
        const body = await readJsonBody(req)
        if (body === null) return fail(res, 400, '请求体不是合法 JSON 对象', method)
        const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
        const patch = isObject(body.config) ? body.config : body
        const result = deps.setConfig(patch)
        if (result?.ok !== true) {
          // 写盘失败：500 + 原文，但**仍然带上已生效的内存值** ——
          // 界面要能同时显示「这一版已经在用」和「重启会丢」。
          return send(res, 500, {
            ok: false,
            error: String(result?.reason ?? '配置写入失败'),
            data: {
              config: deps.getConfig(),
              persisted: false,
              reason: String(result?.reason ?? '配置写入失败'),
              verified: typeof deps.verifyPersisted === 'function' ? deps.verifyPersisted() : null,
            },
          }, method)
        }
        return ok(res, {
          config: deps.getConfig(),
          persisted: result.persisted !== false,
          reason: String(result.reason ?? '已落盘'),
          verified: typeof deps.verifyPersisted === 'function' ? deps.verifyPersisted() : null,
        }, method)
      },
    },

    '/status': ({ res, method }) => ok(res, statusPayload(), method),
  }

  // 展开成按方法索引的表。
  //
  // 两个坑都在这儿：
  //   1. 路由可以写成**一个函数**（纯 GET 端点）或一个「方法 → 函数」的表。
  //      函数体直接展开成 `{ ...spec }` 只会得到空对象 —— 那条路由就静默变成
  //      "未知端点"，而且完全没有报错。所以这里必须先判 typeof。
  //   2. 只读端点自动获得 HEAD。否则探活脚本（`curl -I`）拿到 405，
  //      会误以为端点根本不存在。
  const table = new Map()
  for (const [route, spec] of Object.entries(routes)) {
    const expanded = typeof spec === 'function' ? { GET: spec, HEAD: spec } : { ...spec }
    if (typeof expanded.GET === 'function' && typeof expanded.HEAD !== 'function') expanded.HEAD = expanded.GET
    table.set(route, expanded)
  }

  return async function handler(req, res) {
    // ★ 闸门在第一行：在解析 URL、读 body、碰任何存储之前。
    const verdict = guard.check(req)
    if (verdict.ok !== true) {
      const note = '拒绝一个请求（' + String(verdict.layer) + '）：' + String(verdict.reason)
      try { log?.warn?.(note) } catch { /* 日志不许影响响应 */ }
      return fail(res, Number(verdict.status) || 403, String(verdict.reason))
    }

    const method = String(req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const prefixPattern = new RegExp('^' + ROUTE_PREFIX)
    const route = stripTrailingSlashes(url.pathname.replace(prefixPattern, '')) || '/'
    try {
      const spec = table.get(route)
      const fn = spec?.[method]
      if (typeof fn !== 'function') {
        // 路由在、方法不对 → 405；路由不在 → 404。分开报，排错快得多。
        if (spec) return fail(res, 405, '不支持的方法：' + method + ' ' + ROUTE_PREFIX + route)
        return fail(res, 404, '未知端点：' + method + ' ' + ROUTE_PREFIX + route)
      }
      return await fn({ req, res, method, url, route })
    } catch (error) {
      const message = String(error?.message ?? error)
      const note = 'HTTP 处理出错（' + method + ' ' + ROUTE_PREFIX + route + '）：' + message
      try { log?.error?.(note) } catch { /* 日志不许影响响应 */ }
      return fail(res, 500, message)
    }
  }
}

/** 本模块的路由清单（文档与测试用）。 */
export const ROUTE_TABLE = Object.freeze([
  { method: 'GET', path: ROUTE_PREFIX + '/config' },
  { method: 'POST', path: ROUTE_PREFIX + '/config' },
  { method: 'GET', path: ROUTE_PREFIX + '/status' },
])
