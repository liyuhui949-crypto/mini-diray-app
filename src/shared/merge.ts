import type { Attachment, DiaryEntry, LocalDate } from './types'
import { countEntryWords } from './words'

/**
 * 同一天内容合并规则（外部导入与迁移 merge 共用，保证口径一致）：
 * - 标题：`旧 | 新`（相同标题只留一份）
 * - 正文：`旧\n\n---\n\n新`
 * - 标签：并集
 * - 附件：并集（按 id 去重，不覆盖）
 * - 时间戳：createdAt 取较早，updatedAt 取较晚
 * - 绝不覆盖已有内容
 */

export function composeMergedTitle(oldTitle: string, newTitle: string): string {
  const parts = [...new Set([oldTitle.trim(), newTitle.trim()].filter((part) => part.length > 0))]
  return parts.join(' | ').slice(0, 500)
}

export function composeMergedBody(oldBody: string, newBody: string): string {
  const oldTrimmed = oldBody.trim()
  const newTrimmed = newBody.trim()
  if (!oldTrimmed) return newBody
  if (!newTrimmed) return oldBody
  if (oldTrimmed === newTrimmed) return oldBody
  return `${oldTrimmed}\n\n---\n\n${newTrimmed}`
}

export function mergeTags(oldTags: readonly string[], newTags: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const tag of [...oldTags, ...newTags]) {
    const normalized = tag.trim().replace(/^#+/, '').trim().toLowerCase()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

export function mergeAttachments(
  oldAttachments: readonly Attachment[],
  newAttachments: readonly Attachment[]
): Attachment[] {
  const byId = new Map<string, Attachment>()
  for (const attachment of oldAttachments) byId.set(attachment.id, attachment)
  for (const attachment of newAttachments) {
    if (!byId.has(attachment.id)) byId.set(attachment.id, attachment)
  }
  return [...byId.values()]
}

export function earliestTimestamp(a: string, b: string): string {
  return a <= b ? a : b
}

export function latestTimestamp(a: string, b: string): string {
  return a >= b ? a : b
}

export interface MergeStats {
  added: number
  merged: number
}

/** 把 incoming 合并进 existing（按日期），返回新的条目数组与统计 */
export function mergeEntryLists(
  existing: readonly DiaryEntry[],
  incoming: readonly DiaryEntry[]
): { entries: DiaryEntry[]; stats: MergeStats } {
  const byDate = new Map<LocalDate, DiaryEntry>()
  for (const entry of existing) byDate.set(entry.date, { ...entry, attachments: [...entry.attachments] })

  let added = 0
  let merged = 0
  for (const entry of incoming) {
    const current = byDate.get(entry.date)
    if (!current) {
      byDate.set(entry.date, { ...entry, attachments: [...entry.attachments] })
      added += 1
      continue
    }
    merged += 1
    const title = composeMergedTitle(current.title, entry.title)
    const body = composeMergedBody(current.body, entry.body)
    byDate.set(entry.date, {
      ...current,
      title,
      body,
      tags: mergeTags(current.tags, entry.tags),
      attachments: mergeAttachments(current.attachments, entry.attachments),
      wordCount: countEntryWords(title, body),
      createdAt: earliestTimestamp(current.createdAt, entry.createdAt),
      updatedAt: latestTimestamp(current.updatedAt, entry.updatedAt)
    })
  }

  return { entries: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), stats: { added, merged } }
}

/**
 * merge 模式会为包内附件生成新 ID，正文里的 `attachment://<旧ID>` 必须同步替换，
 * 否则导入后图片/视频引用会断掉。
 */
export function rewriteAttachmentIds(body: string, idMap: ReadonlyMap<string, string>): string {
  if (idMap.size === 0) return body
  return body.replace(/attachment:\/\/([0-9a-f-]{36})/gi, (match, id: string) => {
    const next = idMap.get(id.toLowerCase())
    return next ? `attachment://${next}` : match
  })
}

/** 校验正文里的每个 attachment 引用都能在条目附件里找到 */
export function collectBrokenAttachmentRefs(entries: readonly DiaryEntry[]): string[] {
  const broken: string[] = []
  for (const entry of entries) {
    const ids = new Set(entry.attachments.map((attachment) => attachment.id.toLowerCase()))
    const matches = entry.body.matchAll(/attachment:\/\/([0-9a-f-]{36})/gi)
    for (const match of matches) {
      const id = (match[1] ?? '').toLowerCase()
      if (id && !ids.has(id)) broken.push(`${entry.date}:${id}`)
    }
  }
  return broken
}
