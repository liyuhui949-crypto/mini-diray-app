import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { AppError } from '@shared/errors'
import {
  annotationSchema,
  ANNOTATION_BODY_MAX_LENGTH,
  ANNOTATION_TAG_MAX_LENGTH,
  QUOTE_MAX_LENGTH
} from '@shared/schemas'
import type { Annotation, LocalDate } from '@shared/types'

import { deriveSubkey, randomBytesBuffer } from './crypto'

/** 批注文件头：第一行固定，之后每行一条独立密文 */
export const ANNOTATION_MAGIC = 'INKANN1'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const ANNOTATION_DIR = 'annotations'

export function annotationKey(dek: Buffer, vaultId: string): Buffer {
  return deriveSubkey(dek, vaultId, 'annotation-v1')
}

function annotationDir(dir: string): string {
  return path.join(dir, ANNOTATION_DIR)
}

export function annotationFile(dir: string, date: LocalDate): string {
  return path.join(annotationDir(dir), `${date}.ann`)
}

/** AAD 绑定日期与行号：把记录挪到别的日期/位置就解不开 */
function annotationAad(date: LocalDate, index: number): string {
  return `ann:${date}:${index}`
}

function encodeLine(key: Buffer, date: LocalDate, index: number, record: Annotation): string {
  const nonce = randomBytesBuffer(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(annotationAad(date, index), 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64')
}

function decodeLine(key: Buffer, date: LocalDate, index: number, line: string): Annotation {
  const raw = Buffer.from(line, 'base64')
  if (raw.length <= NONCE_BYTES + TAG_BYTES) {
    throw new AppError('CORRUPT_VAULT', '批注记录损坏')
  }
  const nonce = raw.subarray(0, NONCE_BYTES)
  const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES)
  const ciphertext = raw.subarray(NONCE_BYTES + TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(annotationAad(date, index), 'utf8'))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const parsed = annotationSchema.safeParse(JSON.parse(plaintext.toString('utf8')))
    if (!parsed.success) throw new Error('bad record')
    return parsed.data
  } catch {
    throw new AppError('CORRUPT_VAULT', '批注记录校验失败（可能被外部篡改）')
  }
}

/** 规范化：去前导 #、trim、截断；空值保持空字符串 */
export function normalizeAnnotationTag(input: string): string {
  return input
    .trim()
    .replace(/^#+/, '')
    .trim()
    .slice(0, ANNOTATION_TAG_MAX_LENGTH)
}

export function normalizeQuote(input: string): string {
  return input.trim().slice(0, QUOTE_MAX_LENGTH)
}

export interface NewAnnotationInput {
  date: LocalDate
  quote: string
  tag: string
  body: string
}

/** 'MM-DD HH:mm'，与原型卡片右上角一致 */
export function formatAnnotationTime(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export function buildAnnotation(
  input: NewAnnotationInput,
  seq: number,
  now: Date = new Date()
): Annotation {
  const body = input.body.trim()
  if (!body) throw new AppError('INVALID_INPUT', '批注内容不能为空')
  if (body.length > ANNOTATION_BODY_MAX_LENGTH) {
    throw new AppError('INVALID_INPUT', '批注内容过长')
  }
  return {
    id: `n${seq}`,
    date: input.date,
    quote: normalizeQuote(input.quote),
    tag: normalizeAnnotationTag(input.tag),
    body,
    at: formatAnnotationTime(now),
    createdAt: now.getTime()
  }
}

/** 把批注文件文本解析成记录（损坏只在最后一行容忍） */
export function parseAnnotationText(
  date: LocalDate,
  text: string,
  key: Buffer
): Annotation[] {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== ANNOTATION_MAGIC) {
    throw new AppError('CORRUPT_VAULT', '批注文件头无效')
  }
  const records: Annotation[] = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    try {
      records.push(decodeLine(key, date, index, line))
    } catch (error) {
      // 只有"看起来被截断"的最后一行才允许丢弃（断电半行）；
      // 完整长度但解不开 = 被篡改，必须报错。
      const isLast =
        index === lines.length - 1 ||
        (index === lines.length - 2 && !lines[lines.length - 1]?.trim())
      const rawLength = Buffer.from(line, 'base64').length
      if (isLast && (line.length % 4 !== 0 || rawLength <= NONCE_BYTES + TAG_BYTES + 2)) break
      throw error
    }
  }
  return records.sort((a, b) => a.createdAt - b.createdAt)
}

/** 读取某一天的批注；文件不存在返回空数组 */
export async function readAnnotations(
  dir: string,
  date: LocalDate,
  key: Buffer
): Promise<Annotation[]> {
  const file = annotationFile(dir, date)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  return parseAnnotationText(date, text, key)
}

/** 序列化整份批注文件（导入时重加密后写回） */
function serializeAnnotationFile(
  date: LocalDate,
  records: readonly Annotation[],
  key: Buffer
): string {
  const lines = [ANNOTATION_MAGIC]
  records.forEach((record, index) => lines.push(encodeLine(key, date, index + 1, record)))
  return `${lines.join('\n')}\n`
}

/** 整体写入某一天的批注文件（导入/合并时用），返回文件哈希 */
export async function writeAnnotationFile(
  dir: string,
  date: LocalDate,
  records: readonly Annotation[],
  key: Buffer
): Promise<string> {
  const file = annotationFile(dir, date)
  await fs.mkdir(annotationDir(dir), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, serializeAnnotationFile(date, records, key), { mode: 0o600 })
  return digestOfFile(file)
}

/** 导入时重排 id，避免两个库的 n1 撞车 */
export function renumberAnnotations(
  records: readonly Annotation[],
  startSeq: number
): Annotation[] {
  return records.map((record, index) => ({ ...record, id: `n${startSeq + index + 1}` }))
}

/** 追加一条批注；保留既有记录，返回写入后的文件哈希 */
export async function appendAnnotation(
  dir: string,
  key: Buffer,
  record: Annotation
): Promise<string> {
  const file = annotationFile(dir, record.date)
  await fs.mkdir(annotationDir(dir), { recursive: true, mode: 0o700 })
  // 先解出既有有效记录（顺带丢弃崩溃留下的半行），再整体原子重写
  const records = await readAnnotations(dir, record.date, key)
  const lines = [ANNOTATION_MAGIC]
  records.forEach((item, index) => lines.push(encodeLine(key, record.date, index + 1, item)))
  lines.push(encodeLine(key, record.date, records.length + 1, record))
  const temp = `${file}.tmp`
  await fs.writeFile(temp, `${lines.join('\n')}\n`, { mode: 0o600 })
  await fs.rename(temp, file)
  return digestOfFile(file)
}

export async function digestOfFile(file: string): Promise<string> {
  const data = await fs.readFile(file)
  return createHash('sha256').update(data).digest('hex')
}

/** 列出有批注的日期（只看文件名，不解密） */
export async function listAnnotationDates(dir: string): Promise<LocalDate[]> {
  try {
    const files = await fs.readdir(annotationDir(dir))
    return files
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.ann$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort()
  } catch {
    return []
  }
}

/** 读全部批注（解锁时一次载入内存，锁定即销毁） */
export async function loadAllAnnotations(
  dir: string,
  key: Buffer
): Promise<Record<string, Annotation[]>> {
  const dates = await listAnnotationDates(dir)
  const result: Record<string, Annotation[]> = {}
  for (const date of dates) {
    const list = await readAnnotations(dir, date, key)
    if (list.length > 0) result[date] = list
  }
  return result
}

/** 清空全部批注文件（重置日记库时使用） */
export async function removeAllAnnotations(dir: string): Promise<void> {
  await fs.rm(annotationDir(dir), { recursive: true, force: true })
}
