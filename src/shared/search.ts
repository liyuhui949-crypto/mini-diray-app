import type { DiaryEntry, LocalDate } from './types'
import { daysBetween } from './date'
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

/** NFKC + 小写：全角字母/数字也一并归一化（与 PIPELINE P5 口径一致） */
export function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
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
  const needles = terms.map(normalizeText)
  for (const entry of entries) {
    const plainBody = normalizeText(plainText(entry.body))
    const lowerTitle = normalizeText(entry.title)
    const lowerTags = entry.tags.map(normalizeText)

    let matchedAll = true
    let score = 0
    for (const term of needles) {
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

  const lower = normalizeText(text)
  const ranges: Array<[number, number]> = []
  for (const term of terms.map(normalizeText)) {
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

/* ═══════════════ 检索洞察（概览 + 证据） ═══════════════ */

export interface SearchSnippet {
  /** 已截断的纯文本片段（可能带首尾省略号） */
  text: string
  segments: HighlightSegment[]
}

export interface SearchHitDetail {
  entry: DiaryEntry
  /** 列表标题（隐藏标题时取正文首行） */
  title: string
  titleHits: number
  bodyHits: number
  /** 命中 ≥3 次时给两条（首、尾），否则一条 */
  snippets: SearchSnippet[]
}

export interface SearchYearGroup {
  year: string
  hits: SearchHitDetail[]
}

export interface TimelineBucket {
  /** 月桶是 YYYY-MM，年桶是 YYYY */
  key: string
  year: number
  month: number
  /** 该桶命中的篇数 */
  n: number
  /** 轴上的短标签（26年 / 4月） */
  label: string
  /** 轴上的日期标签（月桶 yyyy-mm，年桶 yyyy） */
  dateLabel: string
}

export interface SearchTimeline {
  unit: 'month' | 'year'
  buckets: TimelineBucket[]
}

export interface StreakInfo {
  /** 该日在本段连续命中里的第几天（1 起） */
  idx: number
  /** 本段连续命中一共几天 */
  len: number
}

export interface SearchAnalysis {
  query: string
  terms: string[]
  hits: SearchHitDetail[]
  byYear: SearchYearGroup[]
  timeline: SearchTimeline
  streakOf: Record<string, StreakInfo>
  /** 最早命中日 */
  firstHit: LocalDate | null
  /** 最近命中日 */
  lastHit: LocalDate | null
}

const SNIPPET_BEFORE = 18
const SNIPPET_AFTER = 26
/** 时间线超过这么多个月就按年聚合 */
export const TIMELINE_MONTH_LIMIT = 30

function mergedMatches(text: string, needles: readonly string[]): Array<[number, number]> {
  const lower = normalizeText(text)
  const ranges: Array<[number, number]> = []
  for (const needle of needles) {
    let index = lower.indexOf(needle)
    while (index !== -1) {
      ranges.push([index, index + needle.length])
      index = lower.indexOf(needle, index + needle.length)
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
    } else {
      merged.push([range[0], range[1]])
    }
  }
  return merged
}

function buildSnippets(body: string, needles: readonly string[]): SearchSnippet[] {
  const plain = plainText(body).replace(/\s+/g, ' ').trim()
  if (!plain) return []
  const matches = mergedMatches(plain, needles)
  if (matches.length === 0) return []

  // n ≤ 2 只给一条；n ≥ 3 给"第一次 + 最后一次"，体现开头提到、结尾还在提
  const picks =
    matches.length <= 2
      ? [matches[0]!]
      : [matches[0]!, matches[matches.length - 1]!]

  const query = needles.join(' ')
  return picks.map(([start, end]) => {
    const from = Math.max(0, start - SNIPPET_BEFORE)
    const to = Math.min(plain.length, end + SNIPPET_AFTER)
    const text = `${from > 0 ? '…' : ''}${plain.slice(from, to)}${to < plain.length ? '…' : ''}`
    return { text, segments: highlightSegments(text, query) }
  })
}

function buildTimeline(hits: readonly SearchHitDetail[]): SearchTimeline {
  if (hits.length === 0) return { unit: 'month', buckets: [] }
  const months = hits.map((hit) => hit.entry.date.slice(0, 7)).sort()
  const first = months[0]!
  const last = months[months.length - 1]!
  const monthIndex = (value: string): number =>
    Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1
  const span = monthIndex(last) - monthIndex(first) + 1

  if (span > TIMELINE_MONTH_LIMIT) {
    const counts = new Map<string, number>()
    for (const hit of hits) {
      const year = hit.entry.date.slice(0, 4)
      counts.set(year, (counts.get(year) ?? 0) + 1)
    }
    return {
      unit: 'year',
      buckets: [...counts.keys()]
        .sort()
        .map((year) => ({
          key: year,
          year: Number(year),
          month: 0,
          n: counts.get(year) ?? 0,
          label: `${year.slice(2)}年`,
          dateLabel: year
        }))
    }
  }

  const counts = new Map<string, number>()
  for (const hit of hits) {
    const key = hit.entry.date.slice(0, 7)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const buckets: TimelineBucket[] = []
  for (let index = 0; index < span; index += 1) {
    const cursor = monthIndex(first) + index
    const year = Math.floor(cursor / 12)
    const month = (cursor % 12) + 1
    const key = `${year}-${String(month).padStart(2, '0')}`
    const label =
      month === 1
        ? `${String(year).slice(2)}年`
        : index === 0 || month % 3 === 1
          ? `${month}月`
          : ''
    buckets.push({
      key,
      year,
      month,
      n: counts.get(key) ?? 0,
      label,
      dateLabel: `${year}-${String(month).padStart(2, '0')}`
    })
  }
  return { unit: 'month', buckets }
}

function buildStreaks(dates: readonly LocalDate[]): Record<string, StreakInfo> {
  const streakOf: Record<string, StreakInfo> = {}
  let runStart = 0
  for (let index = 0; index <= dates.length; index += 1) {
    const broken =
      index === dates.length ||
      (index > 0 && daysBetween(dates[index - 1]!, dates[index]!) !== 1)
    if (!broken) continue
    const len = index - runStart
    for (let offset = 0; offset < len; offset += 1) {
      streakOf[dates[runStart + offset]!] = { idx: offset + 1, len }
    }
    runStart = index
  }
  return streakOf
}

/**
 * 一次扫描产出概览、时间线、连续段与证据分组。
 * 命中规则与 searchEntries 一致（空格分词为"与"，标题/正文/标签都算），保证"卡片与列表同源"。
 */
export function analyzeSearch(
  entries: readonly DiaryEntry[],
  query: string,
  options: SearchOptions = {}
): SearchAnalysis | null {
  const terms = normalizeQuery(query)
  if (terms.length === 0) return null
  const needles = terms.map(normalizeText)

  const hits: SearchHitDetail[] = []
  for (const entry of entries) {
    const lowerTitle = normalizeText(entry.title)
    const plainBody = normalizeText(plainText(entry.body))
    const lowerTags = entry.tags.map(normalizeText)

    let titleHits = 0
    let bodyHits = 0
    let matched = true
    for (const needle of needles) {
      const inTitle = countOccurrences(lowerTitle, needle)
      const inBody = countOccurrences(plainBody, needle)
      const inTags = lowerTags.filter((tag) => tag.includes(needle)).length
      if (inTitle + inBody + inTags === 0) {
        matched = false
        break
      }
      titleHits += inTitle
      bodyHits += inBody
    }
    if (!matched) continue

    hits.push({
      entry,
      title: deriveLocalTitle(entry, options.hideTitle),
      titleHits,
      bodyHits,
      snippets: buildSnippets(entry.body, needles)
    })
  }

  hits.sort((a, b) => (a.entry.date < b.entry.date ? 1 : -1))

  const byYear: SearchYearGroup[] = []
  for (const hit of hits) {
    const year = hit.entry.date.slice(0, 4)
    const group = byYear[byYear.length - 1]
    if (!group || group.year !== year) {
      byYear.push({ year, hits: [hit] })
    } else {
      group.hits.push(hit)
    }
  }

  const dates = [...new Set(hits.map((hit) => hit.entry.date))].sort()

  return {
    query: query.trim(),
    terms,
    hits,
    byYear,
    timeline: buildTimeline(hits),
    streakOf: buildStreaks(dates),
    firstHit: dates[0] ?? null,
    lastHit: dates[dates.length - 1] ?? null
  }
}
