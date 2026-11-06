import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { normalizePresentation, presentationAdmission, presentationFile, readPresentation, writePresentation, createPresentationHandler, mountPresentation } from '../lib/ui-preferences.js'
import { normalizeLibraryPreferences, filterLibraryRows, createPresentationClient } from '../lib/client/library-state.mjs'

test('profile preferences survive a new process-origin and do not change unrelated state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'laurel-prefs-'))
  try {
    const a = presentationFile(dir, '/profiles/one'), b = presentationFile(dir, '/profiles/two')
    assert.notEqual(a, b)
    writeFileSync(join(dir, 'state.json'), 'legacy-unchanged')
    writePresentation(a, { theme: 'wuling', favorites: ['memory-core'], motion: false })
    writePresentation(a, { view: 'list' })
    assert.deepEqual(readPresentation(a), normalizePresentation({ theme: 'wuling', view: 'list', motion: false, favorites: ['memory-core'], recent: [] }))
    assert.equal(readPresentation(b).theme, 'endfield')
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), 'legacy-unchanged')
    writeFileSync(a, 'broken')
    assert.throws(() => writePresentation(a, { theme: 'endfield' }))
    assert.equal(readFileSync(a, 'utf8'), 'broken')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unknown preferences and IDs are bounded; never surface injected fields', () => {
  const bad = { theme: 'unknown', view: 'unknown', favorites: ['memory-core', 'memory-core', '../x'], recent: Array.from({ length: 500 }, (_, i) => 'm-' + i), secret: 'x' }
  assert.deepEqual(normalizeLibraryPreferences(bad), normalizePresentation(bad))
  assert.equal(normalizePresentation(bad).recent.length, 30)
  assert.deepEqual(normalizePresentation(bad).favorites, ['memory-core'])
  assert.equal(normalizePresentation(bad).secret, undefined)
})

test('native admission fail-closed including ambiguous and unavailable services', () => {
  const req = { headers: { 'x-laurel-ui': '1' } }
  assert.equal(presentationAdmission(req, { admit: () => ({ peer: {} }) }), null)
  assert.equal(presentationAdmission(req, { admit: () => ({ rejection: 401 }) }), 401)
  assert.equal(presentationAdmission(req, { admit: () => ({}) }), 503)
  assert.equal(presentationAdmission(req, null), 503)
  assert.equal(presentationAdmission({ headers: {} }, { admit: () => ({ peer: {} }) }), 403)
})

test('real HTTP route rejects unauthenticated, wrong methods/fields and writes only preferences', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'laurel-http-'))
  const file = presentationFile(dir, 'profile')
  let disposed = false
  const handler = createPresentationHandler({ file, connection: () => ({ admit: req => req.headers.authorization === 'test-only' ? { peer: {} } : { rejection: 401 } }), disposed: () => disposed })
  const server = createServer(handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = 'http://127.0.0.1:' + server.address().port + '/api/laurel-center/presentation'
  const headers = { authorization: 'test-only', 'x-laurel-ui': '1', 'content-type': 'application/json' }
  try {
    assert.equal((await fetch(url)).status, 403)
    assert.equal((await fetch(url, { headers: { 'x-laurel-ui': '1' } })).status, 401)
    assert.equal((await fetch(url, { headers, method: 'DELETE' })).status, 405)
    assert.equal((await fetch(url, { headers, method: 'POST', body: '{' })).status, 400)
    assert.equal((await fetch(url, { headers, method: 'POST', body: '{"enabled":true}' })).status, 400)
    assert.equal((await fetch(url, { headers, method: 'POST', body: '{"theme":"evil"}' })).status, 400)
    assert.equal((await fetch(url, { headers, method: 'POST', body: 'x'.repeat(2097153) })).status, 413)
    const result = await fetch(url, { headers, method: 'POST', body: '{"theme":"wuling","view":"list"}' })
    assert.equal(result.status, 200)
    assert.equal((await result.json()).value.theme, 'wuling')
    assert.equal((await (await fetch(url, { headers })).json()).value.view, 'list')
    disposed = true
    assert.equal((await fetch(url, { headers })).status, 503)
  } finally { await new Promise(r => server.close(r)); rmSync(dir, { recursive: true, force: true }) }
})

test('100 modules searchable beyond viewport, combined filters and stable favorite IDs', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: 'module-' + i, label: '模块' + i, state: 'ready', category: i % 2 ? 'new-category' : 'continuity', enabled: i % 3 !== 0, order: i, keywords: i === 99 ? ['尾部目标'] : [] }))
  assert.equal(filterLibraryRows(rows, { query: '尾部目标' })[0].id, 'module-99')
  assert.equal(filterLibraryRows(rows, { category: 'new-category' }).length, 50)
  assert.equal(filterLibraryRows(rows, { status: 'disabled' }).length, 34)
  assert.equal(filterLibraryRows(rows, { section: 'favorites', preferences: { favorites: ['module-99'] } })[0].id, 'module-99')
  assert.equal(filterLibraryRows(rows, { section: 'recent', preferences: { recent: ['module-80', 'module-3'] } })[0].id, 'module-80')
  assert.deepEqual(filterLibraryRows([{ id: 'unknown', state: 'missing' }], { status: 'disabled' }), [])
  assert.equal(filterLibraryRows([{ id: 'failed', state: 'ready', fiberPhase: 'failed' }], { section: 'attention' }).length, 1)
})

test('late initial preference read cannot overwrite an in-flight user theme change', async () => {
  let release
  const client = createPresentationClient({ storage: () => null, fetcher: async (_url, opts) => {
    if (opts.method === 'GET') return await new Promise(r => { release = () => r({ ok: true, json: async () => ({ ok: true, value: { theme: 'endfield', favorites: ['memory-core'] } }) }) })
    return { ok: true, json: async () => ({ ok: true, value: JSON.parse(opts.body) }) }
  } })
  const reading = client.load()
  const saving = client.update({ theme: 'wuling' })
  release(); await reading; await saving
  assert.equal(client.getSnapshot().theme, 'wuling')
  assert.equal(client.getSnapshot().saved, true)
  client.stop()
})

test('failed preference write keeps preview and reports unsaved rather than success', async () => {
  const client = createPresentationClient({ storage: () => null, fetcher: async () => { throw Error('offline') } })
  await client.update({ theme: 'wuling' })
  assert.equal(client.getSnapshot().theme, 'wuling')
  assert.equal(client.getSnapshot().saved, false)
  assert.match(client.getSnapshot().error, /offline/)
  client.stop()
})

test('public package art routes return safe optional-pack fallbacks and unregister', async () => {
  const routes = [], cleanup = []
  const child = { get: () => null, effect(fn) { const off = fn(); if (typeof off === 'function') cleanup.push(off) }, webServer: { register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } } }
  mountPresentation({ inject(_deps, fn) { fn(child) } }, tmpdir(), 'test')
  const art = routes.find(r => r.path === '/laurel-center/art')
  assert.ok(art)
  const server = createServer(art.handler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port + '/laurel-center/art/'
  try {
    for (const name of ['wuling-landscape-v2.webp', 'wuling-si-v2.webp']) {
      const res = await fetch(base + name)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/svg+xml')
      assert.equal(res.headers.get('cache-control'), 'no-store')
      const bytes = Buffer.from(await res.arrayBuffer())
      assert.match(bytes.toString(), /^<svg /)
      assert.doesNotMatch(bytes.toString(), /image href|script|foreignObject/)
      const head = await fetch(base + name, { method: 'HEAD' })
      assert.equal(head.headers.get('content-length'), String(bytes.length))
      assert.equal((await head.arrayBuffer()).byteLength, 0)
    }
    assert.equal((await fetch(base + 'wuling-si-v2.webp', { method: 'POST' })).status, 405)
    assert.equal((await fetch(base + '%2e%2e%2flib/ui-preferences.js')).status, 404)
    assert.equal((await fetch(base + 'unknown.webp')).status, 404)
    for (const off of cleanup.reverse()) off()
    assert.equal(routes.length, 0)
  } finally { await new Promise(r => server.close(r)) }
})

test('0.3 particle themes persist with all earlier theme identities preserved', () => {
  for (const theme of ['endfield','wuling','endfield-v02','wuling-v02','particle-v03','wuling-particle-v03']) {
    assert.equal(normalizePresentation({theme}).theme,theme)
    assert.equal(normalizeLibraryPreferences({theme}).theme,theme)
  }
})
