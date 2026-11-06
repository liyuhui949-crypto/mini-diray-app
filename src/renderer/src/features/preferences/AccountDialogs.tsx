import { useEffect, useState } from 'react'

import { copy } from '@shared/copy'
import { formatBytes } from '@shared/date'

import { call, errorMessage } from '@/api/client'
import { Button, Dialog, Field, Input, PasswordInput, uiStyles } from '@/components/ui'
import { useEntriesStore } from '@/stores/entries'
import { useUiStore } from '@/stores/ui'

export function ChangePasswordDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    if (!open) {
      setCurrent('')
      setNext('')
      setConfirm('')
      setError(null)
      setBusy(false)
    }
  }, [open])

  const submit = async (): Promise<void> => {
    setError(null)
    if (next.length < 8) {
      setError(copy.changePassword.tooShort)
      return
    }
    if (next !== confirm) {
      setError(copy.changePassword.mismatch)
      return
    }
    setBusy(true)
    try {
      await call('vault:changePassword', { currentPassword: current, newPassword: next })
      pushToast(copy.changePassword.success)
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
      title={copy.changePassword.title}
      description={copy.changePassword.subtitle}
      footer={
        <>
          <Button onClick={onClose}>{copy.common.cancel}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? copy.common.loading : copy.changePassword.submit}
          </Button>
        </>
      }
    >
      <Field label={copy.changePassword.current} htmlFor="pwd-current">
        <PasswordInput
          id="pwd-current"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      </Field>
      <Field label={copy.changePassword.next} htmlFor="pwd-next">
        <PasswordInput
          id="pwd-next"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
      </Field>
      <Field label={copy.changePassword.confirm} htmlFor="pwd-confirm">
        <PasswordInput
          id="pwd-confirm"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </Field>
      {error ? <p className={uiStyles.error}>{error}</p> : null}
    </Dialog>
  )
}

interface ConfirmState {
  password: string
  keyword: string
}

export function ResetVaultDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [state, setState] = useState<ConfirmState>({ password: '', keyword: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    if (!open) {
      setState({ password: '', keyword: '' })
      setError(null)
      setBusy(false)
    }
  }, [open])

  const submit = async (): Promise<void> => {
    if (state.keyword.trim() !== copy.reset.keyword) {
      setError(`请输入「${copy.reset.keyword}」`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const snapshot = await call('vault:reset', { password: state.password })
      useEntriesStore.getState().loadSnapshot(snapshot)
      pushToast(copy.reset.success)
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
      title={copy.reset.title}
      description={`${copy.reset.subtitle}\n${copy.reset.warning}`}
      footer={
        <>
          <Button onClick={onClose}>{copy.common.cancel}</Button>
          <Button variant="danger" disabled={busy} onClick={() => void submit()}>
            {busy ? copy.common.loading : copy.reset.submit}
          </Button>
        </>
      }
    >
      <Field label="日记密码" htmlFor="reset-password">
        <PasswordInput
          id="reset-password"
          autoComplete="current-password"
          value={state.password}
          onChange={(event) => setState({ ...state, password: event.target.value })}
        />
      </Field>
      <Field label={copy.reset.keywordLabel} htmlFor="reset-keyword">
        <Input
          id="reset-keyword"
          value={state.keyword}
          placeholder={copy.reset.keyword}
          onChange={(event) => setState({ ...state, keyword: event.target.value })}
        />
      </Field>
      {error ? <p className={uiStyles.error}>{error}</p> : null}
    </Dialog>
  )
}

export function CleanupDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<{ count: number; bytes: number; ids: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    if (!open) {
      setResult(null)
      setScanning(false)
      return
    }
    setScanning(true)
    void call('attachment:cleanup', { dryRun: true })
      .then(setResult)
      .catch(() => setResult({ count: 0, bytes: 0, ids: [] }))
      .finally(() => setScanning(false))
  }, [open])

  const run = async (): Promise<void> => {
    if (!result || result.ids.length === 0) return
    setBusy(true)
    try {
      const removed = await call('attachment:cleanup', { dryRun: false, ids: result.ids })
      pushToast(copy.attachments.gcDone(removed.count, formatBytes(removed.bytes)))
      onClose()
    } catch (error) {
      pushToast(errorMessage(error), { tone: 'error' })
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
      title={copy.attachments.gcTitle}
      description={copy.attachments.gcDescription}
      footer={
        <>
          <Button onClick={onClose}>{copy.common.cancel}</Button>
          <Button
            variant="danger"
            disabled={busy || scanning || !result || result.count === 0}
            onClick={() => void run()}
          >
            {busy ? copy.common.loading : copy.attachments.gcConfirm}
          </Button>
        </>
      }
    >
      {scanning ? (
        <p className={uiStyles.info}>扫描中…</p>
      ) : result && result.count > 0 ? (
        <p className={uiStyles.info}>
          {copy.attachments.gcResult(result.count, formatBytes(result.bytes))}
        </p>
      ) : (
        <p className={uiStyles.info}>{copy.attachments.gcNothing}</p>
      )}
    </Dialog>
  )
}

