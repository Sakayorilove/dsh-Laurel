/**
 * Laurel-Center · 记账
 *
 * 两件事：
 *   1. 旧开关记录（`$DSH_HOME/laurel-center/state.json`）—— **只读的迁移输入**，
 *      第二轮起不再往里写任何东西（写它会把「用户过去点过什么」的证据自己改掉）
 *   2. 事件流水（`$DSH_HOME/laurel-center/events.log`）—— 谁在什么时候开了什么关了，
 *      事后（包括让 agent 自己）能核对
 *   3. 迁移完成记录（`$DSH_HOME/laurel-center/migrations.json`）—— **按 profile** 记，
 *      不再是一个全 Home 共用的标记
 *
 * ── 家目录只认这两条，别推 ──────────────────────────────────────────────
 *   `DSH_HOME` 环境变量（有就用）→ 否则 `~/.dsh`。
 *   桌面版宿主是 Electron 子进程，那个环境里没有 DSH_HOME；从 profile 目录
 *   往上推会推出 `~/.dsh/profiles`，配置就落到错地方了。
 *
 * ── 所有 IO 吞异常 ──────────────────────────────────────────────────────
 * 记账失败不该让 DSH 启动失败。读不到就当作"还没有记录"，写不进就记一条日志。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { normalizeEnabled } from './registry.js'

/** DSH 家目录。 */
export function resolveDshHome() {
  const home = process.env.DSH_HOME
  if (home && home.length > 0) return home
  return join(homedir(), '.dsh')
}

/** 本插件的数据位置。 */
export function centerPaths(home = resolveDshHome()) {
  const dir = join(home, 'laurel-center')
  return {
    dir,
    state: join(dir, 'state.json'),
    events: join(dir, 'events.log'),
    // 迁移完成记录单独一个文件：state.json 是**只读的旧输入**，
    // 往里写标记会把「用户过去点过什么」这条证据自己改掉（F1）。
    migrations: join(dir, 'migrations.json'),
  }
}

/** 建目录，失败不抛。 */
function ensureDir(dir) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * 读开关状态。文件不存在 / 坏了 → 返回默认值。
 *
 * ⚠ 这个文件**不再是**开关的权威副本。权威是 profile 的 `cordis.patch.yml`（用户层）。
 * 这里只在**首次**运行新版时当一次迁移输入，见 lib/migrate.js。
 *
 * @returns {{ enabled: Record<string, boolean>, revision: number, updatedAt: string | null, migratedAt: string | null }}
 */
export function loadState(paths = centerPaths()) {
  const fallback = { enabled: normalizeEnabled(null), revision: 0, updatedAt: null, migratedAt: null }
  try {
    if (!existsSync(paths.state)) return fallback
    const raw = JSON.parse(readFileSync(paths.state, 'utf8'))
    return {
      enabled: normalizeEnabled(raw?.enabled),
      revision: Number.isInteger(raw?.revision) ? raw.revision : 0,
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
      migratedAt: typeof raw?.migratedAt === 'string' ? raw.migratedAt : null,
    }
  } catch {
    return fallback
  }
}

/**
 * 写开关状态。先写临时文件再原子改名，避免半截文件。
 * @returns {{ ok: boolean, state?: object, reason?: string }}
 */
export function saveState(enabled, paths = centerPaths(), extra = {}) {
  const current = loadState(paths)
  const next = {
    enabled: normalizeEnabled(enabled),
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
    ...current.migratedAt === null ? {} : { migratedAt: current.migratedAt },
    ...extra,
  }
  try {
    if (!ensureDir(paths.dir)) return { ok: false, reason: 'mkdir-failed' }
    const tmp = paths.state + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    renameSync(tmp, paths.state)
    return { ok: true, state: next }
  } catch {
    return { ok: false, reason: 'write-failed' }
  }
}

/**
 * 读「哪些 profile 已经迁移过」。文件不存在 / 坏了 → 空表。
 *
 * 第一轮把完成状态记成全 Home 共用的 `state.json.migratedAt`，于是第一个 profile
 * 迁完，第二个 profile 就被那个标记吞掉（F1）。现在按 profile 分别记。
 *
 * 每个 profile 下有两块，**分开**（第三轮 G1）：
 *   `completed` —— 只有全部条目都确知完成才写；只有它算「已迁移」
 *   `pending`   —— 未完成的进度与原因；不终结，下次启动重新核对用户层再处理
 *
 * @returns {{ profiles: Record<string, object>, readOk: boolean, reason?: string }}
 */
export function loadMigrations(paths = centerPaths()) {
  try {
    if (!existsSync(paths.migrations)) return { profiles: {}, readOk: true }
    const raw = JSON.parse(readFileSync(paths.migrations, 'utf8'))
    const profiles = raw?.profiles && typeof raw.profiles === 'object' ? raw.profiles : {}
    return { profiles, readOk: true }
  } catch (error) {
    // 读不了要如实说 —— 上层据此不打完成标记（宁可下次重试，也不要静默跳过）。
    return { profiles: {}, readOk: false, reason: String(error?.message ?? error) }
  }
}

/** 这个 profile 是否已经**确知完成**（只有 `completed` 算数）。 */
export function isMigrationCompleted(profiles, profileKey) {
  if (typeof profileKey !== 'string' || profileKey.length === 0) return false
  const entry = profiles?.[profileKey]
  return Boolean(entry && entry.completed)
}

/**
 * 记下某个 profile 的迁移进度。**合并**写入（`completed` 与 `pending` 不互相覆盖）。
 * 原子写；失败返回原因，不吞。
 * @returns {{ ok: boolean, reason?: string }}
 */
export function recordMigration(profileKey, detail, paths = centerPaths()) {
  if (typeof profileKey !== 'string' || profileKey.length === 0) return { ok: false, reason: 'no-profile-key' }
  const current = loadMigrations(paths)
  if (!current.readOk) return { ok: false, reason: 'migrations-unreadable' }
  const previous = current.profiles[profileKey] ?? {}
  const next = {
    profiles: {
      ...current.profiles,
      [profileKey]: { ...previous, ...detail, at: new Date().toISOString() },
    },
  }
  try {
    if (!ensureDir(paths.dir)) return { ok: false, reason: 'mkdir-failed' }
    const tmp = paths.migrations + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    renameSync(tmp, paths.migrations)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 一行一个 JSON 的事件流水。
 *
 * 会做**尺寸轮转**：超过 `MAX_EVENT_BYTES` 就把它改名成 `.1`（覆盖旧的 `.1`），
 * 再开新的。只留一份历史，不做无限卷 —— 这是「记账」，不是审计日志。
 * 不轮转的话，总控台开着 4 秒轮询、每次开关都记一条，几个月下来能到几 MB；
 * 套件里 laurel 的 events.log 实测 10 天 236K，值得设个上限。
 */
export function appendEvent(event, paths = centerPaths()) {
  try {
    if (!ensureDir(paths.dir)) return false
    rotateIfNeeded(paths.events)
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n'
    appendFileSync(paths.events, line, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 事件流水的大小上限（1 MiB）。 */
export const MAX_EVENT_BYTES = 1024 * 1024

/**
 * 超限就把当前日志挪到 `<name>.1`（旧的直接覆盖），给新的腾地方。
 * 任何一步失败都静默放弃 —— 记账不许影响主流程。
 */
function rotateIfNeeded(file) {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_EVENT_BYTES) return
    renameSync(file, `${file}.1`)
  } catch {
    /* 轮转失败就继续往原文件追加，不抛 */
  }
}

/** 配置 + 家目录信息，给调试用。 */
export function describe(paths = centerPaths()) {
  const migrations = loadMigrations(paths)
  return {
    home: resolveDshHome(),
    dir: paths.dir,
    state: paths.state,
    events: paths.events,
    migrations: paths.migrations,
    migratedProfiles: Object.keys(migrations.profiles),
    migrationsReadable: migrations.readOk,
  }
}
