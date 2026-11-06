import { useState } from 'react'

import { Lock, PackageOpen } from 'lucide-react'

import { copy } from '@shared/copy'

import { call, errorMessage } from '@/api/client'
import { useEntriesStore } from '@/stores/entries'
import { useUiStore } from '@/stores/ui'
import { useVaultStore } from '@/stores/vault'

import styles from '@/styles/auth.module.scss'

function strengthOf(password: string): { score: number; label: string } {
  let score = 0
  if (password.length >= 8) score += 1
  if (password.length >= 12) score += 1
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1
  if (/\d/.test(password)) score += 1
  if (/[^\w\s]/.test(password)) score += 1
  const clamped = Math.min(5, score)
  const labels = [
    copy.onboarding.strengthWeak,
    copy.onboarding.strengthWeak,
    copy.onboarding.strengthFair,
    copy.onboarding.strengthFair,
    copy.onboarding.strengthGood,
    copy.onboarding.strengthStrong
  ]
  return { score: clamped, label: labels[Math.min(labels.length - 1, clamped)] ?? '' }
}

export function Onboarding(): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pushToast = useUiStore((state) => state.pushToast)
  const openDialog = useUiStore((state) => state.openDialog)
  const strength = strengthOf(password)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError(copy.onboarding.passwordTooShort)
      return
    }
    if (password !== confirm) {
      setError(copy.onboarding.passwordMismatch)
      return
    }
    setBusy(true)
    try {
      const snapshot = await call('vault:create', { password })
      useVaultStore.getState().setSnapshot(snapshot)
      useEntriesStore.getState().loadSnapshot(snapshot)
      pushToast(copy.onboarding.createSuccess)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.screen}>
      <form className={styles.card} onSubmit={submit}>
        <div className={styles.mark}>
          <Lock size={20} />
        </div>
        <h1 className={styles.title}>{copy.onboarding.title}</h1>
        <p className={styles.subtitle}>{copy.onboarding.subtitle}</p>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="new-password">
            {copy.onboarding.passwordLabel}
          </label>
          <input
            id="new-password"
            className={`${styles.input} ${styles.passwordInput}`}
            type="password"
            autoFocus
            autoComplete="new-password"
            value={password}
            placeholder={copy.onboarding.passwordPlaceholder}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className={styles.strength} aria-hidden="true">
            {[1, 2, 3, 4, 5].map((step) => (
              <span
                key={step}
                className={`${styles.strengthBar} ${strength.score >= step ? styles.strengthOn : ''}`}
              />
            ))}
          </div>
          <div className={styles.strengthLabel}>{strength.label}</div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="confirm-password">
            {copy.onboarding.confirmLabel}
          </label>
          <input
            id="confirm-password"
            className={`${styles.input} ${styles.passwordInput}`}
            type="password"
            autoComplete="new-password"
            value={confirm}
            placeholder={copy.onboarding.confirmPlaceholder}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>

        <button className={styles.submit} type="submit" disabled={busy}>
          {busy ? copy.common.loading : copy.onboarding.submit}
        </button>

        <div className={styles.error} role="alert">
          {error}
        </div>

        <p className={styles.warning}>{copy.onboarding.warning}</p>

        <div className={styles.footer}>
          <span>{copy.onboarding.importing}</span>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => {
              useUiStore.getState().setPendingPackage(null)
              openDialog('migrationImport')
            }}
          >
            <PackageOpen size={12} aria-hidden="true" /> {copy.onboarding.importAction}
          </button>
        </div>
      </form>
    </div>
  )
}
