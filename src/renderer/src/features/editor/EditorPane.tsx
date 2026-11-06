import { useEffect, useMemo, useRef, useState } from 'react'

import {
  Bold,
  Code2,
  Eye,
  Italic,
  List,
  ListOrdered,
  Lock,
  Paperclip,
  Trash2
} from 'lucide-react'

import { copy } from '@shared/copy'
import { formatClockCN, formatDateWithWeekdayCN, relativeDayLabelCN } from '@shared/date'
import type { Attachment } from '@shared/types'
import { formatBytes } from '@shared/date'
import { countEntryWords } from '@shared/words'

import { call, errorMessage, pathForFile } from '@/api/client'
import { Button, Dialog, IconButton } from '@/components/ui'
import { useToday } from '@/hooks/useToday'
import { useEntriesStore } from '@/stores/entries'
import { usePrefsStore } from '@/stores/prefs'
import { useUiStore } from '@/stores/ui'

import { CodeMirrorEditor, type EditorHandle } from './CodeMirrorEditor'
import { MarkdownPreview } from './MarkdownPreview'
import { TagEditor } from './TagEditor'
import { attachmentMarkdown } from './markdownCommands'
import styles from './editor.module.scss'

const HUGE_FILE_BYTES = 300 * 1024 * 1024

export function EditorPane(): React.JSX.Element {
  const draft = useEntriesStore((state) => state.draft)
  const activeDate = useEntriesStore((state) => state.activeDate)
  const saveState = useEntriesStore((state) => state.saveState)
  const savedAt = useEntriesStore((state) => state.savedAt)
  const saveError = useEntriesStore((state) => state.saveError)
  const updateDraft = useEntriesStore((state) => state.updateDraft)
  const prefs = usePrefsStore((state) => state.prefs)
  const pushToast = useUiStore((state) => state.pushToast)
  const attachmentRequestSeq = useUiStore((state) => state.attachmentRequestSeq)
  const today = useToday()

  const [preview, setPreview] = useState(false)
  const [started, setStarted] = useState(false)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [pendingHuge, setPendingHuge] = useState<{ path: string; size: number } | null>(null)
  const [pendingRemove, setPendingRemove] = useState<Attachment | null>(null)
  const editorRef = useRef<EditorHandle>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  const readOnly = Boolean(prefs && !prefs.allowFutureEntries && activeDate > today)
  const allowFuture = prefs?.allowFutureEntries ?? false
  const spellcheck = prefs?.spellcheck ?? true

  useEffect(() => {
    setPreview(false)
    setStarted(false)
  }, [activeDate])

  useEffect(() => {
    if (attachmentRequestSeq > 0) void addFromDialog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentRequestSeq])

  const wordCount = useMemo(
    () => (draft ? countEntryWords(draft.title, draft.body) : 0),
    [draft]
  )

  if (!draft) {
    return <div className={styles.pane} />
  }

  const blank =
    draft.title.trim().length === 0 &&
    draft.body.trim().length === 0 &&
    draft.tags.length === 0 &&
    draft.attachments.length === 0

  const showEmptyState = blank && !started && !readOnly

  const attachToEntry = (attachment: Attachment): void => {
    const store = useEntriesStore.getState()
    store.addAttachment(attachment)
    if (preview) setPreview(false)
    window.setTimeout(() => {
      editorRef.current?.insertText(attachmentMarkdown(attachment))
      void useEntriesStore.getState().flush()
    }, 0)
  }

  const uploadPath = async (sourcePath: string, size?: number): Promise<void> => {
    if (size && size > HUGE_FILE_BYTES) {
      setPendingHuge({ path: sourcePath, size })
      return
    }
    setBusyPath(sourcePath)
    try {
      const attachment = await call('attachment:addFromPath', { sourcePath })
      attachToEntry(attachment)
      pushToast(copy.attachments.uploadDone)
    } catch (error) {
      pushToast(errorMessage(error), { tone: 'error' })
    } finally {
      setBusyPath(null)
    }
  }

  const addFromDialog = async (): Promise<void> => {
    try {
      const attachment = await call('attachment:addFromDialog', undefined)
      if (!attachment) return
      if (preview) setPreview(false)
      attachToEntry(attachment)
      pushToast(copy.attachments.uploadDone)
    } catch (error) {
      pushToast(errorMessage(error), { tone: 'error' })
    }
  }

  const handleFiles = (files: FileList | null): void => {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      const sourcePath = pathForFile(file)
      if (sourcePath) {
        void uploadPath(sourcePath, file.size)
      }
    }
  }

  const handlePaste = (event: React.ClipboardEvent): void => {
    const item = Array.from(event.clipboardData.items).find(
      (entry) => entry.kind === 'file' && entry.type.startsWith('image/')
    )
    const file = item?.getAsFile()
    if (!file) return
    event.preventDefault()
    if (file.size > 50 * 1024 * 1024) {
      pushToast(copy.attachments.pasteTooLarge, { tone: 'error' })
      return
    }
    void (async () => {
      try {
        const buffer = new Uint8Array(await file.arrayBuffer())
        const extension = file.type.split('/')[1] ?? 'png'
        const attachment = await call('attachment:addBytes', {
          name: `粘贴图片-${Date.now()}.${extension}`,
          mime: file.type,
          bytes: buffer
        })
        attachToEntry(attachment)
      } catch (error) {
        pushToast(errorMessage(error), { tone: 'error' })
      }
    })()
  }

  const statusText = (() => {
    switch (saveState) {
      case 'saving':
        return copy.editor.saving
      case 'dirty':
        return copy.editor.dirty
      case 'error':
        return saveError ?? copy.editor.saveFailed
      case 'saved':
        return savedAt ? copy.editor.savedAt(formatClockCN(new Date(savedAt))) : copy.editor.saved
      default:
        return copy.editor.saved
    }
  })()

  return (
    <div className={styles.pane}>
      <div className={styles.scroll}>
        <article className={styles.doc}>
          <div className={styles.tools}>
            <IconButton
              label={copy.editor.bold}
              onClick={() => editorRef.current?.runCommand('bold')}
              disabled={readOnly}
            >
              <Bold size={14} />
            </IconButton>
            <IconButton
              label={copy.editor.italic}
              onClick={() => editorRef.current?.runCommand('italic')}
              disabled={readOnly}
            >
              <Italic size={14} />
            </IconButton>
            <IconButton
              label={copy.editor.unorderedList}
              onClick={() => editorRef.current?.runCommand('unorderedList')}
              disabled={readOnly}
            >
              <List size={14} />
            </IconButton>
            <IconButton
              label={copy.editor.orderedList}
              onClick={() => editorRef.current?.runCommand('orderedList')}
              disabled={readOnly}
            >
              <ListOrdered size={14} />
            </IconButton>
            <span className={styles.toolsSep} />
            <button
              type="button"
              className={`${styles.tool} ${preview ? styles.toolOn : ''}`}
              onClick={() => setPreview(!preview)}
            >
              {preview ? <Code2 size={14} /> : <Eye size={14} />}
              {preview ? copy.editor.source : copy.editor.preview}
            </button>
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.tool}
              onClick={() => void addFromDialog()}
              disabled={readOnly}
            >
              <Paperclip size={14} />
              {copy.editor.attach}
            </button>
          </div>

          <div className={styles.dateLine}>
            <span>{formatDateWithWeekdayCN(activeDate)}</span>
            <span className={styles.pill}>{relativeDayLabelCN(activeDate, today)}</span>
          </div>

          {showEmptyState ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>{copy.editor.emptyTitle}</p>
              <p className={styles.emptySub}>{copy.editor.emptySubtitle}</p>
              <Button
                variant="primary"
                onClick={() => {
                  setStarted(true)
                  window.setTimeout(() => {
                    if (prefs?.hideTitle) editorRef.current?.focus()
                    else titleRef.current?.focus()
                  }, 30)
                }}
              >
                {copy.editor.startWriting}
              </Button>
            </div>
          ) : (
            <>
              {prefs?.hideTitle ? (
                <div className={styles.hiddenTitle} aria-hidden="true">
                  {draft.title || copy.editor.titlePlaceholder}
                </div>
              ) : (
                <input
                  ref={titleRef}
                  className={styles.title}
                  value={draft.title}
                  placeholder={copy.editor.titlePlaceholder}
                  aria-label={copy.editor.titlePlaceholder}
                  readOnly={readOnly}
                  onChange={(event) => updateDraft({ title: event.target.value })}
                />
              )}

              <TagEditor
                tags={draft.tags}
                readOnly={readOnly}
                onChange={(tags) => updateDraft({ tags })}
              />

              {readOnly ? (
                <div className={styles.readonly}>
                  <Lock size={14} />
                  <div>
                    <p>{copy.editor.futureReadonly}</p>
                    <p className={styles.readonlyHint}>{copy.editor.futureReadonlyHint}</p>
                  </div>
                </div>
              ) : preview ? (
                <div className={styles.previewWrap}>
                  <MarkdownPreview body={draft.body} attachments={draft.attachments} />
                </div>
              ) : (
                <div
                  className={`${styles.editorWrap} ${dragOver ? styles.editorWrapDrag : ''}`}
                  onDragOver={(event) => {
                    event.preventDefault()
                    setDragOver(true)
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(event) => {
                    event.preventDefault()
                    setDragOver(false)
                    handleFiles(event.dataTransfer.files)
                  }}
                  onPaste={handlePaste}
                >
                  <CodeMirrorEditor
                    value={draft.body}
                    onChange={(body) => updateDraft({ body })}
                    spellcheck={spellcheck}
                    placeholderText={copy.editor.emptyStatePlaceholder}
                    handleRef={editorRef}
                  />
                </div>
              )}

              {draft.attachments.length > 0 ? (
                <div className={styles.attachmentStrip}>
                  <div className={styles.attachHead}>
                    {copy.editor.attachmentCount(draft.attachments.length)}
                  </div>
                  {draft.attachments.map((attachment) => (
                    <div key={attachment.id} className={styles.attachRow}>
                      <AttachmentGlyph attachment={attachment} />
                      <span className={styles.attachName}>{attachment.name}</span>
                      <span className={styles.attachSize}>{formatBytes(attachment.size)}</span>
                      <span className={styles.attachLock}>
                        <Lock size={10} /> {copy.attachments.encrypted}
                      </span>
                      {readOnly ? null : (
                        <IconButton
                          label={copy.attachments.remove}
                          onClick={() => setPendingRemove(attachment)}
                        >
                          <Trash2 size={12} />
                        </IconButton>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}

          {busyPath ? <p className={styles.busy}>{copy.attachments.uploading(0)}</p> : null}
          {allowFuture && activeDate > today ? (
            <p className={styles.busy}>{copy.editor.futureReadonlyHint}</p>
          ) : null}
        </article>
      </div>

      <div className={styles.statusbar}>
        <span>{copy.editor.wordCount(wordCount)}</span>
        <span className={styles.sep} />
        <span
          className={`${styles.saveState} ${saveState === 'dirty' ? styles.saveDirty : ''} ${
            saveState === 'error' ? styles.saveError : ''
          }`}
        >
          {statusText}
        </span>
        <span className={styles.spacer} />
        <span className={styles.enc}>
          <Lock size={12} /> AES-256-GCM
        </span>
        <span className={styles.sep} />
        <span>{copy.editor.attachmentCount(draft.attachments.length)}</span>
      </div>

      <Dialog
        open={pendingHuge !== null}
        onOpenChange={(open) => {
          if (!open) setPendingHuge(null)
        }}
        title={copy.attachments.add}
        description={pendingHuge ? copy.attachments.hugeConfirm : undefined}
        footer={
          <>
            <Button onClick={() => setPendingHuge(null)}>{copy.common.cancel}</Button>
            <Button
              variant="primary"
              onClick={() => {
                const pending = pendingHuge
                setPendingHuge(null)
                if (pending) void uploadPath(pending.path)
              }}
            >
              {copy.common.confirm}
            </Button>
          </>
        }
      />

      <Dialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null)
        }}
        title={copy.attachments.removeConfirmTitle}
        description={
          pendingRemove ? copy.attachments.removeConfirm.replace('{name}', pendingRemove.name) : undefined
        }
        footer={
          <>
            <Button onClick={() => setPendingRemove(null)}>{copy.common.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = pendingRemove
                setPendingRemove(null)
                if (!target) return
                useEntriesStore.getState().removeAttachment(target.id)
                void useEntriesStore.getState().flush()
              }}
            >
              {copy.common.delete}
            </Button>
          </>
        }
      />
    </div>
  )
}

function AttachmentGlyph({ attachment }: { attachment: Attachment }): React.JSX.Element {
  if (attachment.kind === 'image') {
    return <img className={styles.glyph} src={`attachment://${attachment.id}`} alt="" loading="lazy" />
  }
  return (
    <span className={styles.glyphFallback}>
      {attachment.kind === 'video' ? '视频' : attachment.kind === 'audio' ? '音频' : '文件'}
    </span>
  )
}
