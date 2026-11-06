/**
 * Laurel-Center · 宿主原生管理适配层
 *
 * ── 这一层存在的理由（R1 / R2 / R6）────────────────────────────────────────
 * 旧实现自己拿 `loader.update()` 改 loader 行、自己往 `$DSH_HOME/laurel-center/state.json`
 * 记账。两处都是「第二份真相」：
 *   · `loader.update()` 会触发 Include.write()，把**组合后的整棵树**写回 profile 的
 *     基础 `cordis.yml`；再挂载时又叠一次 insert patch → 出现重复行。
 *   · state.json 是开机同步源，它会**盖掉**用户层（profile 的 `cordis.patch.yml`）里
 *     显式写的决定 —— 优先级被较低层绕过。
 *
 * 宿主的 `pluginManager` 已经把这件事做对了：
 *   · `setPluginEnabled(entryId, enabled)` 写的是 **profile 的 cordis.patch.yml**（用户层，
 *     优先级最高），再走宿主自己的 reload/HMR 流程；基础 cordis.yml 不动。
 *   · 整个变更在 `withFileLock(profile/package.json)` 里跑，HMR 存在时还串行化 —— 并发有定序。
 *   · 结果带 `application: applied | restart-required | overridden | failed | cancelled`，
 *     失败有 `error.code`，不再需要我们自己猜「成功了没」。
 *
 * 所以本模块只做**翻译**：把 Center 的四个稳定 id 翻成宿主 loader 行的原生身份，
 * 再把结果翻成 Center 的逐项结果合同。持久化、加锁、应用全部交回宿主。
 *
 * ── 为什么不用裸 HTTP 端点（R2）───────────────────────────────────────────
 * 宿主 WebServer 会把任意注册路由分发给调用者；认证只封在原生 `/api` 通道里。
 * 注册一个 prefix **不会**继承认证。所以 Center 不再暴露任何写接口：
 * 前端走 `remote.pluginManager`（原生认证 RPC），宿主半边只做只读诊断。
 *
 * ── 拿不到原生能力时不许抛 ────────────────────────────────────────────────
 * 装载机坏掉不许连累 DSH 主流程。所有函数返回带 `state` 的结果，不 throw。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SUB_PLUGINS, subPlugin } from './registry.js'
import { interpretChangeResult, normalizeApplication } from './change-result.js'
import { readUserOverrides } from './patch.js'

/** 安全取服务：cordis 的 Context 是受控代理，没写进 inject 的服务直接访问会抛。 */
export function getService(ctx, name) {
  try {
    return ctx.get?.(name) ?? null
  } catch {
    return null
  }
}

/** 原生管理通道是否可用（宿主装了 pluginManager 才有）。 */
export function nativeAvailable(ctx) {
  return typeof getService(ctx, 'pluginManager')?.setPluginEnabled === 'function'
}

/**
 * 用户层 patch 文件（F1 / F2 都靠它）。
 *
 * 两个来源都收：
 *   · `pluginManager.profile.patchPath` —— 管理器实际写的那个文件（权威）
 *   · `profileContext.patchPath` / `profileContext.home/cordis.patch.yml` —— 启动期上下文
 * 拿不到任何路径就返回空数组，上层据此走「判不出归属」的保守分支。
 */
export function userPatchPaths(ctx) {
  const paths = []
  const push = (p) => { if (typeof p === 'string' && p.length > 0 && !paths.includes(p)) paths.push(p) }
  const pm = getService(ctx, 'pluginManager')
  push(pm?.profile?.patchPath)
  const profileCtx = getService(ctx, 'profileContext')
  push(profileCtx?.patchPath)
  if (typeof profileCtx?.home === 'string' && profileCtx.home.length > 0) push(join(profileCtx.home, 'cordis.patch.yml'))
  return paths
}

/** 宿主自己的 package.json —— 用来解析宿主已装的 `yaml`（与宿主同一份解析器）。 */
export function installAnchorOf(ctx) {
  const profileCtx = getService(ctx, 'profileContext')
  return typeof profileCtx?.installAnchor === 'string' ? profileCtx.installAnchor : null
}

/**
 * 读用户层的显式条目。
 * @returns {ReturnType<typeof readUserOverrides>}
 */
export function readOverrides(ctx) {
  return readUserOverrides(userPatchPaths(ctx), { installAnchor: installAnchorOf(ctx) })
}

/** 当前 profile 的身份（迁移按它分别记完成状态）。 */
export function profileIdentityOf(ctx) {
  const profileCtx = getService(ctx, 'profileContext')
  const dir = typeof profileCtx?.dir === 'string' && profileCtx.dir.length > 0 ? profileCtx.dir : null
  const name = typeof profileCtx?.name === 'string' && profileCtx.name.length > 0 ? profileCtx.name : null
  if (dir === null && name === null) return { ok: false, key: null, reason: 'no-profile-context' }
  return { ok: true, key: dir ?? name, name, dir }
}

/** 用户层里某个 id 的显式目标开关值；没有显式条目 / 没有 disabled 字段 → null（回读不出）。 */
export function targetEnabledOf(overrides, id) {
  const entry = overrides?.[id]
  if (!entry || typeof entry.disabled !== 'boolean') return null
  return entry.disabled === false
}

/**
 * 把一个原生 loader 行映射成 Center 的插件状态。
 *
 * 映射规则（R6）：**只用 `patchId` 精确匹配 Center 声明的稳定 id**，并且
 * `moduleName` 必须等于该子插件声明的包名。同名多行、包名不符、来自别处的一律拒绝，
 * 绝不「猜第一个」。匹配不到就报 `missing`，不试图凭空造行。
 *
 * @returns {{
 *   id: string,
 *   state: 'ready'|'missing'|'ambiguous'|'name-mismatch'|'read-only'|'no-native'|'error',
 *   entryId?: string, moduleName?: string, enabled?: boolean,
 *   fiberPhase?: 'pending'|'loading'|'active'|'failed'|'unloading'|null,
 *   reason?: string, expected?: string, actual?: string, count?: number,
 * }}
 */
function mapRow(spec, rows) {
  const matches = rows.filter((row) => row?.patchId === spec.id)
  if (matches.length === 0) return { id: spec.id, state: 'missing', expected: spec.entry }
  if (matches.length > 1) return { id: spec.id, state: 'ambiguous', count: matches.length, expected: spec.entry }
  const row = matches[0]
  if (row.moduleName !== spec.entry) {
    return { id: spec.id, state: 'name-mismatch', expected: spec.entry, actual: row.moduleName }
  }
  const entryId = row.entryId === undefined ? undefined : String(row.entryId)
  if (row.readOnlyReason) {
    return { id: spec.id, state: 'read-only', reason: String(row.readOnlyReason), entryId, moduleName: row.moduleName }
  }
  return {
    id: spec.id,
    state: 'ready',
    entryId,
    moduleName: row.moduleName,
    enabled: row.enabled === true,
    fiberPhase: row.fiberPhase ?? null,
  }
}

/**
 * 这个子插件的包**真的装在 profile 里**吗？
 *
 * ── 为什么需要它（2026-10-15 实测的真事故）───────────────────────────────
 * **loader 行存在 ≠ 包存在**。实测场景：套件里加了新模块，源码仓库的
 * `cordis.patch.yml` 也插了那一行 —— 而 `laurel-center` 在 profile 里是个 junction
 * 指向源码仓库，所以那行**立刻可见**。于是总控台里新模块那一行照样出现、
 * 开关照样可点，可 profile 还没跑过安装事务。
 *
 * 点下去会怎样（asar 里 `pluginManager.setPluginEnabled` 实测）：
 *   ① `writePluginEnabled(patchPath, patchId, moduleName, enabled)` —— 先写文件
 *   ② `this.reload([patchId])` —— 再重载，这里解析不到包 → 抛非预期异常
 *   ③ 被 `managementError()` 兜底成 `code: 'operation-error'`
 * 结果是：**profile 被写脏了一行**（那个开关已经记成「开」），界面只报一个
 * `operation-error`，真实原因一个字都没有。
 *
 * 所以在这里**先查文件系统**。判据与宿主自己的 `packageDirFromParent()` 同一条规则
 * （它也是找 `<searchPath>/<name>/package.json`）。
 *
 * 判不出时返回 `null`（未知）而**不是** `false`：拿不到 profile 目录、或读目录出错，
 * 都不该当成「包不存在」把一个正常的包拦下来。
 *
 * @param {object} ctx
 * @param {string} entry 子插件包名（registry 的 entry）
 * @returns {boolean | null} true 在 / false 不在 / null 判不出
 */
export function packagePresent(ctx, entry) {
  if (typeof entry !== 'string' || entry.length === 0) return null
  const profileCtx = getService(ctx, 'profileContext')
  const dir = typeof profileCtx?.dir === 'string' && profileCtx.dir.length > 0 ? profileCtx.dir : null
  if (dir === null) return null
  try {
    return existsSync(join(dir, 'node_modules', entry, 'package.json'))
  } catch {
    return null
  }
}

/**
 * 读全部子插件的原生状态。
 *
 * `state: 'ready'` 只说明**那一行 patch 定位得到**，不代表包在 profile 里。
 * 所以 ready 的行再补一个 `packagePresent`（判不出时**不加**这个字段，
 * 上层据此区分「确认不在」与「没判出来」）。状态语义本身不动 —— 迁移与界面
 * 都按 `state` 分支，改语义会波及它们。
 *
 * @returns {Promise<Record<string, ReturnType<typeof mapRow>>>}
 */
export async function listNative(ctx) {
  const out = {}
  const pm = getService(ctx, 'pluginManager')
  if (typeof pm?.listPlugins !== 'function') {
    for (const p of SUB_PLUGINS) out[p.id] = { id: p.id, state: 'no-native', expected: p.entry }
    return out
  }
  let rows
  try {
    rows = await pm.listPlugins()
  } catch (error) {
    const reason = String(error?.message ?? error)
    for (const p of SUB_PLUGINS) out[p.id] = { id: p.id, state: 'error', reason, expected: p.entry }
    return out
  }
  if (!Array.isArray(rows)) {
    for (const p of SUB_PLUGINS) out[p.id] = { id: p.id, state: 'error', reason: 'listPlugins returned non-array', expected: p.entry }
    return out
  }
  for (const p of SUB_PLUGINS) {
    const row = mapRow(p, rows)
    const present = row.state === 'ready' ? packagePresent(ctx, p.entry) : null
    out[p.id] = present === null ? row : { ...row, packagePresent: present }
  }
  return out
}

/** 原生 inventory（fiber 相位）—— listPlugins 已含 fiberPhase，这里只作交叉核对。 */
export async function listInventory(ctx) {
  const inv = getService(ctx, 'pluginInventory')
  if (typeof inv?.list !== 'function') return null
  try {
    const answer = await inv.list()
    return Array.isArray(answer?.entries) ? answer.entries : null
  } catch {
    return null
  }
}

/**
 * 用一个原生 loader 行的身份做开关。
 *
 * 结果由**共用解释器**（lib/change-result.js）给出，宿主半边不再自己猜。
 * 「保存」与「应用」分开：application:failed 但回读确认目标值已到位 → saved:true，
 * 只是没应用上；协议缺字段（undefined）→ outcome:unknown，**不是**成功。
 *
 * @param {object} ctx
 * @param {string} id Center 的稳定 id
 * @param {boolean} enabled
 * @returns {Promise<{
 *   ok: boolean, outcome: string, reason: string, saved: boolean | null, applied: boolean,
 *   hostApplied: boolean, application: string, changed: boolean, restartHelps: boolean,
 *   id: string, code: string, entryId?: string, diagnostic?: string, warnings?: string[],
 * }>}
 */
export async function setNative(ctx, id, enabled) {
  const spec = subPlugin(id)
  if (!spec) return decorate({ outcome: 'failure', saved: false, applied: false, reason: 'unknown-plugin', code: 'unknown-plugin', application: 'unknown', changed: false, restartHelps: false, diagnostic: null }, id)

  const pm = getService(ctx, 'pluginManager')
  if (typeof pm?.setPluginEnabled !== 'function') {
    return decorate({ outcome: 'failure', saved: false, applied: false, reason: 'native-error', code: 'no-native', application: 'unknown', changed: false, restartHelps: false, diagnostic: null }, id)
  }

  const map = await listNative(ctx)
  const row = map[id]
  if (!row || row.state !== 'ready') {
    return decorate({ outcome: 'failure', saved: false, applied: false, reason: 'unaddressable', code: row?.state ?? 'missing', application: 'unknown', changed: false, restartHelps: false, diagnostic: row?.reason ?? null }, id, row?.entryId)
  }

  // 行定位得到，但包不在 profile 里 → **不发原生调用**。
  // 发了的后果（实测）：宿主先写 patch（profile 被写脏），再 reload 抛异常，
  // 兜底成 operation-error，真实原因看不见。这里直接拦下，一个字节都不写。
  if (row.packagePresent === false) {
    return decorate({
      outcome: 'failure', saved: false, applied: false,
      reason: 'package-missing', code: 'package-missing',
      application: 'unknown', changed: false, restartHelps: false,
      diagnostic: null,
    }, id, row.entryId)
  }

  let result
  try {
    result = await pm.setPluginEnabled(row.entryId, enabled === true)
  } catch (error) {
    return decorate(
      interpretChangeResult(null, { requested: enabled === true, transportError: String(error?.message ?? error) }),
      id, row.entryId,
    )
  }

  // 保存与应用是两件事：只有 failed / unknown 才需要回读当前 patch 的最终目标值。
  const application = normalizeApplication(result?.application)
  let confirmTarget = null
  if (application === 'failed' || application === 'unknown') {
    const read = readOverrides(ctx)
    if (read.ok) {
      const target = targetEnabledOf(read.overrides, id)
      if (target !== null) confirmTarget = target === (enabled === true)
    }
  }

  const interpreted = interpretChangeResult(result, { requested: enabled === true, confirmTarget })
  return decorate(interpreted, id, row.entryId, result)
}

/** 把解释结果整成 Center 的逐项形状（保留旧字段名，前端与测试都在用）。 */
function decorate(interpreted, id, entryId, raw) {
  const ok = interpreted.outcome === 'success' || interpreted.outcome === 'partial'
  return {
    id,
    ok,
    outcome: interpreted.outcome,
    reason: interpreted.reason,
    saved: interpreted.saved,
    applied: interpreted.applied,
    hostApplied: interpreted.applied,
    application: interpreted.application,
    changed: interpreted.changed === true,
    restartHelps: interpreted.restartHelps === true,
    code: interpreted.code,
    entryId,
    diagnostic: interpreted.diagnostic,
    warnings: Array.isArray(raw?.warnings) ? raw.warnings : [],
  }
}

/** 逐个应用，收集逐项结果（R4：一个失败不影响其余，且不谎报整体成功）。 */
export async function setNativeAll(ctx, enabled) {
  const items = []
  for (const p of SUB_PLUGINS) {
    items.push(await setNative(ctx, p.id, enabled))
  }
  return items
}
