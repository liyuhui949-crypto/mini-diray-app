import { useEffect, useRef, useState } from 'react'

import { Lock } from 'lucide-react'

import { copy } from '@shared/copy'
import { AppError } from '@shared/errors'

import { call, errorMessage } from '@/api/client'
import { PasswordInput } from '@/components/ui'
import { useEntriesStore } from '@/stores/entries'
import { useVaultStore } from '@/stores/vault'

import styles from '@/styles/auth.module.scss'

export function UnlockView(): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const lockReason = useVaultStore((state) => state.lockReason)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      const snapshot = await call('vault:unlock', { password })
      useVaultStore.getState().setSnapshot(snapshot)
      useEntriesStore.getState().loadSnapshot(snapshot)
      setPassword('')
    } catch (err) {
      const message = err instanceof AppError ? err.message : errorMessage(err)
      setError(message)
      setShake(true)
      window.setTimeout(() => setShake(false), 340)
      setPassword('')
      inputRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  const reasonText =
    lockReason === 'screen-lock'
      ? copy.unlock.lockedBySystem
      : lockReason === 'idle'
        ? copy.unlock.lockedByIdle
        : null

  return (
    <div className={styles.screen}>
      <form className={`${styles.card} ${shake ? styles.shake : ''}`} onSubmit={submit}>
        <div className={styles.mark}>
          <Lock size={20} />
        </div>
        <h1 className={styles.title}>{copy.unlock.title}</h1>
        <p className={styles.subtitle}>{copy.unlock.subtitle}</p>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="unlock-password">
            {copy.unlock.passwordLabel}
          </label>
          <PasswordInput
            id="unlock-password"
            ref={inputRef}
            className={styles.passwordInput}
            autoComplete="current-password"
            value={password}
            placeholder={copy.unlock.placeholder}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button className={styles.submit} type="submit" disabled={busy || password.length === 0}>
          {busy ? copy.common.loading : copy.unlock.submit}
        </button>

        <div className={styles.error} role="alert">
          {error}
        </div>

        <p className={styles.warning}>{copy.onboarding.warning}</p>
        {reasonText ? <p className={styles.hint}>{reasonText}</p> : null}
      </form>
    </div>
  )
}
