/**
 * laurel-continue · 配置声明式归一化（纯函数，无 IO）
 *
 * 一份配置有**三个来处**：cordis patch 的 config（默认值）、
 * `$DSH_HOME/laurel-continue/settings.json`（设置页写的）、以及设置页的 POST。
 * 任何一个写坏了，都不该让引擎带着 `NaN` 或 `undefined` 去干活。
 *
 * 语义（契约 §2，四条，别改）：
 *   1. **只认声明过的键**，未知键直接丢弃（防设置页塞垃圾）；
 *   2. **类型不对 → 退回 base 里的值**，不是 spec 的 default ——
 *      这样「patch 默认值 → settings.json 覆盖」的分层语义才成立，永不抛；
 *   3. number 一律**四舍五入**并夹在区间内；
 *   4. 字符串时钟一律规整成 `HH:MM`（容许输入 `H:MM`）。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

import { normalizeClock } from './schedule.js'
import { TURN_END_KINDS } from './reasons.js'

/* ------------------------------------------------------------------ *
 * 字段声明
 * ------------------------------------------------------------------ */

/**
 * 字段规格表的类型：
 *   - `boolean` / `string` / `enum` / `number`
 *   - `clock`   HH:MM 时钟字符串
 *   - `kinds`   §3 的 7 个 turn/end kind 的子集
 *
 * `default` 是**出厂值**；归一化时若 base 里有值就优先用 base。
 */
const FIELDS = {
  enabled: { type: 'boolean', default: true },
  graceMs: { type: 'number', default: 10000, min: 0, max: 300000 },
  cooldownMs: { type: 'number', default: 20000, min: 0, max: 3600000 },
  maxConsecutive: { type: 'number', default: 3, min: 1, max: 100 },
  resumedKinds: { type: 'kinds', default: ['error', 'max-tokens'] },
  classify: { type: 'boolean', default: true },

  loopAfterCompleted: { type: 'boolean', default: false },
  loopMaxRounds: { type: 'number', default: 20, min: 1, max: 1000 },
  loopMaxDurationMs: { type: 'number', default: 3600000, min: 60000, max: 86400000 },
  loopBudgetNotice: { type: 'boolean', default: true },

  scheduleMode: { type: 'enum', default: 'always', values: ['always', 'day', 'night', 'custom', 'until'] },
  dayStart: { type: 'clock', default: '08:00' },
  dayEnd: { type: 'clock', default: '22:00' },
  customStart: { type: 'clock', default: '09:00' },
  customEnd: { type: 'clock', default: '18:00' },
  activeFrom: { type: 'number', default: 0, min: 0, max: Number.MAX_SAFE_INTEGER },
  activeUntil: { type: 'number', default: 0, min: 0, max: Number.MAX_SAFE_INTEGER },

  autoAnswer: { type: 'boolean', default: true },
  suppressNotifyOnAutoAnswer: { type: 'boolean', default: true },

  yieldToCompaction: { type: 'boolean', default: true },
  yieldToWaitCap: { type: 'boolean', default: true },
  waitGraceMs: { type: 'number', default: 45000, min: 0, max: 600000 },

  continueText: { type: 'string', default: '', max: 2000 },
  guardTools: { type: 'boolean', default: true },
  guardPendingText: { type: 'string', default: '', max: 2000 },
  guardDoneText: { type: 'string', default: '', max: 2000 },

  notify: { type: 'boolean', default: true },
  locale: { type: 'enum', default: 'auto', values: ['auto', 'zh', 'en'] },
  logLevel: { type: 'enum', default: 'info', values: ['debug', 'info', 'warn', 'error'] },
}

/** 已声明的全部键（顺序稳定，写盘时照这个顺序）。 */
export const CONFIG_KEYS = Object.freeze(Object.keys(FIELDS))

/* ------------------------------------------------------------------ *
 * 单字段工具
 * ------------------------------------------------------------------ */

/** 数字字段：夹到区间 + 四舍五入。非有限数退回 fallback。 */
function clampNumber(value, min, max, fallback) {
  // 只认真正的 number。字符串 '1234' 是**类型不对**，按契约 §2 退回 fallback ——
  // 不能 Number() 一下就当它是数字：设置页传 "12" 和 12 是两种不同的输入，
  // 前者说明那一层已经坏了（比如表单没做转换），静默接受会把坏掉的那层藏起来。
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 布尔字段：只认真正的布尔；其它退回 fallback（不做 `Boolean(x)` 猜测）。 */
function pickBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 字符串字段：必须是字符串，去掉首尾空白并截断。 */
function pickString(value, maxLen, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed
}

/** 枚举字段：只认白名单值。 */
function pickEnum(value, values, fallback) {
  return typeof value === 'string' && values.includes(value) ? value : fallback
}

/**
 * kind 集合字段：取 base 与输入的**交集**再按 §3 的固定顺序排。
 *
 * 为什么顺序要固定：`resumedKinds` 会进日志和 HTTP 响应，
 * 顺序随输入抖动会让"这两次配置一样吗"变成一条无法比对的判断题。
 */
function pickKinds(value, fallback) {
  // 输入不是数组 → 类型不对，退回 fallback。
  if (!Array.isArray(value)) {
    const base = Array.isArray(fallback) ? fallback : []
    return TURN_END_KINDS.filter((kind) => base.includes(kind))
  }
  // 输入是数组 → **严格**取交集，空数组就是空数组。
  //
  // 空数组是合法子集，而且它有明确语义：用户把 resumedKinds 全删光 =
  // 「一个都不自动续跑」—— 这是不碰总开关就能彻底停掉续跑的做法。
  // 如果这里回落默认，恰好会把他的意图反转成「全都续」，是最坏的一种"帮忙"。
  const wanted = new Set()
  for (const item of value) {
    if (typeof item === 'string' && TURN_END_KINDS.includes(item)) wanted.add(item)
  }
  return TURN_END_KINDS.filter((kind) => wanted.has(kind))
}

/** 归一化单个字段。 */
function normalizeField(spec, value, fallback) {
  switch (spec.type) {
    case 'boolean':
      return pickBoolean(value, fallback)
    case 'string':
      return pickString(value, spec.max ?? 400, fallback)
    case 'enum':
      return pickEnum(value, spec.values, fallback)
    case 'number':
      return clampNumber(value, spec.min ?? 0, spec.max ?? Number.MAX_SAFE_INTEGER, fallback)
    case 'clock':
      return normalizeClock(value, fallback)
    case 'kinds':
      return pickKinds(value, fallback)
    default:
      return fallback
  }
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
 * 公开 API（契约 §2 的导出形状）
 * ------------------------------------------------------------------ */

/** 出厂默认配置。**每个键都在**，可以直接当对象用。 */
export const DEFAULT_CONFIG = Object.freeze((() => {
  const out = {}
  for (const [key, spec] of Object.entries(FIELDS)) {
    out[key] = spec.type === 'kinds' ? [...spec.default] : spec.default
  }
  return out
})())

/**
 * 只保留已声明的键。
 *
 * 写盘前必须过一遍：免得临时字段（或设置页多传的东西）被写进 settings.json，
 * 下次启动又被读回来，变成"配置里有但没人认"的幽灵键。
 *
 * @param {unknown} obj
 * @returns {Record<string, unknown>}
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
 * 归一化一份配置。**永不抛**，返回形状与 `DEFAULT_CONFIG` 完全一致的完整对象。
 *
 * @param {unknown} patch 待归一化的输入（可以是任意垃圾）
 * @param {Record<string, unknown>} [base] 上一层配置（默认 `DEFAULT_CONFIG`）
 * @returns {Record<string, unknown>}
 */
export function normalizeConfig(patch, base = DEFAULT_CONFIG) {
  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  const parent = base && typeof base === 'object' && !Array.isArray(base) ? base : DEFAULT_CONFIG
  const out = {}
  for (const [key, spec] of Object.entries(FIELDS)) {
    const value = fieldValue(input, key, parent, spec)
    const fallback = parent[key] !== undefined && parent[key] !== null ? parent[key] : spec.default
    out[key] = normalizeField(spec, value, spec.type === 'kinds' ? fallback : normalizeField(spec, fallback, spec.default))
  }
  return out
}
