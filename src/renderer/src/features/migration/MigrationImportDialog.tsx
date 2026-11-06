import { useEffect, useState } from 'react'

import { copy } from '@shared/copy'
import { formatBytes } from '@shared/date'
import { isValidPackageKey, normalizePackageKey } from '@shared/packageKey'
import type { MigrationMode, MigrationSummary } from '@shared/types'

import { call, errorMessage } from '@/api/client'
import { Button, Dialog, Field, Input, PasswordInput, Progress, Select, uiStyles } from '@/components/ui'
import { useEntriesStore } from '@/stores/entries'
import { useUiStore } from '@/stores/ui'
import { useVaultStore } from '@/stores/vault'

import styles from './migration.module.scss'

type Step = 'pick' | 'password' | 'mode' | 'running' | 'done'

export function MigrationImportDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const pendingPackage = useUiStore((state) => state.pendingPackagePath)
  const [step, setStep] = useState<Step>('pick')
  const [filePath, setFilePath] = useState<string>('')
  const [packagePassword, setPackagePassword] = useState('')
  const [packageKey, setPackageKey] = useState('')
  const [mode, setMode] = useState<MigrationMode>('replace')
  const [summary, setSummary] = useState<MigrationSummary | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ entries: number; attachments: number; merged: number } | null>(
    null
  )
  const status = useVaultStore((state) => state.status)
  const busy = useVaultStore((state) => state.busy)
  const pushToast = useUiStore((state) => state.pushToast)
  const vaultExists = status !== 'missing'

  useEffect(() => {
    if (!open) {
      setStep('pick')
      setFilePath(pendingPackage ?? '')
      setPackagePassword('')
      setPackageKey('')
      setMode('replace')
      setSummary(null)
      setToken(null)
      setError(null)
      setResult(null)
      return
    }
    if (pendingPackage) {
      setFilePath(pendingPackage)
      setStep('password')
    } else {
      setFilePath('')
      setStep('pick')
    }
  }, [open, pendingPackage])

  const pickFile = async (): Promise<void> => {
    const picked = await call('dialog:openFile', { purpose: 'migration' })
    if (!picked.path) return
    setFilePath(picked.path)
    setError(null)
    setStep('password')
  }

  const preview = async (): Promise<void> => {
    if (!isValidPackageKey(packageKey)) {
      setError(copy.migration.packageKeyInvalid)
      return
    }
    setError(null)
    setStep('running')
    try {
      const previewed = await call('migration:preview', {
        filePath,
        packagePassword,
        packageKey: normalizePackageKey(packageKey)
      })
      setSummary(previewed.summary)
      setToken(previewed.token)
      setStep('mode')
    } catch (err) {
      setError(errorMessage(err))
      setStep('password')
    }
  }

  const run = async (): Promise<void> => {
    if (!token) return
    setError(null)
    setStep('running')
    try {
      const imported = await call('migration:import', { token, mode })
      const snapshot = await call('vault:snapshot', undefined)
      useVaultStore.getState().setSnapshot(snapshot)
      useEntriesStore.getState().loadSnapshot(snapshot)
      setResult({
        entries: imported.entries,
        attachments: imported.attachments,
        merged: imported.merged
      })
      setStep('done')
      pushToast(copy.migration.importDone)
    } catch (err) {
      setError(errorMessage(err))
      // 导入用的 token 是一次性的：失败后必须重新校验，不能拿旧 token 再点一次
      setToken(null)
      setSummary(null)
      setStep('password')
    }
  }

  const cancelJob = (): void => {
    const jobId = busy?.jobId
    if (jobId) void call('migration:cancel', { jobId })
  }

  const title =
    step === 'done' ? copy.migration.importDone : copy.migration.importTitle

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
      width={580}
      title={title}
      description={step === 'pick' ? copy.migration.importSubtitle : undefined}
      footer={
        step === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            {copy.common.done}
          </Button>
        ) : step === 'running' ? (
          <Button variant="danger" onClick={cancelJob}>
            {copy.common.cancel}
          </Button>
        ) : step === 'mode' ? (
          <>
            <Button onClick={onClose}>{copy.common.cancel}</Button>
            <Button variant="primary" disabled={!token} onClick={() => void run()}>
              {copy.migration.importStart}
            </Button>
          </>
        ) : step === 'password' ? (
          <>
            <Button onClick={onClose}>{copy.common.cancel}</Button>
            <Button variant="primary" onClick={() => void preview()} disabled={!filePath}>
              {error ? '重新校验' : copy.common.next}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{copy.common.cancel}</Button>
            <Button
              variant="primary"
              onClick={() => void pickFile()}
            >
              {copy.migration.importPick}
            </Button>
          </>
        )
      }
    >
      {filePath ? <p className={styles.path}>{filePath}</p> : null}

      {step === 'password' ? (
        <>
          <Field
            label={copy.migration.packageKeyLabel}
            hint={copy.migration.packageKeyHint}
            htmlFor="import-package-key"
          >
            <Input
              id="import-package-key"
              autoComplete="off"
              spellCheck={false}
              placeholder={copy.migration.packageKeyPlaceholder}
              className={styles.keyInput}
              value={packageKey}
              onChange={(event) => setPackageKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && packagePassword) void preview()
              }}
            />
          </Field>

          <Field label={copy.migration.importPasswordLabel} htmlFor="import-password">
            <PasswordInput
              id="import-password"
              autoComplete="off"
              placeholder={copy.migration.importPasswordPlaceholder}
              value={packagePassword}
              onChange={(event) => setPackagePassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && packagePassword) void preview()
              }}
            />
          </Field>
          {error ? <p className={uiStyles.error}>{error}</p> : null}
        </>
      ) : null}

      {step === 'mode' && summary ? (
        <div className={styles.body}>
          <div className={styles.summary}>
            <p>{copy.migration.importSummaryTitle}</p>
            <ul>
              <li>{copy.migration.importSummaryEntries(summary.entryCount)}</li>
              <li>
                {copy.migration.importSummaryAttachments(
                  summary.attachmentCount,
                  formatBytes(summary.totalAttachmentBytes)
                )}
              </li>
              {summary.firstDate && summary.lastDate ? (
                <li>{copy.migration.importSummaryRange(summary.firstDate, summary.lastDate)}</li>
              ) : null}
              {summary.hasPreferences ? <li>包含可移植偏好设置</li> : null}
            </ul>
          </div>

          <Field label={copy.migration.importMode} htmlFor="import-mode">
            <Select
              id="import-mode"
              value={mode}
              aria-label={copy.migration.importMode}
              onChange={(event) => setMode(event.target.value as MigrationMode)}
              options={[
                {
                  value: 'replace',
                  label: vaultExists ? copy.migration.importModeReplace : '采用包内日记库'
                },
                ...(status === 'unlocked'
                  ? [{ value: 'merge', label: copy.migration.importModeMerge }]
                  : [])
              ]}
            />
          </Field>
          <p className={styles.hint}>
            {mode === 'replace'
              ? vaultExists
                ? copy.migration.importOverwrites
                : copy.migration.importFreshHint
              : copy.migration.importModeMergeDesc}
          </p>

          <p className={styles.hint}>
            {status === 'unlocked'
              ? copy.migration.keepPasswordHint
              : copy.migration.packagePasswordUnlockHint}
          </p>
          {error ? <p className={uiStyles.error}>{error}</p> : null}
        </div>
      ) : null}

      {step === 'running' ? (
        <Progress
          value={busy?.ratio ?? 0}
          label={busy?.label ?? copy.migration.importValidating}
          detail={busy?.bytesTotal ? formatBytes(busy.bytesDone ?? 0) : undefined}
        />
      ) : null}

      {step === 'done' && result ? (
        <p className={uiStyles.info}>
          {copy.migration.importResult(result.entries, result.attachments, result.merged)}
        </p>
      ) : null}

      {step === 'pick' ? <p className={styles.hint}>{copy.migration.dangerCancel}</p> : null}
    </Dialog>
  )
}
