import { useCallback, useEffect, useRef, useState } from 'react'

import {
  AudioLines,
  FileText,
  Image as ImageIcon,
  Video,
  type LucideIcon
} from 'lucide-react'

import {
  buildAttachmentIndex,
  countAttachmentKinds,
  isPreviewableKind,
  totalAttachmentBytes,
  type AttachmentIndexItem,
  type AttachmentTab
} from '@shared/attachmentIndex'
import { copy } from '@shared/copy'
import { formatBytes, parseLocalDate, todayLocalDate } from '@shared/date'
import type { AttachmentKind, LocalDate, OrphanAttachment } from '@shared/types'

import { Button } from '@/components/ui'
import { call } from '@/api/client'
import { CleanupDialog } from '@/features/preferences/AccountDialogs'
import { useEntriesStore } from '@/stores/entries'
import { usePrefsStore } from '@/stores/prefs'
import { useUiStore } from '@/stores/ui'

import styles from './library.module.scss'

type LibraryTab = AttachmentTab | 'orphan'

const TABS: LibraryTab[] = ['all', 'image', 'video', 'audio', 'file', 'orphan']

const SECTIONS: Array<{ kind: AttachmentKind; previewable: boolean }> = [
  { kind: 'image', previewable: true },
  { kind: 'video', previewable: true },
  { kind: 'audio', previewable: true },
  { kind: 'file', previewable: false }
]

const KIND_ICON: Record<AttachmentKind, LucideIcon> = {
  image: ImageIcon,
  video: Video,
  audio: AudioLines,
  file: FileText
}

function shortDate(date: LocalDate): string {
  const parsed = parseLocalDate(date)
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日`
}

function ownerLine(item: AttachmentIndexItem): string {
  return `${shortDate(item.date)} · ${item.entryTitle.trim() || copy.list.untitled}`
}

/**
 * 附件库：纯只读的跨日记聚合视图。
 * 另带一个「未引用」tab 查看/清理没有 entry 引用的遗留附件。
 */
export function AttachmentLibraryPane(): React.JSX.Element {
  const entries = useEntriesStore((state) => state.entries)
  const openAttachmentPreview = useUiStore((state) => state.openAttachmentPreview)
  const openAttachmentLightbox = useUiStore((state) => state.openAttachmentLightbox)
  const openOrphanLightbox = useUiStore((state) => state.openOrphanLightbox)
  const setView = useUiStore((state) => state.setView)
  const openDate = useEntriesStore((state) => state.openDate)
  const mode = usePrefsStore((state) => state.prefs?.attachmentPreviewMode ?? 'entry')
  const [tab, setTab] = useState<LibraryTab>('all')
  const [orphans, setOrphans] = useState<OrphanAttachment[]>([])
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const items = buildAttachmentIndex(entries)
  const counts = countAttachmentKinds(items)
  const bytes = totalAttachmentBytes(items)
  const orphanBytes = orphans.reduce((sum, item) => sum + item.size, 0)

  const refreshOrphans = useCallback(async (): Promise<void> => {
    try {
      const result = await call('attachment:orphans', undefined)
      setOrphans(result.items)
    } catch {
      setOrphans([])
    }
  }, [])

  useEffect(() => {
    void refreshOrphans()
  }, [refreshOrphans, entries])

  const countOf = (key: LibraryTab): number => (key === 'orphan' ? orphans.length : counts[key])

  const changeTab = (next: LibraryTab): void => {
    setTab(next)
    scrollRef.current?.scrollTo({ top: 0 })
  }

  const setMode = (next: 'attachment' | 'entry'): void => {
    void usePrefsStore.getState().update({ attachmentPreviewMode: next })
  }

  const openItem = (item: AttachmentIndexItem): void => {
    const previewable = isPreviewableKind(item.attachment.kind)
    if (previewable && mode === 'attachment') {
      openAttachmentLightbox(item.attachment.id, item.date)
      return
    }
    openAttachmentPreview(item.date, previewable ? item.attachment.id : null)
  }

  const empty = counts.all === 0 || (tab !== 'all' && tab !== 'orphan' && counts[tab] === 0)

  return (
    <div className={styles.pane}>
      <div className={styles.scroll} ref={scrollRef}>
        <div className={styles.inner}>
          <header className={styles.head}>
            <div className={styles.headTop}>
              <div>
                <h1>{copy.attachmentLibrary.title}</h1>
                <p>{copy.attachmentLibrary.meta(counts.all, formatBytes(bytes))}</p>
              </div>
              <div
                className={styles.modeSwitch}
                role="group"
                aria-label={copy.attachmentLibrary.previewModeLabel}
              >
                <button
                  type="button"
                  aria-pressed={mode === 'attachment'}
                  className={mode === 'attachment' ? styles.modeOn : styles.modeBtn}
                  onClick={() => setMode('attachment')}
                >
                  {copy.attachmentLibrary.modeAttachment}
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'entry'}
                  className={mode === 'entry' ? styles.modeOn : styles.modeBtn}
                  onClick={() => setMode('entry')}
                >
                  {copy.attachmentLibrary.modeEntry}
                </button>
              </div>
            </div>
            <div className={styles.tabs} role="tablist" aria-label={copy.attachmentLibrary.title}>
              {TABS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  className={tab === key ? styles.tabOn : styles.tab}
                  onClick={() => changeTab(key)}
                >
                  {copy.attachmentLibrary.tabs[key]}
                  <span className={styles.tabCount}>{countOf(key)}</span>
                </button>
              ))}
            </div>
          </header>

          {tab === 'orphan' ? (
            <section className={styles.section}>
              <h3>
                {copy.attachmentLibrary.tabs.orphan}
                <span className={styles.hint}>
                  {copy.attachmentLibrary.orphanHint(orphans.length, formatBytes(orphanBytes))}
                </span>
                {orphans.length > 0 ? (
                  <span className={styles.sectionAction}>
                    <Button size="sm" variant="danger" onClick={() => setCleanupOpen(true)}>
                      {copy.attachmentLibrary.orphanCleanup}
                    </Button>
                  </span>
                ) : null}
              </h3>
              {orphans.length === 0 ? (
                <div className={styles.empty}>
                  <b>{copy.attachmentLibrary.orphanEmpty}</b>
                  <p>{copy.attachmentLibrary.orphanEmptyHint}</p>
                </div>
              ) : (
                <div className={styles.rows}>
                  {orphans.map((orphan) => {
                    const Icon = KIND_ICON[orphan.kind]
                    const previewable = isPreviewableKind(orphan.kind)
                    return (
                      <LibraryRow
                        key={orphan.id}
                        orphanId={orphan.id}
                        icon={<Icon size={16} />}
                        name={copy.attachmentLibrary.orphanName(orphan.id)}
                        sub={`${copy.attachmentLibrary.tabs[orphan.kind]} · ${formatBytes(orphan.size)}`}
                        meta={
                          previewable ? (
                            <span className={styles.rowGo}>
                              {copy.attachmentLibrary.modeAttachment}
                            </span>
                          ) : (
                            <span>{copy.attachmentLibrary.noPreview}</span>
                          )
                        }
                        onClick={previewable ? () => openOrphanLightbox(orphan) : undefined}
                      />
                    )
                  })}
                </div>
              )}
            </section>
          ) : empty ? (
            <div className={styles.empty}>
              <b>{copy.attachmentLibrary.emptyTitle}</b>
              <p>{copy.attachmentLibrary.emptyHint}</p>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setView('editor')
                  void openDate(todayLocalDate())
                }}
              >
                {copy.attachmentLibrary.emptyAction}
              </Button>
            </div>
          ) : (
            SECTIONS.filter((section) => tab === 'all' || tab === section.kind).map((section) => {
              const list = items.filter((item) => item.attachment.kind === section.kind)
              if (list.length === 0) return null
              return (
                <section key={section.kind} className={styles.section}>
                  <h3>
                    {copy.attachmentLibrary.tabs[section.kind]}
                    <span className={styles.hint}>
                      {copy.attachmentLibrary.sectionHint(list.length, section.previewable)}
                    </span>
                  </h3>
                  {section.previewable ? (
                    <div className={styles.grid}>
                      {list.map((item) => (
                        <button
                          key={item.attachment.id}
                          type="button"
                          className={styles.card}
                          onClick={() => openItem(item)}
                        >
                          <Thumb item={item} />
                          <span className={styles.info}>
                            <span className={styles.name}>{item.attachment.name}</span>
                            <span className={styles.sub}>{ownerLine(item)}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.rows}>
                      {list.map((item) => (
                        <LibraryRow
                          key={item.attachment.id}
                          icon={<FileText size={16} />}
                          name={item.attachment.name}
                          sub={ownerLine(item)}
                          meta={
                            <>
                              <span>{formatBytes(item.attachment.size)}</span>
                              <span>{copy.attachmentLibrary.noPreview}</span>
                              <span className={styles.rowGo}>
                                {copy.attachmentLibrary.viewEntry}
                              </span>
                            </>
                          }
                          onClick={() => openItem(item)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )
            })
          )}
        </div>
      </div>

      <CleanupDialog
        open={cleanupOpen}
        onClose={() => {
          setCleanupOpen(false)
          void refreshOrphans()
        }}
      />
    </div>
  )
}

interface LibraryRowProps {
  icon: React.ReactNode
  name: string
  sub: string
  meta?: React.ReactNode
  orphanId?: string
  onClick?: () => void
}

/** 文件行与未引用行共用的行结构 */
function LibraryRow({
  icon,
  name,
  sub,
  meta,
  orphanId,
  onClick
}: LibraryRowProps): React.JSX.Element {
  const content = (
    <>
      <span className={styles.rowIcon}>{icon}</span>
      <span className={styles.rowBody}>
        <span className={styles.rowName}>{name}</span>
        <span className={styles.rowSub}>{sub}</span>
      </span>
      {meta ? <span className={styles.rowMeta}>{meta}</span> : null}
    </>
  )
  return onClick ? (
    <button type="button" className={styles.row} data-orphan={orphanId} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={styles.row} data-orphan={orphanId}>
      {content}
    </div>
  )
}

function Thumb({ item }: { item: AttachmentIndexItem }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  const kind = item.attachment.kind
  const Icon = KIND_ICON[kind]
  const isImage = kind === 'image'

  return (
    <span className={styles.thumb} data-kind={kind}>
      {isImage && !broken ? (
        <img
          src={`attachment://${item.attachment.id}`}
          alt={item.attachment.name}
          loading="lazy"
          decoding="async"
          title={fileTitle(item)}
          onError={() => setBroken(true)}
        />
      ) : (
        <Icon size={26} className={styles.thumbIcon} />
      )}
      <span className={styles.badge}>
        <Icon size={12} />
      </span>
      {broken ? <span className={styles.broken}>{copy.attachmentLibrary.broken}</span> : null}
      <span className={styles.go}>{copy.attachmentLibrary.viewOwner}</span>
    </span>
  )
}

function fileTitle(item: AttachmentIndexItem): string {
  return `${item.attachment.name} · ${formatBytes(item.attachment.size)}`
}
