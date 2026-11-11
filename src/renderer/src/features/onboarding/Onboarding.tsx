import { useState } from 'react'

import { GitBranch, Lock, PackageOpen, Plus } from 'lucide-react'

import { copy } from '@shared/copy'
import { PASSWORD_MIN_LENGTH } from '@shared/schemas'

import { call, errorMessage } from '@/api/client'
import { PasswordInput } from '@/components/ui'
import { useEntriesStore } from '@/stores/entries'
import { useUiStore } from '@/stores/ui'
import { useVaultStore } from '@/stores/vault'

import { KeyRestoreDialog } from './KeyRestoreDialog'

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
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [mode, setMode] = useState<'choose' | 'create'>('choose')
  const pushToast = useUiStore((state) => state.pushToast)
  const openDialog = useUiStore((state) => state.openDialog)
  const strength = strengthOf(password)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)
    if (password.length < PASSWORD_MIN_LENGTH) {
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

  const heading = (
    <>
      <div className={styles.mark}>
        <Lock size={20} />
      </div>
      <h1 className={styles.title}>
        {mode === 'choose' ? copy.onboarding.chooseTitle : copy.onboarding.title}
      </h1>
      <p className={styles.subtitle}>
        {mode === 'choose' ? copy.onboarding.chooseSubtitle : copy.onboarding.subtitle}
      </p>
    </>
  )

  return (
    <div className={styles.screen}>
      {mode === 'choose' ? (
        <div className={styles.card}>
          {heading}
          <div className={styles.choices}>
            <button
              type="button"
              className={`${styles.choice} ${styles.choicePrimary}`}
              onClick={() => setMode('create')}
            >
              <span className={styles.choiceIcon}>
                <Plus size={14} aria-hidden="true" />
              </span>
              <span className={styles.choiceText}>
                <span className={styles.choiceTitle}>{copy.onboarding.createOption}</span>
              </span>
            </button>
            <button
              type="button"
              className={styles.choice}
              onClick={() => {
                useUiStore.getState().setPendingPackage(null)
                openDialog('migrationImport')
              }}
            >
              <span className={styles.choiceIcon}>
                <PackageOpen size={14} aria-hidden="true" />
              </span>
              <span className={styles.choiceText}>
                <span className={styles.choiceTitle}>{copy.onboarding.importOption}</span>
              </span>
            </button>
            <button type="button" className={styles.choice} onClick={() => setRestoreOpen(true)}>
              <span className={styles.choiceIcon}>
                <GitBranch size={14} aria-hidden="true" />
              </span>
              <span className={styles.choiceText}>
                <span className={styles.choiceTitle}>{copy.onboarding.gitOption}</span>
              </span>
            </button>
          </div>
        </div>
      ) : (
        <form className={styles.card} onSubmit={submit}>
          {heading}

          <div className={styles.field}>
            <label className={styles.label} htmlFor="new-password">
              {copy.onboarding.passwordLabel}
            </label>
            <PasswordInput
              id="new-password"
              className={styles.passwordInput}
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
            <PasswordInput
              id="confirm-password"
              className={styles.passwordInput}
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

          <div className={styles.backRow}>
            <button type="button" className={styles.linkBtn} onClick={() => setMode('choose')}>
              ← {copy.onboarding.back}
            </button>
          </div>
        </form>
      )}

      <KeyRestoreDialog open={restoreOpen} onClose={() => setRestoreOpen(false)} />
    </div>
  )
}
