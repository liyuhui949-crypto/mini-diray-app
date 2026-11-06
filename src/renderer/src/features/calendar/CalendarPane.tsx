import { useEffect, useMemo, useRef } from 'react'

import { ChevronLeft, ChevronRight } from 'lucide-react'

import { copy } from '@shared/copy'
import {
  addDays,
  buildCalendarGrid,
  formatDateCN,
  monthOf,
  monthTitleCN,
  shiftMonth,
  weekdayHeadersCN,
  weekdayOf
} from '@shared/date'
import { hasContent } from '@shared/stats'
import type { DiaryEntry, LocalDate } from '@shared/types'

import { IconButton } from '@/components/ui'

import styles from './calendar.module.scss'

interface CalendarPaneProps {
  cursor: LocalDate
  today: LocalDate
  selected: LocalDate
  entries: readonly DiaryEntry[]
  allowFutureEntries: boolean
  onCursorChange: (date: LocalDate) => void
  onSelect: (date: LocalDate) => void
}

export function CalendarPane({
  cursor,
  today,
  selected,
  entries,
  allowFutureEntries,
  onCursorChange,
  onSelect
}: CalendarPaneProps): React.JSX.Element {
  const gridRef = useRef<HTMLDivElement | null>(null)
  const cells = useMemo(() => buildCalendarGrid(cursor, today), [cursor, today])
  const datesWithContent = useMemo(() => {
    const set = new Set<LocalDate>()
    for (const entry of entries) {
      if (hasContent(entry)) set.add(entry.date)
    }
    return set
  }, [entries])

  const headers = weekdayHeadersCN()

  useEffect(() => {
    const active = gridRef.current?.querySelector<HTMLButtonElement>('[data-active="true"]')
    if (active && gridRef.current?.contains(document.activeElement)) active.focus()
  }, [cursor])

  const move = (date: LocalDate, event: React.KeyboardEvent): void => {
    const step = (days: number): void => {
      const target = addDays(date, days)
      const targetMonth = monthOf(target)
      const cursorMonth = monthOf(cursor)
      if (targetMonth.year !== cursorMonth.year || targetMonth.month !== cursorMonth.month) {
        onCursorChange(
          `${targetMonth.year}-${String(targetMonth.month).padStart(2, '0')}-01`
        )
      }
      if (target > today && !allowFutureEntries) return
      onSelect(target)
    }

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault()
        step(-1)
        return
      case 'ArrowRight':
        event.preventDefault()
        step(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        step(-7)
        return
      case 'ArrowDown':
        event.preventDefault()
        step(7)
        return
      case 'PageUp':
        event.preventDefault()
        step(-28)
        return
      case 'PageDown':
        event.preventDefault()
        step(28)
        return
      case 'Home':
        event.preventDefault()
        step(-((weekdayOf(date) + 6) % 7))
        return
      case 'End':
        event.preventDefault()
        step(6 - ((weekdayOf(date) + 6) % 7))
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (allowFutureEntries || date <= today) onSelect(date)
        return
      default:
        return
    }
  }

  return (
    <div className={styles.calendar}>
      <div className={styles.title}>
        <b>{monthTitleCN(cursor)}</b>
        <div className={styles.nav}>
          <IconButton
            label={copy.sidebar.prevMonth}
            onClick={() => onCursorChange(shiftMonth(cursor, -1))}
          >
            <ChevronLeft size={14} />
          </IconButton>
          <IconButton
            label={copy.sidebar.nextMonth}
            onClick={() => onCursorChange(shiftMonth(cursor, 1))}
          >
            <ChevronRight size={14} />
          </IconButton>
        </div>
      </div>

      <div className={styles.grid} ref={gridRef} role="grid" aria-label={monthTitleCN(cursor)}>
        {headers.map((header) => (
          <div key={header} className={styles.dow} role="columnheader" aria-label={`星期${header}`}>
            {header}
          </div>
        ))}
        {cells.map((cell) => {
          const disabled = cell.isFuture && !allowFutureEntries
          const isSelected = cell.date === selected
          const classes = [
            styles.day,
            cell.inMonth ? '' : styles.out,
            cell.isToday ? styles.today : '',
            isSelected ? styles.selected : '',
            datesWithContent.has(cell.date) ? styles.hasContent : '',
            disabled ? styles.future : ''
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <button
              key={cell.date}
              type="button"
              role="gridcell"
              className={classes}
              data-date={cell.date}
              data-active={isSelected}
              tabIndex={isSelected ? 0 : -1}
              disabled={disabled}
              aria-label={`${formatDateCN(cell.date)}${datesWithContent.has(cell.date) ? '，有日记' : ''}${disabled ? '，未来日期' : ''}`}
              aria-selected={isSelected}
              onClick={() => {
                if (disabled) return
                onSelect(cell.date)
              }}
              onKeyDown={(event) => move(cell.date, event)}
            >
              {cell.day}
            </button>
          )
        })}
      </div>
    </div>
  )
}
