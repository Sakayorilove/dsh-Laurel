/**
 * laurel-reasoning-scroll · 家目录与数据路径
 *
 * 这一条规则必须和宿主自己的家目录约定一致（与 laurel-continue 同源）：
 *   1. `DSH_HOME` 环境变量（有就用它）；
 *   2. 否则 `os.homedir()/.dsh`。
 *
 * ⚠️ 不要用 `DSH_PROFILE_DIR` 去推父目录。桌面版宿主是 fork 出来的子进程，
 * 那个环境里往往没有 DSH_HOME；一旦"从 profile 往上推"，就会推出
 * `~/.dsh/profiles`，于是配置被写到 `~/.dsh/profiles/<包名>/` 这种错地方 ——
 * 而且两边都"能跑"，现场极难看出来。
 *
 * 依赖只有 node 内置模块，这是刻意的：本模块不引第三方依赖。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 本模块在 `$DSH_HOME` 下的数据目录名（与 npm 包名一致）。 */
export const DATA_DIR_NAME = 'laurel-reasoning-scroll'

/**
 * DSH 家目录。插件运行数据全部落在它下面。
 * @returns {string}
 */
export function resolveDshHome() {
  const home = process.env?.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return home
  return join(homedir(), '.dsh')
}

/**
 * 本模块的数据位置。
 *
 *   - `settings.json` 设置页写的那份配置
 *
 * @param {string} [home] 覆盖家目录（测试用）
 */
export function pluginPaths(home = resolveDshHome()) {
  const dir = join(home, DATA_DIR_NAME)
  return { dir, settings: join(dir, 'settings.json') }
}
