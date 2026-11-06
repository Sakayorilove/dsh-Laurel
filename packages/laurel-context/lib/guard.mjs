/**
 * laurel-context/guard —— 摘要守门：接在**任意**摘要引擎之后，不合格就退回原视图。
 *
 * 为什么需要它：
 *   实测外部摘要引擎产出的真实摘要里，限制条件（forbidden）只保留 11%（25/224），
 *   目标 15%、错误 17%。不是它坏，是它的设计本来就不保证逐条保留。
 *   但**没有任何一层会拦住漏项** —— 这就是风险。
 *
 * 这个守门器做的事：
 *   1. 从原文抽受保护项（规则，零推理）
 *   2. 检查摘要是否保住
 *   3. 不合格 → 返回 reject + 理由 + 可选的补救建议
 *   4. 调用方据此决定：重做 / 缩小范围 / 保留原视图
 *
 * 它**不需要模型**，也**不改任何引擎**。可以立刻接在任意摘要引擎之后。
 */
import { SUMMARY_MARKER } from './compaction-provider.mjs'
// 【D91】受保护项类别只保留一份来源（summary-protocol.mjs），本文件不再手写第二份。
// 无环：summary-protocol → laurel-core/format；本文件 → compaction-provider（它只依赖 node:crypto）。
import { PROTECTED_KINDS as PROTOCOL_PROTECTED_KINDS } from './summary-protocol.mjs'

/**
 * 受保护项类别。
 *
 * 【D91】原来这里是第二份手写常量，注释写着「与 summary-protocol 同口径」，
 * 而 summary-protocol 那份有 6 项（含 decision）、这份只有 5 项 ——
 * **注释在撒谎，两套判定已经分叉**。分叉的后果不是立刻报错，而是：
 * 显式声明成 decision 的受保护项，协议层会拦，守门层连看都看不到。
 *
 * 现在改成从协议层取，只此一份来源。以后加类别只改 summary-protocol.mjs。
 */
export const PROTECTED_KINDS = PROTOCOL_PROTECTED_KINDS

/**
 * 各类别的权重：限制与错误最重，因为丢了会直接导致重复犯错。
 *
 * 【D91】补上 decision。原来没有这个键，真出现时按 `?? 1` 兜底 ——
 * 与 exact（最轻的精确值）同档，等于"丢了决定"和"丢了一个小数点后的数字"一样严重。
 * 定成 2：与 todo 同档，因为决策丢了会导致后续工作全部白做，必须重来。
 */
export const KIND_WEIGHT = Object.freeze({ forbidden: 3, constraint: 3, error: 3, todo: 2, decision: 2, goal: 2, exact: 1 })

const SENTENCE_SPLIT = /(?<=[。！？!?\n])/

/**
 * 【S5】否定式约束的**动词表**（必须/不许/禁止/不要/不得/绝不能/切勿/严禁/never/must not/do not…）。
 *
 * 分两档，因为中文里"必须"是双重身份：
 *  - `NEGATIVE_CUE`：纯否定。命中即 forbidden（丢了会直接重复犯错）。
 *  - `POSITIVE_MUST`：`必须/一定要/务必/must`。这类**单独出现时不算约束** ——
 *    "必须先读 README"确实是约束，但"你需要给我一个方案"里的"需要"不是。
 *    所以它必须同时命中 `ACTION_CUE` 才算：约束的要害是**具体动作**，
 *    只抽到"必须"两个字等于没抽（守门器会拿"必须"去比对摘要，永远命中）。
 */
const NEGATIVE_CUE = /(禁止|不许|不准|不得|不要|不能|不可|绝不能|绝不可|切勿|严禁|勿|严禁在|never|must\s+not|mustn't|do\s+not|don't|should\s+not|shall\s+not)/i
const POSITIVE_MUST = /(必须|一定要|务必|必需|\bmust\b|\brequired\s+to\b)/i
/**
 * 具体动作：动词或带目标的名词短语。约束必须落到动作上才有守门价值。
 *
 * 【S5】`备份|迁移|保留|覆盖` 这几个是**实测补上的**，不是拍脑袋加的：
 * 探测脚本 b-probe-extract.mjs 跑出来「一定要备份后再迁移」「必须保留日志」
 * 两句都抽不到任何东西 —— 明明有硬约束词、明明有具体动作，却因为动作表里
 * 只写了"发布/部署"没写"备份/迁移"而整条溜过去。约束词表不是装饰：
 * 漏掉一个动词，对应的那一整类限制条件就永远不进守门器的分母。
 */
const ACTION_CUE = /(执行|运行|调用|删除|删掉|移除|清空|覆盖|改写|修改|写入|提交|推送|发布|部署|上线|重启|停用|启用|安装|卸载|回滚|重置|格式化|导出|上传|下载|备份|迁移|保留|丢弃|替换|drop|truncate|delete|rm\s|rmdir|format|reset|push|deploy|migrate|backup|drop\s+database|DROP\s+DATABASE|kill|truncate\s+table)/

/** 抽取受保护项。零推理、纯规则。 */
export function extractProtected(text, { limit = 60 } = {}) {
  const items = []
  const seen = new Set()
  const add = (kind, v) => {
    const s = String(v).trim()
    if (s.length < 3) return
    const k = kind + '|' + s.slice(0, 50)
    if (seen.has(k)) return
    seen.add(k)
    items.push({ kind, value: s.slice(0, 160) })
  }
  for (const s of String(text).split(SENTENCE_SPLIT)) {
    // 【S5】否定式约束：命中否定词 + 落到具体动作 → forbidden（权重 3，丢了直接拒）。
    // 验收用例「禁止在生产环境执行 drop database」走的正是这一条。
    const neg = NEGATIVE_CUE.test(s)
    const must = POSITIVE_MUST.test(s)
    const act = ACTION_CUE.test(s)
    if (neg && act) add('forbidden', s)
    // 否定词在、动作没识别出来时也不放过：宁可多算（多算只是把分母做大），
    // 漏算才是把一条禁止事项从守门器的集合里整个删掉。
    else if (neg) add('forbidden', s)
    // 「必须/务必 + 具体动作」归 constraint（与 forbidden 同权），
    // 这样"必须先跑 hash-check.sh"这类正向硬约束也进分母。
    else if (must && act) add('constraint', s)
    if (/(未完成|还没|尚未|TODO|待验证|待确认|下一步)/i.test(s)) add('todo', s)
    if (/(ERROR|FAIL|Traceback|Exception|ENOENT|EACCES|exit code [1-9])/.test(s)) add('error', s)
    if (/(目标|要求|需要|必须|决定|结论|改为|采用)/.test(s)) add('goal', s)
    // 【D91】决策类单独成一类。原来「采纳 Y 方案」「定案：走本地优先」「最终选择 B 路线」
    // 三种写法**一句都抽不到**（实测 5 种常见决策句式里 3 种漏网），
    // 于是整条决策从守门器的分母里消失：weightedLoss=0，verdict=accept。
    // 注意顺序：先判 goal 再判 decision，两类的正则有意重叠 ——
    // 带「决定/结论」的句子两边都会进，这正是我们想要的（宁可多算，不可漏算）。
    if (/(采纳|定案|最终选择|最后选择|拍板|选定|改用|放弃|不再评估|不再考虑)/.test(s)) add('decision', s)
    for (const m of s.matchAll(/\b[a-zA-Z_][\w.]*=\d+/g)) add('exact', m[0])
    for (const m of s.matchAll(/(?:[A-Za-z]:\\[^\s"'<>|]+|\/(?:mnt|home|tmp|usr)[\w./-]{4,})/g)) add('exact', m[0])
    for (const m of s.matchAll(/\b\d+(?:\.\d+){1,3}\b/g)) add('exact', m[0])
  }
  return items.slice(0, limit)
}

/** 归一化：去掉标点与空白，做"实质相同"比较。 */
function normalize(x) {
  return String(x).replace(/[\s，。、；：！？,.;:!?"'`（）()【】\[\]]/g, '')
}

/** 一条受保护项是否还在摘要里。 */
export function isKept(item, summaryText) {
  const s = normalize(summaryText)
  const v = normalize(item.value)
  if (!v) return true
  if (s.includes(v)) return true
  const head = v.slice(0, 12)
  return head.length >= 6 && s.includes(head)
}

/** 噪声：这些条目本就不该指望摘要逐字保留，算进分母会低估。 */
export function isNoisy(item) {
  const v = item.value
  if (item.kind === 'todo' && /^\{|\{"todos"|^Updated todo list/.test(v.trim())) return true
  if (item.kind === 'exact' && /^\d+(\.\d+){1,3}$/.test(v)) return true
  if (item.kind === 'exact' && v.length < 10) return true
  return false
}

/**
 * 守门主函数。
 *
 * 【S5】返回值里带上 `policy`（**实际生效**的那一份，已夹紧）。
 * 修前只回 verdict，调用方无从知道"我传的 0.9 到底生效了没有" ——
 * 于是一次误传宽松策略的调用，看起来和正常调用一模一样。
 * 现在每个返回分支都带 policy，日志里能直接看出闸门是 0.35 还是被夹过的值。
 *
 * @param {{original:string|Array, summary:string, policy?:object}} args
 * @returns {{ok:boolean, verdict:'accept'|'reject'|'accept-with-warning', checked:object, missing:Array, weightedLoss:number, advice:string, policy:{maxWeightedLoss:number, allowCriticalLoss:boolean}}}
 */
export function guardSummary({ original, summary, policy = {}, protectedItems = [] }) {
  // 【S5】策略只许收紧：阈值夹到 [0, 0.35]，关键项豁免恒 false。
  // 放在最前面算，保证**每个**返回分支都带同一份 policy（含两条早退分支）。
  //
  // 为什么要下限：`Number.isFinite(-1)` 是 true，只写上界的话 Math.min(-1, 0.35) = -1，
  // 于是 `weightedLoss > maxLoss` 对**任何**摘要都成立 → 压缩永久失败。
  // 那不是"更严"，那是一个配错的负数把整条压缩路径变成不可用（fail-closed 变 fail-dead）。
  // 非法输入（负数/NaN/字符串）统一回落到默认 0.35：宁可回到默认，也不静默改行为。
  const asked = Number.isFinite(policy.maxWeightedLoss) && policy.maxWeightedLoss >= 0
    ? policy.maxWeightedLoss
    : 0.35
  const maxLoss = Math.min(asked, 0.35)
  const allowCriticalLoss = false
  const effectivePolicy = { maxWeightedLoss: maxLoss, allowCriticalLoss }

  const rawText = Array.isArray(original)
    ? original.map((x) => (typeof x === 'string' ? x : (x?.content ?? x?.text ?? ''))).join('\n')
    : String(original ?? '')

  // 摘要若本来就是原视图（没压缩），直接通过
  if (normalize(summary).length >= normalize(rawText).length) {
    return { ok: true, verdict: 'accept', checked: { noCompression: true }, missing: [], weightedLoss: 0, advice: '未压缩，无需守门', policy: effectivePolicy }
  }

  // 【D91】把调用方显式声明的受保护项一并纳入。
  // 原来这里只有 extractProtected(rawText)：显式声明 {kind:'decision', value:'采纳 Y 方案'}
  // 的项在协议层会被拦（validateSummary 认得 decision），守门层却连看都看不到 ——
  // 两层检查的不是同一个集合。现在合并后一起去重、一起进分母。
  const declared = (protectedItems ?? [])
    .filter((it) => it && typeof it === 'object' && typeof it.value === 'string' && it.value.trim())
    .map((it) => ({ kind: it.kind ?? 'goal', value: String(it.value).trim().slice(0, 160) }))
  const seenKey = new Set()
  const all = []
  for (const it of [...declared, ...extractProtected(rawText)]) {
    const k = it.kind + '|' + it.value.slice(0, 50)
    if (seenKey.has(k)) continue
    seenKey.add(k)
    all.push(it)
  }
  if (!all.length) {
    return { ok: true, verdict: 'accept', checked: { protected: 0 }, missing: [], weightedLoss: 0, advice: '原文没有可识别的受保护项', policy: effectivePolicy }
  }

  const scored = all.filter((x) => !isNoisy(x))
  const items = scored.length ? scored : all
  const results = items.map((it) => ({ ...it, kept: isKept(it, summary) }))
  const missing = results.filter((r) => !r.kept)

  const totalWeight = items.reduce((a, r) => a + (KIND_WEIGHT[r.kind] ?? 1), 0)
  const lostWeight = missing.reduce((a, r) => a + (KIND_WEIGHT[r.kind] ?? 1), 0)
  const weightedLoss = totalWeight ? lostWeight / totalWeight : 0

  // 硬规则：只要丢了 forbidden 或 error，就必须拒（这两类丢了会直接导致重复犯错）
  const critical = missing.filter((m) => m.kind === 'forbidden' || m.kind === 'error')

  const byKind = results.reduce((a, r) => {
    a[r.kind] = a[r.kind] ?? { total: 0, kept: 0 }
    a[r.kind].total++
    if (r.kept) a[r.kind].kept++
    return a
  }, {})

  const checked = {
    protected: items.length,
    kept: items.length - missing.length,
    retention: items.length ? (items.length - missing.length) / items.length : 1,
    weightedLoss,
    byKind,
    noisyRemoved: all.length - items.length,
  }

  if (critical.length && !allowCriticalLoss) {
    return {
      ok: false, verdict: 'reject', checked, missing, weightedLoss, policy: effectivePolicy,
      advice: `丢了 ${critical.length} 条关键约束（限制/错误）。建议：重做摘要，或缩小范围只压一部分，或保留原视图。`,
    }
  }
  if (weightedLoss > maxLoss) {
    return {
      ok: false, verdict: 'reject', checked, missing, weightedLoss, policy: effectivePolicy,
      advice: `加权丢失 ${(weightedLoss * 100).toFixed(0)}% 超过阈值 ${(maxLoss * 100).toFixed(0)}%。建议缩小范围或保留原视图。`,
    }
  }
  if (missing.length) {
    return {
      ok: true, verdict: 'accept-with-warning', checked, missing, weightedLoss, policy: effectivePolicy,
      advice: `丢了 ${missing.length} 条非关键项（多为精确值），可接受但已记录。`,
    }
  }
  return { ok: true, verdict: 'accept', checked, missing: [], weightedLoss, advice: '全部受保护项都在', policy: effectivePolicy }
}

/**
 * 兜底：给一个已有摘要包一层"守门结论"，供界面/日志展示。
 * 不修改摘要本身，只加判定。
 */
export function annotateSummary(summaryText, guardResult) {
  const tag = guardResult.ok
    ? `<!-- laurel:guard accept retention=${(guardResult.checked.retention * 100).toFixed(0)}% -->`
    : `<!-- laurel:guard reject missing=${guardResult.missing.length} -->`
  return `${tag}\n${summaryText}`
}

export { SUMMARY_MARKER }
