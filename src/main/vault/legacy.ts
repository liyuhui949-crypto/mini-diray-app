import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import fs from 'node:fs/promises'

import { AppError } from '@shared/errors'
import type { LocalDate } from '@shared/types'

import { randomUuid } from './crypto'

/**
 * 旧版 Mini Diary 3.3.0 加密文件（`mini-diary.txt`）的一次性迁移。
 * 只读旧格式，不沿用其算法：
 *  1. PBKDF2-HMAC-SHA512(password, salt 字符串按 UTF-8, 500000 次, 64 字节) → 128 位十六进制字符串；
 *  2. 该十六进制字符串作为口令，OpenSSL EVP_BytesToKey(MD5, 无 salt, 1 轮) 生成 24B key + 16B iv；
 *  3. AES-192-CBC 解密。
 */

const LEGACY_SALT =
  'KvAUQORXF8OBYXcYmIwHBpahc7I9Td+qe+H1/eGTaXvI9XfRLngERiC4ufpfx4mqvQgITb0t+ns840lJcRRTKQmF65vje5/Wfb99Nsu6kxDudTiM5pKUcmn36fEJ9/lhFIyBd18Unouh3OiTxO+5xhGugtujNARLijOzkDkYy/8='
const ITERATIONS = 500_000
const KEY_BYTES = 64

export function legacyHashPassword(password: string): string {
  return pbkdf2Sync(password, LEGACY_SALT, ITERATIONS, KEY_BYTES, 'sha512').toString('hex')
}

/** OpenSSL 的 EVP_BytesToKey（MD5、无 salt、1 轮） */
export function evpBytesToKey(
  password: Buffer,
  keyLength: number,
  ivLength: number,
  salt: Buffer = Buffer.alloc(0)
): { key: Buffer; iv: Buffer } {
  const parts: Buffer[] = []
  let previous = Buffer.alloc(0)
  while (parts.reduce((sum, part) => sum + part.length, 0) < keyLength + ivLength) {
    const hash = createHash('md5')
    hash.update(previous)
    hash.update(password)
    hash.update(salt)
    previous = hash.digest()
    parts.push(previous)
  }
  const material = Buffer.concat(parts)
  return {
    key: material.subarray(0, keyLength),
    iv: material.subarray(keyLength, keyLength + ivLength)
  }
}

export function decryptLegacy(buffer: Buffer, password: string): string {
  const hashed = legacyHashPassword(password)
  const { key, iv } = evpBytesToKey(Buffer.from(hashed, 'utf8'), 24, 16)
  try {
    const decipher = createDecipheriv('aes-192-cbc', key, iv)
    return Buffer.concat([decipher.update(buffer), decipher.final()]).toString('utf8')
  } catch {
    throw new AppError('WRONG_PASSWORD')
  }
}

interface LegacyEntry {
  title?: unknown
  text?: unknown
  dateUpdated?: unknown
}

export interface LegacyEntryDraft {
  date: LocalDate
  title: string
  body: string
  tags: string[]
}

export function parseLegacyDiary(content: string): { entries: LegacyEntryDraft[]; version: string } {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    throw new AppError('INVALID_INPUT', '旧版日记文件不是合法的 JSON')
  }
  const file = raw as { metadata?: { version?: unknown }; entries?: Record<string, LegacyEntry> }
  if (!file.entries || typeof file.entries !== 'object') {
    throw new AppError('INVALID_INPUT', '旧版日记文件缺少 entries')
  }
  const version = typeof file.metadata?.version === 'string' ? file.metadata.version : '0.0.0'
  const needsParagraphMigration = version < '2.0.0'

  const entries: LegacyEntryDraft[] = []
  for (const [key, value] of Object.entries(file.entries)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
    if (!value || typeof value !== 'object') continue
    const title = typeof value.title === 'string' ? value.title : ''
    let body = typeof value.text === 'string' ? value.text : ''
    if (needsParagraphMigration) body = body.replace(/\n/g, '\n\n')
    entries.push({ date: key, title, body, tags: [] })
  }
  entries.sort((a, b) => (a.date < b.date ? -1 : 1))
  return { entries, version }
}

export class LegacyImporter {
  private readonly tokens = new Map<string, { entries: LegacyEntryDraft[]; filePath: string }>()

  async preview(
    filePath: string,
    password: string
  ): Promise<{ token: string; entries: number; firstDate: LocalDate | null; lastDate: LocalDate | null }> {
    const stats = await fs.stat(filePath).catch(() => {
      throw new AppError('NOT_FOUND', '旧版日记文件不存在')
    })
    if (stats.size > 512 * 1024 * 1024) throw new AppError('INVALID_INPUT', '文件过大')
    const buffer = await fs.readFile(filePath)
    const plaintext = decryptLegacy(buffer, password)
    const parsed = parseLegacyDiary(plaintext)
    const token = randomUuid()
    this.tokens.set(token, { entries: parsed.entries, filePath })
    return {
      token,
      entries: parsed.entries.length,
      firstDate: parsed.entries[0]?.date ?? null,
      lastDate: parsed.entries[parsed.entries.length - 1]?.date ?? null
    }
  }

  take(token: string): LegacyEntryDraft[] {
    const record = this.tokens.get(token)
    if (!record) throw new AppError('NOT_FOUND', '迁移会话已过期')
    this.tokens.delete(token)
    return record.entries
  }
}
