import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
export const MATERIALS_MANIFEST = JSON.parse(readFileSync(join(here, 'materials-manifest.json'), 'utf8'))
export const MATERIALS_PREFIX = '/laurel-center/materials/'

/** Serve only the content-addressed artwork allowlist from a separate local pack. */
export function createMaterialsHandler({ root, manifest = MATERIALS_MANIFEST, fontFile = join(here, 'assets/saira-v5.3.0.woff2') }) {
  const entries = new Map(manifest.files.map(entry => [entry.name, entry]))
  const cache = new Map()
  const canonical = name => {
    const base = realpathSync(root), target = realpathSync(join(root, name))
    if (!target.startsWith(base + sep)) throw new Error('outside-material-pack')
    return target
  }
  const available = () => {
    try {
      const pack = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
      return pack.schema === 1 && entries.size > 0 && [...entries.keys()].every(name => existsSync(canonical(name)))
    } catch { return false }
  }
  function payload(name) {
    const entry = entries.get(name)
    if (!entry) return null
    if (cache.has(name)) return cache.get(name)
    try {
      const body = readFileSync(canonical(name))
      if (createHash('sha256').update(body).digest('hex') !== name.split('.')[0]) throw new Error('material-hash-mismatch')
      const value = { body, mime: entry.mime, private: true }
      cache.set(name, value)
      return value
    } catch {
      // A missing optional pack must leave the controls usable.
      if (entry.mime.startsWith('image/')) {
        const width = Math.max(1, Math.min(8192, entry.width || 1)), height = Math.max(1, Math.min(8192, entry.height || 1))
        return { body: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`), mime: 'image/svg+xml', private: false }
      }
      if (entry.mime.startsWith('font/')) {
        try { return { body: readFileSync(fontFile), mime: 'font/woff2', private: false } } catch {}
      }
      return null
    }
  }
  function send(res, value, head = false) {
    if (!value) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return }
    res.writeHead(200, { 'content-type': value.mime, 'content-length': value.body.length, 'cache-control': value.private ? 'private, max-age=86400' : 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(head ? undefined : value.body)
  }
  function handler(req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return }
    const path = String(req.url).split('?')[0]
    if (path === MATERIALS_PREFIX + 'status.json') {
      const body = Buffer.from(JSON.stringify({ schema: 1, available: available() }))
      send(res, { body, mime: 'application/json; charset=utf-8', private: false }, req.method === 'HEAD'); return
    }
    const name = path.startsWith(MATERIALS_PREFIX) ? path.slice(MATERIALS_PREFIX.length) : ''
    if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(name) || !entries.has(name)) { res.writeHead(404); res.end(); return }
    send(res, payload(name), req.method === 'HEAD')
  }
  function legacy(req, res) {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return }
    const path = String(req.url).split('?')[0], prefix = '/laurel-center/art/'
    const name = path.startsWith(prefix) ? path.slice(prefix.length) : ''
    if (name === 'saira-v5.3.0.woff2') {
      try { send(res, { body: readFileSync(fontFile), mime: 'font/woff2', private: false }, req.method === 'HEAD') } catch { send(res, null) }
      return
    }
    const target = manifest.aliases['art/' + name]
    if (typeof target !== 'string' || !target.startsWith(MATERIALS_PREFIX)) { res.writeHead(404); res.end(); return }
    send(res, payload(target.slice(MATERIALS_PREFIX.length)), req.method === 'HEAD')
  }
  return { handler, legacy, available, dispose: () => cache.clear() }
}
