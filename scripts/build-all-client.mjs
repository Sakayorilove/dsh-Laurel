#!/usr/bin/env node
/**
 * Build independent classic-script factories for Center and each module.
 * The root client.js contains only Center; modules retain their own package versions and output files.
 * Package build declarations supply source manifests. Handwritten/external bundles are validated.
 * --check verifies generated content; --verify checks the existing output without rewriting it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BuildError,
  DEFAULT_MANIFEST,
  buildBundle,
  readBundleId,
  writeBundle,
} from './build-client.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

/** 注册顺序 = 激活顺序。与 lib/registry.js 的 SUB_PLUGINS 同序，但 id 用包名。 */
export const CLIENT_SUB_PACKAGES = [
  'laurel',
  'laurel-memory',
  'laurel-context',
  'laurel-continue',
  'dsh-warden',
  'laurel-reasoning-scroll',
]

/** 装载机自己才需要的 UI 文件（子包不带；判据与 buildBundle 内部那份一致）。 */
const CENTER_ONLY_FILES = [
  'lib/client/module-runtime.mjs',
  'lib/client/experience-v05.mjs',
  'lib/client/experience-v05.css',
  'lib/client/si-flow-assets.mjs',
  'lib/client/si-flow-engine.mjs',
  'lib/client/si-flow-runtime.mjs',

  'lib/client/workbench-assets.mjs',
  'lib/presentation-model.js',
  'lib/client/accepted-v02.css',
  'lib/client/workbench-v02.css',
  'lib/client/accepted-v02-templates.mjs',
  'lib/client/workbench-v02.mjs',
  'lib/client/control-center.css',
  'lib/client/accepted-preview.css',
  'lib/client/accepted-templates.mjs',
  'lib/client/control-center.mjs',
]

/** 从子包的 package.json 推出它该怎么进多块产物。 */
export function resolveSubBlock({ root = repoRoot, dir, read = readFileSync } = {}) {
  const pkgPath = join(root, 'packages', dir, 'package.json')
  if (!existsSync(pkgPath)) throw new BuildError('子包不存在：packages/' + dir)
  const pkg = JSON.parse(read(pkgPath, 'utf8'))
  const id = typeof pkg.name === 'string' && pkg.name ? pkg.name : dir
  const prebuilt = 'packages/' + dir + '/lib/client.js'

  const command = [pkg.scripts && pkg.scripts['build:client'], pkg.scripts && pkg.scripts.build]
    .filter((value) => typeof value === 'string' && /build-client\.mjs/.test(value))[0]

  if (command) {
    const entry = /--entry\s+(\S+)/.exec(command)
    const out = /--out\s+(\S+)/.exec(command)
    const wantsStrip = /--strip-comments/.test(command)
    // 构建命令打的是别的文件（例如 laurel 打的是示例插件）→ 不能当成本包入口。
    const targetsClient = out && /lib[\\/]client\.js$/.test(out[1])
    if (entry && targetsClient) {
      const fromCenter = entry[1].startsWith('packages/')
      const base = fromCenter ? root : join(root, 'packages', dir)
      if (!existsSync(join(base, entry[1]))) {
        throw new BuildError(
          'packages/' + dir + ' 的构建命令指向的入口不存在：' + entry[1]
          + '\n  它的客户端源码可能已经丢了（例如 laurel 只剩一个 .bak 示例）。'
          + '\n  这种情况必须显式走 prebuilt 路径，不许拿示例冒充真插件。',
        )
      }
      const manifest = fromCenter
        ? [...DEFAULT_MANIFEST.slice(0, -1), entry[1]].filter((file) => CENTER_ONLY_FILES.indexOf(file) < 0)
        : ['lib/client-kit.js', entry[1]]
      return {
        dir,
        id,
        kind: 'inline',
        base,
        manifest: pruneUnusedShared(base, manifest, read),
        preserveComments: !wantsStrip,
      }
    }
  }

  if (existsSync(join(root, prebuilt))) return { dir, id, kind: 'prebuilt', file: prebuilt }

  throw new BuildError(
    'packages/' + dir + ' 既没有 build-client 构建命令，也没有 lib/client.js'
    + '\n  —— 无法决定它怎么进多块产物。',
  )
}

/**
 * 共享定义文件：只声明符号，没有顶层副作用，所以「没被引用」就是纯粹的死重量。
 * 删掉它们不改变行为，只是不再把同一份代码复制到每个块里。
 */
const SHARED_DEFINITION_FILES = [
  'lib/client-kit.js',
  'lib/change-result.js',
  'lib/registry.js',
  'lib/presentation-model.js',
]

/** 一个文件导出的顶层符号名（剥掉 export 之后的标识符）。 */
export function exportedNames(source) {
  const names = []
  const patterns = [
    /^[ 	]*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm,
    /^[ \t]*export\s+\{([^}]*)\}/gm,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].includes(',')) {
        for (const piece of match[1].split(',')) {
          const name = piece.trim().split(/\s+as\s+/).pop().trim()
          if (name) names.push(name)
        }
      } else if (match[1]) {
        names.push(match[1])
      }
    }
  }
  return [...new Set(names)]
}

/**
 * 把块里**用不到**的共享定义文件剔掉。
 *
 * 为什么需要：内联是为了让符号可见，但一个块用不到的文件内联进来就是纯粹的
 * 重复体积。实测 laurel-memory / laurel-context / laurel-continue 三块对
 * change-result 与 registry 的符号命中数都是 0 —— 每个块白背 34KB。
 *
 * 判据保守到只剩一条：**这个共享文件导出的符号，entry 里一个都没出现** → 剔。
 * 只对 SHARED_DEFINITION_FILES 生效（那些文件只有声明、没有副作用），
 * kit 这种可能被间接用到的仍然保留在清单里，只要命中任意一个符号。
 */
export function pruneUnusedShared(base, manifest, read) {
  if (manifest.length <= 1) return manifest
  const entry = manifest[manifest.length - 1]
  const entrySource = stripComments(read(join(base, entry), 'utf8'))
  const kept = manifest.filter((file) => {
    if (file === entry) return true
    if (SHARED_DEFINITION_FILES.indexOf(file) < 0) return true
    const names = exportedNames(read(join(base, file), 'utf8'))
    if (names.length === 0) return true
    return names.some((name) => new RegExp('\\b' + escapeRegExp(name) + '\\b').test(entrySource))
  })
  return kept
}

/**
 * 把注释行整行抹掉（保留行号），只留代码。
 *
 * 为什么要剥注释再判「用没用到」：注释里出现一个符号名会让裁剪**保守地保留**
 * 那个文件（只是多背体积，安全）；但当**唯一的用途恰好写在注释里**时，正文没有
 * 命中就会把定义剔掉。1.7.0 的六个模块就是死在这条上 —— laurel-memory 等模块
 * 正文写着 `registerSettingsSection(ctx, {...})`，而注释里还提到 kit 的其它符号，
 * 匹配到的是注释，正文那个调用反而没算进「命中」，于是 kit 只保留了被注释提到的
 * 那几个导出……实测结果是整个 block 里**一个 kit 符号都没有**，
 * 真机表现是 `ReferenceError: registerSettingsSection is not defined`。
 */
function stripComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const text = line.trim()
      if (text.startsWith('*') || text.startsWith('//') || text.startsWith('/*')) return ''
      return line
    })
    .join('\n')
}

/** 正则元字符转义（原名替换写成 name.replace(/$/g, ...)，只在末尾是行尾锚时才算转义）。 */

/**
 * 手写/外构建的 bundle：原样内联，只切掉文件开头那段文档注释。
 *
 * 为什么切 banner：注释里会举例写 window.__ModuleLoader__.load({ id, factory })，
 * 把它留在产物里，「这个文件到底注册了几块」就没法一眼数清了。切的位置是
 * **行首**那个真正的注册语句（/m 锚行首），不是注释里的那一处。
 *
 * 为什么不套 stripSource：它不是真正的解析器，碰到正则字面量 /^https?:\/\//
 * 会把它当字符串起点，把后面的代码整段吞掉（laurel 的 bundle 实测会语法错）。
 */
export function normalizePrebuilt(source, file) {
  const anchor = /^window\.__ModuleLoader__\.load\(/m.exec(source)
  if (!anchor) {
    throw new BuildError(file + ' 里找不到行首的 window.__ModuleLoader__.load( —— 这不是客户端 bundle')
  }
  const body = source.slice(anchor.index)
  const loads = (body.match(/window\.__ModuleLoader__\.load\(/g) || []).length
  if (loads !== 1) throw new BuildError(file + ' 里仍有 ' + loads + ' 处注册语句（应为 1）。')
  if (/^[ \t]*(?:import|export)\s/m.test(body)) {
    throw new BuildError(file + ' 的块里有行首的 import/export —— classic script 里会被当 ESM 解析而崩。')
  }
  return body
}

/** 以行首锚定数注册块：注释里的举例不算。 */
export function countRegistrations(code) {
  return (code.match(/^window\.__ModuleLoader__\.load\(/gm) || []).length
}

/**
 * 把**块内注释里**的注册写法改成不带窗口前缀的说法。
 *
 * 为什么非做不可：lib/change-result.js 的文档注释里写着
 * `产物形状：window.__ModuleLoader__.load({ id, factory }) 的 CJS 闭包`，
 * 这句会被内联进每一个用到它的块，于是「这个文件到底注册了几块」就没法
 * 靠数文本判定了（门禁 module.mjs 与 check.mjs 都是数字面量）。
 *
 * 只改**注释行**（以 * / // / /* 开头），代码行一个字都不动；改的也只是
 * 显示文本，语义完全等价（去掉窗口前缀，后面紧跟着同一个 .load({ id, factory })）。
 */
export function normalizeInlineComments(code) {
  return code
    .split('\n')
    .map((line) => {
      const text = line.trim()
      const isComment = text.startsWith('*') || text.startsWith('//') || text.startsWith('/*')
      if (!isComment) return line
      return line.replace(/window\.__ModuleLoader__\.load\(/g, '__ModuleLoader__.load(')
        .replace(/window\.__ModuleLoader__\s*→/g, '__ModuleLoader__ →')
    })
    .join('\n')
}


/**
 * 装载机自己那块末尾追加的「激活兄弟模块」代码。
 *
 * ── 为什么非有不可 ────────────────────────────────────────────────────
 * 九个兄弟模块的 loader 行会被删掉，宿主只给**有 loader 行**的包建 boot graph
 * row。没有 row，就没有任何东西会去调它们的 apply() —— 它们是「注册了但永远
 * 不会被激活」，界面上直接消失。所以由装载机自己把它们拉起来。
 *
 * ── 2026-10-26 的致命 bug（1.7.0 真机 web boot 全崩，别再犯）───────────
 * 旧实现写成 `ctx.modules || ctx.get('modules')`，并且**直接调 `exports.apply(ctx)`**。
 * 两处都错，合起来就是「重启后插件报错打不开，卸掉全部插件才能进」：
 *
 *   1. `ctx.modules` 是 Cordis 受控代理上的**裸读**。vendor/cordis/src/reflect.ts
 *      的 Proxy get 陷阱对没写进 inject 的服务名直接
 *      `throw new Error('cannot get property "modules" without inject')`，
 *      只有 `ctx.get(name)` 才在缺服务时返回 undefined（ReflectService.get 的 strict 分支）。
 *      于是 apply 在**同步路径**上抛错 → fiber 变 FAILED →
 *      boot-client.ts 的 assertEntriesActive 报 `laurel-center: failed` → 整个 web 启动失败。
 *      实测：服务真的存在时裸读照样抛（见 .local/cordis-modules-probe.mjs）。
 *      ⇒ 一律 `ctx.get?.('modules')`，永远不要 `ctx.modules`。
 *
 *   2. `exports.apply(ctx)` 把兄弟模块**跑在装载机自己的 fiber 里**：它们不成为
 *      子 fiber、不受各自的 inject 约束、也**卸载不掉**（关闭开关只关掉了 UI 认知，
 *      代码还在）。正确的形态是 `ctx.plugin({ name, inject, apply })`：
 *      Cordis 给每个子插件建子 fiber，inject 由 Inject.resolve 合并解析，
 *      父 fiber 的依赖也能被子 fiber 看到（实测 .local/cordis-inherit-probe.mjs），
 *      一个子插件抛错只让它自己的 fiber 变 FAILED，不连带别人。
 *
 * ── 三条设计约束 ──────────────────────────────────────────────────────
 *   1. **每个模块独立隔离**：各自一条子 fiber，一个坏不连坐其它九个；
 *   2. **幂等**：apply 重复调用（热替换）不许把兄弟模块挂两遍；
 *   3. **不把 modules 变成硬依赖**：larel-center 可能先于 modules 服务到达，
 *      所以按退避重试；声明成 inject 会让拿不到服务时整条激活链断掉。
 */
function childActivationEpilogue(childIds) {
  const lines = []
  const indent = (text) => '    ' + text
  for (const line of [
    '/* ================================================================== *',
    ' * 激活兄弟模块',
    ' *',
    ' * 它们和本模块同处这一个 classic script，但**没有 loader 行** —— 宿主不给',
    ' * 它们建 boot graph row，所以没有任何东西会去调它们的 apply。这里补上。',
    ' *',
    ' * 关键：必须用 ctx.plugin() 挂成**子 fiber**，不能直接 exports.apply(ctx)。',
    ' *   · 子 fiber 才能被单独 dispose（模块开关真的关得掉）；',
    ' *   · 子 fiber 才受自己 inject 的约束，拿不到服务是它 pending 而不是别人失败；',
    ' *   · 任一个 apply 抛错只把它自己的 fiber 打成 FAILED，装载机和别的模块照常。',
    ' *',
    ' * ctx.get("modules") 由 @deepseek-ai/dsh-client-modules 提供。它可能晚到，',
    ' * 所以这里退避重试，不写成 inject —— 声明了就是硬依赖，拿不到会整条断掉。',
    ' *',
    ' * ⚠ 绝对不要写 ctx.modules：Cordis 的上下文代理对没 inject 的服务名是 throw，',
    ' *   不是返回 undefined（reflect.ts 的 Proxy get 陷阱）。这一行曾让整个 web boot 失败。',
    ' * ================================================================== */',
    'const CHILD_MODULE_IDS = ' + JSON.stringify(childIds),
    '// 幂等闸：热替换 / 重复 apply 不许把兄弟模块挂两遍。存的是 fiber，不是布尔。',
    'const childFibers = new Map()',
    '',
    '/** 缺服务时返回 undefined —— 只有 ctx.get 有这条契约，ctx.X 会抛。 */',
    'function peekService(ctx, name) {',
    '  if (!ctx || typeof ctx.get !== \'function\') return undefined',
    '  try { return ctx.get(name) } catch { return undefined }',
    '}',
    '',
    '/**',
    ' * 把一个兄弟模块挂成子插件。',
    ' *',
    ' * inject 用模块自己导出的那份：它本来就是写给宿主 boot graph 排顺序用的，',
    ' * 语义与 ctx.plugin({ inject }) 完全一致，照搬即可 —— 抄一份反而会漂。',
    ' * 没有 inject 的模块（早期产物）退化成空数组，照样能挂。',
    ' */',
    'function mountChildModule(ctx, id, exported) {',
    '  const inject = Array.isArray(exported.inject) ? exported.inject.slice() : []',
    '  const child = {',
    '    name: id,',
    '    inject,',
    '    apply(c) { return exported.apply(c) },',
    '  }',
    '  return ctx.plugin(child)',
    '}',
    '',
    'async function activateChildModules(ctx) {',
    '  if (!ctx) return []',
    '  const modules = peekService(ctx, \'modules\')',
    '  if (!modules || typeof modules.import !== \'function\') return []',
    '  const results = []',
    '  for (const id of CHILD_MODULE_IDS) {',
    '    if (childFibers.has(id)) { results.push({ id, status: \'already-active\' }); continue }',
    '    // 先占位再 await：两次并发 apply 不会把同一个模块挂两遍。',
    '    // 失败时删掉占位 —— 那是**故意**的：一次失败不该让这个模块永久失活，',
    '    // 下次热替换 / 下次 apply 还应该再试一次。所以「幂等」的准确含义是',
    '    // 「成功挂上的不会重来」，不是「失败的也不再试」。',
    '    let exported = null',
    '    try {',
    '      exported = await modules.import(id)',
    '      if (!exported || typeof exported.apply !== \'function\') {',
    '        throw new Error(\'拿到的 exports 没有 apply（模块可能没被这个 bundle 注册）\')',
    '      }',
    '      const fiber = mountChildModule(ctx, id, exported)',
    '      childFibers.set(id, fiber)',
    '      results.push({ id, status: \'active\' })',
    '    } catch (error) {',
    '      // 失败要能一眼看出是哪个模块：只报 "apply is not a function" 等于没报。',
    '      results.push({ id, status: \'failed\', error })',
    '      try {',
    '        console.warn(\'[laurel-center] 子模块激活失败：\' + id + \' —— \' + String((error && error.message) || error))',
    '      } catch { /* 无 console 环境忽略 */ }',
    '    }',
    '  }',
    '  return results',
    '}',
    '',
    '/** 摘掉一个已挂载的子模块（模块开关关掉时用）。返回是否真的摘了。 */',
    'function deactivateChildModule(id) {',
    '  const fiber = childFibers.get(id)',
    '  if (fiber === undefined) return false',
    '  childFibers.delete(id)',
    '  try { fiber?.dispose?.() } catch (error) {',
    '    try { console.warn(\'[laurel-center] 子模块卸载失败：\' + id + \' —— \' + String((error && error.message) || error)) } catch { /* 忽略 */ }',
    '  }',
    '  return true',
    '}',
    '',
    '/** 取一个可用的定时器：宿主环境未必有全局 setTimeout（web boot 的沙箱/VM 就没有）。 */',
    'function sleepMs(ctx, ms) {',
    '  const fromCtx = ctx && typeof ctx.setTimeout === \'function\' ? ctx.setTimeout.bind(ctx) : null',
    '  const fromGlobal = typeof globalThis !== \'undefined\' && typeof globalThis.setTimeout === \'function\' ? globalThis.setTimeout : null',
    '  const timer = fromCtx || fromGlobal',
    '  if (!timer) return Promise.resolve()   // 没有定时器就不退避：直接同步重试',
    '  return new Promise((resolve) => timer(resolve, ms))',
    '}',
    '',
    '// 退避等待 modules 服务就绪：12 次 × 50ms ≈ 600ms，足够宿主完成 boot graph。',
    'function activateChildModulesWhenReady(ctx) {',
    '  const attempt = (left) => {',
    '    const modules = peekService(ctx, \'modules\')',
    '    if (modules && typeof modules.import === \'function\') return activateChildModules(ctx)',
    '    if (left <= 0) {',
    '      try { console.warn(\'[laurel-center] 等不到 modules 服务，九个子模块本次未激活\') } catch { /* 忽略 */ }',
    '      return Promise.resolve([])',
    '    }',
    '    return sleepMs(ctx, 50).then(() => attempt(left - 1))',
    '  }',
    '  return attempt(12)',
    '}',
    '',
    '// 包住原来那个 apply：先让它跑完（装载机自己的 UI 优先），再激活兄弟模块。',
    '// 包在最后是因为到这里 apply 已经定义好了；包完再挂回 module.exports.apply。',
    '//',
    '// ⚠ 这个函数**不许**同步抛。它跑在装载机的 fiber 里，抛了就是 laurel-center: failed，',
    '//   症状是整个 web 页面起不来（旧版就是死在这里）。所以全程包在 try 里。',
    'const applyCenterOnly = apply',
    'apply = function applyWithChildModules(ctx) {',
    '  let result',
    '  try {',
    '    result = applyCenterOnly(ctx)',
    '  } catch (error) {',
    '    // 装载机自己的 apply 抛了要照实抛出去 —— 那是它真正的失败，不该被这里吞掉',
    '    // （吞掉会让「中心坏了」变成「中心好的、只是模块没起来」）。',
    '    throw error',
    '  }',
    '  // 子模块失败不许把装载机自己带塌；也不阻塞 apply 的返回值。',
    '  let activation',
    '  try {',
    '    activation = activateChildModulesWhenReady(ctx).catch((error) => {',
    '      try { console.warn(\'[laurel-center] 子模块激活流程异常：\' + String((error && error.message) || error)) } catch { /* 忽略 */ }',
    '      return []',
    '    })',
    '  } catch (error) {',
    '    try { console.warn(\'[laurel-center] 子模块激活启动失败：\' + String((error && error.message) || error)) } catch { /* 忽略 */ }',
    '    activation = Promise.resolve([])',
    '  }',
    '  if (result && typeof result.then === \'function\') return result.then(() => activation)',
    '  return result',
    '}',
    'module.exports.apply = apply',
    'module.exports.activateChildModules = activateChildModules',
    'module.exports.activateChildModulesWhenReady = activateChildModulesWhenReady',
    'module.exports.deactivateChildModule = deactivateChildModule',
  ]) lines.push(indent(line))
  return lines
}

/** 拼出多块产物。 */
export function composeMultiBundle({ id, blocks }) {
  const parts = []
  parts.push('/**')
  parts.push(' * ' + id + ' · 客户端半边（多注册块，由 scripts/build-all-client.mjs 生成，不要直接改这个文件）')
  parts.push(' *')
  parts.push(' * 一个 classic script 里按顺序注册 ' + blocks.length + ' 个模块，每块独立函数作用域：')
  for (const block of blocks) {
    const how = block.kind === 'prebuilt'
      ? '原样内联 ' + block.file
      : '内联 ' + block.manifest.length + ' 个源文件，入口 ' + block.manifest[block.manifest.length - 1]
    parts.push(' *   - ' + block.id + '  ← ' + how)
  }
  parts.push(' *')
  parts.push(' * 标准控制中心只注册自身；商店模块独立下载，通过内容别名注册和独立子 Fiber 激活。')
  parts.push(' * 已注册 factory 可以由原生客户端模块服务导入，不需要额外的 Loader 行。')
  parts.push(' *')
  parts.push(' * 改源码请改每个模块自己的文件，然后跑 pnpm run build:client。')
  parts.push(' */')
  parts.push('')

  for (const block of blocks) {
    parts.push('/* ================================================================== *')
    parts.push(' * ' + block.id)
    if (block.kind === 'prebuilt') {
      parts.push(' * 原样内联：' + block.file)
      parts.push(' * 该包手写/外构建，没有可内联的 mjs 源，块体逐字节照搬。')
    } else {
      parts.push(' * 内联源码（顺序即执行顺序）：')
      for (const file of block.manifest) parts.push(' *   - ' + file)
      parts.push(' * require 只用于 platform seed 表；块内符号不跨块共享。')
    }
    parts.push(' * ================================================================== */')
    parts.push(block.code.trimEnd())
    parts.push('')
  }
  return parts.join('\n')
}

/** 读各个兄弟包、拼成多块产物。 */
export function buildMultiBundle({ root = repoRoot, subPackages = [], read = readFileSync } = {}) {
  const pkg = JSON.parse(read(join(root, 'package.json'), 'utf8'))
  const id = pkg.name
  if (!id) throw new BuildError('package.json 里没有 name，无法确定 bundle id')

  // 第一块永远是装载机自己：其余各块靠它的 apply 激活。
  const center = buildBundle({
    repoRootPath: root,
    id,
    preserveComments: true,
    epilogue: subPackages.length ? childActivationEpilogue(subPackages.map((dir) => {
      // 兄弟块的 id 用**包名**（不是目录名），先解析一遍再交给激活表。
      const spec = resolveSubBlock({ root, dir, read })
      return spec.id
    })) : [],
    read,
  })
  const blocks = [{
    id: center.id,
    kind: 'inline',
    manifest: center.manifest,
    code: normalizeInlineComments(center.code),
  }]

  const seen = [center.id]
  for (const dir of subPackages) {
    const spec = resolveSubBlock({ root, dir, read })
    if (seen.indexOf(spec.id) >= 0) throw new BuildError('多块产物里 id 重复：' + spec.id)
    seen.push(spec.id)

    if (spec.kind === 'prebuilt') {
      const code = normalizePrebuilt(read(join(root, spec.file), 'utf8'), spec.file)
      const declared = readBundleId(code)
      if (declared !== spec.id) {
        throw new BuildError(spec.file + ' 声明的 id 是 ' + declared + '，与包名 ' + spec.id + ' 不一致')
      }
      blocks.push({ id: spec.id, kind: 'prebuilt', file: spec.file, code })
      continue
    }

    const built = buildBundle({
      repoRootPath: spec.base,
      manifest: spec.manifest,
      id: spec.id,
      version: JSON.parse(read(join(root,'packages',dir,'package.json'),'utf8')).version,
      preserveComments: spec.preserveComments,
      read,
    })
    blocks.push({ id: built.id, kind: 'inline', manifest: built.manifest, code: normalizeInlineComments(built.code) })
  }

  return { code: composeMultiBundle({ id, blocks }), id, blocks }
}

/* ------------------------------------------------------------------ *
 * 体检：产物必须自己说得清「注册了几块、每块是谁」
 * ------------------------------------------------------------------ */

export function verifyProduct(code, expectedIds) {
  const problems = []
  const registrations = countRegistrations(code)
  if (registrations !== expectedIds.length) {
    problems.push('注册块数量是 ' + registrations + '，应为 ' + expectedIds.length + ' 段。')
  }

  const ids = []
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/^window\.__ModuleLoader__\.load\(/.test(lines[i])) {
      const id = readBundleId(lines.slice(i, i + 3).join('\n'))
      if (!id) problems.push('第 ' + (i + 1) + ' 行的注册块没有可读出的 id。')
      else ids.push(id)
    }
  }
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (duplicates.length > 0) problems.push('id 有重复：' + duplicates.join(', '))
  for (const id of expectedIds) {
    if (ids.indexOf(id) < 0) problems.push('缺少注册块：' + id)
  }

  const topEsm = []
  lines.forEach((line, index) => {
    if (/^[ \t]*(?:import|export)\s/.test(line)) topEsm.push(index + 1)
  })
  if (topEsm.length > 0) problems.push('行首出现 import/export（第 ' + topEsm.slice(0, 5).join(', ') + ' 行）')

  const dynamicImports = []
  lines.forEach((line, index) => {
    if (/\bimport\s*\(/.test(line)) dynamicImports.push(index + 1)
  })
  const dynamicInCode = dynamicImports.filter((n) => !isCommentLine(lines[n - 1]))

  return { problems, ids, registrations, dynamicImports, dynamicInCode }
}

function isCommentLine(line) {
  const text = (line || '').trim()
  return text.startsWith('*') || text.startsWith('//') || text.startsWith('/*')
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function flagValue(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

export function main(argv) {
  const check = argv.includes('--check')
  const verifyOnly = argv.includes('--verify')
  const outPath = join(repoRoot, flagValue(argv, '--out') || 'lib/client.js')

  let result
  try {
    result = buildMultiBundle()
    // Independent module factories are release inputs, never embedded in Center.
    const children = buildMultiBundle({ subPackages: CLIENT_SUB_PACKAGES }).blocks.slice(1)
    for (let i = 0; i < children.length; i++) {
      const target = join(repoRoot, 'packages', CLIENT_SUB_PACKAGES[i], 'lib/client.js')
      const code = children[i].code.trimEnd() + '\n'
      if (check || verifyOnly) {
        if (!existsSync(target) || readFileSync(target, 'utf8') !== code) throw new BuildError('模块产物过期：' + target)
      } else writeBundle({ id: children[i].id, code }, target)
    }
  } catch (error) {
    console.error('✗ 多块打包失败：' + error.message)
    return 1
  }

  const expected = result.blocks.map((block) => block.id)
  const report = verifyProduct(result.code, expected)
  if (report.problems.length > 0) {
    for (const problem of report.problems) console.error('✗ ' + problem)
    return 1
  }

  const existed = existsSync(outPath)
  const before = existed ? readFileSync(outPath, 'utf8') : null

  if (verifyOnly) {
    const current = verifyProduct(before || '', expected)
    const same = before === result.code
    console.log(
      '✓ 体检：' + expected.length + ' 段注册 / id 唯一 / 无行首 import-export'
      + '；动态 import() 出现 ' + report.dynamicImports.length + ' 次，代码区 '
      + report.dynamicInCode.length + ' 次；产物' + (same ? '与源码一致' : '**不是最新的**'),
    )
    if (current.problems.length > 0) {
      for (const problem of current.problems) console.error('  ✗ 当前产物：' + problem)
      return 1
    }
    return same ? 0 : 1
  }

  if (check) {
    if (before === result.code) {
      console.log('✓ ' + relative(repoRoot, outPath) + ' 与源码一致（' + expected.length + ' 段注册，' + Buffer.byteLength(result.code, 'utf8') + ' 字节）')
      return 0
    }
    console.error('✗ ' + relative(repoRoot, outPath) + ' 不是最新的：源码改过但没重新打包。跑 npm run build。')
    return 1
  }

  if (before === result.code) {
    console.log('✓ 无需改动（' + expected.length + ' 段注册）')
    return 0
  }
  try {
    writeBundle(result, outPath)
  } catch (error) {
    console.error('✗ ' + error.message)
    return 1
  }
  console.log(
    '✓ 已生成 ' + relative(repoRoot, outPath) + '（' + expected.length + ' 段注册：'
    + expected.join(' / ') + '，' + Buffer.byteLength(result.code, 'utf8') + ' 字节）',
  )
  console.log('  客户端半边支持热替换：刷新页面即生效，不用重启 DSH。')
  return 0
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])
if (invokedDirectly) process.exitCode = main(process.argv.slice(2))
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
