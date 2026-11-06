import { useMemo } from 'react'

import { Paperclip, Plus } from 'lucide-react'

import { copy } from '@shared/copy'
import { filterByTag, highlightSegments, searchEntries } from '@shared/search'
import { formatMonthDayWithWeekdayCN, todayLocalDate } from '@shared/date'
import type { DiaryEntry } from '@shared/types'
import { countEntryWords, deriveTitle, makeSnippet } from '@shared/words'

import { useEntriesStore } from '@/stores/entries'
import { usePrefsStore } from '@/stores/prefs'
import { useUiStore } from '@/stores/ui'

import styles from './list.module.scss'

export function EntryList({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const entries = useEntriesStore((state) => state.entries)
  const activeDate = useEntriesStore((state) => state.activeDate)
  const query = useEntriesStore((state) => state.searchQuery)
  const tag = useEntriesStore((state) => state.activeTag)
  const openDate = useEntriesStore((state) => state.openDate)
  const setTag = useEntriesStore((state) => state.setTag)
  const prefs = usePrefsStore((state) => state.prefs)
  const setView = useUiStore((state) => state.setView)
  const hideTitle = prefs?.hideTitle ?? false

  const totalWords = useMemo(
    () => entries.reduce((sum, entry) => sum + entry.wordCount, 0),
    [entries]
  )

  const items = useMemo(() => {
    const byDateDesc = (list: DiaryEntry[]): DiaryEntry[] =>
      [...list].sort((a, b) => (a.date < b.date ? 1 : -1))

    if (query.trim()) {
      return searchEntries(entries, query, { hideTitle }).map((hit) => ({
        date: hit.entry.date,
        title: hit.title || copy.list.untitled,
        snippet: hit.snippet,
        attachments: hit.entry.attachments.length,
        words: hit.entry.wordCount
      }))
    }
    const base = byDateDesc(tag ? filterByTag(entries, tag) : entries)
    return base.map((entry) => ({
      date: entry.date,
      title: hideTitle
        ? deriveTitle('', entry.body) || copy.list.untitled
        : entry.title || copy.list.untitled,
      snippet: makeSnippet(entry.body, entry.title),
      attachments: entry.attachments.length,
      words: entry.wordCount || countEntryWords(entry.title, entry.body)
    }))
  }, [entries, query, tag, hideTitle])

  const heading = query.trim() ? copy.list.searchResults : tag ? `${copy.list.tagPrefix} #${tag}` : copy.list.allEntries

  return (
    <section className={styles.list} data-collapsed={collapsed} aria-hidden={collapsed}>
      <header className={styles.head}>
        <div>
          <h2>{heading}</h2>
          <div className={styles.meta}>
            {query.trim()
              ? copy.list.results(items.length)
              : copy.list.total(items.length, totalWords)}
          </div>
        </div>
        <button
          type="button"
          className={styles.newBtn}
          title={copy.list.newEntry}
          onClick={() => {
            setView('editor')
            void openDate(todayLocalDate())
          }}
        >
          <Plus size={14} /> {copy.list.newEntry}
        </button>
      </header>

      <div className={styles.scroll}>
        {items.length === 0 ? (
          <div className={styles.empty}>
            {query.trim() ? (
              <>
                <p>{copy.list.emptySearch(query.trim())}</p>
                <p className={styles.emptyHint}>{copy.list.emptySearchHint}</p>
              </>
            ) : (
              <p>{copy.list.empty}</p>
            )}
          </div>
        ) : (
          items.map((item) => {
            const isActive = item.date === activeDate
            return (
              <button
                key={item.date}
                type="button"
                className={[styles.item, isActive ? styles.itemActive : ''].filter(Boolean).join(' ')}
                onClick={() => {
                  setView('editor')
                  void openDate(item.date)
                }}
              >
                <div className={styles.itemDate}>
                  <span>{formatMonthDayWithWeekdayCN(item.date)}</span>
                  {item.attachments > 0 ? (
                    <span className={styles.att}>
                      <Paperclip size={10} />
                      {item.attachments}
                    </span>
                  ) : null}
                </div>
                <div className={styles.itemTitle}>
                  <Highlighted text={item.title} query={query} />
                </div>
                {item.snippet ? (
                  <div className={styles.itemSnippet}>
                    <Highlighted text={item.snippet} query={query} />
                  </div>
                ) : null}
              </button>
            )
          })
        )}
      </div>

      {tag ? (
        <button type="button" className={styles.clearTag} onClick={() => setTag(null)}>
          清除标签筛选
        </button>
      ) : null}
    </section>
  )
}

function Highlighted({ text, query }: { text: string; query: string }): React.JSX.Element {
  if (!query.trim()) return <>{text}</>
  const segments = highlightSegments(text, query)
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index}>{segment.text}</mark>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  )
}

