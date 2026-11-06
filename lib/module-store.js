/** Immutable, profile-local module code. User data is never removed here. */
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync, cpSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { CATALOG_URL, CHECK_INTERVAL, compareVersions, parseVersion, validateCatalog, compatibleRelease, fetchBytes, validId } from './module-catalog.js'
import { VERSION } from './config.js'
import { SUPPORTED_HOST_VERSIONS } from './host-compat.js'

export const hash = data => createHash('sha256').update(data).digest('hex')
const MAX_ARCHIVE = 32 * 1024 * 1024, MAX_CONTENT = 64 * 1024 * 1024
const slotId = id => typeof id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)
export function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.' + randomUUID() + '.tmp'
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, file) }
  finally { rmSync(temp, { force: true }) }
}
/** No executable install scripts, links, absolute paths or platform-specific filenames. */
export function unpackModule(bytes, row, release, root) {
  if (bytes.length !== release.bytes || hash(bytes) !== release.sha256) throw Error('模块下载校验失败，旧版本保持')
  const archive = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_CONTENT }).toString('utf8'))
  if (archive.schema !== 1 || archive.id !== row.id || archive.version !== release.version || !Array.isArray(archive.files) || archive.files.length > 4000) throw Error('模块包身份无效')
  let size = 0; const seen = new Set()
  const prefix = 'packages/' + row.dir + '/'
  for (const file of archive.files) {
    if (typeof file.path !== 'string' || !file.path.startsWith(prefix) || file.path.length > 240 || !file.path.split('/').every(p => /^[a-zA-Z0-9_.@-]+$/.test(p) && p !== '.' && p !== '..' && !/[.]$/.test(p) && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)) || /(^|\/)node_modules(\/|$)/.test(file.path) || seen.has(file.path.toLowerCase()) || typeof file.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw Error('模块包包含非法文件')
    seen.add(file.path.toLowerCase())
    const data = Buffer.from(file.data, 'base64'); size += data.length
    if (size > MAX_CONTENT || data.length > 16 * 1024 * 1024) throw Error('模块解包超过限制')
    const target = join(root, file.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data, { flag: 'wx', mode: 0o600 })
  }
  const meta = JSON.parse(readFileSync(join(root, prefix, 'package.json'), 'utf8'))
  if (meta.name !== row.entry || meta.version !== release.version || meta.scripts && Object.keys(meta.scripts).length) throw Error('模块包声明与目录不符')
  return meta
}
function insideEntry(root, entry) {
  if (typeof entry !== 'string' || !entry.startsWith('./')) throw Error('模块入口无效')
  const target = resolve(root, entry), rel = relative(root, target)
  if (!rel || rel.startsWith('..') || resolve(root) === target) throw Error('模块入口越界')
  return target
}
function readState(file) {
  if (!existsSync(file)) return { schema: 1, installed: {}, migrated: false }
  const s = JSON.parse(readFileSync(file, 'utf8'))
  if (s.schema !== 1 || !s.installed || typeof s.installed !== 'object' || Array.isArray(s.installed)) throw Error('模块安装记录损坏；已停止写入，请恢复备份')
  const validateRecord = row => {
    if (!row || !slotId(row.slot) || !validId(row.dir) || !validId(row.entry) || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.dataSchema) || !Array.isArray(row.hostVersions) || !row.hostVersions.length) throw Error('模块安装记录无效')
    parseVersion(row.version);row.hostVersions.forEach(parseVersion)
  }
  for (const [id, row] of Object.entries(s.installed)) {
    if (!validId(id) || !row || !slotId(row.slot) || !validId(row.dir) || !validId(row.entry) || !/^[a-f0-9]{64}$/.test(row.sha256)) throw Error('模块安装记录无效')
    validateRecord(row);if(row.previous)validateRecord(row.previous)
  }
  return s
}

export class ModuleStore {
  constructor({ profileDir, dataPaths, specs, hostVersion, getManager = () => null, isBusy = () => true, fetchImpl = globalThis.fetch, catalogUrl = CATALOG_URL, assetPolicy, bundledRoot = fileURLToPath(new URL('../', import.meta.url)), now = Date.now } = {}) {
    if (!profileDir) throw Error('无法确认当前 profile，模块安装不可用')
    Object.assign(this, { profileDir, dataPaths, hostVersion, getManager, isBusy, fetchImpl, catalogUrl, assetPolicy, bundledRoot, now })
    this.root = join(profileDir, '.laurel-modules'); this.paths = { dir: this.root }
    this.file = join(this.root, 'installed.json'); this.abort = new AbortController(); this.closed = false
    this.job = { phase: 'idle', action: null, id: null, error: '' }; this.activeJob = null; this.modules = null
    this.lastAttempt = 0; this.checkedAt = null; this.checkError = ''; this.checking = null
    this.initializationError = ''; this.ready = async () => {}
    this.catalog = validateCatalog(JSON.parse(readFileSync(join(bundledRoot, 'release-catalog.json'), 'utf8')), assetPolicy)
    this.fallbackSpecs = specs; this.state = readState(this.file)
    if (existsSync(join(this.root, 'catalog.json'))) {
      try { this.catalog = validateCatalog(JSON.parse(readFileSync(join(this.root, 'catalog.json'), 'utf8')), assetPolicy) } catch { /* Keep bundled metadata for an offline catalog. */ }
    }
    this.checkedAt = null // A previous process's cached feed never authorizes a new install.
  }
  specs() {
    const rows = new Map()
    for (const p of this.catalog.modules) if (!p.hidden) rows.set(p.id, { ...this.fallbackSpecs.find(s=>s.id===p.id), ...p })
    // A removed catalog entry must not hide an installed module or uninstall it.
    for (const [id, p] of Object.entries(this.state.installed)) if (!rows.has(id) && p.spec && !p.spec.hidden) rows.set(id, { ...p.spec, retired: true })
    return [...rows.values()]
  }
  async exclusive(fn) {
    if (this.closed) throw Error('更新服务已停止')
    mkdirSync(this.root, { recursive: true })
    const lock = join(this.root, 'operation.lock')
    const acquire = () => { mkdirSync(lock); writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{flag:'wx'}) }
    try { acquire() } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let abandoned = false
      try { const owner = JSON.parse(readFileSync(join(lock,'owner.json'),'utf8')); if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw Error('invalid owner'); try { process.kill(owner.pid,0) } catch (e) { if (e.code === 'ESRCH') abandoned = true } }
      catch { abandoned = Date.now() - statSync(lock).mtimeMs > 30000 }
      if (!abandoned) throw Error('另一个安装事务正在执行；请稍后重试')
      rmSync(lock,{recursive:true,force:true}); acquire()
    }
    try { this.state = readState(this.file); return await fn() }
    finally { rmSync(lock, { recursive: true, force: true }) }
  }
  assertIdle() {
    if (this.closed || this.abort.signal.aborted) throw Error('更新服务已停止')
    if (this.isBusy() !== false) throw Error('有任务正在运行，或无法确认空闲；请等任务结束后重试')
  }
  async check(force = false) {
    if (this.checking) { await this.checking;return this.snapshot() }
    if (this.closed || this.lastAttempt && this.now() - this.lastAttempt < (force ? 30000 : this.checkError ? 5 * 60000 : CHECK_INTERVAL)) return this.snapshot()
    this.lastAttempt = this.now()
    this.checking = (async () => {
      try {
        const bytes = await fetchBytes(this.catalogUrl, { fetchImpl: this.fetchImpl, limit: 1024 * 1024, signal: this.abort.signal, timeout: 15000 })
        const catalog = validateCatalog(JSON.parse(bytes.toString('utf8')), this.assetPolicy)
        if (this.closed) return
        atomicJson(join(this.root, 'catalog.json'), catalog)
        this.catalog = catalog; this.checkedAt = this.now(); this.checkError = ''
      } catch (error) { if (!this.closed) this.checkError = '暂时无法检查更新：' + error.message }
    })().finally(() => { this.checking = null })
    await this.checking; return this.snapshot()
  }
  release(row, version) {
    const release = row?.releases?.find(r => r.version === version && r.published && r.centerApi === 1 && r.hostVersions.includes(this.hostVersion))
    if (!release || !this.checkedAt || this.checkError || this.now() - this.checkedAt > CHECK_INTERVAL) throw Error('请先检查更新并确认该版本适配当前宿主')
    return release
  }
  snapshot() {
    const row = p => {
      const installed = this.state.installed[p.id], latest = compatibleRelease(p, this.hostVersion)
      const runtime = this.modules?.status().find(r=>r.id===p.id)
      return { ...p, installed: !!installed, enabled: !!installed && this.modules?.enabled(p.id) === true, mounted: runtime?.mounted === true, reason: runtime?.reason || null, version: installed?.version || null, latestVersion: latest?.version || null, updateAvailable: !!installed && !!latest && compareVersions(latest.version, installed.version) > 0, installAvailable: !p.retired && !!latest && !!this.checkedAt && !this.checkError, incompatible: !latest && p.releases?.some(r => r.published), rollbackAvailable: !!installed?.previous && installed.previous.dataSchema === installed.dataSchema && installed.previous.hostVersions.includes(this.hostVersion), client: installed ? this.clientInfo(installed, p.id) : null }
    }
    const center = row(this.catalog.center)
    center.installed = true; center.version = VERSION; center.updateAvailable = !!center.latestVersion && compareVersions(center.latestVersion, VERSION) > 0
    const modules = this.specs().map(row)
    let receipt = null
    try { const r = JSON.parse(readFileSync(join(this.root,'center-receipt.json'),'utf8')); if (compareVersions(r.version,VERSION)!==0) receipt = r } catch {}
    if (this.diskCenter) receipt = this.diskCenter === VERSION ? null : {version:this.diskCenter}
    center.diskVersion = this.diskCenter || receipt?.version || VERSION
    center.restartRequired = !!receipt
    return { schema: 1, center, modules, hostVersion: this.hostVersion || null, checkedAt: this.checkedAt, checking: !!this.checking, stale: !!this.checkError, error: this.initializationError || this.checkError, job: receipt && !this.activeJob && this.job.phase !== 'failed' ? { ...this.job, phase:'restart-required', targetVersion:receipt.version } : { ...this.job }, updates: modules.filter(p => p.updateAvailable).length + (center.updateAvailable ? 1 : 0) }
  }
  async syncCenterInventory() {
    if(this.closed)return
    const manager=this.getManager()
    if(!manager?.listBundles)return
    try {
      const bundle=(await manager.listBundles()).find(b=>b.name==='laurel-center'&&b.installed)
      if(bundle?.version){compareVersions(bundle.version,VERSION);this.diskCenter=bundle.version;if(bundle.version===VERSION&&this.job.phase==='restart-required'&&!this.activeJob)this.job={phase:'idle',action:null,id:null,error:''}}
    } catch { /* Inventory unavailable: retain a verified native receipt. */ }
  }
  clientInfo(record, id) {
    const pkgRoot = join(this.root, 'slots', record.slot, 'packages', record.dir)
    try {
      const meta = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
      if (!meta.exports?.['./client']) return null
      const source = readFileSync(insideEntry(pkgRoot, meta.exports['./client']))
      return { id: 'laurel-managed-' + id + '-' + hash(source).slice(0, 24), url: '/api/laurel-center/store/client/' + id + '/' + record.sha256 + '.js', version: record.version }
    } catch { return null }
  }
  clientSource(id, sha256) {
    const record = this.state.installed[id]
    if (!record || record.sha256 !== sha256) throw Error('模块代码已变更，请刷新模块列表')
    const root = join(this.root, 'slots', record.slot, 'packages', record.dir)
    const meta = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const source = readFileSync(insideEntry(root, meta.exports['./client']), 'utf8'), alias = this.clientInfo(record, id)?.id
    const pattern = /(window\.__ModuleLoader__\.load\(\{\s*id:\s*)["'][^"']+["']/
    if (!alias || !pattern.test(source)) throw Error('模块客户端格式不受支持')
    return source.replace(pattern, '$1' + JSON.stringify(alias))
  }
  async resolvePlugin(dir) {
    const record = Object.values(this.state.installed).find(r => r.dir === dir)
    if (!record) return { ok: false, reason: 'module-not-installed' }
    try {
      if (!record.hostVersions?.includes(this.hostVersion)) return { ok:false,reason:'模块尚未确认适配当前 DSH；请检查兼容更新' }
      const root = join(this.root, 'slots', record.slot, 'packages', record.dir)
      const meta = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      const plugin = await import(pathToFileURL(insideEntry(root, meta.exports?.['.'] || meta.main)).href)
      return { ok: true, plugin }
    } catch (error) { return { ok: false, reason: error.message } }
  }
  async artifact(row, release, target) {
    const file = join(this.root, 'cache', release.sha256 + '.lmod')
    mkdirSync(dirname(file), { recursive: true })
    let bytes = existsSync(file) ? readFileSync(file) : null
    if (!bytes || hash(bytes) !== release.sha256 || bytes.length !== release.bytes) {
      bytes = await fetchBytes(release.url, { fetchImpl: this.fetchImpl, limit: MAX_ARCHIVE, expectedBytes: release.bytes, signal: this.abort.signal, asset: true })
      if (hash(bytes) !== release.sha256) throw Error('发行包校验失败')
      if (this.closed) throw Error('更新服务已停止')
      writeFileSync(file, bytes)
    }
    return unpackModule(bytes, row, release, target)
  }
  async install(id, version) {
    const row = this.catalog.modules.find(p => p.id === id && !p.hidden && !p.retired)
    const release = this.release(row, version), old = this.state.installed[id]
    if (old && compareVersions(version, old.version) <= 0) throw Error('已安装此版本或更新版本；降级请使用回退')
    if (old && old.dataSchema !== release.dataSchema) throw Error('此更新改变数据格式，需要专门的迁移版本')
    const slot = randomUUID(), target = join(this.root, 'slots', slot)
    const done = new Map(), visiting = new Set()
    try {
      const extract = async (row, r) => {
        if (done.has(row.id)) { if (done.get(row.id)!==r.version) throw Error('模块依赖版本冲突'); return }
        if (visiting.has(row.id)) throw Error('模块依赖形成循环')
        visiting.add(row.id)
        for (const dep of r.dependencies) {
          const item = this.catalog.modules.find(p => p.id === dep.id)
          await extract(item, this.release(item, dep.version))
        }
        this.job.phase = 'downloading'; await this.artifact(row, r, target)
        visiting.delete(row.id); done.set(row.id, r.version)
      }
      await extract(row, release)
      this.assertIdle(); this.job.phase = 'applying'
      const record = { id, dir: row.dir, entry: row.entry, version, sha256: release.sha256, slot, hostVersions:release.hostVersions, dataSchema: release.dataSchema, spec: row, dependencies: release.dependencies, previous: old ? { ...old, previous: undefined } : null }
      const next = { ...this.state, installed: { ...this.state.installed, [id]: record } }
      const wasEnabled = this.modules?.enabled(id) === true
      if (wasEnabled) await this.modules.suspend(id)
      const before = this.state; this.state = next
      try {
        if (wasEnabled) { const result = await this.modules.resume(id); if (!result.ok) throw Error(result.reason || '模块启动失败') }
        if (this.closed) throw Error('更新服务已停止')
        atomicJson(this.file, next)
      } catch (error) {
        if (wasEnabled) await this.modules.suspend(id)
        this.state = before
        if (wasEnabled && !this.closed) await this.modules.resume(id)
        throw error
      }
    } catch (error) { rmSync(target, { recursive: true, force: true }); throw error }
  }
  async remove(id) {
    if (!this.state.installed[id]) throw Error('模块尚未安装')
    this.assertIdle()
    const before = this.state, wasEnabled = this.modules?.enabled(id) === true
    const next = { ...before, installed: { ...before.installed } }; delete next.installed[id]
    if (wasEnabled) await this.modules.suspend(id)
    try { this.modules?.forget(id); atomicJson(this.file, next); this.state = next }
    catch (error) { if (wasEnabled) { this.modules?.remember?.(id); await this.modules.resume(id) } throw error }
    // Retained immutable slots are rollback material, never active after removal.
  }
  async rollback(id) {
    const old = this.state.installed[id], previous = old?.previous
    if (!previous || previous.dataSchema !== old.dataSchema || !previous.hostVersions?.includes(this.hostVersion)) throw Error('没有适配当前宿主且可安全回退的版本')
    this.assertIdle()
    const enabled = this.modules?.enabled(id), before = this.state
    if (enabled) await this.modules.suspend(id)
    this.state = { ...before, installed: { ...before.installed, [id]: { ...previous, previous: { ...old, previous: undefined } } } }
    try {
      if (enabled) { const result = await this.modules.resume(id); if (!result.ok) throw Error(result.reason) }
      atomicJson(this.file, this.state)
    } catch (error) { if (enabled) await this.modules.suspend(id); this.state = before; if (enabled) await this.modules.resume(id); throw error }
  }
  /** Migration archives carry vendored modules solely for existing installations. */
  async adoptLegacy() {
    if (this.state.migrated || !existsSync(join(this.bundledRoot, 'packages'))) return
    await this.exclusive(async () => {
      if (this.state.migrated) return
      const installed = { ...this.state.installed }
      for (const row of this.fallbackSpecs) {
        if (installed[row.id]) continue
        const source = join(this.bundledRoot, 'packages', row.dir)
        if (!existsSync(join(source, 'package.json'))) continue
        const slot = randomUUID(), root = join(this.root, 'slots', slot), meta = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
        const copy = (source, target) => cpSync(source, target, { recursive: true, dereference: true, filter: path => !relative(source,path).split(/[\\/]/).includes('node_modules') })
        copy(source, join(root, 'packages', row.dir))
        for (const dep of ['laurel-core']) if (existsSync(join(this.bundledRoot, 'packages', dep))) copy(join(this.bundledRoot, 'packages', dep), join(root, 'packages', dep))
        installed[row.id] = { id: row.id, dir: row.dir, entry: row.entry, version: meta.version, sha256: hash(Buffer.from(row.id + '@' + meta.version + ':legacy')), slot, hostVersions: this.hostVersion ? [this.hostVersion] : [...SUPPORTED_HOST_VERSIONS], dataSchema: 1, spec: row, previous: null, adopted: true }
      }
      const oldSwitches = join(this.dataPaths.dir, 'modules.json'), newSwitches = join(this.root, 'modules.json')
      if (!existsSync(newSwitches) && existsSync(oldSwitches)) cpSync(oldSwitches, newSwitches, { errorOnExist: true, force: false })
      const next = { schema: 1, installed, migrated: true }; atomicJson(this.file, next); this.state = next
    })
  }
  async centerUpdate(version) {
    this.assertIdle()
    const row = this.catalog.center, release = this.release(row, version), manager = this.getManager()
    if (compareVersions(version, VERSION) <= 0) throw Error('当前控制中心已是此版本或更新版本')
    if (!manager?.installBundle || !manager?.listBundles) throw Error('宿主未提供原生安装事务')
    const bundle = (await manager.listBundles()).find(b => b.name === 'laurel-center' && b.installed)
    if (!bundle || bundle.readOnlyReason) throw Error('此安装不允许由控制中心自行更新')
    if (bundle.version !== VERSION) throw Error('磁盘版本与运行版本不同，请先重启 DSH')
    this.job.phase = 'downloading'
    const bytes = await fetchBytes(release.url, { fetchImpl: this.fetchImpl, limit: MAX_ARCHIVE, expectedBytes: release.bytes, signal: this.abort.signal, asset: true })
    if (hash(bytes) !== release.sha256) throw Error('控制中心安装包校验失败')
    this.assertIdle()
    const file = join(this.root, 'center-' + release.sha256 + '.tgz'); writeFileSync(file, bytes)
    this.job.phase = 'applying'; this.installRequest = randomUUID()
    const result = await manager.installBundle(file, { enabled: bundle.enabled, requestId: this.installRequest })
    if (!['applied', 'restart-required'].includes(result?.application) || result.bundle !== 'laurel-center') throw Error(result?.error?.diagnostic || '原生安装事务未确认成功，请到 DSH 插件页检查')
    const actual = (await manager.listBundles()).find(b => b.name === 'laurel-center' && b.installed)
    if (actual?.version !== version) throw Error('安装版本与目标不一致，请到 DSH 插件页检查')
    this.job.phase = 'restart-required'; this.job.targetVersion = version
    atomicJson(join(this.root, 'center-receipt.json'), { version, at: this.now() })
  }
  start(action, id, version) {
    if (this.initializationError) throw Error(this.initializationError)
    if (this.activeJob || this.closed) throw Error('安装事务正在进行或服务已停止')
    if (!['install', 'update', 'remove', 'rollback', 'update-all', 'center-update'].includes(action)) throw Error('不支持的操作')
    if (action !== 'update-all' && !validId(id)) throw Error('模块标识无效')
    this.job = { phase: 'checking', action, id, error: '' }
    this.activeJob = this.exclusive(async () => {
      this.assertIdle()
      if (['install', 'update', 'update-all', 'center-update'].includes(action)) await this.check(true)
      if (action === 'center-update') await this.centerUpdate(version)
      else if (action === 'remove') await this.remove(id)
      else if (action === 'rollback') await this.rollback(id)
      else if (action === 'update-all') {
        const failed = []
        for (const row of this.snapshot().modules.filter(p => p.installed && p.updateAvailable && !p.retired)) {
          try { this.job.id = row.id; await this.install(row.id, row.latestVersion) } catch (error) { failed.push(row.title.zh + '：' + error.message) }
        }
        if (failed.length) throw Error(failed.join('；'))
      } else await this.install(id, version)
      if (this.job.phase !== 'restart-required') this.job.phase = 'completed'
    }).catch(error => { this.job.phase = 'failed'; this.job.error = error.message }).finally(() => { this.activeJob = null; this.installRequest = null })
    return this.snapshot()
  }
  startChecks() {
    void this.check()
    this.timer = setInterval(() => { void this.check() }, 60000); this.timer.unref?.()
  }
  close() {
    this.closed = true; this.abort.abort(); clearInterval(this.timer)
    if (this.installRequest) void this.getManager()?.cancelInstall?.(this.installRequest).catch(() => {})
  }
}
