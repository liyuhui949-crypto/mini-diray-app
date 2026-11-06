import { AppError } from '@shared/errors'

import { extractLocalDate, normalizeTagList, type ParseOutcome, type ParsedEntry } from './helpers'

interface JrnlEntry {
  date?: unknown
  title?: unknown
  body?: unknown
  tags?: unknown
  [key: string]: unknown
}

/**
 * jrnl `--export json`：`[{ date, title, body, tags }]`（有时外面再包一层）
 */
export function parseJrnlJson(content: string): ParseOutcome {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    throw new AppError('INVALID_INPUT', '不是合法的 jrnl JSON')
  }

  let list: unknown[] | null = null
  if (Array.isArray(raw)) {
    list = raw
  } else if (raw && typeof raw === 'object') {
    const candidate = (raw as { entries?: unknown }).entries
    if (Array.isArray(candidate)) list = candidate
  }
  if (!list) throw new AppError('INVALID_INPUT', 'jrnl JSON 里没有条目数组')

  const entries: ParsedEntry[] = []
  const warnings: ParseOutcome['warnings'] = []

  for (const item of list as JrnlEntry[]) {
    if (!item || typeof item !== 'object') continue
    const date = extractLocalDate(item.date)
    if (!date) {
      warnings.push({ message: '有一条 jrnl 记录缺少可用日期，已跳过' })
      continue
    }
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 500) : ''
    const body = typeof item.body === 'string' ? item.body : ''
    entries.push({ date, title, body, tags: normalizeTagList(item.tags) })
  }

  return { entries, warnings }
}
