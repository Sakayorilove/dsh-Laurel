/**
 * laurel-memory · 宿主半边入口。
 *
 * 纪律（与套件其它模块一致）：
 *   1. 顶层 `inject` 留空：非 Web 组合（CLI / 无头）也能激活。
 *   2. 家目录只认 DSH_HOME → 否则 ~/.dsh（桌面版宿主没有 DSH_HOME，见 host-model.mjs 的 resolveDshHome）。
 *   3. 所有 IO 吞异常：记忆核心坏掉，不许连带影响宿主里别的东西。
 *   4. 不注册裸 HTTP 控制端点；管理动作走装载机的原生认证 RPC。
 *
 * 本文件只做接线：把模块能力组装起来，真正的逻辑在 lib/*.mjs（宿主无关）。
 */
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonical, sha256 } from '../../laurel-core/lib/format.mjs'
import { JOURNAL_VERSION } from '../../laurel-core/lib/journal.mjs'
import { openVault, initVault, vaultPaths } from '../../laurel-core/lib/vault.mjs'
import { systemTimeZone } from '../../laurel-core/lib/budget.mjs'
import { moduleState, projectIdentityOf, toolSurface, renderStablePrefix } from './adapter-dsh.mjs'
import { createCapture, executeMemoryQuery, resolveQueryScope } from './capture.mjs'
// MC11：经验学习面。`lib/experience/` 四个文件（lifecycle/method/guards/skill，约 32KB）
// 写好了、单测全绿，但**零业务调用方**：`makeExperience|promote(|recordOutcome` 在 lib 里
// 只有 lifecycle.mjs 自己出现，唯一写盘点是 cli.mjs 的 import-forge，
// 真仓 experience/ 目录至今不存在。这里把它接上采集流。
import { createExperiencePlane } from './experience/pipeline.mjs'
// laurel_context 的执行器住在 laurel-core（两包共用一份，不许复制）。
// 这里只负责接线：压缩块的读取逻辑属于压缩层，但依赖方向不允许
// laurel-memory → laurel-context，所以实现落在 laurel-core/lib/context-read.mjs。
import { executeContextQuery } from '../../laurel-core/lib/context-read.mjs'
import { createGateway, MODEL_SOURCES } from './gateway.mjs'
import { providerForSource } from '../../laurel-core/lib/providers.mjs'
import { mountReadOnly } from './host-data.js'
// 家目录解析**只有 host-model.mjs 这一份实现**（本文件原先自己又抄了一份，2026-10-23 收敛）。
// 为什么选它：它会 trim() —— 旧的遇到带前导空格或纯空白的 DSH_HOME（'  /x  '、'   '）
// 会原样返回畸形路径（Windows 上手抄路径带尾随空格很常见）；且 env / fallbackHome
// 可注入，单测不必改全局 process.env。三个调用点原本就零参，换过来一字不改。
//
// 2026-10-25：原来的 harness-model.mjs（自动发现本机网关 + 读密钥文件 + 从会话投影
// 猜当前模型）整体删除，换成 host-model.mjs —— 直接用宿主 llm 服务列出的供应商与模型。
// 理由写在 host-model.mjs 头注释里，一句话：设置页里能选的那些供应商就是宿主 llm 服务的
// 注册表，绕到外面的第三方网关去猜是多余的，而且那个网关在桌面 profile 里根本没起。
import { createHostProvider, hostDefaultSelection, listHostCatalog, probeHostSelection, resolveDshHome } from './host-model.mjs'
import { createSettingsHandler, mountSettings } from './settings-api.js'
// MC13：管理面动作（今天/查/读原文/更正/撤销/经验采纳与验证/打包/恢复/清理）。
// 以前这条通道只有模型来源与档位两个字段 —— 数据全在仓里，但想走完「看到一条
// 记错的东西 → 更正它」这串动作只能去敲 CLI。这里把动作做成枚举交给设置端点。
import { ADMIN_ACTIONS, createAdminActions } from './admin-api.mjs'
// L03：自动注入的真实落点。renderPrefix 从此有了消费者，不再是一条死路。
import { createInjector, INJECT_SOURCE_KIND } from './inject.mjs'
// L11：容量治理的调度方（retention.mjs 在 laurel-core 里早就写完了，但没人调它）
import { createRetentionPlane } from './retention-plane.mjs'

export const name = 'laurel-memory'
export const inject = []

const PACKAGE_NAME = 'laurel-memory'
const VERSION = '0.1.0'

function makeLogger(level = 'info') {
  const rank = { debug: 10, info: 20, warn: 30, error: 40 }
  const min = rank[level] ?? 20
  const make = (n, fn) => (...args) => {
    if ((rank[n] ?? 20) < min) return
    try { fn('[laurel-memory]', ...args) } catch { /* 日志不影响主流程 */ }
  }
  return { debug: make('debug', console.debug.bind(console)), info: make('info', console.info.bind(console)), warn: make('warn', console.warn.bind(console)), error: make('error', console.error.bind(console)) }
}

/**
 * 解析核心仓路径。显式配置优先，其次 `$DSH_HOME/laurel-core`（含 `~/.dsh` 兜底）。
 *
 * `~/.dsh` 兜底是 D47 的教训：桌面版宿主的插件跑在 Electron 子进程里，**那个环境
 * 没有 DSH_HOME**，只认环境变量的旧实现会拿不到就返回 null → 入口 `enabled:false`，
 * 界面上一直显示「读取失败」而宿主侧一切正常。该规矩现在由 `host-model.mjs` 的
 * `resolveDshHome` 承担（本文件不再自带一份）。
 */
function resolveVaultDir(config = {}) {
  if (config.vaultDir) return config.vaultDir
  const home = resolveDshHome()
  if (!home) return null
  return join(home, 'laurel-core')
}

/** 设置页读的端点前缀。与客户端 `lib/client/index.mjs` 的 DATA_API 必须一致。 */
const DATA_PATH = '/laurel-memory'

/**
 * 设置页**写**的端点前缀。
 *
 * 为什么是 `/api/` 开头而不是 `DATA_PATH` 加个 POST：宿主的 webServer 是
 * 「最长前缀优先」，`/api` 后面本来有 connection 服务的 admission 把关；
 * 我们把写通道挂成更长的 `/api/laurel-memory` 后，必须在 handler 里自己跑
 * 同一道栅栏（lib/settings-api.js）。读端点保持无副作用、无鉴权，因为它
 * 只吐「你自己的档位」，而写会改运行时行为。
 */
const SETTINGS_PATH = '/api/laurel-memory'

/**
 * `laurel_context` 工具返回正文的字符上限（S1）。
 *
 * 为什么不复用 INJECT_BUDGET（300/600/1200）：那个预算是**自动注入**给每轮
 * prompt 的上限，属于"顺手塞进去"的量级。这里是模型**主动调用**一次工具、
 * 要读回一段被外置的原文分页 —— 用注入预算会把回读掐成一句话，工具就失去
 * 意义了。原文分页默认 40 行、上限 400 行，这个上限只防极端大段。
 */
const CONTEXT_TOOL_MAX_CHARS = 8000

/** 三档的唯一真源：网关的 TIER_LIMITS 只有这三个键，写别的一律拒绝。 */
const TIER_LABELS = Object.freeze({ zero: '零推理', balanced: '均衡', full: '全面' })

/**
 * 只读端点读 journal 链尾时最多看多少字节。
 *
 * ── 为什么不整读（P2-8 的成本约束）────────────────────────────────────────
 * `/laurel-memory` 是设置页高频轮询的端点，`readJournal()` 会把整个
 * journal.jsonl 读进来并逐行校验（那是**写入链路**要的严格性，不是状态查询
 * 要的）。真机上 journal 已经到几百上千行，整读+全链 sha256 校验放在每次
 * 轮询里是纯浪费。状态只需要一个数：链尾 seq。
 *
 * 一条单元实测约 412–483 字节（真机 1267 条 journal 的分布），8KB 足够覆盖
 * 最后十几到二十条，尾部半条日志（进程被杀留下的）也在窗口里。窗口装不下时
 * 按 4 倍翻倍重试，上限 `JOURNAL_TAIL_MAX_BYTES` —— 绝不因为"单条特别大"
 * 就悄悄退化回内存值。
 */
const JOURNAL_TAIL_BYTES = 8 * 1024

/** 翻倍重试的硬上限。到了还找不到完整单元，就老实报错（快照回落内存值）。 */
const JOURNAL_TAIL_MAX_BYTES = 1024 * 1024

/**
 * 校验一行是否为**完整**的 journal 单元。
 *
 * 复刻 `laurel-core/lib/journal.mjs` 的 `lineHash()`（那里没导出）：
 * `sha256(canonical(去掉 hash 的整个单元))`。意义在于——只认哈希自洽的行，
 * 才敢说"这是最后一条已提交的单元"，而不是"文件里最后一行长得像 JSON"。
 */
function parseTailUnit(line) {
  if (typeof line !== 'string' || !line.trim()) return null
  let unit
  try { unit = JSON.parse(line) } catch { return null }
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return null
  if (unit.v !== JOURNAL_VERSION) return null
  if (!Number.isInteger(unit.seq) || unit.seq < 1) return null
  const { hash, ...rest } = unit
  if (typeof hash !== 'string' || hash.length === 0) return null
  return hash === sha256(canonical(rest)) ? unit : null
}

/**
 * 读磁盘链尾的 seq（P2-8）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────
 * `state.vault.lastSeq` 只在**本进程** commit 时前进
 * （`laurel-core/lib/vault.mjs` 的 `commit()`）。另一个进程（`laurel-memory add`
 * 这类 CLI）追加后，内存值原地不动，端点就会滞后。审计实测 lag=1；今天真机上
 * 「端点与磁盘一致」只因为本进程是唯一写入者 —— 那是运气，不是保证。
 *
 * ── 成本 ─────────────────────────────────────────────────────────────────
 * 每次调用只做一次 `statSync`；`(size, mtimeMs)` 没变就直接返回缓存值
 * （高频轮询的常态）。变了才 `readSync` 最后 `JOURNAL_TAIL_BYTES` 字节。
 * 只读端点因此不会随 journal 增长而变慢。
 *
 * ── 诚实性 ───────────────────────────────────────────────────────────────
 * 返回值带 `readAt`（这个 seq 是什么时候从磁盘读到的）与 `cached`，
 * 由快照写进 `journalSeqMeta`。调用方永远能区分"刚从磁盘读的"和
 * "几毫秒前读的缓存"。
 *
 * @param {string} vaultDir
 * @param {{size:number, mtimeMs:number, seq:number|null, at:number, bytes:number}} cache 复用同一对象
 * @returns {{ok:boolean, seq:number|null, readAt:number, cached:boolean, bytes:number, torn:boolean, error:string|null}}
 */
function readJournalTail(vaultDir, cache) {
  const now = Date.now()
  const fail = (error) => ({ ok: false, seq: null, readAt: now, cached: false, bytes: 0, torn: false, error })
  if (typeof vaultDir !== 'string' || vaultDir.length === 0) return fail('no-vault-dir')
  let journalPath
  try { journalPath = vaultPaths(vaultDir).journal } catch (e) { return fail(String(e?.message ?? e)) }
  let st
  try {
    st = statSync(journalPath)
  } catch (e) {
    // 还没写过任何东西：这不是错误，是"空链"
    if (e && e.code === 'ENOENT') return { ok: true, seq: 0, readAt: now, cached: false, bytes: 0, torn: false, error: null }
    return fail(String(e?.message ?? e))
  }
  if (!st.isFile()) return fail('not-a-file')
  if (cache.seq !== null && cache.size === st.size && cache.mtimeMs === st.mtimeMs) {
    // 命中缓存：readAt 报**当初真的读盘**的时刻，不是现在 —— 否则就是撒谎
    return { ok: true, seq: cache.seq, readAt: cache.at, cached: true, bytes: cache.bytes, torn: false, error: null }
  }
  if (st.size === 0) {
    cache.size = 0; cache.mtimeMs = st.mtimeMs; cache.seq = 0; cache.at = now; cache.bytes = 0
    return { ok: true, seq: 0, readAt: now, cached: false, bytes: 0, torn: false, error: null }
  }
  // 窗口不够就翻倍重试：单条单元偶尔会很大（一条 capture 带整段正文/附件摘要），
  // 8KB 装不下它时，窗口里全是"半行"，会误判成 tail-empty 而静默退化成内存值 ——
  // 那等于悄悄把 P2-8 退回去。翻倍一路上限到 JOURNAL_TAIL_MAX_BYTES 或整个文件。
  let len = Math.min(st.size, JOURNAL_TAIL_BYTES)
  let totalBytes = 0
  for (;;) {
    const start = st.size - len
    const buf = Buffer.allocUnsafe(len)
    let fd = null
    try {
      fd = openSync(journalPath, 'r')
      let off = 0
      while (off < len) {
        const n = readSync(fd, buf, off, len - off, start + off)
        if (n <= 0) break
        off += n
      }
      if (off !== len) return fail('short-read')
    } catch (e) {
      return fail(String(e?.message ?? e))
    } finally {
      if (fd !== null) { try { closeSync(fd) } catch { /* 已关 */ } }
    }
    totalBytes += len

    const lines = buf.toString('utf8').split('\n')
    // start>0 时首段是被窗口切断的半行（也可能是多字节字符被劈开），不能当整行解析
    const firstWhole = start > 0 ? 1 : 0
    let found = null
    let torn = false
    let sawBad = false
    for (let i = lines.length - 1; i >= firstWhole; i--) {
      const line = lines[i]
      if (!line.trim()) continue
      const unit = parseTailUnit(line)
      if (unit) { found = unit; break }
      // 尾部有坏行时只记一笔，继续往前找最后一条**已提交**的单元
      if (!sawBad) { torn = true; sawBad = true }
    }
    if (found) {
      cache.size = st.size; cache.mtimeMs = st.mtimeMs; cache.seq = found.seq; cache.at = now; cache.bytes = totalBytes
      return { ok: true, seq: found.seq, readAt: now, cached: false, bytes: totalBytes, torn, error: null }
    }
    // 已经读到文件开头（或到上限）还没找到 -> 放弃，别无限翻倍
    if (start === 0 || len >= st.size || len >= JOURNAL_TAIL_MAX_BYTES) {
      return fail(torn ? 'tail-unparsed' : 'tail-empty')
    }
    len = Math.min(st.size, len * 4)
  }
}

/** 安全取服务：cordis 的 Context 是受控代理，没 inject 的服务直接访问会抛。 */
function getService(ctx, name) {
  try {
    return ctx.get?.(name) ?? null
  } catch {
    return null
  }
}

export function apply(ctx, config = {}) {
  const log = makeLogger(config.logLevel)
  const state = {
    enabled: true,
    tier: config.tier ?? 'zero',
    modelSource: config.modelSource ?? 'none',
    modelBaseUrl: config.baseUrl ?? null,
    // 宿主供应商 + 模型（modelSource='api' 且没手填 baseUrl 时用这一对）。
    // 这是 2026-10-25 之后第三条来源的全部内容 —— 不再是「地址 + 密钥 + 猜模型」。
    modelProvider: typeof config.provider === 'string' && config.provider ? config.provider : null,
    modelName: typeof config.model === 'string' && config.model ? config.model : null,
    vaultDir: null,
    vault: null,
    error: null,
  }

  try {
    const dir = resolveVaultDir(config)
    if (!dir) {
      state.enabled = false
      state.error = '找不到核心仓路径（DSH_HOME 未设置且未显式配置 vaultDir）'
      log.warn(state.error)
    } else {
      state.vaultDir = dir
      try {
        state.vault = openVault(dir)
      } catch (e) {
        // 仓不存在时建一个；存在但损坏时不覆盖，明确报错
        if (/不是核心仓/.test(String(e.message))) {
          state.vault = initVault(dir, { coreId: config.coreId ?? 'core-default' })
        } else {
          state.error = `核心仓读取失败（不覆盖）：${e.message}`
          state.enabled = false
          log.error(state.error)
        }
      }
    }
  } catch (e) {
    state.enabled = false
    state.error = String(e?.message ?? e)
    log.error('初始化失败', state.error)
  }

  // 模型网关：把 tier / modelSource / timeZone 真正接进来。
  // 此前 gateway.mjs 写好了但宿主入口从没实例化它，
  // 于是"三档 + 三来源"在宿主侧等于没接 —— 配置能写、代码没读。
  //
  // ── 三模式运行时切换（2026-10-21 D143；2026-10-25 改 api 的含义）────────
  // 三种来源：
  //   none   0 模型：0 次调用，本地记录/检索照常
  //   local  本地模型：地址由用户给（例：Ollama 默认的 11434）
  //   api    **宿主模型**：用宿主 llm 服务里注册的那些供应商，在设置页选一个
  //          供应商 + 一个模型即可。不填地址、不填密钥、不猜「宿主正在用哪个」：
  //          供应商目录来自 llm.listProviders()，模型目录来自 llm.listModels()，
  //          请求走 llm.stream()（宿主官方唯一的模型调用通道）。
  //          **不再使用** D143 那套 harness 网关发现（网关端口 / api-key 文件 /
  //          会话投影 lastUsed）—— 那个网关是第三方插件提供的，桌面 profile 里
  //          根本没起，面板于是长期显示「harness 网关现在不可用」。
  //          旧模式文件里 api + 手填 baseUrl 的组合保留读入（route kind='external'），
  //          但面板会提示「选一个宿主模型并应用即可切回」。
  //
  // 为什么写模块自有文件，而不是改宿主 profile 的 cordis.patch.yml：
  //   1. 写 profile patch 要 recomposition 才生效，桌面 profile 是用户正在
  //      使用的输入，插件不该在运行时替用户改它；
  //   2. 切换只是本模块的运行时选择，落在核心仓自己的目录里最合适。
  // 文件：<vaultDir>/.laurel-mode.json，内容 { modelSource, tier, baseUrl, provider, model }。
  // 密钥**不落盘**：宿主模型的凭据由宿主自己的 adapter 管，我们连看都看不到。
  const MODE_FILE = '.laurel-mode.json'

  const readModeOverride = () => {
    if (!state.vaultDir) return null
    try {
      const parsed = JSON.parse(readFileSync(join(state.vaultDir, MODE_FILE), 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch { return null }
  }

  const writeModeOverride = (value) => {
    if (!state.vaultDir) return false
    try {
      writeFileSync(join(state.vaultDir, MODE_FILE), JSON.stringify(value, null, 2) + '\n', 'utf8')
      return true
    } catch (e) {
      log.warn('模式文件写入失败（本次仍生效，重启后回退）', String(e?.message ?? e))
      return false
    }
  }

  /**
   * 模式切换留痕：把「谁在这个会改变行为的持久状态上动了手」写进 audit 通道。
   *
   * ── 为什么必须有这一条（T5a，2026-10-23）──────────────────────────────
   * modelSource / tier 是**会改变运行时行为的持久状态**：none = 0 次模型调用、
   * local = 打外部端点、api = 走宿主 llm 服务；档位决定每日请求预算。它们在
   * `<vaultDir>/.laurel-mode.json` 里跨重启存活，但此前**零留痕** ——
   * 实测整个 laurel-memory 包里 `appendAudit` / `.audit(` 零命中，
   * 真仓 audit/ 目录存在但 0 文件。于是事后没法回答「这个仓什么时候被谁从
   * 哪个模式切到哪个模式」，只能靠猜。
   *
   * ── 三条纪律（写在这里，因为最容易在后续改动里被破）───────────────────
   *  1. **只记枚举与布尔**：modelSource / tier / baseUrlConfigured。
   *     **绝不记 baseUrl 本身** —— 外部端点地址里可能带凭据、内网主机名，
   *     审计文件是最不该出现它们的落点。要表达「配没配」就记一个布尔。
   *  2. **走 audit 通道，不走 vault.commit**：模式文件不是 journal 权威数据，
   *     它只是本模块自己的运行时选择。塞进 commit 会把配置噪音混进
   *     「权威变更流」，让 journal 的语义（可回溯的业务事实）失真。
   *  3. **失败绝不抛**：到这里切换已经生效（gateway 已重建），审计写不进去
   *     只该少一条回执，不该把一次成功的切换变成失败。
   *
   * 注：`vault.audit(entry)` 的真实签名是 laurel-core 的 appendAudit
   * （vault.mjs:273-276）：`{ at: nowIso(), ...entry }` —— 时间戳由它统一打，
   * 调用方传的字段可以覆盖。所以这里**不自己造时间**，免得两份时钟。
   *
   * @returns {boolean} 是否真的落了一条审计（无仓/无该方法时为 false）
   */
  const auditModeWrite = ({ modelSource, tier, baseUrl, provider, model, persisted, prevModelSource, prevTier }) => {
    const vault = state.vault
    if (!vault || typeof vault.audit !== 'function') return false
    try {
      vault.audit({
        op: 'mode.write',
        modelSource,
        tier,
        prevModelSource: prevModelSource ?? null,
        prevTier: prevTier ?? null,
        // 宿主供应商与模型 id 不是秘密（它们就写在设置页里），
        // 事后要能回答「这个仓什么时候换成了哪个模型」，所以记下来。
        provider: provider ?? null,
        model: model ?? null,
        // 端点地址相反：只记布尔，不记地址本身（可能带凭据、内网主机名）
        baseUrlConfigured: typeof baseUrl === 'string' && baseUrl.length > 0,
        persisted,
      })
      return true
    } catch (e) {
      log.warn('模式切换审计写入失败（切换本身已生效）', String(e?.message ?? e))
      return false
    }
  }

  // 启动期：模块自有文件优先于宿主 config —— 否则切换一重启就丢
  {
    const saved = readModeOverride()
    if (saved && MODEL_SOURCES.includes(saved.modelSource)) state.modelSource = saved.modelSource
    if (saved && typeof saved.baseUrl === 'string' && saved.baseUrl) state.modelBaseUrl = saved.baseUrl
    // 宿主供应商 + 模型：用户在设置页选过哪个，重启后还是那个
    if (saved && typeof saved.provider === 'string' && saved.provider) state.modelProvider = saved.provider
    if (saved && typeof saved.model === 'string' && saved.model) state.modelName = saved.model
    // 档位也要跟着回来：TIER_LIMITS 在建网关时定死，档位丢了等于预算被重置
    if (saved && Object.prototype.hasOwnProperty.call(TIER_LABELS, saved.tier)) state.tier = saved.tier
  }

  let gateway = null
  let gatewayError = null
  let routeEpoch = 0
  let routeDisposed = false
  let routeBinding = { state: 'unbound', error: null, inferenceVerified: false }
  let llmContext = ctx

  // 配置中的供应商 id 不是 provider 实例；启动绑定只核对元数据，不调用模型。
  const buildGateway = (overrideProvider = null, tier = state.tier) => {
    const explicitProvider = typeof config.provider?.complete === 'function' ? config.provider : null
    const provider = overrideProvider ?? explicitProvider
    return createGateway({
      vaultDir: state.vaultDir ?? '',
      tier,
      source: state.modelSource,
      timeZone: config.timeZone ?? systemTimeZone(),
      provider,
    })
  }

  try {
    gateway = buildGateway()
  } catch (e) {
    gatewayError = String(e?.message ?? e)
    log.warn('模型网关初始化失败（不影响本地记录/检索）', gatewayError)
  }
  state.gateway = gateway

  // ── 来源解析：把「一个名字」变成「一个能真的调用的 provider」──────────
  // 三条路都要在切换**之前**证明能用，否则就是假成功。
  /** 当前生效的宿主模型 provider（切换成功后留下，供设置页显示「正在用哪个模型」）。 */
  let hostProviderRef = null

  /**
   * 宿主 llm 服务：**每次现取**。
   *
   * 为什么不在 apply 里存一份：宿主里 llm 服务晚于插件装配才就绪是常态，
   * 同步取一次拿到 null 就再也接不上了（S1 的 tools 服务踩过同一个坑）。
   * 另外它属于**可选**服务，只能 ctx.get，不能写进顶层 inject —— 写了 inject
   * 就等于「没有 llm 服务的组合（CLI / 无头）不装载本插件」。
   */
  const getLlm = () => getService(llmContext, 'llm')

  const resolveProviderFor = async (action, { baseUrl = null, apiKey = null, provider = null, model = null } = {}) => {
    if (action === 'none') return { ok: true, provider: null }

    if (action === 'local') {
      const url = baseUrl ?? state.modelBaseUrl ?? null
      const localModel = config.model ?? config.modelName ?? null
      if (!url) {
        return { ok: false, error: '切到 local 需要端点地址。例：/laurel-mode local http://127.0.0.1:11434/v1' }
      }
      if (!localModel) return { ok: false, error: '切到 local 需要模型名：请在模块配置里填 model' }
      try {
        return { ok: true, provider: providerForSource({ source: 'local', baseUrl: url, model: localModel, apiKey }) }
      } catch (e) {
        return { ok: false, error: `端点参数不合法：${String(e?.message ?? e)}` }
      }
    }

    // api + 显式地址 → 外部 OpenAI 兼容端点（旧行为，只为读得懂历史 .laurel-mode.json）。
    // 面板不再提供这条路的入口：它要求用户抄地址和密钥，正是用户要求去掉的那种复杂。
    //
    // 显式选了 (供应商, 模型) 时**优先走宿主模型**：用户在面板里点了「应用」，
    // 意图很明确，不能让 mode 文件里遗留的一行 baseUrl 把它劫持成外部端点。
    if (baseUrl && !(provider && model)) {
      if (!config.model) return { ok: false, error: '切到外部 API 需要模型名：请在模块配置里填 model' }
      try {
        return {
          ok: true,
          provider: providerForSource({ source: 'api', baseUrl, model: config.model, apiKey: apiKey ?? config.apiKey }),
          host: null,
        }
      } catch (e) {
        return { ok: false, error: `端点参数不合法：${String(e?.message ?? e)}` }
      }
    }

    // api（默认形状）：宿主 llm 服务里的 (供应商, 模型)。
    // 两者都没给时回落到「上次选的」——只切档位不该把模型选择丢掉。
    const wantedProvider = provider ?? state.modelProvider ?? null
    const wantedModel = model ?? state.modelName ?? null
    if (!wantedProvider || !wantedModel) {
      return { ok: false, error: '切到宿主模型需要先选供应商和模型（设置页「模型来源 → 宿主模型」）' }
    }
    // 探活不发补全请求：只查 provider 在不在注册表、模型能不能解析。
    // 旧实现在这里真 ping 一次模型 —— 换一次下拉框就是一次计费调用，不能这么干。
    const probed = await probeHostSelection(getLlm, { provider: wantedProvider, model: wantedModel })
    if (!probed.ok) return { ok: false, error: `宿主模型不可用：${probed.reason}` }
    const hostProvider = createHostProvider({ getLlm, provider: wantedProvider, model: wantedModel, log })
    return { ok: true, provider: hostProvider, host: { ...probed, ok: true } }
  }

  /**
   * 切模式 / 切档位。命令与设置页写通道**共用这一份**，避免两处行为漂移。
   *
   * @returns {Promise<{ok: boolean, error?: string, persisted?: boolean, audited?: boolean, host?: object|null}>}
   */
  const switchMode = async ({ modelSource, tier, baseUrl, apiKey, provider, model } = {}) => {
    routeEpoch++
    const nextSource = modelSource ?? state.modelSource
    const nextTier = Object.prototype.hasOwnProperty.call(TIER_LABELS, tier) ? tier : state.tier
    if (!MODEL_SOURCES.includes(nextSource)) {
      return { ok: false, error: `未知模式：${nextSource}。可选 ${MODEL_SOURCES.join(' / ')}` }
    }
    if (nextTier === 'zero' && nextSource !== 'none') {
      // 零推理档下网关本身不会发起调用（TIER_LIMITS.zero.maxRequestsPerDay = 0），
      // 允许这种组合，但要让调用方知道"开了也不会花钱"。
    }

    // 只切档位时（baseUrl 未传）要沿用**当前生效的地址**，否则会从
    // 「外部端点」被悄悄换成「宿主模型」—— 用户只改了档位却换了模型源。
    const effectiveBaseUrl = baseUrl !== undefined ? baseUrl : state.modelBaseUrl
    const resolved = await resolveProviderFor(nextSource, { baseUrl: effectiveBaseUrl, apiKey, provider, model })
    if (!resolved.ok) return { ok: false, error: resolved.error }

    // 探测：宿主 llm 里的 (供应商, 模型) 不通就不切，绝不制造
    // 「status 说 enabled、真调用却报 NO_ADAPTER」。
    // 注意这一探**不发补全请求**（见 host-model.mjs 的 probeHostSelection）。
    if (resolved.provider && typeof resolved.provider.probe === 'function') {
      const probe = await resolved.provider.probe({ timeoutMs: 5000 })
      if (!probe || probe.ok !== true) {
        return { ok: false, error: `宿主模型不可用，未切换（仍是 ${state.modelSource}）：${probe?.reason ?? probe?.error ?? '探测失败'}` }
      }
    }

    const prev = {
      source: state.modelSource, baseUrl: state.modelBaseUrl, tier: state.tier, key: config.apiKey,
      provider: state.modelProvider, model: state.modelName,
    }
    state.modelSource = nextSource
    state.tier = nextTier
    // baseUrl 显式给 null = 清掉手填地址（回到宿主模型）；
    // 没给这一项（undefined）就不动它 —— 只切档位时不该把地址抹掉。
    if (baseUrl !== undefined) state.modelBaseUrl = baseUrl
    // provider/model 同理：显式给了才改，只切档位时保留上次选的
    if (typeof provider === 'string' && provider) state.modelProvider = provider
    if (typeof model === 'string' && model) state.modelName = model
    if (apiKey) config.apiKey = apiKey // 只进内存，绝不写盘

    let next = null
    try {
      next = buildGateway(resolved.provider, nextTier)
    } catch (e) {
      state.modelSource = prev.source
      state.modelBaseUrl = prev.baseUrl
      state.tier = prev.tier
      state.modelProvider = prev.provider
      state.modelName = prev.model
      config.apiKey = prev.key
      return { ok: false, error: `切换失败，已回退到 ${prev.source}/${prev.tier}：${String(e?.message ?? e)}` }
    }
    gateway = next
    state.gateway = next
    hostProviderRef = resolved.host ? resolved.provider : null
    routeBinding = { state: resolved.provider ? 'bound' : 'disabled', error: null, inferenceVerified: false }
    const persisted = writeModeOverride({
      modelSource: state.modelSource,
      tier: state.tier,
      baseUrl: state.modelBaseUrl ?? null,
      provider: state.modelProvider ?? null,
      model: state.modelName ?? null,
    })
    // T5a：切换成功之后落一条审计回执。放在 writeModeOverride **之后**，
    // 是为了让 persisted 这个事实本身也进回执 —— 「切了但没存下来」和
    // 「切了也存下来了」在事后排查时是完全不同的两种现场。
    // 注意传的是 state.modelBaseUrl（现在生效的值），不是方法入参 baseUrl：
    // 只切档位时入参是 undefined，但生效地址可能仍是老那个。
    const audited = auditModeWrite({
      modelSource: state.modelSource,
      tier: state.tier,
      baseUrl: state.modelBaseUrl ?? null,
      provider: state.modelProvider ?? null,
      model: state.modelName ?? null,
      persisted,
      prevModelSource: prev.source,
      prevTier: prev.tier,
    })
    return { ok: true, persisted, audited, host: resolved.host ?? null }
  }

  // ── /laurel-mode：三模式切换（命令通路）────────────────────────────────
  // 设置页从 D143 起也能写（见下面的 SETTINGS_PATH），命令保留是因为：
  //   - 无头 / CLI 组合没有设置页，命令是唯一入口；
  //   - 脚本化验证要一条命令就能切，不必造 HTTP 客户端。
  // 两条通路都走同一个 `switchMode`，行为不会漂。
  const describeMode = () => {
    if (state.modelSource === 'api' && !state.modelBaseUrl) {
      const pair = state.modelProvider && state.modelName
        ? `${state.modelProvider}/${state.modelName}`
        : '(还没选供应商与模型)'
      return `api（宿主模型 ${pair}）`
    }
    const url = state.modelBaseUrl ? `（${state.modelBaseUrl}）` : ''
    return `${state.modelSource}${url}`
  }

  const registerModeCommand = (routeCtx) => {
    const commands = getService(routeCtx, 'commands')
    if (!commands || typeof commands.register !== 'function') return
    commands.register({
      name: 'laurel-mode',
      description: 'Laurel 记忆模块的模型来源与档位：none=0 模型 / local=本地端点 / api=宿主模型（宿主 llm 服务里的供应商+模型）',
      input: { hint: 'status | none | local <baseUrl> | api [provider model] | providers | tier zero|balanced|full' },
      async handler(invocation) {
        const args = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const action = args[0] ?? 'status'
        const head = () => `当前：来源 ${describeMode()}，档位 ${TIER_LABELS[state.tier] ?? state.tier}`

        if (action === 'status') {
          return {
            kind: 'success',
            text: [
              head(),
              '可选：none（0 模型、0 次调用）| local（本地端点，需给地址）| api（宿主模型，选供应商与模型）',
              '例：/laurel-mode local http://127.0.0.1:11434/v1',
              '例：/laurel-mode api deepseek-official deepseek-v4.1-flash',
              '例：/laurel-mode providers（列出宿主里能选的供应商与模型）',
              '例：/laurel-mode tier balanced',
            ].join('\n'),
          }
        }

        // 命令通路也要能看见「有哪些可选的供应商与模型」：
        // 无头 / CLI 组合没有设置页，光有 api 这个字而不给目录等于让人猜。
        if (action === 'providers' || action === 'models') {
          const catalog = await listHostCatalog(getLlm)
          if (!catalog.ok) return { kind: 'error', text: `读不到宿主供应商目录：${catalog.reason}` }
          const lines = catalog.providers.map((row) => {
            const names = row.models.length > 0
              ? row.models.map((m) => m.id).join(', ')
              : `(没有公布模型目录${row.modelsError ? `：${row.modelsError}` : ''}；可直接给模型 id)`
            return `${row.id}（${row.name}）：${names}`
          })
          const def = hostDefaultSelection(ctx)
          return {
            kind: 'success',
            text: [
              head(),
              ...lines,
              def.ok ? `宿主默认模型：${def.provider}/${def.model}` : `宿主默认模型：${def.reason ?? '未知'}`,
              '切换：/laurel-mode api <provider> <model>',
            ].join('\n'),
          }
        }

        if (action === 'tier') {
          const wanted = args[1]
          if (!Object.prototype.hasOwnProperty.call(TIER_LABELS, wanted)) {
            return { kind: 'error', text: `未知档位：${wanted ?? '(空)'}。可选 zero / balanced / full` }
          }
          const result = await switchMode({ tier: wanted })
          if (!result.ok) return { kind: 'error', text: result.error }
          return { kind: 'success', text: `已切档位。${head()}` }
        }

        if (!MODEL_SOURCES.includes(action)) {
          return { kind: 'error', text: `未知模式：${action}。可选 none / local / api（或 tier <zero|balanced|full>）` }
        }

        // api 有两种写法：
        //   /laurel-mode api                         沿用上次选的供应商与模型
        //   /laurel-mode api <provider> <model>      显式指定宿主供应商与模型
        // 历史写法 /laurel-mode api <baseUrl> [apiKey] 仍然认（地址里一定带 ://），
        // 但那是「外部端点」，面板已经不再提供入口。
        const firstArg = args[1] ?? null
        const isEndpoint = typeof firstArg === 'string' && firstArg.includes('://')
        const result = await switchMode(
          action === 'api' && !isEndpoint
            ? { modelSource: action, baseUrl: null, provider: args[1] ?? null, model: args[2] ?? null }
            : { modelSource: action, baseUrl: firstArg, apiKey: args[2] ?? null },
        )
        if (!result.ok) {
          return { kind: 'error', text: `${result.error}\n（未切换，仍是 ${state.modelSource}/${state.tier}）` }
        }
        const tail = result.persisted ? '' : '\n（模式文件没写成：本次生效，重启会回退）'
        const hostLine = result.host?.model
          ? `\n宿主模型：${result.host.provider}/${result.host.model}${result.host.modelName && result.host.modelName !== result.host.model ? `（${result.host.modelName}）` : ''}`
          : ''
        return { kind: 'success', text: `已切换。${head()}${hostLine}\n供应商与模型已校验（未发任何补全请求）。${tail}` }
      },
    })
  }
  // 直接取、不用 ctx.inject：宿主里 commands 在插件 apply 时已就绪
  // （同套件其他模块同样做法）。多一条 inject 会改动数据面订阅契约
  // （host-snapshot.test 断言 injections 恰为 [['webServer']]），不值当。
  try {
    registerModeCommand(ctx)
  } catch (e) {
    log.warn('命令注册失败（不影响其余功能）', String(e?.message ?? e))
  }

  // ── 数据面挂载标志（P2-7）────────────────────────────────────────────────
  // 必须在 `readOnlySnapshot` **之前**声明：`ctx.provide()` 就在紧接着的几行
  // 发生，消费者完全可以在 provide 回调里同步调 `state()`。那时 apply 还没返回，
  // 若把 `let dataPlaneMounted` 留到下面「只读数据面」那段（原位置在 260 行之后），
  // 快照读到的是 `let` 的 TDZ 区，抛
  // `ReferenceError: Cannot access 'dataPlaneMounted' before initialization`。
  // 别用 `var` 提升糊过去 —— 那只是把异常换成静默的 undefined。
  let dataPlaneMounted = false
  // 写通道（/api/laurel-memory）是否挂上：设置页据此决定"能不能点"。
  // 与读通道分开报，是因为两者可以只有一个成功（例如没有 connection 服务的组合）。
  let settingsPlaneMounted = false

  // 工具注射状态（S1）：降级必须**看得见**。
  // 之前拿不到 tools 只 log.warn 一句，界面和端点都显示得跟成功一样，
  // 于是"模型看不见记忆"这件事被埋了一个月。现在把结果写进只读快照。
  const toolPlane = {
    // 'pending' 注入回调还没回来；'ok' 至少注册上一个；'unavailable' 宿主没有 tools 服务
    state: 'pending',
    registered: [],
    failed: [],
    reason: null,
    at: null,
  }

  // 自动注入状态（L03）：从前 `renderPrefix` 零消费者，「自动提示」在代码里
  // 存在、实际一条 note 都没进过请求。这里把「挂上了没有 / 上一轮为什么没注入」
  // 写进只读快照 —— 否则它和 S1 之前的工具注射一样，只在日志里留一行就消失。
  const injectPlane = {
    state: 'pending',
    mounted: false,
    reason: null,
    at: null,
    channel: null,
    sourceKind: INJECT_SOURCE_KIND,
  }
  let injector = null
  let capture = null

  // 容量治理状态（L11）：模块在、调度不在 —— 真仓两周长到 274MB 也没人问过
  // 「这些 blob 还有人引用吗」。这里把「跑没跑过 / 上次回收多少 / 下次什么时候」
  // 写进只读快照：一个没有心跳的定时器，和没接上完全一样。
  let retention = null
  // MC11：经验学习面。与 toolPlane / injectPlane / retentionPlane 同样必须在
  // readOnlySnapshot 之前声明（TDZ，陷阱 10 同族）。
  let experiencePlane = null

  // 磁盘链尾读的缓存：只用来省掉「文件没变」时的重复读，不参与正确性判断。
  // 键是 (size, mtimeMs) —— journal 只追加，两者任一变化都说明有新的提交。
  const journalSeqCache = { size: -1, mtimeMs: -1, seq: null, at: 0, bytes: 0 }

  /**
   * 现在这条来源**到底是哪一种** —— 面板据此决定画哪种输入。
   *
   * 三种（加上两个非 api 的）：
   *   none        不接模型
   *   local       本地端点（要地址）
   *   external    api + 手填 baseUrl：历史遗留的外部端点，面板提示切回宿主模型
   *   host        api + 宿主 (供应商, 模型)：2026-10-25 之后的正路
   *   unresolved  api 但两者都没有（用户还没选完）—— 不许假装能用
   *
   * @returns {{kind: string, provider: string|null, model: string|null, baseUrlConfigured: boolean}}
   */
  const describeRoute = () => {
    const baseUrlConfigured = typeof state.modelBaseUrl === 'string' && state.modelBaseUrl.length > 0
    const provider = state.modelProvider ?? null
    const model = state.modelName ?? null
    let kind = state.modelSource
    if (state.modelSource === 'api') {
      if (baseUrlConfigured) kind = 'external'
      else if (provider && model) kind = 'host'
      else kind = 'unresolved'
    }
    return { kind, provider, model, baseUrlConfigured, binding: { ...routeBinding } }
  }

  // 暴露给装载机的只读状态（不含私密正文）
  //
  // 抽成函数是因为**有两个人要读**：宿主里的装载机（ctx.provide）和设置页
  // （经 webServer 的只读端点）。两份各写一次必然漂移 —— 界面显示的和
  // 程序真正用的会不一样，而这类不一致最难发现。
  const readOnlySnapshot = () => {
    // journalSeq 现读磁盘链尾（P2-8）：内存里的 `lastSeq` 只在本进程 commit 时
    // 前进，外部进程追加后端点会滞后（审计实测 lag=1）。读不到就老实回落内存值——
    // 状态查询绝不能因为 IO 出错而炸掉设置页。
    const tail = readJournalTail(state.vaultDir, journalSeqCache)
    const inMemorySeq = state.vault?.lastSeq ?? 0
    const journalSeq = tail.ok && Number.isInteger(tail.seq) ? tail.seq : inMemorySeq
    return {
      enabled: state.enabled, tier: state.tier, modelSource: state.modelSource,
      // 宿主模型选择（2026-10-25）：设置页的供应商/模型下拉框回显的就是这两个。
      // 它们**不**从宿主现查 —— 只读端点要保持同步、无副作用，目录查询在写通道的
      // settingsSnapshot 里（见下面的 modelCatalog）。
      modelProvider: state.modelProvider ?? null,
      modelName: state.modelName ?? null,
      modelRoute: describeRoute(),
      vaultDir: state.vaultDir, error: state.error ?? capture?.stats().lastError ?? null,
      capturePlane: {
        state: !capture ? 'pending' : capture.stats().lastError ? 'degraded' : 'ready',
        stats: capture?.stats() ?? null,
      },
      coreId: state.vault?.manifest?.coreId ?? null,
      journalSeq,
      // 这个数是**什么时候**从哪儿来的 —— 面板高频轮询时读的可能是几毫秒前的
      // 缓存，`lag>0` 说明本进程内存值落后于磁盘（有外部写入者）。字段只增不删。
      journalSeqMeta: {
        source: tail.ok ? 'disk' : 'memory',
        readAt: tail.readAt,
        cached: tail.cached,
        bytesRead: tail.bytes,
        inMemorySeq,
        lag: journalSeq - inMemorySeq,
        tornTail: tail.torn,
        error: tail.error,
      },
      // 网关可观测性：零推理档应显示 enabled:false 与原因，而不是"看不见"
      modelGateway: gateway ? gateway.status() : { enabled: false, reasons: ['gateway-init-failed'], error: gatewayError },
      usageToday: gateway ? gateway.usageToday() : null,
      // 设置页需要知道"这份数据是不是真的接上了"，不能靠猜。
      dataPlane: {
        mounted: dataPlaneMounted === true,
        path: DATA_PATH,
        settingsPath: SETTINGS_PATH,
        writable: settingsPlaneMounted === true,
      },
      // 工具注射结果（S1）。宿主没有 tools 服务时这里就是 'unavailable'，
      // 而不是"看起来一切正常、模型却调不到工具"。
      toolPlane: {
        state: toolPlane.state,
        registered: toolPlane.registered.slice(),
        failed: toolPlane.failed.slice(),
        reason: toolPlane.reason,
        at: toolPlane.at,
      },
      // 自动注入（L03）：`stats.lastReason` 就是「上一轮为什么没注入」
      // （no-hit / char-budget / empty-query / already-injected-this-turn …）。
      injectPlane: {
        state: injectPlane.state,
        mounted: injectPlane.mounted,
        reason: injectPlane.reason,
        at: injectPlane.at,
        channel: injectPlane.channel,
        sourceKind: injectPlane.sourceKind,
        stats: injector ? injector.status() : null,
      },
      // 容量治理（L11）。`mode` 说明现在是 plan-only 还是真的会删，
      // `lastRunAt`/`nextRunAt`/`runs` 说明它到底有没有在跑 ——
      // 这三项缺任一，面板都没法区分「今天没有孤儿」和「从来没跑过」。
      // MC11：经验学习面的心跳。`emitted` 长期为 0 就说明链没通 ——
      // 一个不产出的观察者与不存在的观察者，从外面看完全一样。
      experiencePlane: experiencePlane
        ? experiencePlane.status()
        : {
          state: 'pending', enabled: false, observed: 0, triggers: 0, emitted: 0,
          promoted: 0, outcomes: 0, revoked: 0, skipped: 0, errors: 0,
          lastTrigger: null, lastReason: null, lastError: null,
        },
      retentionPlane: retention
        ? retention.status()
        : { state: 'pending', enabled: false, mode: null, runs: 0, lastRunAt: null, nextRunAt: null, lastReport: null, lastError: null },
      // MC13：管理面动作表。写在这里是为了让人从端点就能看到「这台机器上
      // 面板到底能做什么」，而不是去读源码猜。
      adminPlane: { actions: ADMIN_ACTIONS.map((a) => ({ id: a.id, kind: a.kind, label: a.label })) },
    }
  }

  ctx.provide?.('laurel.memoryCore', {
    version: VERSION,
    state: readOnlySnapshot,
    modules: () => moduleState({ memoryCoreEnabled: state.enabled, contextEnabled: true }),
    tools: () => toolSurface({ tier: state.tier, memoryCoreEnabled: state.enabled, contextEnabled: true }),
    // L03 之前这一行是全仓 `renderPrefix` 的唯一出现处 —— 提供者自己，零消费者。
    // 真正的注入现在走 lib/inject.mjs 的 agent/pre-step；这里保留取值器，
    // 让设置页/测试与注入走同一个 renderStablePrefix，不复制第二份格式。
    renderPrefix: (notes) => renderStablePrefix({ notes, tier: state.tier }),
    // 受预算约束的模型调用入口；未接模型时返回 disabled，不发起请求
    complete: gateway ? (req) => gateway.complete(req) : null,
    makeProvider: gateway ? (opts) => gateway.makeProvider(opts) : null,
  })

  ctx.on?.('laurel/reload', () => log.info('配置重载'))

  // ── 采集：宿主对话 → 核心仓（此前完全是空的）─────────────────────────────
  // 到这一步为止，本插件只是「开仓 + 建网关 + 挂只读端点」：
  // `adapter-dsh.mjs` 的 shouldCapture / identityFromEvent 一个都没被调用，
  // 于是 journalSeq 恒为 0、journal/ 里一个文件都没有 —— 记忆核心在空转。
  // 这里把它接上：订阅宿主提交后的追加事件流，逐条判定后写入核心仓。
  //
  // 纪律（最要紧的一条）：**采集失败绝不能影响宿主对话**。
  // 宿主对 observer 抛错本身是隔离的（只记录），但这里仍然自己全吞 ——
  // 不把「记忆坏了」这件事变成用户对话里的可见故障。
  // MC11：经验学习面。三条纪律写在 pipeline.mjs 头注释里，这里只用：
  // 新旧条目自动评估和采纳；方法不齐继续观察并记缺项；真实复用结果独立记录；
  // 失败不抛。默认开启 —— 它本来就是"该一直有输出却一直零输出"的那条链。
  try {
    experiencePlane = createExperiencePlane({
      vaultDir: state.vaultDir,
      coreId: state.vault?.manifest?.coreId ?? null,
      enabled: config.experience?.enabled !== false && !!state.vaultDir,
      log,
      // 身份与采集侧**同源**：同一个 projectIdentityOf，不许另算一套（MC01 的同一条纪律）。
      // pipeline 不自己 import adapter-dsh —— 那条链会成环（adapter-dsh ← capture ← pipeline）。
      // 返回 `{projectId, environmentId}` 而不是单个字符串：经验的 method 有一条
      // 硬规则「环境不明不能晋升」，只给 projectId 会让所有经验卡在 raw-episode。
      resolveProject: (session) => {
        const cwd = session?.header?.cwd ?? session?.cwd ?? null
        if (typeof cwd !== 'string' || !cwd.trim()) return null
        const p = projectIdentityOf({ cwd })
        return p.ok ? { projectId: p.projectId, environmentId: p.environmentId ?? null } : null
      },
    })
    if (experiencePlane.status().enabled === false) log.info('经验学习面未启用（无核心仓或配置关闭）')
  } catch (e) {
    experiencePlane = null
    log.warn(`经验学习面未装配（不影响采集）：${e?.message ?? e}`)
  }

  capture = createCapture({
    vault: state.vault,
    vaultDir: state.vaultDir,
    tier: state.tier,
    log,
    // MC11：采集成功后把归一化事件交给经验面。session 与 hostType 由采集层交出
    // ���它手里才有）—— 让外部自己去找等于把「这条属于哪个会话」重新猜一遍。
    observed: (adapterEvent, captured, ctx) => {
      experiencePlane?.observe?.(ctx?.session ?? null, ctx?.hostType ?? '', adapterEvent, captured)
    },
  })

  const onSessionEvent = (session, event) => {
    try {
      capture.handleSessionEvent(session, event)
    } catch (e) {
      // createCapture 内部已兜底；这里是最后一道，防止未来改动漏掉一层
      log.warn(`采集处理器异常（已忽略）：${e?.message ?? e}`)
    }
  }
  try {
    ctx.on?.('session/event', onSessionEvent)
  } catch (e) {
    // 拿不到事件通道就只是不采集，不影响其它能力
    log.warn(`session/event 订阅失败（不会采集新对话）：${e?.message ?? e}`)
  }

  // ── 自动注入：让记忆真的进到每一轮请求里（L03）───────────────────────────
  // 接缝与形状见 lib/inject.mjs 头注释。用 agent/pre-step（waterfall）而不是
  // systemPrompt.section：前者 payload 里有本轮的 messages，能给出「这一轮在说什么」
  // 的查询词；后者只有静态文本，拿不到提问就只能是固定几条，等于每轮塞同样的东西。
  // section 只在宿主提供时作为可选增强 —— 实测本机 dsh-warden 常报
  // `降级=rulesSection`，任何依赖它的注入都会静默失效。
  try {
    injector = createInjector({ vaultDir: state.vaultDir, tier: () => state.tier, log })
    const off = ctx.on?.('agent/pre-step', (payload, next) => injector.handlePreStep(payload, next))
    if (typeof off === 'function') {
      injectPlane.mounted = true
      injectPlane.state = 'ok'
      injectPlane.channel = 'agent/pre-step'
      injectPlane.at = new Date().toISOString()
      // 返回值是唯一的「挂上了」证据（cordis effect 的卸载句柄）。
      ctx.effect?.(() => () => { try { off() } catch { /* 摘不掉就算了 */ } }, 'laurel-memory.inject')
    } else {
      injectPlane.state = 'unavailable'
      injectPlane.reason = 'agent/pre-step 注册没有返回卸载句柄'
      injectPlane.at = new Date().toISOString()
      log.warn('记忆自动注入未挂上：agent/pre-step 没有返回卸载句柄')
    }
  } catch (e) {
    injectPlane.state = 'unavailable'
    injectPlane.reason = `agent/pre-step 挂载失败：${e?.message ?? e}`
    injectPlane.at = new Date().toISOString()
    log.warn(injectPlane.reason)
  }

  // ── 工具注册：让 toolSurface() 真的有消费者 ───────────────────────────────
  // 此前 toolSurface() 只有 `ctx.provide` 里那个 `tools()` 取值器在用，
  // 宿主工具表里从来没有 `laurel_memory`，模型侧等于看不见记忆。
  //
  // 为什么不用顶层 `inject:['tools']`：本文件顶部定了规矩 ——
  // 非 Web / 无头组合也要能激活。`inject` 加了 tools 就等于「没有 tools 服务
  // 就不装载」，那会把记忆核心在 CLI 场景里也一起废掉。
  //
  // S1 修的是另一件事：**apply 期 `ctx.get('tools')` 拿不到服务**。
  // 真宿主的 tools 服务晚于插件装配才就绪（dsh-tool-batch / dsh-warden /
  // dsh-strata 走的都是 `ctx.inject(['tools'], cb)`，回调在服务就绪后带来
  // 一个能取到 tools 的 ctx）。旧写法同步取一次、拿到 null 就 warn 一句收工，
  // 结果 `laurel_memory` 从来没进过硬宿主的工具表 —— 而单测里手工造的
  // 假 ctx 让 `get('tools')` 同步返回对象，于是测试一直是绿的（陷阱 15）。
  //
  // 现在两条路都留：inject 回调是主路，同步试探只作为兜底（无注入机制的
  // 老组合 / CLI 里手工传 ctx.tools 的场景）。哪条路成功都写进 toolPlane，
  // 端点快照里能看见，不再只留在日志里。
  const registerTools = (toolCtx) => {
    // toolCtx 是 inject 回调给的 ctx；兜底时就是外侧的 ctx 本身。
    const serviceCtx = toolCtx ?? ctx
    const tools = getService(serviceCtx, 'tools') ?? serviceCtx?.tools ?? getService(ctx, 'tools') ?? ctx?.tools ?? null
    if (!tools || typeof tools.register !== 'function') {
      toolPlane.state = 'unavailable'
      toolPlane.reason = '宿主未提供 tools 服务'
      toolPlane.at = new Date().toISOString()
      log.warn('宿主未提供 tools 服务（laurel_memory / laurel_context 工具不可用，记忆读写在插件内仍可用）')
      return
    }
    let definitions = []
    try {
      definitions = toolSurface({ tier: state.tier, memoryCoreEnabled: state.enabled, contextEnabled: true })
    } catch (e) {
      toolPlane.state = 'unavailable'
      toolPlane.reason = `工具定义组装失败：${e?.message ?? e}`
      toolPlane.at = new Date().toISOString()
      log.warn(toolPlane.reason)
      return
    }
    for (const definition of definitions) {
      // S1：不再按名字筛掉 laurel_context。
      // 它的执行器已经下沉到 laurel-core/lib/context-read.mjs，两个包共用同一份；
      // 在这里复制一份是明令禁止的（两处实现必然漂移）。
      let execute
      if (definition.name === 'laurel_memory') {
        // MC01：宿主给的第二参 `exec` 带 `agent.session.id` / `header.cwd`，
        // 这是唯一可信的调用方身份来源。旧写法只接 `args`，等于每次查询都在
        // 五个工程混在一起的索引里搜，而调用方无从知道。
        execute = async (args, exec) => ({
          text: executeMemoryQuery({
            vaultDir: state.vaultDir,
            tier: state.tier,
            args: args && typeof args === 'object' ? args : {},
            scope: resolveQueryScope(exec),
          }),
        })
      } else if (definition.name === 'laurel_context') {
        // `laurel_context` 不按工程收窄：它的参数是 `ref`/`query`，
        // 而 `ctx.externalize` 的 op 里没有 projectId（压缩块按会话产生，
        // 一次会话里外置的原文本来就跨工程）。持有 ref 就等于持有读权限，
        // 这是内容寻址的语义；要收窄得先让外置记录带上 projectId（未做）。
        execute = async (args) => ({
          text: executeContextQuery({
            vaultDir: state.vaultDir,
            vault: state.vault,
            // 压缩块正文的阅读与记忆记录不是同一份预算：前者要能装下
            // 一段原文分页，用注入预算（300/600/1200）会把回读掐成一句话。
            maxChars: CONTEXT_TOOL_MAX_CHARS,
            args: args && typeof args === 'object' ? args : {},
          }),
        })
      } else {
        // 走到这里说明 toolSurface 加了新工具但没人接执行器 —— 宁可少一个工具，
        // 也不注册空实现（那等于对模型撒谎），并把原因记进快照。
        toolPlane.failed.push(definition.name)
        toolPlane.reason = `未接执行器的工具定义：${definition.name}`
        log.warn(toolPlane.reason)
        continue
      }
      try {
        // parameters 直接用 toolSurface() 那一份：另写一份必然与它漂移。
        tools.register({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
          },
          // 返回 { text } 而不是裸字符串：与套件内其它工具（dsh-strata / dsh-forge）同一形状，
          // 既喂模型，也是 CLI 下的可读输出。
          execute,
        })
        toolPlane.registered.push(definition.name)
      } catch (e) {
        // 保留名冲突 / 同 scope 重复注册等，只告警，不影响插件其余部分
        toolPlane.failed.push(definition.name)
        log.warn(`工具注册失败（${definition.name}）：${e?.message ?? e}`)
      }
    }
    toolPlane.state = toolPlane.registered.length ? 'ok' : 'unavailable'
    toolPlane.reason = toolPlane.state === 'ok' ? null : (toolPlane.reason ?? '所有工具都没注册上')
    toolPlane.at = new Date().toISOString()
  }

  // 主路：等 tools 服务就绪再注册。inject 不存在（老组合）时退化为同步试一次。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (toolCtx) => {
        try {
          registerTools(toolCtx)
        } catch (e) {
          log.warn(`工具注册流程异常（不影响记忆读写）：${e?.message ?? e}`)
        }
      })
    } else {
      registerTools(null)
    }
  } catch (e) {
    log.warn(`tools 注入订阅失败（不影响记忆读写）：${e?.message ?? e}`)
    try {
      registerTools(null)
    } catch (e2) {
      log.warn(`工具注册流程异常（不影响记忆读写）：${e2?.message ?? e2}`)
    }
  }

  // ── 只读数据面（D48）────────────────────────────────────────────────────
  // 设置页在浏览器里，拿不到 `laurel.memoryCore` 这个宿主 cordis 服务：
  // 客户端可用的只有宿主预置的 remote.* 命名空间，是个固定集合。
  // 所以状态必须由宿主半边挂到 webServer 上，页面 fetch 回来。
  // 拿不到 webServer（非 Web 组合）不抛，只记一句 —— 页面会显示「未接数据」。
  // 注意：`dataPlaneMounted` 声明在 `readOnlySnapshot` 之前（见上面 P2-7 的注释），
  // 不能挪回这里 —— provide 回调会在 apply 返回前同步读快照。
  const mountDataPlane = (routeCtx) => {
    const webServer = getService(routeCtx, 'webServer')
    const mounted = mountReadOnly(webServer, { path: DATA_PATH, collect: () => ({ ok: true, data: readOnlySnapshot() }) })
    dataPlaneMounted = mounted.ok === true
    if (!mounted.ok) log.warn(`设置页数据面未挂载：${mounted.note}`)
    if (mounted.dispose) routeCtx.effect?.(() => () => { try { mounted.dispose() } catch { /* 摘不掉就算了 */ } }, 'laurel-memory.data-plane')
  }

  // ── 设置页写通道（D143）──────────────────────────────────────────────────
  // 用户要求「三个模式要能在界面上点」。以前不做是因为「webServer 的 prefix
  // 不继承认证」，但那句只对**裸挂**成立：宿主的 /api 后面本来有 connection
  // 服务的 admission，而 webServer 是最长前缀优先 —— 我们挂在更长的
  // /api/laurel-memory 上，就必须自己把同一道栅栏跑在最前面
  // （lib/settings-api.js 里做的就是这个，与 dsh-our-free-model 同构）。
  //
  // 读仍然走无鉴权的 /laurel-memory（只吐自己的档位），写只走这里。
  /**
   * 设置快照（写通道 GET/写后回执）。
   *
   * 与只读端点（`/laurel-memory`）的区别就一件事：这里**允许异步问宿主**。
   * 供应商目录、模型目录、宿主默认模型都得问 llm 服务，而只读端点是同步收集的
   * （高频轮询，不该每次都去问模型目录）。所以下拉框的数据放这里，
   * 面板加载时先打这一条，打不到再退回只读端点（四态逻辑保持不变）。
   */
  const settingsSnapshot = async () => {
    const base = readOnlySnapshot()
    let modelCatalog = { ok: false, reason: '还没查', providers: [] }
    let hostDefault = { ok: false, provider: null, model: null, reason: '还没查' }
    try {
      modelCatalog = await listHostCatalog(getLlm)
    } catch (e) {
      modelCatalog = { ok: false, reason: String(e?.message ?? e), providers: [] }
    }
    try {
      hostDefault = hostDefaultSelection(ctx)
    } catch (e) {
      hostDefault = { ok: false, provider: null, model: null, reason: String(e?.message ?? e) }
    }
    // 当前选的那一对现在能不能用：只在「确实选了宿主模型」时查，
    // 查的是注册表与模型目录（不发补全请求），面板据此显示一行结论。
    let hostProbe = null
    if (base.modelRoute && base.modelRoute.kind === 'host') {
      try {
        hostProbe = await probeHostSelection(getLlm, {
          provider: base.modelRoute.provider, model: base.modelRoute.model, timeoutMs: 3000,
        })
      } catch (e) {
        hostProbe = { ok: false, reason: String(e?.message ?? e) }
      }
    }
    return {
      ...base,
      modelBaseUrl: state.modelBaseUrl ?? null,
      // 宿主 llm 服务在不在。不在时面板要把「为什么没有下拉框」说清楚，
      // 而不是渲染一个空 <select>（那看起来像"选过了但没有选项"）。
      llm: { available: !!getLlm() },
      modelCatalog,
      hostDefault,
      hostProbe,
      // 面板要显示"为什么没生效"，所以把选项表也从宿主侧给出去 ——
      // 前端各写一份枚举，改一处漏一处（D66 那类漂移就是这么来的）。
      options: {
        tiers: Object.keys(TIER_LABELS).map((id) => ({ id, label: TIER_LABELS[id] })),
        sources: [
          { id: 'none', label: '不接模型', note: '0 次调用，全部功能仍可用' },
          { id: 'local', label: '本地端点', note: '需要一个 OpenAI 兼容地址（自己填）' },
          { id: 'api', label: '宿主模型', note: '选宿主里的供应商与模型，不用填地址和密钥' },
        ],
      },
      // MC13：面板上的按钮由宿主侧枚举决定，不前端各写一份（D66 那类漂移）。
      // 每个动作的 kind='read'|'write' 决定按钮是否需要在确认后提交。
      actions: ADMIN_ACTIONS,
      admin: adminStatus(),
    }
  }

  const writeSettings = async (patch = {}) => {
    // MC13：管理动作走**同一条**已鉴权的写通道。
    // 为什么不另开一个端点：`settings-api.js` 那两层栅栏（宿主 connection.admit
    // 或本机+同源、再叠 `x-laurel-ui` 头与 8KB 上限）已经验证过；再挂一条
    // 裸路由就要把同一道栅栏抄第二遍，抄漏一次就是无鉴权写口。
    // 请求形状固定为 `{action:'correct', payload:{...}}` —— 不用「任意字段当命令」，
    // 因为那等于开一个转发器。
    if (patch && typeof patch === 'object' && Object.hasOwn(patch, 'action')) {
      const unknown = Object.keys(patch).filter((k) => k !== 'action' && k !== 'payload')
      if (unknown.length) return { ok: false, error: `管理动作请求只能带 action 与 payload，多了：${unknown.join(', ')}` }
      const out = await adminHandle(patch.action, patch.payload ?? {})
      if (!out || out.ok !== true) {
        return { ok: false, error: String(out?.error ?? out?.reason ?? '动作失败'), data: out ?? null }
      }
      return { ok: true, data: { ...out.data, admin: out.data, settings: await settingsSnapshot() } }
    }
    // provider / model 是宿主 llm 服务里的供应商 id 与模型 id。
    // 它们不是秘密（设置页里就写着），所以和 modelSource 一样走明文写通道。
    const allowed = new Set(['modelSource', 'tier', 'baseUrl', 'provider', 'model'])
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) return { ok: false, error: `不认识的字段：${key}` }
    }
    const next = {}
    if (patch.modelSource !== undefined) {
      if (typeof patch.modelSource !== 'string') return { ok: false, error: 'modelSource 必须是字符串' }
      next.modelSource = patch.modelSource
    }
    if (patch.tier !== undefined) {
      if (typeof patch.tier !== 'string') return { ok: false, error: 'tier 必须是字符串' }
      if (!Object.prototype.hasOwnProperty.call(TIER_LABELS, patch.tier)) {
        return { ok: false, error: `未知档位：${patch.tier}。可选 ${Object.keys(TIER_LABELS).join(' / ')}` }
      }
      next.tier = patch.tier
    }
    if (patch.baseUrl !== undefined) {
      if (patch.baseUrl !== null && typeof patch.baseUrl !== 'string') {
        return { ok: false, error: 'baseUrl 必须是字符串或 null' }
      }
      // 空串 = 明确要求「回到宿主模型」，按 null 处理
      next.baseUrl = patch.baseUrl ? patch.baseUrl.trim() : null
    }
    if (patch.provider !== undefined) {
      if (patch.provider !== null && typeof patch.provider !== 'string') {
        return { ok: false, error: 'provider 必须是字符串或 null' }
      }
      next.provider = patch.provider ? patch.provider.trim() : null
    }
    if (patch.model !== undefined) {
      if (patch.model !== null && typeof patch.model !== 'string') {
        return { ok: false, error: 'model 必须是字符串或 null' }
      }
      next.model = patch.model ? patch.model.trim() : null
    }
    if (Object.keys(next).length === 0) return { ok: false, error: '没有要改的字段' }

    const result = await switchMode(next)
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, data: await settingsSnapshot() }
  }

  // ── 管理面动作（MC13）─────────────────────────────────────────────────
  // `vault` / `experiencePlane` 都是**每次现取**：vault 在 apply 早期可能还没
  // 打开（或已降级为 null），经验面在下面才装配。闭包里存一份快照那天，
  // 面板会一直对着一个已经不存在的对象发号施令。
  let admin = null
  const adminInstance = () => {
    if (admin) return admin
    admin = createAdminActions({
      vaultDir: state.vaultDir,
      vault: null,
      experience: null,
      log,
      moduleVersions: { laurelMemory: VERSION },
    })
    return admin
  }
  const adminStatus = () => ({ actions: ADMIN_ACTIONS.map((a) => a.id) })
  const adminHandle = async (action, payload) => {
    const inst = adminInstance()
    // 每次调用前把当下的 vault / 经验面塞进去（存在就拿最新的，不存在就 null，
    // 由 admin-api 自己判 'no-experience' / 'no-vault' 并如实报）。
    inst.bind({ vault: state.vault, experience: experiencePlane })
    // S8：哨兵要的两份状态（注入统计 / 容量治理）**只活在进程内存里**，
    // 没有落盘。面板跑自检时若不把当下的实例塞进去，这两项就永远
    // unmeasured —— 那等于在宿主里也测不到，白白让哨兵难看却不是真的。
    // 顺序也要紧：这两个闭包变量在 apply 更早处就声明了（TDZ 陷阱 10 同族）。
    inst.bind({
      injectStatus: injector ? injector.status() : null,
      retentionStatus: retention ? retention.status() : null,
    })
    return inst.handle(action, payload)
  }

  const mountSettingsPlane = (routeCtx) => {
    const webServer = getService(routeCtx, 'webServer')
    const mounted = mountSettings(webServer, {
      path: SETTINGS_PATH,
      handler: createSettingsHandler({
        read: settingsSnapshot,
        write: writeSettings,
        // 每次请求现取：组合可能在我们加载之后才发布 connection
        connection: () => getService(routeCtx, 'connection'),
        log,
      }),
    })
    settingsPlaneMounted = mounted.ok === true
    if (!mounted.ok) log.warn(`设置写通道未挂载：${mounted.note}`)
    if (mounted.dispose) routeCtx.effect?.(() => () => { try { mounted.dispose() } catch { /* 摘不掉就算了 */ } }, 'laurel-memory.settings-plane')
  }
  // 读、写两块一起挂：**只订阅一次 webServer**。
  // 订阅两次会让 injections 变成 [['webServer'],['webServer']] —— 既有契约
  // （host-snapshot.test 断言恰好一次）会被打破，而多订阅一次没有任何好处。
  const mountPlanes = (routeCtx) => {
    mountDataPlane(routeCtx)
    mountSettingsPlane(routeCtx)
  }
  try {
    ctx.inject?.(['webServer'], mountPlanes)
  } catch (e) {
    log.warn(`数据面订阅失败（不影响记忆读写）：${e?.message ?? e}`)
  }

  // ── 容量治理（L11）────────────────────────────────────────────────────
  // 只挂调度，不在这里跑：`scanReferences` 是真全盘扫（4 万 journal 单元 +
  // 3.7 万 blob，实测 1.6~3.4 秒），在 apply 路径上跑会跟宿主装载抢盘。
  // 首次延后 30 秒、之后每 6 小时一次，定时器 unref（不拖着宿主进程）。
  //
  // 默认 **只 plan 不删**：真删要靠 config.retention.apply=true 显式打开。
  // 这是刻意的 —— 自动删用户数据的事，插件不该替用户决定。
  try {
    const retentionConfig = config.retention && typeof config.retention === 'object' ? config.retention : {}
    retention = createRetentionPlane({
      vaultDir: state.vaultDir,
      policy: retentionConfig.policy && typeof retentionConfig.policy === 'object' ? retentionConfig.policy : {},
      apply: retentionConfig.apply === true,
      ...(Number.isFinite(retentionConfig.intervalMs) ? { intervalMs: retentionConfig.intervalMs } : {}),
      ...(Number.isFinite(retentionConfig.firstDelayMs) ? { firstDelayMs: retentionConfig.firstDelayMs } : {}),
      enabled: retentionConfig.enabled !== false && !!state.vaultDir,
      log,
    })
    const disposeRetention = retention.schedule((dispose) => {
      // 同一条纪律：拿到 disposer 才算挂上，不拿就在日志里明说没挂。
      try { ctx.effect?.(() => dispose, 'laurel-memory.retention') } catch (e) { log.warn(`retention 卸载句柄登记失败：${e?.message ?? e}`) }
    })
    if (typeof disposeRetention !== 'function') {
      log.warn('容量治理未排程（没有核心仓路径或已禁用）')
    }
  } catch (e) {
    // 治理坏了不能连带记忆读写一起坏
    log.warn(`容量治理初始化失败（不影响记忆读写）：${e?.message ?? e}`)
  }

  const restoreRoute = async () => {
    if (routeDisposed || typeof config.provider?.complete === 'function') return
    const epoch = ++routeEpoch
    if (state.modelSource === 'none') {
      routeBinding = { state: 'disabled', error: null, inferenceVerified: false }
      return
    }
    routeBinding = { state: 'checking', error: null, inferenceVerified: false }
    try {
      const resolved = await resolveProviderFor(state.modelSource, {
        baseUrl: state.modelBaseUrl, provider: state.modelProvider, model: state.modelName,
      })
      if (routeDisposed || epoch !== routeEpoch) return
      if (!resolved.ok) {
        routeBinding = { state: 'unavailable', error: resolved.error, inferenceVerified: false }
        return
      }
      gateway = buildGateway(resolved.provider)
      state.gateway = gateway
      hostProviderRef = resolved.host ? resolved.provider : null
      routeBinding = { state: resolved.provider ? 'bound' : 'disabled', error: null, inferenceVerified: false }
    } catch (error) {
      if (!routeDisposed && epoch === routeEpoch)
        routeBinding = { state: 'unavailable', error: String(error?.message ?? error), inferenceVerified: false }
    }
  }
  // 可选服务晚到时重新绑定；不重写模式文件、不探测计费补全。
  void restoreRoute()
  if (state.modelSource === 'api' && state.modelProvider && state.modelName) {
    try {
      ctx.inject?.(['llm'], (routeCtx) => {
        llmContext = routeCtx
        void restoreRoute()
        routeCtx.effect?.(() => () => {
          routeEpoch++
          llmContext = ctx
          hostProviderRef = null
          gateway = buildGateway()
          state.gateway = gateway
          routeBinding = { state: 'unavailable', error: '宿主 llm 服务已卸载', inferenceVerified: false }
        }, 'laurel-memory.model-route')
      })
    } catch (error) {
      routeBinding = { state: 'unavailable', error: String(error?.message ?? error), inferenceVerified: false }
    }
  }
  ctx.on?.('dispose', () => { routeDisposed = true; routeEpoch++ })

  return { name: PACKAGE_NAME, version: VERSION, state }
}

export { PACKAGE_NAME, VERSION }
