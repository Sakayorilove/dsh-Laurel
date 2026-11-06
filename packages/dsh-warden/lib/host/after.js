/**
 * dsh-warden · 执行后观察（`tools/post-execute`）
 *
 * ── 这一层现在做四件事 ─────────────────────────────────────────────────
 * ① **大输出归档**（R3）：新产生的大文本结果先落盘，只把有界摘要 + 指纹 +
 *    引用放进上下文。见 `host/archive.js`。
 * ② **无进展识别**（R6）：按"有没有新证据"判，不按路径计数。
 * ③ **失败分型**（R8）：能力不支持 / 认证缺失 / 路径环境 / 契约 / 瞬时 /
 *    资源冲突 / 业务失败 —— 不同类别给不同的下一步，而不是一律"再试一次"。
 * ④ **两条老提示**：改文件匹配失败、未知工具。这两条只在**已经失败**时触发，
 *    所以不可能误伤正常调用。
 *
 * ── 契约（实读 0.2.0-rc.2 `dsh-tools` 的 `postExecute()`）──────────────
 *   `waterfall(carrier, "tools/post-execute", exec, result, () => ({kind:"accept"}))`
 *   - `{ kind:'accept', content? }` 保持成功，**替换呈现内容**
 *   - `{ kind:'accept', value? }`   替换结构化值；`isError` 的结果不允许替换 value
 *   - `{ kind:'block', feedback }`  变成 isError
 *   - 两种决策都可挂 `additionalContexts`（消息数组，会进下一批上下文）
 *   `content` 与 `value` **不能同时给**（宿主会抛 TypeError）。
 *
 * ── 三条纪律 ───────────────────────────────────────────────────────────
 *   1. **不隐藏失败。** `isError` 的结果一律不归档、不改写正文。
 *   2. **不盲删媒体块。** 归档只动文本块，图片/文件块原样保留。
 *   3. **content 只由这一处组装。** 归档与提醒都在同一条 waterfall 上，
 *      两个监听器各改一次 content 会互相覆盖。
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { extractPath, oneLine, classifyToolError, ERROR_CLASS_HINTS, readRangeKey, readRangeOf } from '../core/text.js'
import { normalizePath } from '../core/config.js'
import { createArchiver } from './archive.js'
import { isIgnored, isMutatingTool, sessionOf, workspaceOf } from './guard.js'

import { createNudgePolicy } from '../core/nudge.js'

/** 提醒消息的 source 标记。 */
const NOTICE_SOURCE = { kind: 'warden', form: 'notice' }

/**
 * 造一条提醒消息。形状与宿主 `createUserMessage` 一致：`{ id, role, content, source }`。
 *
 * ⚠ `source.kind` 是 `'warden'`。这一点很关键：宿主用 `source.kind === 'user'`
 * 标记真人输入（实读 `dsh-subagent` 提交 prompt 时写的就是 `{kind:"user"}`），
 * 所以带 `source` 的插件消息**不该**被别的插件当成"用户新提问"。
 * 补充评审 R9-B 修的就是 Strata 那边只按黑名单排除自家消息的问题。
 */
function createNotice(text, summary) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { ...NOTICE_SOURCE, summary: String(summary ?? '').slice(0, 60) },
  }
  try { return structuredClone(message) } catch { return message }
}

/** 从 result 里抠出错误文本。 */
function errorText(result) {
  if (!result) return ''
  const parts = []
  if (result.error?.message) parts.push(String(result.error.message))
  const content = result.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 返回结果是否是"改文件时匹配失败"这一类。 */
export function isEditMiss(message) {
  return /old_string was not found|old_string matched \d+ times|String to replace not found|No exact match found/i.test(String(message ?? ''))
}

/** 返回结果是否是"工具名不存在"。 */
export function isUnknownTool(message) {
  return /unknown tool|no such tool|tool .* not found|工具不存在/i.test(String(message ?? ''))
}

/**
 * 把这次调用的目标归一成**返工计数的身份**（P2-10）。
 *
 * 旧版直接 `w:${target}`，于是同一个文件换个写法就变成两个键：
 *   `D:\proj\a.txt`（反斜杠，Windows 习惯）与 `D:/proj/a.txt`（正斜杠）
 * 各计各的 → 改 3 次可能永远踩不到阈值。
 *
 * 归一流程：相对路径按工作区 cwd 解析成绝对 → `normalizePath`（统一正斜杠、
 * 盘符小写）。**归一不出来就返回空串**：宁可这次不计，也不要用一个错的键
 * 去累加 —— 错键会让提醒打在无关的操作上。
 *
 * @param {string} target extractPath 挖出来的原始串
 * @param {string} cwd 工作区根（workspaceOf(exec)）
 * @returns {string} 归一后的路径；失败返回空串
 */
/**
 * 命令类工具（没有单一文件目标，只有一段要执行的命令/代码）。
 *
 * P2-10 的不一致就在这里：旧版 `bash` 因为参数里带 `cwd` 被 extractPath 挖出
 * 一个"路径"从而计入返工，而 `pwsh` 用 `workdir` 就挖不到 → **同一个行为，
 * 一个计一个不计**。两种处理都行，但必须一致。这里统一成
 * 「工具名 + 规范化后的命令前缀」—— 既保住 shell 改文件的覆盖，
 * 又不会把"同一个目录下所有命令"混成一个键（那是误报机器）。
 */
const COMMAND_TOOLS = new Set([
  'bash', 'sh', 'shell', 'zsh', 'pwsh', 'powershell', 'cmd', 'terminal',
  'run_code', 'run', 'exec', 'execute', 'script',
])

/** 命令类工具参与返工身份的前缀长度（够区分不同命令，又不至于每次微调都变键）。 */
const COMMAND_KEY_PREFIX = 80

/** 参数里的"真文件目标"字段。**不含 cwd/directory/dir** —— 那是目录，不是被改的实体。 */
const FILE_TARGET_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'notebook_path']

/** 参数里可能承载命令/代码的字段。 */
const COMMAND_KEYS = ['command', 'cmd', 'code', 'script', 'commandLine', 'command_line']

function argsOf(rawArguments) {
  let args = rawArguments
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (!trimmed.startsWith('{')) return null
    try { args = JSON.parse(trimmed) } catch { return null }
  }
  return args && typeof args === 'object' ? args : null
}

/**
 * 返工计数的**身份**（P2-10 的统一入口）。
 *
 * 三类：
 *   1. 有明确的文件目标字段 → 归一化后的绝对路径，前缀 `path:`
 *   2. 命令类工具 → 前缀 `cmd:<工具名>:` + 规范化命令前缀（**与 workdir/cwd 无关**）
 *   3. 其它（纯 DOM 操作、job_id 之类）→ 空串，**统一不计**
 *
 * 第 2 类让 `bash` 与 `pwsh` 行为一致：两边都看命令，都不看目录。
 *
 * @param {string} toolName
 * @param {object|string} rawArguments
 * @param {string} cwd 工作区根
 * @returns {{key: string, display: string}}
 */
export function reworkTargetOf(toolName, rawArguments, cwd) {
  const args = argsOf(rawArguments)
  const name = String(toolName ?? '').trim().toLowerCase()
  if (!args) return { key: '', display: '' }

  for (const field of FILE_TARGET_KEYS) {
    const value = args[field]
    if (typeof value === 'string' && value.trim().length > 0) {
      const normalized = reworkPathKey(value, cwd)
      if (normalized) return { key: 'path:' + normalized, display: value.trim() }
      return { key: '', display: value.trim() }
    }
  }

  if (COMMAND_TOOLS.has(name)) {
    for (const field of COMMAND_KEYS) {
      const value = args[field]
      if (typeof value === 'string' && value.trim().length > 0) {
        // 空白折叠：同一命令换个缩进/换行不该变成新键。
        const flat = value.trim().replace(/\s+/g, ' ').slice(0, COMMAND_KEY_PREFIX)
        return { key: 'cmd:' + name + ':' + flat, display: flat }
      }
    }
    // 命令类工具但没有命令字段 → 不计（而不是退回去按目录计）。
    return { key: '', display: '' }
  }

  return { key: '', display: '' }
}

export function reworkPathKey(target, cwd) {
  const raw = typeof target === 'string' ? target.trim() : ''
  if (raw.length === 0) return ''
  const base = typeof cwd === 'string' ? cwd.trim() : ''
  try {
    // resolve 只在「相对路径 + 有 cwd」时才真正改变结果；绝对路径原样返回。
    const absolute = base ? resolve(base, raw) : resolve(raw)
    return normalizePath(absolute)
  } catch {
    return ''
  }
}

function editMissText(target, message) {
  return `[warden] 改文件没匹配上（${oneLine(message, 120)}）${target ? `，目标：${oneLine(target, 120)}` : ''}\n`
    + `这几乎总是因为**你手里的原文已经过时**（上一轮改过它、或者全角/半角括号、换行对不上）。\n`
    + `正确做法：只重读**你要改的那一段**（带 offset/limit），拿现在的原文去匹配，再改。`
    + `不需要把整个文件重读一遍。`
}

function unknownToolText(name, schemas) {
  const names = Array.isArray(schemas)
    ? schemas.map((s) => s?.name).filter((n) => typeof n === 'string' && n.length > 0)
    : []
  const list = names.length > 0
    ? `\n当前这个 agent 实际可以调用的工具（${names.length} 个）：\n  ${names.join('、')}`
    : '\n（拿不到工具清单，请以你本轮看到的工具定义为唯一依据。）'
  return `[warden] 你调了一个不存在的工具：\`${oneLine(name, 60)}\`${list}\n`
    + `**不要凭记忆拼工具名** —— 只使用上面这份清单里的名字；`
    + `清单里没有的能力，就说明这条路走不通（能力不支持），换通道或把限制报给用户，别在原地反复撞。`
}

/** 失败分型的提醒。按类别给具体下一步，不给"再试一次"。 */
function errorClassText(toolName, message, klass) {
  const hint = ERROR_CLASS_HINTS[klass] ?? ''
  if (!hint) return null
  return `[warden] 这次 \`${toolName}\` 失败被归为「${klass}」类。\n`
    + `  错误：${oneLine(message, 200)}\n`
    + `  ${hint}`
}

/**
 * 挂上执行后观察。返回卸载函数；拿不到钩子返回 null。
 *
 * @param {any} ctx cordis 上下文
 * @param {{config: () => any, counters: any, tools: () => any, progress?: any,
 *          home: string, capabilities?: any, clock?: any, log?: any,
 *          onEvent?: (e: object) => void}} deps
 */
export function installAfter(ctx, deps) {
  if (typeof ctx?.on !== 'function') {
    deps.capabilities?.markUnsupported?.('archiveToolResults', '拿不到 ctx.on')
    return null
  }
  const stats = {
    rework: 0, reread: 0, editMiss: 0, unknownTool: 0,
    archived: 0, archivedDropped: 0, stalled: 0, classified: 0, stalledSuppressed: 0,
  }
  // deferCommit：归档落盘后**先不记账**，等确认内容真的替换进上下文再 commit（P1-11）。
  const archiveDecision = createArchiver(deps, { deferCommit: true })

  /** 提醒节流：首次踩线 / 计数翻倍 / 到线硬动作，之后闭嘴。 */
  const nudge = createNudgePolicy({})

  let off = null
  try {
    off = ctx.on('tools/post-execute', async (exec, result, next) => {
      const notices = []
      let contentOverride = null
      // 待提交的归档（P1-11）：只有真的把 content 赋进决策才 commit。
      let pendingArchive = null
      try {
        const config = deps.config?.() ?? {}
        if (config.enabled !== false) {
          const sessionId = sessionOf(exec)
          const target = extractPath(exec.arguments)
          const usable = sessionId && target && !isIgnored(target, config.pathIgnore)
          // 返工键的身份（P2-10）：文件目标 → 归一化绝对路径；命令类工具 → 工具名+命令前缀。
          // 空串 = 认不出身份 → **统一不计**（宁可少提醒，也不要用错键把无关操作混在一起）。
          const reworkTarget = sessionId ? reworkTargetOf(exec.name, exec.arguments, workspaceOf(exec)) : { key: '', display: '' }
          const targetKey = reworkTarget.key
          // 当前位置（core/timeline.js）：用户回合给提醒节流用，步给归档事件用。
          // 拿不到就是 null —— 节流退回"只按会话上限"，**不猜回合**。
          const at = deps.timeline?.position?.(sessionId) ?? { turn: null, step: null }

          /* ── ① 大输出归档（只动成功结果的文本块）── */
          const archived = archiveDecision(exec, result, config)
          if (archived?.content) {
            contentOverride = archived.content
            // 记账推迟到下面「确实赋了 content」之后（P1-11）。这里只记下待提交项。
            pendingArchive = archived
          }

          /* ── ② 无进展识别（R6）── */
          let progressNoticeSent = false
          if (deps.progress && sessionId) {
            const observation = deps.progress.observe({
              sessionId,
              name: exec.name,
              args: exec.arguments,
              result,
              targetPath: usable ? target : '',
              // 内容指纹由 S2 的字节级 hash 提供；这里只在拿得到时传。
              targetHash: result?.meta?.wardenTargetHash ?? null,
            }, config)
            // `progressMode` 必须真的起作用（2026-10-17 审计）：旧版不管
            // observe 还是 enforce 都 push notice，于是 UI 上写着"先观察不动手"，
            // 实际永远在动手。现在 observe 只记录、不发消息。
            const mode = String(config.progressMode ?? 'observe')
            if (observation.notice && mode === 'enforce') {
              notices.push(createNotice(observation.notice, `no-progress ${observation.stallKind}`))
              progressNoticeSent = true
              stats.stalled++
            } else if (observation.notice) {
              // observe 档：压在手里，只让状态里能看到"本来会发"。
              stats.stalledSuppressed = (stats.stalledSuppressed ?? 0) + 1
            }
            if (observation.progress) deps.capabilities?.markObserved?.('progressWatch', observation.reason)
          }

          /* ── ③ 返工提醒：按路径计数，但**只在真的没有新证据时**才发 ── */
          if (targetKey && config.reworkNudge !== false && isMutatingTool(exec.name)) {
            // 键已归一：`D:\proj\a.txt` 与 `D:/proj/a.txt` 现在是同一个键（P2-10）。
            const key = `w:${targetKey}`
            const shown = targetKey.startsWith('cmd:') ? reworkTarget.display : target
            const count = deps.counters.bump(sessionId, key)
            // 与 ProgressWatch 的差异：这里数的是"对同一路径的写尝试次数"，
            // 用来提醒"该停下来看一眼整体"，不是判定空转。
            // 传整份 config（含 nudgeOnceOnly）给 decide：默认 true → 同一键只发
            // 一条完整提醒后闭嘴；显式 false 才走下面的翻倍/硬动作/一行计数更新。
            const decision = nudge.decide('rework', sessionId, key, count, config.reworkThreshold, config, at)
            if (decision) {
              const head = `[warden] 同一个文件已经改了 ${count} 次：${oneLine(shown, 140)}\n`
              const body = decision.tier === 'hard'
                ? `这已经不是在提醒「慢一点」了。先停手做三件事再继续：\n`
                  + `① 把当前改动落盘 / 留一个回滚点；\n`
                  + `② 用一句话说清「试过哪几条路、分别为什么不行」；\n`
                  + `③ 换策略，而不是再改一处试一次（先确认你改的是真正被加载的那一份、找同一份文件的其它副本、把改动拆成能验证的小步）。\n`
                  + `（本条是本会话对该文件的最后一条提醒。）`
                : decision.sent > 1
                  // 坑1：第 2 条起不再重发全文，只给一行计数更新。
                  ? `（本会话对这条的第 ${decision.sent} 条提醒，全文不再重复。）`
                    + `下一条即为硬动作要求：先落盘回滚点、说清试过哪几条路、换策略再继续。`
                  : `先停一下再动手。可选：① 一次改完，而不是改一处试一次；`
                    + `② 只重读你要改的那一段（带 offset/limit），不必整个文件重读；`
                    + `③ 如果是「改完没生效」，先确认你改的是**真正被加载的那一份**`
                    + `（同一份文件在仓库里可能有两处副本，安装面链接指向的才是生效的那份）。`
              notices.push(createNotice(head + body, `rework ×${count}${decision.tier === 'hard' ? ' hard' : ''}`))
              stats.rework++
              deps.onEvent?.({ kind: 'rework', sessionId, count, tier: decision.tier, notices: decision.sent, detail: `${exec.name} → ${oneLine(shown, 100)}` })
            }
          }

          /* ── ④ 重复读提醒：只在**同一区间**反复读时才算 ──
             不同片段的读取是省上下文的正确做法，绝不提醒（R6 的复现项）。
             ProgressWatch 已经按 readRangeKey 判过了；这一步刚发过无进展提醒
             就不再叠第二条，避免同一步里塞两条内容相近的消息。 */
          if (usable && config.rereadNudge !== false && isReadTool(exec.name) && !progressNoticeSent) {
            // 键必须带读取区间（2026-10-17 审计）：旧版只按路径，于是
            // "grep 换一个关键词"、"read 同一文件的另一段"都被累加成重复读，
            // 今天 35 条里有 15 条是 grep 换词的误报。分段读是省上下文的
            // 正确做法，不该被提醒。
            const key = `r:${target}:${readRangeKey(readRangeOf(exec.arguments))}`
            const count = deps.counters.bump(sessionId, key)
            // 同样传整份 config：nudgeOnceOnly 在这里也生效（同一区间只提醒一次）。
            const decision = nudge.decide('reread', sessionId, key, count, config.rereadThreshold, config, at)
            if (decision) {
              const head = `[warden] 同一个文件的**同一区间**已经读了 ${count} 次：${oneLine(target, 140)}\n`
              const body = decision.tier === 'hard'
                ? `别再读了 —— 你要的信息要么已经在上下文里，要么不再是从这个文件能拿到的。先做一件事再继续：\n`
                  + `把「你到底想确认什么」写成一句话，然后只读能回答它的那一段（带 offset/limit）；或者换一个信息来源。\n`
                  + `（本条是本会话对该文件的最后一条重复读提醒。）`
                : decision.sent > 1
                  // 坑1：第 2 条起不再重发全文，只给一行计数更新。
                  ? `（本会话对这条的第 ${decision.sent} 条提醒，全文不再重复。）`
                    + `下一条即为硬动作要求：把「你到底想确认什么」写成一句话，只读能回答它的那一段，或换信息来源。`
                  : `如果它没变，你要的信息第一次读的时候就拿到了 —— 回到上下文里找。`
                  + `如果它变了，说明有人在改它：先搞清楚是谁改到哪一版再继续。`
                  + `（读**不同**区间不会被算作重复。）`
              notices.push(createNotice(head + body, `reread ×${count}${decision.tier === 'hard' ? ' hard' : ''}`))
              stats.reread++
              deps.onEvent?.({ kind: 'reread', sessionId, count, tier: decision.tier, notices: decision.sent, detail: `${exec.name} → ${oneLine(target, 100)}` })
            }
          }

          /* ── ⑤ 只在**调用已经失败**时触发的三条 ── */
          if (result?.isError) {
            const message = errorText(result)
            if (config.editMissHint !== false && isEditMiss(message)) {
              notices.push(createNotice(editMissText(target, message), 'edit miss'))
              stats.editMiss++
              deps.onEvent?.({ kind: 'edit-miss', sessionId, detail: oneLine(message, 140) })
            } else if (config.unknownToolHint !== false && isUnknownTool(message)) {
              let schemas = []
              try { schemas = deps.tools?.()?.schemas?.(exec.agent) ?? [] } catch { schemas = [] }
              notices.push(createNotice(unknownToolText(exec.name, schemas), 'unknown tool'))
              stats.unknownTool++
              deps.onEvent?.({ kind: 'unknown-tool', sessionId, detail: oneLine(exec.name, 80) })
            } else if (config.errorClassify !== false) {
              const klass = classifyToolError(message)
              const text = errorClassText(String(exec.name ?? 'tool'), message, klass)
              if (text && klass !== 'business') {
                notices.push(createNotice(text, `error class ${klass}`))
                stats.classified++
                deps.onEvent?.({ kind: 'error-class', sessionId, detail: `${klass}：${oneLine(message, 120)}` })
              }
              // 能力不支持这一类要单独记：同一能力不该在各会话里反复撞（R8）。
              if (klass === 'capability' || klass === 'auth') {
                deps.capabilities?.markObserved?.('capabilityPrecheck', `${klass}：${oneLine(message, 100)}`)
              }
            }
          }
        }
      } catch (error) {
        // 观察失败绝不能影响这次调用，但要让降级可见。
        deps.capabilities?.markDegraded?.('postExecute', `post-execute 异常：${error?.message ?? error}`)
      }

      const downstream = await next()
      if (notices.length === 0 && !contentOverride) return downstream

      // 下游可能是 accept 也可能是 block；两种都要把提醒带上。
      try {
        const existing = Array.isArray(downstream?.additionalContexts) ? downstream.additionalContexts : []
        const decision = { ...downstream, additionalContexts: [...notices, ...existing] }
        // ⚠ content 与 value 不能同时给（宿主会抛 TypeError）。
        // block 决策用 feedback 而不是 content，所以只在非 block 时替换。
        if (contentOverride && decision.kind !== 'block' && !('value' in decision)) {
          decision.content = contentOverride
          /**
           * ── P1-11：**到这里才允许记账** ──────────────────────────────
           * 归档文件在判定阶段就已经落盘了（那是证据，不删），但「省了多少字符」
           * 这类收益必须等内容**真的替换进上下文**之后才成立。旧版在落盘瞬间就
           * 记账，而这一支（下游给了 value 或 block）根本不会用我们的 content ——
           * 于是报表把没省下的字符算成了收益。
           */
          if (pendingArchive?.commit) {
            pendingArchive.commit()
            stats.archived++
          }
        } else if (pendingArchive?.dropped) {
          // 没生效：写 archive-dropped + 标降级，**一分钱收益都不记**。
          const why = decision.kind === 'block'
            ? '下游决策是 block（改用 feedback，不接受 content）'
            : '下游给了 value（content 与 value 不能同时给）'
          pendingArchive.dropped(why)
          stats.archivedDropped = (stats.archivedDropped ?? 0) + 1
        }
        return decision
      } catch (error) {
        // 组装失败：归档内容没进去，同样不许记账。
        if (pendingArchive?.dropped) {
          pendingArchive.dropped(`决策组装异常：${error?.message ?? error}`)
          stats.archivedDropped = (stats.archivedDropped ?? 0) + 1
        }
        return downstream
      }
    })
  } catch (error) {
    deps.capabilities?.markDegraded?.('archiveToolResults', `tools/post-execute 挂载失败：${error?.message ?? error}`)
    deps.log?.warn?.(`执行后观察挂载失败（归档与提醒不生效，其余正常）：${error?.message ?? error}`)
    return null
  }

  if (typeof off !== 'function') {
    deps.capabilities?.markDegraded?.('archiveToolResults', 'tools/post-execute 注册没有返回卸载句柄')
    return null
  }
  deps.capabilities?.markMounted?.('archiveToolResults', off, 'tools/post-execute')
  deps.capabilities?.markSupported?.('progressWatch', 'ProgressWatch 已接入')
  deps.capabilities?.markSupported?.('capabilityPrecheck', '失败分型已接入')
  // 0.3.0 的两条新能力都在这一层实现：挂上就算"宿主支持且已接入"。
  // 真正的"命中过"由各分支的 markObserved 负责。
  deps.capabilities?.markSupported?.('nudgeOnce', '同一会话同一原因只提醒一次（nudgeOnceOnly）')
  deps.capabilities?.markSupported?.('archiveByTool', '按工具覆盖归档阈值与摘要形态')

  const dispose = () => {
    try { off() } catch { /* 清理失败无所谓 */ }
    deps.capabilities?.markUnmounted?.('archiveToolResults', '已卸载')
  }
  dispose.stats = stats
  dispose.handle = off
  return dispose
}

/** 只读工具名。用来区分"改同一个文件"和"读同一个文件"。 */
const READ_TOOLS = new Set([
  'read', 'read_file', 'view', 'cat', 'list', 'ls', 'list_dir', 'list_directory',
  'glob', 'grep', 'search', 'find', 'codebase_search',
])

function isReadTool(name) {
  return READ_TOOLS.has(String(name ?? '').toLowerCase())
}
