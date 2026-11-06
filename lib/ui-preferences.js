import { createWallpaperHandler } from './wallpaper-store.js'
import { createMaterialsHandler } from './private-materials.js'
import { PRESENTATION_DEFAULTS, PRESENTATION_THEMES, normalizePresentationValue } from './presentation-model.js'
/** Profile-scoped presentation preferences. No plugin/configuration write access. */
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

export const UI_PREFERENCES_PATH = '/api/laurel-center/presentation'
export const UI_DEFAULTS = PRESENTATION_DEFAULTS
export const normalizePresentation = normalizePresentationValue
export function presentationFile(dir, profile) {
  const key = createHash('sha256').update(String(profile)).digest('hex').slice(0, 24)
  return join(dir, `presentation-${key}.json`)
}
export function readPresentation(file) {
  try { return normalizePresentation(JSON.parse(readFileSync(file, 'utf8'))) }
  catch (error) { if (error.code === 'ENOENT') return normalizePresentation(); throw error }
}
export function writePresentation(file, patch) {
  const previous = readPresentation(file)
  const next = normalizePresentation({ ...previous, ...patch })
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(temp, JSON.stringify(next) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  } finally { try { rmSync(temp, { force: true }) } catch {} }
  return next
}
export function presentationAdmission(req, connection, requireUI = true) {
  if (requireUI && req.headers?.['x-laurel-ui'] !== '1') return 403
  // Same policy as the native API; fail closed when no admission is available.
  try {
    if (typeof connection?.admit === 'function') {
      const d = connection.admit(req)
      if (typeof d === 'number') return d
      if (d?.rejection !== undefined) return typeof d.rejection === 'number' ? d.rejection : 503
      if (d?.status !== undefined) return typeof d.status === 'number' ? d.status : 503
      if (d === undefined || d === null || d === true || d?.peer != null) return null
      return 503
    }
    if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req) ?? null
  } catch {}
  return 503
}
export function createPresentationHandler({ file, connection, disposed = () => false }) {
  return async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(JSON.stringify(value))
    }
    if (disposed()) return send(503, { error: 'disposed' })
    if (String(req.url).split('?')[0] !== UI_PREFERENCES_PATH) return send(404, { error: 'not-found' })
    const rejection = presentationAdmission(req, connection())
    if (rejection) return send(rejection, { error: 'not-authorized' })
    if (!['GET', 'POST'].includes(req.method)) return send(405, { error: 'method-not-allowed' })
    try {
      if (req.method === 'GET') return send(200, { ok: true, value: readPresentation(file) })
      const chunks = []; let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 2097152) return send(413, { error: 'body-too-large' })
        chunks.push(chunk)
      }
      let patch
      try { patch = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'invalid-json' }) }
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !Object.hasOwn(UI_DEFAULTS, k))) return send(400, { error: 'invalid-preferences' })
      if (('colorMode' in patch && !['auto', 'light', 'dark'].includes(patch.colorMode)) || ['sound', 'soundEffects', 'music', 'hover', 'followSystemMotion', 'siEnabled'].some(k => k in patch && typeof patch[k] !== 'boolean') || ['volume', 'rewardVolume', 'areaVolume', 'musicVolume'].some(k => k in patch && (!Number.isFinite(patch[k]) || patch[k] < 0 || patch[k] > 1))) return send(400, { error: 'invalid-preferences' })
      if (['wallpaper','shadows'].some(k => k in patch && (!patch[k] || typeof patch[k] !== 'object' || Array.isArray(patch[k])))) return send(400, { error:'invalid-preferences' })
      if ('siTheme' in patch && !['si-flow-v03','si-paper-v01'].includes(patch.siTheme)) return send(400, { error: 'invalid-preferences' })
      if ('experienceRevision' in patch && patch.experienceRevision !== 5) return send(400, { error: 'invalid-preferences' })
      if (('navMode' in patch && !['tree','baker'].includes(patch.navMode)) || ('workspaceMarkers' in patch && (!patch.workspaceMarkers || typeof patch.workspaceMarkers !== 'object' || Array.isArray(patch.workspaceMarkers)))) return send(400, { error: 'invalid-preferences' })
      if (('theme' in patch && !PRESENTATION_THEMES.includes(patch.theme)) || ('view' in patch && !['list', 'grid'].includes(patch.view)) || ('motion' in patch && typeof patch.motion !== 'boolean') || ['favorites', 'recent'].some(k => k in patch && !Array.isArray(patch[k]))) return send(400, { error: 'invalid-preferences' })
      if (disposed()) return send(503, { error: 'disposed' })
      return send(200, { ok: true, value: writePresentation(file, patch) })
    } catch (error) { return send(500, { error: 'presentation-storage-failed' }) }
  }
}

export function mountPresentation(ctx, dir, profile) {
  if (typeof ctx.inject !== 'function') return
  return ctx.inject(['webServer'], child => {
    let disposed = false
    const connection = () => { try { return child.get('connection') } catch { return null } }
    const handler = createPresentationHandler({ file: presentationFile(dir, profile), connection, disposed: () => disposed })
    const wallpaper = createWallpaperHandler({ root:join(dir, 'wallpapers', createHash('sha256').update(String(profile)).digest('hex').slice(0,24)), admit:req => presentationAdmission(req, connection(), req.method === 'POST'), disposed:()=>disposed })
    child.effect(() => child.webServer.register({ kind:'prefix', path:'/api/laurel-center/wallpapers', handler:wallpaper }))
    const materials = createMaterialsHandler({ root: join(dir, 'private-assets') })
    child.effect(() => child.webServer.register({ kind: 'prefix', path: UI_PREFERENCES_PATH, handler }))
    child.effect(() => child.webServer.register({ kind: 'prefix', path: '/laurel-center/materials', handler: materials.handler }))
    child.effect(() => child.webServer.register({ kind: 'prefix', path: '/laurel-center/art', handler: materials.legacy }))
    child.effect(() => () => { disposed = true; materials.dispose() })
  })
}
