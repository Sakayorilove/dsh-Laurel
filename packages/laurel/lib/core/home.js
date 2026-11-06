/**
 * Laurel 系列 · 家目录与数据路径
 *
 * 这一条规则**必须**和宿主自己的 `@deepseek-ai/dsh-home-paths` 一致：
 *   1. `DSH_HOME` 环境变量（有就用它）；
 *   2. 否则 `os.homedir()/.dsh`。
 *
 * ⚠️ 血泪教训，别再踩：**不要用 `DSH_PROFILE_DIR` 去推父目录。**
 * 桌面版宿主是 Electron fork 出来的子进程，那个环境里**没有** `DSH_HOME`。
 * 一旦改成"从 profile 目录往上推"，就会推出 `~/.dsh/profiles`，
 * 于是配置和事件日志被写到 `~/.dsh/profiles/<包名>/` 这种错地方，
 * 而且因为两边都"能跑"，现场很难看出来。这里只认上面那两条。
 *
 * 依赖只有 node 内置模块，这是刻意的（见 README 的「零第三方依赖」）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * DSH 家目录。插件运行数据全部落在它下面。
 * @returns {string}
 */
export function resolveDshHome() {
  const home = process.env.DSH_HOME
  if (home && home.length > 0) return home
  return join(homedir(), '.dsh')
}

/**
 * 某个插件在家目录下的数据位置。
 *
 * 统一约定（系列内所有插件都照这个来，见 docs/PLUGIN-CONTRACT.md）：
 *   - `settings.json` 设置页写的那份配置
 *   - `events.log`    一行一个 JSON 的事件流水（事后能核对）
 *   - `sounds/`       只有需要音频的插件才建
 *
 * @param {string} name 插件名，同时是数据目录名（用 npm 包名，保持和 bundle id 一致）
 * @param {string} [home] 覆盖家目录（测试用）
 */
export function pluginPaths(name, home = resolveDshHome()) {
  const dir = join(home, name)
  return {
    dir,
    settings: join(dir, 'settings.json'),
    events: join(dir, 'events.log'),
    sounds: join(dir, 'sounds'),
  }
}
