/**
 * Laurel-Center · 原生 ChangeResult 的唯一解释器（宿主与客户端共用）
 *
 * ── 为什么单独一个文件（第二轮 F2）────────────────────────────────────────
 * 第一轮里「宿主半边」和「客户端半边」**各自**把原生 `application` 字符串翻成
 * 自己的 outcome。两套翻译必然漂移，实测已经漂了三处：
 *   · 四项都 restart-required、逐项记 partial，bulk 却只看 failure → 整体变 success
 *   · 写盘成功但 reload 失败（application:failed / changed:true）→ 被当成 saved:false
 *   · native 返回 undefined（协议缺字段）→ application:unknown，却给 ok/saved:true
 * 所以解释只写一遍：本文件是**纯函数、零依赖**，被
 *   · `lib/host.js`（宿主半边）直接 import
 *   · `lib/client/index.mjs`（客户端半边）经 `scripts/build-client.mjs` 内联
 * 同时引用。两个通道因此拿到同一份结果矩阵。
 *
 * ── 保存与应用是两件事 ────────────────────────────────────────────────────
 * 宿主 `pluginManager.setPluginEnabled` 的合同是「先写 profile 的
 * cordis.patch.yml（用户层），再 reload/HMR」。所以：
 *   saved   —— 用户层配置**确实**写成了我们要的目标值（要能核对，不能靠猜）
 *   applied —— 宿主在**本进程内**已经把它应用上（HMR 可用且 reload 成功）
 * `changed:true` 只说明宿主改过文件，**不等于**目标值就是我们要的；
 * 真正的确认是回读当前 patch 的目标值（见 `confirmTarget`）。
 *
 * ── 未知不是成功 ──────────────────────────────────────────────────────────
 * application 不认识（协议缺字段 / 未来新增值）时，`outcome` 是 `unknown`，
 * `saved` 是 `null`（未知）而不是 `true`。宁可让用户看到「未确认」，
 * 也不许把「没读懂」伪装成「保存好了」。
 *
 * 产物形状：`window.__ModuleLoader__.load({ id, factory })` 的 CJS 闭包。
 * 所以本文件**不能**出现顶层 `import`，`export` 会被构建脚本剥掉。
 */

/** 宿主可能给出的 application 值（本机 asar 实测）。 */
export const APPLICATIONS = ['applied', 'restart-required', 'overridden', 'failed', 'cancelled']

/** 逐项 outcome。`unknown` 不是 `success`，也不许折成 `success`。 */
export const OUTCOMES = ['success', 'partial', 'failure', 'unknown']

/**
 * 归一化原生 application：不认识的一律 `unknown`（不是 applied）。
 * @param {unknown} value
 * @returns {'applied'|'restart-required'|'overridden'|'failed'|'cancelled'|'unknown'}
 */
export function normalizeApplication(value) {
  return typeof value === 'string' && APPLICATIONS.indexOf(value) >= 0 ? value : 'unknown'
}

/** 逐项结果里「为什么不是干脆的成功」的稳定原因码。 */
export const REASONS = {
  applied: 'applied',
  restartRequired: 'restart-required',
  overridden: 'overridden',
  reloadFailed: 'reload-failed',
  writeFailed: 'write-failed',
  cancelled: 'cancelled',
  applicationUnknown: 'application-unknown',
  unconfirmed: 'unconfirmed',
  nativeError: 'native-error',
  // 原生调用**没在限期内回执**（宿主被安装/重载占住）。见 interpretRpcTimeout。
  hostBusy: 'host-busy',
  // 因为前一项就没回执，这一项**根本没执行**。不许当成失败，也不许当成成功。
  notAttempted: 'not-attempted',
}

/**
 * 解释一次原生调用结果。
 *
 * @param {any} raw 原生返回值（可能是 undefined / 缺字段 / 抛异常后的占位）
 * @param {{
 *   requested?: boolean,
 *   confirmTarget?: boolean | null,
 *   transportError?: string | null,
 * }} [options]
 *   `confirmTarget` —— 操作后**回读当前 patch 的目标值**是否等于 requested：
 *     true  = 回读确认目标值就是我们要的
 *     false = 回读确认目标值不是我们要的
 *     null  = 回读不了（文件读不到 / 没有用户层可读）→ 不当作确认
 *   `transportError` —— 连原生调用都没送达（服务不可用、抛异常）
 * @returns {{
 *   application: string, outcome: 'success'|'partial'|'failure'|'unknown',
 *   saved: boolean | null, applied: boolean, changed: boolean,
 *   reason: string, code: string, restartHelps: boolean, diagnostic: string | null,
 * }}
 */
export function interpretChangeResult(raw, options = {}) {
  const application = normalizeApplication(raw?.application)
  const changed = raw?.changed === true
  const requested = options.requested
  const confirmTarget = options.confirmTarget === true ? true : options.confirmTarget === false ? false : null
  const diagnostic = stringOrNull(raw?.error?.diagnostic ?? raw?.error?.message ?? options.transportError)
  const nativeCode = typeof raw?.error?.code === 'string' ? raw.error.code : null

  const base = { application, changed, restartHelps: false, diagnostic }

  // 1) 连原生通道都没走到（服务不可用 / 抛异常）：什么都没保存。
  if (options.transportError !== undefined && options.transportError !== null) {
    return { ...base, outcome: 'failure', saved: false, applied: false, reason: REASONS.nativeError, code: nativeCode ?? 'transport-error' }
  }

  // 2) 明确失败 / 取消：默认没保存；只有「回读确认目标值已到位」才认保存成功。
  if (application === 'failed' || application === 'cancelled') {
    if (application === 'failed' && confirmTarget === true) {
      // 实测场景：patch 已写成 disabled:false，随后 reload 抛错 → application:failed。
      // 保存是真的，应用失败也是真的，两个事实都要留下。
      return { ...base, outcome: 'partial', saved: true, applied: false, reason: REASONS.reloadFailed, code: nativeCode ?? 'reload-failed' }
    }
    return {
      ...base,
      outcome: 'failure',
      saved: false,
      applied: false,
      reason: application === 'cancelled' ? REASONS.cancelled : REASONS.writeFailed,
      code: nativeCode ?? application,
    }
  }

  // 3) applied：保存 + 本进程应用，都成立。
  if (application === 'applied') {
    return { ...base, outcome: 'success', saved: true, applied: true, reason: REASONS.applied, code: 'ok' }
  }

  // 4) restart-required：配置写下去了，本进程没应用（要重启才生效）。
  if (application === 'restart-required') {
    return { ...base, outcome: 'partial', saved: true, applied: false, reason: REASONS.restartRequired, code: 'ok', restartHelps: true }
  }

  // 5) overridden：有更高层覆盖压着。重启**不保证**解决，不能给「重启后生效」。
  if (application === 'overridden') {
    return { ...base, outcome: 'partial', saved: true, applied: false, reason: REASONS.overridden, code: 'overridden', restartHelps: false }
  }

  // 6) 协议缺字段 / 不认识的值。不许当成功。
  if (confirmTarget === true) {
    // 目标值确实到位了，但应用结果没读懂 → 保存成立、应用未确认。
    return { ...base, outcome: 'partial', saved: true, applied: false, reason: REASONS.applicationUnknown, code: 'application-unknown' }
  }
  return {
    ...base,
    outcome: 'unknown',
    saved: confirmTarget === false ? false : null,
    applied: false,
    reason: confirmTarget === false ? REASONS.writeFailed : REASONS.unconfirmed,
    code: 'application-unknown',
  }
}

/** 回读断线 / 操作后读不回来时的统一结论：操作回执收到了，当前状态没确认。 */
export function interpretReadbackFailure(raw, options = {}) {
  const application = normalizeApplication(raw?.application)
  const changed = raw?.changed === true
  const diagnostic = stringOrNull(raw?.error?.diagnostic ?? raw?.error?.message ?? options.transportError)
  const known = application === 'failed' || application === 'cancelled'
  return {
    application,
    outcome: known ? 'failure' : 'unknown',
    saved: known ? false : null,
    applied: false,
    changed,
    reason: known ? REASONS.writeFailed : REASONS.unconfirmed,
    code: known ? (typeof raw?.error?.code === 'string' ? raw.error.code : application) : 'unconfirmed',
    restartHelps: false,
    diagnostic,
  }
}

/**
 * 原生调用**没在限期内回执**时的结论。
 *
 * ── 为什么需要它（2026-10-12 实测的真事故）─────────────────────────────────
 * 宿主 `pluginManager.setPluginEnabled` 第一件事是拿 profile 的写锁
 * （`withFileLock(<profile>/package.json, { waitMs: 120000 })`），而**任何**插件安装
 * （`installBundle`）整个 pnpm 运行都握着同一把锁。安装不结束，开关一个回执都拿不到。
 * 更糟的是 pnpm 11.x 有已知缺陷：打完 `Done in Xs` 之后进程**不退出**
 * （上游 pnpm/pnpm#12297、#13617），宿主只能靠 10 分钟空闲看门狗兜底强杀 ——
 * 这段窗口里同样是死等。用户看到的症状就是「点开关就卡死」。
 *
 * 停止等待**不等于**操作失败：调用只是没等到回执，宿主可能仍在执行。
 * 所以 saved 是 null（未知）、outcome 是 unknown、reason 单列 host-busy，
 * 让界面说「结果未确认」，绝不编一个成功或失败出来。
 *
 * @param {{ waitedMs?: number, diagnostic?: string }} [options]
 */
export function interpretRpcTimeout(options = {}) {
  const waited = Number.isFinite(options.waitedMs) ? Math.round(options.waitedMs / 1000) : null
  return {
    application: 'unknown',
    outcome: 'unknown',
    saved: null,
    applied: false,
    changed: false,
    reason: REASONS.hostBusy,
    code: 'host-busy',
    restartHelps: false,
    diagnostic: stringOrNull(options.diagnostic)
      ?? (waited === null ? 'native call did not answer before the deadline' : `native call did not answer within ${waited}s`),
  }
}

/**
 * 因为**前一项就没拿到回执**而根本没执行的那几项。
 * 既不是失败（没试过），也不是成功（没发生），所以 outcome 是 unknown。
 */
export function interpretNotAttempted() {
  return {
    application: 'unknown',
    outcome: 'unknown',
    saved: null,
    applied: false,
    changed: false,
    reason: REASONS.notAttempted,
    code: 'not-attempted',
    restartHelps: false,
    diagnostic: null,
  }
}

/** 逐项汇总：任何 partial/unknown 都不许被折成 success（F2 的第 1 条）。 */
export function summarizeChange(items) {
  const list = Array.isArray(items) ? items : []
  const counts = { success: 0, partial: 0, failure: 0, unknown: 0 }
  for (const item of list) {
    const outcome = itemOutcome(item)
    counts[outcome] += 1
  }
  let outcome = 'success'
  if (list.length === 0) outcome = 'success'
  else if (counts.failure === list.length) outcome = 'failure'
  else if (counts.failure > 0) outcome = 'partial'
  else if (counts.unknown > 0) outcome = 'partial'
  else if (counts.partial > 0) outcome = 'partial'
  return { outcome, total: list.length, succeeded: counts.success, partial: counts.partial, failed: counts.failure, unknown: counts.unknown }
}

/** 逐项 outcome。已经解释过的直接用；裸 item 按 ok/hostApplied 兼容旧形状。 */
export function itemOutcome(item) {
  if (item && OUTCOMES.indexOf(item.outcome) >= 0) return item.outcome
  if (!item?.ok) return 'failure'
  return item.hostApplied ? 'success' : 'partial'
}

/** 逐项结果 → 展示用的稳定原因码（客户端文案按它选）。 */
export function reasonOf(item) {
  if (typeof item?.reason === 'string' && item.reason.length > 0) return item.reason
  return itemOutcome(item)
}

/** 原因码 → locale key。键名用驼峰，原因码用连字符，所以必须显式映射，不能拼字符串。 */
export const REASON_TEXT_KEY = {
  'restart-required': 'reason.restartRequired',
  'overridden': 'reason.overridden',
  'reload-failed': 'reason.reloadFailed',
  'application-unknown': 'reason.applicationUnknown',
  'unconfirmed': 'reason.unconfirmed',
  'write-failed': 'reason.writeFailed',
  'cancelled': 'reason.cancelled',
  'unaddressable': 'reason.unaddressable',
  'host-busy': 'reason.hostBusy',
  'not-attempted': 'reason.notAttempted',
}

/** 一条逐项结果 → 用户可读的一句话。取不到翻译就退回机器码（不编造）。 */
export function reasonTextOf(item, t) {
  const reason = reasonOf(item)
  const key = REASON_TEXT_KEY[reason]
  if (key !== undefined) {
    const text = t(key)
    if (text !== key) return text
  }
  return item?.code ?? reason
}

/**
 * 把一次操作的 notice 渲染成**可见文案**。
 *
 * 这是纯函数，放在共用文件里是为了让「界面显示什么」可被离线检查：
 * 客户端半边调它，检查脚本也调**同一份**，不用在探针里重写一遍渲染逻辑
 * （重写就会掩盖键名对不上这类错误 —— 第一轮就踩过 reason 连字符 vs 驼峰）。
 *
 * @param {object} notice
 * @param {(key: string, params?: object) => string} t locale 绑定
 */
export function formatNotice(notice, t) {
  if (!notice) return null
  // 还在等：界面没有进度条，等久了必须有一行字，否则看起来就是死了。
  if (notice.pending === true) return t('notice.busyWaiting')
  // **连回执都没拿到**（宿主被安装/重载占住）：最优先，且绝不能说成「已生效」。
  // 注意顺序必须在 readbackOk 之前 —— 超时时我们连读回执都没做，
  // 走 readbackOk 分支会误报成「回执已收到」。
  if (notice.hostBusy === true) {
    const items = notice.items ?? []
    // 「未执行」的项单独说 —— 它们既没成功也没失败，混进主语里会让人以为试过了。
    const attempted = items.filter((i) => i.reason !== REASONS.notAttempted)
    const skipped = items.filter((i) => i.reason === REASONS.notAttempted)
    const names = attempted.map((i) => t('plugin.' + i.id)).join('、') || t('section.title')
    const base = t('notice.hostBusy', { names, seconds: notice.waitedSeconds ?? 0 })
    if (skipped.length === 0) return base
    return `${base} ${t('notice.notAttempted', { names: skipped.map((i) => t('plugin.' + i.id)).join('、') })}`
  }
  // 回读失败：回执收到了，但当前状态没确认 —— 绝不追加「已生效」。
  if (notice.readbackOk === false) {
    const failed = (notice.items ?? []).filter((i) => i.outcome === 'failure')
    const head = t('notice.unconfirmed')
    if (failed.length === 0) return head
    return `${head} ${t('notice.failure', { detail: failed.map((f) => failureDetailOf(f, t)).join('；') })}`
  }
  if (notice.outcome === 'success') return t('notice.success')
  if (notice.outcome === 'failure') {
    const detail = (notice.items ?? []).map((i) => failureDetailOf(i, t)).join('；')
    return t('notice.failure', { detail })
  }
  // partial / unknown：逐项说清「为什么不是干脆的成功」
  const notable = (notice.items ?? []).filter((i) => i.outcome !== 'success')
  if (notable.length === 0) return t('notice.partial')
  return `${t('notice.partialHeader')}${notable.map((i) => `${t('plugin.' + i.id)}：${reasonTextOf(i, t)}`).join('；')}`
}

function stringOrNull(value) {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length > 0 ? text : null
}

/** 压成一行 + 限长（诊断里常有换行、路径和长栈）。 */
function oneLine(value, max = 200) {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (text.length === 0) return null
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * 稳定 code → locale key。**只给 Laurel 自己产的 code 用。**
 *
 * 宿主产的码（`operation-error` / `unknown-plugin` / `incompatible-version` …）
 * 一律**不进这张表** —— 它们的文案是宿主自己管的，我们不该替它翻译；
 * 而且它们真正的信息在 `diagnostic` 里（见 failureDetailOf）。
 */
export const CODE_TEXT_KEY = {
  'package-missing': 'code.packageMissing',
}

/**
 * 一项失败 → 给用户看的短句。**必须带上 diagnostic。**
 *
 * ── 为什么（2026-10-15 实测的真事故）───────────────────────────────────────
 * 宿主 `pluginManager` 把**任何非它自己预期的异常**都兜底成 `code: 'operation-error'`
 * （asar 里 `managementError()`：`if (!(error instanceof ManagementFailure)) return
 * { code: 'operation-error', diagnostic: messageOf(error) }`），真实原因**只**放在
 * `error.diagnostic` 里。
 *
 * 只显示 code 的话，用户看到的是「操作未成功：内耗护栏:operation-error」——
 * 一个字的原因都没有，只能来问人。实测那次的原因其实写得很清楚：
 * 那个包还没装进 profile，loader 解析不到它，reload 就抛了。
 *
 * 所以：Laurel 自己的码给一句人话（CODE_TEXT_KEY），宿主的码把它给的
 * diagnostic 附在括号里。diagnostic 可能带路径和栈，压成一行并截断，
 * 免得把那一行提示撑破（界面上它只是一行文字，没有折叠）。
 */
function failureDetailOf(item, t) {
  const head = `${t('plugin.' + item.id)}:${item.code}`
  const parts = []
  const key = CODE_TEXT_KEY[item?.code]
  if (key !== undefined) {
    const text = t(key)
    if (text !== key) parts.push(text)
  }
  const diagnostic = oneLine(item?.diagnostic)
  if (diagnostic !== null) parts.push(diagnostic)
  return parts.length === 0 ? head : `${head}（${parts.join('；')}）`
}
