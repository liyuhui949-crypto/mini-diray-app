import type { DiaryEntry, LocalDate } from './types'
import { daysBetween } from './date'
import {
  buildSnippets,
  highlightSegments,
  normalizeForMatch,
  normalizeQuery,
  type HighlightSegment,
  type SearchSnippet
} from './text'
import { deriveTitle, plainText } from './words'

/** 命中条目在列表/证据里的标题：隐藏标题时取正文首行，兜底回原标题 */
function hitTitle(entry: DiaryEntry, hideTitle?: boolean): string {
  const derived = deriveTitle(hideTitle ? '' : entry.title, entry.body)
  return derived || entry.title.trim()
}

export interface SearchOptions {
  hideTitle?: boolean
}

export { highlightSegments, normalizeForMatch as normalizeText, type HighlightSegment }

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

/** 时间线超过这么多个月就按年聚合 */
export const TIMELINE_MONTH_LIMIT = 30

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
 * 命中规则：空格分词为"与"，标题/正文/标签都算，列表与洞察共用这一份结果。
 */
export function analyzeSearch(
  entries: readonly DiaryEntry[],
  query: string,
  options: SearchOptions = {}
): SearchAnalysis | null {
  const terms = normalizeQuery(query)
  if (terms.length === 0) return null
  const needles = terms.map(normalizeForMatch)

  const hits: SearchHitDetail[] = []
  for (const entry of entries) {
    const lowerTitle = normalizeForMatch(entry.title)
    const plainBody = normalizeForMatch(plainText(entry.body))
    const lowerTags = entry.tags.map(normalizeForMatch)

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
      title: hitTitle(entry, options.hideTitle),
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
