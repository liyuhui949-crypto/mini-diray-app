import { useEffect, useState } from 'react'

import { copy } from '@shared/copy'
import { todayLocalDate } from '@shared/date'

import { call, errorMessage, subscribe } from '@/api/client'
import { Dialogs } from '@/app/Dialogs'
import { BusyOverlay } from '@/app/parts/BusyOverlay'
import { Shell } from '@/app/Shell'
import { Lightbox } from '@/features/attachments/Lightbox'
import { SearchPreviewDialog } from '@/features/search/SearchPreviewDialog'
import { ToastHost } from '@/components/ui'
import { Onboarding } from '@/features/onboarding/Onboarding'
import { UnlockView } from '@/features/unlock/UnlockView'
import { cancelPendingSave, useEntriesStore } from '@/stores/entries'
import { usePrefsStore } from '@/stores/prefs'
import { useUiStore } from '@/stores/ui'
import { useVaultStore } from '@/stores/vault'

import styles from './app.module.scss'

export default function App(): React.JSX.Element {
  const status = useVaultStore((state) => state.status)
  const theme = usePrefsStore((state) => state.theme)
  const [booted, setBooted] = useState(false)
  const pushToast = useUiStore((state) => state.pushToast)

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = await call('app:bootstrap', undefined)
        if (cancelled) return
        usePrefsStore.getState().setPrefs(info.prefs)
        usePrefsStore.getState().setAppVersion(info.version)
        useUiStore.getState().hydrateLayout(info.prefs)
        useVaultStore.getState().setStatus(info.vaultStatus)
        if (info.vaultStatus === 'unlocked') {
          const snapshot = await call('vault:snapshot', undefined)
          useEntriesStore.getState().loadSnapshot(snapshot)
        }
        setBooted(true)
      } catch (error) {
        pushToast(errorMessage(error), { tone: 'error' })
        setBooted(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pushToast])

  useEffect(() => {
    if (!booted) return
    const disposers = [
      subscribe('vault:locked', ({ reason }) => {
        cancelPendingSave()
        useEntriesStore.getState().clear()
        useVaultStore.getState().setLocked(reason)
        const ui = useUiStore.getState()
        ui.closeLightbox()
        ui.closeSearchPreview()
        ui.setView('editor')
      }),
      subscribe('prefs:changed', (prefs) => {
        usePrefsStore.getState().setPrefs(prefs)
      }),
      subscribe('theme:changed', ({ theme: next }) => {
        if (usePrefsStore.getState().prefs?.theme === 'system') {
          usePrefsStore.getState().setTheme(next === 'dark' ? 'dark' : 'light')
        }
      }),
      subscribe('app:flush-request', ({ token }) => {
        void (async () => {
          try {
            await useEntriesStore.getState().flush()
          } catch {
            // 保存失败已经在 store 里标记
          }
          await call('app:flushAck', { token }).catch(() => undefined)
        })()
      }),
      subscribe('job:progress', (progress) => {
        if (progress.kind === 'attachment') return
        useVaultStore.getState().setBusy(progress)
      }),
      subscribe('job:done', (payload) => {
        if (payload.kind === 'attachment') return
        useVaultStore.getState().setBusy(null)
      }),
      subscribe('job:error', (payload) => {
        if (payload.kind === 'attachment') return
        useVaultStore.getState().setBusy(null)
        useUiStore.getState().pushToast(payload.message, { tone: 'error' })
      }),
      subscribe('menu:command', (command) => {
        const ui = useUiStore.getState()
        const entries = useEntriesStore.getState()
        switch (command) {
          case 'new-entry':
          case 'go-today':
            ui.setView('editor')
            void entries.openDate(todayLocalDate())
            break
          case 'search':
            ui.requestFocusSearch()
            break
          case 'open-preferences':
            ui.setView('settings')
            break
          case 'open-stats':
            ui.setView('stats')
            break
          case 'import-entry':
            ui.openDialog('import')
            break
          case 'export-entry':
            ui.openDialog('export')
            break
          case 'migration-export':
            ui.openDialog('migrationExport')
            break
          case 'migration-import':
            ui.openDialog('migrationImport')
            break
          case 'toggle-sidebar':
            ui.toggleSidebar()
            break
          case 'insert-attachment':
            ui.requestAttachment()
            break
          default:
            break
        }
      }),
      subscribe('migration:open-package', ({ path }) => {
        const ui = useUiStore.getState()
        ui.setPendingPackage(path)
        ui.openDialog('migrationImport')
      })
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [booted, pushToast])

  if (!booted) {
    return (
      <div className={styles.splash}>
        <div className={styles.splashMark}>M</div>
        <p className={styles.splashText}>{copy.appName}</p>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      {status === 'missing' ? <Onboarding /> : null}
      {status === 'locked' ? <UnlockView /> : null}
      {status === 'unlocked' ? <Shell /> : null}
      <Dialogs />
      <SearchPreviewDialog />
      <SearchPreviewDialog from="library" />
      <Lightbox />
      <BusyOverlay />
      <ToastHost />
    </div>
  )
}
