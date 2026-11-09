import { useEffect, useMemo, useRef, useState } from 'react'

import { copy } from '@shared/copy'
import { formatDateCN, formatMonthDayWithWeekdayCN } from '@shared/date'
import { analyzeSearch, type TimelineBucket } from '@shared/search'

import { useEntriesStore } from '@/stores/entries'
import { usePrefsStore } from '@/stores/prefs'
import { useUiStore } from '@/stores/ui'

import styles from './search.module.scss'

/** 年份色板：同一份结果里，不同年份用不同色（浅色块靠 color-mix 调淡，深色模式也成立） */
const YEAR_TONES = ['#2f6f4e', '#a8814a', '#4a6d9c', '#7a5f96', '#a05f5a', '#6f7a4a']

function tint(tone: string, ratio: number): string {
  return `color-mix(in srgb, ${tone} ${ratio}%, var(--md-bg-surface))`
}

export function SearchPane(): React.JSX.Element {
  const entries = useEntriesStore((state) => state.entries)
  const query = useEntriesStore((state) => state.searchQuery)
  const hideTitle = usePrefsStore((state) => state.prefs?.hideTitle ?? false)
  const setCalendarMonth = useUiStore((state) => state.setCalendarMonth)
  const pushToast = useUiStore((state) => state.pushToast)
  const openSearchPreview = useUiStore((state) => state.openSearchPreview)
  /** 点过柱子的月份（桶 key）；有值时其余月份淡出，做"仿高亮" */
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const analysis = useMemo(
    () => analyzeSearch(entries, query, { hideTitle }),
    [entries, query, hideTitle]
  )

  // 换一次检索就清掉月份聚焦
  useEffect(() => {
    setSelectedBucket(null)
  }, [analysis])

  if (!analysis) {
    return <div className={styles.pane} />
  }

  if (analysis.hits.length === 0) {
    return (
      <div className={styles.pane}>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{copy.list.emptySearch(analysis.query)}</p>
          <p className={styles.emptyHint}>{copy.list.emptySearchHint}</p>
        </div>
      </div>
    )
  }

  const max = Math.max(...analysis.timeline.buckets.map((bucket) => bucket.n), 1)
  const yearTone = new Map(
    analysis.byYear.map((group, index) => [group.year, YEAR_TONES[index % YEAR_TONES.length]!])
  )
  const toneOf = (year: string | number): string =>
    yearTone.get(String(year)) ?? YEAR_TONES[0]!
  // 副行：每个年份各显示"从哪天开始 + 命中几篇"
  const yearParts = analysis.byYear.map((group) => {
    const oldest = group.hits[group.hits.length - 1]!.entry.date
    return `${oldest} ${copy.search.yearHits(group.hits.length)}`
  })
  const dense = analysis.timeline.buckets.length > 18

  const bucketOf = (date: string): string =>
    analysis.timeline.unit === 'month' ? date.slice(0, 7) : date.slice(0, 4)

  const chooseBucket = (bucket: TimelineBucket): void => {
    const nextKey = selectedBucket === bucket.key ? null : bucket.key
    setSelectedBucket(nextKey)
    const month = bucket.month || 1
    setCalendarMonth(`${bucket.year}-${String(month).padStart(2, '0')}-01`)
    if (!nextKey) return
    pushToast(copy.search.jumpedToMonth(`${bucket.year}年${month}月`))
    // 让证据列表滚到该月第一条，并把它放在视口偏上的位置（上方留出时间线的余量）
    window.setTimeout(() => {
      const host = scrollRef.current
      const target = host?.querySelector<HTMLElement>(`[data-bucket="${nextKey}"]`)
      if (!host || !target) return
      const hostRect = host.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const targetTop = targetRect.top - hostRect.top + host.scrollTop
      const anchor = Math.min(320, host.clientHeight * 0.3)
      host.scrollTo({ top: Math.max(0, targetTop - anchor), behavior: 'smooth' })
    }, 60)
  }

  return (
    <div className={styles.pane}>
      <div className={styles.scroll} ref={scrollRef}>
        <section className={styles.hero} data-testid="search-hero">
          <div className={styles.heroCount}>
            <span className={styles.heroLabel}>{copy.search.heroLabel}</span>
            <span className={styles.heroValue} data-testid="search-hit-count">
              {analysis.hits.length}
              <em>{copy.search.heroUnit}</em>
            </span>
          </div>
          <div className={styles.heroSep} />
          <div className={styles.heroMeta}>
            <p className={styles.heroRange}>
              {formatDateCN(analysis.firstHit!)} — {formatDateCN(analysis.lastHit!)}
            </p>
            <p className={styles.heroSub}>{copy.search.heroSub(analysis.byYear.length, yearParts)}</p>
          </div>
        </section>

        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h3>{copy.search.timelineTitle}</h3>
          </header>
          <div className={styles.bars} data-testid="search-bars" data-dense={dense}>
            {analysis.timeline.buckets.map((bucket, index) => {
              const tone = toneOf(bucket.year)
              const percent = bucket.n === 0 ? 3 : Math.round((bucket.n / max) * 100)
              const selected = selectedBucket === bucket.key
              const dimmed = selectedBucket !== null && !selected
              return (
                <button
                  key={bucket.key}
                  type="button"
                  className={styles.bar}
                  data-testid={`search-bar-${bucket.key}`}
                  data-empty={bucket.n === 0}
                  data-selected={selected}
                  data-dimmed={dimmed}
                  title={copy.search.timelineBar(bucket.dateLabel, bucket.n)}
                  aria-label={copy.search.timelineBar(bucket.dateLabel, bucket.n)}
                  aria-pressed={selected}
                  onClick={() => chooseBucket(bucket)}
                >
                  <span className={styles.barTrack}>
                    {/* 数值贴着各自柱顶，高度按每根柱自己的比例算 */}
                    <span className={styles.barValue} style={{ bottom: `calc(${percent}% + 3px)` }}>
                      {bucket.n}
                    </span>
                    <i
                      style={{
                        height: `${percent}%`,
                        background: tint(tone, bucket.n === 0 ? 10 : 62)
                      }}
                    />
                  </span>
                  <span className={styles.barLabel}>
                    {dense && index % 2 === 1 && !selected ? '' : bucket.dateLabel}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <section className={styles.panel}>
          <header className={styles.panelHead}>
            <h3>{copy.search.evidenceTitle(analysis.hits.length)}</h3>
          </header>
          <div className={styles.evidence}>
            {analysis.byYear.map((group) => {
              const groupActive =
                selectedBucket === null ||
                group.hits.some((hit) => bucketOf(hit.entry.date) === selectedBucket)
              return (
              <div key={group.year} className={styles.yearGroup}>
                <div
                  className={styles.yearHead}
                  data-dimmed={!groupActive}
                  style={{
                    background: tint(
                      toneOf(group.year),
                      selectedBucket ? (groupActive ? 18 : 3) : 6
                    )
                  }}
                >
                  <b>{copy.search.yearHead(group.year, group.hits.length)}</b>
                </div>
                {group.hits.map((hit) => {
                  const date = hit.entry.date
                  const rowActive =
                    selectedBucket === null || bucketOf(date) === selectedBucket
                  return (
                    <button
                      key={date}
                      type="button"
                      className={styles.row}
                      data-testid={`search-row-${date}`}
                      data-bucket={bucketOf(date)}
                      data-dimmed={!rowActive}
                      style={
                        {
                          '--row-tone': tint(
                            toneOf(group.year),
                            selectedBucket ? (rowActive ? 7 : 1) : 2
                          ),
                          '--row-tone-hover': tint(
                            toneOf(group.year),
                            selectedBucket ? (rowActive ? 18 : 6) : 10
                          )
                        } as React.CSSProperties
                      }
                      onClick={() => openSearchPreview(date)}
                    >
                      <span className={styles.rowTop}>
                        <span className={styles.rowDate}>
                          {formatMonthDayWithWeekdayCN(date)}
                        </span>
                        {!hideTitle && hit.entry.title.trim() ? (
                          <span className={styles.rowTitle}>{hit.entry.title.trim()}</span>
                        ) : null}
                      </span>
                      {hit.snippets.map((snippet, index) => (
                        <span key={`${date}-snip-${index}`} className={styles.snippet}>
                          {snippet.segments.map((segment, segIndex) =>
                            segment.match ? (
                              <mark key={segIndex} className="hitMark">
                                {segment.text}
                              </mark>
                            ) : (
                              <span key={segIndex}>{segment.text}</span>
                            )
                          )}
                        </span>
                      ))}
                    </button>
                  )
                })}
              </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
