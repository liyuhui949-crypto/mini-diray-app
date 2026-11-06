import { AppError } from '@shared/errors'

import { extractLocalDate, normalizeTagList, splitTitleAndBody, type ParseOutcome, type ParsedEntry } from './helpers'

interface DayOneJsonEntry {
  creationDate?: unknown
  text?: unknown
  tags?: unknown
  photos?: unknown[]
  audios?: unknown[]
  videos?: unknown[]
  [key: string]: unknown
}

/**
 * Day One JSON 导出：
 * `{ entries: [{ creationDate, text, tags, photos, ... }] }`
 * 只导入文本与标签；照片/音频/视频在预览里逐条提示。
 */
export function parseDayOneJson(content: string): ParseOutcome {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    throw new AppError('INVALID_INPUT', '不是合法的 Day One JSON')
  }
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { entries?: unknown }).entries)
      ? ((raw as { entries: unknown[] }).entries)
      : null
  if (!list) throw new AppError('INVALID_INPUT', 'Day One JSON 里没有 entries')

  const entries: ParsedEntry[] = []
  const warnings: ParseOutcome['warnings'] = []

  for (const item of list as DayOneJsonEntry[]) {
    if (!item || typeof item !== 'object') continue
    const date = extractLocalDate(item.creationDate)
    if (!date) {
      warnings.push({ message: '有一条记录缺少可用日期，已跳过' })
      continue
    }
    const text = typeof item.text === 'string' ? item.text : ''
    const { title, body } = splitTitleAndBody(text)
    const mediaCount =
      (Array.isArray(item.photos) ? item.photos.length : 0) +
      (Array.isArray(item.audios) ? item.audios.length : 0) +
      (Array.isArray(item.videos) ? item.videos.length : 0)
    const warning =
      mediaCount > 0
        ? `这一天有 ${mediaCount} 个照片/音频/视频，外部格式不会导入附件`
        : undefined
    if (warning) warnings.push({ message: warning, date })
    entries.push({
      date,
      title,
      body,
      tags: normalizeTagList(item.tags),
      ...(warning ? { warning } : {})
    })
  }

  return { entries, warnings }
}
