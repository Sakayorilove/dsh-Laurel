/**
 * laurel-context/overlay —— 用 `internal/config` 钩子把预设里的压缩提供者换成 Laurel（S8）。
 *
 * ## 为什么是这个钩子
 *
 * 桌面 profile 的四个 agent 预设（standard / ptc / minimal / cordis）每个都在自己的
 * `config.plugins` 里写了一段：
 *
 * ```yaml
 * - id: compaction
 *   name: cordis:group
 *   group: true
 *   isolate: { compaction: true, toolResultPruner: true }
 *   config:
 *     - id: compaction-basic
 *       name: '@deepseek-ai/dsh-compaction-basic'
 *     - id: command-compact
 *       name: '@deepseek-ai/dsh-command-compact'
 * ```
 *
 * `isolate: { compaction: true }` 让这个组用**自己的私有 symbol** 解析 `compaction`
 * （陷阱 3 / `LocalRealm.suffix = '#'+entry.options.id`），所以根层 `ctx.provide`
 * 永远到不了组里 —— 这就是 L08 里 `hostCompaction.reason === 'isolated-sibling'`
 * 的根因。要接管只能**在组内部换装**，而唯一不需要手改 profile 的换装点就是
 * `internal/config` 这个 waterfall 钩子：把 compaction-basic 那一行的 `name`
 * 换成 `laurel-context/compaction`（匹配按 `name`，不按 `id`）。空转时一行都
 * 不匹配、原样返回，所以重复派发是幂等的。
 *
 * **只碰压缩提供者这一层**：其它行一个都不动。
 *
 * ## 这里还放共享运行态
 *
 * `laurel-context/compaction` 子入口会被**四个预设各加载一次**，`lib/index.js`
 * 又会在根层加载一次。三者必须是同一份 vault / 同一份引擎（S7 第 3 条：
 * 「全局入口把 provider 实现以共享模块方式暴露给子入口，不要各造一套」）。
 * 在 node 里，同一个文件路径被 import 多次拿到的是**同一个模块实例**，
 * 所以模块级 registry 就是那条共享通道 —— 不引入新文件，也不依赖任何宿主 API。
 */

/** 只处理这一个配置节；其它 entry 的 config 原样放行。 */
export const AGENT_PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset'

/** 宿主的两个压缩提供者行。 */
export const COMPACTION_BASIC_PACKAGE = '@deepseek-ai/dsh-compaction-basic'
export const COMMAND_COMPACT_PACKAGE = '@deepseek-ai/dsh-command-compact'

/** 换装目标：本包 `package.json` 的 `exports["./compaction"]`。 */
export const LAUREL_COMPACTION_ENTRY = 'laurel-context/compaction'

/** `internal/config` 钩子的选项。`global: true` 让根层监听器对所有 entry 生效。 */
export const GLOBAL_HOOK_OPTIONS = Object.freeze({ global: true })

// ─────────────────────────────────────────────────── 预设闸门（S8-A）

/**
 * 预设闸门服务名。
 *
 * ## 为什么需要它（S8 的真根因）
 *
 * `internal/config` 只在 **fiber 激活/重载** 时派发一次（`cordis/src/fiber.ts`
 * 的 `_resolveConfig`）。桌面 profile 的四个 `include:preset-*` 行在
 * `@deepseek-ai/dsh-web-app` 这一层就被插进根树，装载顺序排在 `laurel-center`
 * 之前 —— 等我们的钩子挂上时，四个预设（连同组里的 `compaction-basic` 行）
 * 早已 ACTIVE，那次派发永远补不回来。真机读数就是这个：`dispatches:36`、
 * `presetsSeen:0`、`presetEntries` 四行 `fiber:"2"(ACTIVE)`。
 *
 * ## 闸门怎么起作用
 *
 * cordis 的 entry 支持 `inject: [服务名]`：inject 里点名的服务没 provide 之前，
 * 该 fiber 停在 PENDING，不会激活。所以只要给四个预设行加上
 * `inject: [laurelContextPresetGate]`，它们就会一直等到本模块 apply 时把这个
 * 服务 provide 出来 —— 而 apply 里**先 provide 闸门、再挂钩子**，于是预设激活
 * 的那一刻钩子一定已在位，`internal/config` 才真的能被我们换装。
 *
 * 同样的思路：给预设行加 inject 让它们等一个服务，服务 provide 之后预设才激活。
 * 区别是**这里用的是 Laurel 自己的服务名**，不依赖任何外部插件。
 *
 * ## 代价（必须写明，不能藏）
 *
 * 这四个预设行从此**硬依赖**本模块：`laurel-context` 被 disabled 时闸门没人
 * provide，预设不会激活（表现是「起不来 agent」，而不是静默地退回宿主压缩）。
 * 这是刻意的选择 —— 静默退回会让「谁在压」再次不可判定，正是 L08 的老病。
 * profile 里的 `inject` 行旁有同样的注释。
 */
export const LAUREL_PRESET_GATE = 'laurelContextPresetGate'

/**
 * 把闸门服务 provide 出去（每个进程只需一次，重复调用幂等）。
 *
 * `ctx.reflect.provide` 是 cordis 的底层提供入口（`ctx.provide` 是它的语法糖）；
 * 在同一个函数里既挂钩子又 provide 时直接走 `ctx.reflect?.provide?.`，
 * 更不容易被类型层挡住。这里两条路都试：宿主给哪条用哪条。
 *
 * @returns `{ ok, name, via, reason, error }`
 */
export function providePresetGate(ctx) {
  const out = { ok: false, name: LAUREL_PRESET_GATE, via: null, reason: null, error: null }
  if (!ctx) { out.reason = 'no-ctx'; return out }
  const value = Object.freeze({ owner: 'laurel-context', purpose: 'S8 预设闸门：等 Laurel 钩子挂好再激活预设' })
  try {
    if (typeof ctx.reflect?.provide === 'function') {
      ctx.reflect.provide(LAUREL_PRESET_GATE, value)
      out.ok = true
      out.via = 'reflect'
      return out
    }
  } catch (e) {
    // 已经 provide 过会抛 "already provided" —— 幂等，不算失败。
    const msg = String(e?.message ?? e)
    if (/already provided|has been registered/i.test(msg)) {
      out.ok = true
      out.via = 'reflect'
      out.reason = 'already-provided'
      return out
    }
    out.error = msg
  }
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide(LAUREL_PRESET_GATE, value)
      out.ok = true
      out.via = 'provide'
      return out
    }
  } catch (e) {
    const msg = String(e?.message ?? e)
    if (/already provided|has been registered/i.test(msg)) {
      out.ok = true
      out.via = 'provide'
      out.reason = 'already-provided'
      return out
    }
    out.error = msg
  }
  if (!out.reason) out.reason = out.error ? 'provide-failed' : 'unsupported-shape'
  return out
}

// ─────────────────────────────────────────────────────────── 纯函数：换装

/**
 * 把 rows 里指向宿主压缩提供者的行换成 Laurel（纯函数，不依赖任何 ctx）。
 *
 * 输入 rows 数组 → 输出 `{ rows, changes, ... }`：
 *  · `rows`    —— 新数组（没改动的行是**同一个对象引用**，方便调用方比对）；
 *  · `changes` —— 逐条改动记录（谁、从什么、到什么、原来是不是 disabled）；
 *  · `swappedRows` / `remainingBasicRows` —— 供端点与断言读数。
 *
 * 三条规则：
 *  1. `name === '@deepseek-ai/dsh-compaction-basic'` → 换成 `laurel-context/compaction`
 *     并 `disabled: false`（别的钩子可能已经把它关掉了，这里必须显式打开）。
 *     其余字段（id / config / 别的宿主自留字段）原样保留 —— 只换实现。
 *  2. `name === '@deepseek-ai/dsh-command-compact'` → 只把 `disabled` 掰回 false，
 *     让 `/compact` 继续可用（它在同一个组里解析 `compaction`，解析到的就是 Laurel）。
 *  3. `row.group === true && Array.isArray(row.config)` → **递归**穿进组。
 *     这层递归是关键：预设的 compaction 组是 `group: true` 的嵌套行，
 *     不穿进去就只能看到组壳（`id: compaction`），永远匹配不到里面的实现行。
 *
 * `isolate` 一律不动（陷阱 3）：provider 要在组自己的 LocalRealm 里加载，
 * agent 才天然看得见。把 isolate 拆掉才是 `service "compaction" has been registered`
 * 那条死路的来源。
 *
 * @param {Array} rows 预设的 `config.plugins`
 * @param {{target?: string}} [options]
 */
/**
 * 让已经激活的预设行重新解析一次 `internal/config`。
 *
 * ## 为什么需要（S8-A 的第二半）
 *
 * profile 里给四个预设行加 `inject: [laurelContextPresetGate]` 只能解决**下次**
 * 装载的时序：`Entry.update()` 在 fiber 已存在且 `config` 没变时直接 return，
 * 不会重跑 `_resolveConfig`，所以已经在 ACTIVE 的行**不会**因为 patch 里多了个
 * inject 就重新派发。recomposition 也只重载文件变了的插件。
 *
 * `Fiber.update(config, noSave)` 是宿主给的唯一合法入口：它先跑
 * `_resolveConfig()`（也就是派发一次 `internal/config`），再 `restart()` 插件。
 * 这里传**它自己现有的 config**、并置 `noSave=true`，所以：
 *   · 配置文件一个字节都不写（`noSave` 跳过 `internal/update` 的持久化钩子）；
 *   · 插件被重启一次（预设组重新挂载，agent 侧看到的是新配置）。
 *
 * ## 边界
 *
 * 只对 `name === AGENT_PRESET_PACKAGE` 的顶层预设行动手，只调 `update`，
 * 不改 `options`、不改 `config`、不 dispose。任何一步不满足就原样跳过并记进
 * `out.skipped`（不许"试一下再说"）。
 *
 * @returns `{ ok, nudged: string[], skipped: Array<{id,why}>, error }`
 */
export function nudgePresetEntries(ctx, { log = null, limit = 8 } = {}) {
  const out = { ok: false, nudged: [], skipped: [], error: null }
  let loader = null
  try { loader = ctx?.get?.('loader') ?? null } catch { loader = null }
  if (typeof loader?.entries !== 'function') {
    out.error = '拿不到 loader 服务（宿主未提供 entries()）'
    return out
  }
  const rows = []
  try {
    for (const entry of loader.entries()) {
      const name = entry?.options?.name ?? null
      if (name !== AGENT_PRESET_PACKAGE) continue
      rows.push(entry)
      if (rows.length >= limit) break
    }
  } catch (e) {
    out.error = `枚举 loader 失败：${String(e?.message ?? e)}`
    return out
  }
  for (const entry of rows) {
    const id = entry?.options?.id ?? entry?.id ?? '(no-id)'
    const fiber = entry?.fiber ?? null
    if (!fiber || typeof fiber.update !== 'function') {
      // 没 fiber = 还没装载，激活时自然会派发，不需要推。
      out.skipped.push({ id, why: fiber ? 'fiber.update 不可用' : 'fiber 还未创建（激活时会自然派发）' })
      continue
    }
    if (fiber.state !== 2) {
      out.skipped.push({ id, why: `fiber 状态 ${String(fiber.state)} 不是 ACTIVE` })
      continue
    }
    try {
      // 传它自己的 config，只为了触发一次 _resolveConfig()；noSave 保证不写盘。
      fiber.update(entry.options?.config, true)
      out.nudged.push(String(id))
      try { log?.info?.(`S8-A：已让预设行 ${String(id)} 重新解析配置（Fiber.update noSave）`) } catch { /* 日志失败不影响 */ }
    } catch (e) {
      out.skipped.push({ id, why: `update 抛错：${String(e?.message ?? e)}` })
    }
  }
  out.ok = out.nudged.length > 0
  return out
}

export function swapCompactionProvider(rows, options = {}) {
  const target = options.target ?? LAUREL_COMPACTION_ENTRY
  if (!Array.isArray(rows)) {
    return { rows, changes: [], swappedRows: 0, remainingBasicRows: 0, note: 'rows 不是数组，原样返回' }
  }

  const changes = []

  const walk = (list, trail) => {
    let touched = false
    const out = list.map((row, i) => {
      if (!row || typeof row !== 'object') return row
      const at = `${trail}[${i}]${row.id ? `#${row.id}` : ''}`

      if (row.name === COMPACTION_BASIC_PACKAGE) {
        touched = true
        changes.push({
          kind: 'swap-provider',
          at,
          id: row.id ?? null,
          from: COMPACTION_BASIC_PACKAGE,
          to: target,
          wasDisabled: row.disabled === true,
        })
        // 只换 name + 强制启用；id / config / 其它宿主字段全部保留。
        return { ...row, name: target, disabled: false }
      }

      if (row.name === COMMAND_COMPACT_PACKAGE) {
        if (row.disabled === true) {
          touched = true
          changes.push({
            kind: 're-enable-command',
            at,
            id: row.id ?? null,
            from: COMMAND_COMPACT_PACKAGE,
            to: COMMAND_COMPACT_PACKAGE,
            wasDisabled: true,
          })
          return { ...row, disabled: false }
        }
        return row
      }

      if (row.group === true && Array.isArray(row.config)) {
        const kids = walk(row.config, `${at}/`)
        if (kids !== row.config) {
          touched = true
          return { ...row, config: kids }
        }
        return row
      }

      return row
    })
    return touched ? out : list
  }

  const next = walk(rows, '')
  const swappedRows = changes.filter((c) => c.kind === 'swap-provider').length
  return {
    rows: next,
    changes,
    swappedRows,
    reEnabledCommands: changes.filter((c) => c.kind === 're-enable-command').length,
    // 换完之后还剩几行仍然指向宿主实现（正常必须是 0，读到非 0 就是没换干净）
    remainingBasicRows: countRowsByName(next, COMPACTION_BASIC_PACKAGE),
  }
}

/** 递归数「name 完全等于」的行数（只读，用于换装后自检）。 */
export function countRowsByName(rows, name) {
  let n = 0
  const walk = (list) => {
    if (!Array.isArray(list)) return
    for (const row of list) {
      if (!row || typeof row !== 'object') continue
      if (row.name === name) n += 1
      if (Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(rows)
  return n
}

/**
 * 诊断：根层 `@deepseek-ai/dsh-agent-preset` entry 的装载实况。
 *
 * `presetsSeen === 0` 有三个可能的世界，读数必须能分开：
 *   ① 勾子挂晚了 —— 预设 entry 在我们 `ctx.on('internal/config', …)` 之前就
 *      已经解析完（`fiber` 已存在且状态 ACTIVE）→ 需要更早的挂载点/复算机制；
 *   ② entry 根本还没装载（`fiber` 不存在）→ 等它装载时会派发，属于正常等待；
 *   ③ 装载了但 config 里 `plugins` 不是数组 → 我们判据里的守卫把整节跳过了。
 *
 * 只读：遍历 `loader.entries()` 及其 `fiber.state`，不改任何东西。
 */
// S8c-DIAG-BEGIN
/**
 * 诊断：把 loader 树里**所有**条目列出来（不限 name），用来判断预设行到底在不在
 * 我们看得见的 `loader.entries()` 里。
 *
 * 为什么需要这条：`describePresetEntries()` 只留 `name === '@deepseek-ai/dsh-agent-preset'`
 * 的条目，真机上返回 `[]`。但这有两种完全不同的原因，处置完全不同：
 *   · A 预设行**确实不在**我们这棵树里（agent-preset-registry 的内存 PresetTree，write(){}）；
 *   · B 预设行在，只是我们取 loader 服务的路径/形状不对。
 * 全量枚举 + `loaderAvailable` 标志能一次分清。
 */
export function describeLoaderTree(ctx, { limit = 80 } = {}) {
  let loader = null
  try { loader = ctx?.get?.('loader') ?? null } catch { loader = null }
  const out = {
    loaderAvailable: !!loader,
    hasEntries: typeof loader?.entries === 'function',
    total: 0,
    presetRows: 0,
    entries: [],
    error: null,
  }
  if (!out.hasEntries) return out
  try {
    for (const entry of loader.entries()) {
      out.total += 1
      const opts = entry?.options ?? {}
      const name = opts.name ?? null
      if (name === AGENT_PRESET_PACKAGE) out.presetRows += 1
      if (out.entries.length < limit) {
        out.entries.push({
          id: opts.id ?? entry?.id ?? null,
          name,
          disabled: opts.disabled === true,
          group: opts.group === true,
          // inject 是关键：外部插件靠给预设行加 inject 让它们等自己的服务，从而拿到
          // internal/config 的那次派发。这里把真实 inject 打出来做对照。
          inject: Array.isArray(opts.inject) ? opts.inject : null,
          fiber: entry?.fiber ? String(entry.fiber.state) : null,
          hasSubtree: !!entry?.subtree,
        })
      }
    }
  } catch (e) {
    out.error = String(e?.message ?? e)
  }
  return out
}

export function describePresetEntries(ctx) {
  const out = []
  // S8 关键修正：预设的插件树**不在** profile loader 的 entries() 里。
  // `@deepseek-ai/dsh-agent-preset-registry` 用内存 `PresetTree extends EntryTree`
  // 且 `write(){}`（不持久化），所以遍历 loader.entries() 永远返回空 ——
  // 这就是 `presetEntries:[]` 的成因。真正的树挂在 `agentPresets` 服务的
  // `generations` Map 里：`generation.mount.tree` 才是活的那棵。
  // 下面把两条来源都读一遍，端点就能分辨「loader 里没有」与「agentPresets 里有」。
  try {
    const svc = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : ctx?.agentPresets
    const gens = svc?.generations
    if (gens && typeof gens.values === 'function') {
      for (const gen of gens.values()) {
        const tree = gen?.mount?.tree
        const presetId = gen?.mount?.presetId ?? null
        if (!tree || typeof tree.entries !== 'function') continue
        for (const entry of tree.entries()) {
          const opts = entry?.options ?? {}
          const isGroup = opts.group === true
          const rows = isGroup && Array.isArray(opts.config) ? opts.config : null
          out.push({
            source: 'agentPresets',
            presetId,
            id: entry?.id ?? opts.id ?? null,
            name: opts.name ?? null,
            group: isGroup,
            fiber: entry?.fiber ? String(entry.fiber.state ?? 'unknown') : null,
            hasFiber: entry?.fiber != null,
            hasSubgroup: entry?.subgroup != null,
            hasSubtree: entry?.subtree != null,
            isolate: opts.isolate ?? null,
            rowCount: rows ? rows.length : null,
            basicRows: rows ? countRowsByName(rows, COMPACTION_BASIC_PACKAGE) : null,
            laurelRows: rows ? countRowsByName(rows, LAUREL_COMPACTION_ENTRY) : null,
            rowNames: rows ? rows.map((r) => r?.name ?? null).slice(0, 6) : null,
          })
        }
      }
    }
  } catch { /* 诊断失败不影响主流程 */ }

  let loader
  try {
    loader = typeof ctx?.get === 'function' ? ctx.get('loader') : ctx?.loader
  } catch {
    loader = undefined
  }
  if (!loader || typeof loader.entries !== 'function') return out
  try {
    for (const entry of loader.entries()) {
      const opts = entry?.options ?? {}
      if (opts.name !== AGENT_PRESET_PACKAGE) continue
      const raw = opts?.config?.plugins
      // entry.options.config 是**原始**配置（`!!js` 未求值、patch 未合并前的解析结果），
      // fiber.config 才是真正交给插件的**解析后**配置。换装到底有没有落地，只能看后者 ——
      // 只看 options 会永远看到宿主那行还在（我们自己的 swap 也写在 resolved 上）。
      const resolved = entry?.fiber?.config?.plugins
      out.push({
        source: 'loader',
        id: entry?.id ?? opts.id ?? null,
        presetId: opts?.config?.id ?? null,
        fiber: entry?.fiber ? String(entry.fiber.state ?? 'unknown') : null,
        hasFiber: entry?.fiber != null,
        // 闸门机制靠给这些行加 inject 让预设等它的服务；
        // 这个字段为空说明闸门没生效，预设会在任何钩子挂上之前就激活。
        inject: Array.isArray(opts?.inject) ? opts.inject.slice(0, 6) : (opts?.inject ?? null),
        pluginsIsArray: Array.isArray(raw),
        pluginCount: Array.isArray(raw) ? raw.length : null,
        basicRows: Array.isArray(raw) ? countRowsByName(raw, COMPACTION_BASIC_PACKAGE) : null,
        resolvedBasicRows: Array.isArray(resolved)
          ? countRowsByName(resolved, COMPACTION_BASIC_PACKAGE)
          : null,
        resolvedLaurelRows: Array.isArray(resolved) ? countRowsByName(resolved, LAUREL_COMPACTION_ENTRY) : null,
      })
    }
  } catch { /* 诊断失败不影响主流程 */ }
  return out
}

// ─────────────────────────────────────────────────────────── 共享运行态

/**
 * 模块级共享仓：`lib/index.js` 与 `lib/compaction-entry.mjs` 各自 apply 一次，
 * 但必须共用同一个 vault / engine（S7 第 3 条）。
 */
const runtime = {
  vault: null,
  vaultDir: null,
  engine: null,
  gateway: null,
  sessionId: null,
  /** 本进程里所有由 Laurel 提供出去的 compaction 实现（用来判"占位的是自己人"）。 */
  providers: new Set(),
}

/** 读共享运行态（只读视图；调用方不要直接改字段）。 */
export function sharedRuntime() {
  return runtime
}

/** 合并写入共享运行态（只写显式给出的字段，不覆盖未提及的字段）。 */
export function shareLaurelRuntime(patch = {}) {
  for (const key of ['vault', 'vaultDir', 'engine', 'gateway', 'sessionId']) {
    if (patch[key] !== undefined && patch[key] !== null) runtime[key] = patch[key]
  }
  return runtime
}

/** 登记一个由 Laurel 提供的 compaction 实现。 */
export function registerLaurelProvider(provider) {
  if (provider && typeof provider === 'object') runtime.providers.add(provider)
  return provider
}

/** 这个实现是不是 Laurel 自己提供出去的（`occupied` 时要靠它区分"自己人"和宿主）。 */
export function isLaurelProvider(value) {
  return !!value && typeof value === 'object' && runtime.providers.has(value)
}

/** 已登记的 Laurel provider 个数。 */
export function laurelProviderCount() {
  return runtime.providers.size
}

/**
 * 取一个已登记的 Laurel provider（最近登记的那个）。
 *
 * 自动压缩的触发器必须调用**真正在组里那份**实现：预设换装之后 agent 解析到的是
 * `compaction-entry` 建的门面，根层那个 `providedProvider` 可能压根没 provide 成功
 * （`isolated-sibling`）。所以触发器每轮现取，而不是绑死构造期那一个。
 */
export function firstLaurelProvider() {
  let last = null
  for (const p of runtime.providers) last = p
  return last
}

// ─────────────────────────────────────────────────────────── 钩子装配

/** 一个新的 overlay 统计状态（每次 `registerOverlay` 一份）。 */
export function createOverlayState() {
  return {
    handlerInstalled: false,
    hooksRegistered: 0,
    registrationError: null,
    /** 见过的 agent-preset 配置节数。 */
    presetsSeen: 0,
    /** 其中真的被换装的 / 无需改动的。 */
    presetsSwapped: 0,
    presetsUnchanged: 0,
    /** 累计换掉的宿主压缩提供者行数。 */
    basicRowsSwapped: 0,
    commandCompactEnforced: 0,
    /** 换装后仍指向宿主实现的行数（**最坏一次**；正常恒 0）。 */
    basicRowsLeftAfterSwap: null,
    rowsScanned: 0,
    lastPresetId: null,
    lastPresetAt: null,
    lastSwapAt: null,
    /** 最近几次改动的明细（有上限，避免长跑吃内存）。 */
    changes: [],
    /**
     * 诊断：钩子一共被派发了多少次，以及每次的 entry 名字（只留前 40 个）。
     *
     * `presetsSeen === 0` 有两种完全不同的原因，读数一样但修法相反：
     *   ① 钩子**从没被派发**（presets 在我们挂上钩子之前就已经解析完了）；
     *   ② 派发了，但 `this.entry.options.name` 不是 agent-preset（判据写错）。
     * 不数这两个数就只能靠猜，而"看起来一样"正是这本手册里所有陷阱的来源。
     */
    dispatches: 0,
    seenEntryNames: [],
    /** 诊断：根层 agent-preset entry 的装载实况（有没有 fiber、什么状态）。 */
    presetEntries: [],
  }
}

/**
 * 「换装是不是已经在预设里落地」—— 端点与 owner 仲裁用的唯一判据。
 *
 * 三个条件同时成立才算：钩子真的挂上了、至少换掉过一行、换完之后不再有
 * 指向宿主实现的行残留。任一不成立就一律按"没接管"处理，绝不假装。
 */
export function presetTakeoverOf(state) {
  if (!state || state.handlerInstalled !== true) return false
  if ((state.presetsSwapped ?? 0) < 1) return false
  if ((state.basicRowsSwapped ?? 0) < 1) return false
  return (state.basicRowsLeftAfterSwap ?? 0) === 0
}

/** 对外可读的 overlay 摘要（不含 changes 全量）。 */
export function overlayStatusOf(state) {
  if (!state) return null
  return {
    handlerInstalled: state.handlerInstalled,
    hooksRegistered: state.hooksRegistered,
    registrationError: state.registrationError,
    presetsSeen: state.presetsSeen,
    presetsSwapped: state.presetsSwapped,
    presetsUnchanged: state.presetsUnchanged,
    basicRowsSwapped: state.basicRowsSwapped,
    commandCompactEnforced: state.commandCompactEnforced,
    basicRowsLeftAfterSwap: state.basicRowsLeftAfterSwap,
    rowsScanned: state.rowsScanned,
    lastPresetId: state.lastPresetId,
    lastPresetAt: state.lastPresetAt,
    lastSwapAt: state.lastSwapAt,
    presetTakeover: presetTakeoverOf(state),
    recentChanges: state.changes.slice(-5),
    /** 诊断字段：钩子被派发次数 + 见过的 entry 名（分得清"没派发"与"派发了但不是预设"）。 */
    dispatches: state.dispatches ?? 0,
    seenEntryNames: (state.seenEntryNames ?? []).slice(0, 40),
    presetEntries: (state.presetEntries ?? []).slice(0, 12),
  }
}

/**
 * 在根层挂 `internal/config` 钩子。
 *
 * 手写约定（见手册 5.1）：
 *  · 第三个参数必须是 `{ global: true }` —— 没有它，根层监听器只对根层的 entry 生效，
 *    预设是懒加载的**另一个** dispatch，永远看不到；
 *  · 监听器必须是 `function`（不能用箭头函数）—— `this` 绑定到发起 dispatch 的 entry，
 *    只处理 `this.entry.options.name === '@deepseek-ai/dsh-agent-preset'`，
 *    别的配置节一律原样返回，绝不修改。
 *
 * @returns `{ ok, state, status(), dispose() }`；`status()` 每次现算，不缓存。
 */
export function registerOverlay(ctx, { log = null, state = null, target = LAUREL_COMPACTION_ENTRY, enabled = true } = {}) {
  const st = state ?? createOverlayState()
  const status = () => overlayStatusOf(st)
  if (!enabled) return { ok: true, reason: 'engine-not-native', state: st, status, dispose() {} }

  if (!ctx || typeof ctx.on !== 'function') {
    st.registrationError = 'ctx.on 不可用：无法挂 internal/config 钩子'
    return { ok: false, reason: 'no-on', state: st, status, dispose() {} }
  }

  const handler = function internalConfigOverlay(raw, next) {
    // 先让链上后面的解析跑完（waterfall 约定：next() 是"剩下的处理"）。
    let resolved
    try {
      resolved = typeof next === 'function' ? next() : raw
    } catch (e) {
      // 解析失败不是我们的事：原样把异常抛回去，别把它吞成"没接管"。
      throw e
    }

    // 诊断：先把"这次派发到底是谁、resolved 长什么形状"记下来。
    // `presetsSeen===0` 时靠这几个数分因：是没派发、派发了但形状不认识、还是判据写错。
    st.dispatches = (st.dispatches ?? 0) + 1
    const entryName = this?.entry?.options?.name ?? this?.options?.name ?? this?.entry?.name ?? null
    const shape = Array.isArray(resolved)
      ? `array[${resolved.length}]`
      : (resolved && typeof resolved === 'object'
          ? (Array.isArray(resolved.plugins)
              ? `preset{plugins[${resolved.plugins.length}]}`
              : `obj{${Object.keys(resolved).slice(0, 6).join(',')}}`)
          : String(resolved === null ? 'null' : typeof resolved))
    {
      const list = st.seenEntryNames ?? (st.seenEntryNames = [])
      const tag = `${String(entryName)}${this?.entry?.options?.id ? `#${this.entry.options.id}` : ''}=${shape}`
      if (!list.includes(tag) && list.length < 40) list.push(tag)
    }

    // S8 修正：判据从「entry 名等于 '@deepseek-ai/dsh-agent-preset'」改成**看配置形状**。
    //
    // 为什么原来的判据在真机上一次都不命中（dispatches:36，presetsSeen:0）：
    // 预设的插件树是 `@deepseek-ai/dsh-agent-preset-registry` 里的**内存 PresetTree**
    // （`PresetTree extends EntryTree` 且 `write(){}`），根本不挂在 profile loader 的
    // entries() 里 —— 端点 `presetEntries:[]` 就是这件事的直接证据。所以
    // 「预设顶层那一行（name = agent-preset）」的 internal/config 派发我们永远收不到。
    // 但预设里的**子行**激活时照样各自 waterfall 一次 internal/config，
    // seenEntryNames 里出现的 `@deepseek-ai/dsh-agent-loop#agent-loop` 就是它们。
    // 要真正换装，只能在子行解析配置的那一刻改写 —— 也就是判形状、不看名字。
    //
    // 收两种形状：
    //  · A 形 `{ plugins: [...] }`：预设定义对象（顶层那行若被派发到，走这条）；
    //  · B 形 `[...]`（顶层就是数组）：组（`cordis:group`）的子行数组 ——
    //    预设里 `compaction` 组的 config 正是 `[compaction-basic, command-compact,
    //    tool-result-pruner]`，宿主压缩提供者那一行就在这里。
    //
    // 不会误伤别处：`swapCompactionProvider` 只重写 `name` 精确等于
    // `@deepseek-ai/dsh-compaction-basic` / `@deepseek-ai/dsh-command-compact` 的行，
    // 其余行**对象引用原样保留**；一行都不匹配时 `changes` 为空、直接原样返回。
    const isPresetObject = !Array.isArray(resolved) && Array.isArray(resolved?.plugins)
    const isRowArray = Array.isArray(resolved)
    if (!isPresetObject && !isRowArray) return resolved

    const presetId = this?.entry?.options?.id ?? this?.entry?.id ?? null
    const now = Date.now()

    /** 换一份行数组；返回 {rows, out} 或 null（没东西可换）。 */
    const swapRows = (rows) => {
      const out = swapCompactionProvider(rows, { target })
      if (out.changes.length === 0) return null
      st.presetsSwapped += 1
      st.basicRowsSwapped += out.swappedRows
      st.commandCompactEnforced += out.reEnabledCommands
      // 取最坏情况的残留数：任何一个预设换完还留着宿主实现行，就不算接管完成。
      st.basicRowsLeftAfterSwap = Math.max(st.basicRowsLeftAfterSwap ?? 0, out.remainingBasicRows)
      st.lastSwapAt = now
      st.lastSwapId = presetId
      st.changes.push({
        at: now,
        presetId,
        shape: isRowArray ? 'rows' : 'preset',
        swapped: out.swappedRows,
        reEnabled: out.reEnabledCommands,
        remainingBasicRows: out.remainingBasicRows,
        items: out.changes.slice(0, 8),
      })
      if (st.changes.length > 20) st.changes.shift()
      try {
        log?.info?.(
          `internal/config 换装 ${String(presetId)}（${isRowArray ? '组行数组' : '预设定义'}）：`
          + `${out.swappedRows} 行压缩提供者 → ${target}`
          + `（command-compact 启用 ${out.reEnabledCommands}，残留宿主行 ${out.remainingBasicRows}）`,
        )
      } catch { /* 日志失败不影响换装 */ }
      return out.rows
    }

    st.presetsSeen += 1
    st.rowsScanned += isRowArray ? resolved.length : resolved.plugins.length
    st.lastPresetId = presetId
    st.lastPresetAt = now

    if (isRowArray) {
      const rows = swapRows(resolved)
      return rows === null ? resolved : rows
    }

    const outRows = swapRows(resolved.plugins)
    if (outRows === null) { st.presetsUnchanged += 1; return resolved }
    return { ...resolved, plugins: outRows }
  }

  let dispose = null
  try {
    const ret = ctx.on('internal/config', handler, GLOBAL_HOOK_OPTIONS)
    if (typeof ret === 'function') {
      dispose = ret
    } else if (ctx.effect) {
      // cordis 的 on 通常返回 dispose；有的版本把注销挂在 effect 上。
      try { ctx.effect(() => ret) } catch { /* ignore */ }
    }
    st.hooksRegistered = 1
    st.handlerInstalled = true
  } catch (e) {
    st.registrationError = String(e?.message ?? e)
    return { ok: false, reason: 'on-failed', error: st.registrationError, state: st, status, dispose() {} }
  }

  return {
    ok: true,
    state: st,
    status,
    dispose() {
      st.handlerInstalled = false
      st.hooksRegistered = 0
      if (typeof dispose === 'function') { try { dispose() } catch { /* ignore */ } }
    },
  }
}
