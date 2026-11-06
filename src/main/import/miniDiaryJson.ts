import { AppError } from '@shared/errors'

import { extractLocalDate, normalizeTagList, type ParseOutcome, type ParsedEntry } from './helpers'

interface MiniDiaryJsonEntry {
  title?: unknown
  text?: unknown
  dateUpdated?: unknown
  [key: string]: unknown
}

interface MiniDiaryJsonFile {
  metadata?: { application?: unknown; version?: unknown; dateUpdated?: unknown }
  entries?: Record<string, MiniDiaryJsonEntry>
}

/**
 * 旧版 Mini Diary JSON（3.x 导出）：
 * `{ metadata: { version }, entries: { "2026-11-06": { title, text } } }`
 *
 * 2.0.0 之前的 `text` 是纯文本（单换行），需要按旧规则补成 Markdown 段落。
 */
export function parseMiniDiaryJson(content: string): ParseOutcome {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    throw new AppError('INVALID_INPUT', '不是合法的 Mini Diary JSON')
  }
  if (!raw || typeof raw !== 'object') throw new AppError('INVALID_INPUT', 'Mini Diary JSON 结构不正确')

  const file = raw as MiniDiaryJsonFile
  const entriesObject = file.entries
  if (!entriesObject || typeof entriesObject !== 'object') {
    throw new AppError('INVALID_INPUT', 'Mini Diary JSON 里没有 entries')
  }

  const version = typeof file.metadata?.version === 'string' ? file.metadata.version : '0.0.0'
  const needsMarkdownMigration = compareVersion(version, '2.0.0') < 0

  const entries: ParsedEntry[] = []
  const warnings: ParseOutcome['warnings'] = []

  for (const [key, value] of Object.entries(entriesObject)) {
    const date = extractLocalDate(key)
    if (!date) {
      warnings.push({ message: `无法识别的日期键：${key}` })
      continue
    }
    if (!value || typeof value !== 'object') continue
    const title = typeof value.title === 'string' ? value.title.trim().slice(0, 500) : ''
    let body = typeof value.text === 'string' ? value.text : ''
    if (needsMarkdownMigration && body) {
      body = body.replace(/\n/g, '\n\n')
    }
    const tags = normalizeTagList((value as { tags?: unknown }).tags)
    entries.push({ date, title, body, tags })
  }

  entries.sort((a, b) => (a.date < b.date ? -1 : 1))
  return { entries, warnings }
}

function compareVersion(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0))
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}
