import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual
} from 'node:crypto'

import { AppError } from '@shared/errors'

export interface ScryptParams {
  N: number
  r: number
  p: number
}

/** scrypt 参数：2^17 约 128 MiB 内存、单次约 0.5–1s，桌面端可接受 */
export const SCRYPT_PARAMS: ScryptParams = { N: 131_072, r: 8, p: 1 }
export const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  params: ScryptParams
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem 需要比 128 * N * r 更大，否则 Node 会拒绝这次派生
    const maxmem = 128 * params.N * params.r * 2
    scrypt(
      password.normalize('NFC'),
      salt,
      keylen,
      { N: params.N, r: params.r, p: params.p, maxmem },
      (error, derived) => {
        if (error) {
          reject(new AppError('UNKNOWN', '密钥派生失败'))
          return
        }
        resolve(Buffer.from(derived))
      }
    )
  })
}

export function randomBytesBuffer(size: number): Buffer {
  return randomBytes(size)
}

export function randomUuid(): string {
  return randomUUID()
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function newSalt(): Buffer {
  return randomBytes(SALT_BYTES)
}

/** KEK = scrypt(password, salt) */
export function deriveKek(
  password: string,
  salt: Buffer,
  params: ScryptParams = SCRYPT_PARAMS
): Promise<Buffer> {
  if (salt.length < 8) throw new AppError('INVALID_INPUT', 'salt 太短')
  return scryptAsync(password, salt, KEY_BYTES, params)
}

/** HKDF 从 DEK 派生子密钥；用途由 info 区分，绝不跨用途复用 */
export function deriveSubkey(dek: Buffer, vaultId: string, info: string): Buffer {
  const derived = hkdfSync('sha256', dek, Buffer.from(vaultId, 'utf8'), Buffer.from(info, 'utf8'), KEY_BYTES)
  return Buffer.from(derived)
}

export function derivePayloadKey(dek: Buffer, vaultId: string): Buffer {
  return deriveSubkey(dek, vaultId, 'payload-v1')
}

export function deriveAttachmentKey(dek: Buffer, vaultId: string): Buffer {
  return deriveSubkey(dek, vaultId, 'attachment-v1')
}

export interface GcmBlock {
  alg: 'AES-256-GCM'
  iv: string
  ciphertext: string
  tag: string
}

export function encryptGcm(key: Buffer, plaintext: Buffer, aad: Buffer | string): GcmBlock {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(typeof aad === 'string' ? Buffer.from(aad, 'utf8') : aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: tag.toString('base64')
  }
}

export function decryptGcm(key: Buffer, block: GcmBlock, aad: Buffer | string): Buffer {
  try {
    const iv = Buffer.from(block.iv, 'base64')
    const tag = Buffer.from(block.tag, 'base64')
    const ciphertext = Buffer.from(block.ciphertext, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(typeof aad === 'string' ? Buffer.from(aad, 'utf8') : aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new AppError('WRONG_PASSWORD')
  }
}

/** 加密固定长度数据（DEK 包裹用） */
export function encryptSecret(key: Buffer, plaintext: Buffer, aad: string): GcmBlock {
  return encryptGcm(key, plaintext, aad)
}

export function decryptSecret(key: Buffer, block: GcmBlock, aad: string): Buffer {
  const result = decryptGcm(key, block, aad)
  if (result.length !== KEY_BYTES) throw new AppError('WRONG_PASSWORD')
  return result
}

/** 便于测试与清理：把密钥缓冲区清零 */
export function wipe(buffer: Buffer | null | undefined): void {
  if (buffer) buffer.fill(0)
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

export function uuidToBytes(uuid: string): Buffer {
  const clean = uuid.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(clean)) throw new AppError('INVALID_INPUT', '非法 UUID')
  const bytes = Buffer.from(clean, 'hex')
  if (bytes.length !== 16) throw new AppError('INVALID_INPUT', '非法 UUID')
  return bytes
}

export function bytesToUuid(bytes: Buffer): string {
  if (bytes.length !== 16) throw new AppError('INVALID_INPUT', 'UUID 长度错误')
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
