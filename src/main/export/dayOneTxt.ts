import type { DiaryEntry } from '@shared/types'

import { parseLocalDate } from '@shared/date'
import { plainText } from '@shared/words'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function dayOneTimestamp(entry: DiaryEntry): string {
  const date = parseLocalDate(entry.date)
  const updated = new Date(entry.updatedAt)
  const hours = Number.isNaN(updated.getTime()) ? 20 : updated.getHours()
  const minutes = Number.isNaN(updated.getTime()) ? 0 : updated.getMinutes()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hours)}:${pad(minutes)}:00`
}

/**
 * Day One TXT 导出：每条以 `\tDate:` 开头，正文跟在元数据之后。
 * 附件以文件名列出（不含二进制），这是外部格式的边界。
 */
export function buildDayOneTxt(entries: readonly DiaryEntry[]): string {
  const blocks = entries.map((entry) => {
    const lines: string[] = []
    lines.push(`\tDate:\t${dayOneTimestamp(entry)}`)
    if (entry.title.trim()) lines.push(`\tTitle:\t${entry.title.trim()}`)
    if (entry.tags.length > 0) lines.push(`\tTags:\t${entry.tags.map((tag) => `#${tag}`).join(', ')}`)
    lines.push('')
    lines.push(entry.body)
    if (entry.attachments.length > 0) {
      lines.push('')
      for (const attachment of entry.attachments) {
        lines.push(`[附件] ${attachment.name}（${attachment.kind}）`)
      }
    }
    return lines.join('\n')
  })
  return `${blocks.join('\n\n')}\n`
}

/** 摘要行：Day One 之外的纯文本预览（诊断用） */
export function dayOneTxtPreview(entries: readonly DiaryEntry[], limit = 5): string {
  return entries
    .slice(0, limit)
    .map((entry) => `${entry.date} ${plainText(entry.body).slice(0, 30)}`)
    .join('\n')
}
