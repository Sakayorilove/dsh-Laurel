/**
 * Laurel-Center · 当前运行实例的身份（第二轮 F7）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 第一轮的交付证据里有 `migratedAt`、有「应用能打开」的截图，但**没有任何一条**
 * 能独立证明「这一次重启加载的是哪个 build」。用户看到「当前新版已加载」时，
 * 那句话是没有凭据的。
 *
 * 现在宿主半边在激活时算出一份可读的身份：
 *   version      —— 包版本（lib/config.js，与 package.json 校验一致）
 *   buildHash    —— 由 `release.manifest.json` 的逐文件 sha256 汇总出的**构建指纹**
 *   builtAt      —— 那份清单的生成时间（= 那次 release 的时间）
 *   fileCount    —— 清单里的文件数
 *   source       —— 清单记录的源码 HEAD / dirty（清单没记就是 null）
 *   startAt      —— **本次激活**的时间（进程内实例起点）
 *   instanceId   —— 本次激活的随机 id
 *
 * 客户端可以用 `remote` 读到它，把「本窗口看到的到底是哪个 build」写进界面；
 * 不需要为了证明加载而往私有 state 里写东西。
 *
 * 清单缺失 / 坏了不抛：返回 `buildHash: null` 并带上原因 —— 宁可显示「未确认」，
 * 也不许拿一个假的指纹冒充。
 *
 * ── 边界（第三轮 E1）：这是**清单声明**，不是磁盘验真 ─────────────────────
 * `buildHash` 只把 `release.manifest.json` 里的 `path/sha256` 汇总一下，**不碰磁盘上的
 * 文件**。实测：把一份正确的清单复制到「缺大部分文件、package.json 也不同」的目录里，
 * `readBuildInfo()` 照样返回 `ok:true` 和同一个 buildHash。
 *
 * 所以它能回答的是「这个实例读的是哪份清单」，**不是**「磁盘上的代码逐文件都对」。
 * 要证明「新版真的落地了」，必须另外独立核一遍文件 —— 用
 * `scripts/verify-release.mjs <目录> --against <源码>`，再收集真实重启后的
 * `startAt` / `instanceId` / 客户端加载与四插件实际状态。光截图 v1.1.0
 * 或者只调一次 `identity()` 都不算验收。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_NAME, VERSION } from './config.js'

/** 本包根目录（lib/ 的上一级）。 */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 读 `<包根>/release.manifest.json` 并算出构建指纹。
 *
 * @param {{ root?: string, readFile?: Function, exists?: Function }} [options]
 * @returns {{
 *   ok: boolean, path: string, buildHash: string | null, builtAt: string | null,
 *   fileCount: number | null, totalBytes: number | null,
 *   source: { head?: string | null, dirty?: boolean | null } | null, error: string | null,
 * }}
 */
export function readBuildInfo(options = {}) {
  const root = options.root ?? PACKAGE_ROOT
  const readFile = options.readFile ?? readFileSync
  const exists = options.exists ?? existsSync
  const path = join(root, 'release.manifest.json')
  const empty = { ok: false, path, buildHash: null, builtAt: null, fileCount: null, totalBytes: null, source: null }
  if (!exists(path)) return { ...empty, error: 'manifest-missing' }
  try {
    const manifest = JSON.parse(readFile(path, 'utf8'))
    const files = Array.isArray(manifest?.files) ? manifest.files : null
    if (files === null) return { ...empty, error: 'manifest-shape' }
    // 指纹只用「路径 + 内容 hash」，排序后拼 —— 与清单里的顺序无关。
    const lines = files
      .filter((f) => f && typeof f.path === 'string' && typeof f.sha256 === 'string')
      .map((f) => `${f.path}\u0000${f.sha256}`)
      .sort()
    const buildHash = createHash('sha256').update(lines.join('\n')).digest('hex')
    return {
      ok: true,
      path,
      buildHash,
      builtAt: typeof manifest?.at === 'string' ? manifest.at : null,
      fileCount: Number.isInteger(manifest?.fileCount) ? manifest.fileCount : files.length,
      totalBytes: Number.isInteger(manifest?.totalBytes) ? manifest.totalBytes : null,
      source: manifest?.source && typeof manifest.source === 'object'
        ? { head: manifest.source.head ?? null, dirty: manifest.source.dirty ?? null }
        : null,
      error: null,
    }
  } catch (error) {
    return { ...empty, error: `manifest-unreadable: ${String(error?.message ?? error)}` }
  }
}

/**
 * 本次激活的实例身份。`startAt` / `instanceId` 每次激活都不同 ——
 * 这正是「这一次重启加载的是哪一份」的那一半凭据。
 */
export function makeIdentity(options = {}) {
  const now = options.now ?? new Date().toISOString()
  const build = readBuildInfo(options)
  return {
    package: PACKAGE_NAME,
    version: VERSION,
    buildHash: build.buildHash,
    builtAt: build.builtAt,
    fileCount: build.fileCount,
    totalBytes: build.totalBytes,
    source: build.source,
    buildEvidence: build.ok ? 'manifest' : `unconfirmed:${build.error}`,
    manifestPath: build.path,
    startAt: now,
    instanceId: `${VERSION}-${Math.random().toString(36).slice(2, 10)}`,
  }
}
