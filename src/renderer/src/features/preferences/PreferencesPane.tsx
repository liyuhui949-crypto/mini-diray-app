import { useState } from 'react'

import { copy } from '@shared/copy'
import type { AutoLockMinutes } from '@shared/types'

import { call, errorMessage } from '@/api/client'
import { Button, Select, Switch } from '@/components/ui'
import { usePrefsStore } from '@/stores/prefs'
import { useUiStore } from '@/stores/ui'

import styles from './prefs.module.scss'

const THEME_OPTIONS = [
  { value: 'system', label: copy.preferences.themeSystem },
  { value: 'light', label: copy.preferences.themeLight },
  { value: 'dark', label: copy.preferences.themeDark }
]

const AUTO_LOCK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '0', label: copy.preferences.autoLockNever },
  { value: '5', label: copy.preferences.autoLockMinutes(5) },
  { value: '15', label: copy.preferences.autoLockMinutes(15) },
  { value: '30', label: copy.preferences.autoLockMinutes(30) },
  { value: '60', label: copy.preferences.autoLockMinutes(60) }
]

function abbreviateHome(target: string): string {
  const home = '/Users/'
  if (!target.startsWith(home)) return target
  const parts = target.split('/')
  return `~/${parts.slice(3).join('/')}`
}

export function PreferencesPane(): React.JSX.Element {
  const prefs = usePrefsStore((state) => state.prefs)
  const update = usePrefsStore((state) => state.update)
  const openDialog = useUiStore((state) => state.openDialog)
  const pushToast = useUiStore((state) => state.pushToast)
  const [moving, setMoving] = useState(false)

  if (!prefs) return <div className={styles.pane} />

  const moveDirectory = async (): Promise<void> => {
    setMoving(true)
    try {
      const picked = await call('dialog:pickDirectory', { purpose: copy.preferences.moveDirTitle })
      if (!picked.path) return
      const result = await call('vault:moveDirectory', { targetDir: picked.path })
      usePrefsStore.getState().setPrefs({ ...prefs, diaryDir: result.diaryDir })
      pushToast(copy.preferences.moveDirTitle)
    } catch (error) {
      pushToast(errorMessage(error), { tone: 'error' })
    } finally {
      setMoving(false)
    }
  }

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <h1>{copy.preferences.title}</h1>
        <p>{copy.preferences.subtitle}</p>
      </div>

      <section className={styles.panel}>
        <h3>{copy.preferences.appearance}</h3>
        <Setting title={copy.preferences.theme} description={copy.preferences.themeDesc}>
          <Select
            value={prefs.theme}
            aria-label={copy.preferences.theme}
            options={THEME_OPTIONS}
            onChange={(event) => {
              void update({ theme: event.target.value as typeof prefs.theme })
            }}
          />
        </Setting>
      </section>

      <section className={styles.panel}>
        <h3>{copy.preferences.editing}</h3>
        <Setting title={copy.preferences.hideTitle} description={copy.preferences.hideTitleDesc}>
          <Switch
            label={copy.preferences.hideTitle}
            checked={prefs.hideTitle}
            onChange={(checked) => {
              void update({ hideTitle: checked })
            }}
          />
        </Setting>
      </section>

      <section className={styles.panel}>
        <h3>{copy.preferences.calendar}</h3>
        <Setting title={copy.preferences.allowFuture} description={copy.preferences.allowFutureDesc}>
          <Switch
            label={copy.preferences.allowFuture}
            checked={prefs.allowFutureEntries}
            onChange={(checked) => {
              void update({ allowFutureEntries: checked })
            }}
          />
        </Setting>
      </section>

      <section className={styles.panel}>
        <h3>{copy.preferences.security}</h3>
        <Setting title={copy.preferences.autoLock} description={copy.preferences.autoLockDesc}>
          <Select
            value={String(prefs.autoLockMinutes)}
            aria-label={copy.preferences.autoLock}
            options={AUTO_LOCK_OPTIONS}
            onChange={(event) => {
              void update({ autoLockMinutes: Number(event.target.value) as AutoLockMinutes })
            }}
          />
        </Setting>
        <Setting title={copy.preferences.changePassword} description={copy.preferences.changePasswordDesc}>
          <Button size="sm" onClick={() => openDialog('changePassword')}>
            {copy.preferences.changePasswordAction}
          </Button>
        </Setting>
      </section>

      <section className={styles.panel}>
        <h3>{copy.preferences.data}</h3>
        <Setting title={copy.preferences.diaryDir} description={copy.preferences.diaryDirDesc}>
          <div className={styles.rowActions}>
            <code className={styles.path} title={prefs.diaryDir}>
              {abbreviateHome(prefs.diaryDir)}
            </code>
            <Button
              size="sm"
              onClick={() => {
                void call('app:openDiaryDir', undefined)
              }}
            >
              {copy.preferences.openDir}
            </Button>
            <Button size="sm" disabled={moving} onClick={() => void moveDirectory()}>
              {copy.preferences.moveDir}
            </Button>
          </div>
        </Setting>
        <Setting title={copy.preferences.migration} description={copy.preferences.migrationDesc}>
          <div className={styles.rowActions}>
            <Button size="sm" onClick={() => openDialog('migrationImport')}>
              {copy.preferences.migrationImport}
            </Button>
            <Button size="sm" variant="primary" onClick={() => openDialog('migrationExport')}>
              {copy.preferences.migrationExport}
            </Button>
          </div>
        </Setting>
        <Setting title={copy.preferences.cleanup} description={copy.preferences.cleanupDesc}>
          <Button size="sm" onClick={() => openDialog('cleanup')}>
            {copy.preferences.cleanupAction}
          </Button>
        </Setting>
      </section>

      <section className={styles.dangerBox}>
        <Setting title={copy.preferences.resetDiary} description={copy.preferences.resetDiaryDesc}>
          <Button size="sm" variant="danger" onClick={() => openDialog('resetVault')}>
            {copy.preferences.resetAction}
          </Button>
        </Setting>
        <Setting title={copy.preferences.deleteDiary} description={copy.preferences.deleteDiaryDesc}>
          <Button size="sm" variant="danger" onClick={() => openDialog('deleteVault')}>
            {copy.preferences.deleteAction}
          </Button>
        </Setting>
      </section>

      <section className={styles.panel}>
        <h3>{copy.preferences.about}</h3>
        <AboutRow label={copy.preferences.version} value="4.0.0" />
        <AboutRow label={copy.preferences.encryption} value={copy.preferences.encryptionValue} />
        <AboutRow label={copy.preferences.limitations} value={copy.preferences.limitationsValue} />
        <AboutRow label={copy.preferences.backup} value={copy.preferences.backupValue} />
      </section>
    </div>
  )
}

function Setting({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={styles.setting}>
      <div className={styles.settingText}>
        <div className={styles.settingTitle}>{title}</div>
        {description ? <div className={styles.settingDesc}>{description}</div> : null}
      </div>
      <div className={styles.settingControl}>{children}</div>
    </div>
  )
}

function AboutRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className={styles.aboutRow}>
      <span>{label}</span>
      <span className={styles.aboutValue}>{value}</span>
    </div>
  )
}
