import { useEffect, useState } from 'react'

import { copy } from '@shared/copy'
import { call, errorMessage } from '@/api/client'
import { Button, Dialog, Field, PasswordInput, uiStyles } from '@/components/ui'
import { useEntriesStore } from '@/stores/entries'
import { useUiStore } from '@/stores/ui'
import { useVaultStore } from '@/stores/vault'

export function KeyRestoreDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [backupPassword, setBackupPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    if (!open) {
      setFilePath(null)
      setBackupPassword('')
      setError(null)
      setBusy(false)
    }
  }, [open])

  const choose = async (): Promise<void> => {
    try {
      const picked = await call('dialog:openFile', { purpose: 'key' })
      if (picked.path) setFilePath(picked.path)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const submit = async (): Promise<void> => {
    if (!filePath) {
      setError(copy.keyBackup.restoreFile)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const snapshot = await call('vault:restoreKeyBackup', {
        filePath,
        backupPassword
      })
      useVaultStore.getState().setSnapshot(snapshot)
      useEntriesStore.getState().loadSnapshot(snapshot)
      useUiStore.getState().openSync('git')
      pushToast(copy.keyBackup.restoreSuccess, { tone: 'success' })
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
      title={copy.keyBackup.restoreTitle}
      description={copy.keyBackup.restoreSubtitle}
      footer={
        <>
          <Button onClick={onClose}>{copy.common.cancel}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? copy.common.loading : copy.keyBackup.restoreSubmit}
          </Button>
        </>
      }
    >
      <Field label={copy.keyBackup.restoreFile} htmlFor="key-restore-file">
        <div className={uiStyles.row}>
          <code className={uiStyles.path} title={filePath ?? ''}>
            {filePath ?? copy.keyBackup.restoreChoose}
          </code>
          <Button size="sm" onClick={() => void choose()}>
            {copy.keyBackup.restoreChoose}
          </Button>
        </div>
      </Field>
      <Field label={copy.keyBackup.restorePassword} htmlFor="key-restore-backup-password">
        <PasswordInput
          id="key-restore-backup-password"
          autoComplete="off"
          value={backupPassword}
          onChange={(event) => setBackupPassword(event.target.value)}
        />
      </Field>
      <p className={uiStyles.info}>{copy.keyBackup.restoreWarning}</p>
      {error ? <p className={uiStyles.error}>{error}</p> : null}
    </Dialog>
  )
}
