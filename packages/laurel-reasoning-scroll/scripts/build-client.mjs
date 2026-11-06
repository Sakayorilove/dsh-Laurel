#!/usr/bin/env node
import { Script } from 'node:vm'
/**
 * Laurel 系列 · 客户端半边打包器
 *
 * 把 `lib/client/` 下的多个源码文件拼成一个自包含的 CJS bundle `lib/client.js`，
 * 产物的 shape 就是 DSH 客户端模块系统要求的形状：
 *
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
 *
 * ── 为什么需要它（不是"为了工程化好看"）──────────────────────────────────
 * 客户端 `require()` **只能**解析 platform seed 表（React / Cordis / 静态 UI 库）
 * 以及 `dsh.client.external` 点名、由另一个 client 插件行提供的模块。
 * 于是 kit 没法作为 npm 依赖被 require，只能在**打包时内联**。
 * 没有这一步，每个新插件就得把 kit 抄一遍 —— 那正是"系列"最怕的事。
 *
 * ── 为什么零依赖 ────────────────────────────────────────────────────────
 * 只在**构建**期跑 Node，产物仍然零依赖、跨包零依赖。
 * 不引入 esbuild 之类的工具链：拼接这点活不值得带一整套依赖。
 *
 * ── 它做的三件事 ────────────────────────────────────────────────────────
 *   1. 校验：源码里不许有顶层 `import`/`export`（会被当 ESM 解析而崩），
 *      entry 必须导出 `apply`；
 *   2. 剥掉注释与 `export` 关键字（**不剥行号**，所以报错行号仍然可用）；
 *   3. 按清单顺序拼进 IIFE，共享一个作用域，所以 kit 的符号在插件代码里直接可见。
 *
 * 用法：
 *   node scripts/build-client.mjs                      # 用内置清单
 *   node scripts/build-client.mjs --check              # 只校验产物是最新的（CI 用）
 *
 * ⚠ 本文件是**每个包各自一份**的副本（与 packages/dsh-strata/scripts/ 同源）。
 * 原因见上面「为什么零依赖」：`repoRoot` 由脚本自身位置推导，所以副本必须
 * 落在本包内，不能用仓库根那份（那份的 repoRoot 是仓库根，清单也是装载机的）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

/** 默认文件清单。前几项是系列共享的 kit，后面是插件自己的代码。 */
export const DEFAULT_MANIFEST = [
  'lib/client-kit.js',
  'lib/client/index.mjs',
]

export class BuildError extends Error {}

/**
 * 剥掉注释与 `export` 关键字。
 *
 * 刻意**保留换行**（注释整块替换成等量空行），这样产物里的报错行号
 * 和源码行号仍然对得上 —— 客户端代码只能在浏览器里调试，行号错位会非常痛。
 */
export function stripSource(source, { preserveComments = false } = {}) {
  let out = ''
  let i = 0
  const n = source.length
  let state = 'code' // code | line-comment | block-comment | squote | dquote | tquote | regex

  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    const newline = () => { out += '\n'; i++ }
    // preserveComments：把注释**原样留在产物里**。产物体积大一点，但示例代码
    // 的说明性注释是给人看的，剥掉就白写了。
    const keep = (text) => { if (preserveComments) out += text }

    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line-comment'; keep('//'); i += 2; continue }
      if (c === '/' && next === '*') { state = 'block-comment'; keep('/*'); i += 2; continue }
      if (c === "'") { state = 'squote'; out += c; i++; continue }
      if (c === '"') { state = 'dquote'; out += c; i++; continue }
      // 模板串里可能有 ${...}，这里只需正确处理转义与结束反引号。
      if (c === '`') { state = 'tquote'; out += c; i++; continue }
      if (c === '\n') { newline(); continue }
      out += c; i++; continue
    }

    if (state === 'line-comment') {
      if (c === '\n') { keep('\n'); state = 'code'; newline(); continue }
      keep(c); i++; continue
    }

    if (state === 'block-comment') {
      if (c === '*' && next === '/') { state = 'code'; keep('*/'); i += 2; continue }
      if (c === '\n') { keep('\n'); newline(); continue }
      keep(c); i++; continue
    }

    if (state === 'squote' || state === 'dquote') {
      const quote = state === 'squote' ? "'" : '"'
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue }
      if (c === quote) { state = 'code'; out += c; i++; continue }
      if (c === '\n') { newline(); continue }
      out += c; i++; continue
    }

    if (state === 'tquote') {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue }
      if (c === '`') { state = 'code'; out += c; i++; continue }
      if (c === '\n') { newline(); continue }
      out += c; i++; continue
    }
  }
  if (state === 'block-comment') throw new BuildError('源码里有没闭合的块注释（/* 没有对应的 */）')
  if (state === 'tquote' || state === 'squote' || state === 'dquote') {
    throw new BuildError('源码里有没闭合的字符串字面量')
  }

  // 去掉 `export ` 修饰符。既然全塞进一个作用域，导出与否没有意义了。
  out = out
    .replace(/^[ \t]*export\s+default\s+/gm, 'const __default = ')
    .replace(/^[ \t]*export\s+(?=(const|let|var|function|class|async)\b)/gm, '')
    // 兜底：`export { a, b }` 这种命名导出块整行删掉。
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '')
  return out
}

/** 校验一份源码：不许有顶层 import/export，必须能提供所需符号。 */
export function validateModule(file, source, { needsApply = false, needsDynamicImport = true } = {}) {
  const problems = []
  const topImport = source.match(/^[ \t]*import\s.+$/m)
  if (topImport) {
    problems.push(`有顶层 import（客户端 bundle 里出现 import 会被当 ESM 解析而崩）：${topImport[0].trim()}`)
  }
  if (needsDynamicImport && /\bimport\s*\(/.test(source)) {
    problems.push('用了动态 import()（classic script 里不可用）')
  }
  if (/^\s*export\s+default/m.test(source)) problems.push('用了 export default（产物是 CJS，必须用命名导出）')
  // `export` 可能已被 stripSource 剥掉，所以两种写法都要认。
  if (needsApply && !/^\s*(?:export\s+)?(?:async\s+)?function\s+apply\b/m.test(source)) {
    problems.push('没有 `export function apply(ctx)` —— 客户端插件必须导出 apply 才能被激活')
  }
  if (problems.length > 0) {
    throw new BuildError(`${file} 不符合客户端 bundle 契约：\n  - ${problems.join('\n  - ')}`)
  }
}

/** 拼出完整产物。 */
export function composeBundle({ id, manifest, sources }) {
  const parts = []
  parts.push('/**')
  parts.push(` * ${id} · 客户端半边（由 scripts/build-client.mjs 生成，不要直接改这个文件）`)
  parts.push(' *')
  parts.push(' * 改源码请改：')
  for (const file of manifest) parts.push(` *   - ${file}`)
  parts.push(' * 然后跑 `npm run build`。')
  parts.push(' */')
  parts.push('')
  parts.push('window.__ModuleLoader__.load({')
  parts.push(`  id: ${JSON.stringify(id)},`)
  parts.push('  factory: (require) => {')
  parts.push('    const module = { exports: {} }')
  parts.push('    const exports = module.exports')
  parts.push('')
  parts.push('    /* ===== 以下为内联源码。kit 与插件代码共享同一个作用域， ===== */')
  parts.push('    /* ===== 所以 kit 导出的符号在插件代码里可以直接用。      ===== */')
  parts.push('')
  for (let index = 0; index < manifest.length; index++) {
    const file = manifest[index]
    parts.push(`    /* ---------- ${file} ---------- */`)
    // 缩进 4 格，让产物读起来还是一份能看的 JS。
    const body = sources[file].split('\n').map((line) => (line.length > 0 ? `    ${line}` : line))
    parts.push(...body)
    parts.push('')
  }
  // 对外只认 `exports.apply` / `exports.inject` 这一种形状（见 bundle 契约文档）。
  // entry 里写的是 `export function apply` / `export const inject`，这里统一挂上去。
  parts.push('    module.exports.apply = apply')
  parts.push("    if (typeof inject !== 'undefined') module.exports.inject = inject")
  parts.push('')
  parts.push('    return module.exports')
  parts.push('  },')
  parts.push('})')
  parts.push('')
  const bundle = parts.join('\n')
  new Script(bundle, { filename: 'client.js' })
  return bundle
}

/** 读清单里的文件、校验、拼装。返回 `{ code, id, manifest }`。 */
export function buildBundle({
  repoRootPath = repoRoot,
  manifest = DEFAULT_MANIFEST,
  id,
  preserveComments = false,
  read = readFileSync,
} = {}) {
  const pkg = JSON.parse(read(join(repoRootPath, 'package.json'), 'utf8'))
  const packageId = id ?? pkg.name
  if (!packageId) throw new BuildError('package.json 里没有 name，无法确定 bundle id')

  const sources = {}
  for (const file of manifest) {
    const full = join(repoRootPath, file)
    if (!existsSync(full)) throw new BuildError(`清单里的文件不存在：${file}`)
    const raw = read(full, 'utf8')
    const isEntry = file === manifest[manifest.length - 1]
    // 校验**剥注释后**的源码：否则文档里写一句「不许用 import()」就会把自己判死。
    // stripSource 保留行号，所以报错位置仍然可用。
    validateModule(file, stripSource(raw), { needsApply: isEntry })
    sources[file] = stripSource(raw, { preserveComments })
  }

  return { code: composeBundle({ id: packageId, manifest, sources }), id: packageId, manifest }
}

/* ------------------------------------------------------------------ *
 * 防误覆盖
 * ------------------------------------------------------------------ */

/**
 * 从一份已有 bundle 里读出它的 id（不属于本模块格式就返回 null）。
 *
 * 手写 bundle 用单引号、生成物用双引号，两种都要认。
 */
export function readBundleId(source) {
  for (const line of source.split('\n')) {
    const m = /^\s*id:\s*['"]([^'"]+)['"]\s*,?\s*$/.exec(line)
    if (m) return m[1]
  }
  return null
}

/**
 * 写 bundle 到 outPath，但**拒绝覆盖属于另一个包的 bundle**。
 *
 * 为什么需要这个守卫（真出过事）：`buildBundle()` 只认"清单文件存在"，
 * 完全不知道 outPath 是谁的地盘。一个绑错 repoRootPath 的测试脚手架
 * 就能把 **Laurel 自己的 lib/client.js** 覆写成别人的 bundle
 * （id 从 'laurel' 变成 'laurel-demo2'）—— 客户端下一帧热替换，
 * 整个通知插件静默失效，而且没有任何报错。这是最贵的失败模式。
 *
 * 判据只用一条：**目标已存在、且它声明的 id 与这次要写的 id 不同** → 拒绝。
 * 同一个包重复构建（id 相同）照常覆盖，所以不会误挡正常流程。
 *
 * @throws {BuildError} 目标文件属于另一个包时
 */
export function writeBundle(bundle, outPath, { read = readFileSync, write = writeFileSync, mkdir = mkdirSync, exists = existsSync } = {}) {
  if (exists(outPath)) {
    const existingId = readBundleId(read(outPath, 'utf8'))
    if (existingId && existingId !== bundle.id) {
      throw new BuildError(
        `拒绝覆盖：${outPath}\n`
        + `  该文件已经是包 "${existingId}" 的客户端 bundle，而这次要写的是 "${bundle.id}"。\n`
        + `  客户端 bundle 路径由各包自己的 package.json exports["./client"] 声明，\n`
        + `  写错地方会让被覆盖的插件静默失效（不报错，只是什么都不发生）。\n`
        + `  确认 --out / exports["./client"] / repoRootPath 指向的是本包目录。`,
      )
    }
  }
  mkdir(dirname(outPath), { recursive: true })
  write(outPath, bundle.code, 'utf8')
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function main(argv) {
  const check = argv.includes('--check')
  const readFlag = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const entry = readFlag('--entry') ?? DEFAULT_MANIFEST[DEFAULT_MANIFEST.length - 1]

  // ⚠️ 默认输出**不是** lib/client.js。
  //
  // 原因：laurel 目前用的是**手写的** lib/client.js（36KB，含通知逻辑与设置页），
  // 它已经在线跑着。本脚本一旦覆写它，客户端会热替换成一份没有通知逻辑的空壳。
  // 所以默认落在一个独立目录；等 Laurel 自己迁到 kit 写法时，才把 --out 指回去。
  const outPath = join(repoRoot, readFlag('--out') ?? 'lib/client.built.js')

  let result
  try {
    result = buildBundle({
      manifest: [...DEFAULT_MANIFEST.slice(0, -1), entry],
      id: readFlag('--id'),
      // kit 始终剥注释（它是内部依赖）；示例/插件源码默认保留，注释是给人看的。
      preserveComments: !argv.includes('--strip-comments'),
    })
  } catch (error) {
    console.error(`✗ 打包失败：${error.message}`)
    return 1
  }

  const existed = existsSync(outPath)
  const before = existed ? readFileSync(outPath, 'utf8') : null

  if (check) {
    if (before === result.code) {
      console.log(`✓ ${relative(repoRoot, outPath)} 与源码一致（id=${result.id}，${result.manifest.length} 个源文件）`)
      return 0
    }
    console.error(`✗ ${relative(repoRoot, outPath)} 不是最新的：源码改过但没重新打包。跑 \`npm run build\`。`)
    return 1
  }

  if (before === result.code) {
    console.log(`✓ 无需改动（id=${result.id}，${result.manifest.length} 个源文件）`)
    return 0
  }
  try {
    writeBundle(result, outPath)
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return 1
  }
  console.log(`✓ 已生成 ${relative(repoRoot, outPath)}（id=${result.id}，${result.manifest.length} 个源文件，`
    + `${result.code.length} 字节）`)
  console.log('  客户端半边支持热替换：刷新页面即生效，不用重启 DSH。')
  return 0
}

// 只有被当脚本直接跑时才执行 CLI；被 import（测试）时不要跑。
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
