/**
 * Laurel-Center · 常量
 *
 * 包名在三处必须一致（见 docs/PLUGIN-CONTRACT.md）：
 *   1. 本文件（也是 `exports` 寻址的目录名）
 *   2. `package.json` 的 `name`
 *   3. 客户端 bundle 里 `window.__ModuleLoader__.load({ id })` 的 id
 */

/** 包名。同时是家目录下的数据目录名。 */
export const PACKAGE_NAME = 'laurel-center'

/** 版本，与 package.json 保持一致。 */
export const VERSION = '1.9.2'
