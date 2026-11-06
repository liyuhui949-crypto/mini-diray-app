import { describe, expect, it } from 'vitest'

import {
  addDays,
  buildCalendarGrid,
  daysBetween,
  formatBytes,
  formatDateCN,
  formatDateWithWeekdayCN,
  formatNumberCN,
  isFutureDate,
  isValidLocalDate,
  monthTitleCN,
  parseLocalDate,
  relativeDayLabelCN,
  shiftMonth,
  startOfWeek,
  toLocalDate,
  weekdayHeadersCN,
  weekdayOf
} from '@shared/date'

describe('本地日期', () => {
  it('不会把本地日期换算成 UTC 日期', () => {
    expect(toLocalDate(new Date(2026, 10, 6, 23, 30))).toBe('2026-11-06')
    expect(toLocalDate(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01')
  })

  it('解析为本地零点', () => {
    const date = parseLocalDate('2026-11-06')
    expect(date.getFullYear()).toBe(2026)
    expect(date.getMonth()).toBe(10)
    expect(date.getDate()).toBe(6)
    expect(date.getHours()).toBe(0)
  })

  it('拒绝不存在的日期与错误格式', () => {
    expect(isValidLocalDate('2026-02-30')).toBe(false)
    expect(isValidLocalDate('2025-02-29')).toBe(false)
    expect(isValidLocalDate('2024-02-29')).toBe(true)
    expect(isValidLocalDate('2026-13-01')).toBe(false)
    expect(isValidLocalDate('2026-1-1')).toBe(false)
    expect(() => parseLocalDate('2026-02-30')).toThrow()
  })

  it('跨月/跨年加减与差值是日历日', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01')
    expect(daysBetween('2026-01-01', '2026-03-01')).toBe(59)
    expect(daysBetween('2026-03-01', '2026-01-01')).toBe(-59)
  })

  it('周起始固定为周一', () => {
    // 2026-11-06 是周五
    expect(weekdayOf('2026-11-06')).toBe(5)
    expect(startOfWeek('2026-11-06')).toBe('2026-11-02')
    // 周一自己就是一周的第一天
    expect(startOfWeek('2026-11-02')).toBe('2026-11-02')
    // 周日归到前一个周一
    expect(startOfWeek('2026-11-01')).toBe('2026-10-26')
    expect(weekdayHeadersCN()).toEqual(['一', '二', '三', '四', '五', '六', '日'])
  })

  it('月历固定 42 格并标记跨月与今天', () => {
    const grid = buildCalendarGrid('2026-11-01', '2026-11-06')
    expect(grid).toHaveLength(42)
    expect(grid[0]?.date).toBe('2026-10-26')
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(30)
    expect(grid.find((cell) => cell.isToday)?.date).toBe('2026-11-06')
    expect(grid.filter((cell) => cell.isFuture)).toHaveLength(30)
  })

  it('闰年二月与跨年切月', () => {
    const grid = buildCalendarGrid('2024-02-01', '2024-02-10')
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(29)
    expect(shiftMonth('2026-01-15', -1)).toBe('2025-12-01')
    expect(shiftMonth('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('中文格式与相对标签', () => {
    expect(formatDateCN('2026-11-06')).toBe('2026年11月6日')
    expect(formatDateWithWeekdayCN('2026-11-06')).toBe('2026年11月6日 · 星期五')
    expect(monthTitleCN('2026-11-06')).toBe('2026年11月')
    expect(relativeDayLabelCN('2026-11-06', '2026-11-06')).toBe('今天')
    expect(relativeDayLabelCN('2026-11-05', '2026-11-06')).toBe('昨天')
    expect(relativeDayLabelCN('2026-11-01', '2026-11-06')).toBe('5 天前')
    expect(relativeDayLabelCN('2026-11-08', '2026-11-06')).toBe('2 天后')
    expect(isFutureDate('2026-11-07', '2026-11-06')).toBe(true)
    expect(isFutureDate('2026-11-06', '2026-11-06')).toBe(false)
  })

  it('数字与字节格式化使用中文口径', () => {
    expect(formatNumberCN(1234567)).toBe('1,234,567')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1536 * 1024)).toBe('1.5 MB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB')
  })
})
