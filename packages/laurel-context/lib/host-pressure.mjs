/**
 * laurel-context/host-pressure —— 从宿主官方投影读「真实用量 / 真实窗口」（L10）。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────
 * 这两个函数原先住在 `lib/index.js` 里。但**真正提供 `compaction` 服务的入口**
 * 是 `lib/compaction-entry.mjs`（预设组内那份），它不在 `lib/index.js` 的
 * 实例里 —— entry 若去 `import './index.js'`，就形成
 * `index.js → compaction-entry.mjs → index.js` 的循环依赖，
 * 而 index.js 里的 `import { compactionEntryStatus } from './compaction-entry.mjs'`
 * 在循环下会拿到未初始化的绑定。拆成独立模块是最省事的正解：两边都 import 它，
 * 没有环，也仍然只有一份实现（复制第二份 = 两个真相，本仓栽过）。
 *
 * ── 口径来源 ──────────────────────────────────────────────────────────
 * 抄 dsh-warden `lib/host/usage.js:422 readOfficialPressure`：
 * 用 `cachedSnapshot` 而不是 `snapshot` —— 前者只读已经物化好的缓存格子、
 * 不折叠历史，放在 pre-step 热路径上不引入 O(surface) 开销。
 *
 * 拿不到就返回 null。**绝不**用 `content.length` 之流冒充实测：
 * `compaction-provider.mjs` 的 `defaultMeasure` 就是把字符数当 token 报的，
 * 那条路径只能作最后兜底，且必须让 basis 显示它不是 real。
 */

/**
 * @returns {{pressureTokens:number|null, projectedTokens:number|null,
 *            contextWindow:number|null, asOfSeq:number|null}|null}
 */
export function readProjectedPressure(ctx, session) {
  try {
    const projections = ctx?.get?.('sessionProjections')
    if (!projections?.cachedSnapshot || !session) return null
    const snap = projections.cachedSnapshot(session, ['contextPressure', 'tokenUsage'])
    if (!snap || typeof snap !== 'object') return null
    const pressure = snap.values?.contextPressure
    if (!pressure && !snap.values?.tokenUsage) return null
    return {
      pressureTokens: Number.isFinite(pressure?.pressureTokens) ? pressure.pressureTokens : null,
      projectedTokens: Number.isFinite(pressure?.projectedTokens) ? pressure.projectedTokens : null,
      // L10 的核心一条：profile 声明 contextWindow=1,000,000，而老代码写死 200,000。
      // 真实窗口只有投影知道，配置里的数只能当兜底。
      contextWindow: Number.isFinite(pressure?.contextWindow) ? pressure.contextWindow : null,
      asOfSeq: Number.isFinite(snap.asOfSeq) ? snap.asOfSeq : null,
    }
  } catch {
    return null
  }
}

/**
 * 从投影里挑「当前上下文用了多少 token」。
 *
 * 优先 `projectedTokens`（下一次请求真正会发出去的量），退到 `pressureTokens`
 * （触发压力判断用的量）。两者都没有就是 null —— 由调用方把 basis 标成 unknown。
 */
export function usedTokensOf(projection) {
  if (!projection) return null
  const v = projection.projectedTokens ?? projection.pressureTokens
  return Number.isFinite(v) && v >= 0 ? v : null
}
