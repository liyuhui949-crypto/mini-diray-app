import { z } from 'zod'

import type { LocalDate } from './types'

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_RE = /^[0-9a-f]{64}$/

/** 校验 `YYYY-MM-DD` 且必须是真实存在的本地日期 */
export const localDateSchema = z
  .string()
  .regex(LOCAL_DATE_RE, '日期格式必须为 YYYY-MM-DD')
  .refine((value) => {
    const [yearText, monthText, dayText] = value.split('-')
    const year = Number(yearText)
    const month = Number(monthText)
    const day = Number(dayText)
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
    if (year < 1900 || year > 9999) return false
    if (month < 1 || month > 12) return false
    const probe = new Date(year, month - 1, day)
    return (
      probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
    )
  }, '日期不存在')

export const uuidSchema = z.string().regex(UUID_RE, '非法 ID')

export const attachmentKindSchema = z.enum(['image', 'audio', 'video', 'file'])

export const attachmentSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(128),
  kind: attachmentKindSchema,
  size: z.number().int().positive(),
  sha256: z.string().regex(SHA256_RE),
  chunkSize: z.number().int().min(1024).max(16 * 1024 * 1024),
  totalChunks: z.number().int().positive(),
  createdAt: z.string().min(1)
})

export const TAG_MAX_LENGTH = 32
export const TAG_MAX_COUNT = 100
export const TITLE_MAX_LENGTH = 500

export const tagSchema = z
  .string()
  .min(1, '标签不能为空')
  .max(TAG_MAX_LENGTH, `标签最多 ${TAG_MAX_LENGTH} 个字符`)

export const diaryEntrySchema = z.object({
  date: localDateSchema,
  title: z.string().max(TITLE_MAX_LENGTH),
  body: z.string(),
  tags: z.array(tagSchema).max(TAG_MAX_COUNT),
  attachments: z.array(attachmentSchema),
  wordCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
})

export const vaultDataSchema = z.object({
  schemaVersion: z.number().int().positive(),
  vaultId: uuidSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  entries: z.array(diaryEntrySchema)
})

export const entryDraftSchema = z.object({
  date: localDateSchema,
  title: z.string().max(TITLE_MAX_LENGTH),
  body: z.string(),
  tags: z.array(tagSchema).max(TAG_MAX_COUNT),
  attachments: z.array(attachmentSchema)
})

export const themeModeSchema = z.enum(['system', 'light', 'dark'])
export const autoLockSchema = z.union([
  z.literal(0),
  z.literal(5),
  z.literal(15),
  z.literal(30),
  z.literal(60)
])

export const preferencesSchema = z.object({
  version: z.literal(1),
  theme: themeModeSchema,
  hideTitle: z.boolean(),
  allowFutureEntries: z.boolean(),
  autoLockMinutes: autoLockSchema,
  diaryDir: z.string().min(1),
  lastOpenedDate: localDateSchema.nullable(),
  lastImportDir: z.string().nullable(),
  lastExportDir: z.string().nullable()
})

export const portablePreferencesSchema = z.object({
  theme: themeModeSchema,
  hideTitle: z.boolean(),
  allowFutureEntries: z.boolean(),
  autoLockMinutes: autoLockSchema
})

export const passwordSchema = z
  .string()
  .min(8, '密码至少 8 位')
  .max(200, '密码最多 200 位')

export const migrationPackageFormat = z.number().int().positive()

export const migrationManifestSchema = z.object({
  packageFormat: migrationPackageFormat,
  appVersion: z.string().min(1),
  createdAt: z.string().min(1),
  formatVersion: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
  vaultId: uuidSchema,
  entryCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  totalAttachmentBytes: z.number().int().nonnegative(),
  firstDate: localDateSchema.nullable(),
  lastDate: localDateSchema.nullable(),
  hasPreferences: z.boolean()
})

export const migrationModeSchema = z.enum(['replace', 'merge'])

export const importFormatSchema = z.enum(['dayOneJson', 'jrnlJson', 'miniDiaryJson', 'dayOneTxt'])
export const exportFormatSchema = z.enum(['miniDiaryJson', 'markdown', 'pdf', 'dayOneTxt'])

/** 校验本地日期字符串是否合法（供纯函数复用） */
export function isValidLocalDate(value: unknown): value is LocalDate {
  return typeof value === 'string' && localDateSchema.safeParse(value).success
}

/** 规范化标签：去 '#'、去首尾空白、小写、去重、丢弃空值 */
export function normalizeTags(input: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of input) {
    const tag = raw.trim().replace(/^#+/, '').trim().toLowerCase()
    if (!tag) continue
    if (tag.length > TAG_MAX_LENGTH) continue
    if (seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
    if (result.length >= TAG_MAX_COUNT) break
  }
  return result
}
