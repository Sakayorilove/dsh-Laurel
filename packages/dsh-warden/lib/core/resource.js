/**
 * dsh-warden · 规范资源身份（R4 的地基）
 *
 * ── 为什么锁不能只按"锁名"判 ───────────────────────────────────────────
 * 评审已复现：两把**名字不同**的锁可以同时覆盖**同一条路径**，于是
 * `acquire_lock('build-a', path:X)` 和 `acquire_lock('build-b', path:X)`
 * 双双成功 —— 互斥形同虚设。根因是锁的身份是"名字"，而资源的身份是
 * "它到底是哪一个东西"。名字可以随便取，资源不行。
 *
 * 所以这里先把一切归一成 `resourceId`，锁与冲突判定一律只看它：
 *
 *   `path:<canonical>`          文件系统资源（含父子关系）
 *   `named:desktop:input`       真实桌面输入（鼠标/键盘）—— 全机唯一
 *   `named:display-mode`        显示模式 —— 全机唯一
 *   `named:deployment:<target>` 某个部署目标
 *   `named:port:<n>`            某个端口
 *   `named:workspace:<root>`    某个工作区根
 *
 * ── 跨平台：可以合并的才合并，合并了要能说清 ───────────────────────────
 * 本机的实际情况是同一片文件被两种拼法访问：Windows 侧 `D:\<WORKSPACE>\...`、
 * WSL 侧 `/mnt/d/<WORKSPACE>/...`。它们是**同一批字节**，判成两个资源就等于没锁。
 * 但评审也明确要求「不武断跨平台合并」—— 所以：
 *   - 只合并**标准 drvfs 挂载**这一种可判定的形态（`/mnt/<单字母盘>/<rest>` ↔ `<盘>:/<rest>`）；
 *   - 合并后 id 里带上平台前缀，看 id 就知道它被归成了哪一类；
 *   - 归一不出来的（相对路径但没有 cwd、`~` 打头、命令字符串里挖出来的碎片、
 *     非标准挂载）一律 `resolvable:false` 并给出原因，**由调用方明确标"未覆盖"**，
 *     绝不猜一个 id 出来假装锁住了。
 */

import { isAbsolute, resolve, sep } from 'node:path'
import { normalizePath } from './config.js'

/** 已知的命名资源类型。值参与身份的写在 `withValue` 里。 */
const NAMED_KINDS = {
  'desktop-input': { id: 'named:desktop:input', withValue: false, label: '真实桌面输入（鼠标/键盘）' },
  'desktop': { id: 'named:desktop:input', withValue: false, label: '真实桌面输入（鼠标/键盘）' },
  'display-mode': { id: 'named:display-mode', withValue: false, label: '显示模式' },
  'display': { id: 'named:display-mode', withValue: false, label: '显示模式' },
  deployment: { prefix: 'named:deployment', withValue: true, label: '部署目标' },
  deploy: { prefix: 'named:deployment', withValue: true, label: '部署目标' },
  port: { prefix: 'named:port', withValue: true, label: '端口' },
  workspace: { prefix: 'named:workspace', withValue: true, label: '工作区根' },
}

/**
 * @typedef {object} ResourceId
 * @property {boolean} resolvable 归一成功了吗
 * @property {string} resourceId 规范身份（失败时为空串）
 * @property {string} kind 'path' | 'named' | ''
 * @property {string} path 归一后的路径（命名资源为空串）
 * @property {string} named 命名资源的类型（路径资源为空串）
 * @property {string} reason 归一失败的原因（成功时为空串）
 * @property {boolean} mergedCrossPlatform 是否发生了 Windows↔WSL 合并
 */

/** 归一失败的统一出口。 */
function unresolvable(reason) {
  return { resolvable: false, resourceId: '', kind: '', path: '', named: '', reason, mergedCrossPlatform: false }
}

/** 把 Windows 盘符路径归一成 `win:<盘>:/...`（小写、正斜杠、无尾斜杠）。 */
function canonicalWindows(value) {
  const match = /^([a-z]):[\\/](.*)$/i.exec(value)
  if (!match) return null
  const drive = match[1].toLowerCase()
  const rest = match[2].replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')
  return { id: `path:win:${drive}:/${rest.toLowerCase()}`, display: `${drive.toUpperCase()}:/${rest}` }
}

/** UNC 路径 `\\server\share\path` → `unc:server/share/path`。 */
function canonicalUnc(value) {
  const match = /^[/\\]{2}([^/\\]+)[/\\](.*)$/.exec(value)
  if (!match) return null
  const host = match[1].toLowerCase()
  const rest = match[2].replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase()
  return { id: `path:unc:${host}/${rest}`, display: `//${host}/${rest}` }
}

/**
 * WSL 路径。标准 drvfs 挂载 `/mnt/<盘>/...` 归一成对应的 Windows 身份
 * （它们是同一批字节）；其余 POSIX 路径归一成 `wsl:/...`。
 */
function canonicalPosix(value, mergeDrvfs) {
  const clean = value.replace(/\/+/g, '/').replace(/\/+$/, '') || '/'
  if (mergeDrvfs) {
    const drvfs = /^\/mnt\/([a-z])(\/.*)?$/i.exec(clean)
    if (drvfs) {
      const drive = drvfs[1].toLowerCase()
      // drvfs[2] 带着前导斜杠，直接拼会得到 `d://rest` 这种双斜杠身份，
      // 与 Windows 侧的 `d:/rest` 对不上 —— 必须先剥掉。
      const rest = (drvfs[2] ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
      return {
        id: `path:win:${drive}:/${rest.toLowerCase()}`,
        display: `/mnt/${drive}${rest}`,
        merged: true,
      }
    }
  }
  return { id: `path:wsl:${clean}`, display: clean }
}

/**
 * 把一个目标（路径或命名资源）归一成规范身份。
 *
 * @param {string} target 目标：绝对/相对路径，或 `desktop-input` / `deployment:web-host` 这类命名资源
 * @param {string} [cwd] 相对路径的工作区基准
 * @param {{mergeCrossPlatform?: boolean}} [options]
 * @returns {ResourceId}
 */
export function resolveResourceId(target, cwd = '', options = {}) {
  const merge = options.mergeCrossPlatform !== false
  const raw = typeof target === 'string' ? target.trim() : ''
  if (raw.length === 0) return unresolvable('目标为空')

  // ── ① 命名资源 ──
  const named = parseNamedResource(raw)
  if (named) return named

  // ── ② 明显不是路径的东西 ──
  if (raw.startsWith('~')) {
    // `~` 展开依赖用户环境，插件层不猜。
    return unresolvable(`以 ~ 开头的路径无法可靠归一（${raw.slice(0, 60)}）`)
  }
  if (/[\n\r]/.test(raw)) {
    return unresolvable('目标里含换行，像是命令片段而不是单个路径')
  }
  if (/\s/.test(raw) && !/^["'].*["']$/.test(raw)) {
    // 带空格且没被引号包住：很可能是从 shell 命令里挖出来的碎片。
    return unresolvable(`目标含空格，无法确定是单个路径（${raw.slice(0, 60)}）`)
  }
  const unquoted = raw.replace(/^["']|["']$/g, '')

  // ── ③ 相对路径：必须有 cwd 才能归一 ──
  const looksWindows = /^[a-z]:[\\/]/i.test(unquoted) || unquoted.startsWith('\\\\')
  const isPosixAbsolute = unquoted.startsWith('/')
  if (!looksWindows && !isPosixAbsolute && !isAbsolute(unquoted)) {
    const base = typeof cwd === 'string' ? cwd.trim() : ''
    if (!base) return unresolvable(`相对路径但拿不到 cwd（${unquoted.slice(0, 60)}）`)
    try {
      return finalize(resolve(base, unquoted), merge)
    } catch (error) {
      return unresolvable(`相对路径解析失败：${error?.message ?? error}`)
    }
  }

  return finalize(unquoted, merge)
}

function finalize(value, merge) {
  const normalized = normalizePath(value)
  if (!normalized) return unresolvable('归一后为空')

  if (normalized.startsWith('//')) {
    const unc = canonicalUnc(normalized)
    if (unc) return ok(unc, 'path', '', unc.merged ?? false)
    return unresolvable(`无法归一的 UNC 路径（${value.slice(0, 60)}）`)
  }
  if (/^[a-z]:\//i.test(normalized)) {
    const win = canonicalWindows(normalized)
    if (win) return ok(win, 'path', '', false)
    return unresolvable(`无法归一的 Windows 路径（${value.slice(0, 60)}）`)
  }
  if (normalized.startsWith('/')) {
    const posix = canonicalPosix(normalized, merge)
    return ok(posix, 'path', '', posix.merged ?? false)
  }
  // 走到这里说明是 Windows 侧的相对路径被 isAbsolute 认过但没有盘符（例如 `a\b`）。
  return unresolvable(`无法判定平台的路径（${value.slice(0, 60)}）`)
}

function ok(canonical, kind, named, merged) {
  return {
    resolvable: true,
    resourceId: canonical.id,
    kind,
    path: canonical.display,
    named,
    reason: '',
    mergedCrossPlatform: merged === true,
  }
}

/**
 * 解析 `desktop-input` / `display-mode` / `deployment:<target>` / `port:8080`
 * 这类命名资源。认不出来返回 null（交给路径分支）。
 */
export function parseNamedResource(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return null

  const [head, ...rest] = value.split(':')
  const key = head.trim().toLowerCase()
  const qualifier = rest.join(':').trim()
  const spec = NAMED_KINDS[key]
  if (!spec) return null

  if (spec.withValue) {
    if (!qualifier) {
      return {
        resolvable: false, resourceId: '', kind: '', path: '', named: key,
        reason: `命名资源 ${key} 缺少具体目标（应写成 ${key}:<目标>）`, mergedCrossPlatform: false,
      }
    }
    const id = `${spec.prefix}:${qualifier.toLowerCase().replace(/\s+/g, '-')}`
    return {
      resolvable: true, resourceId: id, kind: 'named', path: '', named: key,
      reason: '', mergedCrossPlatform: false,
    }
  }
  return {
    resolvable: true, resourceId: spec.id, kind: 'named', path: '', named: key,
    reason: '', mergedCrossPlatform: false,
  }
}

/** 已知的命名资源清单（给界面与文档用）。 */
export function namedResourceCatalog() {
  return Object.entries(NAMED_KINDS).map(([key, spec]) => ({
    key,
    label: spec.label,
    withValue: spec.withValue === true,
    example: spec.withValue ? `${key}:<目标>` : key,
    resourceId: spec.id ?? `${spec.prefix}:<目标>`,
  }))
}

/**
 * 两个资源身份是否冲突。
 *
 * 规则：
 *   - 完全相同 → 冲突
 *   - 都是 `path:` 且一个是另一个的祖先 → 冲突（**删父目录会毁掉被锁的子树**，
 *     这是评审复现的第三个 R4 缺陷）
 *   - 命名资源之间只有 id 相同才冲突
 *   - 路径资源与命名资源不冲突（它们描述的是不同的东西）
 */
export function resourcesConflict(a, b) {
  const left = String(a ?? '')
  const right = String(b ?? '')
  if (!left || !right) return false
  if (left === right) return true
  if (!left.startsWith('path:') || !right.startsWith('path:')) return false
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  return longer.startsWith(shorter.endsWith('/') ? shorter : `${shorter}/`)
}

/** 某个身份覆盖到的所有身份（用于"抢锁时要检查哪些冲突"）。 */
export function conflictSetOf(resourceId) {
  return { resourceId, isPath: String(resourceId).startsWith('path:') }
}

/** 分隔符常量导出，便于测试断言归一结果与平台无关。 */
export const PATH_SEP = sep
