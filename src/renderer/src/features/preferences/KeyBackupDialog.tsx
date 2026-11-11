import { useEffect, useState } from 'react'

import { copy } from '@shared/copy'
import { PASSWORD_MIN_LENGTH } from '@shared/schemas'

import { call, errorMessage } from '@/api/client'
import { Button, Dialog, Field, PasswordInput, uiStyles } from '@/components/ui'
import { useUiStore } from '@/stores/ui'

export function KeyBackupDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    if (!open) {
      setPassword('')
      setConfirm('')
      setError(null)
      setBusy(false)
    }
  }, [open])

  const submit = async (): Promise<void> => {
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(copy.keyBackup.passwordTooShort)
      return
    }
    if (password !== confirm) {
      setError(copy.keyBackup.passwordMismatch)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await call('sync:exportKeyBackup', { password })
      if (!result.path) return
      pushToast(copy.keyBackup.exportSuccess, { tone: 'success' })
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
      title={copy.keyBackup.exportTitle}
      description={copy.keyBackup.exportSubtitle}
      footer={
        <>
          <Button onClick={onClose}>{copy.common.cancel}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? copy.common.loading : copy.keyBackup.exportSubmit}
          </Button>
        </>
      }
    >
      <Field label={copy.keyBackup.exportPassword} htmlFor="key-backup-password">
        <PasswordInput
          id="key-backup-password"
          autoComplete="new-password"
          value={password}
          placeholder={copy.keyBackup.exportPasswordPlaceholder}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field label={copy.keyBackup.exportConfirm} htmlFor="key-backup-confirm">
        <PasswordInput
          id="key-backup-confirm"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </Field>
      {error ? <p className={uiStyles.error}>{error}</p> : null}
    </Dialog>
  )
}
