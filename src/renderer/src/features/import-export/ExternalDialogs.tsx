import { useEffect, useMemo, useState } from 'react'

import { copy } from '@shared/copy'
import { escapeHtml, renderMarkdownToHtml } from '@shared/markdown'
import { formatDateWithWeekdayCN } from '@shared/date'
import type { DiaryEntry, ExportFormat, ImportFormat } from '@shared/types'

import { call, errorMessage } from '@/api/client'
import { Button, Dialog, Field, Input, Select, uiStyles } from '@/components/ui'
import { useEntriesStore } from '@/stores/entries'
import { useUiStore } from '@/stores/ui'

import styles from './import-export.module.scss'

const IMPORT_FORMATS: Array<{ value: ImportFormat; label: string }> = [
  { value: 'dayOneJson', label: copy.importDialog.dayOneJson },
  { value: 'jrnlJson', label: copy.importDialog.jrnlJson },
  { value: 'miniDiaryJson', label: copy.importDialog.miniDiaryJson },
  { value: 'dayOneTxt', label: copy.importDialog.dayOneTxt }
]

const EXPORT_FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'miniDiaryJson', label: copy.exportDialog.miniDiaryJson },
  { value: 'markdown', label: copy.exportDialog.markdown },
  { value: 'pdf', label: copy.exportDialog.pdf },
  { value: 'dayOneTxt', label: copy.exportDialog.dayOneTxt }
]

export function buildPrintBody(entries: readonly DiaryEntry[]): string {
  return entries
    .map((entry) => {
      const title = entry.title.trim() || formatDateWithWeekdayCN(entry.date)
      const tags =
        entry.tags.length > 0
          ? `<ul class="tag-list">${entry.tags.map((tag) => `<li>#${escapeHtml(tag)}</li>`).join('')}</ul>`
          : ''
      return [
        '<article class="entry">',
        `<h2>${escapeHtml(title)}</h2>`,
        `<p class="entry-meta">${escapeHtml(formatDateWithWeekdayCN(entry.date))} · ${entry.wordCount} 字</p>`,
        tags,
        `<div class="entry-body">${renderMarkdownToHtml(entry.body, { attachments: entry.attachments })}</div>`,
        '</article>'
      ].join('\n')
    })
    .join('\n')
}

export function ImportDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [format, setFormat] = useState<ImportFormat>('dayOneJson')
  const [filePath, setFilePath] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [summary, setSummary] = useState<Awaited<
    ReturnType<typeof call<'import:preview'>>
  >['summary'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    if (!open) {
      setFilePath('')
      setToken(null)
      setSummary(null)
      setError(null)
      setBusy(false)
    }
  }, [open])

  const pick = async (): Promise<void> => {
    const picked = await call('dialog:openFile', { purpose: 'import', format })
    if (!picked.path) return
    setFilePath(picked.path)
    setBusy(true)
    setError(null)
    try {
      const preview = await call('import:preview', { format, filePath: picked.path })
      setToken(preview.token)
      setSummary(preview.summary)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const commit = async (): Promise<void> => {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      await call('import:commit', { token })
      const snapshot = await call('vault:snapshot', undefined)
      useEntriesStore.getState().loadSnapshot(snapshot)
      pushToast(copy.importDialog.done)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) {
          if (token) void call('import:cancel', { token })
          onClose()
        }
      }}
      width={560}
      title={copy.importDialog.title}
      description={copy.importDialog.subtitle}
      footer={
        <>
          <Button onClick={onClose}>{copy.common.cancel}</Button>
          <Button variant="primary" disabled={busy || !token} onClick={() => void commit()}>
            {busy ? copy.importDialog.committing : copy.importDialog.commit}
          </Button>
        </>
      }
    >
      <Field label={copy.importDialog.formatLabel} htmlFor="import-format">
        <Select
          id="import-format"
          value={format}
          aria-label={copy.importDialog.formatLabel}
          options={IMPORT_FORMATS}
          onChange={(event) => {
            setFormat(event.target.value as ImportFormat)
            setToken(null)
            setSummary(null)
          }}
        />
      </Field>

      <div className={styles.pickRow}>
        <Button size="sm" onClick={() => void pick()} disabled={busy}>
          {copy.importDialog.pickFile}
        </Button>
        {filePath ? <code className={styles.path}>{filePath}</code> : null}
      </div>

      {summary ? (
        <div className={styles.summary}>
          <p>
            {copy.importDialog.summary(
              summary.entryCount,
              summary.mergedCount,
              summary.warnings.length
            )}
          </p>
          {summary.firstDate && summary.lastDate ? (
            <p className={styles.range}>
              {summary.firstDate} 至 {summary.lastDate}
            </p>
          ) : null}
          {summary.warnings.length > 0 ? (
            <ul className={styles.warnings}>
              {summary.warnings.slice(0, 6).map((warning, index) => (
                <li key={index}>{warning.message}</li>
              ))}
            </ul>
          ) : null}
          <p className={styles.warnText}>{copy.importDialog.attachmentWarning}</p>
        </div>
      ) : null}

      {error ? <p className={uiStyles.error}>{error}</p> : null}
    </Dialog>
  )
}

export function ExportDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [format, setFormat] = useState<ExportFormat>('miniDiaryJson')
  const [includeAttachments, setIncludeAttachments] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const entries = useEntriesStore((state) => state.entries)
  const pushToast = useUiStore((state) => state.pushToast)

  const html = useMemo(() => (format === 'pdf' ? buildPrintBody(entries) : undefined), [format, entries])

  useEffect(() => {
    if (!open) {
      setError(null)
      setBusy(false)
    }
  }, [open])

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await call('export:run', {
        format,
        includeAttachments: format === 'markdown' ? includeAttachments : undefined,
        html
      })
      if (result.path) {
        pushToast(copy.exportDialog.donePath(result.path))
        onClose()
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
      width={560}
      title={copy.exportDialog.title}
      description={copy.exportDialog.subtitle}
      footer={
        <>
          <Button onClick={onClose}>{copy.common.cancel}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            {busy ? copy.exportDialog.running : copy.exportDialog.run}
          </Button>
        </>
      }
    >
      <Field label={copy.exportDialog.formatLabel} htmlFor="export-format">
        <Select
          id="export-format"
          value={format}
          aria-label={copy.exportDialog.formatLabel}
          options={EXPORT_FORMATS}
          onChange={(event) => setFormat(event.target.value as ExportFormat)}
        />
      </Field>

      {format === 'markdown' ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={includeAttachments}
            onChange={(event) => setIncludeAttachments(event.target.checked)}
          />
          <span>
            {copy.exportDialog.includeAttachments}
            <em>{copy.exportDialog.includeAttachmentsDesc}</em>
          </span>
        </label>
      ) : null}

      <p className={styles.warnText}>{copy.exportDialog.warningPlaintext}</p>
      {error ? <p className={uiStyles.error}>{error}</p> : null}
    </Dialog>
  )
}

export function LegacyImportDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [filePath, setFilePath] = useState('')
  const [password, setPassword] = useState('')
  const [preview, setPreview] = useState<{ token: string; entries: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    if (!open) {
      setFilePath('')
      setPassword('')
      setPreview(null)
      setError(null)
      setBusy(false)
    }
  }, [open])

  const pick = async (): Promise<void> => {
    const picked = await call('dialog:openFile', { purpose: 'import', format: 'dayOneTxt' })
    if (picked.path) setFilePath(picked.path)
  }

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const previewed = await call('legacy:importPreview', { filePath, password })
      setPreview({ token: previewed.token, entries: previewed.entries })
      const committed = await call('legacy:commit', { token: previewed.token })
      const snapshot = await call('vault:snapshot', undefined)
      useEntriesStore.getState().loadSnapshot(snapshot)
      pushToast(`已导入 ${committed.entries} 篇旧日记`)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
      width={520}
      title="导入旧版 Mini Diary 文件"
      description="读取 3.3.0 的 mini-diary.txt，用它原来的密码解密。旧文件会保持原样，不会删除。"
      footer={
        <>
          <Button onClick={onClose}>{copy.common.cancel}</Button>
          <Button
            variant="primary"
            disabled={busy || !filePath || password.length === 0}
            onClick={() => void run()}
          >
            {busy ? copy.common.loading : '导入'}
          </Button>
        </>
      }
    >
      <div className={styles.pickRow}>
        <Button size="sm" onClick={() => void pick()}>
          选择文件…
        </Button>
        {filePath ? <code className={styles.path}>{filePath}</code> : null}
      </div>
      <Field label="旧文件密码" htmlFor="legacy-password">
        <Input
          id="legacy-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      {preview ? <p className={uiStyles.info}>识别到 {preview.entries} 篇</p> : null}
      {error ? <p className={uiStyles.error}>{error}</p> : null}
    </Dialog>
  )
}
