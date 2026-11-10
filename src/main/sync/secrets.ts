import fs from 'node:fs/promises'
import path from 'node:path'

import { app } from 'electron'

import { decryptGcm, encryptGcm } from '../vault/crypto'
import { atomicWriteFile, pathExists, removePath } from '../vault/paths'

const TOKEN_FILE = 'sync-token.bin'
const TOKEN_FORMAT = 'minidiary-sync-token/1'

interface TokenFile {
  format: string
  vaultId: string
  alg: 'AES-256-GCM'
  iv: string
  ciphertext: string
  tag: string
}

function tokenAad(vaultId: string): string {
  return `MINIDIARY|sync-token|1|${vaultId}`
}

/**
 * Git token 用日记库 DEK 派生的密钥加密，不再使用系统钥匙串。
 * 文件只能在解锁状态下读写；同步本来也要求解锁。
 */
export class SyncSecrets {
  private readonly file: string

  constructor(file = path.join(app.getPath('userData'), TOKEN_FILE)) {
    this.file = file
  }

  /** 只判断文件是否存在，不要求解锁 */
  async has(): Promise<boolean> {
    return pathExists(this.file)
  }

  async get(key: Buffer, vaultId: string): Promise<string | null> {
    if (!(await pathExists(this.file))) return null
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as TokenFile
      if (parsed.format !== TOKEN_FORMAT || parsed.vaultId !== vaultId) return null
      return decryptGcm(key, parsed, tokenAad(vaultId)).toString('utf8')
    } catch {
      return null
    }
  }

  async set(token: string, key: Buffer, vaultId: string): Promise<void> {
    const block = encryptGcm(key, Buffer.from(token, 'utf8'), tokenAad(vaultId))
    const payload: TokenFile = {
      format: TOKEN_FORMAT,
      vaultId,
      ...block
    }
    await atomicWriteFile(this.file, JSON.stringify(payload), 0o600)
  }

  async clear(): Promise<void> {
    await removePath(this.file)
  }
}
