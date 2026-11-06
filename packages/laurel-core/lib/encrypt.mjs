/**
 * laurel-core/encrypt —— 搬家包加密（S03 补全）。
 *
 * 设计：
 *   - 口令派生用 scrypt（Node 内置 crypto，无第三方依赖）
 *   - 加密用 AES-256-GCM（带认证，篡改会失败而不是给出垃圾）
 *   - 包格式：可选的外层信封，内层仍是原 ZIP
 *   - **不支持"忘记密码找回"**：没有后门，密码丢了就是丢了
 *
 * 信封格式（纯二进制，简单可校验）：
 *   magic  8B  "LAURELEN"
 *   version 1B 0x01
 *   kdf    1B  0x01 = scrypt
 *   logN   1B  scrypt cost log2 (默认 15 → 32768)
 *   r      1B  scrypt block size (8)
 *   p      1B  scrypt parallelization (1)
 *   salt  16B
 *   iv    12B
 *   tag   16B
 *   ciphertext (rest)
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'

export const ENC_MAGIC = Buffer.from('LAURELEN', 'ascii')
export const ENC_VERSION = 1
export const ENC_EXT = '.laurel-core.enc'

const HEADER_LEN = 8 + 1 + 1 + 1 + 1 + 1 + 16 + 12 + 16

/** 是不是加密信封（用于 CLI 自动识别）。 */
export function isEncrypted(buf) {
  return Buffer.isBuffer(buf) && buf.length > ENC_MAGIC.length && buf.subarray(0, 8).equals(ENC_MAGIC)
}

function deriveKey(password, salt, { logN = 15, r = 8, p = 1 } = {}) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new TypeError('口令至少 8 个字符（更短的口令 scrypt 也救不回来）')
  }
  const N = 1 << logN
  // maxmem 要够：scrypt 需要 128*N*r 字节
  const maxmem = 128 * N * r * 2
  return scryptSync(password, salt, 32, { N, r, p, maxmem })
}

/** 加密一个已存在的包。返回 {ok, bytes, sha256, plainSha256}。 */
export function encryptArchive(plainBuf, password, opts = {}) {
  if (!Buffer.isBuffer(plainBuf) || plainBuf.length === 0) throw new TypeError('待加密内容为空')
  const logN = opts.logN ?? 15
  const r = opts.r ?? 8
  const p = opts.p ?? 1
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(password, salt, { logN, r, p })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()])
  const tag = cipher.getAuthTag()
  const header = Buffer.alloc(HEADER_LEN)
  let o = 0
  ENC_MAGIC.copy(header, o); o += 8
  header[o++] = ENC_VERSION
  header[o++] = 0x01                 // kdf = scrypt
  header[o++] = logN
  header[o++] = r
  header[o++] = p
  salt.copy(header, o); o += 16
  iv.copy(header, o); o += 12
  tag.copy(header, o)
  return Buffer.concat([header, ciphertext])
}

/** 解密。密码错或内容被改 → 抛错（不是返回垃圾）。 */
export function decryptArchive(encBuf, password) {
  if (!isEncrypted(encBuf)) throw new Error('不是 Laurel 加密包（magic 不匹配）')
  let o = 8
  const version = encBuf[o++]
  const kdf = encBuf[o++]
  const logN = encBuf[o++]
  const r = encBuf[o++]
  const p = encBuf[o++]
  if (version !== ENC_VERSION) throw new Error(`加密包版本不支持: ${version}`)
  if (kdf !== 0x01) throw new Error(`KDF 不支持: ${kdf}`)
  const salt = encBuf.subarray(o, o + 16); o += 16
  const iv = encBuf.subarray(o, o + 12); o += 12
  const tag = encBuf.subarray(o, o + 16); o += 16
  const ciphertext = encBuf.subarray(o)
  const key = deriveKey(password, salt, { logN, r, p })
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  try {
    return Buffer.concat([d.update(ciphertext), d.final()])
  } catch {
    // GCM 校验失败：密码错 或 内容被改，两者无法区分（也不该区分）
    throw new Error('解密失败：口令错误或文件已被篡改')
  }
}

/** 元信息（不含密钥材料），用于界面显示与诊断。 */
export function encryptInfo(encBuf) {
  if (!isEncrypted(encBuf)) return null
  let o = 8
  const version = encBuf[o++]
  const kdf = encBuf[o++]
  const logN = encBuf[o++]
  const r = encBuf[o++]
  const p = encBuf[o++]
  return { version, kdf: kdf === 1 ? 'scrypt' : `unknown(${kdf})`, logN, r, p, saltBytes: 16, ivBytes: 12, tagBytes: 16, ciphertextBytes: encBuf.length - HEADER_LEN }
}

/** 口令强度提示（只给建议，不阻止）。 */
export function passwordHints(password) {
  const hints = []
  if (typeof password !== 'string' || password.length < 8) hints.push('少于 8 个字符')
  if (!/[a-zA-Z]/.test(password ?? '')) hints.push('没有字母')
  if (!/\d/.test(password ?? '')) hints.push('没有数字')
  if (!/[^\w\s]/.test(password ?? '')) hints.push('没有符号')
  if ((password ?? '').length < 12) hints.push('建议至少 12 位')
  return { ok: hints.length === 0, hints }
}
