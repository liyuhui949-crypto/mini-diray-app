import type { DiaryEntry, LocalDate } from '@shared/types'

interface MiniDiaryJsonEntry {
  title: string
  text: string
  dateUpdated: string
  tags?: string[]
  attachments?: Array<{
    id: string
    name: string
    mime: string
    kind: string
    size: number
    sha256: string
  }>
}

export interface MiniDiaryJsonFile {
  metadata: {
    application: string
    version: string
    dateUpdated: string
  }
  entries: Record<LocalDate, MiniDiaryJsonEntry>
}

/**
 * 与旧版 Mini Diary 的导出结构兼容：`entries` 以日期为键。
 * 附件只列元数据（id/name/mime/size/sha256），不含二进制；
 * 完整搬运附件必须用迁移包。
 */
export function buildMiniDiaryJson(
  entries: readonly DiaryEntry[],
  options: { version: string; now?: Date }
): string {
  const now = options.now ?? new Date()
  const file: MiniDiaryJsonFile = {
    metadata: {
      application: 'Mini Diary',
      version: options.version,
      dateUpdated: now.toISOString()
    },
    entries: {}
  }

  for (const entry of entries) {
    file.entries[entry.date] = {
      title: entry.title,
      text: entry.body,
      dateUpdated: entry.updatedAt,
      ...(entry.tags.length > 0 ? { tags: [...entry.tags] } : {}),
      ...(entry.attachments.length > 0
        ? {
            attachments: entry.attachments.map((attachment) => ({
              id: attachment.id,
              name: attachment.name,
              mime: attachment.mime,
              kind: attachment.kind,
              size: attachment.size,
              sha256: attachment.sha256
            }))
          }
        : {})
    }
  }

  return JSON.stringify(file, null, 2)
}
