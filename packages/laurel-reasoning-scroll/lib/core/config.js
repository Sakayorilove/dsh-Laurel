/**
 * laurel-reasoning-scroll · 配置声明式归一化（纯函数，无 IO）
 *
 * ── 为什么配置不挂在宿主 settings 文档上 ────────────────────────────────
 * 宿主那份 settings 文档只收**声明了 Config（schemastery）**的入口，而它的
 * 命名空间取自 loader 行 id。本模块的 loader 行 id 是 `reasoning-scroll`
 * （Laurel 套件的短 id 约定），包名却是 `laurel-reasoning-scroll`；两者一旦
 * 漂开，`configForms.get()` 拿到的表单就是 unavailable —— 而且不报错，
 * 只是设置页永远写不进去。
 *
 * 套件里九个子包一个都没导出 Config，全部走「自己的 settings.json + 一条
 * 前缀路由」。这里沿用同一条路：少一个依赖（本包目录下没有 @deepseek-ai/
 * schemastery），也少一处必须手动对齐命名空间的地方。
 *
 * ── 三层归一化（与 laurel-continue 同一套语义）────────────────────────────
 *   1. 出厂默认 DEFAULT_CONFIG；
 *   2. loader 行的 config（profile 的 cordis.patch.yml 里那份）；
 *   3. `$DSH_HOME/laurel-reasoning-scroll/settings.json`（设置页写的）。
 * 每一层都过同一个 normalizeConfig，任何一层写坏都不会让界面带着 NaN 去排版。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

/* ------------------------------------------------------------------ *
 * 字段声明
 * ------------------------------------------------------------------ */

/**
 * 字段规格：`type` 只有 boolean / number 两种（这一版没有自由文本）。
 * `default` 是**出厂值**；归一化时 base 里有值就优先用 base。
 */
const FIELDS = {
  /** 总开关：关掉之后一个字节都不改宿主界面。 */
  enabled: { type: 'boolean', default: true },
  /** 滚动窗高度上限（px）。宿主原生的思考体没有上限，这里是唯一的量化项。 */
  maxHeight: { type: 'number', default: 240, min: 80, max: 1200 },
  /** 流式输出时自动贴底。 */
  autoFollow: { type: 'boolean', default: true },
  /** 开始思考时自动展开这一段。 */
  expandOnStream: { type: 'boolean', default: true },
  /** 思考结束（正文开始）时自动收起。 */
  collapseOnDone: { type: 'boolean', default: true },
  /** 自上而下淡出的渐变文字（用遮罩实现，见 client 里那条注释）。 */
  gradientText: { type: 'boolean', default: true },
  /** 上翻之后右下角那颗「跳到最新」。 */
  showJumpButton: { type: 'boolean', default: true },
  /**
   * 把本轮的编辑 / 查看 / 调用等工具记录也收进同一个限高滚动窗。
   *
   * 出厂默认 false（与独立插件 dsh-reasoning-scroll 0.2.2 一致，它一直是实验项）。
   * 某个 profile 里把它设成 true 是**那个 profile 的选择**，写在 profile 的
   * cordis.patch.yml 里，不烤进这里的出厂值 —— 否则下一个人拿到的就是
   * 「一装上来就把工具过程窗口也一起改了」。
   */
  includeToolCalls: { type: 'boolean', default: false },
};

/** 已声明的全部键（顺序稳定，写盘时照这个顺序）。 */
export const CONFIG_KEYS = Object.freeze(Object.keys(FIELDS))

/* ------------------------------------------------------------------ *
 * 单字段工具
 * ------------------------------------------------------------------ */

/** 数字字段：夹到区间 + 四舍五入。非有限数退回 fallback。 */
function clampNumber(value, min, max, fallback) {
  // 只认真正的 number。字符串 '300' 属于**类型不对**，按契约退回 fallback ——
  // 静默接受会把"设置页那边已经坏了"这件事藏起来。
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 布尔字段：只认真正的布尔；其它退回 fallback（不做 Boolean(x) 猜测）。 */
function pickBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 归一化单个字段。 */
function normalizeField(spec, value, fallback) {
  if (spec.type === 'boolean') return pickBoolean(value, fallback)
  if (spec.type === 'number') return clampNumber(value, spec.min, spec.max, fallback)
  return fallback
}

/** 单个字段取值：输入里非 null/undefined 优先，否则用 base，再否则用 spec.default。 */
function fieldValue(input, key, base, spec) {
  const raw = input[key]
  if (raw !== undefined && raw !== null) return raw
  const inherited = base[key]
  if (inherited !== undefined && inherited !== null) return inherited
  return spec.default
}

/* ------------------------------------------------------------------ *
 * 公开 API
 * ------------------------------------------------------------------ */

/** 出厂默认配置。**每个键都在**，可以直接当对象用。 */
export const DEFAULT_CONFIG = Object.freeze((() => {
  const out = {}
  for (const [key, spec] of Object.entries(FIELDS)) out[key] = spec.default
  return out
})())

/**
 * 只保留已声明的键。
 *
 * 写盘前必须过一遍：免得临时字段（或设置页多传的东西）被写进 settings.json，
 * 下次启动又被读回来，变成"配置里有但没人认"的幽灵键。
 */
export function pickKnown(obj) {
  const src = obj && typeof obj === 'object' ? obj : {}
  const out = {}
  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key]
  }
  return out
}

/**
 * 归一化一份配置。**永不抛**，返回形状与 DEFAULT_CONFIG 完全一致的完整对象。
 *
 * @param {unknown} patch 待归一化的输入（可以是任意垃圾）
 * @param {Record<string, unknown>} [base] 上一层配置（默认 DEFAULT_CONFIG）
 * @returns {Record<string, unknown>}
 */
export function normalizeConfig(patch, base = DEFAULT_CONFIG) {
  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const parent = base && typeof base === 'object' && !Array.isArray(base) ? base : DEFAULT_CONFIG
  const out = {}
  for (const [key, spec] of Object.entries(FIELDS)) {
    const value = fieldValue(input, key, parent, spec)
    const fallback = parent[key] !== undefined && parent[key] !== null ? parent[key] : spec.default
    out[key] = normalizeField(spec, value, fallback)
  }
  return out
}
