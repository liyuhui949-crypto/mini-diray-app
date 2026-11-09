import type { Attachment, AttachmentKind, DiaryEntry, LocalDate } from './types'

/** 附件库 tab：全部 + 四种 kind */
export type AttachmentTab = 'all' | AttachmentKind

export interface AttachmentIndexItem {
  /** 所属日记日期（排序键） */
  date: LocalDate
  /** 日记标题快照；为空表示无标题 */
  entryTitle: string
  attachment: Attachment
}

/**
 * 附件库的纯派生索引：把每篇日记的附件摊平，按日记日期倒序排列。
 * 不建缓存、不新增存储，增删附件后重新算一遍即可。
 */
export function buildAttachmentIndex(
  entries: readonly DiaryEntry[]
): AttachmentIndexItem[] {
  const items: AttachmentIndexItem[] = []
  for (const entry of entries) {
    for (const attachment of entry.attachments) {
      items.push({ date: entry.date, entryTitle: entry.title, attachment })
    }
  }
  return items.sort((a, b) => b.date.localeCompare(a.date))
}

/** 图片 / 视频 / 音频可以在灯箱里直接看；file 只能另存 */
export function isPreviewableKind(kind: AttachmentKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio'
}

/** 各 tab 的实时计数 */
export function countAttachmentKinds(
  items: readonly AttachmentIndexItem[]
): Record<AttachmentTab, number> {
  const counts: Record<AttachmentTab, number> = {
    all: items.length,
    image: 0,
    video: 0,
    audio: 0,
    file: 0
  }
  for (const item of items) counts[item.attachment.kind] += 1
  return counts
}

/** 全部附件体积之和（字节） */
export function totalAttachmentBytes(items: readonly AttachmentIndexItem[]): number {
  return items.reduce((sum, item) => sum + item.attachment.size, 0)
}
