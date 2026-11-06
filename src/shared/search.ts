import type { DiaryEntry } from './types'
import { plainText } from './words'

export interface SearchHit {
  entry: DiaryEntry
  /** 列表标题（隐藏标题时取正文首行） */
  title: string
  snippet: string
  /** 命中次数，用于排序 */
  score: number
}

export interface SearchOptions {
  hideTitle?: boolean
  limit?: number
}

export function normalizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function deriveLocalTitle(entry: DiaryEntry, hideTitle?: boolean): string {
  if (!hideTitle && entry.title.trim()) return entry.title.trim()
  const firstLine = plainText(entry.body)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (firstLine) return firstLine.slice(0, 40)
  return entry.title.trim()
}

function buildSnippet(body: string, terms: string[], limit: number): string {
  const plain = plainText(body).replace(/\s+/g, ' ').trim()
  if (!plain) return ''
  const lower = plain.toLowerCase()
  let start = -1
  for (const term of terms) {
    const index = lower.indexOf(term)
    if (index !== -1 && (start === -1 || index < start)) start = index
  }
  if (start <= 0) return plain.slice(0, limit)
  const from = Math.max(0, start - 20)
  const slice = plain.slice(from, from + limit)
  return from > 0 ? `…${slice}` : slice
}

/**
 * 搜索标题、正文、标签：
 * - 大小写不敏感的中文子串匹配（这是中文检索唯一可靠的方案）；
 * - 多个空格分隔的词是"与"关系；
 * - 标题命中权重高于标签高于正文。
 */
export function searchEntries(
  entries: readonly DiaryEntry[],
  query: string,
  options: SearchOptions = {}
): SearchHit[] {
  const terms = normalizeQuery(query)
  if (terms.length === 0) return []

  const hits: SearchHit[] = []
  for (const entry of entries) {
    const plainBody = plainText(entry.body).toLowerCase()
    const lowerTitle = entry.title.toLowerCase()
    const lowerTags = entry.tags.map((tag) => tag.toLowerCase())

    let matchedAll = true
    let score = 0
    for (const term of terms) {
      const titleHits = countOccurrences(lowerTitle, term)
      const bodyHits = countOccurrences(plainBody, term)
      const tagHits = lowerTags.reduce((sum, tag) => sum + (tag.includes(term) ? 1 : 0), 0)
      if (titleHits + bodyHits + tagHits === 0) {
        matchedAll = false
        break
      }
      score += titleHits * 6 + tagHits * 4 + bodyHits
    }
    if (!matchedAll) continue

    hits.push({
      entry,
      title: deriveLocalTitle(entry, options.hideTitle),
      snippet: buildSnippet(entry.body, terms, 90),
      score
    })
  }

  hits.sort((a, b) => b.score - a.score || (a.entry.date < b.entry.date ? 1 : -1))
  return options.limit ? hits.slice(0, options.limit) : hits
}

export interface HighlightSegment {
  text: string
  match: boolean
}

/** 把命中的片段切成可渲染的段落，供 <mark> 高亮使用 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const terms = normalizeQuery(query)
  if (terms.length === 0 || !text) return [{ text, match: false }]

  const lower = text.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    let index = lower.indexOf(term)
    while (index !== -1) {
      ranges.push([index, index + term.length])
      index = lower.indexOf(term, index + term.length)
    }
  }
  if (ranges.length === 0) return [{ text, match: false }]

  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
    } else {
      merged.push([...range] as [number, number])
    }
  }

  const segments: HighlightSegment[] = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false })
    segments.push({ text: text.slice(start, end), match: true })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments
}

/** 标签筛选（AND 语义由调用方决定，这里只做单标签） */
export function filterByTag(entries: readonly DiaryEntry[], tag: string | null): DiaryEntry[] {
  if (!tag) return [...entries]
  const needle = tag.toLowerCase()
  return entries.filter((entry) => entry.tags.some((item) => item === needle))
}

/** 汇总标签与出现次数，按次数降序、名称升序 */
export function collectTags(entries: readonly DiaryEntry[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    for (const tag of entry.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'))
}
