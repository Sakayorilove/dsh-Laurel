/** Official Laurel release catalog. No profile or user content is sent. */
export const CATALOG_URL = 'https://raw.githubusercontent.com/Sakayorilove/dsh-Laurel/main/release-catalog.json'

export const CENTER_API = 1
export const CHECK_INTERVAL = 6 * 60 * 60 * 1000
export const validId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 120) throw Error('版本号无效')
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value)
  if (!m || m[4]?.split('.').some(x => /^0\d+$/.test(x))) throw Error('版本号无效')
  return { core: m.slice(1, 4).map(BigInt), pre: m[4]?.split('.') || [] }
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b), cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0
  for (let i = 0; i < 3; i++) { const c = cmp(x.core[i], y.core[i]); if (c) return c }
  if (!x.pre.length || !y.pre.length) return cmp(!x.pre.length, !y.pre.length)
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const a = x.pre[i], b = y.pre[i]
    if (a === undefined || b === undefined) return cmp(a !== undefined, b !== undefined)
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b)
    const c = an && bn ? cmp(BigInt(a), BigInt(b)) : an !== bn ? (an ? -1 : 1) : cmp(a, b)
    if (c) return c
  }
  return 0
}
export function officialAsset(value) {
  const u = new URL(value)
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password || u.search || u.hash || !u.pathname.startsWith('/Sakayorilove/dsh-Laurel/releases/download/') || u.pathname.includes('..')) throw Error('发行包地址不属于 Laurel 官方发布源')
  return u.href
}
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2000
function bilingual(value) {
  if (!value || !text(value.zh) || !text(value.en)) throw Error('模块文案无效')
  return { zh: value.zh, en: value.en }
}
/** Validate remote data before it becomes a path, identifier or download request. */
export function validateCatalog(value, assetPolicy = officialAsset) {
  if (value?.schema !== 1 || !Array.isArray(value.modules) || value.modules.length > 200) throw Error('模块目录格式不受支持')
  const ids = new Set(), names = new Set()
  const item = (row, center = false) => {
    if (!validId(row?.id) || ids.has(row.id) || !validId(row.dir) || !validId(row.entry) || names.has(row.entry) || !validId(row.settingsId)) throw Error('模块标识无效或重复')
    ids.add(row.id); names.add(row.entry)
    if (center ? row.id !== 'laurel-center' : row.id === 'laurel-center') throw Error('控制中心标识冲突')
    if (!['experience', 'continuity', 'execution', 'foundation'].includes(row.category)) throw Error('模块分类无效')
    const versions = new Set()
    if (!Array.isArray(row.releases) || row.releases.length > 100) throw Error('发行记录无效')
    const releases = row.releases.map(r => {
      parseVersion(r.version)
      if (versions.has(r.version) || !/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.bytes) || r.bytes <= 0 || r.bytes > 32 * 1024 * 1024 || r.centerApi !== CENTER_API || !Array.isArray(r.hostVersions) || !r.hostVersions.length || r.hostVersions.length > 30) throw Error('发行记录无效')
      versions.add(r.version); r.hostVersions.forEach(parseVersion)
      const dependencies = r.dependencies || []
      if (!Array.isArray(dependencies) || dependencies.length > 20 || dependencies.some(d => !validId(d.id) || !d.version)) throw Error('模块依赖无效')
      dependencies.forEach(d => parseVersion(d.version))
      return { version: r.version, sha256: r.sha256, bytes: r.bytes, url: assetPolicy(r.url), centerApi: r.centerApi, hostVersions: [...r.hostVersions], dependencies: dependencies.map(d => ({ id: d.id, version: d.version })), notes: typeof r.notes === 'string' ? r.notes.slice(0, 4000) : '', dataSchema: Number.isSafeInteger(r.dataSchema) && r.dataSchema >= 0 ? r.dataSchema : 1, published: r.published === true }
    }).sort((a, b) => compareVersions(b.version, a.version))
    return { id: row.id, dir: row.dir, entry: row.entry, clientId: row.entry, settingsId: row.settingsId, title: bilingual(row.title), desc: bilingual(row.desc), summary: bilingual(row.summary || row.desc), scope: bilingual(row.scope || row.desc), category: row.category, order: Number.isFinite(row.order) ? row.order : 100, saveMode: ['instant','apply','read-only'].includes(row.saveMode) ? row.saveMode : 'instant', defaultOn: false, hidden: row.hidden === true, retired: row.retired === true, releases }
  }
  const center = item(value.center, true), modules = value.modules.map(row => item(row))
  for (const row of [center,...modules]) for (const release of row.releases) for (const dep of release.dependencies) {
    const library=modules.find(r=>r.id===dep.id&&r.hidden)
    if (!library?.releases.some(r=>r.version===dep.version)) throw Error('模块依赖必须指向目录中已声明的公共库版本')
  }
  return { schema: 1, center, modules }
}
export function compatibleRelease(row, hostVersion, { publishedOnly = true } = {}) {
  return row?.releases?.find(r => (!publishedOnly || r.published) && r.hostVersions.includes(hostVersion) && !parseVersion(r.version).pre.length) || null
}
/** Download with bounded memory, time and approved redirect destinations. */
export async function fetchBytes(url, { fetchImpl = globalThis.fetch, limit, signal, expectedBytes, timeout = 30000, asset = false } = {}) {
  const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)])
  let target = url
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await fetchImpl(target, { signal: abort, redirect: 'manual', headers: { Accept: 'application/octet-stream', 'User-Agent': 'Laurel-Update' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get('location'), target)
      await response.body?.cancel()
      if (!asset || next.protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname) || next.username || next.password || next.port) throw Error('不受信任的下载跳转')
      target = next.href; continue
    }
    if (!response.ok) { await response.body?.cancel(); throw Error('下载失败 HTTP ' + response.status) }
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw Error('下载文件超过限制') }
    const chunks = []; let size = 0
    for await (const chunk of response.body || []) { size += chunk.length; if (size > limit) throw Error('下载文件超过限制'); chunks.push(chunk) }
    if (!size || expectedBytes !== undefined && size !== expectedBytes) throw Error('下载文件不完整')
    return Buffer.concat(chunks)
  }
  throw Error('下载跳转次数过多')
}
