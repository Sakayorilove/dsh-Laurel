/**
 * dsh-warden · 配置持久化
 *
 * 两个来处：`cordis.patch.yml` 里那份 config 当**默认值**；
 * `$DSH_HOME/warden/settings.json`（设置页写的那份）盖在上面。
 *
 * 写盘只写"已知键"（`pickKnown`），免得把临时字段也存进去。
 * 读失败一律当作"没有这份文件"，绝不抛 —— 配置读不出来不该让插件起不来。
 *
 * ── 写失败必须报失败（R7）──────────────────────────────────────────────
 * 旧版 `setConfig()` 是这样的：
 *
 *     saveSettings(candidate, home, keys)   // 返回值被丢掉
 *     current = candidate
 *     return getConfig()
 *
 * 于是磁盘写不进去（只读挂载、权限、盘满）时，内存里已经改了、HTTP 也回 200，
 * 设置页显示"保存成功"，**重启后配置全丢**。
 * 现在 `saveSettings` 返回 `{ ok, persisted, reason }`，调用方必须把
 * "内存已生效"与"已持久化"分开报告。
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { pluginPaths, resolveDshHome } from './config.js'

/** 读设置。返回 `{ config }` 或 `{}`。 */
export function loadSettings(home = resolveDshHome()) {
  try {
    const raw = readFileSync(pluginPaths(home).settings, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed
  } catch { /* 没有 / 坏了都当没有 */ }
  return {}
}

/**
 * 原子写设置。
 *
 * @returns {{ok: true, persisted: true, file: string, bytes: number}|{ok: false, persisted: false, reason: string}}
 */
export function saveSettings(config, home = resolveDshHome(), knownKeys = []) {
  const file = pluginPaths(home).settings
  const payload = {}
  for (const key of knownKeys) payload[key] = config[key]
  const body = `${JSON.stringify({ config: payload, at: new Date().toISOString() }, null, 2)}\n`
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, body, 'utf8')
    // 改名前确认临时文件真的写全了，避免把半份配置换上去。
    const written = statSync(tmp).size
    if (written !== Buffer.byteLength(body, 'utf8')) {
      throw new Error(`临时文件只写了 ${written} 字节，应为 ${Buffer.byteLength(body, 'utf8')}`)
    }
    renameSync(tmp, file)
    return { ok: true, persisted: true, file, bytes: written }
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* 清不掉就算了 */ }
    return { ok: false, persisted: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 设置是否真的落盘了，以及盘上那份和内存那份是否一致。
 *
 * 给设置页用：不能只看"我 POST 成功了"就显示已保存。
 *
 * @returns {{exists: boolean, matches: boolean, reason: string, at?: string}}
 */
export function verifyPersisted(config, home = resolveDshHome(), knownKeys = []) {
  const stored = loadSettings(home)
  if (!stored.config) return { exists: false, matches: false, reason: '盘上没有这份设置文件' }
  for (const key of knownKeys) {
    const a = JSON.stringify(config[key] ?? null)
    const b = JSON.stringify(stored.config[key] ?? null)
    if (a !== b) {
      return { exists: true, matches: false, reason: `字段 ${key} 与盘上不一致（内存 ${a}，盘上 ${b}）`, at: stored.at }
    }
  }
  return { exists: true, matches: true, reason: '内存与盘上一致', at: stored.at }
}
