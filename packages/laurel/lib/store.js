/**
 * Laurel · 状态与 HTTP 数据面
 *
 * 这里只管两件事：
 *   1. **配置** —— 默认值 → cordis patch 的 config → `$DSH_HOME/laurel/settings.json`
 *      （设置页写的那份，优先级最高）；
 *   2. **事件日志** —— 浏览器半边把「弹了 / 点了 / 失败了」回传到这里，
 *      事后能核对"到底响没响、为什么没响"。
 *
 * 依赖只有 node 内置模块，这是刻意的：这个包要能被别人直接装，
 * 不该带任何第三方依赖。同理，全部路径都从 `$DSH_HOME` 现算，不写死。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

/** 包名。同时是浏览器半边 `window.__ModuleLoader__.load({ id })` 用的 id，两处必须一致。 */
export const PACKAGE_NAME = 'laurel'

/** 与 package.json 的 version 保持一致（测试会核对这一项，防手改漏一处）。 */
export const VERSION = '0.1.0'

/**
 * DSH 家目录 —— 与宿主自己的 `@deepseek-ai/dsh-home-paths` 同一条规则：
 *   1. `DSH_HOME` 环境变量（有就用它）；
 *   2. 否则 `os.homedir()/.dsh`。
 *
 * ⚠️ 不要用 `DSH_PROFILE_DIR` 去推父目录。这个坑真踩过：
 * 桌面版宿主是 Electron fork 出来的子进程，那个环境里**没有** `DSH_HOME`，
 * 于是"从 profile 目录推家目录"推出 `~/.dsh/profiles`，数据被写到了错误的位置。
 */
export function resolveDshHome() {
  const home = process.env.DSH_HOME
  if (home && home.length > 0) return home
  return join(homedir(), '.dsh')
}

/** 本插件的数据目录与三个位置。 */
export function pluginPaths(home = resolveDshHome()) {
  const dir = join(home, 'laurel')
  return {
    dir,
    settings: join(dir, 'settings.json'),
    events: join(dir, 'events.log'),
    sounds: join(dir, 'sounds'),
  }
}

/**
 * 插件配置默认值。
 * `cordis.patch.yml` 里那份 config 会当成**默认值的覆盖**，settings.json 再盖一层。
 */
export const DEFAULT_CONFIG = {
  /** 提问（agent 用 ask_user_question 停下来等你回答）。 */
  notifyOnQuestion: true,
  /**
   * 计划确认（agent 让你确认一份计划）。
   *
   * 与提问**各有一个开关**。2026-09-30 之前这两类共用 `notifyOnQuestion`，
   * 界面上只能画一个「跨两行」的格子 —— 结果那个格子视觉上落在第二行，
   * 「需要你回答」的系统通知格看起来是空的，被当成错位 / 漏配。
   * 拆开之后每一行都是完整的两个格子，也顺便能分别设了。
   */
  notifyOnPlanReview: true,
  /** 审批请求（工具要权限）。 */
  notifyOnApproval: true,
  /** 回合结束。默认关：长任务会响很多次。 */
  notifyOnCompletion: false,
  /** 只有窗口没焦点 / 被收进托盘时才弹。 */
  onlyWhenUnfocused: true,
  /**
   * 窗口在前台时，在页面右下角弹一张卡片（网页内通知）。
   *
   * 注意：这个开关**只在 `onlyWhenUnfocused: true` 时才有意义**。
   * 前台通知走哪条路，由设置页那个「通知时机」三选一决定，三个选项分别是：
   *   - 只后台通知      → onlyWhenUnfocused: true,  toast: false
   *   - 只前台通知      → onlyWhenUnfocused: false, toast 无关
   *   - 前后台都通知    → onlyWhenUnfocused: true,  toast: true
   * 细节见 lib/client.js 的 `timingMode()` / `fire()`。
   */
  toast: true,
  /** 页内卡片停留毫秒数。0 = 不自动消失，只能手动关。 */
  toastMs: 6000,
  /** 页内卡片的位置。 */
  toastCorner: 'bottom-right',
  /**
   * 窗口在前台时，哪几类事件值得打断你 —— 逐类可选。
   *
   * 为什么做成逐类而不是一个大开关：这纯粹是个人口味，没有正确答案。
   * 有人要"全选，放个屁都弹一下"，也有人只想知道"卡住了要我拍板"。
   * 全部关掉也不会失去验证手段：设置页那个「试页内卡片」按钮随时能手动弹一张。
   *
   * 注意这些开关只管**页内卡片**；系统通知仍由上面 notifyOn* 那几个开关管。
   */
  toastOnQuestion: true,
  toastOnApproval: true,
  toastOnPlanReview: true,
  toastOnCompletion: false,
  /** 同一会话的最小间隔（秒）。0 = 不节流。 */
  throttleSeconds: 30,
  /** 提示音（Windows 通知音）。 */
  sound: true,
  /**
   * 自定义提示音。三种写法：
   *   - 空串        → 用 Windows 系统通知音（默认）
   *   - 文件名       → 相对 `$DSH_HOME/laurel/sounds/`，例如 `ding.wav`
   *   - 绝对路径     → 例如 `C:/Windows/Media/Windows Notify Calendar.wav`
   *   - http(s) 链接 → 直接交给浏览器播（离线不可用，且受页面 CSP 限制）
   * 设了这个之后系统通知音会被静音，避免两声叠在一起。
   */
  soundFile: '',
  /** 提问 / 审批是否留在通知中心直到处理。 */
  sticky: true,
  /** 标题前缀，留空 = 只用会话标题。 */
  title: '',
  /** 正文最大字符数。 */
  maxBodyChars: 140,
  /** auto | zh | en */
  language: 'auto',
  logLevel: 'info',
}

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const LANGUAGES = new Set(['auto', 'zh', 'en'])
/** 页内卡片允许的四个角落。 */
const TOAST_CORNERS = new Set(['bottom-right', 'bottom-left', 'top-right', 'top-left'])

/** 事件种类白名单：浏览器半边只会回传这几种，别的一律记成 'other'。 */
const EVENT_KINDS = new Set(['ready', 'config', 'fire', 'shown', 'click', 'sound', 'error', 'warn', 'test', 'watch', 'toast', 'dismiss'])

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function pickString(value, maxLen, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed
}

/**
 * 归一化一份配置：只认已知键；类型不对就用 base 里的值；数值一律夹到合理区间。
 *
 * 为什么不信任输入：这份配置有三个来处（patch、settings.json、设置页的 POST），
 * 任何一个写坏了都不该让插件带着一个 `NaN` 去算节流。
 *
 * @param {Record<string, unknown>} raw 待归一化的配置
 * @param {typeof DEFAULT_CONFIG} base 类型不对时的兜底
 */
export function normalizeConfig(raw = {}, base = DEFAULT_CONFIG) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const out = { ...base }
  const bool = (key) => {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }
  bool('notifyOnQuestion')
  bool('notifyOnPlanReview')
  bool('notifyOnApproval')
  bool('notifyOnCompletion')
  bool('onlyWhenUnfocused')
  bool('sound')
  bool('sticky')
  bool('toast')
  bool('toastOnQuestion')
  bool('toastOnApproval')
  bool('toastOnPlanReview')
  bool('toastOnCompletion')
  out.throttleSeconds = clampNumber(input.throttleSeconds ?? base.throttleSeconds, 0, 3600, base.throttleSeconds)
  out.toastMs = clampNumber(input.toastMs ?? base.toastMs, 0, 120000, base.toastMs)
  out.maxBodyChars = clampNumber(input.maxBodyChars ?? base.maxBodyChars, 20, 500, base.maxBodyChars)
  out.title = pickString(input.title, 40, base.title)
  out.soundFile = pickString(input.soundFile, 400, base.soundFile)
  if (typeof input.language === 'string' && LANGUAGES.has(input.language)) out.language = input.language
  if (typeof input.toastCorner === 'string' && TOAST_CORNERS.has(input.toastCorner)) out.toastCorner = input.toastCorner
  if (typeof input.logLevel === 'string' && LOG_LEVELS.has(input.logLevel)) out.logLevel = input.logLevel
  return out
}

/** 只保留已知键，写盘前用一次，避免把临时字段写进 settings.json。 */
export function pickKnown(config) {
  const out = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) out[key] = config[key]
  return out
}

/** 读 settings.json；文件不存在或坏了都返回 null（调用方退回 patch 默认值）。 */
export function loadSettings(home = resolveDshHome()) {
  const p = pluginPaths(home)
  try {
    if (!existsSync(p.settings)) return { config: null, path: p.settings, exists: false }
    const parsed = JSON.parse(readFileSync(p.settings, 'utf8'))
    return { config: parsed && typeof parsed === 'object' ? parsed : null, path: p.settings, exists: true }
  } catch {
    return { config: null, path: p.settings, exists: false }
  }
}

/** 原子写：先写临时文件再改名，避免设置页写一半时宿主读到半个 JSON。 */
export function saveSettings(config, home = resolveDshHome()) {
  const p = pluginPaths(home)
  mkdirSync(p.dir, { recursive: true })
  const tmp = `${p.settings}.tmp`
  writeFileSync(tmp, `${JSON.stringify(pickKnown(config), null, 2)}\n`, 'utf8')
  try {
    writeFileSync(p.settings, readFileSync(tmp, 'utf8'), 'utf8')
  } catch {
    // 极端情况下（两进程同时写）退回直接写，内容已经是完整 JSON。
    writeFileSync(p.settings, `${JSON.stringify(pickKnown(config), null, 2)}\n`, 'utf8')
  }
  return p.settings
}

const EVENT_LOG_MAX_BYTES = 512 * 1024
const EVENT_DETAIL_MAX_CHARS = 400

/**
 * 追加一条事件。日志是"事后能核对"的地基，所以：
 *   - 一行一个 JSON，方便 `Select-String` 或 `jq` 直接查；
 *   - 超过 512KB 就只保留最后 200 行，避免无限长；
 *   - 任何 IO 失败都吞掉 —— 记日志不许影响通知本身。
 */
export function appendEvent(event, home = resolveDshHome()) {
  const p = pluginPaths(home)
  const record = {
    t: new Date().toISOString(),
    kind: EVENT_KINDS.has(event?.kind) ? event.kind : 'other',
    sessionId: typeof event?.sessionId === 'string' ? event.sessionId.slice(0, 80) : null,
    title: typeof event?.title === 'string' ? event.title.slice(0, 120) : null,
    body: typeof event?.body === 'string' ? event.body.slice(0, EVENT_DETAIL_MAX_CHARS) : null,
    detail: typeof event?.detail === 'string' ? event.detail.slice(0, EVENT_DETAIL_MAX_CHARS) : null,
    focused: typeof event?.focused === 'boolean' ? event.focused : null,
    visibility: typeof event?.visibility === 'string' ? event.visibility.slice(0, 20) : null,
    origin: typeof event?.origin === 'string' ? event.origin.slice(0, 120) : null,
    supported: typeof event?.supported === 'boolean' ? event.supported : null,
    permission: typeof event?.permission === 'string' ? event.permission.slice(0, 20) : null,
  }
  try {
    mkdirSync(p.dir, { recursive: true })
    try {
      if (existsSync(p.events) && statSync(p.events).size > EVENT_LOG_MAX_BYTES) {
        const kept = readFileSync(p.events, 'utf8').split('\n').filter(Boolean).slice(-200)
        writeFileSync(p.events, `${kept.join('\n')}\n`, 'utf8')
      }
    } catch { /* 截断失败就继续追加 */ }
    appendFileSync(p.events, `${JSON.stringify(record)}\n`, 'utf8')
  } catch { /* 日志失败不影响通知 */ }
  return record
}

/** 读最近 limit 条事件（倒序，最新的在前）。 */
export function readEvents(limit = 20, home = resolveDshHome()) {
  const p = pluginPaths(home)
  try {
    if (!existsSync(p.events)) return []
    const lines = readFileSync(p.events, 'utf8').split('\n').filter(Boolean)
    const rows = []
    for (const line of lines.slice(-Math.max(1, Math.min(200, limit)))) {
      try { rows.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
    }
    return rows.reverse()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * 自定义提示音
 * ------------------------------------------------------------------ */

/** 认得的音频扩展名 → content-type。 */
const AUDIO_TYPES = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
}

const SOUNDS_README = `这个文件夹是 Laurel 的自定义提示音目录。

把音效文件（wav / mp3 / ogg / m4a / flac）放在这里，然后在
DSH 的「设置 → 通知 → 自定义提示音」里填文件名，例如：

    ding.wav

Windows 自带的音效也能直接用（填绝对路径，不用拷过来），例如：

    C:/Windows/Media/Windows Notify Calendar.wav

设置页会列出本目录里的音频文件，点一下就能填进去、并且试听。
`

/** 建好提示音目录，并放一个说明文件（已存在就不动）。 */
export function ensureSoundsDir(home = resolveDshHome()) {
  const paths = pluginPaths(home)
  try {
    mkdirSync(paths.sounds, { recursive: true })
    const readme = join(paths.sounds, '把音效放这里.txt')
    if (!existsSync(readme)) writeFileSync(readme, SOUNDS_README, 'utf8')
  } catch { /* 建不出来不影响通知本身 */ }
  return paths.sounds
}

/** 列出提示音目录里的音频文件（按名字排序）。 */
export function listSounds(home = resolveDshHome()) {
  const paths = pluginPaths(home)
  try {
    if (!existsSync(paths.sounds)) return []
    return readdirSync(paths.sounds, { withFileTypes: true })
      .filter((entry) => entry.isFile() && AUDIO_TYPES[extname(entry.name).toLowerCase()])
      .map((entry) => {
        let size = 0
        try { size = statSync(join(paths.sounds, entry.name)).size } catch { /* 读不到大小就算了 */ }
        return { name: entry.name, size }
      })
      .sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return []
  }
}

/**
 * 把"要播的那个提示音"解析成一个可读的文件。
 *
 * 两种来源，都只认音频扩展名：
 *   - `requested` 非空（设置页点名要听哪一个）：**只接受文件名**，且必须在提示音目录里。
 *     带路径分隔符或 `..` 一律拒绝 —— 这是个只读 HTTP 端点，不能当任意文件读取器用。
 *   - `requested` 为空：用配置里的 `soundFile`，这里允许绝对路径（那是用户自己写进配置的）。
 *
 * @returns {{ ok: true, path: string, type: string, name: string } | { ok: false, error: string }}
 */
export function resolveSound(requested, config, home = resolveDshHome()) {
  const paths = pluginPaths(home)

  const asFile = (fullPath, name) => {
    const type = AUDIO_TYPES[extname(fullPath).toLowerCase()]
    if (!type) return { ok: false, error: `不认的音频格式：${name}（支持 ${Object.keys(AUDIO_TYPES).join(' ')}）` }
    try {
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) return { ok: false, error: `找不到文件：${fullPath}` }
    } catch (error) {
      return { ok: false, error: `读不到文件：${fullPath}（${error?.message ?? error}）` }
    }
    return { ok: true, path: fullPath, type, name }
  }

  if (typeof requested === 'string' && requested.trim().length > 0) {
    const name = requested.trim()
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      return { ok: false, error: '点名播放时只接受提示音目录里的文件名（不接受路径）' }
    }
    return asFile(join(paths.sounds, name), name)
  }

  const configured = typeof config?.soundFile === 'string' ? config.soundFile.trim() : ''
  if (!configured) return { ok: false, error: '没有配置自定义提示音（走系统通知音）' }
  if (/^https?:\/\//i.test(configured)) return { ok: false, error: '这是远程链接，由浏览器直接播放，不走宿主' }
  return asFile(isAbsolute(configured) ? configured : join(paths.sounds, configured), configured)
}

/** 读请求体（带上限）。返回解析后的对象；不是合法 JSON 就返回 null。 */
export function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve(null)
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function send(res, status, payload, method = 'GET') {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(method === 'HEAD' ? undefined : JSON.stringify(payload))
}

/**
 * 造 HTTP handler。宿主半边把它注册在 `webServer.register({ kind:'prefix', path:'/laurel' })`。
 *
 * 端点（全部返回 `{ ok, ... }`，浏览器半边只认这一种形状）：
 *   GET  /laurel/config   生效配置 + 版本 + 文件位置
 *   POST /laurel/config   改配置（写 settings.json）
 *   POST /laurel/event    浏览器半边回传事件（弹了/点了/失败了）
 *   GET  /laurel/events   最近事件
 *   GET  /laurel/status   诊断用：配置 + 路径 + 事件计数
 *
 * @param {{ home: string, getConfig: () => any, setConfig: (patch: any) => any, log: any }} deps
 */
export function createHandler({ home, getConfig, setConfig, log }) {
  return async function handler(req, res) {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.replace(/^\/laurel/, '').replace(/\/+$/, '') || '/'
    try {
      if (route === '/config' && (method === 'GET' || method === 'HEAD')) {
        const p = pluginPaths(home)
        return send(res, 200, {
          ok: true,
          data: {
            config: getConfig(),
            version: VERSION,
            package: PACKAGE_NAME,
            settingsPath: p.settings,
            eventsPath: p.events,
            home,
          },
        }, method)
      }

      if (route === '/config' && method === 'POST') {
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
        const patch = body.config && typeof body.config === 'object' ? body.config : body
        const config = setConfig(patch)
        appendEvent({ kind: 'config', detail: JSON.stringify(pickKnown(config)) }, home)
        return send(res, 200, { ok: true, data: { config } })
      }

      if (route === '/event' && method === 'POST') {
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
        const record = appendEvent(body, home)
        if (record.kind === 'error' || record.kind === 'warn') log?.warn?.(`浏览器半边回传：${record.kind} ${record.detail ?? record.body ?? ''}`)
        else log?.debug?.(`浏览器半边回传：${record.kind}`)
        return send(res, 200, { ok: true, data: { recorded: record.t } })
      }

      if (route === '/events' && (method === 'GET' || method === 'HEAD')) {
        const limit = clampNumber(url.searchParams.get('limit') ?? 20, 1, 200, 20)
        return send(res, 200, { ok: true, data: { rows: readEvents(limit, home) } }, method)
      }

      if (route === '/status' && (method === 'GET' || method === 'HEAD')) {
        const p = pluginPaths(home)
        const rows = readEvents(200, home)
        const last = rows[0] ?? null
        return send(res, 200, {
          ok: true,
          data: {
            package: PACKAGE_NAME,
            version: VERSION,
            config: getConfig(),
            home,
            settingsPath: p.settings,
            eventsPath: p.events,
            events: rows.length,
            lastEvent: last,
          },
        }, method)
      }

      if (route === '/sounds' && (method === 'GET' || method === 'HEAD')) {
        const paths = pluginPaths(home)
        const resolved = resolveSound('', getConfig(), home)
        return send(res, 200, {
          ok: true,
          data: {
            dir: paths.sounds,
            files: listSounds(home),
            configured: getConfig().soundFile,
            resolved: resolved.ok
              ? { path: resolved.path, name: resolved.name, type: resolved.type }
              : { error: resolved.error },
          },
        }, method)
      }

      if (route === '/sound' && (method === 'GET' || method === 'HEAD')) {
        const resolved = resolveSound(url.searchParams.get('file') ?? '', getConfig(), home)
        if (!resolved.ok) return send(res, 404, { ok: false, error: resolved.error }, method)
        let bytes
        try {
          bytes = readFileSync(resolved.path)
        } catch (error) {
          return send(res, 500, { ok: false, error: `读文件失败：${error?.message ?? error}` }, method)
        }
        res.statusCode = 200
        res.setHeader('content-type', resolved.type)
        res.setHeader('content-length', String(bytes.length))
        res.setHeader('cache-control', 'no-store')
        res.end(method === 'HEAD' ? undefined : bytes)
        return undefined
      }

      return send(res, 404, { ok: false, error: `未知端点：${method} /laurel${route}` }, method)
    } catch (error) {
      log?.error?.(`HTTP 处理出错：${error?.message ?? error}`)
      return send(res, 500, { ok: false, error: String(error?.message ?? error) }, method)
    }
  }
}
