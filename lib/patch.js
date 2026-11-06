/**
 * Laurel-Center · 读「用户层」写了什么（第二轮 F1 的地基）
 *
 * ── 为什么必须读用户层 ────────────────────────────────────────────────────
 * 一次性迁移要把旧 state.json 里「用户点过开」的意图带进新版本。旧版有个致命假设：
 * 「宿主说 disabled:false 就是用户没表态（默认值）」。第二轮实测证明它是错的 ——
 * 用户可以在 profile 的 `cordis.patch.yml` 里**显式**写 `disabled: true`，
 * 那时宿主报的 enabled 同样是 false。两者混在一起，迁移就会把用户的明确关闭改回打开。
 *
 * 所以迁移前必须知道：**用户层里到底有没有针对这个 id 的显式条目**。
 *
 * ── 为什么用宿主自己的 yaml 解析器 ────────────────────────────────────────
 * `cordis.patch.yml` 由宿主用 `yaml` 包写成 YAML 序列（见 asar 里
 * `dsh-plugin-manager` 的 `writePluginEnabled`）。自己手写解析器就有第二套语义，
 * 迟早和宿主漂移。做法：从 `profileContext.installAnchor`（宿主自己的 package.json）
 * 起 `createRequire` 解析宿主已安装的 `yaml` —— 解析器和宿主**同一份**。
 *
 * 拿不到 `yaml`（宿主换安装方式 / 缺依赖）时不静默当「没有 override」：
 * 退回一个**保守的行扫描**，只认「顶层序列项里的 `id:` / `disabled:`」这一种形状，
 * 并把 `source` 标成 `'scanner'` 让上层知道证据等级更低。
 *
 * ── 读不到就说不确定 ──────────────────────────────────────────────────────
 * 文件不存在 ≠ 有 override。读文件报错（权限 / IO）返回 `ok:false`，
 * 上层据此**放弃自动迁移**（而不是当成「没有 override」继续写用户层）。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'

/**
 * 用宿主自己的 `yaml` 解析一个 patch 文件。
 * @returns {{ ok: true, entries: any[] } | { ok: false, error: string }}
 */
function parseWithHostYaml(text, installAnchor) {
  try {
    if (typeof installAnchor !== 'string' || installAnchor.length === 0) {
      return { ok: false, error: 'no-install-anchor' }
    }
    const requireFromHost = createRequire(installAnchor)
    const yaml = requireFromHost('yaml')
    const parse = typeof yaml?.parse === 'function' ? yaml.parse : yaml?.default?.parse
    if (typeof parse !== 'function') return { ok: false, error: 'yaml-module-shape' }
    const doc = parse(text)
    if (doc === null || doc === undefined) return { ok: true, entries: [] }
    if (!Array.isArray(doc)) return { ok: false, error: 'not-a-sequence' }
    return { ok: true, entries: doc }
  } catch (error) {
    return { ok: false, error: `yaml-unavailable: ${String(error?.message ?? error)}` }
  }
}

/**
 * 保守的行扫描（只在拿不到宿主 yaml 时用）。
 *
 * 用缩进栈区分**顶层序列项**和 `insert:` 块里的**嵌套行**：
 *   - 顶层项（缩进 0 的 `- …`）才是「用户对某一行的表态」
 *   - `insert:` 下面的行缩进更深，属于 bundle 在**声明行**，不是用户表态
 * 这个区分是 F1 的关键：bundle patch 用 `insert:` 声明五个行，
 * 用户 patch 用顶层条目覆盖它们，两者混在一起就会把「默认关闭」误当「用户关闭」。
 *
 * @returns {{ entries: Array<object>, rows: Array<object> }}
 */
function parseWithScanner(text) {
  const all = []
  const stack = []
  const lines = String(text).split(/\r?\n/)
  for (const raw of lines) {
    if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) continue
    const indent = raw.replace(/\t/g, '  ').match(/^\s*/)[0].length
    const body = raw.trim()

    const item = /^-\s*(.*)$/.exec(body)
    if (item) {
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      const parent = stack.length > 0 ? stack[stack.length - 1] : null
      const entry = { indent, parent, id: undefined, disabled: undefined, insert: undefined }
      all.push(entry)
      stack.push(entry)
      if (item[1].length > 0) applyKey(entry, item[1])
      continue
    }

    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(body)
    if (!kv) continue
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    const owner = stack.length > 0 ? stack[stack.length - 1] : null
    if (owner !== null) applyKey(owner, body)
  }

  const shape = (e) => ({
    id: e.id,
    disabled: e.disabled,
    hasInsert: e.insert !== undefined,
    nested: e.parent !== null,
  })
  return {
    entries: all.filter((e) => e.parent === null).map(shape),
    rows: all.filter((e) => e.parent !== null).map(shape),
  }
}

/** 把一行 `key: value` 塞进当前条目。 */
function applyKey(entry, text) {
  const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(text)
  if (!m) return
  const key = m[1]
  const value = stripInlineComment(m[2]).trim()
  if (key === 'disabled') {
    if (value === 'true') entry.disabled = true
    else if (value === 'false') entry.disabled = false
    return
  }
  if (key === 'insert') { entry.insert = true; return }
  if (key === 'id') entry.id = unquote(value)
}

/** 去掉行内注释（不处理引号内的 `#`，保守即可）。 */
function stripInlineComment(value) {
  const idx = value.indexOf('#')
  if (idx < 0) return value
  return value.slice(0, idx)
}

function unquote(value) {
  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  return v
}

/**
 * 读一个 patch 文件里的**顶层显式条目**。
 *
 * @param {string} patchPath
 * @param {{ installAnchor?: string, readFile?: (p: string, enc: string) => string, exists?: (p: string) => boolean }} [options]
 * @returns {{
 *   ok: boolean, present: boolean, source: 'yaml'|'scanner'|null,
 *   entries: Array<{ id: string, disabled?: boolean, hasInsert: boolean }>,
 *   rows: Array<{ id: string, disabled?: boolean, hasInsert: boolean, nested: boolean }>,
 *   error: string | null,
 * }}
 *   `ok:false` 表示**读不了 / 解析不了**，上层不许把它当「没有 override」。
 *   `present:false` 且 `ok:true` 才是「文件不存在 = 没有用户层」。
 *   ⚠ `entries` 与 `rows` **永远存在**（不是「存在时才有」）：调用方普遍写
 *   `[...patch.entries, ...patch.rows]`，少一个键就是一个 TypeError。
 *   实测（2026-10-13，第四轮 R7）：安装面缺 `cordis.patch.yml` 时，
 *   `assembly-check.mjs` 在这一行抛 `loaderPatch.rows is not iterable`，
 *   安装事务**在回滚之前就整个崩掉** —— 比「校验报失败」严重得多。
 */
export function readPatchFile(patchPath, options = {}) {
  const readFile = options.readFile ?? readFileSync
  const exists = options.exists ?? existsSync
  if (typeof patchPath !== 'string' || patchPath.length === 0) {
    return { ok: true, present: false, source: null, entries: [], rows: [], error: null }
  }
  if (!exists(patchPath)) {
    return { ok: true, present: false, source: null, entries: [], rows: [], error: null }
  }
  let text
  try {
    text = readFile(patchPath, 'utf8')
  } catch (error) {
    return { ok: false, present: true, source: null, entries: [], rows: [], error: `read-failed: ${String(error?.message ?? error)}` }
  }

  const viaHost = parseWithHostYaml(text, options.installAnchor)
  let rawEntries
  let rawRows
  let source
  if (viaHost.ok) {
    const expanded = expandHostEntries(viaHost.entries)
    rawEntries = expanded.top
    rawRows = expanded.rows
    source = 'yaml'
  } else {
    const scanned = parseWithScanner(text)
    rawEntries = scanned.entries
    rawRows = scanned.rows
    source = 'scanner'
  }
  return {
    ok: true,
    present: true,
    source,
    entries: normalizeEntries(rawEntries, false),
    rows: normalizeEntries(rawRows, true),
    error: viaHost.ok ? null : viaHost.error,
  }
}

/**
 * 宿主 yaml 解析出来的顶层数组里，`insert:` 是**容器**：
 * 它下面的行要摊平到 `rows`，这样「顶层条目（用户表态）」和
 * 「insert 里的行（bundle 声明）」两种来源在两条通道下形状一致。
 */
function expandHostEntries(entries) {
  const top = []
  const rows = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const insert = entry.insert
    if (Array.isArray(insert)) {
      top.push(entry)
      for (const row of insert) {
        if (row !== null && typeof row === 'object' && !Array.isArray(row)) rows.push({ ...row, nested: true })
      }
    } else if (insert !== null && typeof insert === 'object') {
      top.push(entry)
      rows.push({ ...insert, nested: true })
    } else {
      top.push(entry)
    }
  }
  return { top, rows }
}

/** 把条目规整成 `{ id, disabled, hasInsert, nested }`；丢掉没有 id 的（如纯 `insert:` 容器）。 */
function normalizeEntries(list, nestedDefault) {
  const out = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const id = typeof entry.id === 'string' ? entry.id : null
    if (id === null) continue
    out.push({
      id,
      disabled: typeof entry.disabled === 'boolean' ? entry.disabled : undefined,
      hasInsert: entry.insert !== undefined,
      nested: typeof entry.nested === 'boolean' ? entry.nested : nestedDefault,
    })
  }
  return out
}

/**
 * 汇总若干 patch 文件，得到「哪些 id 被用户层显式表态过」。
 *
 * 只有**顶层**条目算显式表态：带 `insert:` 的条目是 bundle 在声明行，
 * 不是用户对某一行的决定。
 *
 * @param {string[]} patchPaths 用户层文件（profile 的 cordis.patch.yml、home 的同名文件…）
 * @param {{ installAnchor?: string, readFile?: Function, exists?: Function }} [options]
 * @returns {{
 *   ok: boolean, sources: Array<{ path: string, ok: boolean, present: boolean, source: string|null, error: string|null }>,
 *   overrides: Record<string, { disabled: boolean | undefined, from: string }>,
 *   error: string | null,
 * }}
 */
export function readUserOverrides(patchPaths, options = {}) {
  const paths = Array.isArray(patchPaths) ? patchPaths.filter((p) => typeof p === 'string' && p.length > 0) : []
  const sources = []
  const overrides = {}
  let ok = true
  for (const path of paths) {
    const result = readPatchFile(path, options)
    sources.push({ path, ok: result.ok, present: result.present, source: result.source, error: result.error })
    if (!result.ok) { ok = false; continue }
    for (const entry of result.entries) {
      if (entry.hasInsert) continue // bundle 声明行，不是用户表态
      if (Object.prototype.hasOwnProperty.call(overrides, entry.id)) continue
      overrides[entry.id] = { disabled: entry.disabled, from: path }
    }
  }
  return { ok, sources, overrides, error: ok ? null : 'user-layer-unreadable' }
}

/** 只回答一个问题：这个 id 在用户层里有没有显式条目。 */
export function hasExplicitOverride(overrides, id) {
  return Boolean(overrides) && Object.prototype.hasOwnProperty.call(overrides, id)
}
