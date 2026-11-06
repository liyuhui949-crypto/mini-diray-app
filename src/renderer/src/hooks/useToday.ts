import { useEffect, useState } from 'react'

import { todayLocalDate } from '@shared/date'
import type { LocalDate } from '@shared/types'

/** 每分钟刷新一次"今天"，跨零点时界面自动跟上 */
export function useToday(): LocalDate {
  const [today, setToday] = useState<LocalDate>(() => todayLocalDate())
  useEffect(() => {
    const timer = window.setInterval(() => setToday(todayLocalDate()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return today
}
