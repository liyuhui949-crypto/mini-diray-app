import type { z } from 'zod'

import { AppError } from '@shared/errors'
import { migrationManifestSchema, portablePreferencesSchema } from '@shared/schemas'
import type { PortablePreferences } from '@shared/types'

/** `.minidiary` 包的成员布局（第 8.2 节） */
export const PACKAGE_MEMBER = {
  manifest: 'manifest.json',
  vault: 'vault.inkv',
  prefs: 'prefs.json',
  checksums: 'checksums.sha256',
  attachmentsPrefix: 'attachments/',
  annotationsPrefix: 'annotations/'
} as const

/** 当前（也是唯一）支持的包格式：必须「公钥 + 私钥」才能打开 */
export const PACKAGE_FORMAT = 2
export const PACKAGE_EXTENSION = 'minidiary'
export const ANNOTATION_MEMBER_RE = /^annotations\/\d{4}-\d{2}-\d{2}\.ann$/

const ATTACHMENT_MEMBER_RE =
  /^attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mdat$/i

export type PackageManifest = z.infer<typeof migrationManifestSchema>

/** 只允许清单内的成员，其余一律拒绝（防路径穿越与夹带文件） */
export function isAllowedPackageMember(name: string): boolean {
  if (
    name === PACKAGE_MEMBER.manifest ||
    name === PACKAGE_MEMBER.vault ||
    name === PACKAGE_MEMBER.prefs ||
    name === PACKAGE_MEMBER.checksums
  ) {
    return true
  }
  if (ANNOTATION_MEMBER_RE.test(name)) return true
  return ATTACHMENT_MEMBER_RE.test(name)
}

export function annotationMember(date: string): string {
  return `${PACKAGE_MEMBER.annotationsPrefix}${date}.ann`
}

export function annotationDateFromMember(name: string): string | null {
  return ANNOTATION_MEMBER_RE.test(name) ? name.slice(PACKAGE_MEMBER.annotationsPrefix.length, -4) : null
}

export function attachmentMember(id: string): string {
  return `${PACKAGE_MEMBER.attachmentsPrefix}${id}.mdat`
}

export function attachmentIdFromMember(name: string): string | null {
  const match = /^attachments\/([0-9a-f-]{36})\.mdat$/i.exec(name)
  return match?.[1]?.toLowerCase() ?? null
}

export function parseManifest(text: string): PackageManifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new AppError('INVALID_INPUT', '迁移包清单不是合法 JSON')
  }
  const parsed = migrationManifestSchema.safeParse(raw)
  if (!parsed.success) throw new AppError('INVALID_INPUT', '迁移包清单字段不完整')
  if (parsed.data.packageFormat < PACKAGE_FORMAT) {
    throw new AppError(
      'PACKAGE_VERSION_UNSUPPORTED',
      '这个迁移包来自旧版本（不需要公钥），已不再支持导入'
    )
  }
  if (parsed.data.packageFormat > PACKAGE_FORMAT) {
    throw new AppError('VAULT_VERSION_TOO_NEW', '这个迁移包来自更新的版本，请先升级应用')
  }
  return parsed.data
}

export function parsePortablePrefs(text: string): PortablePreferences | null {
  try {
    const parsed = portablePreferencesSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** `checksums.sha256` 每行：`<sha256>  <member>`（两个空格，与 sha256sum 一致） */
export function parseChecksums(text: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(trimmed)
    if (!match) continue
    const [, hash, name] = match
    if (hash && name) result.set(name.trim(), hash.toLowerCase())
  }
  return result
}

export function formatChecksums(entries: ReadonlyArray<{ member: string; sha256: string }>): string {
  return entries
    .map((entry) => `${entry.sha256}  ${entry.member}`)
    .sort((a, b) => a.localeCompare(b))
    .join('\n')
    .concat('\n')
}

/** 默认文件名：`Mini Diary 迁移包 2026-11-06.minidiary` */
export function defaultPackageFileName(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `Mini Diary 迁移包 ${year}-${month}-${day}.${PACKAGE_EXTENSION}`
}

