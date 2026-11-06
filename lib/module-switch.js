/**
 * Laurel-Center · 模块开关端点
 *
 * ── 它是干什么的 ─────────────────────────────────────────────────────────
 * 1.4.x 之前九个模块各是一条 loader 行，开关走宿主原生
 * `pluginManager.setPluginEnabled(entryId, enabled)`（写 profile 的用户层 patch）。
 * 现在 loader 树里只有 laurel-center 一行，模块是它的**子 fiber**（见 lib/modules.js），
 * 没有行可写 —— 开关改成写 `<profile>/.laurel-modules/modules.json`，
 * 客户端通过本文件这条窄端点读写。
 *
 * ── 鉴权（与 presentation 通道同一套）────────────────────────────────────
 * 宿主 WebServer 会把任意注册路由分发给调用者；注册 prefix **不继承**原生的
 * `/api` 认证。所以这里照抄 lib/ui-preferences.js 的 `presentationAdmission`：
 * 必须带 `x-laurel-ui: 1`，再问 `connection.admit(req)`，拿不到准入就失败关闭（503）。
 * 同一个 connection、同一个判断，不另立一套。
 *
 * ── 契约（客户端与宿主都按这个写，不许自创）──────────────────────────────
 *   GET  /api/laurel-center/modules
 *        → 200 { enabled: { <id>: boolean, ... }, status: [{ id, mounted, reason }] }
 *   POST /api/laurel-center/modules  body { id: string, enabled: boolean }
 *        → 200 { ok, id, enabled, applied, reason? }
 *        非法 id / body → 400   鉴权失败 → 403   已卸载 → 503
 *
 * 只认 lib/registry.js 里的 id —— 清单不在本文件重抄第二份。
 *
 * ── 三条纪律（与套件其它模块一致）───────────────────────────────────────
 *   1. 端点坏掉不许拖垮宿主：挂载与注册都包在 try/catch 里，异常只记日志。
 *   2. 只写 modules.json；**不碰** profile 的 cordis.patch.yml / package.json。
 *   3. 卸载后一律 503，不再读写任何东西。
 */

import { SUB_IDS } from './registry.js'
import { loadEnabled } from './modules.js'
import { presentationAdmission } from './ui-preferences.js'

/** 端点路径。客户端（lib/client/*）也按这个字符串拼请求。 */
export const MODULE_SWITCH_PATH = '/api/laurel-center/modules'

/** POST body 上限：这里只有两个字段，64 KiB 已经很宽。 */
export const MAX_BODY_BYTES = 65536

/** 允许的 body 字段。多一个都算非法，免得把不相干的字段带进来。 */
const BODY_KEYS = new Set(['id', 'enabled'])

/** 读开关表；paths 缺省就走 store.js 的 DSH_HOME 推导。 */
function readEnabled(paths) {
  return loadEnabled(paths === null || paths === undefined ? undefined : paths).enabled
}

function send(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

/**
 * 造一个端点处理函数（测试可以直接 createServer(handler)）。
 *
 * @param {object} options
 * @param {() => any} options.connection 取宿主的 connection 服务（懒取，可能为 null）
 * @param {() => boolean} [options.disposed] 插件已卸载时返回 true
 * @param {() => any} [options.getModules] 返回 mountModules() 的返回值
 * @param {object} [options.paths] centerPaths() 的结果（不传就用默认 DSH_HOME）
 */
export function createModuleSwitchHandler({ connection, disposed = () => false, getModules = () => null, paths } = {}) {
  return async (req, res) => {
    if (disposed()) return send(res, 503, { error: 'disposed' })
    if (String(req.url).split('?')[0] !== MODULE_SWITCH_PATH) return send(res, 404, { error: 'not-found' })

    const rejection = presentationAdmission(req, typeof connection === 'function' ? connection() : null)
    if (rejection) return send(res, rejection, { error: 'not-authorized' })

    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'method-not-allowed' })

    let controller = null
    try { controller = getModules() } catch { controller = null }

    try {
      if (req.method === 'GET') {
        if (controller === null || controller === undefined) return send(res, 503, { error: 'modules-unavailable' })
        // 首轮挂载是异步的；等它结束再报状态，否则刚启动就查会全是 false。
        try { await controller.ready?.() } catch { /* 首轮失败不影响读开关 */ }
        if (disposed()) return send(res, 503, { error: 'disposed' })
        return send(res, 200, { enabled: loadEnabled(paths, controller.specs?.()).enabled, status: controller.status(), catalog: controller.specs?.() })
      }

      // ── POST：读 body，严格校验，然后交给挂载控制器 ──────────────────
      const chunks = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > MAX_BODY_BYTES) return send(res, 413, { error: 'body-too-large' })
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(res, 400, { error: 'invalid-json' }) }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'invalid-body' })
      if (Object.keys(body).some((key) => !BODY_KEYS.has(key))) return send(res, 400, { error: 'invalid-body' })
      if (typeof body.id !== 'string' || !(controller?.specs?.().some(p => p.id === body.id) ?? SUB_IDS.includes(body.id))) return send(res, 400, { error: 'unknown-module' })
      if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'invalid-body' })

      if (controller === null || controller === undefined) return send(res, 503, { error: 'modules-unavailable' })
      if (disposed()) return send(res, 503, { error: 'disposed' })

      const result = await controller.setEnabled(body.id, body.enabled)
      return send(res, 200, {
        ok: result?.ok === true,
        id: body.id,
        enabled: result?.enabled ?? body.enabled,
        applied: result?.applied === true,
        ...(typeof result?.reason === 'string' ? { reason: result.reason } : {}),
      })
    } catch {
      // 端点不许把异常抛回宿主事件循环。
      return send(res, 500, { error: 'module-switch-failed' })
    }
  }
}

/**
 * 挂到宿主的 webServer 上。形状与 ui-preferences.js 的 mountPresentation 一致：
 * 顶层 `inject` 留空（非 Web 组合照常激活），真正依赖在调用点再注入。
 *
 * @param {any} ctx laurel-center 的上下文
 * @param {object} paths centerPaths() 的结果
 * @param {any} log 装载机的日志
 * @param {() => any} getModules 返回 mountModules() 的返回值
 */
export function mountModuleSwitch(ctx, paths, log, getModules) {
  if (typeof ctx?.inject !== 'function') return
  return ctx.inject(['webServer'], (child) => {
    let disposed = false
    const connection = () => { try { return child.get('connection') } catch { return null } }
    const handler = createModuleSwitchHandler({ connection, disposed: () => disposed, getModules, paths })
    // 与 presentation 通道一样：注册的是**不带尾斜杠**的精确前缀。
    child.effect(() => child.webServer.register({ kind: 'prefix', path: MODULE_SWITCH_PATH, handler }))
    child.effect(() => () => { disposed = true })
    log?.debug?.('模块开关端点已挂载 %s', MODULE_SWITCH_PATH)
  })
}
