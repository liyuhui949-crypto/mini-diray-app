import type { LocalDate } from './types'

export interface WriteGuardOptions {
  today: LocalDate
  /** 偏好：允许写未来日期（历史仍然封存） */
  allowFutureEntries: boolean
  /** 仅测试/演示使用：允许写入历史（环境变量开启） */
  allowHistory?: boolean
}

/**
 * 可写性铁律：只有今天可写正文；打开 allowFutureEntries 时未来可写；
 * 历史日期永远只读（批注是唯一补偿通道）。
 */
export function isWritableDate(date: LocalDate, options: WriteGuardOptions): boolean {
  if (date === options.today) return true
  if (date > options.today && options.allowFutureEntries) return true
  return options.allowHistory === true
}
