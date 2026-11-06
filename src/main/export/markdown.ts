import type { DiaryEntry } from '@shared/types'

import { formatDateWithWeekdayCN } from '@shared/date'

/** 把 `attachment://<uuid>` 改写成相对路径；正文里的引用必须在导出后仍然可用 */
export function rewriteAttachmentLinks(
  body: string,
  map: ReadonlyMap<string, string>
): string {
  return body.replace(/attachment:\/\/([0-9a-f-]{36})/gi, (match, id: string) => {
    const relative = map.get(id.toLowerCase())
    return relative ?? match
  })
}

export function buildMarkdownDocument(
  entry: DiaryEntry,
  options: { attachmentLinks?: ReadonlyMap<string, string> } = {}
): string {
  const title = entry.title.trim()
  const front = [`# ${title || formatDateWithWeekdayCN(entry.date)}`, '']
  if (entry.tags.length > 0) {
    front.push(entry.tags.map((tag) => `#${tag}`).join(' '), '')
  }
  const body = rewriteAttachmentLinks(entry.body, options.attachmentLinks ?? new Map())
  const footer = entry.attachments.length > 0
    ? ['', '---', '', ...entry.attachments.map((attachment) => `- 附件：${attachment.name}（${attachment.kind}，${attachment.size} 字节）`)]
    : []
  return `${front.join('\n')}${body}${footer.join('\n')}\n`
}

/** 导出到目录时每个条目的文件名 */
export function markdownFileName(date: string): string {
  return `${date}.md`
}

/** 附件导出后的安全文件名：`<原名>-<短ID>.<ext>` */
export function safeAttachmentFileName(id: string, originalName: string): string {
  const base = originalName
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  const shortId = id.slice(0, 8)
  const dotIndex = base.lastIndexOf('.')
  if (dotIndex > 0) {
    return `${base.slice(0, dotIndex)}-${shortId}${base.slice(dotIndex)}`
  }
  return `${base || 'attachment'}-${shortId}`
}
