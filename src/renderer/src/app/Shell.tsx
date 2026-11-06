import { useEffect, useMemo, useRef, useState } from 'react'

import { BarChart3, ChevronRight, Lock, Plus, Search, Settings, X } from 'lucide-react'

import { copy } from '@shared/copy'
import { collectTags } from '@shared/search'
import { countEntriesInMonth } from '@shared/stats'
import { monthOf, todayLocalDate } from '@shared/date'
import type { LocalDate, ThemeMode } from '@shared/types'

import { call } from '@/api/client'
import { CalendarPane } from '@/features/calendar/CalendarPane'
import { JumpToDateDialog } from '@/features/calendar/JumpToDateDialog'
import { EditorPane } from '@/features/editor/EditorPane'
import { EntryList } from '@/features/entry-list/EntryList'
import { PreferencesPane } from '@/features/preferences/PreferencesPane'
import { StatsPane } from '@/features/stats/StatsPane'
import { IconButton } from '@/components/ui'
import { useEntriesStore } from '@/stores/entries'
import { usePrefsStore } from '@/stores/prefs'
import { useUiStore } from '@/stores/ui'

import styles from './shell.module.scss'

const platform = typeof window !== 'undefined' ? window.miniDiary?.platform : 'darwin'

export function Shell(): React.JSX.Element {
  const view = useUiStore((state) => state.view)
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const listCollapsed = useUiStore((state) => state.listCollapsed)
  const openDate = useEntriesStore((state) => state.openDate)
  const today = todayLocalDate()

  const sidebarWidth = sidebarCollapsed ? 0 : 236
  const listWidth = listCollapsed ? 0 : 312

  return (
    <div className={styles.app}>
      <header className={styles.titlebar} data-platform={platform}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>M</span>
          <span className={styles.brandName}>
            <b>{copy.appNameCN}</b>
            {copy.appName}
          </span>
        </div>
        <div className={styles.titleRight}>
          <ThemeSegmented />
        </div>
      </header>

      <div
        className={styles.grid}
        style={{ gridTemplateColumns: `${sidebarWidth}px ${listWidth}px minmax(0, 1fr)` }}
      >
        <Sidebar collapsed={sidebarCollapsed} today={today} />
        <EntryList collapsed={listCollapsed} />
        <main className={styles.main}>
          {view === 'editor' ? <EditorPane /> : null}
          {view === 'stats' ? <StatsPane /> : null}
          {view === 'settings' ? <PreferencesPane /> : null}
        </main>
      </div>

      <button
        type="button"
        className={styles.quickNew}
        onClick={() => {
          useUiStore.getState().setView('editor')
          void openDate(today)
        }}
        aria-label={copy.list.newEntry}
      >
        <Plus size={16} />
      </button>
    </div>
  )
}

function ThemeSegmented(): React.JSX.Element {
  const theme = usePrefsStore((state) => state.prefs?.theme)
  const update = usePrefsStore((state) => state.update)
  const options: Array<{ value: ThemeMode; label: string }> = [
    { value: 'system', label: copy.preferences.themeSystem },
    { value: 'light', label: copy.preferences.themeLight },
    { value: 'dark', label: copy.preferences.themeDark }
  ]
  return (
    <div className={styles.segmented} role="group" aria-label={copy.preferences.theme}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={theme === option.value}
          onClick={() => {
            void update({ theme: option.value })
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

interface SidebarProps {
  collapsed: boolean
  today: LocalDate
}

function Sidebar({ collapsed, today }: SidebarProps): React.JSX.Element {
  const view = useUiStore((state) => state.view)
  const setView = useUiStore((state) => state.setView)
  const focusSearchSeq = useUiStore((state) => state.focusSearchSeq)
  const prefs = usePrefsStore((state) => state.prefs)
  const entries = useEntriesStore((state) => state.entries)
  const searchQuery = useEntriesStore((state) => state.searchQuery)
  const setQuery = useEntriesStore((state) => state.setQuery)
  const activeTag = useEntriesStore((state) => state.activeTag)
  const setTag = useEntriesStore((state) => state.setTag)
  const activeDate = useEntriesStore((state) => state.activeDate)
  const openDate = useEntriesStore((state) => state.openDate)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [monthCursor, setMonthCursor] = useState<LocalDate>(activeDate)
  const [jumpOpen, setJumpOpen] = useState(false)

  useEffect(() => {
    setMonthCursor(activeDate)
  }, [activeDate])

  useEffect(() => {
    if (focusSearchSeq > 0) inputRef.current?.focus()
  }, [focusSearchSeq])

  const tags = useMemo(() => collectTags(entries), [entries])
  const monthCount = useMemo(() => {
    const { year, month } = monthOf(monthCursor)
    return countEntriesInMonth(entries, year, month)
  }, [entries, monthCursor])

  return (
    <aside className={styles.sidebar} data-collapsed={collapsed} aria-hidden={collapsed}>
      <div className={styles.search}>
        <Search size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          value={searchQuery}
          placeholder={copy.sidebar.searchPlaceholder}
          aria-label={copy.sidebar.searchPlaceholder}
          onChange={(event) => {
            setQuery(event.target.value)
            setView('editor')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('')
          }}
        />
        {searchQuery ? (
          <IconButton label={copy.common.close} onClick={() => setQuery('')}>
            <X size={12} />
          </IconButton>
        ) : (
          <kbd>{copy.sidebar.searchShortcut}</kbd>
        )}
      </div>

      <div className={styles.sideScroll}>
        <section className={styles.block}>
          <div className={styles.blockHead}>
            <span>{copy.sidebar.calendar}</span>
            <span>{monthCount > 0 ? copy.sidebar.entryCountCalendar(monthCount) : ''}</span>
          </div>
          <CalendarPane
            cursor={monthCursor}
            today={today}
            selected={activeDate}
            entries={entries}
            firstDayOfWeek={prefs?.firstDayOfWeek ?? 1}
            allowFutureEntries={prefs?.allowFutureEntries ?? false}
            onCursorChange={setMonthCursor}
            onSelect={(date) => {
              setView('editor')
              void openDate(date)
            }}
          />
          <div className={styles.calendarActions}>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => {
                setView('editor')
                void openDate(today)
              }}
            >
              <ChevronRight size={12} aria-hidden="true" />
              {copy.sidebar.today}
            </button>
            <button type="button" className={styles.linkBtn} onClick={() => setJumpOpen(true)}>
              {copy.sidebar.jumpToDate}
            </button>
          </div>
          <JumpToDateDialog
            open={jumpOpen}
            onClose={() => setJumpOpen(false)}
            today={today}
            allowFutureEntries={prefs?.allowFutureEntries ?? false}
            onPick={(date) => {
              setView('editor')
              setMonthCursor(date)
              void openDate(date)
            }}
          />
        </section>

        <section className={styles.block}>
          <div className={styles.blockHead}>
            <span>{copy.sidebar.tags}</span>
            <span>{tags.length > 0 ? tags.length : ''}</span>
          </div>
          <div className={styles.tagList}>
            {tags.length === 0 ? (
              <p className={styles.tagsEmpty}>{copy.sidebar.noTags}</p>
            ) : (
              tags.map((item) => (
                <button
                  key={item.tag}
                  type="button"
                  className={[styles.tagRow, activeTag === item.tag ? styles.tagRowActive : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    setTag(activeTag === item.tag ? null : item.tag)
                    setView('editor')
                  }}
                >
                  <span className={styles.tagHash}>#</span>
                  <span>{item.tag}</span>
                  <span className={styles.tagCount}>{item.count}</span>
                </button>
              ))
            )}
          </div>
        </section>
      </div>

      <div className={styles.sideFooter}>
        <NavButton
          active={view === 'stats'}
          icon={<BarChart3 size={15} />}
          label={copy.sidebar.stats}
          onClick={() => setView('stats')}
        />
        <NavButton
          active={view === 'settings'}
          icon={<Settings size={15} />}
          label={copy.sidebar.settings}
          onClick={() => setView('settings')}
        />
        <NavButton
          icon={<Lock size={15} />}
          label={copy.sidebar.lock}
          shortcut="⌘L"
          onClick={() => {
            void call('vault:lock', undefined)
          }}
        />
      </div>
    </aside>
  )
}

interface NavButtonProps {
  icon: React.ReactNode
  label: string
  shortcut?: string
  active?: boolean
  onClick: () => void
}

function NavButton({ icon, label, shortcut, active, onClick }: NavButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={[styles.navButton, active ? styles.navButtonActive : ''].filter(Boolean).join(' ')}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {shortcut ? <kbd>{shortcut}</kbd> : null}
    </button>
  )
}
