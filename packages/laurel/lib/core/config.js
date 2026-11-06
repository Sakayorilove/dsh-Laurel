/**
 * Laurel 系列 · 配置声明式归一化
 *
 * 为什么值得单独抽一层：一份插件配置有**三个来处** ——
 * cordis patch 的 config（默认值）、`settings.json`（设置页写的）、设置页的 POST。
 * 任何一个写坏了，都不该让插件带着一个 `NaN` 或 `undefined` 去干活。
 * 手写一遍三四十行 `if (typeof x === 'number')` 是每个新插件最容易出错的地方，
 * 所以这里把它变成一份**声明**。
 *
 * 字段规格（field spec）：
 * ```js
 * const FIELDS = {
 *   enabled: { type: 'boolean', default: true },
 *   throttleSeconds: { type: 'seconds', default: 30, min: 0, max: 3600 },
 *   maxBodyChars: { type: 'number', default: 140, min: 20, max: 500 },
 *   title: { type: 'string', default: '', max: 40 },
 *   soundFile: { type: 'string', default: '', max: 400 },
 *   language: { type: 'enum', default: 'auto', values: ['auto', 'zh', 'en'] },
 * }
 * ```
 * 语义（三条，别改）：
 *   - **只认这些键**。多余的键不进结果，写盘时也不会被写进 settings.json。
 *   - **类型不对就用 `base` 里的值**，不是用 spec 的 default —— 这样
 *     "patch 默认值 → settings.json 覆盖" 的层级语义才成立。
 *   - `enum` 只认白名单里的值；数字一律 **四舍五入** 并夹到 [min, max]。
 *
 * 归一化的结果形状和 `FIELDS` 的键**完全一致**，可以放心当对象用。
 */

/** 数字字段：夹到区间 + 四舍五入。非有限数退回 fallback。 */
function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 字符串字段：去空白 + 截断。非字符串退回 fallback。 */
function pickString(value, maxLen, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed
}

/** 单字段取一个「非 null/undefined 优先」的值。 */
function fieldValue(input, key, base, spec) {
  return input[key] !== undefined && input[key] !== null
    ? input[key]
    : (base[key] !== undefined && base[key] !== null ? base[key] : spec.default)
}

/**
 * 按字段声明造一个归一化函数。
 * @param {Record<string, object>} fields 字段规格
 * @returns {(raw?: Record<string, unknown>, base?: Record<string, unknown>) => Record<string, unknown>}
 */
export function createNormalizer(fields) {
  const keys = Object.keys(fields)
  return function normalize(raw = {}, base = {}) {
    const input = raw && typeof raw === 'object' ? raw : {}
    const out = {}
    for (const key of keys) {
      const spec = fields[key]
      const value = fieldValue(input, key, base, spec)
      switch (spec.type) {
        case 'boolean':
          out[key] = typeof value === 'boolean' ? value : Boolean(spec.default)
          break
        case 'string':
          out[key] = pickString(value, spec.max ?? 400, spec.default)
          break
        case 'enum':
          out[key] = typeof value === 'string' && spec.values.includes(value) ? value : spec.default
          break
        case 'seconds':
        case 'number':
          out[key] = clampNumber(value, spec.min ?? 0, spec.max ?? Number.MAX_SAFE_INTEGER, spec.default)
          break
        default:
          throw new Error(`laurel-core: 未知的字段类型 "${spec.type}"（键 ${key}）`)
      }
    }
    return out
  }
}

/**
 * 从字段声明推出默认值。等价于 `normalize({})`，但意图更直白。
 * @param {Record<string, object>} fields
 */
export function createDefaults(fields) {
  const normalize = createNormalizer(fields)
  return normalize({})
}

/**
 * 只保留字段声明里有的键。
 *
 * 写盘前必须过一遍：免得临时字段（或者设置页多传的东西）被写进 settings.json，
 * 下次启动又被读回来，变成一个"配置里有但没人认"的幽灵键。
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, object>} fields
 */
export function pickKnown(config, fields) {
  const out = {}
  for (const key of Object.keys(fields)) out[key] = config?.[key]
  return out
}
