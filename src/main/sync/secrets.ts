import fs from 'node:fs/promises'
import path from 'node:path'

import { app, safeStorage } from 'electron'

import { AppError } from '@shared/errors'

import { atomicWriteFile, pathExists, removePath } from '../vault/paths'

const TOKEN_FILE = 'sync-token.bin'

/** Git 访问令牌只进系统钥匙串（safeStorage），不写偏好、不写日志。 */
export class SyncSecrets {
  private readonly file: string

  constructor(file = path.join(app.getPath('userData'), TOKEN_FILE)) {
    this.file = file
  }

  async available(): Promise<boolean> {
    return safeStorage.isEncryptionAvailable()
  }

  async get(): Promise<string | null> {
    if (!(await pathExists(this.file))) return null
    try {
      const encrypted = await fs.readFile(this.file)
      return safeStorage.decryptString(encrypted)
    } catch {
      return null
    }
  }

  async set(token: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new AppError('UNSUPPORTED', '系统钥匙串不可用，无法安全保存 Git 令牌')
    }
    const encrypted = safeStorage.encryptString(token)
    await atomicWriteFile(this.file, encrypted, 0o600)
  }

  async clear(): Promise<void> {
    await removePath(this.file)
  }
}
