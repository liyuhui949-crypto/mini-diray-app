import { useEffect, useRef, useState } from 'react'

import { Check, Copy } from 'lucide-react'

import { copy } from '@shared/copy'
import { formatBytes } from '@shared/date'
import {
  formatPackageKey,
  generatePackageKey,
  isValidPackageKey,
  normalizePackageKey
} from '@shared/packageKey'

import { call, errorMessage } from '@/api/client'
import { Button, Dialog, Field, Input, PasswordInput, uiStyles } from '@/components/ui'

import styles from './sync.module.scss'

const THINK_SECONDS = 4

interface AttachmentExportResult {
  path: string
  count: number
  bytes: number
}

export function AttachmentExportDialog({
  open,
  onClose,
  onDone
}: {
  open: boolean
  onClose: () => void
  onDone: (result: AttachmentExportResult) => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<'form' | 'key' | 'running' | 'done'>('form')
  const [password, setPassword] = useState('')
  const [packageKey, setPackageKey] = useState('')
  const [copied, setCopied] = useState(false)
  const [countdown, setCountdown] = useState(THINK_SECONDS)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AttachmentExportResult | null>(null)
  const copiedTimer = useRef<number | null>(null)

  useEffect(() => {
    if (open) return
    setPhase('form')
    setPassword('')
    setPackageKey('')
    setCopied(false)
    setCountdown(THINK_SECONDS)
    setError(null)
    setResult(null)
  }, [open])

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
    if (password.length < 8) {
      setError('私钥至少 8 位')
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
      const exported = await call('attachment:exportPackage', {
        packagePassword: password,
        packageKey: normalizePackageKey(packageKey)
      })
      if (!exported.path) {
        setPhase('key')
        return
      }
      const next = { path: exported.path, count: exported.count, bytes: exported.bytes }
      setResult(next)
      setPhase('done')
      onDone(next)
    } catch (err) {
      setError(errorMessage(err))
      setPhase('key')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
      width={580}
      title={phase === 'key' || phase === 'done' ? copy.migration.keyTitle : copy.sync.attachmentExportTitle}
      description={
        phase === 'form'
          ? copy.sync.attachmentExportDesc
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
          <Button variant="danger" disabled>
            {copy.migration.exportPreparing}
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
            <Button variant="primary" disabled={password.length === 0} onClick={goToKey}>
              {copy.migration.exportNext}
            </Button>
          </>
        )
      }
    >
      {phase === 'form' ? (
        <Field
          label={copy.migration.exportPasswordLabel}
          hint={copy.migration.exportPasswordHint}
          htmlFor="att-export-password"
        >
          <PasswordInput
            id="att-export-password"
            autoComplete="new-password"
            placeholder={copy.migration.exportPasswordPlaceholder}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && password.length > 0) goToKey()
            }}
          />
        </Field>
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
          <code className={styles.keyValue} id="att-package-key">
            {formatPackageKey(packageKey)}
          </code>
          <p className={styles.keyWarning}>{copy.migration.keyWarning}</p>
        </div>
      ) : null}

      {phase === 'running' ? (
        <p className={uiStyles.info}>{copy.migration.exportPreparing}</p>
      ) : null}

      {phase === 'done' && result ? (
        <p className={uiStyles.info}>
          {copy.sync.attachmentExportDone(result.count, formatBytes(result.bytes))}
          <br />
          {result.path}
        </p>
      ) : null}

      <div className={styles.error}>{error}</div>
    </Dialog>
  )
}

export function AttachmentImportDialog({
  open,
  onClose,
  onDone
}: {
  open: boolean
  onClose: () => void
  onDone: (result: { imported: number; skipped: number; missing: number }) => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [packageKey, setPackageKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (open) return
    setPassword('')
    setPackageKey('')
    setError(null)
    setRunning(false)
  }, [open])

  const submit = async (): Promise<void> => {
    if (!isValidPackageKey(packageKey)) {
      setError(copy.migration.packageKeyInvalid)
      return
    }
    if (password.length < 8) {
      setError('私钥至少 8 位')
      return
    }
    setRunning(true)
    setError(null)
    try {
      const result = await call('attachment:importPackage', {
        packagePassword: password,
        packageKey: normalizePackageKey(packageKey)
      })
      if (result.imported === 0 && result.skipped === 0) {
        setRunning(false)
        return
      }
      onDone(result)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setRunning(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
      width={560}
      title={copy.sync.attachmentImportTitle}
      description={copy.sync.attachmentImportDesc}
      footer={
        <>
          <Button onClick={onClose}>{copy.common.cancel}</Button>
          <Button variant="primary" disabled={running} onClick={() => void submit()}>
            {running ? copy.common.loading : copy.sync.attachmentImport}
          </Button>
        </>
      }
    >
      <Field label={copy.migration.exportPasswordLabel} htmlFor="att-import-password">
        <PasswordInput
          id="att-import-password"
          autoComplete="current-password"
          placeholder={copy.migration.exportPasswordPlaceholder}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field label={copy.migration.packageKeyLabel} htmlFor="att-import-key">
        <Input
          id="att-import-key"
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-…"
          value={packageKey}
          onChange={(event) => setPackageKey(event.target.value)}
        />
      </Field>
      <div className={styles.error}>{error}</div>
    </Dialog>
  )
}
