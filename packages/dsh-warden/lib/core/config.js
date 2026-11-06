/**
 * dsh-warden · 配置、三档预设、路径
 *
 * 依赖只有 node 内置模块 —— 这是整个 Laurel 系列的纪律：
 * 插件要能被别人直接装，不该带第三方依赖；宿主服务一律走 `ctx.get()` 取。
 *
 * ── 这一层的设计要点：预设 + 自定义 ────────────────────────────────────
 * 三档预设（温和 / 均衡 / 严格）是**三张完整的取值表**，不是"基线 + 补丁"。
 * 这样"我现在到底在什么档位"永远只有一个答案，不会出现
 * "preset 写 balanced、但某个字段还留着上次 strict 的值"这种幽灵状态。
 *
 * 用户动了任何一个单项 → 前端把 `preset` 改成 `custom`，并把当前值整份存下来。
 * 也就是说 `custom` 档 = "以你上次的取值为准"，不需要另存一份表。
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 包名。同时是客户端半边 `window.__ModuleLoader__.load({ id })` 用的 id，两处必须一致。 */
export const PACKAGE_NAME = 'dsh-warden'

/** 与 package.json 的 version 保持一致（测试会核对）。 */
export const VERSION = '0.3.0'

/**
 * 指纹算法版本。写进台账每一行。
 *
 * v1 是评审判定的错误实现：`sha256Hex` 先 `String(buffer)` 再按 UTF-8 hash，
 * 于是 `0x80` 和 `0x81` 两个不同文件都变成替换字符、得到同一个 hash，
 * 也与 `sha256sum` 对不上。v2 起直接对字节流做 SHA-256。
 *
 * **v1 的记录不能被 v2 无条件继承为有效** —— 见 `EvidenceLedger.check()`。
 */
export const HASH_ALGORITHM_VERSION = 2

/** 档位。前三个是预设，`custom` 表示"逐项自定义"。 */
export const PRESETS = ['gentle', 'balanced', 'strict', 'custom']

/** 档位的中文名，界面与日志共用。 */
export const PRESET_LABELS = {
  gentle: '温和',
  balanced: '均衡',
  strict: '严格',
  custom: '自定义',
}

/**
 * 三档预设的完整取值表。
 *
 * 取值依据（全部来自 2026-10-14 本机实测，见 README 的「这些数字是怎么来的」）：
 *   - `waitCapMs`：实测一个会话里 `wait_agent` 被调 41 次，单次可等 1 小时；
 *     宿主对 `wait_agent` 没有硬超时（它没声明 timeoutMs）。
 *     注意 `wait_agent` 自己要求 10000..3600000，所以上限不要设到 10 秒以下。
 *   - `reworkThreshold` / `rereadThreshold`：实测同一条 WSL 命令跑了 111 次、
 *     同一个文件被读了 60 次、同一个文件被改了 31 次。
 *   - `waterLevelStep`：实测单步上下文中位 218k、峰值 627k 且只涨不降。
 *   - `microCompact`：**默认全档关闭**。`agent/pre-step` 拿到的是 inbox 待追加
 *     批次，里面没有历史工具结果；历史压缩的唯一 owner 是官方
 *     `dsh-compaction-basic`（见 `host/inject.js` 顶部说明）。留着这个开关
 *     只是为了兼容旧配置文件，打开也不会再有"裁掉 N 条历史"的行为。
 *   - `archiveToolResults`：替代 microCompact 的正确做法 —— 对**新产生的**
 *     大文本结果先落盘，只把有界摘要 + hash + 引用放进上下文。
 *     阈值 4096 / 保留 800（2026-10-17 审计：8192 只拦到 19 条，4~8KB 那一档
 *     才是 read/pwsh 输出的密集区）。
 *   - `nudgeMaxPerKey` / `nudgeHardAt` / `nudgeMaxPerTurn`（2026-10-16 实测）：
 *     一次 3 小时会话里 rework 96 条 + reread 27 条，占 151 条提醒里 90% 的成本
 *     （约 3.82M token-steps），而同一文件改到 ×72 期间**行为没变**。
 *     所以：翻倍发 + 每键上限 nudgeMaxPerKey + 到 nudgeHardAt 升级硬动作 +
 *     每个用户回合每个键最多 nudgeMaxPerTurn 条。
 *   - `lockTtlMs`：实测 4 个子代理共用一个部署目录，验收期间部署反复变化、
 *     读数无法归属。
 *   - `taskBudgetMs` / `taskBudgetReplies`：评审建议的试验起点
 *     （每阶段 10 分钟或 30 次模型回复先到者复盘）。**到点是复盘提醒，
 *     不是自动成功、也不是自动放弃。**
 */
export const PRESET_VALUES = {
  /**
   * 温和 —— 只提醒、几乎不拦。
   * 适合"我先看看它说了什么再决定"，或者你本来就喜欢自己盯着。
   */
  gentle: {
    waitCapMs: 300000,       // 等待上限 5 分钟
    waitTools: ['wait_agent'],
    starTopology: true,      // 子代理只对主控汇报（只注入规则，不拦工具）
    resultsToFile: false,    // 子代理结论写文件（关）
    reworkNudge: true,       // 返工提醒（同一个文件反复改）
    reworkThreshold: 5,
    nudgeMaxPerKey: 2,       // 同一文件同类提醒最多几条（soft）
    nudgeHardAt: 9,          // 到第几次改成"硬动作"：要求先落盘/说清试过什么/换策略
    nudgeMaxPerTurn: 2,      // 同一文件同一类型在每个用户回合里最多几条
    nudgeTurnBudget: 2,      // 每个用户回合最多发几条提醒（跨文件/跨类型的总量上限）
    rereadNudge: false,      // 重复读提醒（关）
    rereadThreshold: 4,
    // 2026-10-17：实测零行为改变、只占常驻字符，默认关（保留开关供定向打开）
    waterLevelNudge: false,   // 水位提醒
    waterLevelStep: 100000,
    waterLevelRatio: 0.6,    // 或者"占窗口比例"到线也提醒（能读到窗口时才用）
    microCompact: false,     // 历史裁剪：默认关（R3 —— 这一层拿不到历史）
    microCompactKeep: 10,
    archiveToolResults: true, // 新的大文本结果先落盘，只把有界摘要+引用放进上下文
    archiveThresholdChars: 16000,
    archiveKeepChars: 1200,
    archiveMaxBytes: 209715200,
    archiveMaxAgeDays: 30,
    unknownToolHint: true,   // 未知工具给可读提示
    editMissHint: true,      // 改文件匹配失败后提示先重读
    lockGuard: false,        // 共享目录锁（关）
    lockTtlMs: 300000,
    evidenceLedger: false,   // 读数指纹台账（关）
    progressWatch: true,     // 无进展识别
    progressMode: 'observe', // 先观察，不动手
    progressFailureThreshold: 3,
    progressStagnationThreshold: 5,  // P2-2：同一 call+同一 result 连续几次算停滞
    stageContract: true,     // 最小阶段合同
    capabilityPrecheck: true, // 开工前查能力，别在各会话反复撞同一堵墙
    idleLimitMs: 120000,     // 多久没有新活动算"疑似无响应"
    idleAction: 'notify',    // observe / notify（不自动 stop：无消息不等于无进程活动）
    taskBudgetMs: 1800000,   // 阶段预算 30 分钟 → 到点是复盘提醒，不是放弃
    taskBudgetReplies: 60,
    costNudge: true,        // 每会话花费统计（只统计；到线才提醒）
    budgetGate: false,      // 温和档不设预算线
    costBudgetUsd: 0,       // 0 = 不设预算（只统计不提醒）
    costWarnRatio: 0.9,
    nudgeOnceOnly: true,   // 同一会话同一原因只提醒一次（不是周期性播报）
    compactionFallbackRatio: 0.3, // 压力≥窗口 30% 且从未压缩过 → 提醒一次（0=关）
    archiveThresholdByTool: {}, // 按工具覆盖归档阈值（如 grep 更早归档）
    archiveKeepByTool: {},      // 按工具覆盖保留字符数
    reportEnabled: true,        // 收益自报表
    archiveExcludeTools: [],
    pathIgnore: [],
  },

  /**
   * 均衡 —— 默认档。该拦的拦、该提醒的提醒，但不激进。
   */
  balanced: {
    waitCapMs: 60000,        // 等待上限 60 秒
    waitTools: ['wait_agent'],
    starTopology: true,
    resultsToFile: true,
    reworkNudge: true,
    reworkThreshold: 3,
    nudgeMaxPerKey: 3,
    nudgeHardAt: 9,
    nudgeMaxPerTurn: 1,
    nudgeTurnBudget: 1,
    rereadNudge: true,
    rereadThreshold: 3,
    // 2026-10-17：实测零行为改变、只占常驻字符，默认关（保留开关供定向打开）
    waterLevelNudge: false,
    waterLevelStep: 50000,
    waterLevelRatio: 0.5,
    microCompact: false,     // 默认关：历史压缩的唯一 owner 是官方 Basic（R3）
    microCompactKeep: 6,
    archiveToolResults: true,
    archiveThresholdChars: 4096,  // 2026-10-17 审计：8192 只拦住 19 条，4~8KB 这一档全漏；降到 4096
    archiveKeepChars: 800,
    archiveMaxBytes: 209715200,
    archiveMaxAgeDays: 30,
    unknownToolHint: true,
    editMissHint: true,
    lockGuard: true,
    lockTtlMs: 120000,
    evidenceLedger: true,
    progressWatch: true,
    progressMode: 'observe',
    progressFailureThreshold: 3,
    progressStagnationThreshold: 3,  // P2-2：同一 call+同一 result 连续几次算停滞
    stageContract: true,
    capabilityPrecheck: true,
    idleLimitMs: 30000,      // 用户 2026-10-14 明确要求"30 秒没响应就要知道"
    idleAction: 'notify',
    taskBudgetMs: 600000,    // 10 分钟
    taskBudgetReplies: 30,
    costNudge: true,
    budgetGate: true,       // 均衡档：到线提醒一次，但不阻断
    costBudgetUsd: 2,       // 单会话 $2 预警线（≈ ¥14）
    costWarnRatio: 0.8,
    nudgeOnceOnly: true,   // 同一会话同一原因只提醒一次（不是周期性播报）
    compactionFallbackRatio: 0.3, // 压力≥窗口 30% 且从未压缩过 → 提醒一次（0=关）
    archiveThresholdByTool: {}, // 按工具覆盖归档阈值（如 grep 更早归档）
    archiveKeepByTool: {},      // 按工具覆盖保留字符数
    reportEnabled: true,        // 收益自报表
    archiveExcludeTools: [],
    pathIgnore: [],
  },

  /**
   * 严格 —— 团队 / CI / 无人值守。
   *
   * ⚠ 严格**不等于**更短轮询、更少证据、更容易杀掉正常任务（评审明确要求）。
   * 这一档改的是：提醒更早、无进展判定更敏感、等待与阶段预算更短、
   * 无进展模式从 observe 升到 enforce。证据归档反而**更**积极，
   * 因为无人值守时事后能核对比省几 KB 上下文重要得多。
   */
  strict: {
    waitCapMs: 30000,
    waitTools: ['wait_agent'],
    starTopology: true,
    resultsToFile: true,
    reworkNudge: true,
    reworkThreshold: 2,
    nudgeMaxPerKey: 4,
    nudgeHardAt: 6,
    nudgeMaxPerTurn: 1,
    nudgeTurnBudget: 1,
    rereadNudge: true,
    rereadThreshold: 2,
    // 2026-10-17：实测零行为改变、只占常驻字符，默认关（保留开关供定向打开）
    waterLevelNudge: false,
    waterLevelStep: 25000,
    waterLevelRatio: 0.4,
    microCompact: false,
    microCompactKeep: 4,
    archiveToolResults: true,
    // 2026-10-17：唯一放宽的一项。strict 原来是 3072/600，连 3KB 的
    // 目录列表都会被截成首尾各 300 字符（实测反馈是摩擦太大）。
    // 8–16KB 是 read/pwsh 输出的密集区，这一档性价比最低、摩擦最高。
    // 其余 strict 取值（等待 30s、重复 2 次提醒、无进展 enforce）原样不动。
    archiveThresholdChars: 16384,
    archiveKeepChars: 1200,
    archiveMaxBytes: 209715200,
    archiveMaxAgeDays: 30,
    unknownToolHint: true,
    editMissHint: true,
    lockGuard: true,
    lockTtlMs: 60000,
    evidenceLedger: true,
    progressWatch: true,
    progressMode: 'enforce',
    progressFailureThreshold: 2,
    progressStagnationThreshold: 2,  // P2-2：同一 call+同一 result 连续几次算停滞
    stageContract: true,
    capabilityPrecheck: true,
    idleLimitMs: 30000,
    idleAction: 'notify',
    taskBudgetMs: 600000,
    taskBudgetReplies: 30,
    costNudge: true,
    budgetGate: true,       // 严格档：到线提醒一次（仍然不阻断请求）
    costBudgetUsd: 1,       // 单会话 $1 预警线（≈ ¥7）
    costWarnRatio: 0.8,
    nudgeOnceOnly: true,   // 同一会话同一原因只提醒一次（不是周期性播报）
    compactionFallbackRatio: 0.3, // 压力≥窗口 30% 且从未压缩过 → 提醒一次（0=关）
    archiveThresholdByTool: {}, // 按工具覆盖归档阈值（如 grep 更早归档）
    archiveKeepByTool: {},      // 按工具覆盖保留字符数
    reportEnabled: true,        // 收益自报表
    archiveExcludeTools: [],
    pathIgnore: [],
  },
}

/** 布尔型字段。 */
export const BOOL_KEYS = [
  'enabled',
  'starTopology',
  'resultsToFile',
  'reworkNudge',
  'rereadNudge',
  'waterLevelNudge',
  'microCompact',
  'archiveToolResults',
  'unknownToolHint',
  'editMissHint',
  'lockGuard',
  'evidenceLedger',
  'progressWatch',
  'stageContract',
  'capabilityPrecheck',
  'costNudge',
  'budgetGate',
  /** 同一会话同一原因只提醒一次（2026-10-17：周期性播报的注入成本是线性的）。 */
  'nudgeOnceOnly',
  /** 收益自报表（省了多少 token / 多少钱）。 */
  'reportEnabled',
]

/** 数值型字段：[最小, 最大, 兜底]。 */
export const NUM_KEYS = {
  waitCapMs: [0, 3600000, 60000],           // 0 = 不干预；上限与宿主 wait_agent 的硬上限对齐
  reworkThreshold: [2, 50, 3],
  nudgeMaxPerKey: [1, 20, 3],
  nudgeHardAt: [2, 500, 9],
  nudgeMaxPerTurn: [1, 10, 1],
  nudgeTurnBudget: [1, 20, 1],
  rereadThreshold: [2, 50, 3],
  waterLevelStep: [2000, 500000, 50000],
  microCompactKeep: [1, 50, 6],
  archiveThresholdChars: [1024, 4000000, 8192],
  archiveKeepChars: [200, 200000, 1200],
  lockTtlMs: [10000, 3600000, 120000],
  progressFailureThreshold: [2, 20, 3],
  /** P2-2：「同一 call + 同一 result」连续几次算「结果停滞」（独立于失败阈值）。 */
  progressStagnationThreshold: [2, 20, 3],
  idleLimitMs: [5000, 3600000, 30000],
  taskBudgetMs: [60000, 86400000, 600000],
  taskBudgetReplies: [5, 2000, 30],
  /** 本会话花费预算（USD）。0 = 不设预算（只统计不提醒）。 */
  costBudgetUsd: [0, 100000, 0],
  /** 到预算的百分之多少开始预警。0.1~0.99。 */
  costWarnRatio: [0.1, 0.99, 0.8],
  /**
   * 归档目录回收（P2-8，2026-10-24）。
   *
   * 装几个月后 ~/.dsh 会无界膨胀，而原来没有任何 UI 或文档说去哪清。
   * 0 = 关掉该条判据（只按另一条回收）。
   * 默认 200MB / 30 天：按**会话目录**整删，**当前会话的目录永不删**。
   */
  archiveMaxBytes: [0, 100 * 1024 * 1024 * 1024, 200 * 1024 * 1024],
  archiveMaxAgeDays: [0, 3650, 30],
}

/** 比例型字段：[最小, 最大, 兜底]。0 表示不按比例提醒。 */
export const RATIO_KEYS = {
  waterLevelRatio: [0, 0.95, 0.5],
  /**
   * 压缩兜底提醒的触发比例：压力 ≥ 窗口 × 该值、且本会话从未压缩过 → 提醒一次。
   * 0 = 关。默认 0.3，因为官方压缩要 0.8 才动手，很多会话到不了。
   */
  compactionFallbackRatio: [0, 0.95, 0.3],
}

/** 枚举型字段：[允许值, 兜底]。 */
export const ENUM_KEYS = {
  progressMode: [['observe', 'enforce'], 'observe'],
  idleAction: [['observe', 'notify'], 'notify'],
}

/** 字符串数组字段：[最大长度, 兜底]。 */
/**
 * 字符串 → 正整数 的映射型字段。用于"按工具覆盖阈值"这类配置。
 *
 * 归一化规则：键必须是字符串、值必须是正整数；不在范围内的值被丢弃（不夹紧），
 * 因为"把 grep 的阈值夹到 4000"和"没配 grep"是两件不同的事。
 * 最多 {0} 项 —— 见下方 MAP_KEYS 的 maxItems。
 */
export const MAP_KEYS = {
  /** 按工具覆盖归档阈值（字符）。没配的工具走 archiveThresholdChars。 */
  archiveThresholdByTool: [24, 1024, 4000000],
  /** 按工具覆盖摘要保留字符数。没配的工具走 archiveKeepChars。 */
  archiveKeepByTool: [24, 200, 200000],
}

export const LIST_KEYS = {
  waitTools: [8, ['wait_agent']],
  /**
   * 这些工具的输出**永不归档**。
   *
   * 旧版只在 archive.js 里读这个字段，配置层根本不认（不在 DEFAULT_CONFIG、
   * 没有归一化、设置页也没有入口）—— 于是它永远等于 undefined，等于没有这个能力。
   * 现在补进配置层，默认空（不排除任何工具）。
   */
  archiveExcludeTools: [24, []],
}

/**
 * 插件配置默认值。
 *
 * `cordis.patch.yml` 里那份 config 会被当成**默认值的覆盖**；
 * `$DSH_HOME/warden/settings.json`（设置页写的那份）再盖一层。
 */
export const DEFAULT_CONFIG = {
  /** 总开关。关掉后所有钩子都不挂，等于插件不存在。 */
  enabled: true,
  /** 当前档位。见 `PRESETS`。 */
  preset: 'balanced',
  ...PRESET_VALUES.balanced,
  /**
   * 忽略名单：本插件对这些路径**完全不介入**（不查锁、不发提醒、不记账）。
   *
   * ⚠ 注意这不是"给沙箱放行"的开关 —— 插件层没有权限去绕过文件系统级的
   * `cannot read` / `cannot modify`，那是系统层的事（见 README 的「系统层问题」）。
   * 这个名单解决的是另一件事：`node_modules/`、`.git/`、构建产物目录这类
   * "本来就会反复读写、提醒只会变成噪声"的地方，直接让护栏闭嘴。
   */
  archiveExcludeTools: [],
  pathIgnore: [],
  logLevel: 'info',
}

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}

/**
 * 归一化一份配置。
 *
 * 优先级：`input.preset` 的取值表 → `input` 里显式写的单项 → base 兜底。
 *
 * 为什么不信任输入：这份配置有三个来处（patch、settings.json、设置页的 POST），
 * 任何一个写坏了都不该让插件带着 NaN 或半个档位去跑。
 *
 * @param {Record<string, unknown>} raw 待归一化的配置
 * @param {typeof DEFAULT_CONFIG} base 类型不对时的兜底
 */
export function normalizeConfig(raw = {}, base = DEFAULT_CONFIG) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const preset = pickEnum(input.preset, new Set(PRESETS), base.preset ?? 'balanced')
  // `custom` 不提供取值表 —— 它的含义就是"以传进来的值为准"。
  // 只有调用方显式给了档位，才用档位表覆盖；否则保留 base 的逐项取值。
  // 旧写法无条件套 base.preset 的表：`setConfig({ enabled: false })` 这种不带
  // preset 的部分补丁，会把用户手改过的十几项静默重置回档位默认值（P1-10）。
  const presetGiven = typeof input.preset === 'string' && PRESETS.includes(input.preset)
  // `custom` 不提供取值表 —— 它的含义就是「以传进来的值为准」。
  const fromPreset = presetGiven && preset !== 'custom' ? (PRESET_VALUES[preset] ?? {}) : {}

  const out = { ...DEFAULT_CONFIG, ...base, ...fromPreset, preset }

  for (const key of BOOL_KEYS) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }
  for (const [key, [min, max, fallback]] of Object.entries(NUM_KEYS)) {
    out[key] = clampNumber(input[key] ?? out[key], min, max, fallback)
  }
  for (const [key, [min, max, fallback]] of Object.entries(RATIO_KEYS)) {
    const n = Number(input[key] ?? out[key])
    out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  for (const [key, [allowed, fallback]] of Object.entries(ENUM_KEYS)) {
    out[key] = pickEnum(input[key] ?? out[key], new Set(allowed), fallback)
  }
  for (const [key, [maxItems, min, max]] of Object.entries(MAP_KEYS)) {
    const value = input[key] ?? out[key]
    const clean = {}
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [rawKey, rawValue] of Object.entries(value)) {
        const toolName = String(rawKey ?? '').trim().toLowerCase()
        const n = Number(rawValue)
        if (!toolName || !Number.isFinite(n)) continue
        if (n < min || n > max) continue
        clean[toolName] = Math.round(n)
        if (Object.keys(clean).length >= maxItems) break
      }
    }
    out[key] = clean
  }

  for (const [key, [maxItems, fallback]] of Object.entries(LIST_KEYS)) {
    const value = input[key] ?? out[key]
    out[key] = Array.isArray(value)
      ? [...new Set(value.filter((v) => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim()))].slice(0, maxItems)
      : [...fallback]
  }

  // `archiveKeepChars` 必须明显小于阈值，否则"归档"根本没省下什么。
  if (out.archiveKeepChars * 2 > out.archiveThresholdChars) {
    out.archiveKeepChars = Math.max(200, Math.floor(out.archiveThresholdChars / 4))
  }

  // 路径数组：只接受字符串，去空、去重、限长。
  if (Array.isArray(input.pathIgnore)) {
    out.pathIgnore = [...new Set(
      input.pathIgnore
        .filter((p) => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim()),
    )].slice(0, 16)
  } else {
    out.pathIgnore = Array.isArray(out.pathIgnore) ? out.pathIgnore.slice(0, 16) : []
  }

  out.logLevel = pickEnum(input.logLevel, LOG_LEVELS, base.logLevel ?? 'info')
  return out
}

/** 只保留已知键，写盘前用一次，避免把临时字段写进 settings.json。 */
export function pickKnown(config) {
  const out = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) out[key] = config[key]
  return out
}

/**
 * DSH 家目录 —— 与宿主自己的 `@deepseek-ai/dsh-home-paths` 同一条规则：
 *   1. `DSH_HOME` 环境变量（有就用它）；
 *   2. 否则 `os.homedir()/.dsh`。
 *
 * ⚠️ 不要用 `DSH_PROFILE_DIR` 去推父目录。桌面版宿主是 Electron fork 出来的
 * 子进程，那个环境里**没有** `DSH_HOME`，从 profile 目录推会推到错误位置。
 */
const TILDE_SEPARATOR_CODES = [47, 92]
function expandHomePath(value) {
  if (value === '~') return homedir()
  if (value.charAt(0) === '~' && TILDE_SEPARATOR_CODES.indexOf(value.charCodeAt(1)) >= 0) { return join(homedir(), value.slice(2)) }
  return value
}

export function resolveDshHome() {
  const raw = process.env.DSH_HOME
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  // 纯空白等同于没设：旧版会把它当成一个「三空格」目录名，
  // 于是与宿主完全不是同一个 home。
  if (trimmed.length === 0) return join(homedir(), '.dsh')
  const expanded = expandHomePath(trimmed)
  // 绝对路径原样返回：宿主那侧也不改写绝对路径；这里若强行 resolve()，
  // Windows 上会把 /tmp/x 改写成盘符路径，反而与宿主不一致。
  return isAbsolute(expanded) ? expanded : resolve(expanded)
}

/** 本插件的数据位置。 */
export function pluginPaths(home = resolveDshHome()) {
  const dir = join(home, 'warden')
  return {
    dir,
    settings: join(dir, 'settings.json'),
    /** 共享资源锁。短生命周期，可以整体重写。 */
    locks: join(dir, 'locks.json'),
    /** 读数指纹台账：一行一条，追加式，永不覆盖。 */
    evidence: join(dir, 'evidence.jsonl'),
    /** 事件日志：护栏到底拦了什么、提醒了什么。 */
    events: join(dir, 'events.log'),
    /** 阶段合同：每个会话一条，记录目标/验收项/假设/新证据/下一步。 */
    stages: join(dir, 'stages.jsonl'),
    /** 大文本工具结果的归档根目录（下面按会话分子目录）。 */
    archive: join(dir, 'archive'),
  }
}

/** 某个会话的归档目录。 */
export function archiveDirFor(home, sessionId) {
  // 会话 id 直接来自宿主，但仍要洗一遍：它会变成真实目录名。
  const safe = String(sessionId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  return join(pluginPaths(home).archive, safe)
}

/**
 * 路径归一化：Windows 上大小写不敏感，分隔符统一成正斜杠。
 * 锁的"谁盖住谁"判定完全建立在它上面，所以两边必须走同一个函数。
 */
export function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  const path = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path
}

/** 判断 `target` 是否落在 `root` 之下（含自身）。两边都必须先归一化。 */
export function isUnder(target, root) {
  const t = normalizePath(target)
  const r = normalizePath(root)
  if (!t || !r) return false
  if (t === r) return true
  return t.startsWith(r.endsWith('/') ? r : `${r}/`)
}
