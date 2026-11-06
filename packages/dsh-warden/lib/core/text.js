/**
 * dsh-warden · 文本与指纹小工具
 *
 * 只有 node 内置依赖。这里的函数都是**纯函数**，方便离线单测。
 */

import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { HASH_ALGORITHM_VERSION } from './config.js'

/**
 * 粗略的 token 估算。
 *
 * ⚠ 只用于**显示**和"够不够大"的量级判断，绝不拿去记账。
 * 真正的水位数字只认宿主上报的用量（见 `host/inject.js` 的 `cacheSample`）。
 *
 * 规则：CJK 一个字算 1，其余按 4 字符算 1。这是社区通行口径，
 * 对"这段是不是变长了"这类判断足够准，对精确计费不够准 —— 所以不用于计费。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code >= 0x2e80 && code <= 0x9fff) cjk++
    else if (code >= 0xf900 && code <= 0xfaff) cjk++
    else if (code >= 0xff00 && code <= 0xffef) cjk++
  }
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}

/**
 * 完整 sha256（十六进制）。
 *
 * ⚠ **字节就是字节**（R5）。旧实现是
 * `createHash('sha256').update(String(value ?? ''), 'utf8')` ——
 * 把 Buffer 先 `String()` 一遍。Buffer 的 `toString()` 按 UTF-8 解码，
 * 非法字节序列（例如单字节 `0x80`、`0x81`）统统变成 U+FFFD 替换字符，
 * 于是**两个不同的文件得到同一个 hash**，而且和 `sha256sum` 对不上。
 * exe / dll / 图片这些主要验收产物全是二进制，等于指纹全废。
 *
 * 现在：Buffer / TypedArray / ArrayBuffer / DataView 直接喂给 hash；
 * 只有真正的字符串才按 UTF-8 编码。
 *
 * @param {string|Buffer|Uint8Array|ArrayBuffer|DataView|null|undefined} value
 * @returns {string} 64 位十六进制
 */
export function sha256Hex(value) {
  const hash = createHash('sha256')
  if (value === null || value === undefined) {
    hash.update('', 'utf8')
  } else if (typeof value === 'string') {
    hash.update(value, 'utf8')
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    hash.update(value)
  } else if (value instanceof ArrayBuffer) {
    hash.update(Buffer.from(value))
  } else if (ArrayBuffer.isView(value)) {
    hash.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  } else {
    // 既不是字节也不是字符串：明确按 JSON 规范化后再 hash，
    // 绝不悄悄 String() 出一个"看起来像指纹"的东西。
    hash.update(JSON.stringify(value) ?? '', 'utf8')
  }
  return hash.digest('hex')
}

/** 指纹算法版本。写进台账，旧版本的记录不能被无条件继承为有效。 */
export const HASH_ALGORITHM = `sha256-bytes-v${HASH_ALGORITHM_VERSION}`

/**
 * 算一个文件的字节级 sha256。
 *
 * 整块读进内存（本插件的产物都是 MB 级，不值得上流式），
 * **读不到就抛** —— 调用方必须把它变成 `error` 状态，不能当"有效"。
 *
 * @param {string} fullPath 已解析的绝对路径
 * @returns {{hash: string, algorithm: string, bytes: number, mtimeMs: number}}
 */
export function sha256File(fullPath) {
  const data = readFileSync(fullPath)
  const stat = statSync(fullPath)
  return {
    hash: sha256Hex(data),
    algorithm: HASH_ALGORITHM,
    bytes: data.length,
    mtimeMs: stat.mtimeMs,
  }
}

/** 流式版本：只给超大产物用，避免一次性占内存。 */
export function sha256FileStream(fullPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let bytes = 0
    const stream = createReadStream(fullPath)
    stream.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk) })
    stream.on('error', reject)
    stream.on('end', () => resolve({ hash: hash.digest('hex'), algorithm: HASH_ALGORITHM, bytes }))
  })
}

/** 短指纹：取 sha256 前 12 位，够人类肉眼比对。 */
export function shortHash(value) {
  return sha256Hex(value).slice(0, 12)
}

/**
 * 把一次工具调用压成一个稳定的键（用于"同一条命令跑了几次"）。
 *
 * 为什么不用 JSON.stringify 直接当键：参数里的键顺序会变、空白会变，
 * 而 `{a:1,b:2}` 与 `{b:2,a:1}` 是同一件事。所以按键名排序后再序列化。
 * 字符串参数直接原样参与（命令原文就是它本身）。
 */
export function stableKey(name, rawArguments) {
  let normalized = rawArguments
  if (rawArguments && typeof rawArguments === 'object') {
    normalized = sortDeep(rawArguments)
  } else if (typeof rawArguments === 'string') {
    const trimmed = rawArguments.trim()
    // 是 JSON 就规整一下，不是就按原文本（去掉多余空白）。
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { normalized = sortDeep(JSON.parse(trimmed)) } catch { normalized = trimmed.replace(/\s+/g, ' ') }
    } else {
      normalized = trimmed.replace(/\s+/g, ' ')
    }
  }
  let body
  try { body = JSON.stringify(normalized) } catch { body = String(normalized) }
  return `${name}::${body ?? ''}`
}

/** 递归按键名排序，让对象序列化结果稳定。数组保持顺序（顺序通常是语义的一部分）。 */
function sortDeep(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => sortDeep(item, depth + 1))
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key], depth + 1)
  return out
}

/**
 * 从工具参数里尽力挖出"这次动的是哪个文件/目录"。
 *
 * 为什么需要它：共享目录锁要判"这次写的是不是被锁的那片地方"，
 * 而不同工具的参数名不一样（`file_path` / `path` / `target_file` / `notebook_path`…）。
 * 挖不到就返回空字符串 —— **拿不准就不拦**（fail-open）。
 */
export function extractPath(rawArguments) {
  let args = rawArguments
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (!trimmed.startsWith('{')) return ''
    try { args = JSON.parse(trimmed) } catch { return '' }
  }
  if (!args || typeof args !== 'object') return ''
  for (const key of ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'notebook_path', 'cwd', 'directory', 'dir']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/** 把一段可能很长的文本压成一行，用于日志与提醒。 */
export function oneLine(text, max = 120) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * 从参数里读出"这次只取了哪一段"（R6）。
 *
 * ── 为什么需要它 ───────────────────────────────────────────────────────
 * 旧版只按**路径**累计次数，于是"分九次读一个大文件的九个不同片段"
 * 被当成"同一个文件读了九次"，连发三次重复读提醒 —— 而那恰恰是**正确**
 * 的省上下文做法。读取区间必须参与身份判定。
 *
 * 覆盖宿主与常见插件用过的字段名；读不出来返回 null（按"整份读取"处理）。
 *
 * @returns {{offset: number|null, limit: number|null, pattern: string|null}|null}
 */
export function readRangeOf(rawArguments) {
  let args = rawArguments
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return null }
  }
  if (!args || typeof args !== 'object') return null
  const num = (...keys) => {
    for (const key of keys) {
      const value = Number(args[key])
      if (args[key] !== undefined && Number.isFinite(value)) return value
    }
    return null
  }
  const offset = num('offset', 'line_offset', 'start_line', 'startLine', 'from', 'skip')
  const limit = num('limit', 'line_limit', 'end_line', 'endLine', 'count', 'take', 'lines', 'max_lines')
  const pattern = typeof args.pattern === 'string' ? args.pattern
    : typeof args.query === 'string' ? args.query
      : typeof args.regex === 'string' ? args.regex
        : typeof args.glob === 'string' ? args.glob
          : null
  if (offset === null && limit === null && pattern === null) return null
  return { offset, limit, pattern }
}

/** 把读取区间压成稳定的字符串，参与调用指纹。 */
export function readRangeKey(range) {
  if (!range) return 'full'
  const parts = []
  if (range.offset !== null) parts.push(`o${range.offset}`)
  if (range.limit !== null) parts.push(`l${range.limit}`)
  if (range.pattern !== null) parts.push(`p${range.pattern}`)
  return parts.length > 0 ? parts.join('|') : 'full'
}

/**
 * 一次工具调用的完整指纹：工具名 + 规范化参数 + 读取区间。
 *
 * 与 `stableKey` 的区别：`stableKey` 只规范化参数，这里额外把区间显式拼进去，
 * 保证"同文件不同片段"一定得到不同的键。
 */
export function callFingerprint(name, rawArguments) {
  return `${stableKey(name, rawArguments)}#${readRangeKey(readRangeOf(rawArguments))}`
}

/**
 * 一次工具**结果**的指纹。
 *
 * 用途：区分"原样失败"与"换了方法的失败"。同一个失败签名反复出现才是空转；
 * 失败内容变了（哪怕只是错误信息里多了一行定位）就是新证据。
 *
 * 只取结构与文本，不取时间戳 —— **不同的日志时间戳不算进展**（R6）。
 */
export function resultFingerprint(result) {
  if (!result || typeof result !== 'object') return sha256Hex(String(result ?? '')).slice(0, 16)
  const parts = []
  parts.push(result.isError ? 'error' : 'ok')
  if (result.error?.message) parts.push(String(result.error.message))
  if (result.error?.code) parts.push(String(result.error.code))
  const content = result.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (block?.type) parts.push(`<${block.type}>`)
    }
  } else if (typeof content === 'string') {
    parts.push(content)
  }
  // 抹掉纯时间戳与随机 id：它们每次都变，但不代表有新证据。
  const normalized = parts.join('\n')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<clock>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    // commit sha / 内容 sha256 / 构建号：每次构建都变，但不是新证据（P2-3）。
    // 只加这一条遮蔽；错误信息结构一个字节都不动 —— 这条指纹同时被失败签名
    // 与「新证据」判定使用，改宽了会让失败分型变钝。
    .replace(/\b[0-9a-f]{40,64}\b/gi, '<hash>')
  return sha256Hex(normalized).slice(0, 16)
}

/**
 * 从一个失败信息里抠出"错误类别"（R8 的工具错误分型）。
 *
 * 分型的意义：不同类别该走完全不同的路。能力不支持要换通道，
 * 认证缺失要找用户，路径环境要换执行面 —— 一律"再试一次"是最贵的做法。
 */
export function classifyToolError(message) {
  const text = String(message ?? '')
  if (/unknown tool|no such tool|tool .* not found|工具不存在|not supported|unsupported/i.test(text)) return 'capability'
  if (/EPERM|EACCES|permission denied|access is denied|unauthorized|401|403|authentication|credential/i.test(text)) return 'auth'
  if (/ENOENT|ENOTDIR|no such file|cannot find|路径|ENOTSUP|GetFileSecurityW|UNC/i.test(text)) return 'path-env'
  if (/old_string was not found|old_string matched \d+ times|String to replace not found|No exact match found/i.test(text)) return 'edit-miss'
  if (/ETIMEDOUT|timeout|timed out|ECONNRESET|ECONNREFUSED|network|socket hang up/i.test(text)) return 'transient'
  if (/WARDEN_RESOURCE_CONFLICT|正被另一个会话占用|resource conflict|locked by/i.test(text)) return 'resource-conflict'
  if (/schema|validation|invalid_type|required/i.test(text)) return 'contract'
  return 'business'
}

/** 错误类别对应的中文说明与"接下来该做什么"。 */
export const ERROR_CLASS_HINTS = {
  capability: '这个能力当前路由/宿主**不支持**。不要原地重试 —— 换一个已支持的通道，或直接把限制报给用户。',
  auth: '缺认证或权限。这是**人要处理的事**：把具体缺什么报给用户，不要尝试扩大权限或绕过。',
  'path-env': '路径或执行环境不对（常见于 Windows 工具写 WSL/UNC 路径）。确定一条可用的路径与执行面，别反复读写试错。',
  'edit-miss': '你手里的原文已经过时。先重读要改的那一段，用**现在的**原文去匹配。',
  transient: '超时/网络类瞬时错误。可以重试一次；连续失败就换方法或报告阻塞。',
  'resource-conflict': '资源被别的会话占着。先做不依赖它的独立工作，或改用自己的隔离目录/部署目标。',
  contract: '参数或输出不符合契约。按报错里点名的字段改，不要猜。',
  business: '业务本身的失败。先判断这是不是一条**新**的失败定位 —— 是就继续，不是就换假设。',
}

