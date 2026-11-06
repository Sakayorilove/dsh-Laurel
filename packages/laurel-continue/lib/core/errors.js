/**
 * laurel-continue · 失败文本识别规则（纯函数，无 IO）
 *
 * 这些正则认的是**供应商措辞**，不是某个库的私有实现 —— 官方适配器把各家的
 * code/type/message 拼成一个字符串再分类，这里沿用同一套判据。
 *
 * 为什么单独一个文件：上下文超限要同时被「让位规则」和「临时性判定」用到，
 * 两处如果各写一份，早晚会漂移成「一处说超限、另一处说可重试」。
 *
 * Copyright (c) 2026 Clelia
 * SPDX-License-Identifier: MIT
 */

/** 结构化写法：context_length_exceeded / context-window-exceeded / context_window_overflow … */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
  + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
)

/** 请求过大、且直接点名模型上下文。 */
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
  + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
  + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
)

/** "exceeds" 只在宾语明确是模型上下文时才安全。 */
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}`
  + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
  + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
)

/** 最大上下文长度（max context length）。 */
const MAX_CONTEXT = /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i

/** 明确点名的上下文超限字面量。 */
const LITERAL_OVERFLOW = /\b(?:context|token)\s*(?:window|length)?\s*(?:exceeded|overflow)\b/i

/**
 * 这个失败文本是否在说「上下文超限」。
 *
 * @param {string} detail 已拼好的 code/type/message 文本
 * @returns {boolean}
 */
export function isContextOverflowError(detail) {
  if (typeof detail !== 'string' || detail.length === 0) return false
  return STRUCTURED_CONTEXT_OVERFLOW.test(detail)
    || MAX_CONTEXT.test(detail)
    || TOO_LARGE_FOR_CONTEXT.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || EXCEEDS_MODEL_CONTEXT.test(detail)
    || LITERAL_OVERFLOW.test(detail)
}

/**
 * 这个失败文本是否在说「余额/配额耗尽」（不是限流）。
 *
 * 限流（429 too many requests）值得重试；余额耗尽再试一万次也是同一个结果。
 *
 * @param {string} detail
 * @returns {boolean}
 */
export function isQuotaExceededError(detail) {
  if (typeof detail !== 'string' || detail.length === 0) return false
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

/** 本模块识别的判据出口（测试/日志用）。 */
export const ERROR_CLASSIFIERS = Object.freeze({
  isContextOverflowError,
  isQuotaExceededError,
})
