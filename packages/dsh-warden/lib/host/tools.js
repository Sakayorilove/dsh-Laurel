/**
 * dsh-warden · 模型侧工具
 *
 * 只放"模型必须主动调"的能力。护栏里那些自动生效的部分（等待上限、归档、
 * 提醒）都不做成工具 —— 工具要靠模型想起来才会用，而内耗恰恰发生在它想不起来的时候。
 *
 * ── 为什么不用 `defineTool` ────────────────────────────────────────────
 * 与整个 Laurel 系列一致：`defineTool` 的产物就是一份编译好的 JSON Schema，
 * 这里直接把那份 schema 交给 `ctx.tools.register()`。换来的好处是宿主半边
 * **一个非内置 import 都没有** —— `@deepseek-ai/*` 能不能被解析取决于宿主的
 * 运行时解析机制，那是实现细节不是契约，少依赖一个就少一种"装上但什么都不发生"。
 *
 * ⚠ `required` 是**父级的字符串数组**，不是属性里的布尔值。写成布尔值会被当成
 * 未知关键字丢掉，**必填校验静默失效**且不报错。`assertRequiredShape()` 就是
 * 为这个坑设的闸门（照抄 strata 的做法，同一个坑不想踩第二次）。
 *
 * ── 大输出回读不另注册工具 ─────────────────────────────────────────────
 * 归档落在真实文件上（`$DSH_HOME/warden/archive/<会话>/<callId>.txt`），
 * 宿主自带的读取工具就能按行区间读它。补充评审的要求是"优先复用已有
 * read/ops 能力，不无故再注册一排工具"，所以这里**不加** warden_read_archive。
 */

import { isAbsolute, resolve } from 'node:path'
import { HASH_ALGORITHM_VERSION, PACKAGE_NAME, VERSION } from '../core/config.js'
import { sha256File } from '../core/text.js'
import { namedResourceCatalog, resolveResourceId } from '../core/resource.js'
import { STAGE_STATUSES } from '../core/progress.js'
import { buildReport } from '../core/report.js'

/** 文本结果块。宿主 ContentBlock 的最简形态。 */
const text = (value) => [{ type: 'text', text: String(value) }]

/** 守住 `required` 的形状。写错就抛，绝不静默降级。 */
function assertRequiredShape(toolName, schema) {
  if (schema == null || typeof schema !== 'object') return
  const node = schema
  if ('required' in node && !Array.isArray(node.required)) {
    throw new Error(`工具 ${toolName}：required 必须是字符串数组（收到 ${JSON.stringify(node.required)}）。`)
  }
  if (Array.isArray(node.required) && node.properties && typeof node.properties === 'object') {
    for (const name of node.required) {
      if (!(name in node.properties)) {
        throw new Error(`工具 ${toolName}：required 里的 "${name}" 没有出现在 properties 中。`)
      }
    }
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [name, child] of Object.entries(node.properties)) {
      if (child && typeof child === 'object' && 'required' in child) {
        throw new Error(`工具 ${toolName}：属性 "${name}" 里写了 required —— 应写成父级 required: ["${name}"]。`)
      }
      assertRequiredShape(toolName, child)
    }
  }
  if (Array.isArray(node.oneOf)) for (const branch of node.oneOf) assertRequiredShape(toolName, branch)
  if (node.items) assertRequiredShape(toolName, node.items)
}

/** 组装一个工具定义，形状与 `defineTool` 的产物一致。 */
function tool(spec) {
  if (!spec.name || !spec.description) throw new Error('工具必须有 name 与 description')
  const parameters = spec.parameters ?? { type: 'object', additionalProperties: false, properties: {} }
  const outputSchema = spec.output?.schema
    ?? { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }
  assertRequiredShape(spec.name, parameters)
  assertRequiredShape(spec.name, outputSchema)
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => text(value?.text ?? ''),
    },
    async execute(args, exec) {
      const result = await spec.execute(args ?? {}, exec)
      return typeof result === 'string' ? { text: result } : result
    },
  }
}

/** 取当前会话标识。拿不到返回空串。 */
function sessionOf(exec) {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : ''
}

function workspaceOf(exec) {
  return exec?.agent?.session?.header?.cwd ?? ''
}

/**
 * 算一个文件的**字节级** sha256（R5）。
 *
 * 旧版是 `sha256Hex(readFileSync(full))`，而 `sha256Hex` 内部先 `String(value)`
 * —— Buffer 被按 UTF-8 解码，`0x80` 与 `0x81` 都变成 U+FFFD，于是两个不同的
 * 文件得到**同一个** hash，还与 `sha256sum` 对不上。exe/dll/图片全废。
 * 现在直接把 Buffer 喂给 hash。读不到就抛，调用方变成 `error` 状态。
 */
export function hashFile(path, cwd) {
  const full = isAbsolute(path) ? path : resolve(cwd || process.cwd(), path)
  return { full, ...sha256File(full) }
}

/** 台账状态的中文与图标。**unverified 绝不显示成"有效"。** */
const STATE_LABEL = {
  verified: '✅ verified（产物指纹逐字节一致）',
  stale: '❌ stale（产物已漂移，这条读数作废）',
  unverified: '⚠ unverified（未绑定产物 / 环境未知 / 旧算法指纹 —— **不能当验收通过**）',
  error: '⛔ error（算不出当前指纹）',
}

/**
 * 造全部工具。
 *
 * @param {{config: () => any, locks: any, evidence: any, counters: any, home: string,
 *          capabilities?: any, governance?: any, progress?: any, stages?: any,
 *          guards?: () => any[], log?: any, onEvent?: (e: object) => void}} deps
 */
export function createTools(deps) {
  return [
    /* ───────────────────────────── 状态 ───────────────────────────── */
    tool({
      name: 'warden_status',
      description: '查看护栏的真实状态：各项能力是 supported / mounted / observed / degraded 中的哪一档、'
        + '治理 owner 是谁、当前持有的资源锁、上下文压力口径、进展与阶段预算、读数台账统计。只读。'
        + '怀疑护栏没生效时先调它 —— "已启用"和"真的命中过"是两件事。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: (_args, exec) => {
        const config = deps.config?.() ?? {}
        const locks = Object.values(deps.locks?.list?.() ?? {})
        const evidence = deps.evidence?.stats?.() ?? { total: 0, artifacts: 0 }
        const guardStats = deps.guards?.() ?? []
        const capabilities = deps.capabilities?.snapshot?.() ?? []
        const governance = deps.governance?.snapshot?.() ?? []
        const sessionId = sessionOf(exec)
        const progress = deps.progress?.snapshot?.(sessionId) ?? null
        const budget = sessionId ? deps.progress?.budgetCheck?.(sessionId, config) : null
        const stage = deps.stages?.latest?.(sessionId) ?? null

        const capLine = capabilities.length > 0
          ? capabilities.map((c) => `  · ${c.name}（${c.label}）= ${c.state}`
            + `${c.observedCount ? ` 命中 ${c.observedCount} 次` : ''}`
            + `${c.reason ? ` — ${c.reason}` : ''}`).join('\n')
          : '  （没有登记任何能力）'

        const govLine = governance.length > 0
          ? governance.map((g) => `  · ${g.capability}（${g.label}）→ ${g.active ? '本模块执行' : (g.owner ? `由 ${g.owner} 执行，本模块待命` : '无人声明')}`).join('\n')
          : '  （无跨模块治理能力）'

        const lines = [
          `${PACKAGE_NAME} v${VERSION}　指纹算法 sha256-bytes-v${HASH_ALGORITHM_VERSION}`,
          `档位：${config.preset}（enabled=${config.enabled}）`,
          `等待上限：${config.waitCapMs > 0 ? `${Math.round(config.waitCapMs / 1000)} 秒（作用在 ${config.waitTools?.join('/') ?? 'wait_agent'}）` : '不干预'}`,
          `　无活动时限：${Math.round(config.idleLimitMs / 1000)} 秒 → ${config.idleAction}　阶段预算：${Math.round(config.taskBudgetMs / 60000)} 分钟 / ${config.taskBudgetReplies} 次回复`,
          `归档大输出：${config.archiveToolResults ? `开（≥${config.archiveThresholdChars} 字符，保留首尾共 ${config.archiveKeepChars}）` : '关'}`,
          `历史压缩：warden **不做**；唯一 owner 是官方 dsh-compaction-basic（+ tool-result-pruner 治单条超长）`,
          `星型拓扑：${config.starTopology ? '开' : '关'} · 结论落文件：${config.resultsToFile ? '开' : '关'}`,
          `无进展识别：${config.progressWatch ? `开（${config.progressMode}，同一失败 ${config.progressFailureThreshold} 次起）` : '关'}`,
          `共享锁：${config.lockGuard ? '开' : '关'} · 读数台账：${config.evidenceLedger ? '开' : '关'} · 阶段合同：${config.stageContract ? '开' : '关'}`,
          '',
          '能力状态（supported=宿主有 / mounted=确实挂上 / observed=真的命中过 / degraded=坏了）：',
          capLine,
          '',
          '跨模块治理 owner（同一能力全套件只一个执行者）：',
          govLine,
          '',
          `当前持有的资源锁（${locks.length}）：${locks.length === 0 ? '无' : ''}`,
          ...locks.map((l) => `  · ${l.name} → ${l.resourceId}　持有者 ${l.owner}　fence=${l.fence}　`
            + `${Math.max(0, Math.round((l.expiresAt - Date.now()) / 1000))} 秒后过期`),
          `锁统计：${JSON.stringify(deps.locks?.snapshot?.() ?? {})}`,
          `读数台账：${evidence.total} 条（已绑指纹 ${evidence.bound ?? 0}、未绑 ${evidence.unbound ?? 0}、旧算法 ${evidence.legacyHashVersion ?? 0}），`
            + `${evidence.artifacts} 个不同产物指纹`,
          '',
          progress ? `本会话进展：${progress.replies} 次回复 · 最后有效进展「${progress.lastProgressReason}」`
            + `（${Math.round(progress.idleMs / 1000)} 秒前）· 新读数 ${progress.evidenceMarks} 条 · 被否定的假设 ${progress.hypothesesNegated} 个` : '',
          budget?.due ? `阶段预算：${budget.reason} —— 需要一次复盘（不是失败，也不是可以收工）` : '',
          stage ? `当前阶段：${stage.stageId} → ${stage.status}　目标：${stage.goal || '(未填)'}`
            + `　剩余必需项 ${stage.requiredRemaining?.length ?? 0} 个` : '',
          '',
          `运行时统计：${guardStats.map((s) => `${s.name}=${JSON.stringify(s.stats ?? {})}`).join(' ') || '—'}`,
        ]
        return lines.filter((line, index) => line !== '' || index < lines.length - 1).join('\n')
      },
    }),

    /* ─────────────────────────── 共享资源锁 ─────────────────────────── */
    tool({
      name: 'acquire_lock',
      description: '取得一个共享资源的**执行权**。用在没法物理隔离的场景：真实桌面输入、显示模式、'
        + '某个部署目标、某个端口、大家都会写的目录。判定按**规范资源身份**，不是按锁名 —— '
        + '两把名字不同的锁指向同一条路径/同一个父子树，第二把会被拒。'
        + '命名资源写 desktop-input / display-mode / deployment:<目标> / port:<端口> / workspace:<根>；'
        + '路径资源请给绝对路径或让护栏用当前工作区解析。返回里带 fence（栅栏令牌），renew/release 要用它。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: '人可读的锁名，例如 build-dir。仅用于显示与日志，不参与冲突判定。' },
          resource: {
            type: 'string',
            description: '要占的资源。命名资源：desktop-input / display-mode / deployment:web-host / port:8080 / workspace:<根路径>。'
              + '路径资源：绝对路径（相对路径会按当前工作区解析）。',
          },
          path: { type: 'string', description: '兼容旧写法：等价于 resource 传一个路径。' },
          ttl_ms: { type: 'integer', description: '多久自动过期（毫秒）。留空用配置默认值。长任务请配合 renew_lock。' },
          note: { type: 'string', description: '你为什么需要它（可选，方便别人看懂）。' },
        },
        required: ['resource'],
      },
      execute: (args, exec) => {
        const config = deps.config?.() ?? {}
        if (config.lockGuard === false) {
          return { text: '共享锁功能当前是关闭的（设置里把「共享资源执行权」打开再用）。' }
        }
        const owner = sessionOf(exec)
        if (!owner) return { text: '拿不到当前会话标识，无法加锁 —— 本次**没有取得**执行权。' }
        const target = String(args.resource ?? args.path ?? args.name ?? '')
        const result = deps.locks.acquire({
          name: typeof args.name === 'string' ? args.name : '',
          resource: typeof args.resource === 'string' ? args.resource : '',
          path: typeof args.path === 'string' ? args.path : '',
          owner,
          ttlMs: Number(args.ttl_ms) > 0 ? Number(args.ttl_ms) : config.lockTtlMs,
          note: typeof args.note === 'string' ? args.note : '',
          cwd: workspaceOf(exec),
        })
        if (!result.ok) {
          if (result.unresolvable) return { text: `加锁失败：${result.reason}` }
          if (!result.heldBy) return { text: `加锁失败（**没有取得**执行权）：${result.reason ?? '未知原因'}` }
          const held = result.heldBy
          return { text: `资源「${held.resourceId}」现在被 ${held.owner} 占着`
            + `（锁名 ${held.name}${held.path ? `，覆盖 ${held.path}` : ''}），`
            + `${Math.max(0, Math.round((held.expiresAt - Date.now()) / 1000))} 秒后过期，fence=${held.fence}。\n`
            + `建议：先做不依赖这个资源的部分；或者**改用你自己的独立目录/部署目标**——物理隔离比排队快得多。\n`
            + `注意：过期不代表对方已经停手，别指望它一过期就能安全接管。` }
        }
        const lock = result.lock
        deps.onEvent?.({
          kind: 'lock-acquire',
          workspace: workspaceOf(exec),
          sessionId: owner,
          detail: `${lock.name} → ${lock.resourceId}（fence=${lock.fence}）`,
        })
        return { text: `已取得「${lock.resourceId}」的执行权${lock.path ? `（${lock.path}）` : ''}。\n`
          + `  fence（栅栏令牌）：${lock.fence} —— renew_lock / release_lock 要带上它。\n`
          + `  ${Math.round((lock.expiresAt - Date.now()) / 1000)} 秒后自动过期；长任务请用 renew_lock 续租。\n`
          + (result.mergedCrossPlatform
            ? `  注：这个路径被识别为 Windows 盘与 WSL /mnt 挂载的**同一片文件**，已合并成同一资源。\n`
            : '')
          + `  覆盖边界：护栏只拦得住**认得出路径**的写入。任意 shell 命令里看不出来的写入不在覆盖范围内。` }
      },
    }),

    tool({
      name: 'renew_lock',
      description: '给已持有的资源锁续租。长任务（部署、构建、批量验收）必须在过期前续，'
        + '否则会被判陈旧并可能被别的会话回收。fence 对不上说明这把锁已经被回收或抢占 —— '
        + '那时你**必须停止对该资源的写入**并重新申请。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          resource: { type: 'string', description: '资源身份或路径（与 acquire_lock 传的一致）。' },
          fence: { type: 'integer', description: 'acquire_lock 返回的栅栏令牌。' },
          ttl_ms: { type: 'integer', description: '续多久（毫秒）。留空用配置默认值。' },
        },
        required: ['resource'],
      },
      execute: (args, exec) => {
        const owner = sessionOf(exec)
        const config = deps.config?.() ?? {}
        const resolved = resolveResourceId(String(args.resource ?? ''), workspaceOf(exec))
        if (!resolved.resolvable) return { text: `续租失败：${resolved.reason}` }
        const result = deps.locks.renew({
          resourceId: resolved.resourceId,
          owner,
          fence: Number.isFinite(Number(args.fence)) ? Number(args.fence) : undefined,
          ttlMs: Number(args.ttl_ms) > 0 ? Number(args.ttl_ms) : config.lockTtlMs,
        })
        if (!result.ok) {
          return { text: `续租失败：${result.reason}`
            + (result.fenced ? '\n这把锁的执行权已经不属于你了，请停止写入并重新 acquire_lock。' : '') }
        }
        return { text: `已续租「${result.lock.resourceId}」，fence=${result.lock.fence}，`
          + `${Math.round((result.lock.expiresAt - Date.now()) / 1000)} 秒后过期。` }
      },
    }),

    tool({
      name: 'release_lock',
      description: '释放你持有的资源锁。只有持有者能释放；`force` **不能**用来抢别人的活锁 —— '
        + '过期不代表对方已经停手。确实陈旧的锁（已过期且持有者进程不在）才允许强制回收，'
        + '活锁只能由用户在设置页强制释放。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          resource: { type: 'string', description: '资源身份或锁名。' },
          fence: { type: 'integer', description: 'acquire_lock 返回的栅栏令牌（带上更安全）。' },
          force: { type: 'boolean', description: '只在确认对方已经不在跑时用；对活锁无效。' },
        },
        required: ['resource'],
      },
      execute: (args, exec) => {
        const owner = sessionOf(exec)
        const raw = String(args.resource ?? '')
        const resolved = resolveResourceId(raw, workspaceOf(exec))
        const result = deps.locks.release({
          resourceId: resolved.resolvable ? resolved.resourceId : '',
          name: resolved.resolvable ? '' : raw,
          owner,
          force: args.force === true,
          // 模型侧调用一律按 'model' 处理；'user' 只由设置页的 HTTP 面使用。
          actor: 'model',
          fence: Number.isFinite(Number(args.fence)) ? Number(args.fence) : undefined,
        })
        if (!result.ok) {
          return { text: `释放失败：${result.reason ?? '未知原因'}` }
        }
        if (!result.released) return { text: `「${raw}」本来就没有被锁着。` }
        deps.onEvent?.({ kind: 'lock-release', workspace: workspaceOf(exec), sessionId: owner, detail: raw })
        return { text: `已释放「${raw}」。fence 已推进，旧持有者无法再续租。` }
      },
    }),

    tool({
      name: 'list_locks',
      description: '列出当前所有还没过期的资源锁，以及全套件的治理 owner 归属。只读。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: () => {
        const locks = Object.values(deps.locks?.list?.() ?? {})
        const now = Date.now()
        const lockLines = locks.length === 0
          ? ['当前没有任何资源锁。']
          : locks.map((l) => `· ${l.name} → ${l.resourceId}　持有者 ${l.owner}　fence=${l.fence}　`
            + `${Math.max(0, Math.round((l.expiresAt - now) / 1000))} 秒后过期${l.note ? `　备注：${l.note}` : ''}`)
        const governance = deps.governance?.snapshot?.() ?? []
        const govLines = governance.map((g) => `· ${g.capability}（${g.label}）→ `
          + (g.active ? '本模块执行' : (g.owner ? `由 ${g.owner} 执行` : '无人声明')))
        const catalog = namedResourceCatalog().map((c) => `· ${c.example} — ${c.label}`).join('\n')
        return [
          ...lockLines,
          '',
          governance.length > 0 ? `治理 owner（跨模块，同一能力只有一个执行者）：\n${govLines.join('\n')}` : '',
          '',
          `可用的命名资源：\n${catalog}`,
        ].filter(Boolean).join('\n')
      },
    }),

    /* ─────────────────────────── 读数指纹台账 ─────────────────────────── */
    tool({
      name: 'evidence_record',
      description: '记录一条测量结果，并把它**绑定到当时产物的字节级 sha256 指纹**。'
        + '这样以后复核时能判断这条读数是不是已经作废 —— 治的是"验收期间部署反复变化、读数无法归属"。'
        + '不绑定产物的读数会被记成 unverified，**不能当验收通过**。写盘失败会明确报错，不会假装记上了。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: '这条读数的名字，例如 "框外空白-单屏"。' },
          reading: { type: 'string', description: '读数本身，例如 "0 异常 / 14 步"。' },
          artifact: { type: 'string', description: '产物的路径（强烈建议）。相对路径按当前工作区解析。' },
          note: { type: 'string', description: '补充说明（可选）。' },
          environment: {
            type: 'object',
            additionalProperties: true,
            properties: {},
            description: '实验环境（可选但推荐）：pid、buildTag、profile、显示模式、是否隔离等。'
              + '环境变了与产物变了是两件事，分开记才判得清。',
          },
        },
        required: ['label', 'reading'],
      },
      execute: (args, exec) => {
        const config = deps.config?.() ?? {}
        if (config.evidenceLedger === false) {
          return { text: '读数台账当前是关闭的（设置里把「读数指纹台账」打开再用）。' }
        }
        let artifactHash = ''
        let algorithm = ''
        let resolvedArtifact = typeof args.artifact === 'string' ? args.artifact : ''
        let warn = ''
        if (resolvedArtifact) {
          try {
            const hashed = hashFile(resolvedArtifact, workspaceOf(exec))
            artifactHash = hashed.hash
            algorithm = hashed.algorithm
            resolvedArtifact = hashed.full
          } catch (error) {
            warn = `\n⚠ 读不到产物（${error?.message ?? error}）。这条读数**没有绑定指纹**，`
              + `复核时会判 unverified —— 它不能作为验收依据。`
          }
        } else {
          warn = '\n⚠ 没有绑定产物路径。这条读数会被记成 unverified，**不能当验收通过**。'
        }
        const recorded = deps.evidence.record({
          label: args.label,
          reading: args.reading,
          artifact: resolvedArtifact,
          artifactHash,
          hashVersion: HASH_ALGORITHM_VERSION,
          note: args.note,
          owner: sessionOf(exec),
          environment: {
            ...(args.environment && typeof args.environment === 'object' ? args.environment : {}),
            algorithm: algorithm || undefined,
            pid: process.pid,
            workspace: workspaceOf(exec),
          },
        })
        // R5：写盘失败必须返回失败，不返回一个假装存在的记录。
        if (!recorded.ok) return { text: `记录失败：${recorded.reason}` }
        const row = recorded.row
        deps.progress?.markEvidence?.(sessionOf(exec), `记录了读数「${row.label}」`)
        deps.onEvent?.({
          kind: 'evidence-record',
          workspace: workspaceOf(exec),
          sessionId: sessionOf(exec),
          detail: `${row.label} = ${row.reading}${artifactHash ? ` @${artifactHash.slice(0, 12)}` : ' (无指纹 → unverified)'}`,
        })
        return { text: `已记录（id=${row.id}）：${row.label} = ${row.reading}`
          + (artifactHash
            ? `\n指纹：sha256:${artifactHash.slice(0, 16)}…（${algorithm}，${resolvedArtifact}）`
            : warn) }
      },
    }),

    tool({
      name: 'evidence_check',
      description: '复核一条已记录的读数，返回四种状态之一：verified（指纹逐字节一致）/ '
        + 'stale（产物已漂移，读数作废）/ unverified（没绑产物、环境未知或旧算法指纹，不能当通过）/ '
        + 'error（算不出当前指纹）。注意 verified 只证明**产物身份没变**，'
        + '不证明测试通过、也不证明实验环境没被污染。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: '要复核的读数名字。' },
          id: { type: 'string', description: '或者直接用记录时返回的 id。' },
        },
      },
      execute: (args, exec) => {
        const verdict = deps.evidence.check(
          { label: args.label, id: args.id },
          (artifact) => hashFile(artifact, workspaceOf(exec)),
        )
        if (!verdict.found) {
          return { text: `台账里没有这条读数（label=${args.label ?? '—'} id=${args.id ?? '—'}）。` }
        }
        const row = verdict.row
        const env = row.environment && Object.keys(row.environment).length > 0
          ? `\n实验环境：${JSON.stringify(row.environment)}`
          : '\n实验环境：未记录（这一项属于"环境未知"，即使指纹一致也只是产物身份相同）'
        return { text: `${STATE_LABEL[verdict.state] ?? verdict.state}\n`
          + `读数：${row.label} = ${row.reading}\n${verdict.reason}\n`
          + `记录时间：${row.at}　指纹算法版本：v${row.hashVersion ?? 1}（当前 v${HASH_ALGORITHM_VERSION}）`
          + `${row.artifact ? `\n产物：${row.artifact}` : ''}${env}` }
      },
    }),

    /* ─────────────────────────── 阶段合同（R8）─────────────────────────── */
    tool({
      name: 'warden_stage',
      description: '写一条最小阶段记录：目标 / 验收项 / 源码与部署身份 / 当前假设 / 最近新证据 / 下一步 / '
        + '资源占用 / 剩余必需项 / 状态。状态取 in-progress、conditional-complete、blocked、failed、complete 之一。'
        + '**缺必需项时不能写 complete** —— 验收项为空、有验收项没依据、还有必需项没做，都会被拒并要求改成另外三种。'
        + '阶段预算到点只是复盘提醒，不是自动成功也不是自动放弃。与外部计划工具并存时以计划侧的状态为准，这里只补验收齐不齐。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stage_id: { type: 'string', description: '阶段标识，例如 S1 / fix-wait-cap。留空用 default。' },
          goal: { type: 'string', description: '这一阶段要达成什么。' },
          acceptance: {
            type: 'array',
            description: '验收项。每项写清"验什么"，验过之后回填 verified 与 evidence。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                item: { type: 'string', description: '验收项本身，例如"隔离宿主里 wait_agent 被截断到 60 秒"。' },
                verified: { type: 'boolean', description: '是否已经验过。' },
                evidence: { type: 'string', description: '依据：日志路径、命令、hash、截图等。' },
              },
              required: ['item'],
            },
          },
          source_identity: { type: 'string', description: '权威源码身份：路径 + 版本 + commit 或树 hash。' },
          deploy_target: { type: 'string', description: '部署/运行目标，例如 isolated-profile / desktop。' },
          hypothesis: { type: 'string', description: '当前假设。假设被否定也是进展，请照实写。' },
          new_evidence: { type: 'string', description: '最近的**新**证据。只有时间戳变了不算新证据。' },
          next_step: { type: 'string', description: '下一步做什么。' },
          resource_claims: { type: 'array', items: { type: 'string' }, description: '当前占用的资源身份。' },
          required_remaining: { type: 'array', items: { type: 'string' }, description: '还剩哪些**必需**项没做。非空时不能写 complete。' },
          status: { type: 'string', enum: STAGE_STATUSES, description: '阶段状态。' },
          plan_ref: { type: 'string', description: '外部计划/阶段的引用（有就填，避免两套完成真相）。' },
        },
        required: ['goal'],
      },
      execute: (args, exec) => {
        const config = deps.config?.() ?? {}
        if (config.stageContract === false) {
          return { text: '阶段合同当前是关闭的（设置里把「最小阶段合同」打开再用）。' }
        }
        const sessionId = sessionOf(exec)
        const recorded = deps.stages?.record?.({
          sessionId,
          stageId: args.stage_id,
          goal: args.goal,
          acceptance: args.acceptance,
          sourceIdentity: args.source_identity,
          deployTarget: args.deploy_target,
          hypothesis: args.hypothesis,
          newEvidence: args.new_evidence,
          nextStep: args.next_step,
          resourceClaims: args.resource_claims,
          requiredRemaining: args.required_remaining,
          status: args.status,
          planRef: args.plan_ref,
        })
        if (!recorded) return { text: '阶段合同功能不可用（台账没有接上）。' }
        if (!recorded.ok) return { text: `阶段记录被拒：${recorded.reason}` }
        const row = recorded.row
        deps.progress?.startStage?.(sessionId, row.stageId)
        const verifiedCount = row.acceptance.filter((a) => a.verified).length
        return { text: `已记录阶段（id=${row.id}）：${row.stageId} → ${row.status}\n`
          + `  目标：${row.goal}\n`
          + `  验收项：${verifiedCount}/${row.acceptance.length} 已有依据\n`
          + `  剩余必需项：${row.requiredRemaining.length === 0 ? '无' : row.requiredRemaining.join('、')}\n`
          + `  下一步：${row.nextStep || '(未填)'}` }
      },
    }),

    /* ─────────────────────────── 收益自报表（#5）─────────────────────────── */
    tool({
      name: 'warden_report',
      description: '收益自报表：某个时间范围内归档省下多少字符 / 约多少 token（**估算**，不是实测）、'
        + '各类提醒各发了多少条、读数台账新增几条、以及拿得到时的花费。'
        + '用它判断"哪条护栏值得留"。since 可用 today（默认，本地日）/ session（当前会话）/ '
        + 'ISO 时间或 YYYY-MM-DD。空数据或读不到时会明说没有数据，**不会**用 0 冒充已知。只读。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          since: {
            type: 'string',
            description: "统计起点：'today'（默认，本地日零点）/ 'session'（当前会话）/ ISO 8601 / YYYY-MM-DD。",
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            data: { type: 'object' },
          },
          required: ['text'],
        },
      },
      execute: (args, exec) => {
        const config = deps.config?.() ?? {}
        const report = buildReport({
          home: deps.home,
          config,
          since: typeof args.since === 'string' && args.since.length > 0 ? args.since : 'today',
          sessionId: sessionOf(exec),
          ledger: deps.ledger,
          evidence: deps.evidence,
        })
        if (report.known !== true) {
          // 关闭 ≠ 出错：明确告诉模型"这项被关掉了"，别让它以为护栏坏了。
          return {
            text: report.disabled === true ? report.reason : `没有可统计的数据：${report.reason}`,
            data: report,
          }
        }
        deps.capabilities?.markObserved?.(
          'selfReport',
          `since=${report.since.spec} archives=${report.data.archives.count} notices=${report.data.notices.total}`,
        )
        return { text: report.markdown, data: report }
      },
    }),
  ]
}
