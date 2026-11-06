/**
 * laurel-memory/experience/method —— 经验方法结构（S06）。
 *
 * 一条可晋升的经验方法必须同时具备五件事（01 §4.2）：
 *   applicableEnv  适用环境（项目 + 环境，缺一即"环境不明"）
 *   action         实际操作（工具/命令/参数，不是"改一下配置"这种空话）
 *   verification   验证办法**与结果**（只有办法没有结果 = 未验证）
 *   limits         限制与前置条件（"仅在备份后"、"不能用于正式数据库"）
 *   evidence       来源证据（记录 id / blob hash / 原文引用）
 *
 * 缺任一项 → {ok:false, missing:[...]}，调用方**不得晋升**。
 * 这里只做结构与归一化，不读盘、不调用模型、不执行命令。
 *
 * 与 guards 的分工：guards 判"这段文字有没有丢掉相邻条件/是否被撤回"；
 * 本文件判"结构化方法是否齐备"。两者都过才允许 adopted。
 */
import { canonical, contentHash } from '../../../laurel-core/lib/format.mjs'
// S3：环境形态与 id 的**唯一**判据在适配层（它同时服务采集侧）。
// 在这里另写一份正则 = 两份真相，采集时判成 wsl、晋升时判成原生，谁也发现不了。
import { environmentIdOf, shellShapeOf } from '../adapter-dsh.mjs'

export const REQUIRED_METHOD_FIELDS = Object.freeze([
  'applicableEnv', 'action', 'verification', 'limits', 'evidence',
])

/** 验证结果枚举。`unknown`/`none` 都不能算验证通过。 */
export const VERIFICATION_RESULTS = Object.freeze(['passed', 'failed', 'pending', 'unknown', 'none'])

const RESULT_ALIASES = new Map([
  ['通过', 'passed'], ['已验证', 'passed'], ['验证通过', 'passed'], ['成功', 'passed'],
  ['有效', 'passed'], ['已确认', 'passed'], ['passed', 'passed'], ['verified', 'passed'],
  ['ok', 'passed'], ['effective', 'passed'], ['success', 'passed'],
  ['失败', 'failed'], ['未通过', 'failed'], ['无效', 'failed'], ['failed', 'failed'],
  ['ineffective', 'failed'],
  ['待验证', 'pending'], ['待确认', 'pending'], ['进行中', 'pending'], ['未完成', 'pending'],
  ['pending', 'pending'],
  ['未知', 'unknown'], ['不明', 'unknown'], ['unknown', 'unknown'],
  ['无', 'none'], ['未验证', 'none'], ['none', 'none'], ['', 'none'],
])

function str(v) {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s ? s : null
}

/** 归一化验证结果（中英别名 → 枚举）。 */
export function normalizeResult(value) {
  if (value === undefined || value === null) return 'none'
  const key = String(value).trim().toLowerCase()
  if (RESULT_ALIASES.has(key)) return RESULT_ALIASES.get(key)
  return VERIFICATION_RESULTS.includes(key) ? key : 'unknown'
}

/**
 * 适用环境：必须带 projectId + environmentId。
 * 只给 os/shell 不算适用环境 —— 环境不明不能晋升。
 */
export function normalizeEnv(env) {
  if (!env || typeof env !== 'object') return null
  const projectId = str(env.projectId ?? env.project)
  const environmentId = str(env.environmentId ?? env.environment ?? env.envId)
  if (!projectId && !environmentId) return null
  return {
    projectId,
    environmentId,
    os: str(env.os ?? env.platform),
    shell: str(env.shell),
    cwd: str(env.cwd ?? env.dir),
    branch: str(env.branch),
    note: str(env.note),
  }
}

/** 操作：字符串视为命令；对象取 tool/command/args/cwd。 */
export function normalizeAction(action) {
  if (typeof action === 'string') {
    const command = action.trim()
    return command ? { tool: null, command, args: [], cwd: null } : null
  }
  if (!action || typeof action !== 'object') return null
  const tool = str(action.tool ?? action.toolName)
  const command = str(action.command ?? action.cmd ?? action.run)
  const args = Array.isArray(action.args) ? action.args.map((a) => String(a)) : []
  const cwd = str(action.cwd ?? action.dir)
  if (!tool && !command) return null
  return { tool, command, args, cwd }
}

/**
 * 操作签名：tool + command + args 的稳定指纹。
 * **不含 cwd**：路径会随项目映射变化，用 projectId 表达归属；
 * 命令不同就是不同操作，不能因为症状相似而合并。
 */
export function actionSignature(action) {
  const a = normalizeAction(action)
  if (!a) return null
  const norm = {
    tool: a.tool ? a.tool.toLowerCase() : null,
    command: a.command ? a.command.toLowerCase().replace(/\s+/g, ' ').trim() : null,
    args: a.args.map((x) => x.toLowerCase()),
  }
  return 'act-' + contentHash(norm).slice(0, 16)
}

/** 限制：字符串 / 字符串数组 / 键值对象。空 → null（视为缺失，不是"没有限制"）。 */
export function normalizeLimits(limits) {
  if (limits === undefined || limits === null) return null
  if (typeof limits === 'string') {
    const t = limits.trim()
    return t ? [t] : null
  }
  if (Array.isArray(limits)) {
    const out = limits
      .map((x) => {
        if (typeof x === 'string') return x.trim()
        if (x && typeof x === 'object') return canonical(x)
        return String(x ?? '').trim()
      })
      .filter(Boolean)
    return out.length ? out : null
  }
  if (typeof limits === 'object') {
    const out = Object.entries(limits)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? canonical(v) : v}`)
    return out.length ? out : null
  }
  return null
}

/** 证据引用：字符串 → {id}；对象取 id/hash/quote/source。 */
export function normalizeEvidence(evidence) {
  if (evidence === undefined || evidence === null) return null
  const list = Array.isArray(evidence) ? evidence : [evidence]
  const out = []
  for (const e of list) {
    if (typeof e === 'string') {
      const s = e.trim()
      if (s) out.push({ id: s, hash: null, quote: null, source: null })
      continue
    }
    if (e && typeof e === 'object') {
      const id = str(e.id ?? e.evidenceId ?? e.eventId ?? e.recordId)
      const hash = str(e.hash ?? e.sha256 ?? e.blobHash)
      const quote = str(e.quote ?? e.text)
      const source = str(e.source)
      if (id || hash || quote) out.push({ id, hash, quote, source })
    }
  }
  return out.length ? out : null
}

/**
 * 验证：{how, result}。
 * `how` 是验证办法（命令/检查/外部核对），`result` 是**真实结果**。
 * 只写"验证办法"而不写结果 = 未验证。
 */
export function normalizeVerification(v) {
  if (v === undefined || v === null) return null
  if (typeof v === 'string') {
    const how = v.trim()
    return how ? { how, result: 'unknown', at: null, evidence: null } : null
  }
  if (typeof v !== 'object') return null
  const how = str(v.how ?? v.method ?? v.check ?? v.command ?? v.steps)
  const result = normalizeResult(v.result ?? v.outcome ?? v.status)
  const evidence = normalizeEvidence(v.evidence ?? v.evidenceRefs)
  return { how, result, at: v.at ?? null, evidence }
}

/** 归一化整条方法（不判完备性）。 */
export function normalizeMethod(input) {
  if (!input || typeof input !== 'object') return null
  return {
    applicableEnv: normalizeEnv(input.applicableEnv ?? input.env ?? input.scope),
    action: normalizeAction(input.action ?? input.operation ?? input.fix),
    verification: normalizeVerification(input.verification ?? input.verify),
    limits: normalizeLimits(input.limits ?? input.constraints ?? input.boundaries),
    evidence: normalizeEvidence(input.evidence ?? input.sources ?? input.evidenceRefs),
  }
}

/**
 * 判完备性。
 * @returns {{ok:boolean, complete:boolean, missing:string[], problems:string[], method:object|null}}
 */
export function validateMethod(input) {
  const m = normalizeMethod(input)
  if (!m) {
    return {
      ok: false, complete: false,
      missing: [...REQUIRED_METHOD_FIELDS],
      problems: ['method 不是对象'],
      method: null,
    }
  }
  const missing = []
  const problems = []

  if (!m.applicableEnv) missing.push('applicableEnv')
  else if (!m.applicableEnv.projectId) problems.push('applicableEnv 缺 projectId（不允许跨项目猜归属）')
  else if (!m.applicableEnv.environmentId) problems.push('applicableEnv 缺 environmentId（环境不明不能晋升）')

  if (!m.action) missing.push('action')

  if (!m.verification || !m.verification.how) missing.push('verification')
  else if (m.verification.result === 'unknown') {
    problems.push('verification.result 未知：写了验证办法不等于验证有结果')
  } else if (m.verification.result === 'failed' || m.verification.result === 'none') {
    // P5b: a method whose verification FAILED must never be promoted. The gate
    // used to check only for 'unknown', which meant that the moment
    // environmentId started being filled in, every recorded failure would have
    // been upgraded into an "adopted practice" — the memory store would have
    // been poisoned by its own evidence. 1,981 failed against 435 passed in the
    // audited store makes that a real risk, not a hypothetical one.
    problems.push(
      'verification.result 是 ' + m.verification.result
      + '：验证没通过的做法不能升为经验。要么补一次成功的验证（result=passed），'
      + '要么如实降级停在 raw-episode。',
    )
  }

  if (!m.limits) missing.push('limits')
  if (!m.evidence) missing.push('evidence')

  const ok = missing.length === 0 && problems.length === 0
  return { ok, complete: ok, missing, problems, method: m }
}

/** 建方法：完备才返回 ok:true；否则把缺项如实带回，不"补全"、不猜。 */
export function makeMethod(input) {
  const v = validateMethod(input)
  if (!v.ok) return { ok: false, missing: v.missing, problems: v.problems, method: v.method }
  return { ok: true, method: { ...v.method, fingerprint: methodFingerprint(v.method) } }
}

/** 方法指纹：进入内容版本，方法任一字段变化都会让旧 Skill/缓存失效。 */
export function methodFingerprint(method) {
  const m = normalizeMethod(method)
  if (!m) return null
  return 'mf-' + contentHash({
    applicableEnv: m.applicableEnv
      ? {
        projectId: m.applicableEnv.projectId,
        environmentId: m.applicableEnv.environmentId,
        os: m.applicableEnv.os,
        shell: m.applicableEnv.shell,
      }
      : null,
    action: m.action
      ? {
        tool: m.action.tool,
        command: m.action.command ? m.action.command.toLowerCase().replace(/\s+/g, ' ').trim() : null,
        args: m.action.args,
      }
      : null,
    verification: m.verification ? { how: m.verification.how, result: m.verification.result } : null,
    limits: m.limits,
    evidence: (m.evidence ?? []).map((e) => e.id ?? e.hash ?? e.quote).sort(),
  })
}

const COMMAND_TOKEN = /\b(?:pnpm|npm|yarn|npx|node|git|docker|kubectl|systemctl|python|pip|cargo|go|make)\s+[^\s。；，,]+(?:\s+[^\s。；，,]+){0,6}/gi

/**
 * 从一段自由文本里**保守**抽取方法骨架。
 *
 * 它的作用不是"理解任意根因"，而是保证相邻条件被**搬进 limits** 而不是丢掉：
 * 文本里出现"仅在…后""不能用于…"时，这里必须原样收进 limits；
 * 抽不到的结构（验证办法、证据）由调用方显式给，抽不到就保持缺失 → 不可晋升。
 */
export function methodFromSummary(text, ctx = {}) {
  const s = String(text ?? '')
  const commands = [...s.matchAll(/`([^`]{1,200})`/g)].map((m) => m[1].trim()).filter(Boolean)
  const inline = [...s.matchAll(COMMAND_TOKEN)].map((m) => m[0].trim())
  const command = commands[0] ?? inline[0] ?? null

  // Keep full constraints, not only tokens such as "前提是" which lose their object.
  const limits = [...new Set(s.split(/[。；;\n]/).map(x => x.trim()).filter(x =>
    /不能用于|不得|不可|禁止|不要|仅限|仅适用于|只适用于|只有在|仅在|只在|前提|需要先|必须先|暂不用于|不用于|先(?:完成|做|备份|确认|检查)/.test(x)))]
  // Explicit failure takes precedence over a success mentioned elsewhere in the window.
  const failed = /(?:无效|未完成|还没|尚未|回滚|撤回|未通过|未解决|验证失败|测试失败)/.test(s)
  const result = failed ? 'failed' :
    /(?:已经|已|均|都|最终)(?:通过|成功|修复|解决|生效|恢复正常)|验证通过|测试通过|构建通过|确认修复|修复成功|问题解决|恢复正常/i.test(s)
      ? 'passed' : 'unknown'

  return validateMethod({
    applicableEnv: {
      projectId: ctx.projectId,
      environmentId: ctx.environmentId,
      os: ctx.os,
      shell: ctx.shell,
      cwd: ctx.cwd,
    },
    action: command ? { tool: ctx.tool ?? null, command } : null,
    verification: {
      how: ctx.verificationHow ?? null,
      result,
      evidence: ctx.verificationEvidence ?? null,
    },
    limits,
    evidence: ctx.evidence ?? null,
  })
}

/* ─────────────────────────────────────────────────────────────────────────
 * S2：「验证通过」这条触发（顺境）
 *
 * ── 为什么单独一条支路（不是 methodFromSummary 的加强版）───────────────
 * 真仓实测（55,129 条记录）：按 source.toolCallId 配对得到 18,059 对
 * 「调用 + 结果」，其中 shell 类 8,839 对、能解析出 command 的 8,350 对、
 * 结果里明确带通过标记的 330 对。而这 660 条绑定记录里，只有 22 条
 * 落在 S1 四道闸门产出的 episode 窗口内 —— 96.7% 的「跑过并且过了」发生在
 * 没有纠正、没有工具失败、也没有用户原话的顺境里。
 *
 * 也就是说：顺境是这套设计里最肥的一块素材，而现有三条触发对它全盲。
 * 硬把它塞进 S1 的窗口（用 episode 证据去抽）等于自废 96% 的货，所以它是
 * 与 correction / tool-failure 并列的第四条触发，输入是配对结果本身。
 *
 * ── 与 methodFromSummary 的区别（这条最要紧）─────────────────────────
 * methodFromSummary 的 verification 是「依据原文自述」—— 那是从散文里推断
 * 出来的"看起来过了"。这里的 verification.result === 'passed' 的来源只有
 * 一个：工具自己的结果记录没有失败标记、且带通过标记。前者是判断，
 * 后者是被观测到的事实。所以 validateMethod 的
 * 「verification.result !== 'unknown'」在这里是真满足，不是绕过。
 *
 * 仍然不满足的部分如实留在那里：limits 抽不到整句就留空 → 条目停在
 * raw-episode；environmentId 拿不到就留 null → 同样停在 raw-episode。
 * 本模块不补全、不猜。
 */

/** verified-action 认的 shell 类工具名。其它工具（write/edit/read…）不参与配对。 */
export const VERIFIED_SHELL_TOOLS = Object.freeze([
  'ops_bash', 'pwsh', 'bg_shell', 'bash', 'batch_bash', 'batch_shell',
])
const VERIFIED_SHELL_TOOL_SET = new Set(VERIFIED_SHELL_TOOLS)

/**
 * 通过标记 / 失败标记。判据写死在这两个正则里，同时命中即不算通过。
 * 顺序也是契约：失败标记先判（宁可漏，不可错 —— 把失败当成"已验证做法"
 * 推荐出去，比少记一条贵得多）。
 */
export const VERIFIED_PASS_MARKERS = Object.freeze(['PASS', 'passed', '0 fail', '✔', '测试通过'])
export const VERIFIED_FAIL_MARKERS = Object.freeze([
  'FAIL', '✖', 'Error:', 'error:', 'ENOENT', 'exit code [1-9]',
])
const VERIFIED_PASS_RE = /PASS|passed|0 fail|✔|测试通过/
const VERIFIED_FAIL_RE = /FAIL|✖|Error:|error:|ENOENT|exit code [1-9]/

/**
 * 调用记录正文形态：「调用 <toolName> {json 参数}」。
 * 失败调用在采集侧加了「[工具失败] 」前缀（capture.mjs 的 isError 分支），
 * 所以前缀要容忍 —— 否则失败调用的入参会被误当成结果记录。
 */
export const CALL_BODY_RE = /^(?:\[工具失败\]\s*)?调用 ([a-z_0-9]+) /

/**
 * 调用正文里只取 command 一个键。
 * 不 JSON.parse 整个参数对象：参数里经常是嵌套的引号/换行，parse 失败一次就丢一条；
 * 而且这里要的是命令原文，不是参数树。
 */
const COMMAND_ARG_RE = /"command"\s*:\s*"((?:[^"\\]|\\.){1,600})"/

/**
 * 命令头长度 = 指纹长度，不是命令长度。
 *
 * 为什么是 80 而不是整条命令：真仓同一件事的命令常常只差尾部路径/引号，
 * 用整条命令去重会得到 270+ 种（实测 160 字符时是 270，80 字符时是 96），
 * 那就等于没有去重。80 字符是实测出来的稳定点：96 种命令头 → 重复≥2 次的 24 种，
 * 与设计文档给的数一致。改这个数会改掉那三个数，所以它不是"调参"。
 */
export const VERIFIED_HEAD_CHARS = 80

/**
 * 命令 → 归一化命令头（去重键）。
 *
 * 三级归一：字面量 \n → 空格（命令里的换行在 JSON 里是转义的）、
 * 连续空白 → 单空格、截断到 VERIFIED_HEAD_CHARS、转小写。
 * 不做反转义：反转义会让 96 变成 98（实测），因为 \" 与 " 会分家；
 * 而命令原文另外完整保存在 action.command 里，头只承担"是不是同一条"。
 */
export function commandHeadOf(rawCommand, max = VERIFIED_HEAD_CHARS) {
  return String(rawCommand ?? '')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .toLowerCase()
}

/** 排序键：优先 journalSeq（盘上顺序），退到 createdAt，再退 0。 */
function orderOf(record) {
  if (Number.isFinite(record?.journalSeq)) return record.journalSeq
  if (Number.isFinite(record?.createdAt)) return record.createdAt
  if (Number.isFinite(record?.at)) return record.at
  return 0
}

/**
 * 把记录按 source.toolCallId 配对，返回同时满足三条的对：
 *   (a) 工具名属于 VERIFIED_SHELL_TOOLS（取自调用正文的「调用 <name> 」）；
 *   (b) 调用正文能解析出 {"command": ...}；
 *   (c) 结果 isError !== true、命中通过标记、且不命中失败标记。
 *
 * 缺任一边直接跳过 —— 不拿单边硬造。这一条是整步的诚实底线：
 * 只有调用没有结果 = 不知道过没过；只有结果没有调用 = 不知道下的什么命令。
 * 真仓实测：18,059 对绑定 → 8,839 对 shell → 8,350 对可解析命令 →
 * 330 对通过 / 1,002 对明确失败 / 7,018 对既无通过也无失败标记（后者不算）。
 *
 * 同一 toolCallId 出现多条同类记录时（真仓 4 组是「1 调用 + 2 结果」）：
 * 取第一条调用与第一条结果，其余计入 extras。不做多数表决 ——
 * 一条命令有两次输出时，"哪次算数"没有可靠判据，猜就是编。
 *
 * @returns {Array<{callId:string, callRecordId:string, resultRecordId:string,
 *   tool:string, command:string, head:string, sessionId:string|null,
 *   projectId:string|null, environmentId:string|null, seq:number,
 *   output:string, extras:number}>}
 */
export function passingCallPairs(records = [], { includeFailed = false } = {}) {
  const list = Array.isArray(records) ? records : []
  const groups = new Map()
  for (const r of list) {
    const callId = r?.source?.toolCallId
    if (typeof callId !== 'string' || !callId) continue
    let g = groups.get(callId)
    if (!g) { g = { call: null, result: null, extras: 0 }; groups.set(callId, g) }
    const body = String(r?.body ?? '')
    if (CALL_BODY_RE.test(body)) {
      if (g.call === null) g.call = r
      else g.extras += 1
    } else if (g.result === null) g.result = r
    else g.extras += 1
  }

  const out = []
  for (const [callId, g] of groups) {
    // 缺任一边跳过：单边不构成"跑过并且过了"。
    if (g.call === null || g.result === null) continue
    const m = CALL_BODY_RE.exec(String(g.call.body ?? ''))
    const tool = m ? m[1] : String(g.call.toolName ?? '')
    if (!VERIFIED_SHELL_TOOL_SET.has(tool)) continue
    const cmd = COMMAND_ARG_RE.exec(String(g.call.body ?? ''))
    if (!cmd) continue
    const output = String(g.result.body ?? '')
    // 失败先判：isError 是采集侧算好的字段，比正文关键词更可信。
    const failed = g.result.isError === true || VERIFIED_FAIL_RE.test(output) || /exit(?:ed with)?(?: code)?[: ]+[1-9]\d*/i.test(output)
    const passed = !failed && (VERIFIED_PASS_RE.test(output) || /exit(?:ed with)?(?: code)?[: ]+0\b/i.test(output))
    if (!passed && !(includeFailed && failed)) continue
    // A result paired across different scopes is never execution evidence.
    if (g.call.projectId && g.result.projectId && g.call.projectId !== g.result.projectId) continue
    if (g.call.environmentId && g.result.environmentId && g.call.environmentId !== g.result.environmentId) continue

    const command = String(cmd[1] ?? '')
    // S3：环境形态**只算一次**，下面的 environmentId 与 methodFromPair 都用它。
    // 算两遍虽然等价，但两份正则的结果一旦分叉（改了一处忘了另一处），
    // 就会出现"pair 说是 wsl、method 说是原生"这种只有对账才看得见的错。
    const shape = shellShapeOf(command)
    out.push({
      callId,
      ...(includeFailed ? { result: failed ? 'failed' : 'passed' } : {}),
      callRecordId: String(g.call.id ?? ''),
      resultRecordId: String(g.result.id ?? ''),
      tool,
      command,
      shape,
      head: commandHeadOf(command),
      // 会话归属以调用侧为准（结果可能落在另一个采集批次里）。
      sessionId: g.call.source?.sessionId ?? g.result.source?.sessionId ?? null,
      projectId: g.call.projectId ?? g.result.projectId ?? null,
      // S3：环境是**逐动作**的，所以这里先按命令正文派生，再退到记录上已有的值。
      // 顺序不能反：记录上的 environmentId 是采集时按 cwd/gitBranch 算的会话级值，
      // 用它盖掉动作级派生，等于把「这条命令在 WSL 里跑」抹成「说不清」。
      // 派生不出来（命令里没有 shell 线索）才用记录值，两者都没有就留 null。
      environmentId: shape
        ? environmentIdOf({ ...shape })
        : (g.call.environmentId ?? g.result.environmentId ?? null),
      seq: orderOf(g.call),
      output,
      extras: g.extras,
    })
  }
  return out
}

/**
 * limits 的抽取：整句，不是碎片。
 *
 * 判据（缺一不可）：按 。；; 换行 切句 → 整句长度 8..200 → 命中条件词 →
 * 不是 markdown 表格行、不是 "123: " 这种行号前缀。
 * 为什么要求整句：validateMethod 里 limits 是"限制与前置条件"，它会被
 * 原样展示给人看。"必须先"三个字不是限制，带完整条件的句子才是。
 * 抽不到就返回空数组 —— 调用方据此让条目停在 raw-episode，而不是用
 * 半句话把方法"凑齐"。真仓口径：24 条里有 12 条能抽到整句，12 条留空。
 */
export const LIMIT_MARKERS = /(仅当|除非|如果|若|前提|需先|需要先|必须先|必须|不能用于|不得用于|只在|仅限|仅在|只适用于|仅适用于|注意|only if|unless|requires?|must )/

/**
 * 一眼能认出「这不是散文里的整句」的形态。命中即丢 —— 这些都不是条件句：
 *   1. markdown 项目符号（- / * / +）与编号列表（1. / 1、）：那是文档排版；
 *   2. markdown 表格行（单元格里带 | 或行尾是 |）：表格被切开后必然断章；
 *   3. 行号前缀（343: …）：那是 grep / Select-String 的输出边框；
 *   4. 源码行（const/let/var/function/import/export/return 开头，或含 => / require()）：
 *      实测踩过 —— 一条结果正文里的 const a = require(process.argv[1]) 含 require，
 *      就被当成条件句收进了 limits。源码不是限制。
 *
 * 这四类都是拿真仓 24 条逐条看出来的：不加它们，24 条里会出现
 * 「- 租约回收必须留 reclaimed 回执」（文档项目符号）与「契约变更=调用方必须 await |」
 * （表格碎片）—— 那正是任务书禁止的「用碎片凑」。
 */
const NOT_PROSE_RE = /^(?:[-*+]\s|\d+[.、)]\s|\||\d+\s*:\s)/
const CODE_LINE_RE = /^(?:const|let|var|function|import|export|class|return|await)\b|=>|require\(/
const TABLE_RE = /\s\|\s|\|\s*$/

export function conditionSentencesOf(text, { max = 3, minChars = 8, maxChars = 200 } = {}) {
  const out = []
  for (const raw of String(text ?? '').split(/[。；;\n]/)) {
    const s = raw.trim()
    if (s.length < minChars || s.length > maxChars) continue
    if (NOT_PROSE_RE.test(s)) continue
    if (CODE_LINE_RE.test(s)) continue
    if (TABLE_RE.test(s)) continue
    if (!LIMIT_MARKERS.test(s)) continue
    if (!out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}

/**
 * 从一批记录直接产出每条通过配对的方法骨架（每条都走 validateMethod）。
 *
 * 返回形状与 methodFromSummary 同形（{ok, complete, missing, problems, method}），
 * 多带两个字段：
 *   - pair   ：配对的原始信息（记录 id / 命令 / 会话 / 顺序），供 pipeline 去重与举证；
 *   - limits ：这次抽到的整句限制（空数组 = 抽不到，条目会停在 raw-episode）。
 *
 * 为什么返回数组：一对绑定 = 一条候选方法。330 对就该出 330 条，
 * 由调用方用 dedupeVerifiedPairs 做三道去重 —— 去重是"放多少进池子"的决定，
 * 不属于"怎么从一对记录读出一条方法"。
 *
 * verification.how 写的是「同一条命令」而不是"已跑测试"：验证办法就是
 * 重跑这一条命令，证据是那条结果记录的 id（可回读核对）。不编造更细的说法。
 */
export function methodFromCallPairs(records = [], ctx = {}) {
  return passingCallPairs(records).map((pair) => methodFromPair(pair, ctx))
}

/**
 * 单个已配对的一对 → 方法骨架。methodFromCallPairs 内部就是它的 map。
 *
 * 为什么单独导出一个：运行时的流式路径（pipeline 的 emitVerifiedAction）手里
 * 已经有 pair 对象了。如果为了走 methodFromCallPairs 再把 pair 拼回两条「记录」
 * 文本、让下游重新用正则解析一遍，中间任何一步的拼装格式不对都会静默解析出
 * 0 条（实测踩过：拼出来的调用正文少了 JSON 外壳，于是全部变成 0，而错误被
 * observe 的顶层 catch 吞掉，看起来就像「这条触发从不产出」）。
 * 直接吃 pair，没有中间表示，就没有这个失败模式。
 */
/* ─────────────────────────────────────────────────────────────────────────
 * S3：环境下沉到动作级
 *
 * ── 为什么要下沉 ─────────────────────────────────────────────────────
 * 真仓实测（S 文档 §2.5）：743 条 episode **内部**混用 wsl.exe 与原生 PowerShell，
 * 仅 wsl 725 条、仅原生 1,196 条。所以 environmentId 不可能是"每条 episode 一个值" ——
 * 它是**逐动作**的。原来它由 episode 级的 gitBranch 派生，本机不是 git 仓库，
 * 于是 2,680 条 episode 的 environmentId **100% 是 null**，S2 那 24 条验证通过的
 * 命令也因此全被 validateMethod 的「环境不明不能晋升」挡在 0/24。
 *
 * ── 三层取值的顺序（这就是本步的全部语义）─────────────────────────────
 *   1. action：从**这条命令的正文**派生出 shell 形态 → 环境 id。
 *      这是本步新增的唯一一层，也是唯一"逐动作"的一层。
 *   2. record：记录上已经被上一层写好的 environmentId（S3 之后新采集的记录会有）。
 *   3. ctx：调用方显式给的值（宿主知道自己在哪跑）。
 *
 * 顺序反过来就是错的：ctx 是**会话级**的，一条会话里既有 WSL 又有原生 PowerShell 时，
 * 拿会话级的值去盖动作级的值，等于把 743 条混环境 episode 又混回去。
 * 所以动作层在最前面；动作层判不出来（命令里没有 shell 线索）才往下退。
 *
 * ── 不编 ─────────────────────────────────────────────────────────────
 * 三层都拿不到就**返回 null**，validateMethod 照旧挡住晋升（这条规则没动）。
 * 真仓 24 条里有 6 条命令里既没有 wsl 也没有 PowerShell 特征（纯 `cd ... && sed ...`），
 * 那 6 条就是判不出来 —— 它们被记成环境不明，而不是被猜成 "win32|powershell"。
 */

/**
 * 该从哪一层取环境身份 —— 写在返回值上，便于事后核对"这条 id 凭什么"。
 * 不是装饰：事后要能回答"这条经验的 environmentId 是派生的还是别人给的"。
 */
export const ENV_SOURCES = Object.freeze(['action', 'record', 'ctx'])

/**
 * 单个 pair + ctx → `{projectId, environmentId, os, shell, source, shape}`。
 * 纯函数、确定性（同样的 pair + ctx 必然得到同样的结果）。
 */
export function resolveApplicableEnv(pair, ctx = {}) {
  const projectId = ctx.projectId ?? pair?.projectId ?? null
  // pair 上已经算过就用它（passingCallPairs 算的），没有才现算 —— 少一条分叉路径。
  const shape = pair?.shape ?? shellShapeOf(pair?.command)
  if (shape) {
    const environmentId = environmentIdOf({ ...shape, nodeMajor: ctx.nodeMajor })
    // 形态判出来了但派生不出 id（理论上不会：shape 有 shell 就一定有 id）——
    // 退到下面两层，不编一个 id 出来。
    if (environmentId) {
      return {
        projectId,
        environmentId,
        os: shape.platform ?? null,
        shell: shape.shell ?? null,
        source: 'action',
        shape,
      }
    }
  }
  const fromRecord = str(pair?.environmentId)
  if (fromRecord) {
    return { projectId, environmentId: fromRecord, os: ctx.os ?? null, shell: ctx.shell ?? null, source: 'record', shape: null }
  }
  const fromCtx = str(ctx.environmentId)
  if (fromCtx) {
    // 动作层判不出来时，调用方给的值是**唯一**还能用的线索。
    // 它与动作无关（会话级），所以 source 如实写 'ctx'，别让它看起来像派生的。
    return { projectId, environmentId: fromCtx, os: ctx.os ?? null, shell: ctx.shell ?? null, source: 'ctx', shape: null }
  }
  return { projectId, environmentId: null, os: ctx.os ?? null, shell: ctx.shell ?? null, source: null, shape: null }
}

export function methodFromPair(pair, ctx = {}) {
  if (!pair || typeof pair !== 'object') return null
  const maxLimits = Number.isInteger(ctx.maxLimits) ? ctx.maxLimits : 3
  const limits = conditionSentencesOf(pair.output, { max: maxLimits })
  const env = resolveApplicableEnv(pair, ctx)
  const verdict = validateMethod({
    applicableEnv: {
      projectId: env.projectId,
      environmentId: env.environmentId,
      os: env.os,
      shell: env.shell,
      cwd: ctx.cwd ?? null,
    },
    action: { tool: pair.tool, command: pair.command },
    verification: {
      how: '同一条命令：' + pair.head,
      result: 'passed',
      at: pair.seq || null,
      // 验证的证据是结果记录：那一条正文里看得见通过标记。
      evidence: [pair.resultRecordId],
    },
    limits,
    // 来源证据 = 调用 + 结果两条：少一条就无法复核"下的什么命令、过了没有"。
    evidence: [pair.callRecordId, pair.resultRecordId],
  })
  return {
    ...verdict,
    pair,
    limits,
    // S3：这条 environmentId 是从哪一层来的（action / record / ctx / null）。
    // 与 limits 并列放在这里，因为两者都是"这次到底拿到了什么"的事实。
    envSource: env.source,
    envShape: env.shape,
  }
}


/**
 * P5c：把**已经落库的**方法补上可派生的环境身份。
 *
 * ── 为什么需要这一步（评审 §5.4 的实测断点）───────────────────────────
 * 存量 2,680 条 episode 的 `applicableEnv.environmentId` **100% 是 null**：
 * 它当年由 episode 级的 `gitBranch` 派生，而本机不是 git 仓库，于是永远派不出来。
 * 结果 `validateMethod` 的「环境不明不能晋升」把**每一条**都挡在 raw-episode ——
 * 人工点「采纳」也过不去，因为 `methodOk` 在写入那一刻就被冻结成 false。
 *
 * 补上动作级派生之后（S3 的 `resolveApplicableEnv`），这 2,680 条里
 * 命令正文带 shell 线索的那批**本来就可以判定**——只是没人回头再算一次。
 *
 * ── 这一步只补环境，别的缺项一个都不补 ───────────────────────────────
 * 尤其**不动 verification**：一条 result 是 failed 的做法，补完环境仍然不能晋升
 * （P5b 的拦截）。所以本函数返回的方法**仍要**过一遍 `validateMethod`，
 * 调用方不许拿它的返回值当"已经可晋升"。
 *
 * 纯函数：不读盘、不改原对象。派生不出来就保持原样返回 null，不编。
 *
 * @returns {{method:object, derived:{environmentId:string|null, source:string|null, shape:object|null}}}
 */
export function withDerivedEnv(method, ctx = {}) {
  const m = normalizeMethod(method ?? {})
  if (!m) return { method: method ?? null, derived: { environmentId: null, source: null, shape: null } }
  const current = m.applicableEnv ?? {}
  const env = resolveApplicableEnv(
    {
      command: m.action?.command ?? null,
      // 记录上已有的值交给 resolveApplicableEnv 的第二层，别在这里先判 ——
      // 判据只该有一份（它自己就是"动作 > 记录 > ctx"的次序）。
      environmentId: current.environmentId ?? null,
      projectId: current.projectId ?? null,
    },
    { projectId: current.projectId ?? ctx.projectId ?? null, environmentId: ctx.environmentId ?? null },
  )
  if (!env.environmentId) {
    // 派生不出来：原样退回，**不改**成 {} 或 null —— 那会抹掉已有的其它字段。
    return { method: m, derived: { environmentId: null, source: null, shape: null } }
  }
  return {
    method: {
      ...m,
      applicableEnv: {
        ...current,
        environmentId: env.environmentId,
        // os/shell 只在原来没有时补：已有值优先（那是采集当时的事实，比现在重推的可信）。
        os: current.os ?? env.os ?? null,
        shell: current.shell ?? env.shell ?? null,
      },
    },
    derived: { environmentId: env.environmentId, source: env.source, shape: env.shape },
  }
}

/**
 * 三道去重（本步最容易做错的地方，全部写死在这里）。
 *
 *  闸 1 —— 同一归一化命令只留最近一次通过：真仓 330 → 96 种命令头。
 *           同一会话里同一命令通过多次，也只是这一行的计数 +1，不会多出一条。
 *  闸 2 —— 只放「重复 ≥2 次」的：96 → 24 种。一次性的探针命令不被
 *           当成"这台机器上已验证的做法"：它更可能是随手读个文件。
 *  闸 3 —— 跨 ≥2 会话的打 strong（24 里只有 3 种），但仍然一起放行：
 *           strong 是可信度标记，不是入选条件。收缩到 3 条会让这一步几乎没有产出。
 *
 * 为什么不一次放 330 条：那正是在造第二个 2,680（真仓旧实现里"什么都是经验"的形状）。
 * 去重后的 24 条必须命令两两不同（Set 断言），这是闸 1 的直接后果。
 *
 * @returns {{distinctCommands:number, repeatCommands:number, crossSession:number,
 *   selected:Array, rejectedSingle:number}}
 */
export function dedupeVerifiedPairs(pairs = [], { minRepeats = 2, minSessions = 2, max = 0 } = {}) {
  const list = Array.isArray(pairs) ? pairs : []
  const byHead = new Map()
  for (const p of list) {
    const head = typeof p?.head === 'string' && p.head ? p.head : commandHeadOf(p?.command)
    if (!head) continue
    const seq = Number.isFinite(p?.seq) ? p.seq : 0
    let e = byHead.get(head)
    if (!e) {
      e = { head, count: 0, sessions: new Set(), latest: p, latestSeq: seq }
      byHead.set(head, e)
    }
    e.count += 1
    // null 会话不进会话集合：不知道属于哪个会话时不假装跨会话。
    if (p?.sessionId) e.sessions.add(String(p.sessionId))
    if (seq >= e.latestSeq) { e.latest = p; e.latestSeq = seq }
  }

  const repeated = [...byHead.values()].filter((e) => e.count >= minRepeats)
  const selected = repeated
    .slice()
    .sort((a, b) => (b.latestSeq - a.latestSeq))
    .map((e) => ({
      ...e.latest,
      head: e.head,
      repeatCount: e.count,
      sessionCount: e.sessions.size,
      strong: e.sessions.size >= minSessions,
    }))
  return {
    distinctCommands: byHead.size,
    repeatCommands: repeated.length,
    crossSession: repeated.filter((e) => e.sessions.size >= minSessions).length,
    selected: max > 0 ? selected.slice(0, max) : selected,
    rejectedSingle: byHead.size - repeated.length,
  }
}

