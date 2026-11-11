import { z } from 'zod'

import { AppError } from '@shared/errors'

import {
  KEY_BYTES,
  SCRYPT_PARAMS,
  type ScryptParams,
  decryptGcm,
  decryptSecret,
  deriveKek,
  encryptGcm,
  encryptSecret,
  newSalt,
  wipe
} from './crypto'
import { cipherBlockSchema, kdfSchema, type KdfDescriptor } from './format'

const KEY_BACKUP_MAGIC = 'MINIDIARY-KEY-BACKUP'
const KEY_BACKUP_VERSION = 1

const keyBackupSyncSchema = z.object({
  repo: z.string().min(1),
  branch: z.string().min(1)
})

const keyBackupSchema = z.object({
  magic: z.literal(KEY_BACKUP_MAGIC),
  formatVersion: z.literal(KEY_BACKUP_VERSION),
  vaultId: z.string().min(1),
  createdAt: z.string().min(1),
  kdf: kdfSchema,
  keyWrap: cipherBlockSchema,
  /** 仓库地址/分支加密块；不含 token、代理 */
  sync: cipherBlockSchema.optional()
})

export type KeyBackup = z.infer<typeof keyBackupSchema>
interface KeyBackupSync {
  repo: string
  branch: string
}
interface OpenedKeyBackup {
  dek: Buffer
  sync: KeyBackupSync | null
}

function keyBackupAad(kdf: KdfDescriptor, vaultId: string): string {
  return `${KEY_BACKUP_MAGIC}|keyWrap|${KEY_BACKUP_VERSION}|${vaultId}|${kdf.name}|${kdf.N}|${kdf.r}|${kdf.p}|${kdf.salt}`
}

function keyBackupSyncAad(kdf: KdfDescriptor, vaultId: string): string {
  return `${KEY_BACKUP_MAGIC}|sync|${KEY_BACKUP_VERSION}|${vaultId}|${kdf.name}|${kdf.N}|${kdf.r}|${kdf.p}|${kdf.salt}`
}

function validateKdf(kdf: KdfDescriptor): void {
  const { N, r, p } = kdf
  const salt = Buffer.from(kdf.salt, 'base64')
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
    throw new AppError('KEY_BACKUP_INVALID')
  }
}

/** 用备份密码包裹 DEK；sync 块加密携带仓库/分支，不含 token、代理或正文 */
export async function createKeyBackup(options: {
  vaultId: string
  dek: Buffer
  password: string
  sync?: KeyBackupSync
  scrypt?: ScryptParams
}): Promise<KeyBackup> {
  if (options.dek.length !== KEY_BYTES) throw new AppError('KEY_BACKUP_INVALID')
  const params = options.scrypt ?? SCRYPT_PARAMS
  const salt = newSalt()
  const kdf: KdfDescriptor = {
    name: 'scrypt',
    N: params.N,
    r: params.r,
    p: params.p,
    salt: salt.toString('base64')
  }
  const kek = await deriveKek(options.password, salt, kdf)
  try {
    return {
      magic: KEY_BACKUP_MAGIC,
      formatVersion: KEY_BACKUP_VERSION,
      vaultId: options.vaultId,
      createdAt: new Date().toISOString(),
      kdf,
      keyWrap: encryptSecret(kek, options.dek, keyBackupAad(kdf, options.vaultId)),
      ...(options.sync
        ? {
            sync: encryptGcm(
              kek,
              Buffer.from(JSON.stringify(options.sync), 'utf8'),
              keyBackupSyncAad(kdf, options.vaultId)
            )
          }
        : {})
    }
  } finally {
    wipe(kek)
  }
}

export function parseKeyBackup(text: string): KeyBackup {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new AppError('KEY_BACKUP_INVALID')
  }
  const parsed = keyBackupSchema.safeParse(raw)
  if (!parsed.success) throw new AppError('KEY_BACKUP_INVALID')
  validateKdf(parsed.data.kdf)
  return parsed.data
}

export async function openKeyBackup(
  backup: KeyBackup,
  password: string
): Promise<OpenedKeyBackup> {
  validateKdf(backup.kdf)
  const salt = Buffer.from(backup.kdf.salt, 'base64')
  const kek = await deriveKek(password, salt, backup.kdf)
  try {
    const dek = decryptSecret(kek, backup.keyWrap, keyBackupAad(backup.kdf, backup.vaultId))
    if (dek.length !== KEY_BYTES) {
      wipe(dek)
      throw new AppError('KEY_BACKUP_INVALID')
    }
    let sync: KeyBackupSync | null = null
    if (backup.sync) {
      try {
        const parsed = keyBackupSyncSchema.safeParse(
          JSON.parse(
            decryptGcm(
              kek,
              backup.sync,
              keyBackupSyncAad(backup.kdf, backup.vaultId)
            ).toString('utf8')
          )
        )
        if (parsed.success) sync = parsed.data
      } catch {
        // 配置块损坏不影响 DEK 恢复；只是不自动填入仓库
      }
    }
    return { dek, sync }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('WRONG_PASSWORD')
  } finally {
    wipe(kek)
  }
}
