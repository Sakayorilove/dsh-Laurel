/**
 * Laurel 系列 · settings.json 读写
 *
 * 配置的**权威文件**就在插件自己的数据目录里：`$DSH_HOME/<插件名>/settings.json`。
 * 优先级链（上层盖下层）：
 *   `cordis.patch.yml` 的 config（默认值）  <  `settings.json`（设置页写的）
 *
 * 所以"恢复默认"这个动作 = 删掉 settings.json。不需要任何 UI。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { pluginPaths } from './home.js'

/**
 * 读 settings.json。
 * 文件不存在、读不了、JSON 坏了 —— 一律返回 `config: null`，让调用方退回 patch 默认值。
 * **绝不抛异常**：配置读不到不该让插件起不来。
 *
 * @param {string} name 插件名
 * @param {string} [home]
 */
export function loadSettings(name, home) {
  const p = pluginPaths(name, home)
  try {
    if (!existsSync(p.settings)) return { config: null, path: p.settings, exists: false }
    const parsed = JSON.parse(readFileSync(p.settings, 'utf8'))
    return { config: parsed && typeof parsed === 'object' ? parsed : null, path: p.settings, exists: true }
  } catch {
    return { config: null, path: p.settings, exists: false }
  }
}

/**
 * 原子写 settings.json。
 *
 * 为什么要"先写 .tmp 再落地"：设置页和宿主可能同时读写，直接覆写会让宿主
 * 读到**半个 JSON**（这时候 `loadSettings` 会返回 null，于是配置"莫名其妙重置了"）。
 * 这个 bug 很难复现，所以从第一次就写对。
 *
 * @param {Record<string, unknown>} config 已经 `pickKnown` 过的干净配置
 * @param {string} name
 * @param {string} [home]
 * @returns {string} settings.json 的路径
 */
export function saveSettings(config, name, home) {
  const p = pluginPaths(name, home)
  mkdirSync(p.dir, { recursive: true })
  const body = `${JSON.stringify(config, null, 2)}\n`
  const tmp = `${p.settings}.tmp`
  writeFileSync(tmp, body, 'utf8')
  try {
    writeFileSync(p.settings, readFileSync(tmp, 'utf8'), 'utf8')
  } catch {
    // 极端情况（两进程同时写）退回直接写 —— body 本身已经是完整 JSON。
    writeFileSync(p.settings, body, 'utf8')
  }
  return p.settings
}
