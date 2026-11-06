/**
 * laurel-memory · 客户端半边：设置页（记忆核心）。
 *
 * 硬约束（见 docs/PLUGIN-CONTRACT.md）：
 *   1. 不许 import/export default/动态 import；产物是 classic script 的 CJS factory。
 *   2. 只能 require platform seed 表里的东西（这里是 react）。
 *   3. 必须 export function apply(ctx)。
 *   4. exports.inject 里的服务名，其供给方要写进 package.json 的 dsh.client.inject。
 *
 * 2026-10-19（D45）：宿主日志报 "web boot: 2 entries did not activate / laurel-memory: failed"。
 * 含义是**这个条目的 apply() 抛了**（不是 import 失败，也不是等不到服务）。
 * 同宿主上能正常工作的 dsh-warden 等模块都是同一套写法：
 *   - 只 inject 真正要用的服务（`slots`），不再顺手写 `locale`；
 *   - 注册前先 `slots.inject('settings.section', ...)` 等插槽就位，不直接 register；
 *   - 拿不到 slots 就**安静跳过**（不抛），因为"没有设置页"不该让整个 web boot 失败。
 * 另外加了 try/catch + console.error：万一还失败，宿主 crash 日志里的
 * "renderer console (error level)" 段会带上我们的标记和堆栈，不用再靠猜。
 *
 * 2026-10-19（D48）：这一页原来是个**静态占位** —— 拿不到 `ctx.get('remote')`
 * 就显示"读取失败"，拿到了也只会返回硬编码的 `{tier:'zero', source:'none'}`，
 * 从来不读任何真实状态。查过宿主后确认客户端根本够不到插件自己的 cordis 服务
 * （能用的只有宿主预置的 remote.* 命名空间，是固定集合）。
 * 所以现在改成 fetch 宿主半边挂出来的只读端点（lib/host-data.js），
 * 并且**区分四种情况**：真的没接上数据 / 端点回了错 / 这次没连上宿主 / 读到了真实状态。
 * 不把"没接上"伪装成"读取失败"，不把"这次没连上"伪装成"读取失败"，
 * 也不把"读取失败"伪装成"空库"。
 */

/** 只读状态端点。必须与 lib/index.js 的 DATA_PATH 一致。 */
const DATA_API = '/laurel-memory'
/** 写端点（有鉴权栅栏）。必须与 lib/index.js 的 SETTINGS_PATH 一致。 */
const SETTINGS_API = '/api/laurel-memory'
/** 写请求必须带的头：跨站请求带不上它，等于一道 CSRF 栅栏。 */
const UI_HEADER = { 'x-laurel-ui': '1' }
/** 端点没挂上（非 Web 组合）时的等待上限；超时按"未接数据"处理，不无限转圈。 */
const FETCH_TIMEOUT_MS = 8000
/** 网络层失败后的一次有界重试间隔。总时长仍受 FETCH_TIMEOUT_MS 约束。 */
const RETRY_DELAY_MS = 250
/** 写请求的上限：切换会做一次真实探测（含一次极小模型调用），比读要宽。 */
const SAVE_TIMEOUT_MS = 20000

/**
 * 管理动作的上限。比切档位宽得多：完整打包要把 100MB+ 的核心仓写成 zip
 * （流式，但仍是几百 MB 的 IO），清理计划要扫 4 万条 journal 单元。
 * 共用 20s 会让「打包」这个按钮在真仓上必然超时，然后用户以为它坏了。
 */
const ADMIN_TIMEOUT_MS = 120000

/** 需要哪些客户端服务。供给方要写进 package.json 的 dsh.client.inject。 */
const inject = ['slots']

const TEXT = {
  zh: {
    label: '记忆核心',
    heading: '记忆核心',
    desc: '把记忆与经验学习合成一套：记录要求与项目现状、从修复中积累经验、按需形成 Skill。',
    tabs: ['今天', '记忆', '经验', '搬家'],
    tierLabel: '档位',
    tiers: { zero: '零推理（额外模型费用为 0）', balanced: '均衡（推荐日常）', full: '全面（复杂任务）' },
    sourceLabel: '模型来源',
    modelSourceLabel: '模型网关',
    sources: {
      none: '不接模型（0 次调用）',
      local: '本地模型（填端点地址）',
      api: '宿主模型（选供应商与模型）',
    },
    apply: '应用',
    saving: '正在应用…',
    saved: '已保存并生效',
    saveFailed: '没保存成功：',
    needLocalUrl: '本地模型要先填端点地址（例：http://127.0.0.1:11434/v1）',
    localUrlLabel: '端点地址',
    // ── 宿主模型：从宿主设置页那批供应商里选一个，再选它的模型 ────────────
    // 旧的「harness 直连」靠自动发现网关地址 + 读密钥文件 + 猜当前模型，
    // 猜错就是「面板说在用、真调用连不上」。现在谁在用、用哪个模型都由用户明说。
    modelProviderLabel: '供应商',
    modelNameLabel: '模型',
    pickProvider: '选择供应商',
    pickModel: '选择模型',
    noCatalog: '宿主没有给出供应商目录：',
    catalogEmpty: '这个供应商没有公布模型目录，直接填模型 id',
    modelInputPlaceholder: '模型 id（例：deepseek-v4.1-flash）',
    hostModelLine: '当前宿主模型',
    hostUnavailable: '宿主模型服务不可用：',
    externalRoute: '现在生效的还是历史的外部端点；选一个宿主模型并应用即可切回。',
    useHostDefault: '用宿主默认模型',
    writableHint: '改完点「应用」立即生效，并记在核心仓里（重启不丢）。',
    readonlyHint: '写通道没挂上（非 Web 组合）：只能看，改不了。',
    statusLabel: '状态',
    states: { recorded: '已记录', pending: '待整理', verified: '已验证' },
    empty: '这个核心仓还没有记忆。',
    readFailed: '读取失败（不是空库，请检查核心仓路径）',
    unreachable: '暂时读不到宿主状态（这次没连上，不是库坏了）。核心仓路径不受影响，稍后会自动重试。',
    notWired: '未接数据：宿主没有提供只读状态端点（非 Web 组合，或数据面没挂上）。',
    disabled: '未启用',
    enabled: '已启用',
    coreIdLabel: '核心仓 ID',
    journalLabel: '日志序号',
    vaultLabel: '核心仓路径',
    errorLabel: '原因',
    rebuilding: '正在重建索引…',
    readonly: '只读（另一个进程正在写入）',
    lastBackup: '最近备份',
    backupNow: '完整打包',
    restore: '恢复核心仓',
    // ── 管理面（MC13）：四个页签真正要用的文案。缺一个 key，面板上就是一串 undefined。
    settingsSummary: '全局设置（档位 / 模型来源 / 核心仓信息）',
    working: '正在读取…',
    failed: '没成：',
    refresh: '刷新',
    todayCount: '今天新记 / 总共',
    badLines: '索引里有坏行（不影响读取，但说明某次写入没写完）：',
    todayKinds: '按类型',
    todayAuthors: '按来源',
    pendingEpisodes: '自动观察中的经验',
    noPending: '新旧经验均自动处理，无需手动采纳。',
    searchPlaceholder: '搜一句人话（例：为什么压缩没生效）',
    searchBtn: '搜索',
    noHits: '没有命中。换个说法试试 —— 检索按词命中，不猜语义。',
    openRecord: '读全文',
    correct: '更正',
    revoke: '撤销',
    save: '保存为新版本',
    cancel: '取消',
    prev: '上一页',
    next: '下一页',
    editHint: '保存会写成一个新版本（旧版本仍可查，不会被覆盖）。',
    editTooLong: '这条正文超过 400 行，文本框里只有前 400 行 —— 现在保存会把后面的内容删掉，所以拒绝。请改用命令行 laural-memory 分页处理。',
    revokeHint: '撤销要写原因 —— 三个月后没人记得为什么撤的。',
    reasonPlaceholder: '为什么撤/退役这一条',
    adopt: '采纳',
    automaticHint: '经验自动评估、采纳和召回；真实工具结果自动反馈。证据不足时继续观察，无需手工补摘要。',
    observing: '自动观察中 · 等待足够证据',
    outcomePassed: '用过，成功',
    outcomeFailed: '用过，失败',
    retire: '退役',
    epRevoke: '撤销经验',
    expEmpty: '这个核心仓还没有经验条目。经验是采集流里自动攒的，攒够一次「做完/纠正/失败」就会出一条候选。',
    filterAll: '全部',
    exportPath: '打包到（留空 = 仓内 exports/）',
    exportBtn: '完整打包',
    moveHint: '打包会把 journal、blobs、records、经验一起打成 zip，并给出 sha256 与「是否完整」。',
    restoreArchive: '归档包路径',
    restoreTarget: '恢复到哪个目录（必须是新目录，不能是现在用的仓）',
    confirmDestructive: '我确认这一步是破坏性的',
    retentionPlan: '清理计划（只看不删）',
    retentionApply: '执行清理',
    selfcheck: '自检（快检）',
    selfcheckDeep: '自检（深检，解一次日志）',
    selfcheckSummary: '自检结果',
    selfcheckUnmeasured: '未测（不是通过）',
    completeYes: '包是完整的',
    completeNo: '包不完整（缺原文，别拿它搬家）',
    sha: 'sha256',
    gaps: '缺口',
    applied: '已完成',
  },
  en: {
    label: 'Memory Core',
    heading: 'Memory Core',
    desc: 'Memory and experience learning in one store.',
    tabs: ['Today', 'Memory', 'Experience', 'Move'],
    tierLabel: 'Tier',
    tiers: { zero: 'Zero-inference (no extra model cost)', balanced: 'Balanced', full: 'Full' },
    sourceLabel: 'Model source',
    modelSourceLabel: 'Model gateway',
    sources: {
      none: 'No model (0 calls)',
      local: 'Local model (enter endpoint)',
      api: 'Host model (pick a provider and model)',
    },
    apply: 'Apply',
    saving: 'Applying…',
    saved: 'Saved and active',
    saveFailed: 'Not saved: ',
    needLocalUrl: 'Local model needs an endpoint first (e.g. http://127.0.0.1:11434/v1)',
    localUrlLabel: 'Endpoint',
    modelProviderLabel: 'Provider',
    modelNameLabel: 'Model',
    pickProvider: 'Pick a provider',
    pickModel: 'Pick a model',
    noCatalog: 'The host published no provider catalogue: ',
    catalogEmpty: 'This provider lists no models — type the model id',
    modelInputPlaceholder: 'Model id (e.g. deepseek-v4.1-flash)',
    hostModelLine: 'Current host model',
    hostUnavailable: 'Host model service unavailable: ',
    externalRoute: 'The historical external endpoint is still in effect; pick a host model and apply to switch back.',
    useHostDefault: 'Use the host default model',
    writableHint: 'Apply takes effect immediately and is recorded in the core vault (survives restarts).',
    readonlyHint: 'Write channel not mounted (non-web composition): read-only.',
    statusLabel: 'Status',
    states: { recorded: 'Recorded', pending: 'Pending', verified: 'Verified' },
    empty: 'This core vault has no memories yet.',
    readFailed: 'Read failed (not an empty vault)',
    unreachable: 'Host status temporarily unreachable (a failed connection, not a broken vault). The vault path is unaffected; it will retry.',
    notWired: 'Not connected: the host exposes no read-only status endpoint.',
    disabled: 'Disabled',
    enabled: 'Enabled',
    coreIdLabel: 'Core ID',
    journalLabel: 'Journal seq',
    vaultLabel: 'Vault path',
    errorLabel: 'Reason',
    rebuilding: 'Rebuilding index…',
    readonly: 'Read-only (another process is writing)',
    lastBackup: 'Last backup',
    backupNow: 'Full export',
    restore: 'Restore core',
    settingsSummary: 'Settings (tier / model source / vault info)',
    working: 'Loading…',
    failed: 'Failed: ',
    refresh: 'Refresh',
    todayCount: 'New today / total',
    badLines: 'Corrupt lines in the index (reads still work):',
    todayKinds: 'By kind',
    todayAuthors: 'By author',
    pendingEpisodes: 'Experiences under automatic observation',
    noPending: 'New and existing experiences are processed automatically.',
    searchPlaceholder: 'Search in plain words',
    searchBtn: 'Search',
    noHits: 'No hits. Try other words — matching is lexical, not semantic.',
    openRecord: 'Read',
    correct: 'Correct',
    revoke: 'Revoke',
    save: 'Save as new revision',
    cancel: 'Cancel',
    prev: 'Prev',
    next: 'Next',
    editHint: 'Saving writes a new revision; the old one stays readable.',
    editTooLong: 'This body is longer than 400 lines and the box holds only the first 400 — saving now would delete the rest, so it is refused.',
    revokeHint: 'A revoke needs a reason.',
    reasonPlaceholder: 'Why revoke / retire this',
    adopt: 'Adopt',
    automaticHint: 'Evaluation, adoption and recall are automatic. Observed tool results update reuse feedback. Incomplete evidence stays under observation.',
    observing: 'Observing automatically · awaiting evidence',
    outcomePassed: 'Used, worked',
    outcomeFailed: 'Used, failed',
    retire: 'Retire',
    epRevoke: 'Revoke episode',
    expEmpty: 'No episodes yet.',
    filterAll: 'All',
    exportPath: 'Export to (empty = vault exports/)',
    exportBtn: 'Full export',
    moveHint: 'The archive bundles journal, blobs, records and episodes, and reports sha256 plus completeness.',
    restoreArchive: 'Archive path',
    restoreTarget: 'Restore into (must be a new directory, not the live vault)',
    confirmDestructive: 'I confirm this step is destructive',
    retentionPlan: 'Cleanup plan (read-only)',
    retentionApply: 'Run cleanup',
    selfcheck: 'Self-check (fast)',
    selfcheckDeep: 'Self-check (deep, decodes once)',
    selfcheckSummary: 'Self-check result',
    selfcheckUnmeasured: 'unmeasured (not a pass)',
    completeYes: 'Archive is complete',
    completeNo: 'Archive is incomplete (missing originals)',
    sha: 'sha256',
    gaps: 'Gaps',
    applied: 'Done',
  },
}

/** 页签表：`[动作前缀, TEXT.tabs 下标]`。顺序即渲染顺序。 */
const TABS = [
  ['today', 0],
  ['memory', 1],
  ['experience', 2],
  ['move', 3],
]

const SETTINGS_ID = 'memory-core'
/**
 * 插槽名**不在这里写死**：交给 kit 的 `registerSettingsSection` 做两路选择
 *   总控在   → 'laurel-center.module'（内容进「Laurel 控制中心」的模块卡片）
 *   总控不在 → 'settings.section'（独立一条设置页导航）
 * 这里写死任何一个都会漏掉另一条路（D66 就是这么来的）。
 */
const LABEL = '记忆核心'

/** 取 slots 服务：优先服务解析，退回到 ctx.slots（两者同源，但不同宿主版本暴露方式不同）。 */
function slotsOf(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const viaGet = ctx.get('slots')
      if (viaGet) return viaGet
    }
  } catch (e) { /* ctx.get 在某些版本会抛：不当成致命 */ }
  return (ctx && ctx.slots) || null
}

/** 由装载机聚合进「Laurel 套件」那一条设置里。 */

/**
 * 这次请求到底"连没连上宿主"。四档语义与 laurel-context 侧完全一致：
 *
 *   live        读到了（端点回了、ok、数据面已挂）
 *   detached    端点根本没挂 —— 404，或 data.dataPlane.mounted === false（**正常状态**，
 *               不是错误；不该显示成红色"读取失败"，否则用户会一直以为坏了）
 *   unreachable **网络层**失败 —— fetch 直接抛（Failed to fetch / NetworkError /
 *               超时 AbortError）。语义是"这次没连上宿主"，是中性事实，
 *               绝不能被渲染成"读取失败"让用户以为核心仓坏了。
 *   wired       端点回了但结果不对 —— HTTP 非 2xx，或 body.ok !== true。真错误。
 *
 * 2026-10-20：原来这里把网络层失败和真读取错误一起归成 wired，于是宿主 web
 * 服务刚起还没监听时的 `TypeError: Failed to fetch`、页面刚加载时的一次瞬时
 * 断连、请求被浏览器拦掉，全被渲染成「读取失败（不是空库，请检查核心仓路径）」，
 * 让用户以为核心仓出了问题。注释里写着"这种情况按 detached 更友好"，代码没做。
 */
const NETWORK_ERROR_RE = /failed to fetch|networkerror|network error|network request failed|load failed|fetch failed|terminated/i

/** 判断一个抛出来的异常是不是"网络层"失败（而不是端点返回了错误结果）。 */
function isNetworkFailure(e) {
  if (!e) return false
  const name = String(e.name || '')
  // AbortError：被超时定时器打断；TimeoutError：某些实现的超时名
  if (name === 'AbortError' || name === 'TimeoutError') return true
  if (name === 'NetworkError') return true
  const msg = String((e && e.message) || e)
  if (name === 'TypeError' && NETWORK_ERROR_RE.test(msg)) return true
  return NETWORK_ERROR_RE.test(msg)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 单次尝试。网络层失败返回 kind:'unreachable'，其余直接给出最终结果。 */
async function fetchStatusOnce(signal) {
  try {
    const res = await fetch(DATA_API, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal,
    })
    // 404 = 宿主没有这个路由（数据面没挂上），不是错误
    if (res.status === 404) return { kind: 'detached' }
    const body = await res.json().catch(() => null)
    if (!res.ok || !body || body.ok !== true) {
      return { kind: 'wired', reason: (body && body.error) || `HTTP ${res.status}` }
    }
    const data = body.data || {}
    // 宿主自报数据面没挂上时，仍信宿主（它比前端清楚）
    if (data.dataPlane && data.dataPlane.mounted === false) return { kind: 'detached', data }
    return { kind: 'live', data }
  } catch (e) {
    if (isNetworkFailure(e)) {
      const reason = e && e.name === 'AbortError' ? `超时 ${FETCH_TIMEOUT_MS}ms` : String((e && e.message) || e)
      return { kind: 'unreachable', reason }
    }
    // fetch 抛了但不像网络层原因 —— 保守当成真错误，宁可显示"读取失败"
    return { kind: 'wired', reason: String((e && e.message) || e) }
  }
}

/**
 * 从只读端点拿真实状态（四态）。
 *
 * 网络层失败做**一次有界重试**：等 RETRY_DELAY_MS 再试一次，整体仍由
 * 同一个 FETCH_TIMEOUT_MS 定时器兜底（总时间不因重试而翻倍）。
 * 第二次还是网络层失败才返回 unreachable；第二次成功就按成功结果返回。
 */
async function fetchStatus() {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null
  try {
    const signal = controller ? controller.signal : undefined
    const first = await fetchStatusOnce(signal)
    if (first.kind !== 'unreachable') return first
    await delay(RETRY_DELAY_MS)
    // 预算已经烧完（定时器把 signal 打断）就不再多打一次请求
    if (controller && controller.signal.aborted) return first
    return await fetchStatusOnce(signal)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 读**完整**设置快照（写端点 GET，只读用）。
 *
 * 为什么读设置面要多跑一趟：模型来源改成「宿主模型（选供应商与模型）」之后，
 * 面板要三样只读端点给不了的东西 ——
 *   llm.available（宿主的 llm 服务到底在不在）、
 *   modelCatalog（供应商目录与每个供应商的模型目录）、
 *   hostDefault（宿主设置页里的默认模型，给「用宿主默认模型」那个按钮）。
 * 这三样都只有设置快照里有；只读端点刻意只吐记忆核心自己的状态，不替宿主转述。
 *
 * 纪律：只读，所以**不碰写通道**（本文件只有 postLaurel 一处 POST）。
 * 任何失败（非 2xx / 解析失败 / 网络异常 / 没有 data）一律返回 null 不抛 ——
 * 调用方据此退回 fetchStatus() 的四态判断，而不是把一个"没读到"渲染成"读取失败"。
 */
async function fetchSettingsFull() {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null
  try {
    const res = await fetch(SETTINGS_API, {
      method: 'GET',
      headers: { accept: 'application/json', ...UI_HEADER },
      signal: controller ? controller.signal : undefined,
    })
    if (!res || !res.ok) return null
    const body = await res.json().catch(() => null)
    if (!body || body.ok !== true || !body.data) return null
    return body.data
  } catch (e) {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 提交设置（写通道）。
 *
 * 三条纪律：
 *   - 带 `x-laurel-ui: 1`：跨站请求带不上自定义头，等于一道 CSRF 栅栏；
 *   - 失败不吞：把宿主给的原因原样交回去，界面上必须能看见"为什么没成"；
 *   - 结果以宿主回的快照为准（不用本地草稿假装成功）。
 *
 * @param {{tier?: string, modelSource?: string, baseUrl?: string|null}} patch
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
/** 提交到写通道。**鉴权栅栏只有这一处**（settings-api.js 那两层）。 */
async function postLaurel(body, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const res = await fetch(SETTINGS_API, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...UI_HEADER,
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    })
    const parsed = await res.json().catch(() => null)
    if (!res.ok || !parsed || parsed.ok !== true) {
      return { ok: false, error: (parsed && parsed.error) || `HTTP ${res.status}` }
    }
    return { ok: true, data: parsed.data || null }
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? `超时 ${timeoutMs}ms` : String((e && e.message) || e)
    return { ok: false, error: reason }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 提交设置（tier / modelSource / baseUrl）。
 *
 * 三条纪律：
 *   - 带 `x-laurel-ui: 1`：跨站请求带不上自定义头，等于一道 CSRF 栅栏；
 *   - 失败不吞：把宿主给的原因原样交回去，界面上必须能看见"为什么没成"；
 *   - 结果以宿主回的快照为准（不用本地草稿假装成功）。
 */
async function saveSettings(patch) {
  return postLaurel(patch, SAVE_TIMEOUT_MS)
}

/**
 * 执行一次管理动作（MC13）。
 *
 * 走**和设置同一条**已鉴权的写通道，body 形状固定为 `{action, payload}`。
 * 不为它另开端点的理由：那道栅栏（本机/同源 + `x-laurel-ui` + 8KB 上限）
 * 已经在 `settings-api.js` 里验证过；再挂一条裸路由等于把同一道栅栏抄第二遍，
 * 抄漏一次就是无鉴权写口。宿主侧 `writeSettings` 认这个形状后转给 admin-api。
 */
async function runAdmin(action, payload) {
  return postLaurel({ action, payload: payload || {} }, ADMIN_TIMEOUT_MS)
}

// ── 管理面四个页签（MC13）─────────────────────────────────────────────
//
// 为什么拆成组件而不是在一个 Panel 里堆 if：每个页签各有一份自己的输入
// （搜索词、正在编辑的正文、采纳时要补的摘要、打包路径）。塞进一个组件里，
// 「切到经验页再切回来」就会把刚敲的搜索词清空 —— 这类小摩擦正是
// 用户最终放弃面板、回去敲 CLI 的原因。
//
// 每个页签共同的纪律：**只显示宿主真回的东西**。动作失败就把原因原样摆出来，
// 不显示一个"看起来成功"的空壳（L13 那一类：面板显示得像有数据，其实是硬编码）。

/** 页签共用的「读一次 → 有错就摆出来」钩子。 */
function useAdminData(t, run, action, payload) {
  const React = require('react')
  const [s, setS] = React.useState({ busy: true, error: null, data: null })
  const load = async () => {
    setS({ busy: true, error: null, data: null })
    const r = await run(action, payload || {})
    if (!r.ok) { setS({ busy: false, error: r.error || t.failed, data: null }); return }
    setS({ busy: false, error: null, data: r.data })
  }
  React.useEffect(() => { load() }, [])
  return [s, load, setS]
}

/** 今天：回答「今天发生了什么 + 有没有值得采纳的」，不是一串裸数字。 */
function AdminToday({ t, run }) {
  const React = require('react')
  const h = React.createElement
  const [s, load] = useAdminData(t, run, 'today')
  if (s.busy) return h('p', { className: 'laurel-hint' }, t.working)
  if (s.error) {
    return h('div', null,
      h('p', { className: 'laurel-error' }, `${t.failed}${s.error}`),
      h('button', { type: 'button', onClick: load }, t.refresh))
  }
  const d = s.data || {}
  const eps = d.episodes || {}
  const kinds = Object.entries(d.byKind || {}).map(([k, v]) => `${k} ${v}`).join(' · ')
  const authors = Object.entries(d.byAuthor || {}).map(([k, v]) => `${k} ${v}`).join(' · ')
  return h('div', null,
    h('div', { className: 'laurel-row' },
      h('span', null, t.todayCount),
      h('span', null, `${d.todayRecords ?? 0} / ${d.records ?? 0}`)),
    d.badLines ? h('p', { className: 'laurel-error' }, `${t.badLines}${d.badLines}`) : null,
    kinds ? h('p', { className: 'laurel-hint' }, `${t.todayKinds}：${kinds}`) : null,
    authors ? h('p', { className: 'laurel-hint' }, `${t.todayAuthors}：${authors}`) : null,
    h('div', { className: 'laurel-row' },
      h('span', null, t.pendingEpisodes),
      h('span', null, String(eps.pending ?? 0))),
    (eps.top && eps.top.length)
      ? h('ul', null, eps.top.map((e) => h('li', { key: e.id }, `${e.state} · ${e.summary}`)))
      : h('p', { className: 'laurel-hint' }, t.noPending),
    h('button', { type: 'button', onClick: load }, t.refresh))
}

/** 记忆：搜 → 读全文（分页）→ 更正 / 撤销。 */
function AdminMemory({ t, run }) {
  const React = require('react')
  const h = React.createElement
  const [q, setQ] = React.useState('')
  const [hits, setHits] = React.useState(null)
  const [open, setOpen] = React.useState(null)
  const [edit, setEdit] = React.useState(null)
  const [rev, setRev] = React.useState(null)
  const [s, setS] = React.useState({ busy: false, error: null, message: null })

  async function doSearch() {
    const word = String(q || '').trim()
    if (!word) return
    setS({ busy: true, error: null, message: null })
    const r = await run('search', { query: word, limit: 10 })
    if (!r.ok) { setS({ busy: false, error: r.error || t.failed, message: null }); setHits([]); return }
    setS({ busy: false, error: null, message: null })
    setHits(r.data.hits || [])
    setOpen(null)
    setEdit(null)
    setRev(null)
  }

  async function openRecord(id, offset) {
    setS({ busy: true, error: null, message: null })
    const r = await run('page', { id, offset: offset || 0, lines: 40 })
    if (!r.ok) { setS({ busy: false, error: r.error || t.failed, message: null }); return }
    setS({ busy: false, error: null, message: null })
    setOpen({ id, text: r.data.text, offset: r.data.offset, total: r.data.total, hasMore: r.data.hasMore, lines: r.data.lines })
  }

  /** 更正要先拿到**整条正文**：分页只给一页，改一页会把后面几页丢掉。 */
  async function startEdit(id) {
    setS({ busy: true, error: null, message: null })
    const r = await run('page', { id, offset: 0, lines: 400 })
    if (!r.ok) { setS({ busy: false, error: r.error || t.failed, message: null }); return }
    setS({ busy: false, error: null, message: r.data.hasMore ? t.editHint : null })
    setEdit({ id, text: r.data.text, truncated: r.data.hasMore === true })
  }

  async function submitEdit() {
    if (!edit) return
    // 正文超过一页（400 行）时**不许保存**：文本框里只有前 400 行，
    // 拿它当新版本提交等于把后面几百行删掉，而「更正」这个动作的本意是改措辞。
    // 这一条写在实现里而不是只写在 README 里 —— 界面提示挡不住误点。
    if (edit.truncated) {
      setS({ busy: false, error: t.editTooLong, message: null })
      return
    }
    setS({ busy: true, error: null, message: null })
    const r = await run('correct', { id: edit.id, text: edit.text })
    if (!r.ok) { setS({ busy: false, error: r.error || t.failed, message: null }); return }
    setS({ busy: false, error: null, message: `${t.applied} · revision ${r.data.revision}` })
    setEdit(null)
    await doSearch()
  }

  async function submitRevoke() {
    if (!rev || !String(rev.reason || '').trim()) return
    setS({ busy: true, error: null, message: null })
    const r = await run('revoke', { id: rev.id, reason: String(rev.reason).trim() })
    if (!r.ok) { setS({ busy: false, error: r.error || t.failed, message: null }); return }
    setS({ busy: false, error: null, message: `${t.applied} · ${r.data.status}` })
    setRev(null)
    await doSearch()
  }

  return h('div', null,
    h('div', { className: 'laurel-row' },
      h('input', {
        type: 'text',
        value: q,
        placeholder: t.searchPlaceholder,
        style: { minWidth: '320px' },
        onChange: (e) => setQ(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') doSearch() },
      }),
      h('button', { type: 'button', onClick: doSearch, disabled: s.busy }, t.searchBtn)),
    s.error ? h('p', { className: 'laurel-error' }, `${t.failed}${s.error}`) : null,
    s.message ? h('p', { className: 'laurel-hint' }, s.message) : null,
    hits === null ? null
      : hits.length === 0 ? h('p', { className: 'laurel-hint' }, t.noHits)
        : h('ul', null, hits.map((x) => h('li', { key: x.id },
          h('span', null, `[${x.kind}] `),
          h('span', { title: `${x.id} · ${x.score ?? ''}` }, x.head || ''),
          h('button', { type: 'button', onClick: () => openRecord(x.id, 0) }, t.openRecord),
          h('button', { type: 'button', onClick: () => startEdit(x.id) }, t.correct),
          h('button', { type: 'button', onClick: () => setRev({ id: x.id, reason: '' }) }, t.revoke)))),
    open ? h('div', null,
      h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '320px', overflow: 'auto' } }, open.text),
      h('div', { className: 'laurel-row' },
        h('span', null, `${open.offset + 1}–${open.offset + open.lines} / ${open.total}`),
        open.offset > 0 ? h('button', { type: 'button', onClick: () => openRecord(open.id, Math.max(0, open.offset - open.lines)) }, t.prev) : null,
        open.hasMore ? h('button', { type: 'button', onClick: () => openRecord(open.id, open.offset + open.lines) }, t.next) : null)) : null,
    edit ? h('div', null,
      h('p', { className: 'laurel-hint' }, t.editHint),
      edit.truncated ? h('p', { className: 'laurel-error' }, `${t.gaps}: 400+`) : null,
      h('textarea', {
        rows: 10,
        style: { width: '100%' },
        value: edit.text,
        onChange: (e) => setEdit({ ...edit, text: e.target.value }),
      }),
      h('div', { className: 'laurel-row' },
        h('button', { type: 'button', onClick: submitEdit, disabled: s.busy }, t.save),
        h('button', { type: 'button', onClick: () => setEdit(null) }, t.cancel))) : null,
    rev ? h('div', null,
      h('p', { className: 'laurel-hint' }, t.revokeHint),
      h('input', {
        type: 'text',
        value: rev.reason,
        placeholder: t.reasonPlaceholder,
        style: { minWidth: '320px' },
        onChange: (e) => setRev({ ...rev, reason: e.target.value }),
      }),
      h('div', { className: 'laurel-row' },
        h('button', { type: 'button', onClick: submitRevoke, disabled: s.busy || !String(rev.reason || '').trim() }, t.revoke),
        h('button', { type: 'button', onClick: () => setRev(null) }, t.cancel))) : null)
}

/** 经验自动处理；人工可纠错、停用或撤销。 */
function AdminExperience({ t, run }) {
  const React = require('react')
  const h = React.createElement
  const [filter, setFilter] = React.useState('')
  const [s, load] = useAdminData(t, run, 'episodes', {})
  const [busy, setBusy] = React.useState(false)
  const [out, setOut] = React.useState({ error: null, message: null })

  async function act(action, payload, okText) {
    setBusy(true)
    setOut({ error: null, message: null })
    const r = await run(action, payload)
    if (!r.ok) { setBusy(false); setOut({ error: r.error || t.failed, message: null }); return r }
    setBusy(false)
    setOut({ error: null, message: okText || t.applied })
    await load()
    return r
  }

  if (s.busy) return h('p', { className: 'laurel-hint' }, t.working)
  if (s.error) {
    return h('div', null,
      h('p', { className: 'laurel-error' }, `${t.failed}${s.error}`),
      h('button', { type: 'button', onClick: load }, t.refresh))
  }
  const d = s.data || {}
  const all = Array.isArray(d.episodes) ? d.episodes : []
  const list = filter ? all.filter((e) => e.state === filter) : all
  const states = Array.isArray(d.states) ? d.states : []
  return h('div', null,
    h('p', { className: 'laurel-hint' }, t.automaticHint),
    h('div', { className: 'laurel-row' },
      h('span', null, `${d.total ?? 0}`),
      h('select', { value: filter, onChange: (e) => setFilter(e.target.value) },
        h('option', { value: '' }, t.filterAll),
        states.map((st) => h('option', { key: st, value: st }, `${st} ${(d.byState && d.byState[st]) || 0}`))),
      h('button', { type: 'button', onClick: load }, t.refresh)),
    out.error ? h('p', { className: 'laurel-error' }, `${t.failed}${out.error}`) : null,
    out.message ? h('p', { className: 'laurel-hint' }, out.message) : null,
    list.length === 0 ? h('p', { className: 'laurel-hint' }, t.expEmpty) : h('ul', null, list.map((e) => h('li', { key: e.id },
      h('span', null, `${e.state}${e.methodOk ? '' : ' · 方法不齐'} · `),
      h('span', null, e.summary || ''),
      e.state === 'candidate' || e.state === 'raw-episode'
        ? h('span', { className: 'laurel-hint' }, t.observing) : null,
      e.state === 'adopted' || e.state === 'trial'
        ? h('span', null,
          h('button', { type: 'button', disabled: busy, onClick: () => act('retire', { id: e.id, reason: '不再适用' }, t.applied) }, t.retire)) : null,
      e.state !== 'revoked'
        ? h('button', { type: 'button', disabled: busy, onClick: () => act('episode-revoke', { id: e.id, reason: '记错了' }, t.applied) }, t.epRevoke) : null))))
}

/** 搬家：完整打包 / 从归档恢复 / 清理计划与执行。 */
function AdminMove({ t, run }) {
  const React = require('react')
  const h = React.createElement
  const [outPath, setOutPath] = React.useState('')
  const [arch, setArch] = React.useState('')
  const [target, setTarget] = React.useState('')
  const [confirm, setConfirm] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [res, setRes] = React.useState(null)

  async function go(action, payload) {
    setBusy(true)
    setRes(null)
    const r = await run(action, payload)
    setBusy(false)
    setRes(r)
    return r
  }

  return h('div', null,
    h('p', { className: 'laurel-hint' }, t.moveHint),
    h('div', { className: 'laurel-row' },
      h('input', {
        type: 'text', value: outPath, placeholder: t.exportPath, style: { minWidth: '360px' },
        onChange: (e) => setOutPath(e.target.value),
      }),
      h('button', {
        type: 'button', disabled: busy,
        onClick: () => go('export', outPath.trim() ? { outPath: outPath.trim() } : {}),
      }, t.exportBtn)),
    h('div', { className: 'laurel-row' },
      h('input', {
        type: 'text', value: arch, placeholder: t.restoreArchive, style: { minWidth: '360px' },
        onChange: (e) => setArch(e.target.value),
      })),
    h('div', { className: 'laurel-row' },
      h('input', {
        type: 'text', value: target, placeholder: t.restoreTarget, style: { minWidth: '360px' },
        onChange: (e) => setTarget(e.target.value),
      })),
    h('div', { className: 'laurel-row' },
      h('label', null,
        h('input', { type: 'checkbox', checked: confirm, onChange: (e) => setConfirm(e.target.checked) }),
        ` ${t.confirmDestructive}`),
      h('button', {
        type: 'button', disabled: busy || !confirm,
        onClick: () => go('restore', { confirm: true, archivePath: arch.trim(), targetDir: target.trim() }),
      }, t.restore)),
    h('div', { className: 'laurel-row' },
      h('button', { type: 'button', disabled: busy, onClick: () => go('retention-plan', {}) }, t.retentionPlan),
      h('button', {
        type: 'button', disabled: busy || !confirm,
        onClick: () => go('retention-apply', { confirm: true }),
      }, t.retentionApply)),
    // S8：哨兵。快检不解 JSON（数十毫秒），深检真解一次（真仓秒级）。
    // **四档一起显示、unmeasured 单独一列** —— 把它并进「通过」那一格，
    // 就是「9/9 全绿而真相是 9/10」。
    h('div', { className: 'laurel-row' },
      h('button', { type: 'button', disabled: busy, onClick: () => go('selfcheck', {}) }, t.selfcheck),
      h('button', { type: 'button', disabled: busy, onClick: () => go('selfcheck', { deep: true }) }, t.selfcheckDeep)),
    res === null ? null
      : res.ok !== true
        ? h('p', { className: 'laurel-error' }, `${t.failed}${res.error || ''}`)
        : h('div', null,
          res.data && res.data.path
            ? h('p', { className: 'laurel-hint' }, `${res.data.path} · ${res.data.bytes ?? 0} B · ${t.sha} ${res.data.sha256 || ''}`) : null,
          res.data && res.data.complete !== undefined
            ? h('p', { className: res.data.complete ? 'laurel-hint' : 'laurel-error' }, res.data.complete ? t.completeYes : t.completeNo) : null,
          res.data && Array.isArray(res.data.gaps) && res.data.gaps.length
            ? h('p', { className: 'laurel-error' }, `${t.gaps}: ${JSON.stringify(res.data.gaps).slice(0, 400)}`) : null,
          res.data && res.data.candidateCount !== undefined
            ? h('p', { className: 'laurel-hint' }, `candidates ${res.data.candidateCount} · reclaimable ${res.data.reclaimableBytes ?? 0} B`) : null,
          res.data && res.data.target ? h('p', { className: 'laurel-hint' }, `${t.applied} · ${res.data.target}`) : null,
          res.data && Array.isArray(res.data.items)
            ? h('div', null,
              h('p', { className: 'laurel-hint' },
                `${t.selfcheckSummary} · ok ${res.data.summary?.ok ?? 0} / warn ${res.data.summary?.warn ?? 0} / error ${res.data.summary?.error ?? 0} / ${t.selfcheckUnmeasured} ${res.data.summary?.unmeasured ?? 0}`),
              h('p', { className: res.data.summary?.verdict === 'healthy' ? 'laurel-hint' : 'laurel-error' },
                res.data.summary?.note || ''),
              h('ul', null, res.data.items.map((it) => h('li', { key: it.id },
                h('span', null, `${it.id} · ${it.state} · `),
                h('span', { className: it.state === 'ok' ? 'laurel-hint' : 'laurel-error' }, it.detail || '')))))
            : null))
}

/**
 * 注册记忆核心的设置面板。
 *
 * 2026-10-19（D66）：这里原来是本文件自己实现的一份「单路注册」——
 * 只 `slots.inject('settings.section', ...)`。而总控（Laurel 控制中心）
 * 渲染的是聚合插槽 `laurel-center.module`，两边插槽名压根不相等：
 *   总控 index.mjs:75  const MODULE_SLOT = 'laurel-center.module'
 *   本文件           const SLOT = 'settings.section'
 * 于是装了总控的宿主里，总控永远等不到模块写入，面板显示
 * 「等待模块设置加载 / 模块尚未向本窗口提供设置」。
 *
 * 更隐蔽的是：本文件原来那个函数**也叫 `registerSettingsSection`**，
 * 而 scripts/build-client.mjs 的 composeBundle() 把清单里所有文件拼进
 * 同一个 IIFE 作用域。kit（lib/client-kit.js）里已经有一个同名函数，
 * 本文件那份排在后面 → 静默覆盖 kit 的两路注册，不报错不警告。
 * 排查时看到「kit 明明支持两路」却完全不生效，根源就在这里。
 *
 * 现在改成：本地函数改名，注册逻辑交给 kit 的 `registerSettingsSection`，
 * 由它做「总控在 → 收进 laurel-center.module；总控不在 → 退回
 * settings.section」的两路选择。与 dsh-strata / laurel 自己的写法一致。
 */
function registerMemorySettings(ctx, React) {
  const h = React.createElement
  function Panel() {
    const [state, setState] = React.useState({ loading: true, mode: 'live', error: null, data: null })
    // 当前页签（今天 / 记忆 / 经验 / 搬家）。放 Panel 里而不是各页签组件里：
    // 切走再切回来时页签必须还是刚才那个，否则用户会以为「点半天没反应」。
    const [tab, setTab] = React.useState('today')
    // 本地草稿：改动先停在草稿里，点「应用」才提交 —— 切档位会触发一次真实
    // 的端点探测（一次极小的模型调用），不能每按一下方向键就打一次。
    const [draft, setDraft] = React.useState({ tier: '', modelSource: '', baseUrl: '', provider: '', model: '' })
    const [save, setSave] = React.useState({ busy: false, message: null, error: null })

    React.useEffect(() => {
      let alive = true
      const load = async () => {
        // 先要完整设置快照：供应商目录 / 模型目录 / 宿主默认模型只有这里才有。
        // 拿到了就是 live（数据更全，四态判断也用不着了）。
        const full = await fetchSettingsFull()
        if (!alive) return
        if (full) { setState({ loading: false, mode: 'live', error: null, data: full }); return }
        // 拿不到（非 Web 组合、旧宿主、写通道没挂）才退回只读端点的四态判断。
        // 四态语义一字不改 —— "没接上 / 没连上 / 读取失败"仍然要分得清。
        const r = await fetchStatus()
        if (!alive) return
        if (r.kind === 'live') { setState({ loading: false, mode: 'live', error: null, data: r.data }); return }
        if (r.kind === 'detached') { setState({ loading: false, mode: 'detached', error: null, data: r.data || null }); return }
        // 网络层失败：中性提示，绝不落到 wired（那会显示"读取失败"）
        if (r.kind === 'unreachable') { setState({ loading: false, mode: 'unreachable', error: r.reason, data: null }); return }
        setState({ loading: false, mode: 'wired', error: r.reason, data: null })
      }
      load()
      return () => { alive = false }
    }, [])

    // 数据到了才初始化草稿（不能放在 useState 初值里 —— 那时还没有数据）
    React.useEffect(() => {
      const d = state.data
      if (!d) return
      setDraft({
        tier: d.tier || 'zero',
        modelSource: d.modelSource || 'none',
        baseUrl: d.modelBaseUrl || '',
        // 宿主模型选的是 (供应商, 模型) 这一对 —— 两个都要进草稿，
        // 否则"只换了模型"或"只换了供应商"会被 dirty 判成没改，应用按钮点不动。
        provider: d.modelProvider || '',
        model: d.modelName || '',
      })
    }, [state.data])

    async function onApply() {
      setSave({ busy: true, message: null, error: null })
      const d = state.data || {}
      const patch = {}
      if (draft.tier && draft.tier !== d.tier) patch.tier = draft.tier
      if (draft.modelSource && draft.modelSource !== d.modelSource) patch.modelSource = draft.modelSource
      const url = String(draft.baseUrl || '').trim()
      if (draft.modelSource === 'local') {
        if (!url) { setSave({ busy: false, message: null, error: TEXT.zh.needLocalUrl }); return }
        patch.baseUrl = url
      } else if (draft.modelSource === 'api') {
        // 宿主模型：只报 (供应商, 模型) 这一对，地址与密钥都归宿主管理。
        patch.provider = String(draft.provider || '').trim()
        patch.model = String(draft.model || '').trim()
        // baseUrl **一定**带 null：api + 手填地址在宿主那边会被判成历史遗留的
        // external 路由（「现在生效的还是外部端点」），不清掉就永远切不回宿主模型。
        patch.baseUrl = null
      } else if (draft.modelSource === 'none') {
        patch.baseUrl = null
      }
      if (Object.keys(patch).length === 0) {
        setSave({ busy: false, message: TEXT.zh.saved, error: null })
        return
      }
      const result = await saveSettings(patch)
      if (!result.ok) { setSave({ busy: false, message: null, error: result.error }); return }
      try { window.dispatchEvent(new CustomEvent('laurel:configuration-saved', { detail: { id: 'memory-core', persisted: true } })) } catch {}
      setState((prev) => ({ ...prev, mode: 'live', error: null, data: result.data || prev.data }))
      setSave({ busy: false, message: TEXT.zh.saved, error: null })
    }

    // 管理动作的执行器：走**和设置同一条**已鉴权通道（见 runAdmin）。
    const run = (action, payload) => runAdmin(action, payload)

    const t = TEXT.zh
    if (state.loading) return h('div', { className: 'laurel-panel' }, h('p', null, t.rebuilding))
    // 端点没挂上（非 Web 组合）：这是**正常**状态，不该红着报错。
    // 但也不能显示一个像真数据的空壳 —— 如实说"未接数据"。
    if (state.mode === 'detached') {
      return h('div', { className: 'laurel-panel' },
        h('h3', null, t.heading),
        h('p', { className: 'laurel-desc' }, t.desc),
        h('p', { className: 'laurel-hint' }, t.notWired),
      )
    }
    // 端点挂上了但这次没读成：这才是真的"读取失败"，必须报出来。
    if (state.mode === 'wired') {
      return h('div', { className: 'laurel-panel' },
        h('h3', null, t.heading),
        h('p', { className: 'laurel-error' }, t.readFailed),
        h('p', { className: 'laurel-hint' }, String(state.error)),
      )
    }
    // 网络层失败：中性提示（laurel-hint），不是 laurel-error ——
    // "这次没连上宿主"和"核心仓坏了"是两件事，颜色不能一样。
    if (state.mode === 'unreachable') {
      return h('div', { className: 'laurel-panel' },
        h('h3', null, t.heading),
        h('p', { className: 'laurel-hint' }, t.unreachable),
        h('p', { className: 'laurel-hint' }, String(state.error)),
      )
    }
    const d = state.data || {}
    const enabledText = d.enabled ? t.enabled : t.disabled
    // 选项表由宿主侧给（d.options），前端不再自己写一份枚举
    const tierOptions = (d.options && Array.isArray(d.options.tiers) && d.options.tiers.length > 0)
      ? d.options.tiers
      : [{ id: 'zero', label: t.tiers.zero }, { id: 'balanced', label: t.tiers.balanced }, { id: 'full', label: t.tiers.full }]
    const sourceOptions = (d.options && Array.isArray(d.options.sources) && d.options.sources.length > 0)
      ? d.options.sources
      : [
        { id: 'none', label: t.sources.none },
        { id: 'local', label: t.sources.local },
        { id: 'api', label: t.sources.api },
      ]
    // 宿主要说自己有没有挂上写通道；没说就按"能写"渲染（旧宿主没这个字段）
    const writable = !(d.dataPlane && d.dataPlane.writable === false)
    // 草稿里现在是哪一个来源：切到一半也算（用户刚选了「宿主模型」，下拉要立刻出现）
    const draftSource = draft.modelSource || d.modelSource || 'none'
    // 宿主模型那一组控件只在 api 下出现
    const hostModelUi = draftSource === 'api'
    const dirty = (draft.tier && draft.tier !== d.tier)
      || (draft.modelSource && draft.modelSource !== d.modelSource)
      || (draftSource !== 'none' && draftSource !== 'api' && String(draft.baseUrl || '').trim() !== String(d.modelBaseUrl || '').trim())
      // 宿主模型档下，"宿主那边还存着历史地址"本身就是待办：应用一次就清掉它，
      // 否则这一项永远 dirty 不起来，用户看着 external 提示却找不到能点的按钮
      || (hostModelUi && !!d.modelBaseUrl)
      // 选中的 (供应商, 模型) 与宿主已保存的不一致也算改动 ——
      // 少算这一项，「换了个模型」会被判成没改，应用按钮就是灰的
      || (hostModelUi && String(draft.provider || '').trim() !== String(d.modelProvider || '').trim())
      || (hostModelUi && String(draft.model || '').trim() !== String(d.modelName || '').trim())
    const selectStyle = { maxWidth: '260px' }

    // ── 宿主模型（供应商 + 模型）────────────────────────────────────────
    // 旧做法是「api = 自动发现网关地址 + 读密钥文件 + 猜宿主当前模型」，猜错
    // 就是「面板说在用、真调用连不上」。现在地址和密钥都归宿主管理，这里只让用户
    // 在宿主设置页那批供应商里选一个，再选它的模型。
    const llmDown = d.llm && d.llm.available === false
    const catalog = d.modelCatalog || null
    const catalogProviders = (catalog && Array.isArray(catalog.providers)) ? catalog.providers
      .filter((row) => row && typeof row.id === 'string' && row.id) : []
    const catalogDown = !!catalog && catalog.ok === false
    const catalogUnknown = !catalog
    // 「目录拿不到」的三种形态，一律如实说，不渲染一个点开只有占位项的空壳下拉：
    //   ① 宿主说目录失败（catalog.ok === false）
    //   ② 快照里压根没有 modelCatalog（退回只读端点那种老路径）
    //   ③ 目录是好的，但宿主里一个供应商都没注册
    const catalogMissing = catalogDown || catalogUnknown
    const noProviders = !!catalog && catalog.ok === true && catalogProviders.length === 0
    const catalogReason = catalogUnknown
      ? '这次只拿到状态，快照里没有供应商目录'
      : (catalog.reason || (noProviders ? '宿主里没有注册任何供应商' : '未知原因'))
    // llm 服务不在时，"目录没给"只是它的后果；原因要报 llm 的那个，
    // 否则用户看到的是"没有供应商目录"，转头去查自己的供应商配置。
    const blockReason = llmDown ? ((catalog && catalog.reason) || '未知原因') : catalogReason
    const selectedProviderId = String(draft.provider || '')
    const selectedProvider = catalogProviders.find((row) => row.id === selectedProviderId) || null
    // 供应商没公布模型目录（账号型供应商就是这样）：下拉换成文本输入，
    // 让用户直接填模型 id —— 这不等于「不能用」，只是宿主问不出名字。
    const providerModels = selectedProvider && Array.isArray(selectedProvider.models) ? selectedProvider.models : []
    const modelFreeText = !!selectedProvider
      && (selectedProvider.modelsOk === false || providerModels.length === 0)
    // 已保存的模型不在目录里时也要能看见（宿主那边真存着它，下拉却显示空
    // 会让用户以为"没选"，于是去点一个其实已经生效的东西）
    const draftModelId = String(draft.model || '')
    const modelChoices = providerModels.slice()
    if (draftModelId && !modelChoices.some((row) => row && row.id === draftModelId)) {
      modelChoices.push({ id: draftModelId, name: draftModelId })
    }
    const hostModelLine = h('div', { className: 'laurel-row' },
      h('span', null, t.hostModelLine),
      h('span', null, `${d.modelProvider || '—'} / ${d.modelName || '—'}`))
    // 外部路由是历史遗留（api + 手填地址），不提示的话用户在下面选完也不知道为什么没生效
    const externalLine = (d.modelRoute && d.modelRoute.kind === 'external')
      ? h('p', { className: 'laurel-hint' }, t.externalRoute) : null
    const hostDefaultRow = (d.hostDefault && d.hostDefault.ok && d.hostDefault.provider && d.hostDefault.model)
      ? h('div', { className: 'laurel-row' },
        h('button', {
          type: 'button',
          disabled: !writable || save.busy,
          // 只填草稿，不直接提交：改完还得点「应用」，与这一页其它控件同一个节奏
          onClick: () => setDraft((prev) => ({ ...prev, provider: d.hostDefault.provider, model: d.hostDefault.model })),
        }, t.useHostDefault),
        h('span', { className: 'laurel-hint' }, `${d.hostDefault.provider} / ${d.hostDefault.model}`))
      : null

    let hostModelBlock = null
    if (hostModelUi && (llmDown || catalogMissing || noProviders)) {
      // 宿主自己说没有目录 / llm 服务不在：如实说，绝不渲染一个空壳下拉
      // （空下拉看起来"有得选"，其实一个选项都没有）
      hostModelBlock = h('div', null,
        h('p', { className: 'laurel-error' },
          `${llmDown ? t.hostUnavailable : t.noCatalog}${blockReason}`),
        hostModelLine)
    } else if (hostModelUi) {
      const providerRow = h('div', { className: 'laurel-row' },
        h('label', { htmlFor: 'laurel-memory-provider' }, t.modelProviderLabel),
        h('select', {
          id: 'laurel-memory-provider',
          value: selectedProviderId,
          disabled: !writable || save.busy,
          style: selectStyle,
          onChange: (e) => setDraft((prev) => ({
            ...prev,
            provider: e.target.value,
            // 换供应商就把模型清掉：上一个供应商的模型 id 留在新供应商名下
            // 必定是错的一对，宿主那边会直接拒。
            model: '',
          })),
        },
          h('option', { value: '' }, t.pickProvider),
          catalogProviders.map((row) => h('option', { key: row.id, value: row.id }, row.name || row.id))),
      )
      const modelRow = !selectedProvider ? null
        : modelFreeText
          ? h('div', { className: 'laurel-row' },
            h('label', { htmlFor: 'laurel-memory-model' }, t.modelNameLabel),
            h('input', {
              id: 'laurel-memory-model',
              type: 'text',
              value: draft.model || '',
              placeholder: t.modelInputPlaceholder,
              disabled: !writable || save.busy,
              style: { minWidth: '320px' },
              onChange: (e) => setDraft((prev) => ({ ...prev, model: e.target.value })),
            }),
            h('span', { className: 'laurel-hint' }, t.catalogEmpty))
          : h('div', { className: 'laurel-row' },
            h('label', { htmlFor: 'laurel-memory-model' }, t.modelNameLabel),
            h('select', {
              id: 'laurel-memory-model',
              value: draft.model || '',
              disabled: !writable || save.busy,
              style: selectStyle,
              onChange: (e) => setDraft((prev) => ({ ...prev, model: e.target.value })),
            },
              h('option', { value: '' }, t.pickModel),
              modelChoices.map((row) => h('option', { key: row.id, value: row.id }, row.name || row.id))))
      hostModelBlock = h('div', null, providerRow, modelRow, hostModelLine, hostDefaultRow, externalLine)
    }

    return h('div', { className: 'laurel-panel' },
      h('h3', null, t.heading),
      h('p', { className: 'laurel-desc' }, t.desc),
      // 未启用时把原因摆出来 —— 用户看到"开着却没用"最容易困惑
      d.enabled ? null : h('p', { className: 'laurel-error' }, `${t.disabled}：${d.error || '未知原因'}`),
      h('div', { className: 'laurel-row' },
        h('span', null, t.statusLabel),
        h('span', null, enabledText),
      ),
      // 全局设置收进 <details>：一个非程序员进这个面板，八成是想「看看今天记了什么 /
      // 改掉那条记错的」，而不是来改档位的。设置常驻会把真正的入口挤到折叠线以下。
      h('details', null,
        h('summary', null, t.settingsSummary),
        // ── 三档：下拉框，选中后在下面点「应用」 ──────────────────────────
        h('div', { className: 'laurel-row' },
          h('label', { htmlFor: 'laurel-memory-tier' }, t.tierLabel),
          h('select', {
            id: 'laurel-memory-tier',
            value: draft.tier || d.tier || 'zero',
            disabled: !writable || save.busy,
            style: selectStyle,
            onChange: (e) => setDraft((prev) => ({ ...prev, tier: e.target.value })),
          }, tierOptions.map((option) => h('option', { key: option.id, value: option.id }, option.label))),
        ),
        // ── 三来源：none / local / api(宿主模型：供应商 + 模型) ────────────
        h('div', { className: 'laurel-row' },
          h('label', { htmlFor: 'laurel-memory-source' }, t.sourceLabel),
          h('select', {
            id: 'laurel-memory-source',
            value: draft.modelSource || d.modelSource || 'none',
            disabled: !writable || save.busy,
            style: selectStyle,
            onChange: (e) => setDraft((prev) => ({ ...prev, modelSource: e.target.value })),
          }, sourceOptions.map((option) => h('option', { key: option.id, value: option.id }, option.label))),
        ),
        // 端点地址：只有本地模型才要填。宿主模型那一档地址与密钥都归宿主管理，
        // 再摆一个输入框只会让用户以为"这里留空=自动发现"（那套已经作废）。
        draftSource === 'local' ? h('div', { className: 'laurel-row' },
          h('label', { htmlFor: 'laurel-memory-endpoint' }, t.localUrlLabel),
          h('input', {
            id: 'laurel-memory-endpoint',
            type: 'text',
            value: draft.baseUrl || '',
            placeholder: 'http://127.0.0.1:11434/v1',
            disabled: !writable || save.busy,
            style: { minWidth: '320px' },
            onChange: (e) => setDraft((prev) => ({ ...prev, baseUrl: e.target.value })),
          }),
        ) : null,
        // ── 宿主模型：供应商 / 模型 / 当前生效的是谁 ──────────────────────
        hostModelBlock,
        writable ? h('div', { className: 'laurel-row' },
          h('span', null, ''),
          h('button', {
            type: 'button',
            onClick: onApply,
            disabled: save.busy || !dirty,
          }, save.busy ? t.saving : t.apply),
        ) : null,
        save.error ? h('p', { className: 'laurel-error' }, `${t.saveFailed}${save.error}`) : null,
        save.message ? h('p', { className: 'laurel-hint' }, save.message) : null,
        h('p', { className: 'laurel-hint' }, writable ? t.writableHint : t.readonlyHint),
        h('div', { className: 'laurel-row' },
          h('span', null, t.vaultLabel),
          h('span', { title: d.vaultDir || '' }, d.vaultDir || '—'),
        ),
        h('div', { className: 'laurel-row' },
          h('span', null, t.coreIdLabel),
          h('span', null, d.coreId || '—'),
        ),
        h('div', { className: 'laurel-row' },
          h('span', null, t.journalLabel),
          h('span', null, String(d.journalSeq ?? 0)),
        ),
        // 网关状态：零推理档要能看见"为什么没调用模型"，而不是看不见
        d.modelGateway && d.modelGateway.enabled === false
          ? h('p', { className: 'laurel-hint' }, `${t.modelSourceLabel}：${(d.modelGateway.reasons || []).join(', ') || '未启用'}`)
          : null,
      ),
      // ── 四个页签（MC13）：今天 / 记忆 / 经验 / 搬家 ────────────────────
      // 页签名来自 TEXT.tabs，与动作表的 label 一一对应（今天=today、记忆=search/page/
      // correct/revoke、经验=episodes/adopt/outcome/retire、搬家=export/restore/retention）。
      h('div', { className: 'laurel-row' },
        TABS.map(([id, i]) => h('button', {
          key: id,
          type: 'button',
          onClick: () => setTab(id),
          // 当前页不能用颜色以外的唯一线索：加粗 + 方括号，色盲用户也能分辨。
          style: tab === id ? { fontWeight: 'bold' } : null,
        }, tab === id ? `［${t.tabs[i]}］` : t.tabs[i]))),
      // 写通道没挂上时不渲染动作页签：让人点一个必然 403 的按钮，比不显示更糟。
      writable
        ? (tab === 'today' ? h(AdminToday, { t, run })
          : tab === 'memory' ? h(AdminMemory, { t, run })
            : tab === 'experience' ? h(AdminExperience, { t, run })
              : h(AdminMove, { t, run }))
        : h('p', { className: 'laurel-hint' }, t.readonlyHint),
    )
  }
  const slots = slotsOf(ctx)
  if (!slots || typeof slots.register !== 'function') {
    console.error('[laurel-memory] 没有 slots.register，设置页不注册（不抛，避免 web boot 整体失败）')
    return null
  }
  // 走 kit 的两路注册：总控在就收进聚合插槽，不在就退回独立设置页。
  // 不自己写 inject —— 那样会漏掉 `laurel-center.module` 那一路（D66）。
  return registerSettingsSection(ctx, {
    id: SETTINGS_ID,
    order: 21,
    label: () => LABEL,
    component: Panel,
    slots,
  })
}

/** 插件入口。 */
function apply(ctx) {
  const React = require('react')
  try {
    ctx.effect(() => registerMemorySettings(ctx, React), 'laurel-memory: settings')
  } catch (e) {
    console.error('[laurel-memory] 客户端激活失败：', (e && (e.stack || e.message)) || String(e))
    throw e
  }
}

export { apply, inject, TEXT, SETTINGS_ID, fetchStatus, saveSettings }
