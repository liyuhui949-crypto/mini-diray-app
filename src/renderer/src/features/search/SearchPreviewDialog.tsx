import { useEffect, useMemo, useRef } from 'react'

import { isPreviewableKind } from '@shared/attachmentIndex'
import { copy } from '@shared/copy'
import { daysBetween, formatDateWithWeekdayCN, todayLocalDate } from '@shared/date'
import { analyzeSearch } from '@shared/search'
import { countEntryWords } from '@shared/words'

import { Button, Dialog } from '@/components/ui'
import { MarkdownPreview } from '@/features/editor/MarkdownPreview'
import { useEntriesStore } from '@/stores/entries'
import { useUiStore } from '@/stores/ui'

import styles from './search.module.scss'

interface SearchPreviewDialogProps {
  /** search：检索/列表入口；library：附件库入口（脚注与二级动作不同） */
  from?: 'search' | 'library'
}

/**
 * 日记预览：检索列表、检索洞察与附件库共用同一个对话框。
 * 点结果只预览，不打断当前视图；只有「在日记中打开」才真的跳转。
 */
export function SearchPreviewDialog({ from = 'search' }: SearchPreviewDialogProps): React.JSX.Element {
  const isLibrary = from === 'library'
  const date = useUiStore((state) =>
    isLibrary ? state.attachmentPreviewDate : state.searchPreviewDate
  )
  const close = useUiStore((state) =>
    isLibrary ? state.closeAttachmentPreview : state.closeSearchPreview
  )
  const setView = useUiStore((state) => state.setView)
  const requestSearchJump = useUiStore((state) => state.requestSearchJump)
  const attachmentPreviewAttachmentId = useUiStore((state) => state.attachmentPreviewAttachmentId)
  const openAttachmentLightbox = useUiStore((state) => state.openAttachmentLightbox)
  const entries = useEntriesStore((state) => state.entries)
  const query = useEntriesStore((state) => state.searchQuery)
  const openDate = useEntriesStore((state) => state.openDate)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const entry = date ? entries.find((item) => item.date === date) : undefined

  // 只对这一篇算一次命中次数，用来显示「正文中 n 处提到」
  const bodyHits = useMemo(() => {
    if (!entry || isLibrary) return 0
    return analyzeSearch([entry], query)?.hits[0]?.bodyHits ?? 0
  }, [entry, query, isLibrary])

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

  const switchAttachment = isLibrary
    ? entry?.attachments.find((item) => item.id === attachmentPreviewAttachmentId)
    : undefined
  const canSwitchToAttachment = Boolean(switchAttachment && isPreviewableKind(switchAttachment.kind))

  const openInDiary = (): void => {
    if (!date) return
    close()
    setView('editor')
    void openDate(date)
    if (!isLibrary) requestSearchJump(date, query)
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
          {isLibrary ? (
            <span className={styles.pvNote}>
              {copy.attachmentLibrary.previewNote(entry?.attachments.length ?? 0)}
            </span>
          ) : bodyHits > 0 ? (
            <span className={styles.pvNote}>{copy.search.previewNote(bodyHits, query)}</span>
          ) : null}
          {canSwitchToAttachment && switchAttachment && date ? (
            <Button
              onClick={() => {
                const target = switchAttachment
                const targetDate = date
                close()
                openAttachmentLightbox(target.id, targetDate)
              }}
            >
              {copy.attachmentLibrary.modeAttachment}
            </Button>
          ) : null}
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
            <MarkdownPreview
              body={entry.body}
              attachments={entry.attachments}
              highlight={isLibrary ? '' : query}
            />
          </div>
        </div>
      ) : null}
    </Dialog>
  )
}
