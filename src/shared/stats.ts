import type { DiaryEntry, LocalDate } from './types'
import { addDays, daysBetween, parseLocalDate, startOfWeek, toLocalDate } from './date'
import { countEntryWords } from './words'

export interface DiaryStats {
  totalEntries: number
  perWeek: number
  longestStreak: number
  currentStreak: number
  totalWords: number
  avgWords: number
  firstDate: LocalDate | null
  lastDate: LocalDate | null
}

export interface StatsOptions {
  today: LocalDate
}

export function hasContent(entry: DiaryEntry): boolean {
  return (
    entry.title.trim().length > 0 ||
    entry.body.trim().length > 0 ||
    entry.tags.length > 0 ||
    entry.attachments.length > 0
  )
}

function sortedDates(entries: readonly DiaryEntry[]): LocalDate[] {
  const dates = new Set<LocalDate>()
  for (const entry of entries) {
    if (hasContent(entry)) dates.add(entry.date)
  }
  return [...dates].sort()
}

/** 连续天数：dates 必须已升序 */
function longestRun(dates: readonly LocalDate[]): number {
  let longest = 0
  let run = 0
  let previous: LocalDate | null = null
  for (const date of dates) {
    if (previous && daysBetween(previous, date) === 1) {
      run += 1
    } else {
      run = 1
    }
    if (run > longest) longest = run
    previous = date
  }
  return longest
}

/** 当前连续：以今天或昨天为锚点（今天还没写时仍显示到昨天为止的连续） */
function currentRun(dates: readonly LocalDate[], today: LocalDate): number {
  const set = new Set(dates)
  let cursor = today
  if (!set.has(cursor)) {
    const yesterday = addDays(today, -1)
    if (!set.has(yesterday)) return 0
    cursor = yesterday
  }
  let run = 0
  while (set.has(cursor)) {
    run += 1
    cursor = addDays(cursor, -1)
  }
  return run
}

export function calcStats(entries: readonly DiaryEntry[], options: StatsOptions): DiaryStats {
  const dates = sortedDates(entries)
  const contentEntries = entries.filter(hasContent)
  const totalEntries = contentEntries.length
  const totalWords = contentEntries.reduce(
    (sum, entry) => sum + (entry.wordCount || countEntryWords(entry.title, entry.body)),
    0
  )

  const firstDate = dates[0] ?? null
  const lastDate = dates[dates.length - 1] ?? null

  let perWeek = 0
  if (firstDate) {
    const firstWeekStart = startOfWeek(firstDate)
    const currentWeekStart = startOfWeek(options.today)
    const weeks = Math.floor(daysBetween(firstWeekStart, currentWeekStart) / 7) + 1
    perWeek = totalEntries / Math.max(1, weeks)
  }

  return {
    totalEntries,
    perWeek,
    longestStreak: longestRun(dates),
    currentStreak: currentRun(dates, options.today),
    totalWords,
    avgWords: totalEntries === 0 ? 0 : totalWords / totalEntries,
    firstDate,
    lastDate
  }
}

export interface WeeklyBucket {
  /** 该周第一天（按偏好周起始） */
  start: LocalDate
  count: number
  words: number
}

/** 最近 N 周（含本周）的每周条目数，用于柱状图 */
export function weeklyBuckets(
  entries: readonly DiaryEntry[],
  weeks: number,
  options: StatsOptions
): WeeklyBucket[] {
  const currentWeekStart = startOfWeek(options.today)
  const buckets: WeeklyBucket[] = []
  const index = new Map<LocalDate, WeeklyBucket>()
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(currentWeekStart, -7 * i)
    const bucket: WeeklyBucket = { start, count: 0, words: 0 }
    buckets.push(bucket)
    index.set(start, bucket)
  }
  for (const entry of entries) {
    if (!hasContent(entry)) continue
    if (entry.date > options.today) continue
    const weekStart = startOfWeek(entry.date)
    const bucket = index.get(weekStart)
    if (!bucket) continue
    bucket.count += 1
    bucket.words += entry.wordCount || countEntryWords(entry.title, entry.body)
  }
  return buckets
}

export type HeatLevel = 0 | 1 | 2 | 3 | 4

export interface HeatCell {
  date: LocalDate
  count: number
  words: number
  level: HeatLevel
}

export interface HeatColumn {
  cells: HeatCell[]
}

function levelForWords(words: number): HeatLevel {
  if (words <= 0) return 0
  if (words < 50) return 1
  if (words < 150) return 2
  if (words < 400) return 3
  return 4
}

/** 最近 N 周的热力图：按列（周）组织，每列 7 天，行从周起始日开始 */
export function heatmapColumns(
  entries: readonly DiaryEntry[],
  weeks: number,
  options: StatsOptions
): HeatColumn[] {
  const currentWeekStart = startOfWeek(options.today)
  const byDate = new Map<LocalDate, { count: number; words: number }>()
  for (const entry of entries) {
    if (!hasContent(entry)) continue
    const current = byDate.get(entry.date) ?? { count: 0, words: 0 }
    current.count += 1
    current.words += entry.wordCount || countEntryWords(entry.title, entry.body)
    byDate.set(entry.date, current)
  }

  const columns: HeatColumn[] = []
  for (let column = weeks - 1; column >= 0; column--) {
    const weekStart = addDays(currentWeekStart, -7 * column)
    const cells: HeatCell[] = []
    for (let day = 0; day < 7; day++) {
      const date = addDays(weekStart, day)
      const data = byDate.get(date) ?? { count: 0, words: 0 }
      cells.push({
        date,
        count: data.count,
        words: data.words,
        level: date > options.today ? 0 : levelForWords(data.words)
      })
    }
    columns.push({ cells })
  }
  return columns
}

/** 条目按月分组计数，用于日历上"这个月 N 篇" */
export function countEntriesInMonth(
  entries: readonly DiaryEntry[],
  year: number,
  month: number
): number {
  const prefix = `${year}-${String(month).padStart(2, '0')}`
  let count = 0
  for (const entry of entries) {
    if (hasContent(entry) && entry.date.startsWith(prefix)) count += 1
  }
  return count
}

/** 统计页日期范围文案 */
export function statsRangeLabel(stats: DiaryStats): { first: string; last: string } | null {
  if (!stats.firstDate || !stats.lastDate) return null
  const first = parseLocalDate(stats.firstDate)
  const last = parseLocalDate(stats.lastDate)
  const format = (date: Date): string =>
    `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
  return { first: format(first), last: format(last) }
}

/** 今天的本地日期（测试可注入） */
export function nowLocalDate(now: Date = new Date()): LocalDate {
  return toLocalDate(now)
}
