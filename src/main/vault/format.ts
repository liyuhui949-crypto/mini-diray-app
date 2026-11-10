import { z } from 'zod'

import { AppError } from '@shared/errors'
import { vaultDataSchema } from '@shared/schemas'
import type { VaultData } from '@shared/types'

import {
  KEY_BYTES,
  SCRYPT_PARAMS,
  type ScryptParams,
  decryptSecret,
  deriveKek,
  derivePayloadKey,
  encryptSecret,
  encryptGcm,
  decryptGcm,
  newSalt,
  randomBytesBuffer,
  randomUuid,
  wipe
} from './crypto'

export const VAULT_MAGIC = 'MINIDIARY'
/** 当前支持写入的容器格式版本 */
export const SUPPORTED_FORMAT_VERSION = 1
export const SUPPORTED_SCHEMA_VERSION = 1
export const VAULT_FILE_NAME = 'diary.vault'

const kdfSchema = z.object({
  name: z.literal('scrypt'),
  N: z.number().int().positive(),
  r: z.number().int().positive(),
  p: z.number().int().positive(),
  salt: z.string().min(1)
})

const cipherBlockSchema = z.object({
  alg: z.literal('AES-256-GCM'),
  iv: z.string().min(1),
  ciphertext: z.string(),
  tag: z.string().min(1)
})

export const vaultEnvelopeSchema = z.object({
  magic: z.literal(VAULT_MAGIC),
  formatVersion: z.number().int().positive(),
  vaultId: z.string().min(1),
  createdAt: z.string().min(1),
  kdf: kdfSchema,
  keyWrap: cipherBlockSchema,
  payload: cipherBlockSchema
})

export type KdfDescriptor = z.infer<typeof kdfSchema>
export type CipherBlock = z.infer<typeof cipherBlockSchema>
export type VaultEnvelope = z.infer<typeof vaultEnvelopeSchema>

export function keyWrapAad(kdf: KdfDescriptor): string {
  // 绑定 KDF 参数：改动迭代次数或 salt 会让 DEK 解包失败
  return `${VAULT_MAGIC}|keyWrap|1|${kdf.name}|${kdf.N}|${kdf.r}|${kdf.p}|${kdf.salt}`
}

export function payloadAad(vaultId: string): string {
  return `${VAULT_MAGIC}|payload|1|${vaultId}`
}

export function serializeEnvelope(envelope: VaultEnvelope): string {
  return JSON.stringify(envelope)
}

export function parseEnvelope(text: string): VaultEnvelope {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new AppError('CORRUPT_VAULT')
  }
  const parsed = vaultEnvelopeSchema.safeParse(raw)
  if (!parsed.success) throw new AppError('CORRUPT_VAULT')
  if (parsed.data.formatVersion > SUPPORTED_FORMAT_VERSION) {
    throw new AppError('VAULT_VERSION_TOO_NEW')
  }
  return parsed.data
}

export function assertSupportedSchema(data: VaultData): void {
  if (data.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new AppError('VAULT_VERSION_TOO_NEW')
  }
}

interface CreateOptions {
  password: string
  data: VaultData
  /** 仅测试使用：注入固定 salt，避免每次派生耗时 */
  salt?: Buffer
  /** 仅测试使用：降低 KDF 成本，生产永远用 SCRYPT_PARAMS */
  scrypt?: ScryptParams
}

export interface NewEnvelope {
  envelope: VaultEnvelope
  dek: Buffer
}

/** 创建信封：随机 DEK，用 KEK 包裹，并用 payloadKey 加密整个 VaultData */
export async function createEnvelope(options: CreateOptions): Promise<NewEnvelope> {
  const salt = options.salt ?? newSalt()
  const scryptParams = options.scrypt ?? SCRYPT_PARAMS
  const kdf: KdfDescriptor = {
    name: 'scrypt',
    N: scryptParams.N,
    r: scryptParams.r,
    p: scryptParams.p,
    salt: salt.toString('base64')
  }
  const dek = randomBytesBuffer(KEY_BYTES)

  const kek = await deriveKek(options.password, salt, kdf)
  try {
    const keyWrap = encryptSecret(kek, dek, keyWrapAad(kdf))
    const payloadKey = derivePayloadKey(dek, options.data.vaultId)
    try {
      const payload = encryptGcm(payloadKey, Buffer.from(JSON.stringify(options.data), 'utf8'), payloadAad(options.data.vaultId))
      return {
        dek,
        envelope: {
          magic: VAULT_MAGIC,
          formatVersion: SUPPORTED_FORMAT_VERSION,
          vaultId: options.data.vaultId,
          createdAt: options.data.createdAt,
          kdf,
          keyWrap,
          payload
        }
      }
    } finally {
      wipe(payloadKey)
    }
  } finally {
    wipe(kek)
  }
}

export interface OpenedEnvelope {
  data: VaultData
  dek: Buffer
  payloadAad: string
}

/** 解开信封；错误密码与损坏统一抛 WRONG_PASSWORD（不泄露是哪一步失败） */
export async function openEnvelope(envelope: VaultEnvelope, password: string): Promise<OpenedEnvelope> {
  const salt = Buffer.from(envelope.kdf.salt, 'base64')
  const kek = await deriveKek(password, salt, envelope.kdf)
  let dek: Buffer
  try {
    dek = decryptSecret(kek, envelope.keyWrap, keyWrapAad(envelope.kdf))
  } catch {
    throw new AppError('WRONG_PASSWORD')
  } finally {
    wipe(kek)
  }

  const payloadKey = derivePayloadKey(dek, envelope.vaultId)
  let data: VaultData
  try {
    const plaintext = decryptGcm(payloadKey, envelope.payload, payloadAad(envelope.vaultId))
    const parsed = vaultDataSchema.safeParse(JSON.parse(plaintext.toString('utf8')))
    if (!parsed.success) throw new AppError('CORRUPT_VAULT')
    data = parsed.data as VaultData
  } catch (error) {
    wipe(dek)
    if (error instanceof AppError) throw error
    throw new AppError('CORRUPT_VAULT')
  } finally {
    wipe(payloadKey)
  }

  assertSupportedSchema(data)
  return { data, dek, payloadAad: payloadAad(envelope.vaultId) }
}

/** 用新密码重新包裹 DEK；payload 密文与附件密文保持不变 */
export async function rewrapEnvelope(
  envelope: VaultEnvelope,
  dek: Buffer,
  newPassword: string,
  params: ScryptParams = SCRYPT_PARAMS
): Promise<VaultEnvelope> {
  const salt = newSalt()
  const kdf: KdfDescriptor = {
    name: 'scrypt',
    N: params.N,
    r: params.r,
    p: params.p,
    salt: salt.toString('base64')
  }
  const kek = await deriveKek(newPassword, salt, kdf)
  try {
    return {
      ...envelope,
      kdf,
      keyWrap: encryptSecret(kek, dek, keyWrapAad(kdf))
    }
  } finally {
    wipe(kek)
  }
}

/** 数据更新后重新加密 payload（复用同一个 DEK） */
export function sealPayload(envelope: VaultEnvelope, dek: Buffer, data: VaultData): VaultEnvelope {
  const payloadKey = derivePayloadKey(dek, envelope.vaultId)
  try {
    const payload = encryptGcm(
      payloadKey,
      Buffer.from(JSON.stringify(data), 'utf8'),
      payloadAad(envelope.vaultId)
    )
    return { ...envelope, payload }
  } finally {
    wipe(payloadKey)
  }
}

export function createVaultData(now: Date = new Date()): VaultData {
  const iso = now.toISOString()
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    vaultId: randomUuid(),
    createdAt: iso,
    updatedAt: iso,
    entries: []
  }
}

/** .inkatt 的公钥+私钥信封：只包裹 DEK，不包含 payload */
export const PACKAGE_KEY_MAGIC = 'MINIDIARY-PACKAGE-KEY'
export const PACKAGE_KEY_VERSION = 1

export interface PackageKeyEnvelope {
  magic: typeof PACKAGE_KEY_MAGIC
  formatVersion: number
  vaultId: string
  createdAt: string
  kdf: KdfDescriptor
  keyWrap: CipherBlock
}

export const packageKeyEnvelopeSchema = z.object({
  magic: z.literal(PACKAGE_KEY_MAGIC),
  formatVersion: z.literal(PACKAGE_KEY_VERSION),
  vaultId: z.string().min(1),
  createdAt: z.string().min(1),
  kdf: kdfSchema,
  keyWrap: cipherBlockSchema
})

function packageKeyAad(kdf: KdfDescriptor, vaultId: string): string {
  return `${PACKAGE_KEY_MAGIC}|keyWrap|${PACKAGE_KEY_VERSION}|${vaultId}|${kdf.name}|${kdf.N}|${kdf.r}|${kdf.p}|${kdf.salt}`
}

/** 用「公钥+私钥」组合口令包裹 DEK；用于附件包，不改变原 vault */
export async function createPackageKeyEnvelope(
  envelope: VaultEnvelope,
  dek: Buffer,
  secret: string,
  params: ScryptParams = SCRYPT_PARAMS
): Promise<PackageKeyEnvelope> {
  const salt = newSalt()
  const kdf: KdfDescriptor = {
    name: 'scrypt',
    N: params.N,
    r: params.r,
    p: params.p,
    salt: salt.toString('base64')
  }
  const kek = await deriveKek(secret, salt, kdf)
  try {
    return {
      magic: PACKAGE_KEY_MAGIC,
      formatVersion: PACKAGE_KEY_VERSION,
      vaultId: envelope.vaultId,
      createdAt: new Date().toISOString(),
      kdf,
      keyWrap: encryptSecret(kek, dek, packageKeyAad(kdf, envelope.vaultId))
    }
  } finally {
    wipe(kek)
  }
}

/** 解开附件包信封，返回 DEK；公钥/私钥错误统一 WRONG_PASSWORD */
export async function openPackageKeyEnvelope(
  keyEnvelope: PackageKeyEnvelope,
  secret: string
): Promise<Buffer> {
  if (
    keyEnvelope.magic !== PACKAGE_KEY_MAGIC ||
    keyEnvelope.formatVersion !== PACKAGE_KEY_VERSION ||
    !keyEnvelope.vaultId ||
    !keyEnvelope.kdf
  ) {
    throw new AppError('WRONG_PASSWORD')
  }
  const salt = Buffer.from(keyEnvelope.kdf.salt, 'base64')
  const { N, r, p } = keyEnvelope.kdf
  // 包可能来自外部：限制 KDF 参数，避免恶意包用超大 N 造成内存/CPU DoS
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 2 ** 14 ||
    N > 2 ** 19 ||
    r < 1 ||
    r > 16 ||
    p < 1 ||
    p > 8 ||
    salt.length < 8 ||
    salt.length > 64
  ) {
    throw new AppError('WRONG_PASSWORD')
  }
  const kek = await deriveKek(secret, salt, keyEnvelope.kdf)
  try {
    return decryptSecret(kek, keyEnvelope.keyWrap, packageKeyAad(keyEnvelope.kdf, keyEnvelope.vaultId))
  } finally {
    wipe(kek)
  }
}

/** 迁移包里的 `vault.inkv` 与本地信封结构一致，这里只需换一个文件名 */
export const MIGRATION_VAULT_MEMBER = 'vault.inkv'
