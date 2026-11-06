import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

for (const entry of [
  'packages/laurel-memory/lib/index.js',
  'packages/laurel-context/lib/index.js',
  'packages/laurel-context/lib/compaction-entry.mjs',
]) {
  test(`${entry} opens the data vault under DSH_HOME`, () => {
    const home = mkdtempSync(join(tmpdir(), 'laurel-vault-'))
    try {
      const url = new URL(`../${entry}`, import.meta.url).href
      const script = `
        import assert from 'node:assert/strict';
        import { join } from 'node:path';
        const { apply } = await import(${JSON.stringify(url)});
        const result = apply({}, { logLevel: 'error', retention: { enabled: false } });
        assert.equal(result.state.vaultDir, join(process.env.DSH_HOME, 'laurel-core'));
        assert.equal(result.state.error, null);
        assert.notEqual(result.state.enabled, false);
      `
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', timeout: 15000,
      })
      assert.equal(child.status, 0, child.stderr || child.stdout)
      assert.ok(existsSync(join(home, 'laurel-core', 'manifest.json')))
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
}

test('experience capture recognizes references to the shared package', async () => {
  const { selfReferenceIn } = await import('../packages/laurel-memory/lib/experience/pipeline.mjs')
  assert.equal(selfReferenceIn('Fix laurel-core before capturing this correction'), 'laurel-core')
})
