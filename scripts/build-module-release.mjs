#!/usr/bin/env node
/** Deterministic archives. Publishing is a separate, deliberate operation. */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync, cpSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { SUB_PLUGINS } from '../lib/registry.js'
import { SUPPORTED_HOST_VERSIONS } from '../lib/host-compat.js'
import { validateCatalog } from '../lib/module-catalog.js'
import { unpackModule } from '../lib/module-store.js'
import { externalOutput } from './private-output.mjs'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
const json = path => JSON.parse(readFileSync(path, 'utf8'))
export function seedCatalog() {
  return { schema: 1, center: { id: 'laurel-center', dir: 'laurel-center', entry: 'laurel-center', settingsId: 'laurel-center', category: 'foundation', title: { zh: 'Laurel 控制中心', en: 'Laurel Center' }, desc: { zh: '模块商店、开关与独立更新。', en: 'Module store, switches and independent updates.' }, releases: [] }, modules: [...SUB_PLUGINS.map(p => ({ ...p, releases: [] })), { id: 'laurel-core', dir: 'laurel-core', entry: 'laurel-core', settingsId: 'laurel-core', category: 'foundation', hidden: true, title: { zh: 'Laurel 公共库', en: 'Laurel Core' }, desc: { zh: '随模块自动安装的共享代码。', en: 'Shared code installed with dependent modules.' }, releases: [] }] }
}
export function moduleArchive(row, root = ROOT) {
  const base = join(root, 'packages', row.dir), pkg = json(join(base, 'package.json')), files = []
  const add = rel => {
    const path = join(base, rel), stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw Error('Release inputs must not contain links: ' + path)
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) add(rel + '/' + name); return }
    if (!stat.isFile() || /(?:\.map|\.bak|\.tmp)$/.test(rel) || /(^|\/)(?:node_modules|tests?|__tests__)(\/|$)/.test(rel)) return
    let data = readFileSync(path)
    if (rel === 'package.json') { const clean = { ...pkg }; delete clean.scripts; delete clean.devDependencies; delete clean.workspaces; data = Buffer.from(JSON.stringify(clean, null, 2) + '\n') }
    files.push({ path: 'packages/' + row.dir + '/' + rel, data: data.toString('base64') })
  }
  for (const rel of ['package.json', 'lib', 'locale', 'icon.svg', 'README.md', 'LICENSE', 'THIRD-PARTY.md']) if (existsSync(join(base, rel))) add(rel)
  files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const bytes = gzipSync(Buffer.from(JSON.stringify({ schema: 1, id: row.id, version: pkg.version, files })), { level: 9 })
  return { bytes, version: pkg.version, dependencies: pkg.laurel?.dependencies || (['laurel-memory','laurel-context'].includes(row.dir) ? [{ id: 'laurel-core', version: json(join(root,'packages/laurel-core/package.json')).version }] : []) }
}
export function buildRelease(out, { root = ROOT, published = false, centerFile, previousCatalog, tag } = {}) {
  out = externalOutput(out); mkdirSync(out, { recursive: true })
  const catalog = seedCatalog(), pkg = json(join(root,'package.json')), previous = previousCatalog ? validateCatalog(previousCatalog) : null
  tag ||= 'v' + pkg.version
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(tag))throw Error('Invalid release tag')
  const merge=(row,r)=>{
    const before=[previous?.center,...(previous?.modules||[])].find(p=>p?.id===row.id)
    if(before&&(before.dir!==row.dir||before.entry!==row.entry))throw Error('Stable module identity cannot change: '+row.id)
    const same=before?.releases.find(old=>old.version===r.version)
    // `hostVersions` 是**可增长的**：同一个已发布产物在新宿主上验过之后，给它补一条适配记录，
    // 不需要（也不应该）重发版本 —— 重发会换掉 sha256，让已经装好的用户对不上账。
    // 其余字段一旦改了就说明产物本身变了，必须升独立版本号。
    if(same&&['sha256','bytes','dependencies','centerApi','dataSchema'].some(key=>JSON.stringify(same[key])!==JSON.stringify(r[key])))throw Error('Published version changed; bump its independent version: '+row.id+'@'+r.version)
    if(same&&!same.hostVersions.every(v=>r.hostVersions.includes(v)))throw Error('A published release must not drop a host version: '+row.id+'@'+r.version)
    if(same)r.hostVersions=[...new Set([...r.hostVersions,...same.hostVersions])]
    row.releases=[same||r,...(before?.releases||[]).filter(old=>old.version!==r.version)]
  }
  const release = (file, version, bytes, dependencies = []) => ({ version, url: 'https://github.com/Sakayorilove/dsh-Laurel/releases/download/' + tag + '/' + file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, hostVersions: [...SUPPORTED_HOST_VERSIONS], centerApi: 1, dataSchema: 1, dependencies, published, notes: '' })
  for (const row of catalog.modules) {
    const artifact = moduleArchive(row,root), file = row.id + '-' + artifact.version + '.lmod'
    writeFileSync(join(out,file),artifact.bytes); merge(row,release(file,artifact.version,artifact.bytes,artifact.dependencies))
  }
  if (centerFile) { const bytes = readFileSync(centerFile), file = 'laurel-center-' + pkg.version + '.tgz'; if (resolve(centerFile) !== join(out,file)) writeFileSync(join(out,file),bytes); merge(catalog.center,release(file,pkg.version,bytes)) }
  else if(previous)catalog.center.releases=previous.center.releases
  for(const row of previous?.modules||[])if(!catalog.modules.some(p=>p.id===row.id))catalog.modules.push({...row,retired:true})
  validateCatalog(catalog)
  writeFileSync(join(out,'release-catalog.json'),JSON.stringify(catalog,null,2)+'\n')
  return catalog
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key)+1]
  if (args.includes('--seed')) writeFileSync(join(ROOT,'release-catalog.json'), JSON.stringify(seedCatalog(),null,2)+'\n')
  else {
    if (!args.includes('--output')) throw Error('Use --output <private release directory>')
    const out = externalOutput(value('--output'))
    if (existsSync(out)) throw Error('Output must be a fresh directory')
    mkdirSync(out,{recursive:true})
    const previousCatalog=args.includes('--previous')?json(resolve(value('--previous'))):undefined,tag=args.includes('--tag')?value('--tag'):undefined
    if(args.includes('--modules-only')){
      if(!previousCatalog||!tag)throw Error('--modules-only requires --previous <verified catalog> and --tag <new immutable tag>')
      buildRelease(out,{previousCatalog,tag});console.log(JSON.stringify({out,modulesOnly:true,published:false}));process.exit(0)
    }
    const pack = spawnSync('pnpm',['pack','--pack-destination',out,'--skip-manifest-obfuscation'],{cwd:ROOT,encoding:'utf8'})
    if (pack.status !== 0) throw Error(pack.stderr || pack.stdout)
    const pkg = json(join(ROOT,'package.json')), centerFile = join(out,'laurel-center-'+pkg.version+'.tgz')
    buildRelease(out,{centerFile,previousCatalog,tag})
    const migration = join(out,'migration-source'); mkdirSync(migration)
    for (const rel of ['lib','locale','cordis.patch.yml','icon.svg','README.md','LICENSE','THIRD-PARTY.md','release-catalog.json']) cpSync(join(ROOT,rel),join(migration,rel),{recursive:true})
    const candidates = json(join(out,'release-catalog.json'))
    for (const row of candidates.modules.filter(r=>seedCatalog().modules.some(s=>s.id===r.id))) { const r=row.releases[0];unpackModule(readFileSync(join(out,row.id+'-'+r.version+'.lmod')),row,r,migration) }
    writeFileSync(join(migration,'package.json'),JSON.stringify({...pkg,files:[...pkg.files,'packages'],scripts:{}},null,2)+'\n')
    const migrationOut = join(out,'migration');mkdirSync(migrationOut)
    const legacy = spawnSync('pnpm',['pack','--pack-destination',migrationOut,'--skip-manifest-obfuscation'],{cwd:migration,encoding:'utf8'})
    if (legacy.status !== 0) throw Error(legacy.stderr || legacy.stdout)
    const migrationFile=join(migrationOut,'laurel-center-migration-'+pkg.version+'.tgz')
    renameSync(join(migrationOut,'laurel-center-'+pkg.version+'.tgz'),migrationFile)
    console.log(JSON.stringify({out,centerFile,migration:migrationFile,catalog:join(out,'release-catalog.json'),published:false},null,2))
  }
}
