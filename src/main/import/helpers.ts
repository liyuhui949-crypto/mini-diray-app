import { isValidLocalDate, toLocalDate } from '@shared/date'
import type { LocalDate } from '@shared/types'

/**
 * 从各种外部格式里抽取"本地日期"。
 * 只取日历日期部分，不把时区换算成 UTC 日期——日记是按本地日历索引的。
 */
export function extractLocalDate(input: unknown): LocalDate | null {
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : toLocalDate(input)
  }
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (!text) return null

  // 2020-01-02 / 2020-01-02T03:04:05Z / 2020/01/02
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text)
  if (iso) {
    const value = `${iso[1]}-${iso[2]!.padStart(2, '0')}-${iso[3]!.padStart(2, '0')}`
    if (isValidLocalDate(value)) return value
  }

  // 02/01/2020（按本地时间解析，交给 Date）
  const parsed = new Date(text)
  if (!Number.isNaN(parsed.getTime())) return toLocalDate(parsed)

  return null
}

/** 把多行文本按第一行切成「标题 + 正文」 */
export function splitTitleAndBody(text: string): { title: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!normalized) return { title: '', body: '' }
  const lines = normalized.split('\n')
  const firstIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstIndex === -1) return { title: '', body: '' }
  const firstLine = lines[firstIndex]!.trim()
  const headingMatch = /^#{1,6}\s+(.*)$/.exec(firstLine)
  const title = (headingMatch?.[1] ?? firstLine).slice(0, 500)
  const rest = lines.slice(firstIndex + 1).join('\n').replace(/^\n+/, '')
  return { title, body: rest }
}

export function normalizeTagList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    if (typeof input === 'string') {
      return input
        .split(/[,\s]+/)
        .map((tag) => tag.trim().replace(/^#+/, '').trim().toLowerCase())
        .filter(Boolean)
    }
    return []
  }
  const tags: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const tag = item.trim().replace(/^#+/, '').trim().toLowerCase()
    if (tag) tags.push(tag)
  }
  return [...new Set(tags)]
}

export interface ParsedEntry {
  date: LocalDate
  title: string
  body: string
  tags: string[]
  /** 来源格式里的额外信息（附件被忽略等） */
  warning?: string
}

export interface ParseOutcome {
  entries: ParsedEntry[]
  warnings: Array<{ message: string; date?: LocalDate }>
}
