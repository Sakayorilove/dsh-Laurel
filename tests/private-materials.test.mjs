import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createMaterialsHandler } from '../lib/private-materials.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'laurel-materials-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const body = Buffer.from('synthetic artwork bytes'), name = createHash('sha256').update(body).digest('hex') + '.png'
  const manifest = { schema: 1, files: [{ name, mime: 'image/png', width: 10, height: 8 }], aliases: { 'art/sample.png': '/laurel-center/materials/' + name } }
  writeFileSync(join(root, name), body); writeFileSync(join(root, 'manifest.json'), '{"schema":1}')
  return { root, body, name, manifest, api: createMaterialsHandler({ root, manifest }) }
}
function request(handler, url, method = 'GET') {
  const response = { status: 0, headers: {}, body: undefined, writeHead(status, headers = {}) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
  handler({ url, method }, response)
  return response
}
test('serves exact allowlisted bytes, content type, private cache and HEAD', t => {
  const f = fixture(t), path = '/laurel-center/materials/' + f.name
  const r = request(f.api.handler, path)
  assert.equal(r.status, 200); assert.deepEqual(r.body, f.body); assert.equal(r.headers['content-type'], 'image/png'); assert.match(r.headers['cache-control'], /^private/)
  const h = request(f.api.handler, path, 'HEAD'); assert.equal(h.status, 200); assert.equal(h.body, undefined); assert.equal(h.headers['content-length'], f.body.length)
})
test('rejects unknown names, traversal, encoded traversal and mutation verbs', t => {
  const f = fixture(t)
  for (const path of ['../secret', '%2e%2e%2fsecret', 'unknown.png', f.name + '/extra']) assert.equal(request(f.api.handler, '/laurel-center/materials/' + path).status, 404)
  assert.equal(request(f.api.handler, '/laurel-center/materials/' + f.name, 'POST').status, 405)
})
test('does not follow a symlink outside the private pack', t => {
  const f = fixture(t), outside = join(f.root, '..', 'outside-' + f.name)
  writeFileSync(outside, f.body); t.after(() => rmSync(outside, { force: true }))
  rmSync(join(f.root, f.name)); symlinkSync(outside, join(f.root, f.name))
  const r = request(f.api.handler, '/laurel-center/materials/' + f.name)
  assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'image/svg+xml'); assert.notDeepEqual(r.body, f.body); assert.equal(f.api.available(), false)
})
test('rejects modified bytes and has a non-sensitive missing-image fallback', t => {
  const f = fixture(t); writeFileSync(join(f.root, f.name), 'different contents')
  const r = request(f.api.handler, '/laurel-center/materials/' + f.name)
  assert.equal(r.headers['content-type'], 'image/svg+xml'); assert.match(r.body.toString(), /width="10" height="8"/); assert.doesNotMatch(r.body.toString(), /different|private-assets|tmp/)
})
test('status does not expose a path or file listing; missing pack remains optional', t => {
  const f = fixture(t); assert.equal(f.api.available(), true)
  const path = '/laurel-center/materials/status.json'; assert.deepEqual(JSON.parse(request(f.api.handler, path).body), { schema: 1, available: true })
  rmSync(join(f.root, 'manifest.json')); assert.deepEqual(JSON.parse(request(f.api.handler, path).body), { schema: 1, available: false })
})
test('legacy asset URLs use the same allowlist and cache can be disposed', t => {
  const f = fixture(t); assert.deepEqual(request(f.api.legacy, '/laurel-center/art/sample.png').body, f.body)
  assert.equal(request(f.api.legacy, '/laurel-center/art/../secret').status, 404)
  f.api.dispose(); rmSync(join(f.root, f.name)); assert.equal(request(f.api.handler, '/laurel-center/materials/' + f.name).headers['content-type'], 'image/svg+xml')
})
