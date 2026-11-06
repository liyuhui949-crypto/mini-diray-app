import { useEffect, useState } from 'react'

import { copy } from '@shared/copy'
import { formatBytes } from '@shared/date'
import type { MigrationSummary } from '@shared/types'

import { call, errorMessage } from '@/api/client'
import { Button, Dialog, Field, Input, Progress, uiStyles } from '@/components/ui'
import { useUiStore } from '@/stores/ui'
import { useVaultStore } from '@/stores/vault'

import styles from './migration.module.scss'

type Phase = 'form' | 'running' | 'done'

export function MigrationExportDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [phase, setPhase] = useState<Phase>('form')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ path: string; summary: MigrationSummary } | null>(null)
  const busy = useVaultStore((state) => state.busy)
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    if (!open) {
      setPassword('')
      setPhase('form')
      setError(null)
      setResult(null)
    }
  }, [open])

  const submit = async (): Promise<void> => {
    if (password.length < 8) {
      setError('迁移包密码至少 8 位')
      return
    }
    setPhase('running')
    setError(null)
    try {
      const exported = await call('migration:export', { packagePassword: password })
      if (!exported.path || !exported.summary) {
        setPhase('form')
        return
      }
      setResult({ path: exported.path, summary: exported.summary })
      setPhase('done')
      pushToast(copy.migration.exportDone)
    } catch (err) {
      setError(errorMessage(err))
      setPhase('form')
    }
  }

  const cancel = (): void => {
    const jobId = busy?.jobId
    if (jobId) void call('migration:cancel', { jobId })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
      width={560}
      title={copy.migration.exportTitle}
      description={phase === 'form' ? copy.migration.exportSubtitle : undefined}
      footer={
        phase === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            {copy.common.done}
          </Button>
        ) : phase === 'running' ? (
          <Button variant="danger" onClick={cancel}>
            {copy.common.cancel}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{copy.common.cancel}</Button>
            <Button variant="primary" onClick={() => void submit()} disabled={password.length === 0}>
              {copy.migration.exportStart}
            </Button>
          </>
        )
      }
    >
      {phase === 'form' ? (
        <>
          <Field
            label={copy.migration.exportPasswordLabel}
            hint={copy.migration.exportPasswordHint}
            htmlFor="export-password"
          >
            <Input
              id="export-password"
              type="password"
              autoComplete="new-password"
              placeholder={copy.migration.exportPasswordPlaceholder}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {error ? <p className={uiStyles.error}>{error}</p> : null}
        </>
      ) : null}

      {phase === 'running' ? (
        <Progress
          value={busy?.ratio ?? 0}
          label={busy?.label ?? copy.migration.exportPreparing}
          detail={busy?.bytesTotal ? formatBytes(busy.bytesDone ?? 0) : undefined}
        />
      ) : null}

      {phase === 'done' && result ? (
        <div>
          <p className={uiStyles.info}>
            {copy.migration.exportSummary(
              result.summary.entryCount,
              result.summary.attachmentCount,
              formatBytes(result.summary.totalAttachmentBytes)
            )}
          </p>
          <p className={styles.path}>{result.path}</p>
          <p className={styles.hint}>{copy.migration.exportPathHint}</p>
        </div>
      ) : null}
    </Dialog>
  )
}
