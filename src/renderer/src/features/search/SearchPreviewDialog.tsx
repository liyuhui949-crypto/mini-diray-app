import { useEffect, useMemo, useRef } from 'react'

import { copy } from '@shared/copy'
import { daysBetween, formatDateWithWeekdayCN, todayLocalDate } from '@shared/date'
import { analyzeSearch } from '@shared/search'
import { countEntryWords } from '@shared/words'

import { Button, Dialog } from '@/components/ui'
import { MarkdownPreview } from '@/features/editor/MarkdownPreview'
import { useEntriesStore } from '@/stores/entries'
import { useUiStore } from '@/stores/ui'

import styles from './search.module.scss'

/**
 * 搜索结果预览：列表与检索洞察共用同一个对话框。
 * 点结果只预览，不打断检索；只有「在日记中打开」才真的跳转。
 */
export function SearchPreviewDialog(): React.JSX.Element {
  const date = useUiStore((state) => state.searchPreviewDate)
  const close = useUiStore((state) => state.closeSearchPreview)
  const setView = useUiStore((state) => state.setView)
  const requestSearchJump = useUiStore((state) => state.requestSearchJump)
  const entries = useEntriesStore((state) => state.entries)
  const query = useEntriesStore((state) => state.searchQuery)
  const openDate = useEntriesStore((state) => state.openDate)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const entry = date ? entries.find((item) => item.date === date) : undefined

  // 只对这一篇算一次命中次数，用来显示「正文中 n 处提到」
  const bodyHits = useMemo(() => {
    if (!entry) return 0
    return analyzeSearch([entry], query)?.hits[0]?.bodyHits ?? 0
  }, [entry, query])

  // 打开后滚到第一个命中处（没有命中就停在顶部）
  useEffect(() => {
    const host = bodyRef.current
    if (!host || !date) return
    host.scrollTop = 0
    const first = host.querySelector('mark')
    if (first) first.scrollIntoView({ block: 'center' })
  }, [date])

  const days = date ? daysBetween(date, todayLocalDate()) : 0
  const distance =
    days <= 0 ? copy.editor.today : days === 1 ? copy.editor.yesterday : copy.editor.daysAgo(days)
  const words = entry ? entry.wordCount || countEntryWords(entry.title, entry.body) : 0

  const openInDiary = (): void => {
    if (!date) return
    close()
    setView('editor')
    void openDate(date)
    requestSearchJump(date, query)
  }

  return (
    <Dialog
      open={Boolean(date && entry)}
      onOpenChange={(value) => {
        if (!value) close()
      }}
      width={720}
      title={entry?.title.trim() || copy.list.untitled}
      description={
        date ? (
          <span className={styles.pvMeta}>
            <span>{formatDateWithWeekdayCN(date)}</span>
            <span>{distance}</span>
            <span>{copy.editor.wordCount(words)}</span>
          </span>
        ) : undefined
      }
      footer={
        <>
          <span className={styles.pvNote}>
            {bodyHits > 0
              ? copy.search.previewNote(bodyHits, query)
              : copy.search.previewNoteEmpty}
          </span>
          <Button onClick={close}>{copy.common.close}</Button>
          <Button variant="primary" onClick={openInDiary}>
            {copy.search.openInDiary}
          </Button>
        </>
      }
    >
      {entry ? (
        <div className={styles.pvBody} ref={bodyRef}>
          {entry.tags.length > 0 ? (
            <div className={styles.pvTags}>
              {entry.tags.map((tag) => (
                <span key={tag} className={styles.pvTag}>
                  #{tag}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mdPreview">
            <MarkdownPreview body={entry.body} attachments={entry.attachments} highlight={query} />
          </div>
        </div>
      ) : null}
    </Dialog>
  )
}
