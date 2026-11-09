import { useMemo } from 'react'

import { MessageSquare, Paperclip } from 'lucide-react'

import { copy } from '@shared/copy'
import {
  analyzeSearch,
  filterByTag,
  highlightSegments,
  type HighlightSegment
} from '@shared/search'
import { formatMonthDayWithWeekdayCN, monthOf } from '@shared/date'
import type { DiaryEntry } from '@shared/types'
import { countEntryWords, deriveTitle, makeSnippet } from '@shared/words'

import { ColumnResizer } from '@/components/ui/ColumnResizer'
import { useEntriesStore } from '@/stores/entries'
import { persistLayout, usePrefsStore } from '@/stores/prefs'
import { useUiStore } from '@/stores/ui'

import styles from './list.module.scss'

interface ListItem {
  date: string
  title: string
  snippet: string
  /** 检索结果用结构化片段（最多两条，带高亮段） */
  snippets?: HighlightSegment[][]
  attachments: number
  annotations: number
}

export function EntryList(): React.JSX.Element {
  const entries = useEntriesStore((state) => state.entries)
  const annotationsByDate = useEntriesStore((state) => state.annotations)
  const activeDate = useEntriesStore((state) => state.activeDate)
  const query = useEntriesStore((state) => state.searchQuery)
  const tag = useEntriesStore((state) => state.activeTag)
  const openDate = useEntriesStore((state) => state.openDate)
  const setTag = useEntriesStore((state) => state.setTag)
  const prefs = usePrefsStore((state) => state.prefs)
  const setView = useUiStore((state) => state.setView)
  const openSearchPreview = useUiStore((state) => state.openSearchPreview)
  const calendarMonth = useUiStore((state) => state.calendarMonth)
  const listScope = useUiStore((state) => state.listScope)
  const setListScope = useUiStore((state) => state.setListScope)
  const listWidth = useUiStore((state) => state.listWidth)
  const setListWidth = useUiStore((state) => state.setListWidth)

  const hideTitle = prefs?.hideTitle ?? false
  const searching = query.trim().length > 0
  const { year, month } = monthOf(calendarMonth)

  const monthEntries = useMemo(() => {
    const prefix = `${year}-${String(month).padStart(2, '0')}`
    return entries.filter((entry) => entry.date.startsWith(prefix))
  }, [entries, year, month])

  const scopedEntries = listScope === 'month' ? monthEntries : entries

  const items = useMemo<ListItem[]>(() => {
    const toDesc = (list: readonly DiaryEntry[]): ListItem[] =>
      [...list]
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .map((entry) => ({
          date: entry.date,
          title: hideTitle
            ? deriveTitle('', entry.body) || copy.list.untitled
            : entry.title || copy.list.untitled,
          snippet: makeSnippet(entry.body, entry.title),
          attachments: entry.attachments.length,
          annotations: annotationsByDate[entry.date]?.length ?? 0
        }))

    // 搜索与标签是"全库"视图；只有普通列表跟随日历月份
    if (searching) {
      // 与检索洞察共用同一次分析结果，保证"卡片说几篇、列表就是几条"
      const analysis = analyzeSearch(entries, query, { hideTitle })
      return (analysis?.hits ?? []).map((hit) => ({
        date: hit.entry.date,
        // 无标题时不重复显示"正文首行"，交给片段说明
        title: hideTitle ? '' : hit.entry.title.trim(),
        snippet: hit.snippets[0]?.text ?? '',
        snippets: hit.snippets.map((snippet) => snippet.segments),
        attachments: hit.entry.attachments.length,
        annotations: annotationsByDate[hit.entry.date]?.length ?? 0
      }))
    }
    if (tag) return toDesc(filterByTag(entries, tag))
    return toDesc(scopedEntries)
  }, [entries, searching, query, tag, hideTitle, scopedEntries, annotationsByDate])

  const totalWords = useMemo(
    () =>
      (searching || tag ? entries : scopedEntries).reduce(
        (sum, entry) => sum + (entry.wordCount || countEntryWords(entry.title, entry.body)),
        0
      ),
    [entries, scopedEntries, searching, tag]
  )

  const heading = searching
    ? copy.list.searchResults
    : tag
      ? `${copy.list.tagPrefix} #${tag}`
      : listScope === 'month'
        ? copy.list.monthTitle(year, month)
        : copy.list.allEntries

  const meta = searching
    ? copy.list.results(items.length)
    : listScope === 'month' && !tag
      ? copy.list.monthMeta(items.length, totalWords)
      : copy.list.total(items.length, totalWords)

  const showScopeToggle = !searching && !tag

  return (
    <section className={styles.list} data-testid="entry-list">
      <header className={styles.head}>
        <div className={styles.headRow}>
          <h2>{heading}</h2>
          {showScopeToggle ? (
            <div className={styles.scope} role="group" aria-label={copy.list.scopeHint}>
              <button
                type="button"
                aria-pressed={listScope === 'month'}
                onClick={() => setListScope('month')}
              >
                {copy.list.scopeMonth}
              </button>
              <button
                type="button"
                aria-pressed={listScope === 'all'}
                onClick={() => setListScope('all')}
              >
                {copy.list.scopeAll}
              </button>
            </div>
          ) : null}
        </div>
        <div className={styles.metaRow}>
          <span className={styles.meta}>{meta}</span>
          {showScopeToggle ? null : (
            <span className={styles.scopeHint}>{copy.list.allScopeHint}</span>
          )}
        </div>
      </header>

      <div className={styles.scroll}>
        {items.length === 0 ? (
          <div className={styles.empty}>
            {searching ? (
              <>
                <p>{copy.list.emptySearch(query.trim())}</p>
                <p>{copy.list.emptySearchHint}</p>
              </>
            ) : tag || listScope === 'all' ? (
              <p>{copy.list.emptyAll}</p>
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
                  // 搜索结果是"预览"而不是跳转：先把这篇看完整，再决定要不要打开
                  if (searching) {
                    openSearchPreview(item.date)
                    return
                  }
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
                  {item.annotations > 0 ? (
                    <span className={styles.annBadge}>
                      <MessageSquare size={9} />
                      {copy.annotations.badge(item.annotations)}
                    </span>
                  ) : null}
                </div>
                {item.title ? (
                  <div className={styles.itemTitle}>
                    <Highlighted text={item.title} query={query} />
                  </div>
                ) : null}
                {item.snippets ? (
                  item.snippets.map((segments, index) => (
                    <div key={`${item.date}-snippet-${index}`} className={styles.itemSnippet}>
                      {segments.map((segment, segIndex) =>
                        segment.match ? (
                          <mark key={segIndex} className="hitMark">
                            {segment.text}
                          </mark>
                        ) : (
                          <span key={segIndex}>{segment.text}</span>
                        )
                      )}
                    </div>
                  ))
                ) : item.snippet ? (
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
      <ColumnResizer
        side="right"
        value={listWidth}
        min={240}
        max={420}
        label={copy.list.widthHandle}
        onChange={setListWidth}
        onCommit={(width) => {
          persistLayout({ listWidth: width })
        }}
      />
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
