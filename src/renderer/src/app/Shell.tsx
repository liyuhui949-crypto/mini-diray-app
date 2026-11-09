import { useEffect, useMemo, useRef, useState } from 'react'

import {
  ArrowRight,
  BarChart3,
  ChevronRight,
  Loader2,
  Lock,
  PanelLeft,
  Search,
  Settings
} from 'lucide-react'

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
import { SearchPane } from '@/features/search/SearchPane'
import { StatsPane } from '@/features/stats/StatsPane'
import { useEntriesStore } from '@/stores/entries'
import { persistLayout, usePrefsStore } from '@/stores/prefs'
import { useUiStore } from '@/stores/ui'

import styles from './shell.module.scss'

const platform = typeof window !== 'undefined' ? window.miniDiary?.platform : 'darwin'
/** 检索节奏：停手 320ms 自动提交，回车/点按钮立即提交 */
const SEARCH_DEBOUNCE_MS = 320
/** 粘贴一大段文本时只取前 50 个字，避免做无意义的全库扫描 */
const SEARCH_MAX_QUERY = 50

export function Shell(): React.JSX.Element {
  const view = useUiStore((state) => state.view)
  const searchQuery = useEntriesStore((state) => state.searchQuery)
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed)
  const today = todayLocalDate()

  const sidebarColumns = sidebarCollapsed ? 0 : 236
  const listWidth = useUiStore((state) => state.listWidth)

  return (
    <div className={styles.app}>
      <header className={styles.titlebar} data-platform={platform}>
        <button
          type="button"
          className={styles.sidebarToggle}
          aria-label={sidebarCollapsed ? copy.sidebar.expand : copy.menu.toggleSidebar}
          aria-pressed={sidebarCollapsed}
          title={sidebarCollapsed ? copy.sidebar.expand : copy.menu.toggleSidebar}
          onClick={() => {
            const next = !sidebarCollapsed
            setSidebarCollapsed(next)
            persistLayout({ sidebarCollapsed: next })
          }}
        >
          <PanelLeft size={15} />
        </button>
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
        style={{ gridTemplateColumns: `${sidebarColumns}px ${listWidth}px minmax(0, 1fr)` }}
      >
        <Sidebar collapsed={sidebarCollapsed} today={today} />
        <EntryList />
        <main className={styles.main}>
          {view === 'search' && searchQuery.trim() ? <SearchPane /> : null}
          {view === 'editor' || (view === 'search' && !searchQuery.trim()) ? <EditorPane /> : null}
          {view === 'stats' ? <StatsPane /> : null}
          {view === 'settings' ? <PreferencesPane /> : null}
        </main>
      </div>

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
  const annotations = useEntriesStore((state) => state.annotations)
  const searchInput = useEntriesStore((state) => state.searchInput)
  const searchQuery = useEntriesStore((state) => state.searchQuery)
  const setSearchInput = useEntriesStore((state) => state.setSearchInput)
  const commitSearch = useEntriesStore((state) => state.commitSearch)
  const clearSearch = useEntriesStore((state) => state.clearSearch)
  const activeTag = useEntriesStore((state) => state.activeTag)
  const setTag = useEntriesStore((state) => state.setTag)
  const activeDate = useEntriesStore((state) => state.activeDate)
  const openDate = useEntriesStore((state) => state.openDate)
  const calendarMonth = useUiStore((state) => state.calendarMonth)
  const setCalendarMonth = useUiStore((state) => state.setCalendarMonth)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [jumpOpen, setJumpOpen] = useState(false)

  // 选中日期变化时，日历跟随到那一天所在的月份；单纯翻月不改变选中日期
  useEffect(() => {
    setCalendarMonth(activeDate)
  }, [activeDate, setCalendarMonth])

  useEffect(() => {
    if (focusSearchSeq > 0) inputRef.current?.focus()
  }, [focusSearchSeq])

  const pushToast = useUiStore((state) => state.pushToast)
  const pending =
    searchInput.trim().length > 0 && searchInput.trim() !== searchQuery.trim()

  const commit = (): void => {
    const raw = searchInput.trim()
    if (!raw) return
    if (raw.length > SEARCH_MAX_QUERY) {
      commitSearch(raw.slice(0, SEARCH_MAX_QUERY))
      pushToast(copy.search.tooLong(SEARCH_MAX_QUERY))
    } else {
      commitSearch()
    }
    setView('search')
  }

  // 停手 320ms 自动检索；回车/点按钮走 commitNow
  useEffect(() => {
    const value = searchInput.trim()
    if (!value) {
      if (useEntriesStore.getState().searchQuery) {
        clearSearch()
        if (useUiStore.getState().view === 'search') setView('editor')
      }
      return
    }
    const timer = window.setTimeout(commit, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
    // commit 每次渲染都是新的，但只依赖 searchInput 变化触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  const clearAndLeave = (): void => {
    clearSearch()
    if (useUiStore.getState().view === 'search') setView('editor')
  }

  const tags = useMemo(() => collectTags(entries), [entries])
  const monthCount = useMemo(() => {
    const { year, month } = monthOf(calendarMonth)
    return countEntriesInMonth(entries, year, month)
  }, [entries, calendarMonth])

  return (
    <aside className={styles.sidebar} data-collapsed={collapsed} aria-hidden={collapsed}>
      <div className={styles.search} data-pending={pending}>
        <Search size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          value={searchInput}
          placeholder={copy.sidebar.searchPlaceholder}
          aria-label={copy.sidebar.searchPlaceholder}
          onChange={(event) => setSearchInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') clearAndLeave()
          }}
        />
        <button
          type="button"
          className={styles.searchGo}
          title={copy.search.runHint}
          aria-label={copy.search.run}
          disabled={!searchInput.trim()}
          onClick={commit}
        >
          {pending ? (
            <Loader2 size={12} className={styles.searchSpin} />
          ) : (
            <ArrowRight size={12} />
          )}
        </button>
      </div>

      <div className={styles.sideScroll}>
        <section className={styles.block}>
          <div className={styles.blockHead}>
            <span>{copy.sidebar.calendar}</span>
            <span>{monthCount > 0 ? copy.sidebar.entryCountCalendar(monthCount) : ''}</span>
          </div>
          <CalendarPane
            cursor={calendarMonth}
            today={today}
            selected={activeDate}
            entries={entries}
            annotations={annotations}
            allowFutureEntries={prefs?.allowFutureEntries ?? false}
            onCursorChange={setCalendarMonth}
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
              setCalendarMonth(date)
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
