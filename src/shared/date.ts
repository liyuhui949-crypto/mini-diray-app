import type { LocalDate } from './types'

const WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const
const WEEKDAY_SHORT_CN = ['日', '一', '二', '三', '四', '五', '六'] as const
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_DAY = 86_400_000

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Date → 本地 `YYYY-MM-DD`（不做 UTC 转换） */
export function toLocalDate(date: Date): LocalDate {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** `YYYY-MM-DD` → 本地零点 Date；非法输入抛错 */
export function parseLocalDate(value: LocalDate): Date {
  if (!LOCAL_DATE_RE.test(value)) throw new Error(`非法日期：${value}`)
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(`日期不存在：${value}`)
  }
  return date
}

export function isValidLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== 'string' || !LOCAL_DATE_RE.test(value)) return false
  try {
    parseLocalDate(value)
    return true
  } catch {
    return false
  }
}

export function todayLocalDate(now: Date = new Date()): LocalDate {
  return toLocalDate(now)
}

/** 本地日期加减天数（跨 DST 也按日历日计算） */
export function addDays(value: LocalDate, days: number): LocalDate {
  const date = parseLocalDate(value)
  return toLocalDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days))
}

/** 所在周的第一天（固定周一，日历与统计共用同一口径） */
export function startOfWeek(value: LocalDate): LocalDate {
  const date = parseLocalDate(value)
  const offset = (date.getDay() + 6) % 7
  return addDays(value, -offset)
}

/** 两个本地日期相差的日历天数（b - a） */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const start = parseLocalDate(a)
  const end = parseLocalDate(b)
  const startUTC = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())
  const endUTC = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate())
  return Math.round((endUTC - startUTC) / MS_PER_DAY)
}

export function isFutureDate(value: LocalDate, today: LocalDate): boolean {
  return value > today
}

export function weekdayCN(value: LocalDate): string {
  return WEEKDAY_CN[parseLocalDate(value).getDay()] ?? ''
}

export function weekdayShortCN(weekday: number): string {
  return WEEKDAY_SHORT_CN[((weekday % 7) + 7) % 7] ?? ''
}

export function monthTitleCN(value: LocalDate): string {
  const date = parseLocalDate(value)
  return `${date.getFullYear()}年${date.getMonth() + 1}月`
}

export function formatDateCN(value: LocalDate): string {
  const date = parseLocalDate(value)
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

export function formatDateWithWeekdayCN(value: LocalDate): string {
  return `${formatDateCN(value)} · ${weekdayCN(value)}`
}

export function formatMonthDayCN(value: LocalDate): string {
  const date = parseLocalDate(value)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function formatMonthDayWithWeekdayCN(value: LocalDate): string {
  return `${formatMonthDayCN(value)} · ${weekdayCN(value)}`
}

/** 相对今天的标签：今天 / 昨天 / N 天前 / N 天后 */
export function relativeDayLabelCN(value: LocalDate, today: LocalDate): string {
  const diff = daysBetween(today, value)
  if (diff === 0) return '今天'
  if (diff === -1) return '昨天'
  if (diff === 1) return '明天'
  if (diff < 0) return `${-diff} 天前`
  return `${diff} 天后`
}

/** 把 `2026-11` 形式转成当月第一天 */
export interface CalendarCell {
  date: LocalDate
  day: number
  inMonth: boolean
  isToday: boolean
  isFuture: boolean
}

/** 6×7 月历网格，固定 42 格 */
export function buildCalendarGrid(cursor: LocalDate, today: LocalDate): CalendarCell[] {
  const cursorDate = parseLocalDate(cursor)
  const year = cursorDate.getFullYear()
  const month = cursorDate.getMonth()
  const first = new Date(year, month, 1)
  const offset = (first.getDay() + 6) % 7
  const cells: CalendarCell[] = []
  for (let i = 0; i < 42; i++) {
    const date = new Date(year, month, 1 - offset + i)
    const value = toLocalDate(date)
    cells.push({
      date: value,
      day: date.getDate(),
      inMonth: date.getMonth() === month,
      isToday: value === today,
      isFuture: value > today
    })
  }
  return cells
}

/** 月历标题里用到的年份与月份 */
export function monthOf(value: LocalDate): { year: number; month: number } {
  const date = parseLocalDate(value)
  return { year: date.getFullYear(), month: date.getMonth() + 1 }
}

/** 上/下个月（日期固定落到 1 号，避免 31 号跳月溢出） */
export function shiftMonth(value: LocalDate, delta: number): LocalDate {
  const date = parseLocalDate(value)
  return toLocalDate(new Date(date.getFullYear(), date.getMonth() + delta, 1))
}

export function weekdayOf(value: LocalDate): number {
  return parseLocalDate(value).getDay()
}

/** 中文星期表（周一开始） */
export function weekdayHeadersCN(): string[] {
  const result: string[] = []
  for (let i = 0; i < 7; i++) {
    result.push(weekdayShortCN(1 + i))
  }
  return result
}

/** `Intl` 中文数字格式化（千分位） */
export function formatNumberCN(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

/** 人类可读的字节数（中文单位） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exponent
  const digits = exponent === 0 ? 0 : value < 10 ? 1 : 0
  return `${value.toFixed(digits)} ${units[exponent]}`
}

/** 文件时间戳 `${HH}:${MM}` */
export function formatClockCN(date: Date = new Date()): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}
