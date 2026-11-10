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

export function PreferencesPane(): React.JSX.Element {
  const appVersion = usePrefsStore((state) => state.appVersion)
  const prefs = usePrefsStore((state) => state.prefs)
  const update = usePrefsStore((state) => state.update)
  const openDialog = useUiStore((state) => state.openDialog)
  const pushToast = useUiStore((state) => state.pushToast)
  const isMac = window.miniDiary.platform === 'darwin'

  if (!prefs) return <div className={styles.pane} />

  const openPrivacySettings = (target: 'filesAndFolders' | 'localNetwork'): void => {
    void call('system:openPrivacySettings', { target }).catch((error) => {
      pushToast(errorMessage(error), { tone: 'error' })
    })
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

      {isMac ? (
        <section className={styles.panel}>
          <h3>{copy.preferences.permissions}</h3>
          <Setting title={copy.preferences.permissionFiles} description={copy.preferences.permissionFilesDesc}>
            <Button size="sm" onClick={() => openPrivacySettings('filesAndFolders')}>
              {copy.preferences.permissionOpenFiles}
            </Button>
          </Setting>
          <Setting
            title={copy.preferences.permissionLocalNetwork}
            description={copy.preferences.permissionLocalNetworkDesc}
          >
            <Button size="sm" onClick={() => openPrivacySettings('localNetwork')}>
              {copy.preferences.permissionOpenLocalNetwork}
            </Button>
          </Setting>
        </section>
      ) : null}

      <section className={styles.panel}>
        <h3>{copy.preferences.about}</h3>
        <AboutRow
          label={copy.preferences.version}
          value={appVersion || '1.0.0'}
        />
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
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={styles.setting}>
      <div className={styles.settingText}>
        <div className={styles.settingTitle}>{title}</div>
        {description ? <div className={styles.settingDesc}>{description}</div> : null}
      </div>
      {children ? <div className={styles.settingControl}>{children}</div> : null}
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
