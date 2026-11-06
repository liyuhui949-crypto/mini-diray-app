import { useEffect, useMemo, useState } from 'react'

import { copy } from '@shared/copy'
import { formatBytes, formatNumberCN, todayLocalDate } from '@shared/date'
import { calcStats, heatmapColumns, statsRangeLabel, weeklyBuckets } from '@shared/stats'
import type { StorageStats } from '@shared/types'

import { call } from '@/api/client'
import { useEntriesStore } from '@/stores/entries'

import styles from './stats.module.scss'

export function StatsPane(): React.JSX.Element {
  const entries = useEntriesStore((state) => state.entries)
  const [storage, setStorage] = useState<StorageStats | null>(null)

  const today = todayLocalDate()
  const options = useMemo(() => ({ today }), [today])
  const stats = useMemo(() => calcStats(entries, options), [entries, options])
  const weeks = useMemo(() => weeklyBuckets(entries, 12, options), [entries, options])
  const heat = useMemo(() => heatmapColumns(entries, 13, options), [entries, options])
  const range = statsRangeLabel(stats)

  useEffect(() => {
    let cancelled = false
    void call('stats:storage', undefined)
      .then((value) => {
        if (!cancelled) setStorage(value)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [entries])

  const maxWeek = Math.max(1, ...weeks.map((week) => week.count))

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <h1>{copy.stats.title}</h1>
        <p>
          {range
            ? copy.stats.subtitle(range.first, range.last)
            : copy.stats.subtitleEmpty}
        </p>
      </div>

      <div className={styles.grid}>
        <StatCard
          label={copy.stats.totalEntries}
          value={formatNumberCN(stats.totalEntries)}
          unit={copy.stats.unitEntries}
        />
        <StatCard
          label={copy.stats.perWeek}
          value={stats.perWeek.toFixed(1)}
          unit={copy.stats.unitEntries}
        />
        <StatCard
          label={copy.stats.longestStreak}
          value={formatNumberCN(stats.longestStreak)}
          unit={copy.stats.unitDays}
        />
        <StatCard
          label={copy.stats.currentStreak}
          value={formatNumberCN(stats.currentStreak)}
          unit={copy.stats.unitDays}
        />
        <StatCard
          label={copy.stats.totalWords}
          value={formatNumberCN(stats.totalWords)}
          unit={copy.stats.unitWords}
        />
        <StatCard label={copy.stats.avgWords} value={stats.avgWords.toFixed(1)} unit={copy.stats.unitWords} />
      </div>

      <section className={styles.panel}>
        <h3>
          {copy.stats.weeklyTitle}
          <span className={styles.hint}>{copy.stats.weeklyHint}</span>
        </h3>
        <div className={styles.bars}>
          {weeks.map((week) => (
            <div key={week.start} className={styles.bar} title={`${week.start} · ${week.count} 篇`}>
              <div
                className={styles.barFill}
                style={{ height: `${Math.max(2, (week.count / maxWeek) * 100)}%` }}
              />
              <span>{week.start.slice(5).replace('-', '/')}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.panel}>
        <h3>
          {copy.stats.heatTitle}
          <span className={styles.hint}>{copy.stats.heatHint}</span>
        </h3>
        <div className={styles.heat}>
          {heat.map((column) => (
            <div key={column.cells[0]?.date ?? ''} className={styles.heatCol}>
              {column.cells.map((cell) => (
                <i
                  key={cell.date}
                  data-level={cell.level}
                  title={`${cell.date} · ${cell.words} 字`}
                />
              ))}
            </div>
          ))}
        </div>
        <div className={styles.legend}>
          {copy.stats.heatLess}
          <i data-level={0} />
          <i data-level={1} />
          <i data-level={2} />
          <i data-level={3} />
          <i data-level={4} />
          {copy.stats.heatMore}
        </div>
      </section>

      <section className={styles.panel}>
        <h3>{copy.stats.storageTitle}</h3>
        <Row label={copy.stats.storageEntries} value={`${formatNumberCN(storage?.entryCount ?? 0)} 篇`} />
        <Row
          label={copy.stats.storageAttachments}
          value={`${formatNumberCN(storage?.attachmentCount ?? 0)} 个`}
        />
        <Row label={copy.stats.storageAttachmentBytes} value={formatBytes(storage?.attachmentBytes ?? 0)} />
        {storage && storage.orphanCount > 0 ? (
          <Row
            label={copy.stats.storageOrphan}
            value={`${formatNumberCN(storage.orphanCount)} 个 · ${formatBytes(storage.orphanBytes)}`}
          />
        ) : null}
        <Row label={copy.stats.storageVault} value={formatBytes(storage?.vaultBytes ?? 0)} />
      </section>
    </div>
  )
}

function StatCard({
  label,
  value,
  unit
}: {
  label: string
  value: string
  unit: string
}): React.JSX.Element {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>
        {value}
        <span className={styles.statUnit}>{unit}</span>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className={styles.row}>
      <span>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  )
}
