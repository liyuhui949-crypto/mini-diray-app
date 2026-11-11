import { useEffect, useRef, useState } from 'react'

import { Check, Copy } from 'lucide-react'

import { copy } from '@shared/copy'
import { PASSWORD_MIN_LENGTH } from '@shared/schemas'
import { formatBytes } from '@shared/date'
import { formatPackageKey, generatePackageKey, normalizePackageKey } from '@shared/packageKey'
import type { MigrationSummary } from '@shared/types'

import { call, errorMessage } from '@/api/client'
import { Button, Dialog, Field, PasswordInput, Progress, uiStyles } from '@/components/ui'
import { usePrefsStore } from '@/stores/prefs'
import { useUiStore } from '@/stores/ui'
import { useVaultStore } from '@/stores/vault'

import styles from './migration.module.scss'

type Phase = 'form' | 'key' | 'running' | 'done'

/** 生成公钥后强制停留的秒数：留给用户"抄下来"的时间 */
const THINK_SECONDS = 5

export function MigrationExportDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [packageKey, setPackageKey] = useState('')
  const [copied, setCopied] = useState(false)
  const [countdown, setCountdown] = useState(THINK_SECONDS)
  const [phase, setPhase] = useState<Phase>('form')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ path: string; summary: MigrationSummary } | null>(null)
  const busy = useVaultStore((state) => state.busy)
  const pushToast = useUiStore((state) => state.pushToast)
  const syncEnabled = usePrefsStore((state) => state.prefs?.syncEnabled === true)
  const copiedTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!open) {
      setPassword('')
      setConfirm('')
      setPackageKey('')
      setCopied(false)
      setCountdown(THINK_SECONDS)
      setPhase('form')
      setError(null)
      setResult(null)
    }
  }, [open])

  // 公钥出现后倒计时，5 秒内不允许导出
  useEffect(() => {
    if (phase !== 'key') return
    setCountdown(THINK_SECONDS)
    const timer = window.setInterval(() => {
      setCountdown((value) => {
        if (value <= 1) {
          window.clearInterval(timer)
          return 0
        }
        return value - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  useEffect(
    () => () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
    },
    []
  )

  const goToKey = (): void => {
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError('私钥至少 8 位')
      return
    }
    if (password !== confirm) {
      setError(copy.migration.exportPasswordMismatch)
      return
    }
    setError(null)
    setPackageKey(generatePackageKey())
    setCopied(false)
    setPhase('key')
  }

  const copyKey = async (): Promise<void> => {
    try {
      await call('app:copyText', { text: formatPackageKey(packageKey) })
      setCopied(true)
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2500)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const submit = async (): Promise<void> => {
    setPhase('running')
    setError(null)
    try {
      const exported = await call('migration:export', {
        packagePassword: password,
        packageKey: normalizePackageKey(packageKey)
      })
      if (!exported.path || !exported.summary) {
        setPhase('form')
        return
      }
      setResult({ path: exported.path, summary: exported.summary })
      setPhase('done')
      pushToast(copy.migration.exportDone)
    } catch (err) {
      setError(errorMessage(err))
      setPhase('key')
    }
  }

  const cancel = (): void => {
    const jobId = busy?.jobId
    if (jobId) void call('migration:cancel', { jobId })
  }

  const keyDisplay = packageKey ? formatPackageKey(packageKey) : ''

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
      width={580}
      title={phase === 'key' || phase === 'done' ? copy.migration.keyTitle : copy.migration.exportTitle}
      description={
        phase === 'form'
          ? copy.migration.exportSubtitle
          : phase === 'key'
            ? copy.migration.keyDescription
            : undefined
      }
      footer={
        phase === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            {copy.common.done}
          </Button>
        ) : phase === 'running' ? (
          <Button variant="danger" onClick={cancel}>
            {copy.common.cancel}
          </Button>
        ) : phase === 'key' ? (
          <>
            <Button onClick={onClose}>{copy.common.cancel}</Button>
            <Button variant="primary" disabled={countdown > 0} onClick={() => void submit()}>
              {countdown > 0 ? copy.migration.keyCooldown(countdown) : copy.migration.exportStart}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{copy.common.cancel}</Button>
            <Button
              variant="primary"
              disabled={password.length === 0 || confirm.length === 0}
              onClick={goToKey}
            >
              {copy.migration.exportNext}
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
            <PasswordInput
              id="export-password"
              autoComplete="new-password"
              placeholder={copy.migration.exportPasswordPlaceholder}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && password.length > 0) goToKey()
              }}
            />
          </Field>
          <Field label={copy.migration.exportPasswordConfirm} htmlFor="export-password-confirm">
            <PasswordInput
              id="export-password-confirm"
              autoComplete="new-password"
              placeholder={copy.migration.exportPasswordPlaceholder}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && password.length > 0 && confirm.length > 0) goToKey()
              }}
            />
          </Field>
          {syncEnabled ? <p className={uiStyles.info}>{copy.migration.exportSyncIncluded}</p> : null}
        </>
      ) : null}

      {phase === 'key' || phase === 'done' ? (
        <div className={styles.keyBox}>
          <div className={styles.keyBoxHead}>
            <span>{copy.migration.keyLabel}</span>
            <Button size="sm" onClick={() => void copyKey()}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? copy.migration.keyCopied : copy.migration.copyKey}
            </Button>
          </div>
          <code className={styles.keyValue} id="package-key">
            {keyDisplay}
          </code>
          <p className={styles.keyWarning}>{copy.migration.keyWarning}</p>
        </div>
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

      {error ? <p className={uiStyles.error}>{error}</p> : null}
    </Dialog>
  )
}
