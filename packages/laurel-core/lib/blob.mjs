/**
 * laurel-core/blob —— 内容寻址的不可变正文仓。
 *
 * 纪律：
 *  1. 先持久化正文，再发布引用（写引用的一方必须先等到本函数返回 hash）。
 *  2. 同 hash 只存一份（去重）；写入用 tmp → fsync → rename → fsync(dir)。
 *  3. 只读不删：清理策略是独立操作，不在这里隐式发生。
 *  4. 读取按 hash 校验；hash 不符即报损坏，不当成空。
 */
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, existsSync, readFileSync, renameSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from './format.mjs'

const SHARD = 2

function shardPath(root, hash) {
  return join(root, hash.slice(0, SHARD), hash)
}

/**
 * 写入一段正文，返回 { hash, bytes, deduped }。
 * @param {string} root blobs 根目录
 * @param {Buffer|string} data
 */
export function putBlob(root, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  const hash = sha256(buf)
  const dest = shardPath(root, hash)
  if (existsSync(dest)) {
    const st = statSync(dest)
    if (st.size === buf.length) return { hash, bytes: buf.length, deduped: true }
    // 同 hash 不同长度 = 现有文件损坏；不覆盖，明确报错交给上层隔离
    throw new Error(`blob 损坏：${hash} 期望 ${buf.length} 字节，实际 ${st.size}`)
  }
  mkdirSync(join(root, hash.slice(0, SHARD)), { recursive: true })
  const tmp = join(root, `.tmp-${hash}-${process.pid}-${Date.now()}`)
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, buf)
    fsyncSync(fd)
  } catch (e) {
    // 写入失败（典型是 ENOSPC）时必须删掉半写的临时文件，否则每失败一次就留一个垃圾。
    // 之前这里只有 finally{closeSync}，实测 ENOSPC 后 blobs/ 下会残留 .tmp-* 文件。
    try { closeSync(fd) } catch { /* 已关或关闭失败都继续清理 */ }
    try { unlinkSync(tmp) } catch { /* 清理失败不掩盖原始错误 */ }
    throw e
  } finally {
    // 正常路径与异常路径都要保证 fd 关闭；重复 close 会抛 EBADF，吞掉即可
    try { closeSync(fd) } catch { /* 已在 catch 里关过 */ }
  }
  renameSync(tmp, dest)
  // 目录持久化：rename 的可见性靠目录项刷盘
  try {
    const dfd = openSync(join(root, hash.slice(0, SHARD)), 'r')
    try { fsyncSync(dfd) } finally { closeSync(dfd) }
  } catch { /* 部分平台不支持对目录 fsync，记录在平台限制里 */ }
  return { hash, bytes: buf.length, deduped: false }
}

/** 读正文并校验 hash。 */
export function getBlob(root, hash) {
  const p = shardPath(root, hash)
  if (!existsSync(p)) return { ok: false, reason: 'missing', hash }
  const buf = readFileSync(p)
  const actual = sha256(buf)
  if (actual !== hash) return { ok: false, reason: 'corrupt', hash, actual }
  return { ok: true, hash, bytes: buf.length, data: buf }
}

export function hasBlob(root, hash) {
  return existsSync(shardPath(root, hash))
}

/** 枚举全部 blob（用于打包与闭包校验）。 */
export function listBlobs(root) {
  const out = []
  if (!existsSync(root)) return out
  for (const shard of readdirSync(root)) {
    const dir = join(root, shard)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.tmp-')) continue
      out.push({ hash: name, bytes: statSync(join(dir, name)).size })
    }
  }
  return out
}
